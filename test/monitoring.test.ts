import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAnalyticsStore } from "../src/analytics.ts";
import { QualityMonitorStore } from "../src/monitoring.ts";
import { atomicWriteJson } from "../src/storage.ts";
import { TeamWorkspace } from "../src/team.ts";
import { startTeamServer, type TeamServerHandle } from "../src/team-server.ts";
import type { TraceDocument } from "../src/tracing.ts";

const roots: string[] = [];
const handles: TeamServerHandle[] = [];
afterEach(async () => { while (handles.length) await handles.pop()!.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("production quality monitors", () => {
  it("persists revisioned SLOs and records healthy, breached, and insufficient windows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-monitor-")); roots.push(root);
    const analytics = new MemoryAnalyticsStore();
    const store = new QualityMonitorStore(root);
    const now = new Date("2026-08-26T12:00:00.000Z");
    await analytics.ingestTraces("workspace", "project", [trace("good", "ok", 100, now), trace("bad", "error", 900, now)]);
    const monitor = await store.create({ name: "production quality", windowMinutes: 60, minEvents: 2, thresholds: { minPassRate: 0.75, maxP95LatencyMs: 500 } });
    const breached = await store.evaluate(monitor.id, analytics, "workspace", "project", now);
    const repeated = await store.evaluate(monitor.id, analytics, "workspace", "project", now);
    expect(repeated.id).toBe(breached.id);
    expect(store.listResults({ monitorId: monitor.id })).toHaveLength(1);
    expect(breached.status).toBe("breached");
    expect(breached.violations.map((item) => item.metric)).toEqual(["minPassRate", "maxP95LatencyMs"]);
    const relaxed = await store.update(monitor.id, { thresholds: { minPassRate: 0.5, maxP95LatencyMs: 1_000 } });
    expect(relaxed.revision).toBe(2);
    await expect(store.evaluate(relaxed.id, analytics, "workspace", "project", now)).resolves.toMatchObject({ status: "healthy", monitorRevision: 2 });
    const sparse = await store.create({ name: "high volume", minEvents: 10, thresholds: { minPassRate: 0.9 } });
    await expect(store.evaluate(sparse.id, analytics, "workspace", "project", now)).resolves.toMatchObject({ status: "insufficient-data", violations: [] });
    expect(store.listResults({ monitorId: monitor.id })).toHaveLength(2);
  });

  it("exposes authenticated monitor lifecycle and evaluation through the team API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-monitor-api-")); roots.push(root);
    const { workspace, admin } = await TeamWorkspace.initialize(path.join(root, "team"), "Monitor API");
    const analytics = new MemoryAnalyticsStore();
    const project = workspace.project("default").project;
    await analytics.ingestTraces(workspace.config().id, project.id, [trace("api-good", "ok", 25, new Date())]);
    const handle = await startTeamServer({ workspace, analytics, port: 0 }); handles.push(handle);
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };
    const created = await fetch(`${handle.url}/api/v1/projects/default/monitors`, { method: "POST", headers, body: JSON.stringify({ name: "API quality", minEvents: 1, thresholds: { minPassRate: 1, maxP95LatencyMs: 50 } }) });
    expect(created.status).toBe(201);
    const monitor = (await created.json() as any).monitor;
    const evaluated = await fetch(`${handle.url}/api/v1/projects/default/monitors/${monitor.id}/evaluate`, { method: "POST", headers, body: "{}" });
    expect(evaluated.status).toBe(200);
    expect(await evaluated.json()).toMatchObject({ result: { status: "healthy", observed: { events: 1 } } });
    const results = await fetch(`${handle.url}/api/v1/projects/default/monitors/${monitor.id}/results`, { headers });
    expect(results.status).toBe(200);
    expect((await results.json() as any).results).toHaveLength(1);
  });

  it("runs enabled monitors on a replica-safe fixed schedule", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-monitor-schedule-")); roots.push(root);
    const { workspace } = await TeamWorkspace.initialize(path.join(root, "team"), "Scheduled monitoring");
    const stores = workspace.project("default");
    await stores.monitors.create({ name: "scheduled", minEvents: 1, thresholds: { minPassRate: 0.9 } });
    const analytics = new MemoryAnalyticsStore();
    await analytics.ingestTraces(workspace.config().id, stores.project.id, [trace("scheduled-good", "ok", 25, new Date())]);
    const handle = await startTeamServer({ workspace, analytics, port: 0, monitorIntervalMs: 20 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      const results = stores.monitors.listResults();
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((result) => result.status === "healthy")).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("includes monitor history in project retention", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-monitor-retention-")); roots.push(root);
    const { workspace, admin } = await TeamWorkspace.initialize(path.join(root, "team"), "Monitor retention");
    const owner = workspace.authenticate(admin.token)!;
    const stores = workspace.project("default");
    const analytics = new MemoryAnalyticsStore();
    const old = new Date("2020-01-01T00:00:00.000Z");
    await analytics.ingestTraces(workspace.config().id, stores.project.id, [trace("old-quality", "ok", 10, old)]);
    const monitor = await stores.monitors.create({ name: "retained", minEvents: 1, thresholds: { minPassRate: 1 } });
    const result = await stores.monitors.evaluate(monitor.id, analytics, workspace.config().id, stores.project.id, old);
    atomicWriteJson(path.join(stores.monitors.resultsDir, `${result.id}.json`), { ...result, evaluatedAt: old.toISOString() });
    const applied = await workspace.applyRetention(owner, stores.project.id, { olderThanDays: 30 });
    expect(applied.qualityMonitorResults).toHaveLength(1);
    expect(stores.monitors.listResults()).toHaveLength(0);
  });
});

function trace(id: string, status: "ok" | "error", durationMs: number, now: Date): TraceDocument {
  const endedAt = new Date(now.getTime() - 1_000).toISOString();
  const startedAt = new Date(Date.parse(endedAt) - durationMs).toISOString();
  return { kind: "dry-run.trace", version: 1, id, name: id, status, startedAt, endedAt, durationMs, rootSpanId: `span_${id}`, spans: [{ id: `span_${id}`, traceId: id, name: id, type: "agent", status, startedAt, endedAt, durationMs, attributes: {}, metrics: {}, events: [] }], feedback: [] };
}
