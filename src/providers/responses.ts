import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from "../types.ts";
import { redactText } from "../cassette.ts";

export interface OpenAIResponsesOptions { apiKey?: string; baseURL?: string; model?: string }

export class OpenAIResponsesProvider implements LLMProvider {
  #apiKey: string;
  #baseURL: string;
  #model: string;
  constructor(options: OpenAIResponsesOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.#baseURL = (options.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.#model = options.model ?? process.env.DRYRUN_MODEL ?? "gpt-5-mini";
    if (!this.#apiKey) throw new Error("OpenAIResponsesProvider requires OPENAI_API_KEY or { apiKey }");
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.#baseURL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
      signal: request.signal,
      body: JSON.stringify({
        model: request.model || this.#model,
        input: request.messages.flatMap(toResponsesInput),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: "object" } })) } : {}),
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.topP != null ? { top_p: request.topP } : {}),
        ...(request.maxTokens != null ? { max_output_tokens: request.maxTokens } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI Responses API error ${response.status}: ${redactText((await response.text()).slice(0, 500))}`);
    const body = await response.json() as Record<string, any>;
    const output = Array.isArray(body.output) ? body.output : [];
    const toolCalls: ToolCall[] = output.filter((item: any) => item.type === "function_call").map((item: any) => ({
      id: String(item.call_id ?? item.id),
      name: String(item.name),
      arguments: parseArguments(item.arguments),
    }));
    const text = body.output_text ?? output.flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === "output_text").map((item: any) => item.text ?? "").join("");
    return {
      text: text || null,
      toolCalls,
      usage: body.usage ? {
        inputTokens: body.usage.input_tokens ?? 0,
        outputTokens: body.usage.output_tokens ?? 0,
        cachedInputTokens: body.usage.input_tokens_details?.cached_tokens,
        reasoningTokens: body.usage.output_tokens_details?.reasoning_tokens,
      } : undefined,
      finishReason: body.status,
      providerMetadata: { responseId: body.id },
    };
  }
}

function toResponsesInput(message: import("../types.ts").ChatMessage): Record<string, unknown>[] {
  if (message.role === "tool") {
    return [{ type: "function_call_output", call_id: message.toolCallId ?? "", output: message.content ?? "" }];
  }
  const items: Record<string, unknown>[] = [];
  if (message.content != null && message.content !== "") items.push({ role: message.role, content: message.content });
  for (const call of message.toolCalls ?? []) {
    items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
  }
  return items;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
