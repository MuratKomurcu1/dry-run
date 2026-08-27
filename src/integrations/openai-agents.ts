import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TestAgent, ToolCall, Trajectory } from "../types.ts";
import { redactDeep } from "../cassette.ts";

export interface OpenAIAgentsResultLike {
  finalOutput?: unknown;
  final_output?: unknown;
  newItems?: unknown[];
  new_items?: unknown[];
  history?: unknown[];
}

export function openAIAgentsAgent(
  run: (input: string, options?: { signal?: AbortSignal }) => Promise<OpenAIAgentsResultLike>,
): TestAgent {
  return async (input, context) => trajectoryFromOpenAIAgents(await run(input, { signal: context?.signal }));
}

export function trajectoryFromOpenAIAgents(result: OpenAIAgentsResultLike): Trajectory {
  const items = result.newItems ?? result.new_items ?? result.history ?? [];
  const steps: Trajectory["steps"] = [];
  let output = "";
  for (const item of items as any[]) {
    const raw = item?.rawItem ?? item?.raw_item ?? item;
    const type = String(item?.type ?? raw?.type ?? "").toLowerCase();
    if (isToolOutput(type, raw)) {
      const id = callId(raw, item);
      const resultValue = item?.output ?? raw?.output ?? raw?.result;
      const previous = [...steps].reverse().find((step) => step.kind === "tool" && step.toolCall && (step.toolCall.id === id || (!id && step.toolCall.name === toolName(raw, item))));
      if (previous) previous.result = resultValue;
      else steps.push({ kind: "tool", toolCall: { id: id || `call-${steps.length}`, name: toolName(raw, item), arguments: {} }, result: resultValue });
      continue;
    }
    if (isToolCall(type, raw)) {
      steps.push({ kind: "tool", toolCall: normalizeToolCall(raw, item, steps.length) });
      if (raw?.output !== undefined) steps.at(-1)!.result = raw.output;
      continue;
    }
    if (isMessageOutput(type, raw)) {
      const text = assistantText(raw?.content ?? item?.content ?? item?.output);
      if (text) { steps.push({ kind: "llm", response: text }); output = text; }
    }
  }
  const final = result.finalOutput ?? result.final_output;
  if (final != null) output = typeof final === "string" ? final : JSON.stringify(final);
  return { steps, output };
}

export interface DryRunTraceProcessorOptions { file: string }

export function createDryRunTraceProcessor(options: DryRunTraceProcessorOptions) {
  const traces: unknown[] = [];
  const spans: unknown[] = [];
  const persist = () => {
    mkdirSync(path.dirname(path.resolve(options.file)), { recursive: true });
    writeFileSync(options.file, `${JSON.stringify({ resourceSpans: [], traces, spans }, null, 2)}\n`, { mode: 0o600 });
  };
  return {
    async onTraceStart(_trace: unknown) { /* capture completed traces only */ },
    async onTraceEnd(trace: unknown) { traces.push(serialize(trace)); persist(); },
    async onSpanStart(_span: unknown) { /* capture completed spans only */ },
    async onSpanEnd(span: unknown) { spans.push(serialize(span)); persist(); },
    async forceFlush() { persist(); },
    async shutdown() { persist(); },
  };
}

function serialize(value: any): unknown {
  if (typeof value?.toJSON === "function") return redactDeep(value.toJSON(), true);
  if (value?.spanData) return redactDeep(value.spanData, true);
  try { return redactDeep(structuredClone(value), true); }
  catch { return redactDeep({ name: value?.name, type: value?.type, data: value?.data }, true); }
}

function isMessageOutput(type: string, raw: any): boolean {
  return type.includes("message_output") || raw?.role === "assistant" || raw?.type === "message";
}

function isToolCall(type: string, raw: any): boolean {
  return (type.includes("tool_call") && !type.includes("output")) || ["function_call", "hosted_tool_call", "computer_call", "shell_call", "apply_patch_call", "program"].includes(raw?.type);
}

function isToolOutput(type: string, raw: any): boolean {
  return type.includes("tool_call_output") || ["function_call_result", "computer_call_result", "shell_call_output", "apply_patch_call_output", "program_output"].includes(raw?.type);
}

function normalizeToolCall(raw: any, item: any, index: number): ToolCall {
  let args = raw?.arguments ?? raw?.input ?? raw?.action ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); }
    catch { args = { value: args }; }
  }
  return {
    id: callId(raw, item) || `call-${index}`,
    name: toolName(raw, item),
    arguments: args && typeof args === "object" && !Array.isArray(args) ? args : { value: args },
  };
}

function callId(raw: any, item: any): string {
  return String(raw?.callId ?? raw?.call_id ?? item?.callId ?? item?.call_id ?? raw?.id ?? "");
}

function toolName(raw: any, item: any): string {
  return String(raw?.name ?? item?.name ?? raw?.type ?? item?.type ?? "tool");
}

function assistantText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value);
  return value.map((part: any) => {
    if (typeof part === "string") return part;
    if (part?.type === "output_text" || part?.type === "text") return part.text ?? "";
    if (part?.type === "refusal") return part.refusal ?? "";
    return "";
  }).join("");
}
