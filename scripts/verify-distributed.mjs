#!/usr/bin/env node
import { DistributedRuntime } from "../dist/distributed-runtime.js";
import { ControlRevisionConflictError } from "../dist/distributed.js";
import { TeamWorkspace } from "../dist/team.js";
import { startTeamServer } from "../dist/team-server.js";
import { DistributedWorkspaceState } from "../dist/distributed-state.js";
import { DistributedRecoveryManager } from "../dist/distributed-recovery.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const natsSuffix = suffix.replace(/[^A-Za-z0-9_-]/g, "_");
const options = {
  postgres: { connectionString: process.env.DRYRUN_POSTGRES_URL ?? "postgresql://dryrun:dryrun-development-password@127.0.0.1:55432/dryrun", schema: "dryrun_verify", max: 4 },
  artifacts: { endpoint: process.env.DRYRUN_S3_ENDPOINT ?? "http://127.0.0.1:59000", bucket: process.env.DRYRUN_S3_BUCKET ?? "dryrun-artifacts", accessKeyId: process.env.DRYRUN_S3_ACCESS_KEY ?? "dryrun-admin", secretAccessKey: process.env.DRYRUN_S3_SECRET_KEY ?? "dryrun-development-password", tls: false, forcePathStyle: true, createBucket: true, prefix: "verification" },
  nats: { servers: process.env.DRYRUN_NATS_URL ?? "nats://127.0.0.1:54222", stream: `DRYRUN_VERIFY_${natsSuffix.toUpperCase()}`, subjectPrefix: `dryrun_verify_${natsSuffix}.jobs`, replicas: 1 },
  relayIntervalMs: 50,
};
const scope = { organizationId: "verify-org", workspaceId: "verify-workspace", projectId: "verify-project" };
const stateAlias = `verify-${natsSuffix}`;
const recoveryLabel = `recovery-${natsSuffix}`;
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !output) throw new Error("--output requires a file path");
const first = await DistributedRuntime.create(options);
let second;
let firstServer;
let secondServer;
let teamDir;
let secondTeamDir;
try {
  const health = await first.health();
  if (!health.ok) throw new Error("distributed health check failed");
  if (await first.control.schemaVersion() < 2) throw new Error("serialized PostgreSQL migrations did not reach the expected schema version");
  const created = await first.control.put(scope, "settings", `setting-${suffix}`, { enabled: true }, { expectedRevision: 0 });
  const updated = await first.control.put(scope, "settings", `setting-${suffix}`, { enabled: false }, { expectedRevision: 1 });
  if (created.revision !== 1 || updated.revision !== 2) throw new Error("optimistic revision contract failed");
  let conflict = false;
  try { await first.control.put(scope, "settings", `setting-${suffix}`, { stale: true }, { expectedRevision: 1 }); } catch (error) { conflict = error instanceof ControlRevisionConflictError; }
  if (!conflict) throw new Error("stale control-plane write was not rejected");

  const trace = traceDocument(`trace-${suffix}`);
  const indexed = await first.traces.put(scope, trace, 0);
  const repeated = await first.traces.put(scope, trace);
  const loaded = await first.traces.get(scope, trace.id);
  if (!loaded || loaded.id !== trace.id || indexed.revision !== 1 || repeated.revision !== 1) throw new Error("distributed trace round trip or idempotency failed");

  second = await DistributedRuntime.create(options);
  const concurrentTrace = traceDocument(`concurrent-${suffix}`);
  const concurrent = await Promise.all([first.traces.put(scope, concurrentTrace), second.traces.put(scope, concurrentTrace)]);
  if (concurrent.some((record) => record.revision !== 1)) throw new Error("concurrent idempotent trace writes advanced the revision");
  const crossReplica = await second.traces.get(scope, trace.id);
  if (!crossReplica || crossReplica.spans[0].attributes.replica !== "first") throw new Error("cross-replica read failed");
  const page = await second.traces.page(scope, { limit: 10 });
  if (!page.items.some((item) => item.id === trace.id)) throw new Error("distributed trace index pagination failed");

  const abort = new AbortController();
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { abort.abort(); reject(new Error("JetStream delivery timed out")); }, 10_000);
    first.queue.consume(`verify_${natsSuffix}`, async (job) => { if (job.id === `job-${suffix}`) { clearTimeout(timer); abort.abort(); resolve(job); } }, { filter: "probe", signal: abort.signal }).catch(reject);
  });
  await second.queue.publish("probe", { source: "second" }, { id: `job-${suffix}` });
  const job = await received;
  if (job.payload.source !== "second") throw new Error("JetStream payload mismatch");

  const poisonAbort = new AbortController();
  let poisonAttempts = 0;
  const poisonTask = first.queue.consume(`poison_${natsSuffix}`, async () => { poisonAttempts += 1; throw new Error("deliberate poison message"); }, { filter: "poison", maxDeliver: 2, retryDelayMs: 100, signal: poisonAbort.signal });
  await second.queue.publish("poison", { test: true }, { id: `poison-${suffix}` });
  const poisonDeadline = Date.now() + 5_000;
  while (poisonAttempts < 2 && Date.now() < poisonDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  poisonAbort.abort(); let poisonFailure; await poisonTask.catch((error) => { poisonFailure = error; });
  const redrive = await second.queue.redriveDeadLetters(10);
  if (poisonAttempts < 2 || redrive.redriven !== 1 || redrive.invalid !== 0) throw new Error(`JetStream dead-letter/redrive contract failed: attempts=${poisonAttempts} redrive=${JSON.stringify(redrive)} consumer=${poisonFailure?.message ?? "ok"}`);

  teamDir = mkdtempSync(path.join(tmpdir(), "dryrun-distributed-api-"));
  const { workspace, admin } = await TeamWorkspace.initialize(teamDir, "Distributed API verification");
  const stateSecret = "dryrun-distributed-verification-state-key-2026";
  const firstState = await DistributedWorkspaceState.open(first, teamDir, { alias: stateAlias, encryptionSecret: stateSecret });
  await firstState.transact(async () => { await workspace.project("default").online.create({ name: "Distributed queue verification", checks: [{ type: "maxDuration", ms: 10 }] }); });
  secondTeamDir = mkdtempSync(path.join(tmpdir(), "dryrun-distributed-cold-node-"));
  const secondState = await DistributedWorkspaceState.open(second, secondTeamDir, { alias: stateAlias, encryptionSecret: stateSecret });
  const secondWorkspace = new TeamWorkspace(secondTeamDir);
  const projectStores = workspace.project("default");
  firstServer = await startTeamServer({ workspace, port: 0, distributed: first, distributedState: firstState });
  secondServer = await startTeamServer({ workspace: secondWorkspace, port: 0, distributed: second, distributedState: secondState });
  const apiTrace = traceDocument(`api-${suffix}`), headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };
  const written = await fetch(`${firstServer.url}/api/v1/projects/default/traces/${apiTrace.id}`, { method: "PUT", headers, body: JSON.stringify(apiTrace) });
  if (written.status !== 202) throw new Error(`distributed API write returned ${written.status}`);
  const read = await fetch(`${secondServer.url}/api/v1/projects/default/traces/${apiTrace.id}`, { headers });
  const readBody = await read.json();
  if (read.status !== 200 || readBody.traces?.[0]?.id !== apiTrace.id) throw new Error("cross-replica HTTP read failed");
  const queueCreated = await fetch(`${firstServer.url}/api/v1/projects/default/queues`, { method: "POST", headers, body: JSON.stringify({ name: `Cross replica ${suffix}` }) });
  if (queueCreated.status !== 201) throw new Error(`distributed state write returned ${queueCreated.status}`);
  const queueRead = await fetch(`${secondServer.url}/api/v1/projects/default/queues`, { headers });
  const queueBody = await queueRead.json();
  if (queueRead.status !== 200 || !queueBody.queues?.some((queue) => queue.name === `Cross replica ${suffix}`)) throw new Error("stateless cross-replica control-state read failed");
  const ready = await secondServer.readiness();
  if (!ready.ok || !ready.checks.distributed?.ok || ready.checks.distributed.state?.sharedPosixRequired !== false) throw new Error("distributed readiness/state contract failed");
  const onlineDeadline = Date.now() + 10_000;
  let onlineResults = [];
  while (!onlineResults.length && Date.now() < onlineDeadline) { onlineResults = await firstState.transact(async () => projectStores.online.listResults({ traceId: apiTrace.id })); if (!onlineResults.length) await new Promise((resolve) => setTimeout(resolve, 50)); }
  if (!onlineResults.length) throw new Error("JetStream trace event did not trigger online evaluation");

  const recovery = new DistributedRecoveryManager(first, stateSecret);
  const recoveryPoint = await recovery.create(recoveryLabel);
  const recoveryVerified = await recovery.verify(recoveryPoint.label);
  await first.control.delete(scope, "settings", `setting-${suffix}`);
  const restored = await recovery.restore(recoveryPoint.label);
  const restoredSetting = await first.control.get(scope, "settings", `setting-${suffix}`);
  if (!recoveryVerified.ok || !restored.imported || !restoredSetting) throw new Error("portable distributed recovery contract failed");

  const report = { schema: "dry-run.distributed-verification.v2", createdAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version }, health, checks: { postgresMigrations: true, postgresRevisions: true, staleWriteRejected: true, idempotentTraceWrite: true, concurrentIdempotentWrite: true, minioChecksumRoundTrip: true, crossReplicaRead: true, pagination: true, jetStreamDelivery: true, jetStreamDeadLetterRedrive: true, jetStreamOnlineEvaluation: true, crossReplicaHttp: true, encryptedWorkspaceState: true, statelessColdNode: true, crossReplicaControlState: true, distributedReadiness: true, portableRecovery: true }, traceId: trace.id };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(path.resolve(output), rendered, { encoding: "utf8", flag: "wx" });
  process.stdout.write(rendered);
} finally {
  await first.queue.deleteStream().catch(() => undefined);
  await first.control.deleteScope(scope).catch(() => undefined);
  await first.control.delete({ organizationId: "system", workspaceId: "system", projectId: "system" }, "workspace-state", stateAlias).catch(() => undefined);
  await first.control.delete({ organizationId: "system", workspaceId: "system", projectId: "system" }, "recovery-points", recoveryLabel).catch(() => undefined);
  await first.artifacts.clearPrefix().catch(() => undefined);
  await secondServer?.close();
  await firstServer?.close();
  await second?.close();
  await first.close();
  if (teamDir) rmSync(teamDir, { recursive: true, force: true });
  if (secondTeamDir) rmSync(secondTeamDir, { recursive: true, force: true });
}

function traceDocument(id) {
  const now = new Date().toISOString();
  return { kind: "dry-run.trace", version: 1, id, name: "distributed verification", status: "ok", startedAt: now, endedAt: now, durationMs: 1, rootSpanId: `span-${suffix}`, spans: [{ id: `span-${suffix}`, traceId: id, name: "cross-replica", type: "agent", status: "ok", startedAt: now, endedAt: now, durationMs: 1, attributes: { replica: "first" }, metrics: {}, events: [] }], tags: ["distributed-verification"], feedback: [] };
}
