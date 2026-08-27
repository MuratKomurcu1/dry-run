import { createHash, randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { connect, type NatsConnection, type NodeConnectionOptions } from "@nats-io/transport-node";
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type Consumer,
  type JetStreamClient,
} from "@nats-io/jetstream";
import type { TraceDocument } from "./tracing.ts";
import { redactUrlCredentials, trimSlashes } from "./safe-text.ts";

export interface DistributedScope {
  organizationId: string;
  workspaceId: string;
  projectId: string;
}

export interface ControlRecord<T = unknown> extends DistributedScope {
  collection: string;
  id: string;
  revision: number;
  value: T;
  createdAt: string;
  updatedAt: string;
}

export interface ControlPage<T = unknown> {
  items: Array<ControlRecord<T>>;
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface ControlEvent {
  id: string;
  subject: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
}

export interface ControlPlaneSnapshot {
  kind: "dry-run.control-plane-snapshot";
  version: 1;
  createdAt: string;
  records: ControlRecord[];
}

export interface DeadLetterEnvelope<T = unknown> {
  kind: "dry-run.dead-letter";
  version: 1;
  originalSubject: string;
  originalId: string;
  payload: T;
  error: string;
  deliveries: number;
  failedAt: string;
  redrives: number;
}

export class ControlRevisionConflictError extends Error {
  readonly currentRevision: number | undefined;
  constructor(currentRevision?: number) {
    super(`Control-plane revision conflict${currentRevision == null ? "" : `; current revision is ${currentRevision}`}`);
    this.name = "ControlRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class PostgresControlPlane {
  readonly pool: Pool;
  readonly schema: string;
  private readonly table: string;
  private readonly outboxTable: string;

  constructor(options: PoolConfig & { schema?: string }) {
    this.schema = sqlIdentifier(options.schema ?? "dryrun");
    this.table = `${quoteIdentifier(this.schema)}.${quoteIdentifier("documents")}`;
    this.outboxTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier("outbox")}`;
    const { schema: _schema, ...poolOptions } = options;
    this.pool = new Pool(poolOptions);
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    const schema = quoteIdentifier(this.schema);
    const migrationTable = `${schema}.${quoteIdentifier("schema_migrations")}`;
    const lockName = `dry-run:migrate:${this.schema}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockName]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${migrationTable} (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        project_id text NOT NULL,
        collection text NOT NULL,
        id text NOT NULL,
        revision bigint NOT NULL,
        value jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (organization_id, workspace_id, project_id, collection, id)
      )
    `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier("documents_collection_updated_idx")} ON ${this.table} (organization_id, workspace_id, project_id, collection, updated_at DESC, id DESC)`);
      await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.outboxTable} (
        id text PRIMARY KEY,
        subject text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        available_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0,
        leased_by text,
        lease_until timestamptz,
        published_at timestamptz,
        last_error text
      )
    `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier("outbox_pending_idx")} ON ${this.outboxTable} (available_at, created_at) WHERE published_at IS NULL`);
      await client.query(`INSERT INTO ${migrationTable} (version) VALUES (1),(2) ON CONFLICT (version) DO NOTHING`);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => undefined);
      client.release();
    }
  }

  async schemaVersion(): Promise<number> {
    const table = `${quoteIdentifier(this.schema)}.${quoteIdentifier("schema_migrations")}`;
    const result = await this.pool.query(`SELECT COALESCE(MAX(version),0) AS version FROM ${table}`);
    return Number(result.rows[0]?.version ?? 0);
  }

  async withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    validateSegment(name, "advisory lock", 256);
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [name]);
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [name]).catch(() => undefined);
      client.release();
    }
  }

  async exportSnapshot(scope?: Partial<DistributedScope>): Promise<ControlPlaneSnapshot> {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, value] of [["organization_id", scope?.organizationId], ["workspace_id", scope?.workspaceId], ["project_id", scope?.projectId]] as const) {
      if (!value) continue;
      validateSegment(value, column);
      values.push(value);
      clauses.push(`${column}=$${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT organization_id,workspace_id,project_id,collection,id,revision,value,created_at,updated_at FROM ${this.table}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY organization_id,workspace_id,project_id,collection,id`,
      values,
    );
    return { kind: "dry-run.control-plane-snapshot", version: 1, createdAt: new Date().toISOString(), records: result.rows.map((row) => mapControlRecord(row)) };
  }

  async importSnapshot(snapshot: ControlPlaneSnapshot, options: { replace?: boolean } = {}): Promise<{ imported: number }> {
    validateControlSnapshot(snapshot);
    return this.transaction(async (client) => {
      if (options.replace) {
        const scopes = new Map(snapshot.records.map((record) => [`${record.organizationId}\0${record.workspaceId}\0${record.projectId}`, record]));
        for (const record of scopes.values()) {
          await client.query(`DELETE FROM ${this.table} WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3`, [record.organizationId, record.workspaceId, record.projectId]);
        }
      }
      for (const record of snapshot.records) {
        await client.query(
          `INSERT INTO ${this.table} AS target (organization_id,workspace_id,project_id,collection,id,revision,value,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz)
           ON CONFLICT (organization_id,workspace_id,project_id,collection,id) DO UPDATE
           SET revision=GREATEST(target.revision,EXCLUDED.revision),value=CASE WHEN EXCLUDED.revision >= target.revision THEN EXCLUDED.value ELSE target.value END,updated_at=GREATEST(target.updated_at,EXCLUDED.updated_at)`,
          [record.organizationId, record.workspaceId, record.projectId, record.collection, record.id, record.revision, JSON.stringify(record.value), record.createdAt, record.updatedAt],
        );
      }
      return { imported: snapshot.records.length };
    });
  }

  async health(): Promise<{ ok: true; latencyMs: number }> {
    const started = performance.now();
    await this.pool.query("SELECT 1");
    return { ok: true, latencyMs: round(performance.now() - started) };
  }

  async get<T>(scope: DistributedScope, collection: string, id: string): Promise<ControlRecord<T> | undefined> {
    validateScope(scope);
    validateSegment(collection, "collection");
    validateSegment(id, "document id", 256);
    const result = await this.pool.query(
      `SELECT organization_id, workspace_id, project_id, collection, id, revision, value, created_at, updated_at FROM ${this.table}
       WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3 AND collection=$4 AND id=$5`,
      [scope.organizationId, scope.workspaceId, scope.projectId, collection, id],
    );
    return result.rows[0] ? mapControlRecord<T>(result.rows[0]) : undefined;
  }

  async put<T>(
    scope: DistributedScope,
    collection: string,
    id: string,
    value: T,
    options: { expectedRevision?: number; event?: { id?: string; subject: string; payload: unknown } } = {},
  ): Promise<ControlRecord<T>> {
    validateScope(scope);
    validateSegment(collection, "collection");
    validateSegment(id, "document id", 256);
    assertJsonValue(value, "control-plane document");
    if (options.expectedRevision != null && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) throw new Error("expectedRevision must be a non-negative integer");
    if (options.event) validateSubject(options.event.subject);
    return this.transaction(async (client) => {
      const values = [scope.organizationId, scope.workspaceId, scope.projectId, collection, id, JSON.stringify(value)];
      const saved = options.expectedRevision == null
        ? await client.query(
          `INSERT INTO ${this.table} AS target (organization_id,workspace_id,project_id,collection,id,revision,value)
           VALUES ($1,$2,$3,$4,$5,1,$6::jsonb)
           ON CONFLICT (organization_id,workspace_id,project_id,collection,id)
           DO UPDATE SET revision=target.revision+1,value=EXCLUDED.value,updated_at=now()
           RETURNING organization_id, workspace_id, project_id, collection, id, revision, value, created_at, updated_at`,
          values,
        )
        : await client.query(
          `INSERT INTO ${this.table} AS target (organization_id,workspace_id,project_id,collection,id,revision,value)
           VALUES ($1,$2,$3,$4,$5,1,$6::jsonb)
           ON CONFLICT (organization_id,workspace_id,project_id,collection,id)
           DO UPDATE SET revision=target.revision+1,value=EXCLUDED.value,updated_at=now()
           WHERE target.revision=$7
           RETURNING organization_id, workspace_id, project_id, collection, id, revision, value, created_at, updated_at`,
          [...values, options.expectedRevision],
        );
      if (!saved.rows[0]) {
        const current = await client.query(
          `SELECT revision FROM ${this.table} WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3 AND collection=$4 AND id=$5`,
          values.slice(0, 5),
        );
        throw new ControlRevisionConflictError(current.rows[0] ? Number(current.rows[0].revision) : undefined);
      }
      if (options.event) {
        const eventId = options.event.id ?? `event_${randomUUID().replace(/-/g, "")}`;
        validateSegment(eventId, "event id", 256);
        assertJsonValue(options.event.payload, "outbox payload");
        await client.query(
          `INSERT INTO ${this.outboxTable} (id,subject,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING`,
          [eventId, options.event.subject, JSON.stringify(options.event.payload)],
        );
      }
      return mapControlRecord<T>(saved.rows[0]);
    });
  }

  async putBatch<T>(scope: DistributedScope, collection: string, entries: Array<{ id: string; value: T }>, options: { event?: { id?: string; subject: string; payload: unknown } } = {}): Promise<Array<ControlRecord<T>>> {
    validateScope(scope); validateSegment(collection, "collection");
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 5_000) throw new Error("Control-plane batch must contain 1-5000 documents");
    const ids = new Set<string>();
    for (const entry of entries) { validateSegment(entry.id, "document id", 256); if (ids.has(entry.id)) throw new Error(`Duplicate control-plane batch id: ${entry.id}`); ids.add(entry.id); assertJsonValue(entry.value, "control-plane document"); }
    if (options.event) { validateSubject(options.event.subject); assertJsonValue(options.event.payload, "outbox payload"); }
    return this.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ${this.table} AS target (organization_id,workspace_id,project_id,collection,id,revision,value)
         SELECT $1,$2,$3,$4,item.id,1,item.value FROM jsonb_to_recordset($5::jsonb) AS item(id text,value jsonb)
         ON CONFLICT (organization_id,workspace_id,project_id,collection,id) DO UPDATE SET
           revision=CASE WHEN target.value=EXCLUDED.value THEN target.revision ELSE target.revision+1 END,
           value=EXCLUDED.value,
           updated_at=CASE WHEN target.value=EXCLUDED.value THEN target.updated_at ELSE now() END
         RETURNING organization_id,workspace_id,project_id,collection,id,revision,value,created_at,updated_at`,
        [scope.organizationId, scope.workspaceId, scope.projectId, collection, JSON.stringify(entries)],
      );
      if (options.event) {
        const eventId = options.event.id ?? `event_${randomUUID().replace(/-/g, "")}`;
        validateSegment(eventId, "event id", 256);
        await client.query(`INSERT INTO ${this.outboxTable} (id,subject,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING`, [eventId, options.event.subject, JSON.stringify(options.event.payload)]);
      }
      const byId = new Map(result.rows.map((row) => [String(row.id), mapControlRecord<T>(row)]));
      return entries.map((entry) => byId.get(entry.id)!).filter(Boolean);
    });
  }

  async delete(scope: DistributedScope, collection: string, id: string, expectedRevision?: number): Promise<boolean> {
    validateScope(scope);
    validateSegment(collection, "collection");
    validateSegment(id, "document id", 256);
    return this.transaction(async (client) => {
      const current = await client.query(
        `SELECT revision FROM ${this.table} WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3 AND collection=$4 AND id=$5 FOR UPDATE`,
        [scope.organizationId, scope.workspaceId, scope.projectId, collection, id],
      );
      const currentRevision = current.rows[0] ? Number(current.rows[0].revision) : undefined;
      if (expectedRevision != null && (currentRevision ?? 0) !== expectedRevision) throw new ControlRevisionConflictError(currentRevision);
      if (currentRevision == null) return false;
      await client.query(
        `DELETE FROM ${this.table} WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3 AND collection=$4 AND id=$5`,
        [scope.organizationId, scope.workspaceId, scope.projectId, collection, id],
      );
      return true;
    });
  }

  async list<T>(scope: DistributedScope, collection: string, options: { limit?: number; cursor?: string } = {}): Promise<ControlPage<T>> {
    validateScope(scope);
    validateSegment(collection, "collection");
    const limit = boundedInteger(options.limit ?? 100, 1, 500, "limit");
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    const values: unknown[] = [scope.organizationId, scope.workspaceId, scope.projectId, collection];
    let cursorSql = "";
    if (cursor) {
      values.push(cursor.updatedAt, cursor.id);
      cursorSql = ` AND (updated_at,id) < ($5::timestamptz,$6)`;
    }
    values.push(limit + 1);
    const result = await this.pool.query(
      `SELECT organization_id, workspace_id, project_id, collection, id, revision, value, created_at, updated_at FROM ${this.table}
       WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3 AND collection=$4${cursorSql}
       ORDER BY updated_at DESC,id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map((row) => mapControlRecord<T>(row));
    const last = items.at(-1);
    return { items, limit, hasMore, ...(hasMore && last ? { nextCursor: encodeCursor({ updatedAt: last.updatedAt, id: last.id }) } : {}) };
  }

  async count(scope: DistributedScope, collection: string): Promise<number> {
    validateScope(scope); validateSegment(collection, "collection");
    const result = await this.pool.query(`SELECT count(*)::bigint AS count FROM ${this.table} WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3 AND collection=$4`, [scope.organizationId, scope.workspaceId, scope.projectId, collection]);
    const count = Number(result.rows[0]?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Control-plane count exceeds the safe integer range");
    return count;
  }

  async deleteScope(scope: DistributedScope): Promise<number> {
    validateScope(scope);
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE organization_id=$1 AND workspace_id=$2 AND project_id=$3`, [scope.organizationId, scope.workspaceId, scope.projectId]);
    return result.rowCount ?? 0;
  }

  async claimOutbox(workerId: string, options: { limit?: number; leaseMs?: number } = {}): Promise<ControlEvent[]> {
    validateSegment(workerId, "worker id", 128);
    const limit = boundedInteger(options.limit ?? 50, 1, 500, "outbox claim limit");
    const leaseMs = boundedInteger(options.leaseMs ?? 30_000, 1_000, 3_600_000, "outbox lease");
    return this.transaction(async (client) => {
      const result = await client.query(
        `WITH candidates AS (
           SELECT id FROM ${this.outboxTable}
           WHERE published_at IS NULL AND available_at <= now() AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE ${this.outboxTable} o SET leased_by=$2,lease_until=now()+($3::text || ' milliseconds')::interval,attempts=o.attempts+1
         FROM candidates c WHERE o.id=c.id
         RETURNING o.id,o.subject,o.payload,o.created_at,o.attempts`,
        [limit, workerId, leaseMs],
      );
      return result.rows.map((row) => ({ id: String(row.id), subject: String(row.subject), payload: row.payload, createdAt: new Date(row.created_at).toISOString(), attempts: Number(row.attempts) }));
    });
  }

  async completeOutbox(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.outboxTable} SET published_at=now(),leased_by=NULL,lease_until=NULL,last_error=NULL
       WHERE id=$1 AND leased_by=$2 AND published_at IS NULL`,
      [id, workerId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async failOutbox(id: string, workerId: string, error: unknown, delayMs: number): Promise<boolean> {
    const delay = boundedInteger(delayMs, 100, 3_600_000, "outbox retry delay");
    const message = safeError(error);
    const result = await this.pool.query(
      `UPDATE ${this.outboxTable} SET available_at=now()+($3::text || ' milliseconds')::interval,leased_by=NULL,lease_until=NULL,last_error=$4
       WHERE id=$1 AND leased_by=$2 AND published_at IS NULL`,
      [id, workerId, delay, message],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface S3ArtifactStoreOptions {
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  createBucket?: boolean;
  tls?: boolean;
}

export interface StoredArtifact {
  key: string;
  digest: string;
  bytes: number;
  contentType: string;
  versionId?: string;
  etag?: string;
}

export class S3ArtifactStore {
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;
  readonly createBucket: boolean;

  constructor(options: S3ArtifactStoreOptions) {
    this.bucket = validateBucket(options.bucket);
    this.prefix = normalizePrefix(options.prefix ?? "dryrun");
    this.createBucket = options.createBucket ?? false;
    const credentials = options.accessKeyId && options.secretAccessKey ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } : undefined;
    if ((options.accessKeyId && !options.secretAccessKey) || (!options.accessKeyId && options.secretAccessKey)) throw new Error("S3 access key and secret must be configured together");
    const config: S3ClientConfig = {
      region: options.region ?? "us-east-1",
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      ...(options.endpoint ? { endpoint: normalizeEndpoint(options.endpoint, options.tls !== false) } : {}),
      ...(credentials ? { credentials } : {}),
    };
    this.client = new S3Client(config);
  }

  async initialize(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!this.createBucket) throw new Error(`Artifact bucket ${this.bucket} is unavailable: ${safeError(error)}`);
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async putJson(key: string, value: unknown, options: { immutable?: boolean } = {}): Promise<StoredArtifact> {
    assertJsonValue(value, "artifact");
    const data = Buffer.from(`${JSON.stringify(value)}\n`);
    return this.put(key, data, "application/json", options);
  }

  async put(key: string, data: Uint8Array, contentType = "application/octet-stream", options: { immutable?: boolean } = {}): Promise<StoredArtifact> {
    const resolved = this.key(key);
    return this.putAtResolvedKey(resolved, data, contentType, options);
  }

  async restore(key: string, data: Uint8Array, contentType = "application/octet-stream", options: { immutable?: boolean } = {}): Promise<StoredArtifact> {
    const resolved = this.key(key, true);
    return this.putAtResolvedKey(resolved, data, contentType, options);
  }

  private async putAtResolvedKey(resolved: string, data: Uint8Array, contentType: string, options: { immutable?: boolean }): Promise<StoredArtifact> {
    const digest = digestBytes(data);
    const result = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: resolved,
      Body: data,
      ContentType: contentType,
      Metadata: { "dryrun-sha256": digest.slice(7) },
      ...(options.immutable ? { IfNoneMatch: "*" } : {}),
    }));
    return { key: resolved, digest, bytes: data.byteLength, contentType, ...(result.VersionId ? { versionId: result.VersionId } : {}), ...(result.ETag ? { etag: result.ETag } : {}) };
  }

  async getJson<T>(key: string, expectedDigest?: string): Promise<T> {
    const data = await this.get(key, expectedDigest);
    try { return JSON.parse(Buffer.from(data).toString("utf8")) as T; }
    catch { throw new Error(`Artifact ${safeObjectKey(key)} is not valid JSON`); }
  }

  async get(key: string, expectedDigest?: string): Promise<Uint8Array> {
    const resolved = this.key(key, true);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: resolved }));
    if (!result.Body) throw new Error(`Artifact ${safeObjectKey(key)} returned an empty body`);
    const data = await result.Body.transformToByteArray();
    const digest = digestBytes(data);
    const stored = result.Metadata?.["dryrun-sha256"];
    if (stored && digest !== `sha256:${stored}`) throw new Error(`Artifact ${safeObjectKey(key)} failed its stored checksum`);
    if (expectedDigest && digest !== expectedDigest) throw new Error(`Artifact ${safeObjectKey(key)} checksum mismatch`);
    return data;
  }

  async exists(key: string): Promise<boolean> {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key, true) })); return true; }
    catch (error) { if (httpStatus(error) === 404) return false; throw error; }
  }

  async health(): Promise<{ ok: true; latencyMs: number }> {
    const started = performance.now();
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return { ok: true, latencyMs: round(performance.now() - started) };
  }

  async delete(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key, true) })); }

  async list(prefix = "", limit = 1_000): Promise<string[]> {
    const bounded = boundedInteger(limit, 1, 1_000, "artifact list limit");
    const resolvedPrefix = this.key(prefix || "_", true).replace(/_$/, "");
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: resolvedPrefix, MaxKeys: bounded }));
    return (result.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []);
  }

  async clearPrefix(prefix = ""): Promise<number> {
    const resolvedPrefix = this.key(prefix || "_", true).replace(/_$/, "");
    let continuation: string | undefined;
    let deleted = 0;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: resolvedPrefix, MaxKeys: 1_000, ...(continuation ? { ContinuationToken: continuation } : {}) }));
      const objects = (page.Contents ?? []).flatMap((item) => item.Key ? [{ Key: item.Key }] : []);
      if (objects.length) { await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } })); deleted += objects.length; }
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
    return deleted;
  }

  async close(): Promise<void> { this.client.destroy(); }

  private key(value: string, alreadyResolved = false): string {
    if (alreadyResolved && value.startsWith(`${this.prefix}/`)) return validateObjectKey(value);
    return validateObjectKey(`${this.prefix}/${value.replace(/^\/+/, "")}`);
  }
}

export interface QueueJob<T = unknown> {
  id: string;
  subject: string;
  payload: T;
  deliveries: number;
}

export class NatsJetStreamQueue {
  private readonly connection: NatsConnection;
  private readonly js: JetStreamClient;
  readonly stream: string;
  readonly subjectPrefix: string;

  private constructor(connection: NatsConnection, stream: string, subjectPrefix: string) {
    this.connection = connection;
    this.js = jetstream(connection);
    this.stream = stream;
    this.subjectPrefix = subjectPrefix;
  }

  static async connect(options: NodeConnectionOptions & { stream?: string; subjectPrefix?: string; replicas?: number } = {}): Promise<NatsJetStreamQueue> {
    const { stream = "DRYRUN_JOBS", subjectPrefix = "dryrun.jobs", replicas = 1, ...connectionOptions } = options;
    validateNatsName(stream, "stream");
    validateSubject(subjectPrefix);
    const nc = await connect(connectionOptions);
    const queue = new NatsJetStreamQueue(nc, stream, subjectPrefix);
    try { await queue.initialize(replicas); await queue.ensureConsumer("DRYRUN_DLQ_REDRIVE", "dead.>", { ackWaitMs: 30_000, maxDeliver: 20 }); }
    catch (error) { await nc.close(); throw error; }
    return queue;
  }

  async publish(subject: string, payload: unknown, options: { id?: string } = {}): Promise<{ sequence: number; duplicate: boolean }> {
    const fullSubject = this.resolveSubject(subject);
    assertJsonValue(payload, "queue payload");
    const id = options.id ?? `job_${randomUUID().replace(/-/g, "")}`;
    validateSegment(id, "job id", 256);
    const ack = await this.js.publish(fullSubject, Buffer.from(JSON.stringify({ id, payload })), { msgID: id });
    return { sequence: ack.seq, duplicate: ack.duplicate };
  }

  async ensureConsumer(name: string, filter = ">", options: { ackWaitMs?: number; maxDeliver?: number } = {}): Promise<Consumer> {
    validateNatsName(name, "consumer");
    const jsm = await jetstreamManager(this.connection);
    try { await jsm.consumers.info(this.stream, name); }
    catch {
      await jsm.consumers.add(this.stream, {
        durable_name: name,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        replay_policy: ReplayPolicy.Instant,
        filter_subject: this.resolveSubject(filter),
        ack_wait: boundedInteger(options.ackWaitMs ?? 30_000, 1_000, 3_600_000, "ack wait") * 1_000_000,
        max_deliver: boundedInteger(options.maxDeliver ?? 10, 1, 1_000, "max deliveries"),
      });
    }
    return this.js.consumers.get(this.stream, name);
  }

  async consume<T>(
    name: string,
    handler: (job: QueueJob<T>) => void | Promise<void>,
    options: { filter?: string; ackWaitMs?: number; maxDeliver?: number; retryDelayMs?: number; deadLetter?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const consumer = await this.ensureConsumer(name, options.filter ?? ">", options);
    const retryDelay = boundedInteger(options.retryDelayMs ?? 1_000, 100, 3_600_000, "queue retry delay");
    while (!options.signal?.aborted) {
      const message = await consumer.next({ expires: 1_000 }).catch((error) => {
        if (options.signal?.aborted) return null;
        throw error;
      });
      if (!message) continue;
      try {
        const envelope = JSON.parse(Buffer.from(message.data).toString("utf8")) as { id?: unknown; payload?: unknown };
        if (typeof envelope.id !== "string" || !("payload" in envelope)) throw new Error("Queue envelope is invalid");
        await handler({ id: envelope.id, subject: message.subject, payload: envelope.payload as T, deliveries: message.info.deliveryCount });
        message.ack();
      } catch (error) {
        if (message.info.deliveryCount >= (options.maxDeliver ?? 10)) {
          if (options.deadLetter !== false) {
            const originalSubject = this.relativeSubject(message.subject);
            const envelope = safeQueueEnvelope(message.data);
            await this.publish(`dead.${originalSubject}`, {
              kind: "dry-run.dead-letter", version: 1, originalSubject, originalId: envelope.id,
              payload: envelope.payload, error: safeError(error), deliveries: message.info.deliveryCount,
              failedAt: new Date().toISOString(), redrives: 0,
            }, { id: `dead_${createHash("sha256").update(`${envelope.id}\0${message.info.deliveryCount}`).digest("hex")}` });
          }
          message.ack();
        }
        else message.nak(retryDelay);
      }
    }
  }

  async redriveDeadLetters(limit = 100): Promise<{ redriven: number; invalid: number }> {
    const bounded = boundedInteger(limit, 1, 1_000, "dead-letter redrive limit");
    const consumer = await this.ensureConsumer("DRYRUN_DLQ_REDRIVE", "dead.>", { ackWaitMs: 30_000, maxDeliver: 20 });
    let redriven = 0;
    let invalid = 0;
    for (let index = 0; index < bounded; index += 1) {
      const message = await consumer.next({ expires: index === 0 ? 5_000 : 250 }).catch(() => null);
      if (!message) break;
      try {
        const parsed = JSON.parse(Buffer.from(message.data).toString("utf8")) as { payload?: unknown };
        const dead = parsed.payload as DeadLetterEnvelope;
        validateDeadLetter(dead);
        await this.publish(dead.originalSubject, dead.payload, { id: `${dead.originalId}_redrive_${dead.redrives + 1}_${randomUUID().slice(0, 8)}` });
        message.ack();
        redriven += 1;
      } catch {
        message.term("invalid dead-letter envelope");
        invalid += 1;
      }
    }
    return { redriven, invalid };
  }

  async health(): Promise<{ ok: true; latencyMs: number }> {
    const started = performance.now();
    await this.connection.flush();
    return { ok: true, latencyMs: round(performance.now() - started) };
  }

  async deleteStream(): Promise<boolean> {
    const manager = await jetstreamManager(this.connection);
    try { return await manager.streams.delete(this.stream); }
    catch (error) { if (httpStatus(error) === 404) return false; throw error; }
  }

  async close(): Promise<void> { await this.connection.drain(); }

  private async initialize(replicas: number): Promise<void> {
    const jsm = await jetstreamManager(this.connection);
    try { await jsm.streams.info(this.stream); }
    catch {
      await jsm.streams.add({
        name: this.stream,
        subjects: [`${this.subjectPrefix}.>`],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        num_replicas: boundedInteger(replicas, 1, 5, "JetStream replicas"),
        duplicate_window: 120_000_000_000,
        max_age: 30 * 86_400_000_000_000,
      });
    }
  }

  private resolveSubject(value: string): string {
    const candidate = value.startsWith(`${this.subjectPrefix}.`) ? value : `${this.subjectPrefix}.${value}`;
    validateSubject(candidate, true);
    return candidate;
  }

  private relativeSubject(value: string): string {
    return value.startsWith(`${this.subjectPrefix}.`) ? value.slice(this.subjectPrefix.length + 1) : value;
  }
}

interface TraceIndexValue {
  artifactKey: string;
  digest: string;
  bytes: number;
  status: TraceDocument["status"];
  name: string;
  startedAt: string;
  endedAt: string;
  receivedAt?: string;
  tags: string[];
  artifactFormat?: "json" | "ndjson";
  artifactIndex?: number;
}

export class DistributedTraceRepository {
  readonly control: PostgresControlPlane;
  readonly artifacts: S3ArtifactStore;
  readonly queue?: NatsJetStreamQueue;
  constructor(
    control: PostgresControlPlane,
    artifacts: S3ArtifactStore,
    queue?: NatsJetStreamQueue,
  ) { this.control = control; this.artifacts = artifacts; this.queue = queue; }

  async put(scope: DistributedScope, trace: TraceDocument, expectedRevision?: number): Promise<ControlRecord<TraceIndexValue>> {
    validateTraceEnvelope(trace);
    const serialized = Buffer.from(`${JSON.stringify(trace)}\n`);
    const digest = digestBytes(serialized);
    const artifactKey = traceArtifactKey(scope, trace.id, digest);
    const artifact = await this.artifacts.put(artifactKey, serialized, "application/json", { immutable: true }).catch(async (error) => {
      if (httpStatus(error) === 412 && await this.artifacts.exists(artifactKey)) return { key: artifactKey, digest, bytes: serialized.byteLength, contentType: "application/json" };
      throw error;
    });
    const value: TraceIndexValue = {
      artifactKey: artifact.key,
      digest,
      bytes: artifact.bytes,
      status: trace.status,
      name: trace.name,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      ...(trace.receivedAt ? { receivedAt: trace.receivedAt } : {}),
      tags: [...(trace.tags ?? [])],
    };
    let current = await this.control.get<TraceIndexValue>(scope, "traces", trace.id);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (current?.value.digest === digest) {
        if (expectedRevision != null && current.revision !== expectedRevision) throw new ControlRevisionConflictError(current.revision);
        return current;
      }
      const compareRevision = expectedRevision ?? current?.revision ?? 0;
      const revision = compareRevision + 1;
      const eventId = `trace_${createHash("sha256").update(`${scope.organizationId}\0${scope.workspaceId}\0${scope.projectId}\0${trace.id}\0${digest}\0${revision}`).digest("hex")}`;
      try {
        return await this.control.put(scope, "traces", trace.id, value, {
          expectedRevision: compareRevision,
          event: { id: eventId, subject: "trace.ingested", payload: { scope, traceId: trace.id, revision, artifactKey, digest } },
        });
      } catch (error) {
        if (!(error instanceof ControlRevisionConflictError) || expectedRevision != null) throw error;
        current = await this.control.get<TraceIndexValue>(scope, "traces", trace.id);
      }
    }
    throw new ControlRevisionConflictError(current?.revision);
  }

  async putMany(scope: DistributedScope, traces: TraceDocument[]): Promise<Array<ControlRecord<TraceIndexValue>>> {
    if (!Array.isArray(traces) || traces.length < 1 || traces.length > 500) throw new Error("Distributed trace batch must contain 1-500 traces");
    const ids = new Set<string>();
    for (const trace of traces) { validateTraceEnvelope(trace); if (ids.has(trace.id)) throw new Error(`Duplicate trace id in batch: ${trace.id}`); ids.add(trace.id); }
    if (traces.length === 1) return [await this.put(scope, traces[0])];
    const serialized = Buffer.from(`${traces.map((trace) => JSON.stringify(trace)).join("\n")}\n`);
    const digest = digestBytes(serialized);
    const artifactKey = traceBatchArtifactKey(scope, digest);
    const artifact = await this.artifacts.put(artifactKey, serialized, "application/x-ndjson", { immutable: true }).catch(async (error) => {
      if (httpStatus(error) === 412 && await this.artifacts.exists(artifactKey)) return { key: artifactKey, digest, bytes: serialized.byteLength, contentType: "application/x-ndjson" };
      throw error;
    });
    const entries = traces.map((trace, artifactIndex) => ({ id: trace.id, value: traceIndexValue(trace, artifact, { artifactFormat: "ndjson", artifactIndex }) }));
    const eventId = `tracebatch_${createHash("sha256").update(`${scope.organizationId}\0${scope.workspaceId}\0${scope.projectId}\0${digest}`).digest("hex")}`;
    return this.control.putBatch(scope, "traces", entries, { event: { id: eventId, subject: "trace.batch-ingested", payload: { scope, traceIds: traces.map((trace) => trace.id), artifactKey: artifact.key, digest } } });
  }

  async get(scope: DistributedScope, id: string): Promise<TraceDocument | undefined> {
    const record = await this.control.get<TraceIndexValue>(scope, "traces", id);
    if (!record) return undefined;
    const trace = await this.loadIndexed(record.value);
    validateTraceEnvelope(trace);
    if (trace.id !== id) throw new Error("Distributed trace artifact identity mismatch");
    return trace;
  }

  async page(scope: DistributedScope, options: { limit?: number; cursor?: string } = {}): Promise<{ items: TraceDocument[]; hasMore: boolean; nextCursor?: string }> {
    const page = await this.control.list<TraceIndexValue>(scope, "traces", options);
    const artifactCache = new Map<string, Promise<TraceDocument[]>>();
    const items = await Promise.all(page.items.map(async (record) => {
      if (record.value.artifactFormat !== "ndjson") return this.artifacts.getJson<TraceDocument>(record.value.artifactKey, record.value.digest);
      let loaded = artifactCache.get(record.value.artifactKey);
      if (!loaded) { loaded = this.loadBatch(record.value); artifactCache.set(record.value.artifactKey, loaded); }
      const trace = (await loaded)[record.value.artifactIndex ?? -1];
      if (!trace) throw new Error("Distributed trace batch index is invalid");
      return trace;
    }));
    for (const trace of items) validateTraceEnvelope(trace);
    return { items, hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async delete(scope: DistributedScope, id: string, expectedRevision?: number): Promise<boolean> {
    const record = await this.control.get<TraceIndexValue>(scope, "traces", id);
    if (!record) return false;
    const deleted = await this.control.delete(scope, "traces", id, expectedRevision);
    if (deleted && record.value.artifactFormat !== "ndjson") await this.artifacts.delete(record.value.artifactKey);
    return deleted;
  }

  private async loadIndexed(value: TraceIndexValue): Promise<TraceDocument> {
    if (value.artifactFormat !== "ndjson") return this.artifacts.getJson<TraceDocument>(value.artifactKey, value.digest);
    const trace = (await this.loadBatch(value))[value.artifactIndex ?? -1];
    if (!trace) throw new Error("Distributed trace batch index is invalid");
    return trace;
  }

  private async loadBatch(value: TraceIndexValue): Promise<TraceDocument[]> {
    const data = await this.artifacts.get(value.artifactKey, value.digest);
    const traces = Buffer.from(data).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as TraceDocument);
    for (const trace of traces) validateTraceEnvelope(trace);
    return traces;
  }
}

export class DistributedOutboxRelay {
  readonly control: PostgresControlPlane;
  readonly queue: NatsJetStreamQueue;
  readonly workerId: string;
  constructor(control: PostgresControlPlane, queue: NatsJetStreamQueue, workerId = `relay-${process.pid}-${randomUUID().slice(0, 8)}`) {
    this.control = control;
    this.queue = queue;
    validateSegment(workerId, "worker id", 128);
    this.workerId = workerId;
  }

  async flush(limit = 100): Promise<{ published: number; failed: number }> {
    const events = await this.control.claimOutbox(this.workerId, { limit });
    let published = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.queue.publish(event.subject, event.payload, { id: event.id });
        await this.control.completeOutbox(event.id, this.workerId);
        published += 1;
      } catch (error) {
        await this.control.failOutbox(event.id, this.workerId, error, Math.min(60_000, 500 * (2 ** Math.min(event.attempts, 7))));
        failed += 1;
      }
    }
    return { published, failed };
  }

  async run(signal: AbortSignal, intervalMs = 250): Promise<void> {
    const interval = boundedInteger(intervalMs, 50, 60_000, "relay interval");
    while (!signal.aborted) {
      try {
        const result = await this.flush();
        if (result.published === 0 && result.failed === 0) await abortableDelay(interval, signal);
      } catch {
        if (!signal.aborted) await abortableDelay(Math.min(5_000, interval * 4), signal);
      }
    }
  }
}

function validateTraceEnvelope(trace: TraceDocument): void {
  if (!trace || trace.kind !== "dry-run.trace" || trace.version !== 1) throw new Error("Unsupported trace document");
  validateSegment(trace.id, "trace id", 256);
  if (!trace.name?.trim() || !["ok", "error"].includes(trace.status) || !Array.isArray(trace.spans) || !Array.isArray(trace.feedback)) throw new Error("Trace document is invalid");
  if (!Number.isFinite(Date.parse(trace.startedAt)) || !Number.isFinite(Date.parse(trace.endedAt))) throw new Error("Trace timestamps are invalid");
  if (!trace.spans.some((span) => span.id === trace.rootSpanId && span.traceId === trace.id)) throw new Error("Trace root span is invalid");
}

function traceArtifactKey(scope: DistributedScope, id: string, digest: string): string {
  validateScope(scope);
  validateSegment(id, "trace id", 256);
  return ["organizations", scope.organizationId, "workspaces", scope.workspaceId, "projects", scope.projectId, "traces", id, `${digest.slice(7)}.json`].map(encodeURIComponent).join("/");
}

function traceBatchArtifactKey(scope: DistributedScope, digest: string): string {
  validateScope(scope);
  return ["organizations", scope.organizationId, "workspaces", scope.workspaceId, "projects", scope.projectId, "trace-batches", `${digest.slice(7)}.ndjson`].map(encodeURIComponent).join("/");
}

function traceIndexValue(trace: TraceDocument, artifact: StoredArtifact, extra: Pick<TraceIndexValue, "artifactFormat" | "artifactIndex"> = {}): TraceIndexValue {
  return { artifactKey: artifact.key, digest: artifact.digest, bytes: artifact.bytes, status: trace.status, name: trace.name, startedAt: trace.startedAt, endedAt: trace.endedAt, ...(trace.receivedAt ? { receivedAt: trace.receivedAt } : {}), tags: [...(trace.tags ?? [])], ...extra };
}

function validateScope(scope: DistributedScope): void {
  validateSegment(scope.organizationId, "organization id");
  validateSegment(scope.workspaceId, "workspace id");
  validateSegment(scope.projectId, "project id");
}

function validateSegment(value: string, label: string, maximum = 128): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function validateSubject(value: string, wildcards = false): string {
  const allowed = wildcards ? /^[A-Za-z0-9_.>*-]+$/ : /^[A-Za-z0-9_.-]+$/;
  if (!allowed.test(value) || value.startsWith(".") || value.endsWith(".") || value.includes("..") || (!wildcards && /[*>]/.test(value))) throw new Error("NATS subject is invalid");
  return value;
}

function validateNatsName(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`NATS ${label} is invalid`);
  return value;
}

function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("PostgreSQL schema name is invalid");
  return value;
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function mapControlRecord<T>(row: Record<string, unknown>): ControlRecord<T> {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Stored control-plane revision is invalid");
  return {
    organizationId: String(row.organization_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id),
    collection: String(row.collection), id: String(row.id), revision, value: row.value as T,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(), updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
  };
}

function assertJsonValue(value: unknown, label: string): void {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    JSON.parse(serialized);
  } catch { throw new Error(`${label} must be JSON serializable`); }
}

function safeQueueEnvelope(data: Uint8Array): { id: string; payload: unknown } {
  const envelope = JSON.parse(Buffer.from(data).toString("utf8")) as { id?: unknown; payload?: unknown };
  if (typeof envelope.id !== "string" || !("payload" in envelope)) throw new Error("Queue envelope is invalid");
  return { id: envelope.id, payload: envelope.payload };
}

function validateDeadLetter(value: unknown): asserts value is DeadLetterEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dead-letter envelope is invalid");
  const record = value as Record<string, unknown>;
  if (record.kind !== "dry-run.dead-letter" || record.version !== 1 || typeof record.originalSubject !== "string" || typeof record.originalId !== "string" || typeof record.error !== "string" || !Number.isSafeInteger(record.deliveries) || !Number.isSafeInteger(record.redrives)) throw new Error("Dead-letter envelope is invalid");
  validateSubject(record.originalSubject);
}

function validateControlSnapshot(value: unknown): asserts value is ControlPlaneSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Control-plane snapshot is invalid");
  const snapshot = value as ControlPlaneSnapshot;
  if (snapshot.kind !== "dry-run.control-plane-snapshot" || snapshot.version !== 1 || !Number.isFinite(Date.parse(snapshot.createdAt)) || !Array.isArray(snapshot.records)) throw new Error("Control-plane snapshot is invalid");
  for (const record of snapshot.records) {
    validateScope(record);
    validateSegment(record.collection, "collection");
    validateSegment(record.id, "document id", 256);
    if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error("Control-plane snapshot record is invalid");
    assertJsonValue(record.value, "control-plane snapshot value");
  }
}

function encodeCursor(value: { updatedAt: string; id: string }): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value: string): { updatedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt)) || typeof parsed.id !== "string") throw new Error();
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch { throw new Error("Invalid control-plane cursor"); }
}

function validateBucket(value: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..")) throw new Error("S3 bucket name is invalid");
  return value;
}
function normalizePrefix(value: string): string {
  const normalized = trimSlashes(value);
  if (!normalized || normalized.length > 256) throw new Error("S3 artifact prefix is invalid");
  return validateObjectKey(normalized);
}
function validateObjectKey(value: string): string {
  if (!value || value.length > 1024 || value.includes("\0") || value.split("/").some((part) => part === "..")) throw new Error("S3 artifact key is invalid");
  return value;
}
function safeObjectKey(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function normalizeEndpoint(value: string, requireTls: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (requireTls && url.protocol !== "https:") || (!requireTls && !["http:", "https:"].includes(url.protocol))) throw new Error("S3 endpoint is invalid or violates the TLS policy");
  return url.origin;
}
function digestBytes(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}
function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactUrlCredentials(message.slice(0, 2_000)).slice(0, 500);
}
function round(value: number): number { return Math.round(value * 100) / 100; }
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
