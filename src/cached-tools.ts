import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CassetteMode } from "./cassette.ts";
import { currentCassetteMode, redactDeep } from "./cassette.ts";

export interface CachedToolsOptions {
  dir?: string;
  mode?: CassetteMode;
  redact?: boolean;
}

export function cachedTools<T extends Record<string, (args: any) => unknown>>(
  tools: T,
  opts: CachedToolsOptions = {},
): T {
  const base = opts.dir ?? process.env.DRYRUN_CASSETTE_DIR ?? ".dryrun";
  const dir = path.join(base, "tools");
  const mode = opts.mode ?? currentCassetteMode();
  const redact = opts.redact ?? process.env.DRYRUN_NO_REDACT !== "1";

  const out = {} as Record<string, (args: any) => unknown>;
  for (const [name, fn] of Object.entries(tools)) {
    out[name] = (args: unknown) => cacheCall(name, fn, args, dir, mode, redact);
  }
  return out as T;
}

async function cacheCall(
  name: string,
  fn: (args: any) => unknown,
  args: unknown,
  dir: string,
  mode: CassetteMode,
  redact: boolean,
): Promise<unknown> {
  if (mode === "passthrough") return fn(args);

  const legacyKey = stableKey(args);
  const key = `sha256:${createHash("sha256").update(legacyKey).digest("hex")}`;
  const file = path.join(dir, `${slug(name)}.json`);
  const cache = loadCache(file, redact);

  if (key in cache) return cache[key];
  if (legacyKey in cache) return cache[legacyKey];

  if (mode === "replay") {
    throw new Error(
      `cachedTools: no recorded result for ${name} (argument fingerprint ${key}). ` +
        `Re-record with --record to capture it.`,
    );
  }

  const result = await fn(args);
  cache[key] = redactDeep(result ?? null, redact);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictMode(dir, 0o700);
  atomicWritePrivate(file, JSON.stringify(cache, null, 2));
  return result;
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
      const targetKey = key.startsWith("sha256:")
        ? key
        : `sha256:${createHash("sha256").update(key).digest("hex")}`;
      changed ||= targetKey !== key;
      const safeValue = redactDeep(value, redact);
      changed ||= JSON.stringify(safeValue) !== JSON.stringify(value);
      migrated[targetKey] = safeValue;
    }
    if (changed) atomicWritePrivate(file, JSON.stringify(migrated, null, 2));
    return migrated;
  } catch (error) {
    throw new Error(
      `cachedTools: cache "${file}" is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function stableKey(args: unknown): string {
  return JSON.stringify(sortDeep(args ?? null)) ?? "null";
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortDeep(val)]),
    );
  }
  return v;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function atomicWritePrivate(file: string, value: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    restrictMode(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

function restrictMode(target: string, mode: number): void {
  if (process.platform === "win32") return;
  chmodSync(target, mode);
}
