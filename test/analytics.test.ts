import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClickHouseAnalyticsStore, MemoryAnalyticsStore, type AnalyticsStore } from "../src/analytics.ts";
import { startTeamServer } from "../src/team-server.ts";
import { TeamWorkspace } from "../src/team.ts";
import type { TraceDocument } from "../src/tracing.ts";

const dirs: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared analytics plane", () => {
  it("serves idempotent analytics across two team-server nodes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dryrun-analytics-")); dirs.push(dir);
    const { workspace, admin } = await TeamWorkspace.initialize(dir, "Analytics team");
    const analytics = new MemoryAnalyticsStore();
    const first = await startTeamServer({ workspace, port: 0, analytics });
    const second = await startTeamServer({ workspace, port: 0, analytics });
    handles.push(first, second);
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };
    const accepted = await fetch(`${first.url}/api/v1/projects/default/traces`, { method: "POST", headers, body: JSON.stringify(trace("shared", "ok")) });
    expect(accepted.status).toBe(202);
    const summary = await (await fetch(`${second.url}/api/v1/projects/default/analytics/summary`, { headers })).json() as any;
    expect(summary.summary.totals).toMatchObject({ count: 1, passed: 1, failed: 0 });

    await fetch(`${second.url}/api/v1/projects/default/traces`, { method: "POST", headers, body: JSON.stringify(trace("shared", "error")) });
    const updated = await (await fetch(`${first.url}/api/v1/projects/default/analytics/summary`, { headers })).json() as any;
    expect(updated.summary.totals).toMatchObject({ count: 1, passed: 0, failed: 1 });
    const events = await (await fetch(`${first.url}/api/v1/projects/default/analytics/events?kind=trace&limit=10`, { headers })).json() as any;
    expect(events.events.items).toMatchObject([{ id: "shared", status: "error" }]);
    expect((await fetch(`${first.url}/api/v1/projects/default/analytics/timeseries?interval=hour`, { headers })).status).toBe(200);
    expect((await fetch(`${first.url}/api/v1/projects/default/analytics/facets`, { headers })).status).toBe(200);
    const resource = await (await fetch(`${first.url}/api/v1/projects/default/analytics/resources/trace/shared`, { headers })).json() as any;
    expect(resource.resource.payload).toMatchObject({ id: "shared", status: "error" });
  });

  it("uses ClickHouse ReplacingMergeTree ingestion and parameterized summaries", async () => {
    const calls: Array<{ url: string; body: string; headers: Headers }> = [];
    const request: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? "");
      calls.push({ url: String(input), body, headers: new Headers(init?.headers) });
      if (body.includes("GROUP BY kind ORDER BY kind")) return Response.json({ data: [{ kind: "trace", count: 2, passed: 1, failed: 1, durationMs: 15, tokens: 20, costUsd: 0 }] });
      return new Response("");
    };
    const store = new ClickHouseAnalyticsStore({ endpoint: "https://clickhouse.example", username: "dryrun", password: "secret", fetch: request });
    await store.initialize();
    await store.ingestTraces("workspace", "project", [trace("one", "ok")]);
    const summary = await store.summary("workspace", "project", { since: "2026-01-01T00:00:00Z" });
    expect(summary.totals).toMatchObject({ count: 2, passed: 1, failed: 1 });
    expect(calls.some((call) => call.body.includes("ReplacingMergeTree"))).toBe(true);
    expect(calls.some((call) => call.body.includes("DEFAULT now64(6)"))).toBe(true);
    expect(calls.some((call) => call.body.includes("FORMAT JSONEachRow"))).toBe(true);
    expect(calls.find((call) => call.body.includes("FORMAT JSONEachRow"))?.body).not.toContain('"version"');
    const query = calls.find((call) => call.body.includes("GROUP BY kind ORDER BY kind"))!;
    expect(new URL(query.url).searchParams.get("param_workspace")).toBe("workspace");
    expect(query.headers.get("x-clickhouse-key")).toBe("secret");
    expect(query.url).not.toContain("secret");
  });

  it("supports production event search, percentiles, facets, drill-down, and retention", async () => {
    const analytics = new MemoryAnalyticsStore();
    const first = trace("first", "ok");
    first.name = "Support agent";
    first.receivedAt = "2026-08-24T10:15:00.000Z";
    first.durationMs = 10;
    first.tags = ["production", "support"];
    first.metadata = { environment: "production", release: "v1" };
    first.spans[0].attributes = { "gen_ai.response.model": "gpt-test", "gen_ai.system": "openai-compatible" };
    const second = trace("second", "error");
    second.name = "Support fallback";
    second.receivedAt = "2026-08-24T11:15:00.000Z";
    second.durationMs = 100;
    second.tags = ["production"];
    second.metadata = { environment: "production", release: "v2" };
    await analytics.ingestTraces("workspace", "project", [first, second]);

    const page = await analytics.queryEvents("workspace", "project", { search: "support", tags: ["production"], limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
    const next = await analytics.queryEvents("workspace", "project", { tags: ["production"], limit: 1, cursor: page.nextCursor });
    expect(next.items[0].id).not.toBe(page.items[0].id);

    const summary = await analytics.summary("workspace", "project");
    expect(summary).toMatchObject({ passRate: 0.5, latency: { p50Ms: 10, p95Ms: 100, p99Ms: 100 } });
    const series = await analytics.timeseries("workspace", "project", { interval: "hour" });
    expect(series.points).toHaveLength(2);
    const facets = await analytics.facets("workspace", "project");
    expect(facets.environment).toContainEqual({ value: "production", count: 2 });
    expect(facets.model).toContainEqual({ value: "gpt-test", count: 1 });
    const resource = await analytics.resource("workspace", "project", "trace", "first");
    expect(resource?.payload).toMatchObject({ id: "first", name: "Support agent" });
    expect(await analytics.deleteBefore("workspace", "project", "2026-08-24T11:00:00.000Z")).toBe(1);
    expect((await analytics.summary("workspace", "project")).totals.count).toBe(1);
  });

  it("exposes public probes and authenticated low-cardinality Prometheus metrics", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dryrun-operations-")); dirs.push(dir);
    const { workspace, admin } = await TeamWorkspace.initialize(dir, "Operations team");
    const metricsToken = "metrics_12345678901234567890123456789012";
    const server = await startTeamServer({ workspace, port: 0, analytics: new MemoryAnalyticsStore(), metricsToken });
    handles.push(server);

    const live = await fetch(`${server.url}/api/v1/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, service: "dry-run-team" });

    const ready = await fetch(`${server.url}/api/v1/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, checks: { workspace: { ok: true }, analytics: { ok: true, backend: "memory" } } });

    expect((await fetch(`${server.url}/api/v1/metrics`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/v1/metrics`, { headers: { Authorization: `Bearer ${admin.token}` } })).status).toBe(401);
    const metrics = await fetch(`${server.url}/api/v1/metrics`, { headers: { Authorization: `Bearer ${metricsToken}` } });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const body = await metrics.text();
    expect(body).toContain("dryrun_up 1");
    expect(body).toContain('route="/api/v1/health/live"');
    expect(server.metrics().requests).toBeGreaterThanOrEqual(3);
  });

  it("fails readiness without leaking a dependency error while liveness stays healthy", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dryrun-unready-")); dirs.push(dir);
    const { workspace } = await TeamWorkspace.initialize(dir, "Unready team");
    const analytics: AnalyticsStore = {
      backend: "test-cluster",
      async initialize() {},
      async health() { return { ok: false, backend: "test-cluster", latencyMs: 9, error: "secret.internal:8123 refused the password" }; },
      async ingestTraces() {},
      async ingestExperiments() {},
      async summary() { throw new Error("unavailable"); },
    };
    const server = await startTeamServer({ workspace, port: 0, analytics });
    handles.push(server);

    expect((await fetch(`${server.url}/api/v1/health/live`)).status).toBe(200);
    const ready = await fetch(`${server.url}/api/v1/health/ready`);
    expect(ready.status).toBe(503);
    const body = await ready.text();
    expect(body).toContain('"backend":"test-cluster"');
    expect(body).not.toContain("secret.internal");
    expect((await server.readiness()).ok).toBe(false);
  });
});

function trace(id: string, status: "ok" | "error"): TraceDocument {
  const now = new Date().toISOString();
  return {
    kind: "dry-run.trace", version: 1, id, name: id, status, startedAt: now, endedAt: now, durationMs: 5,
    rootSpanId: `span_${id}`,
    spans: [{ id: `span_${id}`, traceId: id, name: "agent", type: "agent", status, startedAt: now, endedAt: now, durationMs: 5, attributes: {}, metrics: { total_tokens: 10 }, events: [] }],
    feedback: [],
  };
}
