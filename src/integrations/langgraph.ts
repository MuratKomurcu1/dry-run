import type { TestAgent, ToolCall, Trajectory } from "../types.ts";

interface LangGraphLike {
  invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
}

export interface LangGraphAdapterOptions {
  input?: (text: string) => unknown;
  output?: (result: unknown) => unknown[];
  config?: Record<string, unknown>;
}

export function langGraphAgent(graph: LangGraphLike, options: LangGraphAdapterOptions = {}): TestAgent {
  return async (input, context) => {
    const result = await graph.invoke(options.input?.(input) ?? { messages: [{ role: "user", content: input }] }, {
      ...options.config,
      signal: context?.signal,
    });
    return trajectoryFromLangGraph(options.output?.(result) ?? extractMessages(result));
  };
}

export function trajectoryFromLangGraph(value: unknown): Trajectory {
  const messages = Array.isArray(value) ? value : extractMessages(value);
  const steps: Trajectory["steps"] = [];
  let output = "";
  for (const message of messages as any[]) {
    const type = String(message?.type ?? message?._getType?.() ?? message?.role ?? "").toLowerCase();
    const calls = message?.tool_calls ?? message?.toolCalls ?? message?.additional_kwargs?.tool_calls ?? [];
    if (type.includes("ai") || type === "assistant") {
      const text = contentText(message?.content);
      steps.push({ kind: "llm", response: text || undefined });
      if (text) output = text;
      for (const raw of calls) {
        const call = normalizeToolCall(raw);
        steps.push({ kind: "tool", toolCall: call });
      }
    } else if (type.includes("tool") || type === "function") {
      const name = String(message?.name ?? message?.tool_name ?? "tool");
      const id = String(message?.tool_call_id ?? message?.toolCallId ?? `tool-${steps.length}`);
      const previous = [...steps].reverse().find((step) => step.kind === "tool" && step.toolCall?.id === id);
      if (previous) previous.result = message?.content;
      else steps.push({ kind: "tool", toolCall: { id, name, arguments: {} }, result: message?.content });
    }
  }
  return { steps, output };
}

function extractMessages(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, any>;
    if (Array.isArray(record.messages)) return record.messages;
    if (Array.isArray(record.values?.messages)) return record.values.messages;
  }
  return [];
}

function normalizeToolCall(value: any): ToolCall {
  const fn = value?.function ?? value;
  let args = fn?.args ?? fn?.arguments ?? value?.input ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  return {
    id: String(value?.id ?? value?.tool_call_id ?? `call-${Math.random().toString(16).slice(2)}`),
    name: String(fn?.name ?? value?.toolName ?? "tool"),
    arguments: args && typeof args === "object" ? args : {},
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part: any) => part?.type === "text" || typeof part === "string").map((part: any) => typeof part === "string" ? part : part.text ?? "").join("");
  return content == null ? "" : JSON.stringify(content);
}
