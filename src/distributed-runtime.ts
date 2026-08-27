import type { PoolConfig } from "pg";
import { DistributedOutboxRelay, DistributedTraceRepository, NatsJetStreamQueue, PostgresControlPlane, S3ArtifactStore, type S3ArtifactStoreOptions } from "./distributed.ts";

export interface DistributedRuntimeOptions {
  postgres: PoolConfig & { schema?: string };
  artifacts: S3ArtifactStoreOptions;
  nats: { servers: string | string[]; stream?: string; subjectPrefix?: string; replicas?: number; user?: string; pass?: string; token?: string };
  relayIntervalMs?: number;
}
export interface DistributedRuntimeHealth { ok: boolean; postgres?: { latencyMs: number }; artifacts?: { latencyMs: number }; queue?: { latencyMs: number }; error?: string }

export class DistributedRuntime {
  readonly control: PostgresControlPlane;
  readonly artifacts: S3ArtifactStore;
  readonly queue: NatsJetStreamQueue;
  readonly traces: DistributedTraceRepository;
  readonly relay: DistributedOutboxRelay;
  private readonly relayIntervalMs: number;
  private readonly abort = new AbortController();
  private relayTask?: Promise<void>;
  private closed = false;
  private constructor(control: PostgresControlPlane, artifacts: S3ArtifactStore, queue: NatsJetStreamQueue, relayIntervalMs: number) {
    this.control = control;
    this.artifacts = artifacts;
    this.queue = queue;
    this.relayIntervalMs = relayIntervalMs;
    this.traces = new DistributedTraceRepository(control, artifacts, queue);
    this.relay = new DistributedOutboxRelay(control, queue);
  }
  static async create(options: DistributedRuntimeOptions): Promise<DistributedRuntime> {
    const control = new PostgresControlPlane(options.postgres), artifacts = new S3ArtifactStore(options.artifacts);
    let queue: NatsJetStreamQueue | undefined;
    try {
      await Promise.all([control.initialize(), artifacts.initialize()]);
      queue = await NatsJetStreamQueue.connect(options.nats);
      const runtime = new DistributedRuntime(control, artifacts, queue, bounded(options.relayIntervalMs ?? 250, 50, 60_000, "relayIntervalMs"));
      runtime.relayTask = runtime.relay.run(runtime.abort.signal, runtime.relayIntervalMs);
      return runtime;
    } catch (error) {
      await Promise.allSettled([control.close(), artifacts.close(), queue?.close()]);
      throw error;
    }
  }
  async health(): Promise<DistributedRuntimeHealth> {
    try {
      const [postgres, artifacts, queue] = await Promise.all([this.control.health(), this.artifacts.health(), this.queue.health()]);
      return { ok: true, postgres: { latencyMs: postgres.latencyMs }, artifacts: { latencyMs: artifacts.latencyMs }, queue: { latencyMs: queue.latencyMs } };
    } catch (error) { return { ok: false, error: safeError(error) }; }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.abort.abort();
    await this.relayTask?.catch(() => undefined);
    await Promise.allSettled([this.queue.close(), this.artifacts.close(), this.control.close()]);
  }
}

export async function distributedRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<DistributedRuntime | undefined> {
  const postgres = env.DRYRUN_POSTGRES_URL, endpoint = env.DRYRUN_S3_ENDPOINT, bucket = env.DRYRUN_S3_BUCKET, nats = env.DRYRUN_NATS_URL;
  const configured = [postgres, endpoint, bucket, nats].filter(Boolean).length;
  if (!configured) return undefined;
  if (configured !== 4) throw new Error("Distributed mode requires DRYRUN_POSTGRES_URL, DRYRUN_S3_ENDPOINT, DRYRUN_S3_BUCKET, and DRYRUN_NATS_URL together");
  const accessKeyId = env.DRYRUN_S3_ACCESS_KEY, secretAccessKey = env.DRYRUN_S3_SECRET_KEY;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error("DRYRUN_S3_ACCESS_KEY and DRYRUN_S3_SECRET_KEY must be set together");
  return DistributedRuntime.create({
    postgres: { connectionString: postgres, ...(env.DRYRUN_POSTGRES_SCHEMA ? { schema: env.DRYRUN_POSTGRES_SCHEMA } : {}), max: env.DRYRUN_POSTGRES_POOL_SIZE ? bounded(Number(env.DRYRUN_POSTGRES_POOL_SIZE), 1, 100, "DRYRUN_POSTGRES_POOL_SIZE") : 20, application_name: "dry-run" },
    artifacts: { endpoint, bucket: bucket!, ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}), ...(env.DRYRUN_S3_REGION ? { region: env.DRYRUN_S3_REGION } : {}), prefix: env.DRYRUN_S3_PREFIX ?? "dryrun", forcePathStyle: env.DRYRUN_S3_FORCE_PATH_STYLE !== "false", createBucket: env.DRYRUN_S3_CREATE_BUCKET !== "false", tls: env.DRYRUN_S3_TLS !== "false" },
    nats: { servers: nats!, ...(env.DRYRUN_NATS_STREAM ? { stream: env.DRYRUN_NATS_STREAM } : {}), ...(env.DRYRUN_NATS_SUBJECT_PREFIX ? { subjectPrefix: env.DRYRUN_NATS_SUBJECT_PREFIX } : {}), replicas: env.DRYRUN_NATS_REPLICAS ? bounded(Number(env.DRYRUN_NATS_REPLICAS), 1, 5, "DRYRUN_NATS_REPLICAS") : 1, ...(env.DRYRUN_NATS_USER ? { user: env.DRYRUN_NATS_USER } : {}), ...(env.DRYRUN_NATS_PASSWORD ? { pass: env.DRYRUN_NATS_PASSWORD } : {}), ...(env.DRYRUN_NATS_TOKEN ? { token: env.DRYRUN_NATS_TOKEN } : {}) },
    ...(env.DRYRUN_OUTBOX_INTERVAL_MS ? { relayIntervalMs: bounded(Number(env.DRYRUN_OUTBOX_INTERVAL_MS), 50, 60_000, "DRYRUN_OUTBOX_INTERVAL_MS") } : {}),
  });
}
function bounded(value: number, minimum: number, maximum: number, name: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return value; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(?:postgres(?:ql)?|nats|https?):\/\/[^\s@]+@/gi, (match) => match.replace(/\/\/.*@/, "//[redacted]@")).slice(0, 300); }
