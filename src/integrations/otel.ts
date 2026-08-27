import type { CassetteDocument, Interaction } from "../cassette.ts";
import { createDocument } from "../cassette.ts";
import type { ChatMessage, ToolCall, Trajectory } from "../types.ts";

interface FlatSpan { name: string; attributes: Record<string, unknown>; start?: number; end?: number }

export function traceToTrajectory(input: unknown): Trajectory {
  const spans = flattenSpans(input).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const steps: Trajectory["steps"] = [];
  let output = "";
  for (const span of spans) {
    const attrs = span.attributes;
    const toolName = stringAttr(attrs, "gen_ai.tool.name", "tool.name", "tool_name");
    const isTool = Boolean(toolName) || /tool/i.test(span.name);
    if (isTool) {
      const args = jsonAttr(attrs, "gen_ai.tool.call.arguments", "tool.arguments", "tool.input") ?? {};
      const result = jsonAttr(attrs, "gen_ai.tool.call.result", "tool.result", "tool.output");
      const call: ToolCall = { id: stringAttr(attrs, "gen_ai.tool.call.id", "tool.call.id") ?? `tool-${steps.length}`, name: toolName ?? span.name, arguments: asRecord(args) };
      steps.push({ kind: "tool", toolCall: call, result, error: stringAttr(attrs, "error.message"), durationMs: duration(span) });
      continue;
    }
    if (/llm|chat|model|generation|response/i.test(span.name) || hasAny(attrs, ["gen_ai.response.model", "gen_ai.output.text", "llm.output"])) {
      const text = stringAttr(attrs, "gen_ai.output.text", "llm.output", "output.value") ?? extractMessageText(jsonAttr(attrs, "gen_ai.output.messages"));
      if (text) output = text;
      steps.push({
        kind: "llm",
        response: text || undefined,
        durationMs: duration(span),
        usage: tokenUsage(attrs),
        costUsd: numberAttr(attrs, "gen_ai.usage.cost", "llm.cost_usd"),
      });
    }
  }
  return { steps, output };
}

export function traceToCassette(input: unknown, name = "otel-import"): CassetteDocument {
  const spans = flattenSpans(input).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const interactions: Interaction[] = [];
  for (const span of spans) {
    const attrs = span.attributes;
    if (!/llm|chat|model|generation|response/i.test(span.name) && !hasAny(attrs, ["gen_ai.request.model", "gen_ai.response.model"])) continue;
    const messages = parseMessages(jsonAttr(attrs, "gen_ai.input.messages", "llm.input_messages", "input.value"));
    const text = stringAttr(attrs, "gen_ai.output.text", "llm.output", "output.value") ?? extractMessageText(jsonAttr(attrs, "gen_ai.output.messages"));
    const calls = parseToolCalls(jsonAttr(attrs, "gen_ai.output.tool_calls", "llm.tool_calls"));
    interactions.push({
      request: {
        model: stringAttr(attrs, "gen_ai.request.model", "llm.request.model", "gen_ai.response.model") ?? "",
        messages: messages.length ? messages : [{ role: "user", content: stringAttr(attrs, "gen_ai.input.text", "llm.input") ?? "" }],
      },
      response: {
        text: text || null,
        toolCalls: calls,
        usage: tokenUsage(attrs),
        costUsd: numberAttr(attrs, "gen_ai.usage.cost", "llm.cost_usd"),
      },
    });
  }
  if (!interactions.length) throw new Error("No LLM spans with importable request/response data were found");
  return createDocument(name, interactions, { matching: "canonical", source: { type: "opentelemetry" } });
}

function flattenSpans(input: unknown): FlatSpan[] {
  const root = input as any;
  const raw = [
    ...(Array.isArray(root?.spans) ? root.spans : []),
    ...(Array.isArray(root?.data) ? root.data.flatMap((trace: any) => trace.spans ?? []) : []),
    ...(Array.isArray(root?.resourceSpans) ? root.resourceSpans.flatMap((resource: any) => (resource.scopeSpans ?? resource.instrumentationLibrarySpans ?? []).flatMap((scope: any) => scope.spans ?? [])) : []),
  ];
  return raw.map((span: any) => ({
    name: String(span.name ?? span.operationName ?? span.spanData?.name ?? span.type ?? "span"),
    attributes: attributes(span.attributes ?? span.tags ?? span.spanData?.data ?? span.data ?? {}),
    start: numericTime(span.startTimeUnixNano ?? span.startTime ?? span.start_time),
    end: numericTime(span.endTimeUnixNano ?? span.endTime ?? span.end_time),
  }));
}

function attributes(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return Object.fromEntries(value.map((item: any) => [item.key, otelValue(item.value ?? item)]));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, otelValue(child)])) : {};
}

function otelValue(value: any): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue", "bytesValue"]) if (key in value) return value[key];
  if (value.arrayValue?.values) return value.arrayValue.values.map(otelValue);
  if (value.kvlistValue?.values) return Object.fromEntries(value.kvlistValue.values.map((item: any) => [item.key, otelValue(item.value)]));
  return value;
}

function stringAttr(attrs: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (attrs[key] != null) return typeof attrs[key] === "string" ? attrs[key] as string : JSON.stringify(attrs[key]);
  return undefined;
}
function numberAttr(attrs: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) { const value = Number(attrs[key]); if (Number.isFinite(value)) return value; }
  return undefined;
}
function jsonAttr(attrs: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (attrs[key] != null) { const value = attrs[key]; if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
  return undefined;
}
function hasAny(attrs: Record<string, unknown>, keys: string[]): boolean { return keys.some((key) => key in attrs); }
function duration(span: FlatSpan): number | undefined { return span.start != null && span.end != null ? Math.max(0, Math.round(span.end - span.start)) : undefined; }
function numericTime(value: unknown): number | undefined { const number = Number(value); if (!Number.isFinite(number)) return undefined; return number > 1e15 ? number / 1e6 : number; }

function tokenUsage(attrs: Record<string, unknown>) {
  const inputTokens = numberAttr(attrs, "gen_ai.usage.input_tokens", "llm.token_count.prompt", "input_tokens");
  const outputTokens = numberAttr(attrs, "gen_ai.usage.output_tokens", "llm.token_count.completion", "output_tokens");
  return inputTokens != null || outputTokens != null ? { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 } : undefined;
}
function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object").map((item: any) => ({ role: ["system", "user", "assistant", "tool"].includes(item.role) ? item.role : "user", content: typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "") }));
}
function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((call: any, index) => ({ id: String(call.id ?? `call-${index}`), name: String(call.name ?? call.function?.name ?? "tool"), arguments: asRecord(typeof call.arguments === "string" ? safeParse(call.arguments) : call.arguments ?? call.function?.arguments) }));
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeParse(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function extractMessageText(value: unknown): string { return Array.isArray(value) ? value.map((item: any) => typeof item?.content === "string" ? item.content : "").join("") : ""; }
