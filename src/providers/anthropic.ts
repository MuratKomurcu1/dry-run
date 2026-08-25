import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from "../types.ts";
import { redactText } from "../cassette.ts";

export interface AnthropicOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
}

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

interface AnthropicResponseBody {
  content: Block[];
  usage?: { input_tokens: number; output_tokens: number };
}

interface OutgoingMessage {
  role: "user" | "assistant";
  content: unknown;
}

export class AnthropicProvider implements LLMProvider {
  #apiKey: string;
  #baseURL: string;
  #model: string;
  #maxTokens: number;

  constructor(opts: AnthropicOptions = {}) {
    this.#apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.#baseURL = (
      opts.baseURL ??
      process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com"
    ).replace(/\/+$/, "");
    this.#model = opts.model ?? process.env.DRYRUN_MODEL ?? "claude-sonnet-4-5";
    this.#maxTokens = opts.maxTokens ?? 4096;
    if (!this.#apiKey) {
      throw new Error(
        "AnthropicProvider requires an API key. Set ANTHROPIC_API_KEY or pass { apiKey }.",
      );
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.#baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(this.#toBody(req)),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${redactText(text.slice(0, 500))}`);
    }

    const data = (await res.json()) as AnthropicResponseBody;

    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    const toolCalls: ToolCall[] = data.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id!,
        name: b.name!,
        arguments: b.input ?? {},
      }));

    return {
      text: text || null,
      toolCalls,
      usage: data.usage
        ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
        : undefined,
    };
  }

  #toBody(req: ChatRequest) {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .filter(Boolean)
      .join("\n");

    return {
      model: req.model || this.#model,
      max_tokens: this.#maxTokens,
      ...(system ? { system } : {}),
      messages: req.messages.filter((m) => m.role !== "system").map(toAnthropicMessage),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              input_schema: t.parameters ?? { type: "object", properties: {} },
            })),
          }
        : {}),
    };
  }
}

function toAnthropicMessage(m: ChatMessage): OutgoingMessage {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content ?? "",
        },
      ],
    };
  }

  if (m.role === "assistant" && m.toolCalls?.length) {
    const blocks: Block[] = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const c of m.toolCalls) {
      blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
    }
    return { role: "assistant", content: blocks };
  }

  return { role: m.role as "user" | "assistant", content: m.content ?? "" };
}
