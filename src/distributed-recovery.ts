import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { DistributedRuntime } from "./distributed-runtime.ts";
import type { ControlPlaneSnapshot, DistributedScope } from "./distributed.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const RECOVERY_SCOPE: DistributedScope = { organizationId: "system", workspaceId: "system", projectId: "system" };

export interface RecoveryArtifactCopy {
  originalKey: string;
  backupKey: string;
  digest: string;
  bytes: number;
}

export interface DistributedRecoveryPoint {
  kind: "dry-run.distributed-recovery";
  version: 1;
  label: string;
  createdAt: string;
  snapshotKey: string;
  snapshotDigest: string;
  records: number;
  artifacts: RecoveryArtifactCopy[];
}

interface SealedRecovery {
  kind: "dry-run.sealed-recovery";
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class DistributedRecoveryManager {
  private readonly key: Buffer;
  private readonly runtime: DistributedRuntime;
  constructor(runtime: DistributedRuntime, secret: string) { this.runtime = runtime; this.key = deriveKey(secret); }

  async create(label: string, scope?: Partial<DistributedScope>): Promise<DistributedRecoveryPoint> {
    const id = validateLabel(label);
    return this.runtime.control.withAdvisoryLock(`recovery:${id}`, async () => {
      const snapshot = await this.runtime.control.exportSnapshot(scope);
      const artifactKeys = [...collectArtifactKeys(snapshot)].sort();
      const copies: RecoveryArtifactCopy[] = [];
      for (const originalKey of artifactKeys) {
        const data = await this.runtime.artifacts.get(originalKey);
        const digest = sha256(data);
        const backupPath = `recovery/${encodeURIComponent(id)}/objects/${digest.slice(7)}`;
        const stored = await this.runtime.artifacts.put(backupPath, data, "application/octet-stream", { immutable: true }).catch(async (error) => {
          if (await this.runtime.artifacts.exists(backupPath)) return { key: backupPath, digest, bytes: data.length, contentType: "application/octet-stream" };
          throw error;
        });
        copies.push({ originalKey, backupKey: stored.key, digest: stored.digest, bytes: stored.bytes });
      }
      const compressed = Buffer.from(await gzipAsync(Buffer.from(JSON.stringify(snapshot)), { level: 9 }));
      const sealed = Buffer.from(`${JSON.stringify(seal(compressed, this.key))}\n`);
      const stored = await this.runtime.artifacts.put(`recovery/${encodeURIComponent(id)}/control-${sha256(sealed).slice(7)}.json`, sealed, "application/vnd.dryrun.sealed-recovery+json", { immutable: true });
      const point: DistributedRecoveryPoint = {
        kind: "dry-run.distributed-recovery", version: 1, label: id, createdAt: new Date().toISOString(),
        snapshotKey: stored.key, snapshotDigest: stored.digest, records: snapshot.records.length, artifacts: copies,
      };
      const current = await this.runtime.control.get(RECOVERY_SCOPE, "recovery-points", id);
      await this.runtime.control.put(RECOVERY_SCOPE, "recovery-points", id, point, { expectedRevision: current?.revision ?? 0 });
      return point;
    });
  }

  async list(): Promise<DistributedRecoveryPoint[]> {
    const points: DistributedRecoveryPoint[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.runtime.control.list<DistributedRecoveryPoint>(RECOVERY_SCOPE, "recovery-points", { limit: 500, ...(cursor ? { cursor } : {}) });
      for (const record of page.items) { validatePoint(record.value); points.push(record.value); }
      cursor = page.nextCursor;
    } while (cursor);
    return points.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async verify(label: string): Promise<{ ok: true; records: number; artifacts: number; bytes: number }> {
    const point = await this.load(label);
    await this.readSnapshot(point);
    for (const artifact of point.artifacts) await this.runtime.artifacts.get(artifact.backupKey, artifact.digest);
    return { ok: true, records: point.records, artifacts: point.artifacts.length, bytes: point.artifacts.reduce((sum, item) => sum + item.bytes, 0) };
  }

  async restore(label: string, options: { replace?: boolean } = {}): Promise<{ imported: number; restoredArtifacts: number }> {
    const id = validateLabel(label);
    return this.runtime.control.withAdvisoryLock(`recovery:${id}`, async () => {
      const point = await this.load(id);
      const snapshot = await this.readSnapshot(point);
      let restoredArtifacts = 0;
      for (const artifact of point.artifacts) {
        if (await this.runtime.artifacts.exists(artifact.originalKey)) {
          await this.runtime.artifacts.get(artifact.originalKey, artifact.digest);
          continue;
        }
        const data = await this.runtime.artifacts.get(artifact.backupKey, artifact.digest);
        await this.runtime.artifacts.restore(artifact.originalKey, data, "application/octet-stream", { immutable: true });
        restoredArtifacts += 1;
      }
      const imported = await this.runtime.control.importSnapshot(snapshot, { replace: options.replace });
      return { imported: imported.imported, restoredArtifacts };
    });
  }

  private async load(label: string): Promise<DistributedRecoveryPoint> {
    const record = await this.runtime.control.get<DistributedRecoveryPoint>(RECOVERY_SCOPE, "recovery-points", validateLabel(label));
    if (!record) throw new Error(`Unknown distributed recovery point: ${label}`);
    validatePoint(record.value);
    return record.value;
  }

  private async readSnapshot(point: DistributedRecoveryPoint): Promise<ControlPlaneSnapshot> {
    const bytes = await this.runtime.artifacts.get(point.snapshotKey, point.snapshotDigest);
    let sealed: SealedRecovery;
    try { sealed = JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedRecovery; }
    catch { throw new Error("Recovery control snapshot is not valid JSON"); }
    const snapshot = JSON.parse(Buffer.from(await gunzipAsync(openSealed(sealed, this.key))).toString("utf8")) as ControlPlaneSnapshot;
    if (snapshot.kind !== "dry-run.control-plane-snapshot" || snapshot.version !== 1 || !Array.isArray(snapshot.records) || snapshot.records.length !== point.records) throw new Error("Recovery control snapshot is invalid");
    return snapshot;
  }
}

function collectArtifactKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) collectArtifactKeys(item, found);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (key === "artifactKey" && typeof item === "string") found.add(item);
    else collectArtifactKeys(item, found);
  }
  return found;
}

function seal(value: Uint8Array, key: Buffer): SealedRecovery {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return { kind: "dry-run.sealed-recovery", version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function openSealed(value: SealedRecovery, key: Buffer): Buffer {
  if (!value || value.kind !== "dry-run.sealed-recovery" || value.version !== 1 || value.algorithm !== "aes-256-gcm") throw new Error("Unsupported sealed recovery artifact");
  try { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64")); decipher.setAuthTag(Buffer.from(value.tag, "base64")); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]); }
  catch { throw new Error("Recovery snapshot decryption failed; verify DRYRUN_STATE_ENCRYPTION_KEY"); }
}

function validatePoint(value: DistributedRecoveryPoint): void {
  if (!value || value.kind !== "dry-run.distributed-recovery" || value.version !== 1 || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.artifacts) || !Number.isSafeInteger(value.records)) throw new Error("Distributed recovery point is invalid");
  validateLabel(value.label);
  if (!/^sha256:[a-f0-9]{64}$/.test(value.snapshotDigest)) throw new Error("Distributed recovery point checksum is invalid");
  for (const item of value.artifacts) if (!item.originalKey || !item.backupKey || !/^sha256:[a-f0-9]{64}$/.test(item.digest) || !Number.isSafeInteger(item.bytes)) throw new Error("Distributed recovery artifact is invalid");
}

function validateLabel(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error("Recovery label is invalid"); return value; }
function deriveKey(secret: string): Buffer { if (typeof secret !== "string" || secret.length < 32 || secret.length > 4096) throw new Error("Recovery encryption secret must contain 32-4096 characters"); return createHash("sha256").update(secret).digest(); }
function sha256(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
