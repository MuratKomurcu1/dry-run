import type { ChatRequest, ChatResponse, LLMProvider } from "../types.ts";
import { redactText } from "../cassette.ts";

export interface HttpProviderOptions {
  url: string;
  headers?: Record<string, string>;
  method?: "POST" | "PUT";
  buildBody?: (request: ChatRequest) => unknown;
  parseResponse?: (body: unknown, response: Response) => ChatResponse | Promise<ChatResponse>;
}

export class HttpProvider implements LLMProvider {
  private readonly options: HttpProviderOptions;
  constructor(options: HttpProviderOptions) { this.options = options; }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { signal: _signal, ...serializableRequest } = request;
    const response = await fetch(this.options.url, {
      method: this.options.method ?? "POST",
      headers: { "content-type": "application/json", ...this.options.headers },
      body: JSON.stringify(this.options.buildBody?.(request) ?? serializableRequest),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`HTTP provider error ${response.status}: ${redactText((await response.text()).slice(0, 500))}`);
    const body = await response.json();
    if (this.options.parseResponse) return this.options.parseResponse(body, response);
    return normalizeResponse(body);
  }
}

function normalizeResponse(value: unknown): ChatResponse {
  if (!value || typeof value !== "object") throw new Error("HTTP provider returned a non-object response");
  const body = value as Record<string, any>;
  const text = body.text ?? body.output ?? body.message?.content ?? null;
  const calls = body.toolCalls ?? body.tool_calls ?? [];
  return {
    text: typeof text === "string" ? text : text == null ? null : JSON.stringify(text),
    toolCalls: Array.isArray(calls) ? calls.map((call: any) => ({
      id: String(call.id ?? call.toolCallId ?? call.tool_call_id ?? "call"),
      name: String(call.name ?? call.toolName ?? call.function?.name ?? "tool"),
      arguments: normalizeArguments(call.arguments ?? call.input ?? call.function?.arguments),
    })) : [],
    usage: body.usage,
    costUsd: body.costUsd ?? body.cost_usd,
    finishReason: body.finishReason ?? body.finish_reason,
  };
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
