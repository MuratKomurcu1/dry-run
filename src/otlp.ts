import type { SpanEvent, SpanRecord, SpanType, TraceDocument } from "./tracing.ts";

export interface OtlpIngestResult { traces: TraceDocument[]; spans: number; rejectedSpans: number; errors: string[] }

export function decodeOtlpHttp(body: Uint8Array, contentType: string): unknown {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (type === "application/json") {
    try { return JSON.parse(new TextDecoder().decode(body)); } catch { throw new Error("OTLP JSON payload is invalid"); }
  }
  if (type === "application/x-protobuf" || type === "application/protobuf") return decodeExportTraceRequest(body);
  throw new Error("OTLP Content-Type must be application/json or application/x-protobuf");
}

export function otlpToDryRunTraces(payload: unknown, options: { receivedAt?: string; maxSpans?: number; maxTraces?: number } = {}): OtlpIngestResult {
  const receivedAt = options.receivedAt ?? new Date().toISOString(), maxSpans = boundedInt(options.maxSpans ?? 10_000, 1, 100_000, "OTLP maxSpans"), maxTraces = boundedInt(options.maxTraces ?? 500, 1, 5_000, "OTLP maxTraces");
  const root = asRecord(payload), resourceSpans = array(root.resourceSpans ?? root.resource_spans);
  const grouped = new Map<string, Array<{ span: Record<string, any>; resource: Record<string, unknown>; scope: Record<string, unknown> }>>();
  const errors: string[] = []; let seen = 0, rejected = 0;
  for (const resourceEntry of resourceSpans) {
    const resourceRecord = asRecord(resourceEntry), resource = attributes(asRecord(resourceRecord.resource).attributes), scopeSpans = array(resourceRecord.scopeSpans ?? resourceRecord.scope_spans ?? resourceRecord.instrumentationLibrarySpans);
    for (const scopeEntry of scopeSpans) {
      const scopeRecord = asRecord(scopeEntry), scope = asRecord(scopeRecord.scope ?? scopeRecord.instrumentationLibrary);
      for (const rawSpan of array(scopeRecord.spans)) {
        seen += 1;
        if (seen > maxSpans) throw new Error(`OTLP payload exceeds ${maxSpans} spans`);
        try {
          const span = asRecord(rawSpan), traceId = identifier(span.traceId ?? span.trace_id, 32, "traceId");
          grouped.set(traceId, [...(grouped.get(traceId) ?? []), { span, resource, scope }]);
          if (grouped.size > maxTraces) throw new Error(`OTLP payload exceeds ${maxTraces} traces`);
        } catch (error) { rejected += 1; if (errors.length < 20) errors.push(error instanceof Error ? error.message : String(error)); }
      }
    }
  }
  const traces = [...grouped.entries()].map(([traceId, entries]) => buildTrace(traceId, entries, receivedAt));
  return { traces, spans: seen - rejected, rejectedSpans: rejected, errors };
}

export function mergeOtlpTrace(existing: TraceDocument | undefined, incoming: TraceDocument): TraceDocument {
  if (!existing) return structuredClone(incoming);
  if (existing.id !== incoming.id) throw new Error("Cannot merge different OTLP trace ids");
  const spans = new Map(existing.spans.map((span) => [span.id, span]));
  for (const span of incoming.spans) spans.set(span.id, span);
  const ordered = [...spans.values()].toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
  const ids = new Set(ordered.map((span) => span.id));
  const root = ordered.find((span) => !span.parentId || !ids.has(span.parentId)) ?? ordered[0];
  const startedAt = ordered[0].startedAt, endedAt = ordered.map((span) => span.endedAt ?? span.startedAt).sort().at(-1)!;
  return {
    ...existing, ...incoming, name: incoming.name || existing.name, status: ordered.some((span) => span.status === "error") ? "error" : "ok",
    startedAt, endedAt, receivedAt: incoming.receivedAt ?? existing.receivedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    rootSpanId: root.id, spans: ordered, metadata: { ...existing.metadata, ...incoming.metadata }, tags: [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])], feedback: existing.feedback,
  };
}

function buildTrace(traceId: string, entries: Array<{ span: Record<string, any>; resource: Record<string, unknown>; scope: Record<string, unknown> }>, receivedAt: string): TraceDocument {
  const ids = new Set(entries.map(({ span }) => identifier(span.spanId ?? span.span_id, 16, "spanId"))), records = entries.map(({ span, resource, scope }) => buildSpan(traceId, span, resource, scope));
  const root = records.find((span) => !span.parentId || !ids.has(stripSpanPrefix(span.parentId))) ?? records.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  const startedAt = records.map((span) => span.startedAt).sort()[0], endedAt = records.map((span) => span.endedAt ?? span.startedAt).sort().at(-1)!;
  const rootEntry = entries.find(({ span }) => `otelspan_${identifier(span.spanId ?? span.span_id, 16, "spanId")}` === root.id) ?? entries[0];
  const resource = rootEntry.resource, rootAttrs = attributes(rootEntry.span.attributes);
  const name = text(rootAttrs["session.name"] ?? rootAttrs["openinference.trace.name"] ?? resource["service.name"] ?? root.name, "OTLP trace name", 512);
  const tags = stringList(rootAttrs["tag.tags"] ?? rootAttrs["openinference.tags"] ?? resource["deployment.environment.name"] ?? resource["deployment.environment"]);
  const metadata: Record<string, unknown> = {
    source: "otlp", "otel.trace_id": traceId,
    ...(resource["service.name"] != null ? { service: resource["service.name"] } : {}),
    ...(resource["service.version"] != null ? { release: resource["service.version"] } : {}),
    ...(resource["deployment.environment.name"] != null ? { environment: resource["deployment.environment.name"] } : resource["deployment.environment"] != null ? { environment: resource["deployment.environment"] } : {}),
  };
  return { kind: "dry-run.trace", version: 1, id: `otel_${traceId}`, name, status: records.some((span) => span.status === "error") ? "error" : "ok", startedAt, endedAt, receivedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)), rootSpanId: root.id, spans: records.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)), metadata, ...(tags.length ? { tags } : {}), feedback: [] };
}

function buildSpan(traceId: string, span: Record<string, any>, resource: Record<string, unknown>, scope: Record<string, unknown>): SpanRecord {
  const rawAttributes = attributes(span.attributes), spanId = identifier(span.spanId ?? span.span_id, 16, "spanId"), parent = optionalIdentifier(span.parentSpanId ?? span.parent_span_id, 16), startedAt = nanosToIso(span.startTimeUnixNano ?? span.start_time_unix_nano), endedAt = nanosToIso(span.endTimeUnixNano ?? span.end_time_unix_nano, startedAt), statusRecord = asRecord(span.status);
  const statusCode = Number(statusRecord.code ?? 0), exception = array(span.events).find((event) => String(asRecord(event).name).toLowerCase() === "exception"), exceptionAttrs = exception ? attributes(asRecord(exception).attributes) : {};
  const status: SpanRecord["status"] = statusCode === 2 || exception != null || rawAttributes["error.type"] != null ? "error" : "ok";
  const input = semanticValue(rawAttributes, "input"), output = semanticValue(rawAttributes, "output");
  const events: SpanEvent[] = array(span.events).map((event) => {
    const value = asRecord(event); return { name: text(value.name ?? "event", "OTLP event name", 512), timestamp: nanosToIso(value.timeUnixNano ?? value.time_unix_nano, startedAt), ...(array(value.attributes).length ? { attributes: attributes(value.attributes) } : {}) };
  });
  const metrics = numericMetrics(rawAttributes);
  return {
    id: `otelspan_${spanId}`, traceId: `otel_${traceId}`, ...(parent ? { parentId: `otelspan_${parent}` } : {}), name: text(span.name ?? "span", "OTLP span name", 512), type: semanticSpanType(rawAttributes, String(span.name ?? "")), status, startedAt, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
    attributes: { ...resourcePrefixed(resource), ...rawAttributes, "otel.scope.name": scope.name ?? "", "otel.span_id": spanId }, metrics, events,
    ...(status === "error" ? { error: { name: text(exceptionAttrs["exception.type"] ?? rawAttributes["error.type"] ?? "Error", "OTLP error name", 256), message: text(statusRecord.message ?? exceptionAttrs["exception.message"] ?? rawAttributes["error.message"] ?? "OTLP span failed", "OTLP error message", 4_096), ...(typeof exceptionAttrs["exception.stacktrace"] === "string" ? { stack: exceptionAttrs["exception.stacktrace"] } : {}) } } : {}),
  };
}

function semanticSpanType(attrs: Record<string, unknown>, name: string): SpanType {
  const kind = String(attrs["openinference.span.kind"] ?? attrs["dryrun.span.type"] ?? "").toLowerCase();
  if (["agent", "chain"].includes(kind)) return "agent";
  if (["llm", "embedding"].includes(kind) || /llm|chat|model|generation|embedding/i.test(name)) return "llm";
  if (kind === "tool" || attrs["gen_ai.tool.name"] != null || /tool/i.test(name)) return "tool";
  if (["retriever", "reranker"].includes(kind) || /retriev|rerank/i.test(name)) return "retriever";
  if (["evaluator", "guardrail"].includes(kind) || /scor|evaluat|guardrail/i.test(name)) return "scorer";
  if (kind === "task" || kind === "custom") return kind;
  return "custom";
}
function semanticValue(attrs: Record<string, unknown>, side: "input" | "output"): unknown {
  const value = attrs[`${side}.value`] ?? attrs[`openinference.${side}.value`] ?? attrs[`gen_ai.${side}.messages`] ?? attrs[`gen_ai.${side}.text`];
  const mime = String(attrs[`${side}.mime_type`] ?? attrs[`openinference.${side}.mime_type`] ?? "");
  if (typeof value === "string" && (mime.includes("json") || /^[\[{]/.test(value.trim()))) { try { return JSON.parse(value); } catch { return value; } }
  return value;
}
function numericMetrics(attrs: Record<string, unknown>): Record<string, number> {
  const mappings: Record<string, string[]> = { input_tokens: ["gen_ai.usage.input_tokens", "llm.token_count.prompt", "llm.token_count.input"], output_tokens: ["gen_ai.usage.output_tokens", "llm.token_count.completion", "llm.token_count.output"], total_tokens: ["gen_ai.usage.total_tokens", "llm.token_count.total"], costUsd: ["gen_ai.usage.cost", "llm.cost_usd"] }, result: Record<string, number> = {};
  for (const [target, sources] of Object.entries(mappings)) for (const source of sources) { const value = Number(attrs[source]); if (Number.isFinite(value)) { result[target] = value; break; } }
  if (result.total_tokens == null && (result.input_tokens != null || result.output_tokens != null)) result.total_tokens = (result.input_tokens ?? 0) + (result.output_tokens ?? 0);
  return result;
}
function resourcePrefixed(resource: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(resource).map(([key, value]) => [`resource.${key}`, value])); }

function decodeExportTraceRequest(input: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(input), resourceSpans: unknown[] = [];
  while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) resourceSpans.push(decodeResourceSpans(reader.message())); else reader.skip(wire); }
  return { resourceSpans };
}
function decodeResourceSpans(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = { scopeSpans: [] }; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) result.resource = decodeResource(reader.message()); else if (field === 2 && wire === 2) (result.scopeSpans as unknown[]).push(decodeScopeSpans(reader.message())); else if (field === 3 && wire === 2) result.schemaUrl = reader.string(); else reader.skip(wire); } return result; }
function decodeResource(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = { attributes: [] }; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) (result.attributes as unknown[]).push(decodeKeyValue(reader.message())); else reader.skip(wire); } return result; }
function decodeScopeSpans(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = { spans: [] }; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) result.scope = decodeScope(reader.message()); else if (field === 2 && wire === 2) (result.spans as unknown[]).push(decodeSpan(reader.message())); else if (field === 3 && wire === 2) result.schemaUrl = reader.string(); else reader.skip(wire); } return result; }
function decodeScope(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = { attributes: [] }; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) result.name = reader.string(); else if (field === 2 && wire === 2) result.version = reader.string(); else if (field === 3 && wire === 2) (result.attributes as unknown[]).push(decodeKeyValue(reader.message())); else reader.skip(wire); } return result; }
function decodeSpan(reader: ProtoReader): Record<string, unknown> {
  const result: Record<string, unknown> = { attributes: [], events: [] };
  while (!reader.end()) { const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) result.traceId = bytesHex(reader.bytes()); else if (field === 2 && wire === 2) result.spanId = bytesHex(reader.bytes()); else if (field === 4 && wire === 2) result.parentSpanId = bytesHex(reader.bytes()); else if (field === 5 && wire === 2) result.name = reader.string(); else if (field === 6 && wire === 0) result.kind = Number(reader.varint()); else if (field === 7 && wire === 1) result.startTimeUnixNano = reader.fixed64().toString(); else if (field === 8 && wire === 1) result.endTimeUnixNano = reader.fixed64().toString(); else if (field === 9 && wire === 2) (result.attributes as unknown[]).push(decodeKeyValue(reader.message())); else if (field === 11 && wire === 2) (result.events as unknown[]).push(decodeEvent(reader.message())); else if (field === 15 && wire === 2) result.status = decodeStatus(reader.message()); else reader.skip(wire);
  } return result;
}
function decodeEvent(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = { attributes: [] }; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 1) result.timeUnixNano = reader.fixed64().toString(); else if (field === 2 && wire === 2) result.name = reader.string(); else if (field === 3 && wire === 2) (result.attributes as unknown[]).push(decodeKeyValue(reader.message())); else reader.skip(wire); } return result; }
function decodeStatus(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = {}; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 2 && wire === 2) result.message = reader.string(); else if (field === 3 && wire === 0) result.code = Number(reader.varint()); else reader.skip(wire); } return result; }
function decodeKeyValue(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = {}; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) result.key = reader.string(); else if (field === 2 && wire === 2) result.value = decodeAnyValue(reader.message()); else reader.skip(wire); } return result; }
function decodeAnyValue(reader: ProtoReader): Record<string, unknown> { const result: Record<string, unknown> = {}; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) result.stringValue = reader.string(); else if (field === 2 && wire === 0) result.boolValue = reader.varint() !== 0n; else if (field === 3 && wire === 0) result.intValue = reader.signedVarint().toString(); else if (field === 4 && wire === 1) result.doubleValue = reader.double(); else if (field === 5 && wire === 2) result.arrayValue = decodeArrayValue(reader.message()); else if (field === 6 && wire === 2) result.kvlistValue = decodeKvList(reader.message()); else if (field === 7 && wire === 2) result.bytesValue = Buffer.from(reader.bytes()).toString("base64"); else reader.skip(wire); } return result; }
function decodeArrayValue(reader: ProtoReader): Record<string, unknown> { const values: unknown[] = []; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) values.push(decodeAnyValue(reader.message())); else reader.skip(wire); } return { values }; }
function decodeKvList(reader: ProtoReader): Record<string, unknown> { const values: unknown[] = []; while (!reader.end()) { const { field, wire } = reader.tag(); if (field === 1 && wire === 2) values.push(decodeKeyValue(reader.message())); else reader.skip(wire); } return { values }; }

class ProtoReader {
  private position = 0;
  private readonly input: Uint8Array;
  constructor(input: Uint8Array) { this.input = input; }
  end(): boolean { return this.position >= this.input.length; }
  tag(): { field: number; wire: number } { const value = Number(this.varint()); return { field: value >>> 3, wire: value & 7 }; }
  varint(): bigint { let value = 0n, shift = 0n; for (let count = 0; count < 10; count += 1) { if (this.end()) throw new Error("Truncated OTLP protobuf varint"); const byte = this.input[this.position++]; value |= BigInt(byte & 0x7f) << shift; if (!(byte & 0x80)) return value; shift += 7n; } throw new Error("Invalid OTLP protobuf varint"); }
  signedVarint(): bigint { const value = this.varint(); return BigInt.asIntN(64, value); }
  bytes(): Uint8Array { const length = Number(this.varint()); if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.input.length) throw new Error("Truncated OTLP protobuf field"); const result = this.input.subarray(this.position, this.position + length); this.position += length; return result; }
  string(): string { return new TextDecoder().decode(this.bytes()); }
  message(): ProtoReader { return new ProtoReader(this.bytes()); }
  fixed64(): bigint { if (this.position + 8 > this.input.length) throw new Error("Truncated OTLP fixed64"); let result = 0n; for (let index = 0; index < 8; index += 1) result |= BigInt(this.input[this.position++]) << BigInt(index * 8); return result; }
  double(): number { if (this.position + 8 > this.input.length) throw new Error("Truncated OTLP double"); const view = new DataView(this.input.buffer, this.input.byteOffset + this.position, 8); const value = view.getFloat64(0, true); this.position += 8; return value; }
  skip(wire: number): void { if (wire === 0) { this.varint(); return; } if (wire === 1) { this.advance(8); return; } if (wire === 2) { this.bytes(); return; } if (wire === 5) { this.advance(4); return; } throw new Error(`Unsupported OTLP protobuf wire type ${wire}`); }
  private advance(length: number): void { if (this.position + length > this.input.length) throw new Error("Truncated OTLP protobuf field"); this.position += length; }
}

function attributes(value: unknown): Record<string, unknown> { if (!Array.isArray(value)) return isRecord(value) ? structuredClone(value) : {}; const result: Record<string, unknown> = {}; for (const raw of value) { const item = asRecord(raw); if (typeof item.key === "string") result[item.key] = anyValue(item.value); } return result; }
function anyValue(value: unknown): unknown { if (!isRecord(value)) return value; for (const key of ["stringValue", "boolValue", "doubleValue", "intValue", "bytesValue"]) if (key in value) return key === "intValue" ? safeNumber(value[key]) : value[key]; const arrayValue = asRecord(value.arrayValue); if (Array.isArray(arrayValue.values)) return arrayValue.values.map(anyValue); const kvlist = asRecord(value.kvlistValue); if (Array.isArray(kvlist.values)) return attributes(kvlist.values); return value; }
function identifier(value: unknown, expectedLength: number, label: string): string { const result = bytesHex(value).toLowerCase(); if (!/^[a-f0-9]+$/.test(result) || result.length !== expectedLength || /^0+$/.test(result)) throw new Error(`OTLP ${label} must be ${expectedLength / 2} non-zero bytes`); return result; }
function optionalIdentifier(value: unknown, expectedLength: number): string | undefined { if (value == null || value === "" || value instanceof Uint8Array && !value.length) return undefined; const result = bytesHex(value).toLowerCase(); if (/^0+$/.test(result)) return undefined; return identifier(result, expectedLength, "parentSpanId"); }
function bytesHex(value: unknown): string { if (typeof value === "string") return value; if (value instanceof Uint8Array) return Buffer.from(value).toString("hex"); if (Array.isArray(value)) return Buffer.from(value).toString("hex"); return ""; }
function stripSpanPrefix(value: string): string { return value.startsWith("otelspan_") ? value.slice(9) : value; }
function nanosToIso(value: unknown, fallback?: string): string { try { const nanos = typeof value === "string" ? BigInt(value) : typeof value === "bigint" ? value : Array.isArray(value) ? (BigInt(Number(value[1]) >>> 0) << 32n) | BigInt(Number(value[0]) >>> 0) : BigInt(Math.trunc(Number(value))); const millis = Number(nanos / 1_000_000n); if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString(); } catch { /* validated fallback below */ } if (fallback) return fallback; throw new Error("OTLP span timestamp is invalid"); }
function stringList(value: unknown): string[] { const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value == null ? [] : [String(value)]; return [...new Set(values.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 100); }
function safeNumber(value: unknown): unknown { const number = Number(value); return Number.isSafeInteger(number) ? number : String(value); }
function text(value: unknown, label: string, maximum: number): string { const result = String(value ?? "").trim(); if (!result || result.length > maximum) throw new Error(`${label} must contain 1-${maximum} characters`); return result; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asRecord(value: unknown): Record<string, any> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedInt(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`); return value; }
