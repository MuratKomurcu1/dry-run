import { existsSync, readdirSync, statfsSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { redactDeep } from "./cassette.ts";
import type { ExperimentDocument } from "./experiment.ts";
import type { TraceDocument, TraceExporter } from "./tracing.ts";
import { atomicWriteJson, ensurePrivateDirectory, readJsonFile, sha256, withFileLock } from "./storage.ts";
import { DRY_RUN_VERSION } from "./version.ts";

export interface RemoteTeamClientOptions {
  endpoint: string;
  project: string;
  token: string;
  timeoutMs?: number;
  retries?: number;
  allowInsecureHttp?: boolean;
  fetch?: typeof globalThis.fetch;
}

export class RemoteTeamClient {
  readonly endpoint: string;
  readonly project: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly request: typeof globalThis.fetch;

  constructor(opts: RemoteTeamClientOptions) {
    const endpoint = new URL(opts.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Remote team endpoint cannot contain credentials, query parameters, or a fragment");
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
    if (endpoint.protocol !== "https:" && !(opts.allowInsecureHttp && isLoopback(endpoint.hostname))) {
      throw new Error("Remote team endpoint must use HTTPS; plaintext HTTP is allowed only for an explicitly enabled loopback endpoint");
    }
    if (!opts.project.trim()) throw new Error("Remote project cannot be empty");
    if (!opts.token.startsWith("drk_") || opts.token.length < 20) throw new Error("Invalid Dry Run team token");
    this.endpoint = endpoint.toString().replace(/\/$/, "");
    this.project = opts.project;
    this.token = opts.token;
    this.timeoutMs = positiveInteger(opts.timeoutMs ?? 10_000, "timeoutMs");
    this.retries = nonNegativeInteger(opts.retries ?? 3, "retries");
    this.request = opts.fetch ?? globalThis.fetch;
  }

  async uploadTraces(traces: TraceDocument[]): Promise<{ accepted: number; ids: string[] }> {
    if (!traces.length || traces.length > 500) throw new Error("Trace batch must contain 1-500 documents");
    return this.post(`/api/v1/projects/${encodeURIComponent(this.project)}/traces`, { traces });
  }

  async uploadExperiments(experiments: ExperimentDocument[]): Promise<{ accepted: number; ids: string[] }> {
    if (!experiments.length || experiments.length > 100) throw new Error("Experiment batch must contain 1-100 documents");
    return this.post(`/api/v1/projects/${encodeURIComponent(this.project)}/experiments`, { experiments });
  }

  async requestJson<T = unknown>(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    return this.perform<T>(pathname, method, init.body);
  }

  private async post<T>(pathname: string, body: unknown): Promise<T> { return this.perform<T>(pathname, "POST", body); }

  private async perform<T>(pathname: string, method: string, body?: unknown): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await this.request(`${this.endpoint}${pathname}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            "User-Agent": `@muratkomurcu/dry-run/${DRY_RUN_VERSION}`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "error",
        });
        if (!response.ok) {
          const error = new RemoteTeamError(`Dry Run team server returned HTTP ${response.status}`, response.status);
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
          const retryAfter = Number(response.headers.get("retry-after"));
          if (attempt < this.retries) await delay(Number.isFinite(retryAfter) ? Math.min(10_000, retryAfter * 1_000) : backoff(attempt));
          continue;
        }
        if (response.status === 204) return undefined as T;
        return await response.json() as T;
      } catch (error) {
        lastError = sanitizeRemoteError(error);
        if (error instanceof RemoteTeamError && error.status < 500 && error.status !== 429) throw error;
        if (attempt < this.retries) await delay(backoff(attempt));
      }
    }
    throw lastError ?? new Error("Remote team request failed");
  }
}

export interface RemoteTraceExporterOptions extends RemoteTeamClientOptions {
  spoolDir?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  throwOnError?: boolean;
  maxSpoolBytes?: number;
  maxSpoolFiles?: number;
  minFreeBytes?: number;
}

export interface RemoteSpoolUsage {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
  freeBytes: number;
  minFreeBytes: number;
}

export class RemoteTraceExporter implements TraceExporter {
  readonly spoolDir: string;
  readonly client: RemoteTeamClient;
  private readonly batchSize: number;
  private readonly throwOnError: boolean;
  private readonly maxSpoolBytes: number;
  private readonly maxSpoolFiles: number;
  private readonly minFreeBytes: number;
  private readonly timer: NodeJS.Timeout;
  private flushing?: Promise<number>;
  private closed = false;

  constructor(opts: RemoteTraceExporterOptions) {
    this.client = new RemoteTeamClient(opts);
    this.batchSize = positiveInteger(opts.batchSize ?? 50, "batchSize");
    if (this.batchSize > 500) throw new Error("batchSize cannot exceed 500");
    this.throwOnError = opts.throwOnError ?? false;
    this.maxSpoolBytes = positiveInteger(opts.maxSpoolBytes ?? 512 * 1024 * 1024, "maxSpoolBytes");
    this.maxSpoolFiles = positiveInteger(opts.maxSpoolFiles ?? 50_000, "maxSpoolFiles");
    this.minFreeBytes = nonNegativeInteger(opts.minFreeBytes ?? 64 * 1024 * 1024, "minFreeBytes");
    const queueId = sha256(`${this.client.endpoint}\n${this.client.project}`).slice(7, 23);
    this.spoolDir = path.resolve(opts.spoolDir ?? path.join(".dryrun", "remote-spool", queueId));
    ensurePrivateDirectory(this.spoolDir);
    const flushIntervalMs = positiveInteger(opts.flushIntervalMs ?? 1_000, "flushIntervalMs");
    this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, flushIntervalMs);
    this.timer.unref();
  }

  async export(trace: TraceDocument): Promise<void> {
    if (this.closed) throw new Error("RemoteTraceExporter is shut down");
    const file = this.spoolFile(trace.id);
    const document = redactDeep(trace, true);
    const bytes = Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`);
    await withFileLock(path.join(this.spoolDir, ".capacity"), () => {
      const usage = this.spoolUsage();
      const existingBytes = existsSync(file) ? statSync(file).size : 0;
      const projectedBytes = usage.bytes - existingBytes + bytes;
      const projectedFiles = usage.files + (existsSync(file) ? 0 : 1);
      const requiredFreeBytes = this.minFreeBytes + Math.max(0, bytes - existingBytes);
      if (projectedBytes > this.maxSpoolBytes || projectedFiles > this.maxSpoolFiles || usage.freeBytes < requiredFreeBytes) {
        throw new RemoteSpoolFullError({ ...usage, files: projectedFiles, bytes: projectedBytes });
      }
      atomicWriteJson(file, document);
    });
    if (this.pending() >= this.batchSize) {
      try { await this.flush(); }
      catch (error) { if (this.throwOnError) throw error; }
    }
  }

  pending(): number { return existsSync(this.spoolDir) ? readdirSync(this.spoolDir).filter((file) => file.endsWith(".json")).length : 0; }

  spoolUsage(): RemoteSpoolUsage {
    const files = existsSync(this.spoolDir) ? readdirSync(this.spoolDir).filter((file) => file.endsWith(".json")) : [];
    const stats = statfsSync(this.spoolDir);
    return {
      files: files.length,
      bytes: files.reduce((total, name) => total + statSync(path.join(this.spoolDir, name)).size, 0),
      maxFiles: this.maxSpoolFiles,
      maxBytes: this.maxSpoolBytes,
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      minFreeBytes: this.minFreeBytes,
    };
  }

  async flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    try { await this.flush(); }
    catch (error) { if (this.throwOnError) throw error; }
  }

  private async drain(): Promise<number> {
    let uploaded = 0;
    while (true) {
      const files = readdirSync(this.spoolDir).filter((file) => file.endsWith(".json")).sort().slice(0, this.batchSize);
      if (!files.length) return uploaded;
      const documents: TraceDocument[] = [];
      const acceptedFiles: Array<{ file: string; digest: string }> = [];
      for (const name of files) {
        const file = path.join(this.spoolDir, name);
        try {
          const value = readJsonFile(file);
          if (!isTrace(value)) continue;
          documents.push(value);
          acceptedFiles.push({ file, digest: sha256(JSON.stringify(value)) });
        } catch { /* Leave malformed files for operator inspection instead of deleting them. */ }
      }
      if (!documents.length) return uploaded;
      await this.client.uploadTraces(documents);
      await withFileLock(path.join(this.spoolDir, ".capacity"), () => {
        for (const accepted of acceptedFiles) {
          if (!existsSync(accepted.file)) continue;
          try {
            const current = readJsonFile(accepted.file);
            if (sha256(JSON.stringify(current)) === accepted.digest) unlinkSync(accepted.file);
          } catch { /* Preserve changed or malformed files for the next flush/operator inspection. */ }
        }
      });
      uploaded += documents.length;
    }
  }

  private spoolFile(id: string): string {
    if (!/^[a-zA-Z0-9_.-]{1,192}$/.test(id)) throw new Error("Invalid trace id");
    return path.join(this.spoolDir, `${id}.json`);
  }
}

export class RemoteTeamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "RemoteTeamError"; this.status = status; }
}

export class RemoteSpoolFullError extends Error {
  readonly usage: RemoteSpoolUsage;
  constructor(usage: RemoteSpoolUsage) {
    super(`Remote trace spool capacity reached (${usage.files}/${usage.maxFiles} files, ${usage.bytes}/${usage.maxBytes} bytes)`);
    this.name = "RemoteSpoolFullError";
    this.usage = usage;
  }
}

function isTrace(value: unknown): value is TraceDocument {
  return typeof value === "object" && value !== null && (value as any).kind === "dry-run.trace" && (value as any).version === 1 && typeof (value as any).id === "string";
}

function isLoopback(host: string): boolean { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase()); }
function positiveInteger(value: number, name: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value; }
function nonNegativeInteger(value: number, name: string): number { if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`); return value; }
function backoff(attempt: number): number { return Math.min(5_000, 100 * 2 ** attempt + Math.floor(Math.random() * 100)); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sanitizeRemoteError(error: unknown): Error {
  if (error instanceof RemoteTeamError) return error;
  if (error instanceof Error && error.name === "TimeoutError") return new Error("Dry Run team request timed out");
  return new Error(`Dry Run team request failed: ${error instanceof Error ? error.message : String(error)}`);
}
