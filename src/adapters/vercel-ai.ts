import type { LLMProvider, ChatMessage, ToolDef } from "../types.ts";

export interface VercelAIModelOptions {
  provider: string;
  modelId: string;
}

type AnyRecord = Record<string, any>;

export function vercelAIModel(
  llm: LLMProvider,
  opts: { provider?: string; modelId?: string } = {},
): AnyRecord {
  const self = {
    specificationVersion: "v4",
    provider: opts.provider ?? "dry-run.mock",
    modelId: opts.modelId ?? "dry-run",

    async doGenerate(options: AnyRecord): Promise<AnyRecord> {
      const { messages, tools } = fromV4Prompt(options);
      const res = await llm.chat({ model: self.modelId, messages, tools });
      return toGenerateResult(res);
    },

    async doStream(options: AnyRecord): Promise<AnyRecord> {
      const { messages, tools } = fromV4Prompt(options);
      const response = await llm.chat({ model: self.modelId, messages, tools });
      const result = toGenerateResult(response);
      const chunks: AnyRecord[] = [{ type: "stream-start", warnings: [] }];
      const events = response.streamEvents?.length
        ? response.streamEvents
        : [
            ...(response.text ? [{ type: "text-delta" as const, textDelta: response.text, offsetMs: undefined }] : []),
            ...response.toolCalls.map((toolCall) => ({ type: "tool-call" as const, toolCall, offsetMs: undefined })),
          ];
      let textOpen = false;
      const textId = "txt-0";
      let previousOffset = 0;
      for (const event of events) {
        const delayMs = event.offsetMs == null ? undefined : Math.max(0, event.offsetMs - previousOffset);
        if (event.offsetMs != null) previousOffset = event.offsetMs;
        if (event.type === "text-delta" && event.textDelta != null) {
          if (!textOpen) { chunks.push({ type: "text-start", id: textId }); textOpen = true; }
          chunks.push({ type: "text-delta", id: textId, delta: event.textDelta, _delayMs: delayMs });
        } else if (event.type === "tool-call" && event.toolCall) {
          if (textOpen) { chunks.push({ type: "text-end", id: textId }); textOpen = false; }
          chunks.push({ type: "tool-call", toolCallId: event.toolCall.id, toolName: event.toolCall.name, input: JSON.stringify(event.toolCall.arguments), _delayMs: delayMs });
        }
      }
      if (textOpen) chunks.push({ type: "text-end", id: textId });

      chunks.push({
        type: "finish",
        usage: result.usage,
        finishReason: result.finishReason,
      });

      const encoder = new TextEncoder();
      let i = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          if (i < chunks.length) {
            const chunk = chunks[i++];
            if (chunk._delayMs) await new Promise((resolve) => setTimeout(resolve, chunk._delayMs));
            delete chunk._delayMs;
            controller.enqueue(chunk);
          }
          else controller.close();
        },
      });
      void encoder;
      return { stream };
    },
  };

  return self;
}

function toGenerateResult(res: import("../types.ts").ChatResponse): AnyRecord {
  const content: AnyRecord[] = [];
  if (res.text) content.push({ type: "text", text: res.text });
  for (const call of res.toolCalls) content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.arguments) });
  const reason = res.finishReason ?? (res.toolCalls.length ? "tool-calls" : "stop");
  return { content, finishReason: { unified: reason, raw: reason }, usage: toV4Usage(res.usage), warnings: [] };
}

function fromV4Prompt(options: AnyRecord): {
  messages: ChatMessage[];
  tools?: ToolDef[];
} {
  const messages: ChatMessage[] = [];

  for (const msg of options.prompt ?? []) {
    if (msg.role === "system") {
      messages.push({ role: "system", content: msg.content });
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: joinText(msg.content) });
    } else if (msg.role === "assistant") {
      const toolCalls = (msg.content ?? [])
        .filter((p: AnyRecord) => p.type === "tool-call")
        .map((p: AnyRecord) => ({
          id: p.toolCallId,
          name: p.toolName,
          arguments: normalizeArgs(p.input),
        }));
      messages.push({
        role: "assistant",
        content: joinText(msg.content) || null,
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    } else if (msg.role === "tool") {
      for (const part of msg.content ?? []) {
        messages.push({
          role: "tool",
          content: stringifyResult(part.output ?? part.result ?? part.content ?? ""),
          toolCallId: part.toolCallId,
          name: part.toolName,
        });
      }
    }
  }

  const v4Tools = (options.tools ?? []).filter(
    (t: AnyRecord) => t?.type === "function",
  );
  const tools: ToolDef[] | undefined = v4Tools.length
    ? v4Tools.map((t: AnyRecord) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }))
    : undefined;

  return { messages, tools };
}

function joinText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: AnyRecord) => p.type === "text")
    .map((p: AnyRecord) => p.text ?? "")
    .join("");
}

function normalizeArgs(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof input === "object" && input !== null ? (input as AnyRecord) : {};
}

function stringifyResult(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

function toV4Usage(usage?: { inputTokens: number; outputTokens: number }): AnyRecord {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  return {
    inputTokens: {
      total: input,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: output,
      text: undefined,
      reasoning: undefined,
      cacheWrite: undefined,
    },
  };
}
