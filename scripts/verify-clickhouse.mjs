#!/usr/bin/env node
import { ClickHouseAnalyticsStore } from "../dist/analytics.js";

const endpoint = process.env.DRYRUN_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const username = process.env.DRYRUN_CLICKHOUSE_USER ?? "dryrun";
const password = process.env.DRYRUN_CLICKHOUSE_PASSWORD ?? "dryrun-test-password";
const store = new ClickHouseAnalyticsStore({ endpoint, username, password, allowInsecureHttp: true });
await store.initialize();
await store.initialize();
const now = "2026-08-26T00:00:00.000Z";
const trace = {
  kind: "dry-run.trace", version: 1, id: "clickhouse-contract", name: "ClickHouse contract", status: "ok", startedAt: now, endedAt: now, receivedAt: now, durationMs: 123, rootSpanId: "root",
  spans: [{ id: "root", traceId: "clickhouse-contract", name: "generation", type: "llm", status: "ok", startedAt: now, endedAt: now, durationMs: 123, input: "hello", output: "world", attributes: { "gen_ai.response.model": "local-model", "gen_ai.system": "openai-compatible", environment: "integration" }, metrics: { total_tokens: 42, cost_usd: 0.001 }, events: [] }],
  tags: ["integration", "clickhouse"], feedback: [],
};
await store.ingestTraces("integration", "default", [trace]);
const summary = await store.summary("integration", "default");
const events = await store.queryEvents("integration", "default", { model: "local-model", tags: ["clickhouse"] });
const series = await store.timeseries("integration", "default", { interval: "hour" });
const facets = await store.facets("integration", "default");
const resource = await store.resource("integration", "default", "trace", trace.id);
assert(summary.totals.count === 1 && summary.latency.p95Ms === 123, "summary/percentile mismatch");
assert(events.items[0]?.id === trace.id, "event query mismatch");
assert(series.points.length === 1, "time-series mismatch");
assert(facets.model.some((item) => item.value === "local-model"), "facet mismatch");
assert(resource?.payload.id === trace.id, "resource payload mismatch");
await store.deleteBefore("integration", "default", "2026-08-27T00:00:00.000Z");
assert((await store.summary("integration", "default")).totals.count === 0, "retention delete mismatch");
console.log(JSON.stringify({ ok: true, backend: "clickhouse", analytics: ["summary", "percentiles", "events", "timeseries", "facets", "resource", "retention"] }));
function assert(condition, message) { if (!condition) throw new Error(message); }
