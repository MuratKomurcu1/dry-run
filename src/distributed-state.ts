import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { DistributedRuntime } from "./distributed-runtime.ts";
import type { ControlRecord, DistributedScope } from "./distributed.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const BOOTSTRAP_SCOPE: DistributedScope = { organizationId: "system", workspaceId: "system", projectId: "system" };
const MAX_FILES = 250_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface WorkspaceStatePointer {
  kind: "dry-run.workspace-state";
  version: 1;
  alias: string;
  artifactKey: string;
  artifactDigest: string;
  contentDigest: string;
  files: number;
  bytes: number;
  createdAt: string;
  excluded: string[];
}

interface WorkspaceArchive {
  kind: "dry-run.workspace-archive";
  version: 1;
  createdAt: string;
  entries: Array<{ path: string; mode: number; bytes: number; content: string }>;
}

interface SealedArchive {
  kind: "dry-run.sealed-workspace";
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface DistributedStateStatus {
  enabled: true;
  alias: string;
  revision: number;
  contentDigest: string;
  files: number;
  bytes: number;
  encrypted: true;
  sharedPosixRequired: false;
}

/**
 * Bridges the existing synchronous file stores to a stateless multi-node
 * deployment. PostgreSQL serializes mutations and stores the CAS pointer;
 * MinIO/S3 stores immutable, encrypted workspace snapshots. Trace payloads are
 * deliberately excluded because DistributedTraceRepository is their source of
 * truth.
 */
export class DistributedWorkspaceState {
  readonly dir: string;
  readonly alias: string;
  private readonly runtime: DistributedRuntime;
  private readonly key: Buffer;
  private current?: ControlRecord<WorkspaceStatePointer>;

  private constructor(runtime: DistributedRuntime, dir: string, alias: string, secret: string) {
    this.runtime = runtime;
    this.dir = path.resolve(dir);
    this.alias = validateAlias(alias);
    this.key = deriveKey(secret);
  }

  static async open(runtime: DistributedRuntime, dir: string, options: { alias?: string; encryptionSecret: string }): Promise<DistributedWorkspaceState> {
    const state = new DistributedWorkspaceState(runtime, dir, options.alias ?? "default", options.encryptionSecret);
    await state.runtime.control.withAdvisoryLock(state.lockName(), async () => state.initializeLocked());
    return state;
  }

  async transact<T>(fn: () => Promise<T>): Promise<T> {
    return this.runtime.control.withAdvisoryLock(this.lockName(), async () => {
      await this.pullLocked();
      let result: T | undefined;
      let failure: unknown;
      try { result = await fn(); }
      catch (error) { failure = error; }
      try { await this.publishIfChangedLocked(); }
      catch (publishError) {
        if (failure) throw new AggregateError([failure, publishError], "Request and distributed state persistence both failed");
        throw publishError;
      }
      if (failure) throw failure;
      return result as T;
    });
  }

  async checkpoint(): Promise<WorkspaceStatePointer> {
    return this.runtime.control.withAdvisoryLock(this.lockName(), async () => {
      await this.pullLocked();
      await this.publishIfChangedLocked();
      if (!this.current) throw new Error("Distributed workspace state is unavailable");
      return structuredClone(this.current.value);
    });
  }

  status(): DistributedStateStatus {
    if (!this.current) throw new Error("Distributed workspace state is unavailable");
    return {
      enabled: true, alias: this.alias, revision: this.current.revision,
      contentDigest: this.current.value.contentDigest, files: this.current.value.files,
      bytes: this.current.value.bytes, encrypted: true, sharedPosixRequired: false,
    };
  }

  private async initializeLocked(): Promise<void> {
    const remote = await this.runtime.control.get<WorkspaceStatePointer>(BOOTSTRAP_SCOPE, "workspace-state", this.alias);
    if (remote) {
      validatePointer(remote.value, this.alias);
      await this.restore(remote.value);
      this.current = remote;
      return;
    }
    if (!existsSync(path.join(this.dir, "workspace.json"))) throw new Error(`Distributed workspace ${this.alias} has not been seeded and ${this.dir} is empty`);
    const archive = await captureWorkspace(this.dir);
    this.current = await this.publishArchive(archive, 0);
  }

  private async pullLocked(): Promise<void> {
    const remote = await this.runtime.control.get<WorkspaceStatePointer>(BOOTSTRAP_SCOPE, "workspace-state", this.alias);
    if (!remote) throw new Error(`Distributed workspace state disappeared: ${this.alias}`);
    validatePointer(remote.value, this.alias);
    if (!this.current || remote.revision !== this.current.revision || remote.value.contentDigest !== this.current.value.contentDigest) await this.restore(remote.value);
    this.current = remote;
  }

  private async publishIfChangedLocked(): Promise<void> {
    const archive = await captureWorkspace(this.dir);
    if (archive.contentDigest === this.current?.value.contentDigest) return;
    this.current = await this.publishArchive(archive, this.current?.revision ?? 0);
  }

  private async publishArchive(archive: CapturedWorkspace, expectedRevision: number): Promise<ControlRecord<WorkspaceStatePointer>> {
    const sealed = seal(archive.compressed, this.key);
    const sealedBytes = Buffer.from(`${JSON.stringify(sealed)}\n`);
    const sealedDigest = digest(sealedBytes);
    const artifactKey = `workspace-state/${encodeURIComponent(this.alias)}/${sealedDigest.slice(7)}.json`;
    const stored = await this.runtime.artifacts.put(artifactKey, sealedBytes, "application/vnd.dryrun.sealed-workspace+json", { immutable: true }).catch(async (error) => {
      if (await this.runtime.artifacts.exists(artifactKey)) return { key: artifactKey, digest: sealedDigest, bytes: sealedBytes.length, contentType: "application/vnd.dryrun.sealed-workspace+json" };
      throw error;
    });
    const pointer: WorkspaceStatePointer = {
      kind: "dry-run.workspace-state", version: 1, alias: this.alias,
      artifactKey: stored.key, artifactDigest: stored.digest, contentDigest: archive.contentDigest,
      files: archive.files, bytes: archive.bytes, createdAt: new Date().toISOString(),
      excluded: ["projects/*/traces/**", "*.lock", "*.tmp-*"],
    };
    return this.runtime.control.put(BOOTSTRAP_SCOPE, "workspace-state", this.alias, pointer, {
      expectedRevision,
      event: { subject: "workspace.updated", payload: { alias: this.alias, contentDigest: archive.contentDigest } },
    });
  }

  private async restore(pointer: WorkspaceStatePointer): Promise<void> {
    const sealedBytes = await this.runtime.artifacts.get(pointer.artifactKey, pointer.artifactDigest);
    let sealed: SealedArchive;
    try { sealed = JSON.parse(Buffer.from(sealedBytes).toString("utf8")) as SealedArchive; }
    catch { throw new Error("Distributed workspace artifact is not valid JSON"); }
    const compressed = openSealed(sealed, this.key);
    if (digest(compressed) !== pointer.contentDigest) throw new Error("Distributed workspace content checksum mismatch");
    const archive = parseArchive(JSON.parse(Buffer.from(await gunzipAsync(compressed)).toString("utf8")));
    const parent = path.dirname(this.dir);
    const staging = path.join(parent, `.dryrun-state-${randomUUID()}`);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      for (const entry of archive.entries) {
        const target = path.join(staging, ...entry.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const content = Buffer.from(entry.content, "base64");
        if (content.length !== entry.bytes) throw new Error(`Workspace archive size mismatch: ${entry.path}`);
        await writeFile(target, content, { mode: entry.mode, flag: "wx" });
        await chmod(target, entry.mode);
      }
      const existing = await stat(this.dir).catch(() => undefined);
      const previous = path.join(parent, `.dryrun-state-previous-${randomUUID()}`);
      if (existing) await rename(this.dir, previous);
      try { await rename(staging, this.dir); }
      catch (error) { if (existing) await rename(previous, this.dir).catch(() => undefined); throw error; }
      if (existing) await rm(previous, { recursive: true, force: true });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private lockName(): string { return `workspace-state:${this.alias}`; }
}

interface CapturedWorkspace { compressed: Buffer; contentDigest: string; files: number; bytes: number }

async function captureWorkspace(root: string): Promise<CapturedWorkspace> {
  const entries: WorkspaceArchive["entries"] = [];
  let bytes = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded(relative, entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Distributed state refuses symbolic link: ${relative}`);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) {
        const info = await lstat(full);
        const content = await readFile(full);
        bytes += content.length;
        if (entries.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error("Distributed workspace snapshot exceeds its safety limit");
        entries.push({ path: relative, mode: info.mode & 0o777, bytes: content.length, content: content.toString("base64") });
      } else throw new Error(`Distributed state refuses special file: ${relative}`);
    }
  }
  await walk(root, "");
  const archive: WorkspaceArchive = { kind: "dry-run.workspace-archive", version: 1, createdAt: new Date(0).toISOString(), entries };
  const compressed = Buffer.from(await gzipAsync(Buffer.from(JSON.stringify(archive)), { level: 9 }));
  return { compressed, contentDigest: digest(compressed), files: entries.length, bytes };
}

function excluded(relative: string, name: string): boolean {
  if (name.endsWith(".lock") || name.includes(".tmp-") || name.startsWith(".dryrun-state-")) return true;
  return /(^|\/)projects\/[^/]+\/traces(?:\/|$)/.test(relative);
}

function seal(value: Uint8Array, key: Buffer): SealedArchive {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return { kind: "dry-run.sealed-workspace", version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function openSealed(value: SealedArchive, key: Buffer): Buffer {
  if (!value || value.kind !== "dry-run.sealed-workspace" || value.version !== 1 || value.algorithm !== "aes-256-gcm") throw new Error("Unsupported sealed workspace artifact");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
  } catch { throw new Error("Distributed workspace decryption failed; verify DRYRUN_STATE_ENCRYPTION_KEY"); }
}

function parseArchive(value: unknown): WorkspaceArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace archive is invalid");
  const archive = value as WorkspaceArchive;
  if (archive.kind !== "dry-run.workspace-archive" || archive.version !== 1 || !Array.isArray(archive.entries) || archive.entries.length > MAX_FILES) throw new Error("Workspace archive is invalid");
  let total = 0;
  const seen = new Set<string>();
  for (const entry of archive.entries) {
    if (!entry || !safeRelative(entry.path) || seen.has(entry.path) || !Number.isSafeInteger(entry.mode) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.content !== "string") throw new Error("Workspace archive contains an invalid entry");
    seen.add(entry.path); total += entry.bytes;
    if (total > MAX_BYTES) throw new Error("Workspace archive exceeds its safety limit");
  }
  return archive;
}

function validatePointer(value: WorkspaceStatePointer, alias: string): void {
  if (!value || value.kind !== "dry-run.workspace-state" || value.version !== 1 || value.alias !== alias || !value.artifactKey || !/^sha256:[a-f0-9]{64}$/.test(value.artifactDigest) || !/^sha256:[a-f0-9]{64}$/.test(value.contentDigest) || !Number.isSafeInteger(value.files) || !Number.isSafeInteger(value.bytes)) throw new Error("Distributed workspace pointer is invalid");
}

function validateAlias(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error("Distributed workspace alias is invalid");
  return value;
}

function deriveKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 4096) throw new Error("DRYRUN_STATE_ENCRYPTION_KEY must contain 32-4096 characters");
  return createHash("sha256").update(secret, "utf8").digest();
}

function digest(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function safeRelative(value: string): boolean { return value.length > 0 && value.length <= 2048 && !value.includes("\\") && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== ".."); }
