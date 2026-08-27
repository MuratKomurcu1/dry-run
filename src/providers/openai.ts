import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "../types.ts";
import { redactText } from "../cassette.ts";
import { trimTrailingSlashes } from "../safe-text.ts";

export interface OpenAIOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export class OpenAIProvider implements LLMProvider {
  #apiKey: string;
  #baseURL: string;
  #model: string;

  constructor(opts: OpenAIOptions = {}) {
    this.#apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.#baseURL = trimTrailingSlashes(
      opts.baseURL ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1"
    );
    this.#model =
      opts.model ?? process.env.DRYRUN_MODEL ?? "gpt-4o-mini";
    if (!this.#apiKey) {
      throw new Error(
        "OpenAIProvider requires an API key. Set OPENAI_API_KEY or pass { apiKey }.",
      );
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: req.model || this.#model,
      messages: req.messages.map(toOpenAIMessage),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description ?? "",
                parameters: t.parameters ?? { type: "object", properties: {} },
              },
            })),
          }
        : {}),
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.topP != null ? { top_p: req.topP } : {}),
      ...(req.maxTokens != null ? { max_completion_tokens: req.maxTokens } : {}),
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(req.metadata ? { metadata: req.metadata } : {}),
    };

    const res = await fetch(`${this.#baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM API error ${res.status}: ${redactText(text.slice(0, 500))}`);
    }

    const data = (await res.json()) as {
      choices: { message: OpenAIMessage; finish_reason?: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
    };

    const msg = data.choices[0]?.message;
    if (!msg) throw new Error("LLM API returned no message");

    return {
      text: msg.content,
      toolCalls: (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeJson(tc.function.arguments),
      })),
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
          }
        : undefined,
      finishReason: data.choices[0]?.finish_reason,
    };
  }
}

function toOpenAIMessage(m: ChatMessage): OpenAIMessage {
  const out: OpenAIMessage = { role: m.role, content: m.content };
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
  }
  if (m.role === "tool") {
    out.tool_call_id = m.toolCallId;
    out.name = m.name;
    out.content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null);
  }
  return out;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
}

export function toToolCalls(calls: ToolCall[] | undefined): ToolCall[] {
  return calls ?? [];
}
