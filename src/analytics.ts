import type { ExperimentDocument } from "./experiment.ts";
import type { TraceDocument } from "./tracing.ts";

export interface AnalyticsHealth {
  ok: boolean;
  backend: string;
  latencyMs: number;
  error?: string;
}

export interface AnalyticsAggregate {
  kind: "trace" | "experiment";
  count: number;
  passed: number;
  failed: number;
  durationMs: number;
  tokens: number;
  costUsd: number;
  latency?: AnalyticsLatency;
}

export interface AnalyticsLatency {
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface AnalyticsSummary {
  workspaceId: string;
  projectId: string;
  since?: string;
  until?: string;
  aggregates: AnalyticsAggregate[];
  totals: Omit<AnalyticsAggregate, "kind">;
  passRate: number;
  latency: AnalyticsLatency;
}

export type AnalyticsKind = "trace" | "experiment";
export type AnalyticsInterval = "hour" | "day" | "week";

export interface AnalyticsQuery {
  since?: string;
  until?: string;
  kind?: AnalyticsKind;
  status?: string;
  tags?: string[];
  model?: string;
  provider?: string;
  environment?: string;
  release?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface AnalyticsEventView {
  kind: AnalyticsKind;
  id: string;
  name: string;
  occurredAt: string;
  status: string;
  passed: boolean;
  durationMs: number;
  tokens: number;
  costUsd: number;
  itemCount: number;
  tags: string[];
  model?: string;
  provider?: string;
  environment?: string;
  release?: string;
}

export interface AnalyticsPage {
  items: AnalyticsEventView[];
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface AnalyticsSeriesPoint {
  bucket: string;
  count: number;
  passed: number;
  failed: number;
  passRate: number;
  durationAvgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  tokens: number;
  costUsd: number;
}

export interface AnalyticsSeries {
  interval: AnalyticsInterval;
  points: AnalyticsSeriesPoint[];
}

export interface AnalyticsFacetValue { value: string; count: number }
export interface AnalyticsFacets {
  status: AnalyticsFacetValue[];
  tags: AnalyticsFacetValue[];
  model: AnalyticsFacetValue[];
  provider: AnalyticsFacetValue[];
  environment: AnalyticsFacetValue[];
  release: AnalyticsFacetValue[];
}

export interface AnalyticsResource {
  event: AnalyticsEventView;
  payload: TraceDocument | ExperimentDocument;
}

export interface AnalyticsStore {
  readonly backend: string;
  initialize(): Promise<void>;
  health(): Promise<AnalyticsHealth>;
  ingestTraces(workspaceId: string, projectId: string, traces: TraceDocument[]): Promise<void>;
  ingestExperiments(workspaceId: string, projectId: string, experiments: ExperimentDocument[]): Promise<void>;
  summary(workspaceId: string, projectId: string, opts?: { since?: string; until?: string }): Promise<AnalyticsSummary>;
  queryEvents?(workspaceId: string, projectId: string, opts?: AnalyticsQuery): Promise<AnalyticsPage>;
  timeseries?(workspaceId: string, projectId: string, opts?: AnalyticsQuery & { interval?: AnalyticsInterval }): Promise<AnalyticsSeries>;
  facets?(workspaceId: string, projectId: string, opts?: Omit<AnalyticsQuery, "limit" | "cursor">): Promise<AnalyticsFacets>;
  resource?(workspaceId: string, projectId: string, kind: AnalyticsKind, id: string): Promise<AnalyticsResource | undefined>;
  deleteBefore?(workspaceId: string, projectId: string, cutoff: string): Promise<number | undefined>;
  close?(): Promise<void>;
}

interface AnalyticsEvent {
  workspace_id: string;
  project_id: string;
  kind: "trace" | "experiment";
  resource_id: string;
  name: string;
  occurred_at: string;
  status: string;
  passed: number;
  duration_ms: number;
  tokens: number;
  cost_usd: number;
  item_count: number;
  tags: string[];
  model: string;
  provider: string;
  environment: string;
  release: string;
  payload: string;
}

export class MemoryAnalyticsStore implements AnalyticsStore {
  readonly backend = "memory";
  private readonly events = new Map<string, AnalyticsEvent>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async health(): Promise<AnalyticsHealth> { return { ok: true, backend: this.backend, latencyMs: 0 }; }
  async ingestTraces(workspaceId: string, projectId: string, traces: TraceDocument[]): Promise<void> {
    for (const event of traceEvents(workspaceId, projectId, traces)) this.events.set(eventKey(event), event);
  }
  async ingestExperiments(workspaceId: string, projectId: string, experiments: ExperimentDocument[]): Promise<void> {
    for (const event of experimentEvents(workspaceId, projectId, experiments)) this.events.set(eventKey(event), event);
  }
  async summary(workspaceId: string, projectId: string, opts: { since?: string; until?: string } = {}): Promise<AnalyticsSummary> {
    const range = validateRange(opts);
    const events = [...this.events.values()].filter((event) => event.workspace_id === workspaceId && event.project_id === projectId)
      .filter((event) => !range.since || event.occurred_at >= range.since)
      .filter((event) => !range.until || event.occurred_at <= range.until);
    return summarizeEvents(workspaceId, projectId, events, range);
  }
  async queryEvents(workspaceId: string, projectId: string, opts: AnalyticsQuery = {}): Promise<AnalyticsPage> {
    const { events, limit } = memorySelection(this.events, workspaceId, projectId, opts);
    const cursor = decodeCursor(opts.cursor);
    const start = cursor ? events.findIndex((event) => cursorKey(event) === cursorKey(cursor)) + 1 : 0;
    const selected = events.slice(Math.max(0, start), Math.max(0, start) + limit + 1);
    const hasMore = selected.length > limit;
    const page = selected.slice(0, limit);
    return { items: page.map(publicEvent), limit, hasMore, ...(hasMore && page.length ? { nextCursor: encodeCursor(page.at(-1)!) } : {}) };
  }
  async timeseries(workspaceId: string, projectId: string, opts: AnalyticsQuery & { interval?: AnalyticsInterval } = {}): Promise<AnalyticsSeries> {
    const interval = validateInterval(opts.interval);
    const { events } = memorySelection(this.events, workspaceId, projectId, { ...opts, limit: 500 });
    return seriesFromEvents(events, interval);
  }
  async facets(workspaceId: string, projectId: string, opts: Omit<AnalyticsQuery, "limit" | "cursor"> = {}): Promise<AnalyticsFacets> {
    const { events } = memorySelection(this.events, workspaceId, projectId, { ...opts, limit: 500 });
    return facetsFromEvents(events);
  }
  async resource(workspaceId: string, projectId: string, kind: AnalyticsKind, id: string): Promise<AnalyticsResource | undefined> {
    const event = this.events.get(`${workspaceId}\0${projectId}\0${kind}\0${id}`);
    return event ? { event: publicEvent(event), payload: JSON.parse(event.payload) as TraceDocument | ExperimentDocument } : undefined;
  }
  async deleteBefore(workspaceId: string, projectId: string, cutoff: string): Promise<number> {
    const before = iso(cutoff, "cutoff");
    let deleted = 0;
    for (const [key, event] of this.events) if (event.workspace_id === workspaceId && event.project_id === projectId && event.occurred_at < before) { this.events.delete(key); deleted += 1; }
    return deleted;
  }
}

export interface ClickHouseAnalyticsOptions {
  endpoint: string;
  database?: string;
  tablePrefix?: string;
  username?: string;
  password?: string;
  createSchema?: boolean;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ClickHouseAnalyticsStore implements AnalyticsStore {
  readonly backend = "clickhouse";
  readonly endpoint: URL;
  readonly database: string;
  readonly table: string;
  private readonly options: ClickHouseAnalyticsOptions;
  private readonly request: typeof fetch;

  constructor(options: ClickHouseAnalyticsOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("ClickHouse endpoint cannot contain credentials, query, or fragment");
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname.toLowerCase());
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && (loopback || options.allowInsecureHttp))) throw new Error("ClickHouse endpoint requires HTTPS outside loopback");
    if (!/^https?:$/.test(endpoint.protocol)) throw new Error("ClickHouse endpoint must use HTTP(S)");
    this.database = sqlIdentifier(options.database ?? "dryrun", "ClickHouse database");
    this.table = `${sqlIdentifier(options.tablePrefix ?? "dryrun", "ClickHouse table prefix")}_events`;
    this.endpoint = endpoint;
    this.options = options;
    this.request = options.fetch ?? fetch;
  }

  async initialize(): Promise<void> {
    if (this.options.createSchema === false) return;
    await this.query(`CREATE DATABASE IF NOT EXISTS ${this.database}`);
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.database}.${this.table} (
      workspace_id String,
      project_id String,
      kind LowCardinality(String),
      resource_id String,
      name String,
      occurred_at DateTime64(3, 'UTC'),
      status LowCardinality(String),
      passed UInt8,
      duration_ms Float64,
      tokens UInt64,
      cost_usd Float64,
      item_count UInt32,
      tags Array(String),
      model LowCardinality(String),
      provider LowCardinality(String),
      environment LowCardinality(String),
      release LowCardinality(String),
      payload String CODEC(ZSTD(3)),
      version DateTime64(6, 'UTC') DEFAULT now64(6)
    ) ENGINE = ReplacingMergeTree(version)
    PARTITION BY toYYYYMM(occurred_at)
    ORDER BY (workspace_id, project_id, kind, resource_id)`);
    const additions = [
      "name String AFTER resource_id",
      "model LowCardinality(String) AFTER tags",
      "provider LowCardinality(String) AFTER model",
      "environment LowCardinality(String) AFTER provider",
      "release LowCardinality(String) AFTER environment",
      "payload String CODEC(ZSTD(3)) AFTER release",
    ];
    for (const addition of additions) await this.query(`ALTER TABLE ${this.database}.${this.table} ADD COLUMN IF NOT EXISTS ${addition}`);
  }

  async health(): Promise<AnalyticsHealth> {
    const started = performance.now();
    try {
      await this.query("SELECT 1 FORMAT JSON");
      return { ok: true, backend: this.backend, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, backend: this.backend, latencyMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
    }
  }

  async ingestTraces(workspaceId: string, projectId: string, traces: TraceDocument[]): Promise<void> {
    await this.insert(traceEvents(workspaceId, projectId, traces));
  }

  async ingestExperiments(workspaceId: string, projectId: string, experiments: ExperimentDocument[]): Promise<void> {
    await this.insert(experimentEvents(workspaceId, projectId, experiments));
  }

  async summary(workspaceId: string, projectId: string, opts: { since?: string; until?: string } = {}): Promise<AnalyticsSummary> {
    const range = validateRange(opts);
    const parameters: Record<string, string> = { workspace: workspaceId, project: projectId, since: range.since ?? "1970-01-01T00:00:00.000Z", until: range.until ?? "9999-12-31T23:59:59.999Z" };
    const body = await this.query(`SELECT
      kind,
      count() AS count,
      sum(passed) AS passedCount,
      count() - sum(passed) AS failedCount,
      sum(duration_ms) AS durationMs,
      sum(tokens) AS tokens,
      sum(cost_usd) AS costUsd
    FROM (
      SELECT kind, resource_id,
        argMax(occurred_at, version) AS occurred_at,
        argMax(passed, version) AS passed,
        argMax(duration_ms, version) AS duration_ms,
        argMax(tokens, version) AS tokens,
        argMax(cost_usd, version) AS cost_usd
      FROM ${this.database}.${this.table}
      WHERE workspace_id = {workspace:String} AND project_id = {project:String}
      GROUP BY kind, resource_id
    )
    WHERE occurred_at >= parseDateTime64BestEffort({since:String}) AND occurred_at <= parseDateTime64BestEffort({until:String})
    GROUP BY kind ORDER BY kind FORMAT JSON`, parameters);
    const parsed = JSON.parse(body) as { data?: Array<Record<string, unknown>> };
    const aggregates = (parsed.data ?? []).map((row): AnalyticsAggregate => ({
      kind: row.kind === "experiment" ? "experiment" : "trace",
      count: finiteNumber(row.count), passed: finiteNumber(row.passedCount ?? row.passed), failed: finiteNumber(row.failedCount ?? row.failed),
      durationMs: finiteNumber(row.durationMs), tokens: finiteNumber(row.tokens), costUsd: finiteNumber(row.costUsd),
    }));
    const latencyBody = await this.query(`SELECT
      avg(duration_ms) AS averageMs,
      quantileExact(0.50)(duration_ms) AS p50Ms,
      quantileExact(0.95)(duration_ms) AS p95Ms,
      quantileExact(0.99)(duration_ms) AS p99Ms
    FROM (
      SELECT kind, resource_id, argMax(occurred_at, version) AS occurred_at, argMax(duration_ms, version) AS duration_ms
      FROM ${this.database}.${this.table}
      WHERE workspace_id = {workspace:String} AND project_id = {project:String}
      GROUP BY kind, resource_id
    ) WHERE occurred_at >= parseDateTime64BestEffort({since:String}) AND occurred_at <= parseDateTime64BestEffort({until:String}) FORMAT JSON`, parameters);
    const latencyRow = (JSON.parse(latencyBody || "{}") as { data?: Array<Record<string, unknown>> }).data?.[0];
    return summaryFromAggregates(workspaceId, projectId, aggregates, range, latencyRow ? latencyFromRow(latencyRow) : undefined);
  }

  async queryEvents(workspaceId: string, projectId: string, opts: AnalyticsQuery = {}): Promise<AnalyticsPage> {
    const built = clickHouseFilters(workspaceId, projectId, opts);
    const limit = boundedLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
      built.clauses.push("(occurred_at, kind, resource_id) < (parseDateTime64BestEffort({cursor_time:String}), {cursor_kind:String}, {cursor_id:String})");
      Object.assign(built.parameters, { cursor_time: cursor.occurred_at, cursor_kind: cursor.kind, cursor_id: cursor.resource_id });
    }
    const body = await this.query(`SELECT kind, resource_id, name, occurred_at, status, passed, duration_ms, tokens, cost_usd, item_count, tags, model, provider, environment, release
    FROM (${latestEventsSql(this.database, this.table)})
    WHERE ${built.clauses.join(" AND ")}
    ORDER BY occurred_at DESC, kind DESC, resource_id DESC LIMIT ${limit + 1} FORMAT JSON`, built.parameters);
    const rows = (JSON.parse(body || "{}") as { data?: Array<Record<string, unknown>> }).data ?? [];
    const events = rows.map(eventFromRow);
    const hasMore = events.length > limit;
    const page = events.slice(0, limit);
    return { items: page.map(publicEvent), limit, hasMore, ...(hasMore && page.length ? { nextCursor: encodeCursor(page.at(-1)!) } : {}) };
  }

  async timeseries(workspaceId: string, projectId: string, opts: AnalyticsQuery & { interval?: AnalyticsInterval } = {}): Promise<AnalyticsSeries> {
    const interval = validateInterval(opts.interval);
    const built = clickHouseFilters(workspaceId, projectId, opts);
    const bucket = interval === "hour" ? "toStartOfHour(occurred_at)" : interval === "week" ? "toStartOfWeek(occurred_at, 1)" : "toStartOfDay(occurred_at)";
    const body = await this.query(`SELECT ${bucket} AS bucket, count() AS count, sum(passed) AS passedCount, count()-sum(passed) AS failedCount,
      avg(duration_ms) AS durationAvgMs, quantileExact(0.50)(duration_ms) AS p50Ms, quantileExact(0.95)(duration_ms) AS p95Ms,
      quantileExact(0.99)(duration_ms) AS p99Ms, sum(tokens) AS tokens, sum(cost_usd) AS costUsd
    FROM (${latestEventsSql(this.database, this.table)}) WHERE ${built.clauses.join(" AND ")}
    GROUP BY bucket ORDER BY bucket FORMAT JSON`, built.parameters);
    const rows = (JSON.parse(body || "{}") as { data?: Array<Record<string, unknown>> }).data ?? [];
    return { interval, points: rows.map(seriesPointFromRow) };
  }

  async facets(workspaceId: string, projectId: string, opts: Omit<AnalyticsQuery, "limit" | "cursor"> = {}): Promise<AnalyticsFacets> {
    const built = clickHouseFilters(workspaceId, projectId, opts);
    const columns = ["status", "model", "provider", "environment", "release"] as const;
    const result = emptyFacets();
    for (const column of columns) {
      const body = await this.query(`SELECT ${column} AS value, count() AS count FROM (${latestEventsSql(this.database, this.table)})
      WHERE ${built.clauses.join(" AND ")} AND ${column} != '' GROUP BY value ORDER BY count DESC, value LIMIT 100 FORMAT JSON`, built.parameters);
      result[column] = facetRows(body);
    }
    const tagBody = await this.query(`SELECT tag AS value, count() AS count FROM (${latestEventsSql(this.database, this.table)}) ARRAY JOIN tags AS tag
      WHERE ${built.clauses.join(" AND ")} AND tag != '' GROUP BY value ORDER BY count DESC, value LIMIT 100 FORMAT JSON`, built.parameters);
    result.tags = facetRows(tagBody);
    return result;
  }

  async resource(workspaceId: string, projectId: string, kind: AnalyticsKind, id: string): Promise<AnalyticsResource | undefined> {
    const body = await this.query(`SELECT kind, resource_id, name, occurred_at, status, passed, duration_ms, tokens, cost_usd, item_count, tags, model, provider, environment, release, payload
      FROM (${latestEventsSql(this.database, this.table)}) WHERE workspace_id={workspace:String} AND project_id={project:String} AND kind={kind:String} AND resource_id={id:String} LIMIT 1 FORMAT JSON`,
    { workspace: workspaceId, project: projectId, kind, id });
    const row = (JSON.parse(body || "{}") as { data?: Array<Record<string, unknown>> }).data?.[0];
    if (!row) return undefined;
    return { event: publicEvent(eventFromRow(row)), payload: JSON.parse(String(row.payload)) as TraceDocument | ExperimentDocument };
  }

  async deleteBefore(workspaceId: string, projectId: string, cutoff: string): Promise<undefined> {
    await this.query(`ALTER TABLE ${this.database}.${this.table} DELETE WHERE workspace_id={workspace:String} AND project_id={project:String} AND occurred_at < parseDateTime64BestEffort({cutoff:String})`,
      { workspace: workspaceId, project: projectId, cutoff: iso(cutoff, "cutoff"), setting_mutations_sync: "1" });
    return undefined;
  }

  private async insert(events: AnalyticsEvent[]): Promise<void> {
    if (!events.length) return;
    const unique = [...new Map(events.map((event) => [eventKey(event), event])).values()];
    const lines = unique.map((event) => JSON.stringify(event)).join("\n");
    await this.query(`INSERT INTO ${this.database}.${this.table} FORMAT JSONEachRow\n${lines}`, {
      setting_date_time_input_format: "best_effort",
      setting_input_format_defaults_for_omitted_fields: "1",
    });
  }

  private async query(statement: string, parameters: Record<string, string> = {}): Promise<string> {
    const endpoint = new URL(this.endpoint);
    endpoint.searchParams.set("database", this.database);
    for (const [name, value] of Object.entries(parameters)) {
      if (name.startsWith("setting_")) endpoint.searchParams.set(name.slice("setting_".length), value);
      else endpoint.searchParams.set(name.startsWith("param_") ? name : `param_${name}`, value);
    }
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", accept: "application/json" };
    if (this.options.username) headers["x-clickhouse-user"] = this.options.username;
    if (this.options.password) headers["x-clickhouse-key"] = this.options.password;
    const response = await this.request(endpoint, { method: "POST", redirect: "error", headers, body: statement, signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000) });
    const body = await response.text();
    if (!response.ok) throw new AnalyticsError(`ClickHouse request failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    return body;
  }
}

export class AnalyticsError extends Error {
  readonly status = 503;
  constructor(message: string) { super(message); this.name = "AnalyticsError"; }
}

function traceEvents(workspaceId: string, projectId: string, traces: TraceDocument[]): AnalyticsEvent[] {
  return traces.map((trace) => ({
    workspace_id: workspaceId, project_id: projectId, kind: "trace", resource_id: trace.id, name: trace.name,
    occurred_at: trace.receivedAt ?? trace.endedAt, status: trace.status, passed: trace.status === "ok" ? 1 : 0,
    duration_ms: finiteNumber(trace.durationMs), tokens: spanMetric(trace, /(?:^|_)(?:total_?)?tokens?$/i), cost_usd: spanMetric(trace, /cost(?:_usd)?$/i),
    item_count: trace.spans.length, tags: trace.tags ?? [],
    model: traceDimension(trace, ["model", "gen_ai.response.model", "gen_ai.request.model", "llm.model_name"]),
    provider: traceDimension(trace, ["provider", "gen_ai.system", "llm.provider"]),
    environment: traceDimension(trace, ["environment", "deployment.environment", "service.environment"]),
    release: traceDimension(trace, ["release", "service.version", "deployment.release"]),
    payload: JSON.stringify(trace),
  }));
}

function experimentEvents(workspaceId: string, projectId: string, experiments: ExperimentDocument[]): AnalyticsEvent[] {
  return experiments.map((experiment) => ({
    workspace_id: workspaceId, project_id: projectId, kind: "experiment", resource_id: experiment.id, name: experiment.name,
    occurred_at: experiment.updatedAt, status: experiment.passed ? "passed" : "failed", passed: experiment.passed ? 1 : 0,
    duration_ms: finiteNumber(experiment.summary.durationMs), tokens: finiteNumber(experiment.summary.tokens), cost_usd: finiteNumber(experiment.summary.costUsd),
    item_count: experiment.summary.total, tags: experiment.tags ?? [],
    model: recordString(experiment.metadata, ["model", "modelName"]),
    provider: recordString(experiment.metadata, ["provider"]),
    environment: recordString(experiment.metadata, ["environment"]),
    release: recordString(experiment.metadata, ["release"]) || experiment.provenance.gitSha || experiment.provenance.producer.version,
    payload: JSON.stringify(experiment),
  }));
}

function spanMetric(trace: TraceDocument, pattern: RegExp): number {
  let total = 0;
  for (const span of trace.spans) for (const [name, value] of Object.entries(span.metrics)) if (pattern.test(name) && typeof value === "number" && Number.isFinite(value)) total += value;
  return total;
}

function eventKey(event: AnalyticsEvent): string { return `${event.workspace_id}\0${event.project_id}\0${event.kind}\0${event.resource_id}`; }

function validateRange(opts: { since?: string; until?: string }): { since?: string; until?: string } {
  const since = opts.since ? iso(opts.since, "since") : undefined;
  const until = opts.until ? iso(opts.until, "until") : undefined;
  if (since && until && since > until) throw new Error("Analytics since cannot be after until");
  return { ...(since ? { since } : {}), ...(until ? { until } : {}) };
}

function summarizeEvents(workspaceId: string, projectId: string, events: AnalyticsEvent[], range: { since?: string; until?: string }): AnalyticsSummary {
  const aggregates = (["trace", "experiment"] as const).flatMap((kind) => {
    const selected = events.filter((event) => event.kind === kind);
    return selected.length ? [{ kind, count: selected.length, passed: selected.reduce((sum, event) => sum + event.passed, 0), failed: selected.reduce((sum, event) => sum + (event.passed ? 0 : 1), 0), durationMs: sum(selected, "duration_ms"), tokens: sum(selected, "tokens"), costUsd: sum(selected, "cost_usd") }] : [];
  });
  return summaryFromAggregates(workspaceId, projectId, aggregates, range, latencyFromEvents(events));
}

function summaryFromAggregates(workspaceId: string, projectId: string, aggregates: AnalyticsAggregate[], range: { since?: string; until?: string }, latency = zeroLatency()): AnalyticsSummary {
  const totals = {
    count: aggregates.reduce((sum, value) => sum + value.count, 0), passed: aggregates.reduce((sum, value) => sum + value.passed, 0), failed: aggregates.reduce((sum, value) => sum + value.failed, 0),
    durationMs: aggregates.reduce((sum, value) => sum + value.durationMs, 0), tokens: aggregates.reduce((sum, value) => sum + value.tokens, 0), costUsd: aggregates.reduce((sum, value) => sum + value.costUsd, 0),
  };
  return {
    workspaceId, projectId, ...range, aggregates,
    totals,
    passRate: totals.count ? totals.passed / totals.count : 0,
    latency,
  };
}

function memorySelection(source: Map<string, AnalyticsEvent>, workspaceId: string, projectId: string, opts: AnalyticsQuery): { events: AnalyticsEvent[]; limit: number } {
  const range = validateRange(opts);
  const tags = validateStrings(opts.tags, "tags");
  const search = normalizedFilter(opts.search);
  const events = [...source.values()].filter((event) => event.workspace_id === workspaceId && event.project_id === projectId)
    .filter((event) => !range.since || event.occurred_at >= range.since)
    .filter((event) => !range.until || event.occurred_at <= range.until)
    .filter((event) => !opts.kind || event.kind === opts.kind)
    .filter((event) => !opts.status || event.status === opts.status)
    .filter((event) => !opts.model || event.model === opts.model)
    .filter((event) => !opts.provider || event.provider === opts.provider)
    .filter((event) => !opts.environment || event.environment === opts.environment)
    .filter((event) => !opts.release || event.release === opts.release)
    .filter((event) => tags.every((tag) => event.tags.includes(tag)))
    .filter((event) => !search || `${event.name}\n${event.resource_id}`.toLowerCase().includes(search))
    .sort(compareEvents);
  return { events, limit: boundedLimit(opts.limit) };
}

function clickHouseFilters(workspaceId: string, projectId: string, opts: Omit<AnalyticsQuery, "cursor">): { clauses: string[]; parameters: Record<string, string> } {
  const range = validateRange(opts);
  const clauses = ["workspace_id={workspace:String}", "project_id={project:String}"];
  const parameters: Record<string, string> = { workspace: workspaceId, project: projectId };
  for (const [key, column] of [["kind", "kind"], ["status", "status"], ["model", "model"], ["provider", "provider"], ["environment", "environment"], ["release", "release"]] as const) {
    const value = opts[key];
    if (value) { clauses.push(`${column}={${key}:String}`); parameters[key] = validatedFilter(value, key); }
  }
  if (range.since) { clauses.push("occurred_at>=parseDateTime64BestEffort({since:String})"); parameters.since = range.since; }
  if (range.until) { clauses.push("occurred_at<=parseDateTime64BestEffort({until:String})"); parameters.until = range.until; }
  const tags = validateStrings(opts.tags, "tags");
  tags.forEach((tag, index) => { const name = `tag_${index}`; clauses.push(`has(tags, {${name}:String})`); parameters[name] = tag; });
  if (opts.search) { clauses.push("positionCaseInsensitiveUTF8(concat(name, '\\n', resource_id), {search:String}) > 0"); parameters.search = validatedFilter(opts.search, "search"); }
  return { clauses, parameters };
}

function latestEventsSql(database: string, table: string): string {
  return `SELECT workspace_id, project_id, kind, resource_id,
    argMax(name, version) AS name, argMax(occurred_at, version) AS occurred_at, argMax(status, version) AS status,
    argMax(passed, version) AS passed, argMax(duration_ms, version) AS duration_ms, argMax(tokens, version) AS tokens,
    argMax(cost_usd, version) AS cost_usd, argMax(item_count, version) AS item_count, argMax(tags, version) AS tags,
    argMax(model, version) AS model, argMax(provider, version) AS provider, argMax(environment, version) AS environment,
    argMax(release, version) AS release, argMax(payload, version) AS payload
    FROM ${database}.${table} GROUP BY workspace_id, project_id, kind, resource_id`;
}

function publicEvent(event: AnalyticsEvent): AnalyticsEventView {
  return {
    kind: event.kind, id: event.resource_id, name: event.name, occurredAt: normalizeClickHouseTime(event.occurred_at), status: event.status,
    passed: Boolean(event.passed), durationMs: event.duration_ms, tokens: event.tokens, costUsd: event.cost_usd, itemCount: event.item_count,
    tags: [...event.tags], ...(event.model ? { model: event.model } : {}), ...(event.provider ? { provider: event.provider } : {}),
    ...(event.environment ? { environment: event.environment } : {}), ...(event.release ? { release: event.release } : {}),
  };
}

function eventFromRow(row: Record<string, unknown>): AnalyticsEvent {
  return {
    workspace_id: String(row.workspace_id ?? ""), project_id: String(row.project_id ?? ""), kind: row.kind === "experiment" ? "experiment" : "trace",
    resource_id: String(row.resource_id), name: String(row.name ?? row.resource_id), occurred_at: normalizeClickHouseTime(String(row.occurred_at)),
    status: String(row.status ?? ""), passed: finiteNumber(row.passed), duration_ms: finiteNumber(row.duration_ms), tokens: finiteNumber(row.tokens),
    cost_usd: finiteNumber(row.cost_usd), item_count: finiteNumber(row.item_count), tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    model: String(row.model ?? ""), provider: String(row.provider ?? ""), environment: String(row.environment ?? ""), release: String(row.release ?? ""), payload: String(row.payload ?? "{}"),
  };
}

function seriesFromEvents(events: AnalyticsEvent[], interval: AnalyticsInterval): AnalyticsSeries {
  const groups = new Map<string, AnalyticsEvent[]>();
  for (const event of events) {
    const bucket = timeBucket(event.occurred_at, interval);
    groups.set(bucket, [...(groups.get(bucket) ?? []), event]);
  }
  return { interval, points: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, values]) => {
    const durations = values.map((event) => event.duration_ms);
    const passed = values.reduce((total, event) => total + event.passed, 0);
    return { bucket, count: values.length, passed, failed: values.length - passed, passRate: values.length ? passed / values.length : 0,
      durationAvgMs: average(durations), p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99),
      tokens: sum(values, "tokens"), costUsd: sum(values, "cost_usd") };
  }) };
}

function facetsFromEvents(events: AnalyticsEvent[]): AnalyticsFacets {
  const result = emptyFacets();
  for (const key of ["status", "model", "provider", "environment", "release"] as const) result[key] = counted(events.map((event) => event[key]).filter(Boolean));
  result.tags = counted(events.flatMap((event) => event.tags));
  return result;
}

function emptyFacets(): AnalyticsFacets { return { status: [], tags: [], model: [], provider: [], environment: [], release: [] }; }
function counted(values: string[]): AnalyticsFacetValue[] { const counts = new Map<string, number>(); for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1); return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, 100); }
function facetRows(body: string): AnalyticsFacetValue[] { return ((JSON.parse(body || "{}") as { data?: Array<Record<string, unknown>> }).data ?? []).map((row) => ({ value: String(row.value), count: finiteNumber(row.count) })); }
function seriesPointFromRow(row: Record<string, unknown>): AnalyticsSeriesPoint { const count = finiteNumber(row.count); const passed = finiteNumber(row.passedCount ?? row.passed); return { bucket: normalizeClickHouseTime(String(row.bucket)), count, passed, failed: finiteNumber(row.failedCount ?? row.failed), passRate: count ? passed / count : 0, durationAvgMs: finiteNumber(row.durationAvgMs), p50Ms: finiteNumber(row.p50Ms), p95Ms: finiteNumber(row.p95Ms), p99Ms: finiteNumber(row.p99Ms), tokens: finiteNumber(row.tokens), costUsd: finiteNumber(row.costUsd) }; }

function latencyFromEvents(events: AnalyticsEvent[]): AnalyticsLatency { const values = events.map((event) => event.duration_ms); return { averageMs: average(values), p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99) }; }
function latencyFromRow(row: Record<string, unknown>): AnalyticsLatency { return { averageMs: finiteNumber(row.averageMs), p50Ms: finiteNumber(row.p50Ms), p95Ms: finiteNumber(row.p95Ms), p99Ms: finiteNumber(row.p99Ms) }; }
function zeroLatency(): AnalyticsLatency { return { averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }; }
function average(values: number[]): number { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
function percentile(values: number[], quantile: number): number { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]; }
function timeBucket(value: string, interval: AnalyticsInterval): string { const date = new Date(value); if (interval === "hour") date.setUTCMinutes(0, 0, 0); else { date.setUTCHours(0, 0, 0, 0); if (interval === "week") { const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() - day + 1); } } return date.toISOString(); }

function traceDimension(trace: TraceDocument, keys: string[]): string {
  const metadata = recordString(trace.metadata, keys);
  if (metadata) return metadata;
  for (const span of trace.spans) { const value = recordString(span.attributes, keys); if (value) return value; }
  return "";
}
function recordString(record: Record<string, unknown> | undefined, keys: string[]): string { for (const key of keys) { const value = record?.[key]; if (typeof value === "string" && value.trim()) return value.trim().slice(0, 512); } return ""; }

function encodeCursor(event: Pick<AnalyticsEvent, "occurred_at" | "kind" | "resource_id">): string { return Buffer.from(JSON.stringify({ t: event.occurred_at, k: event.kind, i: event.resource_id }), "utf8").toString("base64url"); }
function decodeCursor(value: string | undefined): Pick<AnalyticsEvent, "occurred_at" | "kind" | "resource_id"> | undefined { if (!value) return undefined; if (value.length > 1024) throw new Error("Analytics cursor is invalid"); try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>; if (typeof parsed.t !== "string" || (parsed.k !== "trace" && parsed.k !== "experiment") || typeof parsed.i !== "string") throw new Error(); return { occurred_at: iso(parsed.t, "cursor"), kind: parsed.k, resource_id: parsed.i }; } catch { throw new Error("Analytics cursor is invalid"); } }
function cursorKey(value: Pick<AnalyticsEvent, "occurred_at" | "kind" | "resource_id">): string { return `${value.occurred_at}\0${value.kind}\0${value.resource_id}`; }
function compareEvents(a: AnalyticsEvent, b: AnalyticsEvent): number { return b.occurred_at.localeCompare(a.occurred_at) || b.kind.localeCompare(a.kind) || b.resource_id.localeCompare(a.resource_id); }
function boundedLimit(value = 100): number { if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error("Analytics limit must be between 1 and 500"); return value; }
function validateInterval(value: AnalyticsInterval | undefined): AnalyticsInterval { if (value == null) return "day"; if (!(["hour", "day", "week"] as const).includes(value)) throw new Error("Analytics interval must be hour, day, or week"); return value; }
function validateStrings(value: string[] | undefined, label: string): string[] { if (value == null) return []; if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 256)) throw new Error(`Analytics ${label} is invalid`); return [...new Set(value.map((item) => item.trim()))]; }
function normalizedFilter(value: string | undefined, label = "filter"): string { if (value == null) return ""; const result = value.trim(); if (!result || result.length > 512) throw new Error(`Analytics ${label} is invalid`); return result.toLowerCase(); }
function validatedFilter(value: string, label: string): string { const result = value.trim(); if (!result || result.length > 512) throw new Error(`Analytics ${label} is invalid`); return result; }
function normalizeClickHouseTime(value: string): string { const parsed = Date.parse(value.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value; }

function sum(events: AnalyticsEvent[], field: "duration_ms" | "tokens" | "cost_usd"): number { return events.reduce((total, event) => total + event[field], 0); }
function finiteNumber(value: unknown): number { const number = Number(value ?? 0); return Number.isFinite(number) ? number : 0; }
function iso(value: string, label: string): string { const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error(`Analytics ${label} must be an ISO timestamp`); return new Date(time).toISOString(); }
function sqlIdentifier(value: string, label: string): string { if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) throw new Error(`${label} is invalid`); return value; }
