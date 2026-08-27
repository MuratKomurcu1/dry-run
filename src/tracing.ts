import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { redactDeep } from "./cassette.ts";
import type { Trajectory, Step, ToolCall } from "./types.ts";
import { atomicWriteJson, ensurePrivateDirectory, newId, readJsonFile, withFileLock } from "./storage.ts";
import { DRY_RUN_VERSION } from "./version.ts";

export type SpanType = "agent" | "task" | "llm" | "tool" | "retriever" | "scorer" | "custom";
export type SpanStatus = "running" | "ok" | "error";

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

export interface SpanRecord {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  type: SpanType;
  status: SpanStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  attributes: Record<string, unknown>;
  metrics: Record<string, number>;
  events: SpanEvent[];
  error?: { name: string; message: string };
}

export interface TraceFeedback {
  id: string;
  spanId?: string;
  source: "human" | "code" | "external";
  score?: number;
  label?: string;
  comment?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface TraceDocument {
  kind: "dry-run.trace";
  version: 1;
  id: string;
  name: string;
  status: "ok" | "error";
  startedAt: string;
  endedAt: string;
  /** Server-controlled ingestion time used by self-hosted retention. */
  receivedAt?: string;
  durationMs: number;
  rootSpanId: string;
  spans: SpanRecord[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  feedback: TraceFeedback[];
}

export interface StartSpanOptions {
  type?: SpanType;
  input?: unknown;
  attributes?: Record<string, unknown>;
  metrics?: Record<string, number>;
  traceName?: string;
  traceMetadata?: Record<string, unknown>;
  tags?: string[];
}

export interface TraceExporter {
  export(trace: TraceDocument): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export interface TracePage {
  items: TraceDocument[];
  limit: number;
  scanned: number;
  hasMore: boolean;
  nextCursor?: string;
}

interface TraceState {
  id: string;
  name: string;
  rootSpanId: string;
  startedAt: string;
  startedNs: bigint;
  spans: Map<string, SpanRecord>;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

interface SpanContext { tracer: Tracer; trace: TraceState; spanId: string }

const active = new AsyncLocalStorage<SpanContext>();

export class ActiveSpan {
  readonly record: SpanRecord;
  private readonly tracer: Tracer;
  private readonly trace: TraceState;
  private readonly startedNs: bigint;
  private ended = false;

  constructor(tracer: Tracer, trace: TraceState, record: SpanRecord, startedNs: bigint) {
    this.tracer = tracer;
    this.trace = trace;
    this.record = record;
    this.startedNs = startedNs;
  }

  setInput(value: unknown): this { this.record.input = safeTraceData(value); return this; }
  setOutput(value: unknown): this { this.record.output = safeTraceData(value); return this; }
  setAttribute(key: string, value: unknown): this { this.record.attributes[key] = safeTraceData(value); return this; }
  setMetric(key: string, value: number): this {
    if (!Number.isFinite(value)) throw new Error(`Trace metric ${key} must be finite`);
    this.record.metrics[key] = value;
    return this;
  }
  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.record.events.push({ name, timestamp: new Date().toISOString(), ...(attributes ? { attributes: safeTraceData(attributes) as Record<string, unknown> } : {}) });
    return this;
  }
  recordError(error: unknown): this {
    const normalized = normalizeError(error);
    this.record.error = normalized;
    this.record.status = "error";
    this.addEvent("exception", { name: normalized.name, message: normalized.message });
    return this;
  }

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    return active.run({ tracer: this.tracer, trace: this.trace, spanId: this.record.id }, async () => fn());
  }

  async end(output?: unknown): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (output !== undefined) this.setOutput(output);
    if (this.record.status === "running") this.record.status = "ok";
    this.record.endedAt = new Date().toISOString();
    this.record.durationMs = Number(process.hrtime.bigint() - this.startedNs) / 1e6;
    if (this.record.id === this.trace.rootSpanId) await this.tracer.finishTrace(this.trace);
  }
}

export class Tracer {
  private readonly exporters: TraceExporter[];
  private readonly completed = new Map<string, TraceDocument>();

  constructor(exporters: TraceExporter[] = []) {
    this.exporters = exporters;
  }

  startSpan(name: string, opts: StartSpanOptions = {}): ActiveSpan {
    if (!name.trim()) throw new Error("Span name cannot be empty");
    const current = active.getStore();
    if (current && current.tracer !== this) throw new Error("Cannot nest spans from different Tracer instances in the same async context");
    const trace: TraceState = current?.trace ?? {
      id: newId("trace"),
      name: opts.traceName ?? name,
      rootSpanId: "",
      startedAt: new Date().toISOString(),
      startedNs: process.hrtime.bigint(),
      spans: new Map(),
      ...(opts.traceMetadata ? { metadata: safeTraceData(opts.traceMetadata) as Record<string, unknown> } : {}),
      ...(opts.tags ? { tags: [...opts.tags] } : {}),
    };
    const id = newId("span");
    if (!trace.rootSpanId) trace.rootSpanId = id;
    const startedNs = process.hrtime.bigint();
    const record: SpanRecord = {
      id,
      traceId: trace.id,
      ...(current ? { parentId: current.spanId } : {}),
      name,
      type: opts.type ?? "custom",
      status: "running",
      startedAt: new Date().toISOString(),
      ...(opts.input !== undefined ? { input: safeTraceData(opts.input) } : {}),
      attributes: opts.attributes ? safeTraceData(opts.attributes) as Record<string, unknown> : {},
      metrics: opts.metrics ? { ...opts.metrics } : {},
      events: [],
    };
    for (const [metric, value] of Object.entries(record.metrics)) if (!Number.isFinite(value)) throw new Error(`Trace metric ${metric} must be finite`);
    trace.spans.set(id, record);
    return new ActiveSpan(this, trace, record, startedNs);
  }

  async withSpan<T>(name: string, opts: StartSpanOptions, fn: (span: ActiveSpan) => T | Promise<T>): Promise<T> {
    const span = this.startSpan(name, opts);
    try {
      const output = await span.run(() => fn(span));
      span.setOutput(output);
      return output;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      await span.end();
    }
  }

  observe<Args extends unknown[], Result>(
    name: string,
    fn: (...args: Args) => Result | Promise<Result>,
    opts: Omit<StartSpanOptions, "input"> & { captureInput?: boolean; captureOutput?: boolean } = {},
  ): (...args: Args) => Promise<Result> {
    return async (...args: Args) => this.withSpan(name, { ...opts, ...(opts.captureInput === false ? {} : { input: args }) }, async (span) => {
      const result = await fn(...args);
      if (opts.captureOutput !== false) span.setOutput(result);
      return result;
    });
  }

  currentSpan(): SpanRecord | undefined {
    const current = active.getStore();
    return current?.tracer === this ? current.trace.spans.get(current.spanId) : undefined;
  }

  getTrace(id: string): TraceDocument | undefined { return this.completed.get(id); }
  listTraces(): TraceDocument[] { return [...this.completed.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }

  async finishTrace(trace: TraceState): Promise<void> {
    const root = trace.spans.get(trace.rootSpanId);
    if (!root?.endedAt) return;
    const endedAt = root.endedAt;
    const document: TraceDocument = {
      kind: "dry-run.trace",
      version: 1,
      id: trace.id,
      name: trace.name,
      status: [...trace.spans.values()].some((span) => span.status === "error") ? "error" : "ok",
      startedAt: trace.startedAt,
      endedAt,
      durationMs: Number(process.hrtime.bigint() - trace.startedNs) / 1e6,
      rootSpanId: trace.rootSpanId,
      spans: [...trace.spans.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      ...(trace.metadata ? { metadata: trace.metadata } : {}),
      ...(trace.tags ? { tags: trace.tags } : {}),
      feedback: [],
    };
    this.completed.set(document.id, document);
    await Promise.all(this.exporters.map((exporter) => exporter.export(document)));
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map((exporter) => exporter.shutdown?.()));
  }
}

export class InMemoryTraceExporter implements TraceExporter {
  readonly traces: TraceDocument[] = [];
  export(trace: TraceDocument): void { this.traces.push(structuredClone(trace)); }
}

export class TraceStore implements TraceExporter {
  readonly dir: string;
  constructor(dir = path.resolve(".dryrun/traces")) { this.dir = dir; ensurePrivateDirectory(dir); }
  file(id: string): string { if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("Invalid trace id"); return path.join(this.dir, `${id}.json`); }
  async export(trace: TraceDocument): Promise<void> {
    const file = this.file(trace.id);
    await withFileLock(file, () => atomicWriteJson(file, redactDeep(trace, true)));
  }
  load(id: string): TraceDocument { return validateTrace(readJsonFile(this.file(id))); }
  list(filter: { status?: "ok" | "error"; type?: SpanType; query?: string; tag?: string } = {}): TraceDocument[] {
    if (!existsSync(this.dir)) return [];
    const traces: TraceDocument[] = [];
    for (const file of readdirSync(this.dir).filter((name) => name.endsWith(".json"))) {
      try { traces.push(validateTrace(readJsonFile(path.join(this.dir, file)))); } catch { /* ignore invalid files */ }
    }
    return traces.filter((trace) => traceMatches(trace, filter)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  page(filter: { status?: "ok" | "error"; type?: SpanType; query?: string; tag?: string; limit?: number; cursor?: string; maxScan?: number } = {}): TracePage {
    const limit = boundedInteger(filter.limit ?? 100, 1, 500, "Trace page limit");
    const names = existsSync(this.dir) ? readdirSync(this.dir).filter((name) => name.endsWith(".json")).sort() : [];
    const after = decodeCursor(filter.cursor);
    let index = after ? names.findIndex((name) => name > after) : 0;
    if (index < 0) index = names.length;
    const filtered = Boolean(filter.status || filter.type || filter.query || filter.tag);
    const maxScan = boundedInteger(filter.maxScan ?? (filtered ? Math.max(200, limit * 20) : limit), limit, 5_000, "Trace page scan limit");
    const items: TraceDocument[] = [];
    let scanned = 0;
    let lastScanned: string | undefined;
    while (index < names.length && scanned < maxScan && items.length < limit) {
      const name = names[index++];
      lastScanned = name;
      scanned += 1;
      try {
        const trace = validateTrace(readJsonFile(path.join(this.dir, name)));
        if (traceMatches(trace, filter)) items.push(trace);
      } catch { /* Invalid files still advance the cursor. */ }
    }
    return {
      items,
      limit,
      scanned,
      hasMore: index < names.length,
      ...(lastScanned && index < names.length ? { nextCursor: encodeCursor(lastScanned) } : {}),
    };
  }
  async addFeedback(traceId: string, feedback: Omit<TraceFeedback, "id" | "createdAt">): Promise<TraceFeedback> {
    const file = this.file(traceId);
    return withFileLock(file, () => {
      const trace = this.load(traceId);
      if (feedback.spanId && !trace.spans.some((span) => span.id === feedback.spanId)) throw new Error(`Unknown span id: ${feedback.spanId}`);
      if (feedback.score != null && (!Number.isFinite(feedback.score) || feedback.score < 0 || feedback.score > 1)) throw new Error("Feedback score must be between 0 and 1");
      const record: TraceFeedback = { ...feedback, id: newId("feedback"), createdAt: new Date().toISOString() };
      trace.feedback.push(record);
      atomicWriteJson(file, redactDeep(trace, true));
      return record;
    });
  }
}

export const defaultTracer = new Tracer();

export function observe<Args extends unknown[], Result>(
  name: string,
  fn: (...args: Args) => Result | Promise<Result>,
  opts?: Parameters<Tracer["observe"]>[2],
): (...args: Args) => Promise<Result> {
  return defaultTracer.observe(name, fn, opts);
}

export function traceToTrajectory(trace: TraceDocument): Trajectory {
  const steps: Step[] = [];
  for (const span of trace.spans) {
    if (span.type === "llm") {
      const output = isRecord(span.output) ? span.output : {};
      steps.push({
        kind: "llm",
        response: typeof output.text === "string" ? output.text : typeof span.output === "string" ? span.output : undefined,
        durationMs: span.durationMs,
        ...(numberMetric(span, "costUsd") != null ? { costUsd: numberMetric(span, "costUsd") } : {}),
      });
    }
    if (span.type === "tool") {
      const call = toToolCall(span);
      steps.push({
        kind: "tool",
        toolCall: call,
        result: span.output,
        ...(span.error ? { error: span.error.message } : {}),
        durationMs: span.durationMs,
      });
    }
  }
  const root = trace.spans.find((span) => span.id === trace.rootSpanId);
  const output = typeof root?.output === "string" ? root.output : isRecord(root?.output) && typeof root.output.output === "string" ? root.output.output : JSON.stringify(root?.output ?? "");
  return { steps, output };
}

export function traceToOtlpJson(trace: TraceDocument): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "dry-run" } }] },
      scopeSpans: [{
        scope: { name: "@muratkomurcu/dry-run", version: DRY_RUN_VERSION },
        spans: trace.spans.map((span) => ({
          traceId: compactHex(trace.id, 32),
          spanId: compactHex(span.id, 16),
          ...(span.parentId ? { parentSpanId: compactHex(span.parentId, 16) } : {}),
          name: span.name,
          kind: 1,
          startTimeUnixNano: isoToNs(span.startedAt),
          endTimeUnixNano: isoToNs(span.endedAt ?? span.startedAt),
          attributes: [
            { key: "dryrun.span.type", value: { stringValue: span.type } },
            ...Object.entries(span.attributes).map(([key, value]) => ({ key, value: otlpValue(value) })),
          ],
          status: { code: span.status === "error" ? 2 : 1, ...(span.error ? { message: span.error.message } : {}) },
        })),
      }],
    }],
  };
}

function validateTrace(value: unknown): TraceDocument {
  if (!isRecord(value) || value.kind !== "dry-run.trace" || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.spans)) {
    throw new Error("Unsupported trace document");
  }
  return value as unknown as TraceDocument;
}

function traceMatches(trace: TraceDocument, filter: { status?: "ok" | "error"; type?: SpanType; query?: string; tag?: string }): boolean {
  if (filter.status && trace.status !== filter.status) return false;
  if (filter.type && !trace.spans.some((span) => span.type === filter.type)) return false;
  if (filter.tag && !trace.tags?.includes(filter.tag)) return false;
  const query = filter.query?.toLowerCase();
  return !query || `${trace.name} ${trace.spans.map((span) => span.name).join(" ")}`.toLowerCase().includes(query);
}

function encodeCursor(file: string): string { return Buffer.from(file, "utf8").toString("base64url"); }

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 512) throw new Error("Trace cursor is invalid");
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[a-zA-Z0-9_.-]{1,192}\.json$/.test(value)) throw new Error("Trace cursor is invalid");
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function toToolCall(span: SpanRecord): ToolCall {
  const input = isRecord(span.input) ? span.input : {};
  return {
    id: typeof input.id === "string" ? input.id : span.id,
    name: typeof input.name === "string" ? input.name : span.name,
    arguments: isRecord(input.arguments) ? input.arguments : input,
  };
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function safeTraceData(value: unknown): unknown {
  try { return redactDeep(JSON.parse(JSON.stringify(value)), true); }
  catch { return String(value); }
}

function numberMetric(span: SpanRecord, name: string): number | undefined {
  const value = span.metrics[name];
  return typeof value === "number" ? value : undefined;
}

function compactHex(value: string, length: number): string {
  const compact = Buffer.from(value).toString("hex");
  return compact.slice(0, length).padEnd(length, "0");
}

function isoToNs(value: string): string { return `${BigInt(Date.parse(value)) * 1_000_000n}`; }
function otlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: JSON.stringify(value) };
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
