#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DistributedRuntime } from "../dist/distributed-runtime.js";
import { DistributedWorkspaceState } from "../dist/distributed-state.js";
import { TeamWorkspace } from "../dist/team.js";
import { startTeamServer } from "../dist/team-server.js";

const args = process.argv.slice(2);
const traceCount = integer("--traces", 10_000, 1, 1_000_000);
const nodes = integer("--nodes", 4, 3, 5);
const batchSize = integer("--batch-size", 500, 1, 500);
const concurrency = integer("--concurrency", 16, 1, 256);
const output = value("--output");
const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^A-Za-z0-9_-]/g, "_");
const stateAlias = `chaos-${suffix}`;
const options = {
  postgres: { connectionString: process.env.DRYRUN_POSTGRES_URL ?? "postgresql://dryrun:dryrun-development-password@127.0.0.1:55432/dryrun", schema: "dryrun_chaos", max: Math.max(4, concurrency) },
  artifacts: { endpoint: process.env.DRYRUN_S3_ENDPOINT ?? "http://127.0.0.1:59000", bucket: process.env.DRYRUN_S3_BUCKET ?? "dryrun-artifacts", accessKeyId: process.env.DRYRUN_S3_ACCESS_KEY ?? "dryrun-admin", secretAccessKey: process.env.DRYRUN_S3_SECRET_KEY ?? "dryrun-development-password", tls: false, forcePathStyle: true, createBucket: true, prefix: `chaos-${suffix}` },
  nats: { servers: process.env.DRYRUN_NATS_URL ?? "nats://127.0.0.1:54222", stream: `DRYRUN_CHAOS_${suffix.toUpperCase()}`, subjectPrefix: `dryrun_chaos_${suffix}.jobs`, replicas: 1 }, relayIntervalMs: 50,
};
const dirs = [], runtimes = [], states = [], workspaces = [], servers = [];
let token = "", scope;
const started = performance.now(), latencies = [], requestErrors = [];
let successfulTraces = 0, completedBatches = 0, evicted = false;
try {
  for (let index = 0; index < nodes; index += 1) {
    const runtime = await DistributedRuntime.create(options); runtimes.push(runtime);
    const dir = mkdtempSync(path.join(tmpdir(), `dryrun-chaos-node-${index}-`)); dirs.push(dir);
    if (index === 0) {
      const initialized = await TeamWorkspace.initialize(dir, "HA load verification"); token = initialized.admin.token;
      states.push(await DistributedWorkspaceState.open(runtime, dir, { alias: stateAlias, encryptionSecret: "dryrun-chaos-verification-state-encryption-key" }));
    } else states.push(await DistributedWorkspaceState.open(runtime, dir, { alias: stateAlias, encryptionSecret: "dryrun-chaos-verification-state-encryption-key" }));
    const workspace = new TeamWorkspace(dir); workspaces.push(workspace);
    if (index === 0) { const config = workspace.config(); scope = { organizationId: config.organization?.id ?? config.id, workspaceId: config.id, projectId: workspace.project("default").project.id }; }
    servers.push(await startTeamServer({ workspace, distributed: runtime, distributedState: states[index], port: 0, requestsPerMinute: 10_000_000, maxProjectFiles: Math.max(100_000, traceCount + 10_000), maxProjectBytes: 20 * 1024 * 1024 * 1024 }));
  }
  const batches = [];
  for (let offset = 0; offset < traceCount; offset += batchSize) batches.push({ offset, count: Math.min(batchSize, traceCount - offset) });
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async (_unused, worker) => {
    while (true) {
      const batchIndex = cursor++;
      if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex];
      const traces = Array.from({ length: batch.count }, (_item, index) => trace(`load_${suffix}_${batch.offset + index}`));
      const before = performance.now();
      let accepted = false;
      for (let attempt = 0; attempt < 4 && !accepted; attempt += 1) {
        const active = servers.filter(Boolean);
        const server = active[(batchIndex + worker + attempt) % active.length];
        try {
          const response = await fetch(`${server.url}/api/v1/projects/default/traces`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ traces }) });
          if (response.status === 202) accepted = true;
          else requestErrors.push(`HTTP ${response.status}`);
        } catch (error) { requestErrors.push(error instanceof Error ? error.message : String(error)); }
      }
      if (!accepted) throw new Error(`Batch ${batchIndex} failed after failover retries`);
      latencies.push(performance.now() - before); successfulTraces += batch.count; completedBatches += 1;
      if (!evicted && completedBatches >= Math.ceil(batches.length / 3)) {
        evicted = true;
        const removed = servers[1]; servers[1] = undefined;
        await removed.close();
      }
    }
  }));
  const activeRuntime = runtimes[2] ?? runtimes[0];
  const stored = await activeRuntime.control.count(scope, "traces");
  if (stored !== traceCount || successfulTraces !== traceCount) throw new Error(`Trace durability mismatch: accepted=${successfulTraces}, indexed=${stored}, expected=${traceCount}`);
  const sampleIds = [0, Math.floor(traceCount / 2), traceCount - 1].map((index) => `load_${suffix}_${index}`);
  for (const [index, id] of sampleIds.entries()) {
    const active = servers.filter(Boolean); const server = active[index % active.length];
    const response = await fetch(`${server.url}/api/v1/projects/default/traces/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status !== 200) throw new Error(`Post-failover sample read failed: ${id}`);
  }
  const durationMs = performance.now() - started;
  const sorted = latencies.sort((a, b) => a - b);
  const report = {
    schema: "dry-run.ha-chaos.v1", createdAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version },
    configuration: { nodes, traces: traceCount, batchSize, concurrency, injectedFault: "one application node gracefully evicted at 33% completion" },
    result: { passed: true, accepted: successfulTraces, indexed: stored, duplicates: successfulTraces - stored, lost: traceCount - stored, retryableRequestErrors: requestErrors.length, durationMs: round(durationMs), tracesPerSecond: round(traceCount / (durationMs / 1_000)), batchLatencyMs: { p50: percentile(sorted, .5), p95: percentile(sorted, .95), p99: percentile(sorted, .99), max: round(sorted.at(-1) ?? 0) }, postFailoverReads: sampleIds.length },
    limitations: ["The injected application-node fault is a graceful eviction; abrupt SIGKILL and dependency partitions are separate operator drills.", ...(traceCount < 1_000_000 ? ["Run with --traces 1000000 to execute the full million-trace profile on production-equivalent hardware."] : ["This run executed the full million-trace profile; results describe this machine and configuration, not a universal SLA."])],
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(path.resolve(output), rendered, { encoding: "utf8", flag: "wx" });
  process.stdout.write(rendered);
  await activeRuntime.queue.deleteStream().catch(() => undefined);
} finally {
  const cleanupRuntime = runtimes.find((runtime, index) => index !== 1) ?? runtimes[0];
  if (cleanupRuntime) {
    if (scope) await cleanupRuntime.control.deleteScope(scope).catch(() => undefined);
    await cleanupRuntime.control.delete({ organizationId: "system", workspaceId: "system", projectId: "system" }, "workspace-state", stateAlias).catch(() => undefined);
    await cleanupRuntime.artifacts.clearPrefix().catch(() => undefined);
  }
  for (const server of servers.filter(Boolean).reverse()) await server.close().catch(() => undefined);
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function trace(id) { const at = new Date(1_767_268_800_000 + Number(id.split("_").at(-1)) * 10).toISOString(); const spanId = `${id}_root`; return { kind: "dry-run.trace", version: 1, id, name: "ha-load", status: "ok", startedAt: at, endedAt: at, durationMs: 1, rootSpanId: spanId, spans: [{ id: spanId, traceId: id, name: "load", type: "agent", status: "ok", startedAt: at, endedAt: at, durationMs: 1, attributes: { environment: "load", release: "chaos" }, metrics: {}, events: [] }], tags: ["ha-load"], feedback: [] }; }
function value(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function integer(name, fallback, min, max) { const raw = value(name); const parsed = raw == null ? fallback : Number(raw); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return parsed; }
function percentile(values, p) { if (!values.length) return 0; return round(values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]); }
function round(value) { return Math.round(value * 100) / 100; }
