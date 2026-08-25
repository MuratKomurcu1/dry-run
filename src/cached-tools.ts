import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CassetteMode } from "./cassette.ts";
import { currentCassetteMode } from "./cassette.ts";

export interface CachedToolsOptions {
  dir?: string;
  mode?: CassetteMode;
}

export function cachedTools<T extends Record<string, (args: any) => unknown>>(
  tools: T,
  opts: CachedToolsOptions = {},
): T {
  const base = opts.dir ?? process.env.DRYRUN_CASSETTE_DIR ?? ".dryrun";
  const dir = path.join(base, "tools");
  const mode = opts.mode ?? currentCassetteMode();

  const out = {} as Record<string, (args: any) => unknown>;
  for (const [name, fn] of Object.entries(tools)) {
    out[name] = (args: unknown) => cacheCall(name, fn, args, dir, mode);
  }
  return out as T;
}

async function cacheCall(
  name: string,
  fn: (args: any) => unknown,
  args: unknown,
  dir: string,
  mode: CassetteMode,
): Promise<unknown> {
  if (mode === "passthrough") return fn(args);

  const key = stableKey(args);
  const file = path.join(dir, `${slug(name)}.json`);
  const cache = loadCache(file);

  if (key in cache) return cache[key];

  if (mode === "replay") {
    throw new Error(
      `cachedTools: no recorded result for ${name}(${stableKey(args)}). ` +
        `Re-record with --record to capture it.`,
    );
  }

  const result = await fn(args);
  cache[key] = result ?? null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2));
  return result;
}

function loadCache(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
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
