import { randomUUID } from "node:crypto";
import type { TestAgent, Trajectory } from "../types.ts";
import { redactText } from "../cassette.ts";

export interface A2AAgentOptions {
  url: string;
  headers?: Record<string, string>;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export function a2aAgent(options: A2AAgentOptions): TestAgent {
  return async (input, context): Promise<Trajectory> => {
    const started = performance.now();
    const response = await fetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      signal: context?.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "message/send",
        params: {
          message: {
            role: "user",
            messageId: randomUUID(),
            ...(options.contextId ? { contextId: options.contextId } : {}),
            parts: [{ kind: "text", text: input }],
            ...(options.metadata ? { metadata: options.metadata } : {}),
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`A2A endpoint error ${response.status}: ${redactText((await response.text()).slice(0, 500))}`);
    const body = await response.json() as Record<string, any>;
    if (body.error) throw new Error(`A2A JSON-RPC error ${body.error.code}: ${redactText(String(body.error.message ?? "unknown"))}`);
    const output = extractText(body.result);
    return { steps: [{ kind: "llm", response: output, durationMs: Math.round(performance.now() - started) }], output };
  };
}

function extractText(result: any): string {
  const candidates = [result?.parts, result?.message?.parts, result?.status?.message?.parts, result?.artifact?.parts].filter(Array.isArray);
  return candidates.flatMap((parts) => parts).filter((part: any) => part?.kind === "text" || part?.type === "text").map((part: any) => part.text ?? "").join("") || JSON.stringify(result ?? null);
}
