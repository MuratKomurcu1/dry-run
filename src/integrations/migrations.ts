import { createHash } from "node:crypto";
import { redactDeep } from "../cassette.ts";
import { Dataset, type DatasetCase, type DatasetDocument } from "../dataset.ts";
import type { SpanRecord, SpanType, TraceDocument, TraceFeedback } from "../tracing.ts";
import { trimHyphens } from "../safe-text.ts";

export type MigrationSource = "deepeval" | "langfuse" | "braintrust";

export interface MigrationBundle {
  kind: "dry-run.migration";
  version: 1;
  source: MigrationSource;
  createdAt: string;
  datasets: DatasetDocument[];
  traces: TraceDocument[];
  warnings: string[];
  summary: { datasets: number; cases: number; traces: number; spans: number };
}

/** Converts documented JSON export shapes without importing vendor implementation code. */
export function migrateEvaluationExport(source: MigrationSource, input: unknown, name = `${source}-import`): MigrationBundle {
  if (!(["deepeval", "langfuse", "braintrust"] as const).includes(source)) throw new Error("Migration source must be deepeval, langfuse, or braintrust");
  const converted = source === "deepeval" ? migrateDeepEval(input, name) : source === "langfuse" ? migrateLangfuse(input) : migrateBraintrust(input);
  const createdAt = new Date().toISOString();
  return {
    kind: "dry-run.migration", version: 1, source, createdAt, datasets: converted.datasets, traces: converted.traces, warnings: converted.warnings,
    summary: { datasets: converted.datasets.length, cases: converted.datasets.reduce((total, dataset) => total + dataset.cases.length, 0), traces: converted.traces.length, spans: converted.traces.reduce((total, trace) => total + trace.spans.length, 0) },
  };
}

function migrateDeepEval(input: unknown, name: string): Converted {
  const root = record(input);
  const raw = array(input) ?? array(root?.testCases) ?? array(root?.test_cases) ?? array(root?.cases) ?? array(root?.data);
  if (!raw) throw new Error("DeepEval export does not contain a test-case array");
  const warnings: string[] = [];
  const cases: DatasetCase[] = raw.map((value, index) => {
    const item = record(value);
    if (!item) throw new Error(`DeepEval case ${index + 1} is not an object`);
    const inputValue = first(item, "input", "prompt", "user_input");
    if (inputValue == null) throw new Error(`DeepEval case ${index + 1} has no input`);
    const metrics = array(item.metricsData) ?? array(item.metrics_data) ?? array(item.metrics);
    if (metrics?.length) warnings.push(`Case ${index + 1}: historical metric results were preserved as metadata; rerun metrics to compare implementations`);
    const context = stringArray(first(item, "context"));
    const retrievalContext = stringArray(first(item, "retrievalContext", "retrieval_context"));
    return {
      id: safeId(String(first(item, "id", "testCaseId", "test_case_id") ?? `case-${index + 1}`), "case"),
      ...(typeof item.name === "string" ? { name: item.name } : {}), input: redacted(inputValue),
      ...(first(item, "expectedOutput", "expected_output", "expected") != null ? { expected: redacted(first(item, "expectedOutput", "expected_output", "expected")) } : {}),
      ...(context.length ? { context } : {}), ...(retrievalContext.length ? { retrievalContext } : {}),
      ...(Array.isArray(item.turns) ? { turns: normalizeTurns(item.turns) } : {}),
      metadata: { source: "deepeval", ...(first(item, "actualOutput", "actual_output") != null ? { previousOutput: redacted(first(item, "actualOutput", "actual_output")) } : {}), ...(metrics ? { previousMetrics: redacted(metrics) } : {}) },
    };
  });
  return { datasets: [Dataset.create(name, cases, { description: "Imported evaluation cases" }).document], traces: [], warnings: unique(warnings) };
}

function migrateLangfuse(input: unknown): Converted {
  const root = record(input);
  const raw = array(input) ?? array(root?.data) ?? array(root?.traces);
  if (!raw) throw new Error("Langfuse export does not contain a trace array");
  const warnings: string[] = [];
  const traces = raw.map((value, index) => {
    const item = requiredRecord(value, `Langfuse trace ${index + 1}`);
    const id = safeId(String(item.id ?? `trace-${index + 1}`), "trace");
    const observations = array(item.observations) ?? array(item.spans) ?? [];
    const startedAt = timestamp(first(item, "timestamp", "createdAt", "created_at"));
    const spans = observations.length ? observations.map((entry, spanIndex) => langfuseSpan(requiredRecord(entry, `Langfuse observation ${spanIndex + 1}`), id, spanIndex, startedAt)) : [syntheticRoot(item, id, startedAt)];
    const rootSpan = spans.find((span) => !span.parentId) ?? spans[0];
    if (!observations.length) warnings.push(`Trace ${id}: export had no observations; created a synthetic root span`);
    const endedAt = spans.map((span) => span.endedAt ?? span.startedAt).sort().at(-1) ?? startedAt;
    const scores = array(item.scores) ?? [];
    return traceDocument(id, String(item.name ?? "imported trace"), spans, rootSpan.id, startedAt, endedAt, tags(item.tags), record(item.metadata), scores.map((score, scoreIndex) => scoreFeedback(score, scoreIndex)));
  });
  return { datasets: [], traces, warnings };
}

function migrateBraintrust(input: unknown): Converted {
  const root = record(input);
  const rows = array(input) ?? array(root?.data) ?? array(root?.spans) ?? array(root?.events);
  if (!rows) throw new Error("Braintrust export does not contain span rows");
  const groups = new Map<string, Record<string, unknown>[]>();
  rows.forEach((value, index) => {
    const row = requiredRecord(value, `Braintrust row ${index + 1}`);
    const attributes = record(first(row, "span_attributes", "spanAttributes"));
    const group = String(first(row, "root_span_id", "rootSpanId", "trace_id", "traceId") ?? attributes?.root_span_id ?? row.id ?? `trace-${index + 1}`);
    groups.set(group, [...(groups.get(group) ?? []), row]);
  });
  const traces: TraceDocument[] = [];
  for (const [group, rows] of groups) {
    const id = safeId(group, "trace");
    const spans = rows.map((row, index) => braintrustSpan(row, id, index));
    const rootSpan = spans.find((span) => !span.parentId || !spans.some((candidate) => candidate.id === span.parentId)) ?? spans[0];
    rootSpan.parentId = undefined;
    const startedAt = spans.map((span) => span.startedAt).sort()[0];
    const endedAt = spans.map((span) => span.endedAt ?? span.startedAt).sort().at(-1) ?? startedAt;
    const rootRow = rows[spans.indexOf(rootSpan)] ?? rows[0];
    traces.push(traceDocument(id, String(first(rootRow, "name", "span_name") ?? "imported trace"), spans, rootSpan.id, startedAt, endedAt, tags(rootRow.tags), { source: "braintrust" }, []));
  }
  return { datasets: [], traces, warnings: [] };
}

function langfuseSpan(item: Record<string, unknown>, traceId: string, index: number, fallback: string): SpanRecord {
  const startedAt = timestamp(first(item, "startTime", "start_time", "timestamp"), fallback);
  const endedAt = timestamp(first(item, "endTime", "end_time"), startedAt);
  const level = String(first(item, "level", "status") ?? "").toLowerCase();
  const id = safeId(String(item.id ?? `span-${index}`), "span");
  return {
    id, traceId, ...(first(item, "parentObservationId", "parent_observation_id", "parentSpanId") ? { parentId: safeId(String(first(item, "parentObservationId", "parent_observation_id", "parentSpanId")), "span") } : {}),
    name: String(item.name ?? `span ${index + 1}`), type: spanType(String(item.type ?? item.kind ?? "custom")), status: level.includes("error") ? "error" : "ok",
    startedAt, endedAt, durationMs: durationMs(startedAt, endedAt), ...(item.input !== undefined ? { input: redacted(item.input) } : {}), ...(item.output !== undefined ? { output: redacted(item.output) } : {}),
    attributes: { source: "langfuse", ...(record(item.metadata) ?? {}), ...(typeof item.model === "string" ? { "gen_ai.response.model": item.model } : {}) }, metrics: numericRecord(item.usage ?? item.usageDetails), events: [],
    ...(level.includes("error") ? { error: { name: "ImportedError", message: String(first(item, "statusMessage", "status_message") ?? "Imported observation reported an error") } } : {}),
  };
}

function braintrustSpan(row: Record<string, unknown>, traceId: string, index: number): SpanRecord {
  const attributes = record(first(row, "span_attributes", "spanAttributes")) ?? {};
  const startedAt = timestamp(first(row, "created", "start", "start_time", "createdAt"));
  const metrics = numericRecord(row.metrics);
  const explicitDuration = number(first(row, "duration", "duration_ms", "durationMs"));
  const endedAt = timestamp(first(row, "end", "end_time", "endedAt"), explicitDuration != null ? new Date(Date.parse(startedAt) + explicitDuration).toISOString() : startedAt);
  const errorValue = first(row, "error", "error_message");
  return {
    id: safeId(String(first(row, "span_id", "spanId", "id") ?? `span-${index}`), "span"), traceId,
    ...(first(row, "parent_id", "parentId", "parent_span_id") ? { parentId: safeId(String(first(row, "parent_id", "parentId", "parent_span_id")), "span") } : {}),
    name: String(first(row, "name", "span_name") ?? `span ${index + 1}`), type: spanType(String(first(attributes, "type", "span_type") ?? first(row, "type") ?? "custom")), status: errorValue ? "error" : "ok",
    startedAt, endedAt, durationMs: explicitDuration ?? durationMs(startedAt, endedAt), ...(row.input !== undefined ? { input: redacted(row.input) } : {}), ...(row.output !== undefined ? { output: redacted(row.output) } : {}),
    attributes: { source: "braintrust", ...redacted(attributes) as Record<string, unknown> }, metrics, events: [], ...(errorValue ? { error: { name: "ImportedError", message: String(errorValue) } } : {}),
  };
}

function syntheticRoot(item: Record<string, unknown>, traceId: string, startedAt: string): SpanRecord { const endedAt = timestamp(first(item, "updatedAt", "updated_at"), startedAt); return { id: safeId(`${traceId}-root`, "span"), traceId, name: String(item.name ?? "trace"), type: "agent", status: item.level === "ERROR" ? "error" : "ok", startedAt, endedAt, durationMs: durationMs(startedAt, endedAt), ...(item.input !== undefined ? { input: redacted(item.input) } : {}), ...(item.output !== undefined ? { output: redacted(item.output) } : {}), attributes: { source: "langfuse" }, metrics: {}, events: [] }; }
function traceDocument(id: string, name: string, spans: SpanRecord[], rootSpanId: string, startedAt: string, endedAt: string, traceTags: string[], metadata: Record<string, unknown> | undefined, feedback: TraceFeedback[]): TraceDocument { const status = spans.some((span) => span.status === "error") ? "error" : "ok"; return { kind: "dry-run.trace", version: 1, id, name, status, startedAt, endedAt, durationMs: durationMs(startedAt, endedAt), rootSpanId, spans, ...(metadata ? { metadata: redacted(metadata) as Record<string, unknown> } : {}), ...(traceTags.length ? { tags: traceTags } : {}), feedback }; }
function scoreFeedback(value: unknown, index: number): TraceFeedback { const score = requiredRecord(value, `score ${index + 1}`); const numeric = number(first(score, "value", "score")); return { id: safeId(String(score.id ?? `feedback-${index}`), "feedback"), source: "external", ...(numeric != null ? { score: Math.max(0, Math.min(1, numeric)) } : {}), ...(typeof score.name === "string" ? { label: score.name } : {}), ...(typeof score.comment === "string" ? { comment: score.comment } : {}), createdAt: timestamp(first(score, "timestamp", "createdAt")) }; }
function normalizeTurns(value: unknown[]): any[] { return value.flatMap((turn) => { const item = record(turn); const role = String(item?.role ?? "user").toLowerCase(); if (!item || !["system", "user", "assistant", "tool"].includes(role)) return []; return [{ role, content: String(first(item, "content", "text") ?? ""), ...(typeof item.name === "string" ? { name: item.name } : {}) }]; }); }
function spanType(value: string): SpanType { const normalized = value.toLowerCase(); if (normalized.includes("generation") || normalized.includes("llm")) return "llm"; if (normalized.includes("tool")) return "tool"; if (normalized.includes("retriev")) return "retriever"; if (normalized.includes("score")) return "scorer"; if (normalized.includes("agent")) return "agent"; if (normalized.includes("task")) return "task"; return "custom"; }
function safeId(value: string, prefix: string): string { const normalized = trimHyphens(value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-")).slice(0, 120); return normalized || `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`; }
function timestamp(value: unknown, fallback = new Date(0).toISOString()): string { const time = typeof value === "number" ? (value > 1e14 ? value / 1e6 : value > 1e11 ? value : value * 1000) : Date.parse(String(value ?? "")); return Number.isFinite(time) ? new Date(time).toISOString() : fallback; }
function durationMs(start: string, end: string): number { return Math.max(0, Date.parse(end) - Date.parse(start)); }
function numericRecord(value: unknown): Record<string, number> { const result: Record<string, number> = {}; for (const [key, candidate] of Object.entries(record(value) ?? {})) if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) result[key] = candidate; return result; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function tags(value: unknown): string[] { return unique(stringArray(value).map((tag) => tag.slice(0, 256))); }
function number(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function redacted<T>(value: T): T { return redactDeep(value, true) as T; }
function array(value: unknown): unknown[] | undefined { return Array.isArray(value) ? value : undefined; }
function record(value: unknown): Record<string, any> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function requiredRecord(value: unknown, label: string): Record<string, unknown> { const result = record(value); if (!result) throw new Error(`${label} is not an object`); return result; }
function first(source: Record<string, any>, ...keys: string[]): any { for (const key of keys) if (source[key] != null) return source[key]; return undefined; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
interface Converted { datasets: DatasetDocument[]; traces: TraceDocument[]; warnings: string[] }
