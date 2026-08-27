#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

if (!process.argv.includes("--yes")) {
  throw new Error("HA verification stops one replica temporarily; pass --yes to continue");
}

const endpoint = new URL(option("--endpoint") ?? "http://quality.localhost:8080");
const compose = path.resolve(option("--file") ?? "deploy/compose.ha.yml");
const victim = option("--service") ?? "dryrun-a";
const project = option("--project") ?? "default";
const requests = positiveInteger(option("--requests") ?? "200", "--requests", 10_000);
const concurrency = positiveInteger(option("--concurrency") ?? "8", "--concurrency", 256);
const output = option("--output");
const token = process.env.DRYRUN_TEAM_TOKEN;

if (!token) throw new Error("Set DRYRUN_TEAM_TOKEN to a project key with read and ingest access");
if (!/^dryrun-[a-z0-9-]+$/.test(victim)) throw new Error("--service is invalid");
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project)) throw new Error("--project is invalid");
if (output && path.resolve(output) === compose) throw new Error("--output must not overwrite the Compose file");

const runId = `ha_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const observations = [];
const rounds = [];
let stopped = false;

try {
  await probe("baseline-live", "/api/v1/health/live");
  await probe("baseline-ready", "/api/v1/health/ready");
  await authenticatedProbe();
  rounds.push(await verifyRound("baseline", Math.max(4, concurrency)));

  // Begin traffic before SIGTERM so the report covers the load-balancer transition,
  // graceful drain, surviving replica, and shared persistence—not just steady state.
  const failoverTraffic = verifyRound("failover", requests, 5);
  await delay(75);
  await docker("stop", victim);
  stopped = true;
  rounds.push(await failoverTraffic);
  await probe("survivor-ready", "/api/v1/health/ready");
} finally {
  if (stopped || await isStopped(victim)) await docker("start", victim);
}

await waitForRecovery();
rounds.push(await verifyRound("recovery", Math.max(10, Math.ceil(requests / 5))));

const operations = observations.filter((item) => item.kind === "write" || item.kind === "read");
const failed = observations.filter((item) => !item.ok);
const successfulTransactions = rounds.reduce((sum, round) => sum + round.successfulTransactions, 0);
const expectedTransactions = rounds.reduce((sum, round) => sum + round.expectedTransactions, 0);
const report = {
  schema: "dry-run.ha-verification.v2",
  createdAt: new Date().toISOString(),
  endpoint: endpoint.origin,
  compose,
  project,
  stoppedReplica: victim,
  runId,
  rounds,
  summary: {
    expectedTransactions,
    successfulTransactions,
    failedTransactions: expectedTransactions - successfulTransactions,
    operations: operations.length,
    failedOperations: operations.filter((item) => !item.ok).length,
    failedProbes: failed.filter((item) => item.kind === "probe").length,
    p50OperationLatencyMs: percentile(operations.map((item) => item.latencyMs), 0.5),
    p95OperationLatencyMs: percentile(operations.map((item) => item.latencyMs), 0.95),
    p99OperationLatencyMs: percentile(operations.map((item) => item.latencyMs), 0.99),
    exactReadAfterWriteCardinality: successfulTransactions === expectedTransactions,
  },
  failures: failed.slice(0, 100),
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(path.resolve(output), serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write(serialized);
if (failed.length || successfulTransactions !== expectedTransactions) process.exitCode = 1;

async function verifyRound(stage, count, pauseMs = 0) {
  let cursor = 0;
  let successfulTransactions = 0;
  const started = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      const id = `${runId}_${stage}_${String(index).padStart(5, "0")}`;
      const wrote = await writeTrace(stage, id);
      const read = wrote ? await readTrace(stage, id) : false;
      if (wrote && read) successfulTransactions++;
      if (pauseMs > 0) await delay(pauseMs);
    }
  });
  await Promise.all(workers);
  return {
    stage,
    expectedTransactions: count,
    successfulTransactions,
    failedTransactions: count - successfulTransactions,
    durationMs: round(performance.now() - started),
  };
}

async function writeTrace(stage, id) {
  const now = new Date().toISOString();
  return requestOperation("write", stage, id, `/api/v1/projects/${encodeURIComponent(project)}/traces/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({
      kind: "dry-run.trace",
      version: 1,
      id,
      name: `HA verification ${id}`,
      status: "ok",
      startedAt: now,
      endedAt: now,
      durationMs: 1,
      rootSpanId: `span_${id}`,
      spans: [{
        id: `span_${id}`,
        traceId: id,
        name: "ha-verification",
        type: "agent",
        status: "ok",
        startedAt: now,
        endedAt: now,
        durationMs: 1,
        attributes: { runId, stage },
        metrics: {},
        events: [],
      }],
      metadata: { runId, stage },
      tags: ["ha-verification"],
      feedback: [],
    }),
  }, (response, body) => response.status === 202 && body?.accepted === 1 && body?.ids?.[0] === id);
}

async function readTrace(stage, id) {
  return requestOperation("read", stage, id, `/api/v1/projects/${encodeURIComponent(project)}/traces/${encodeURIComponent(id)}`, {
    headers: apiHeaders(),
  }, (response, body) => response.status === 200 && body?.traces?.length === 1 && body.traces[0]?.id === id);
}

async function requestOperation(kind, stage, id, pathname, init, validate) {
  const started = performance.now();
  try {
    const response = await fetch(new URL(pathname, endpoint), { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => undefined);
    const ok = validate(response, body);
    observations.push({ kind, stage, id, ok, status: response.status, latencyMs: round(performance.now() - started), ...(ok ? {} : { error: safeError(body) }) });
    return ok;
  } catch (error) {
    observations.push({ kind, stage, id, ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: round(performance.now() - started) });
    return false;
  }
}

async function probe(stage, pathname) {
  const started = performance.now();
  try {
    const response = await fetch(new URL(pathname, endpoint), { signal: AbortSignal.timeout(5_000) });
    const item = { kind: "probe", stage, ok: response.ok, status: response.status, latencyMs: round(performance.now() - started) };
    observations.push(item);
    if (!item.ok) throw new Error(`probe returned ${item.status}`);
    return item;
  } catch (error) {
    if (!observations.some((item) => item.kind === "probe" && item.stage === stage)) {
      observations.push({ kind: "probe", stage, ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: round(performance.now() - started) });
    }
    throw error;
  }
}

async function authenticatedProbe() {
  const response = await fetch(new URL("/api/v1/me", endpoint), { headers: apiHeaders(), signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`DRYRUN_TEAM_TOKEN was rejected with ${response.status}`);
}

async function waitForRecovery() {
  let lastError;
  for (let attempt = 1; attempt <= 45; attempt++) {
    try {
      await probe(`recovery-ready-${attempt}`, "/api/v1/health/ready");
      return;
    } catch (error) {
      lastError = error;
      await delay(1_000);
    }
  }
  throw lastError ?? new Error("Replica did not recover");
}

async function docker(action, service) {
  await new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-f", compose, action, service], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`docker compose ${action} failed (${signal ?? code})`)));
  });
}

async function isStopped(service) {
  return await new Promise((resolve) => {
    const child = spawn("docker", ["compose", "-f", compose, "ps", "--status", "exited", "--services", service], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0 && stdout.trim().split("\n").includes(service)));
  });
}

function apiHeaders() {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return parsed;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function safeError(body) {
  const value = body && typeof body === "object" && "error" in body ? body.error : undefined;
  return typeof value === "string" ? value.slice(0, 300) : "response contract mismatch";
}

function round(value) { return Math.round(value * 100) / 100; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
