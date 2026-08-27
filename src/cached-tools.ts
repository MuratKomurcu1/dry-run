import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CassetteMode } from "./cassette.ts";
import { currentCassetteMode, redactDeep } from "./cassette.ts";

export interface CachedToolsOptions {
  dir?: string;
  mode?: CassetteMode;
  redact?: boolean;
  lockTimeoutMs?: number;
}

export function cachedTools<T extends Record<string, (args: any) => unknown>>(tools: T, opts: CachedToolsOptions = {}): T {
  const base = opts.dir ?? process.env.DRYRUN_CASSETTE_DIR ?? ".dryrun";
  const dir = path.join(base, "tools");
  const mode = opts.mode ?? currentCassetteMode();
  const redact = opts.redact ?? process.env.DRYRUN_NO_REDACT !== "1";
  const output = {} as Record<string, (args: any) => unknown>;
  for (const [name, fn] of Object.entries(tools)) {
    output[name] = (args: unknown) => cacheCall(name, fn, args, dir, mode, redact, opts.lockTimeoutMs ?? 30_000);
  }
  return output as T;
}

async function cacheCall(
  name: string,
  fn: (args: any) => unknown,
  args: unknown,
  dir: string,
  mode: CassetteMode,
  redact: boolean,
  lockTimeoutMs: number,
): Promise<unknown> {
  if (mode === "passthrough") return fn(args);
  const canonical = stableKey(args);
  const key = hashKey(canonical);
  const legacy = legacyStableKey(args);
  const legacyHash = hashKey(legacy);
  const file = path.join(dir, toolFilename(name));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictMode(dir, 0o700);

  return withFileLock(file, lockTimeoutMs, async () => {
    const cache = loadCache(file, redact);
    if (key in cache) return cache[key];
    if (legacyHash in cache) return cache[legacyHash];
    if (legacy in cache) return cache[legacy];
    if (mode === "replay") {
      throw new Error(`cachedTools: no recorded result for ${name} (argument fingerprint ${key}). Re-record with --record to capture it.`);
    }
    const result = await fn(args);
    cache[key] = redactDeep(result ?? null, redact);
    atomicWritePrivate(file, `${JSON.stringify(cache, null, 2)}\n`);
    return result;
  });
}

function loadCache(file: string, redact: boolean): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected an object keyed by argument fingerprints");
    }
    const source = parsed as Record<string, unknown>;
    const migrated: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(source)) {
      const targetKey = key.startsWith("sha256:") ? key : hashKey(key);
      const safeValue = redactDeep(value, redact);
      changed ||= targetKey !== key || JSON.stringify(safeValue) !== JSON.stringify(value);
      migrated[targetKey] = safeValue;
    }
    if (changed) atomicWritePrivate(file, `${JSON.stringify(migrated, null, 2)}\n`);
    return migrated;
  } catch (error) {
    throw new Error(`cachedTools: cache "${file}" is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function stableKey(args: unknown): string {
  return JSON.stringify(canonicalize(args, new WeakSet<object>()));
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $type: "number", value: String(value) };
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "symbol" || typeof value === "function") return { $type: typeof value, value: String(value) };
  const object = value as object;
  if (seen.has(object)) throw new Error("cachedTools: circular tool arguments are not supported");
  seen.add(object);
  try {
    if (Array.isArray(value)) return value.map((child) => canonicalize(child, seen));
    if (value instanceof Date) return { $type: "date", value: value.toISOString() };
    if (value instanceof Map) {
      const entries = [...value.entries()].map(([key, child]) => [canonicalize(key, seen), canonicalize(child, seen)]);
      entries.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
      return { $type: "map", entries };
    }
    if (value instanceof Set) {
      const values = [...value].map((child) => canonicalize(child, seen)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { $type: "set", values };
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child, seen)]));
  } finally { seen.delete(object); }
}

function legacyStableKey(value: unknown): string {
  const sort = (child: unknown): unknown => Array.isArray(child) ? child.map(sort) : child && typeof child === "object"
    ? Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sort(nested)]))
    : child;
  try { return JSON.stringify(sort(value ?? null)) ?? "null"; }
  catch { return stableKey(value); }
}

function hashKey(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function toolFilename(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return name.toLowerCase() === safe ? `${safe}.json` : `${safe || "tool"}--${createHash("sha256").update(name).digest("hex").slice(0, 10)}.json`;
}

async function withFileLock<T>(file: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const started = Date.now();
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch {
      try { if (Date.now() - statSync(lock).mtimeMs > timeoutMs) rmSync(lock, { recursive: true, force: true }); }
      catch { /* lock was released */ }
      if (Date.now() - started > timeoutMs) throw new Error(`cachedTools: timed out waiting for lock ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function atomicWritePrivate(file: string, value: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    restrictMode(file, 0o600);
  } finally { rmSync(temp, { force: true }); }
}

function restrictMode(target: string, mode: number): void { if (process.platform !== "win32") chmodSync(target, mode); }
