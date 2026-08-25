import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from "../types.ts";

export type MockTurn = { say: string } | { call: string; args?: Record<string, unknown> };

export class MockProvider implements LLMProvider {
  #turns: MockTurn[];
  #i = 0;

  constructor(turns: MockTurn[]) {
    this.#turns = turns;
  }

  get remaining(): number {
    return this.#turns.length - this.#i;
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    const turn = this.#turns[this.#i];
    if (!turn) {
      throw new Error(
        `MockProvider exhausted: all ${this.#turns.length} scripted turns were consumed. Add more turns to the script.`,
      );
    }
    this.#i++;
    if ("say" in turn) {
      return { text: turn.say, toolCalls: [] };
    }
    const call: ToolCall = {
      id: `call_${this.#i}`,
      name: turn.call,
      arguments: turn.args ?? {},
    };
    return { text: null, toolCalls: [call] };
  }
}
