#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryAnalyticsStore } from "../dist/analytics.js";
import { startTeamServer } from "../dist/team-server.js";
import { TeamWorkspace } from "../dist/team.js";

const requests = integer("--requests", 2_000, 1, 100_000);
const concurrency = integer("--concurrency", 32, 1, 512);
const output = value("--output");
const root = await mkdtemp(path.join(tmpdir(), "dryrun-control-plane-bench-"));
let server;
try {
  const { workspace, admin } = await TeamWorkspace.initialize(path.join(root, "team"), "Benchmark");
  server = await startTeamServer({ workspace, port: 0, analytics: new MemoryAnalyticsStore(), requestsPerMinute: Math.max(10_000, requests * 2), metricsEnabled: true });
  const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };
  const durations = [];
  let next = 0;
  let errors = 0;
  const started = performance.now();
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= requests) return;
      const begin = performance.now();
      const now = new Date().toISOString();
      const trace = {
        kind: "dry-run.trace", version: 1, id: `bench-${index}`, name: "control-plane benchmark", status: "ok",
        startedAt: now, endedAt: now, durationMs: index % 250, rootSpanId: `span-${index}`,
        spans: [{ id: `span-${index}`, traceId: `bench-${index}`, name: "agent", type: "agent", status: "ok", startedAt: now, endedAt: now, durationMs: index % 250, attributes: { environment: "benchmark" }, metrics: { total_tokens: 10 }, events: [] }],
        tags: ["benchmark"], feedback: [],
      };
      try {
        const response = await fetch(`${server.url}/api/v1/projects/default/traces`, { method: "POST", headers, body: JSON.stringify(trace) });
        if (response.status !== 202) errors += 1;
        await response.arrayBuffer();
      } catch { errors += 1; }
      durations.push(performance.now() - begin);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - started;
  const summaryResponse = await fetch(`${server.url}/api/v1/projects/default/analytics/summary`, { headers });
  const summary = await summaryResponse.json();
  durations.sort((a, b) => a - b);
  const result = {
    schema: "dry-run.control-plane-benchmark.v1", createdAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
    configuration: { requests, concurrency, backend: "memory", payload: "single-span trace" },
    result: { elapsedMs, requestsPerSecond: requests / (elapsedMs / 1000), errors, errorRate: errors / requests, latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: durations.at(-1) ?? 0 }, analyticsCount: summary.summary?.totals?.count ?? null },
  };
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (output) { const target = path.resolve(output); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, rendered, { flag: "wx" }); }
  process.stdout.write(rendered);
  if (errors || result.result.analyticsCount !== requests) process.exitCode = 1;
  function percentile(q) { return durations[Math.max(0, Math.ceil(durations.length * q) - 1)] ?? 0; }
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}

function value(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function integer(name, fallback, minimum, maximum) { const raw = value(name); const parsed = raw == null ? fallback : Number(raw); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`); return parsed; }
