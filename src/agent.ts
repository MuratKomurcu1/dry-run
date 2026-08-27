import type {
  ChatMessage,
  LLMProvider,
  TestAgent,
  ToolCall,
  ToolDef,
  Trajectory,
  AgentRunContext,
} from "./types.ts";

export interface AgentConfig {
  provider: LLMProvider;
  model?: string;
  system?: string;
  tools?: ToolDef[];
  execute?: (call: ToolCall, context?: AgentRunContext) => unknown | Promise<unknown>;
  maxTurns?: number;
}

export function defineAgent(cfg: AgentConfig): TestAgent {
  const maxTurns = cfg.maxTurns ?? 8;

  return async (input: string, context): Promise<Trajectory> => {
    const messages: ChatMessage[] = [];
    if (cfg.system) messages.push({ role: "system", content: cfg.system });
    messages.push({ role: "user", content: input });

    const steps: Trajectory["steps"] = [];
    let output = "";

    for (let turn = 0; turn < maxTurns; turn++) {
      context?.signal.throwIfAborted();
      const llmStart = performance.now();
      const res = await cfg.provider.chat({
        model: cfg.model ?? "",
        messages,
        tools: cfg.tools,
        signal: context?.signal,
      });

      steps.push({
        kind: "llm",
        response: res.text ?? undefined,
        usage: res.usage,
        costUsd: res.costUsd,
        durationMs: Math.round(performance.now() - llmStart),
      });

      if (res.toolCalls.length === 0) {
        output = res.text ?? "";
        return { steps, output };
      }

      messages.push({
        role: "assistant",
        content: res.text,
        toolCalls: res.toolCalls,
      });

      for (const call of res.toolCalls) {
        context?.signal.throwIfAborted();
        let result: unknown;
        let error: string | undefined;
        const toolStart = performance.now();
        try {
          result = await cfg.execute?.(call, context);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        steps.push({
          kind: "tool",
          toolCall: call,
          result,
          error,
          durationMs: Math.round(performance.now() - toolStart),
        });
        messages.push({
          role: "tool",
          content: JSON.stringify({ ok: !error, result, error }),
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    throw new Error(`Agent exceeded maxTurns (${maxTurns}) without a final answer`);
  };
}
