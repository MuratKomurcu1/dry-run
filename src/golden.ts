import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Trajectory } from "./types.ts";

export interface GoldenEntry {
  name: string;
  toolCalls: string[];
  output: string;
  tokens?: number;
}

export interface GoldenFile {
  version: 1;
  savedAt: string;
  entries: GoldenEntry[];
}

export type GoldenStatus = "pass" | "drift" | "new" | "missing";

export interface GoldenDiff {
  name: string;
  status: GoldenStatus;
  changes: string[];
}

export function toGoldenEntry(name: string, t: Trajectory, tokens?: number): GoldenEntry {
  return {
    name,
    toolCalls: t.steps
      .filter((s) => s.kind === "tool")
      .map((s) => s.toolCall!.name),
    output: t.output,
    ...(tokens != null ? { tokens } : {}),
  };
}

export function saveGolden(file: string, entries: GoldenEntry[]): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const data: GoldenFile = { version: 1, savedAt: new Date().toISOString(), entries };
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function loadGolden(file: string): GoldenFile {
  return JSON.parse(readFileSync(file, "utf8")) as GoldenFile;
}

export interface CompareOptions {
  ignoreOutput?: boolean;
}

export function compareGolden(
  baseline: GoldenEntry[],
  current: GoldenEntry[],
  opts: CompareOptions = {},
): GoldenDiff[] {
  const baseByName = new Map(baseline.map((e) => [e.name, e]));
  const curByName = new Map(current.map((e) => [e.name, e]));
  const diffs: GoldenDiff[] = [];

  for (const cur of current) {
    const base = baseByName.get(cur.name);
    if (!base) {
      diffs.push({ name: cur.name, status: "new", changes: ["scenario has no baseline"] });
      continue;
    }
    const changes: string[] = [];
    if (base.toolCalls.join(",") !== cur.toolCalls.join(",")) {
      changes.push(`tool path: [${base.toolCalls.join(",") || "none"}] → [${cur.toolCalls.join(",") || "none"}]`);
    }
    if (!opts.ignoreOutput && base.output !== cur.output) {
      changes.push(`output changed:\n        ${truncate(base.output)}\n        → ${truncate(cur.output)}`);
    }
    diffs.push({ name: cur.name, status: changes.length ? "drift" : "pass", changes });
  }

  for (const base of baseline) {
    if (!curByName.has(base.name)) {
      diffs.push({ name: base.name, status: "missing", changes: ["in baseline but did not run"] });
    }
  }

  return diffs;
}

function truncate(s: string, n = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? `"${flat}"` : `"${flat.slice(0, n)}…"`;
}
