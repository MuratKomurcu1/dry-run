import { describe, expect, it } from "vitest";
import { generateText, jsonSchema, streamText } from "ai";
import { vercelAIModel } from "../src/adapters/vercel-ai.ts";
import { MockProvider } from "../src/providers/mock.ts";

describe("vercel AI SDK adapter", () => {
  it("works with generateText", async () => {
    const model = vercelAIModel(new MockProvider([{ say: "hello from mock" }]));
    const { text } = await generateText({ model: model as never, prompt: "hi" });
    expect(text).toBe("hello from mock");
  });

  it("passes tools and returns tool calls", async () => {
    const model = vercelAIModel(
      new MockProvider([{ call: "get_weather", args: { city: "Paris" } }]),
    );
    const { toolCalls } = await generateText({
      model: model as never,
      prompt: "weather?",
      tools: {
        get_weather: {
          inputSchema: jsonSchema({
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          }),
          execute: async () => "sunny",
        },
      } as never,
    });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe("get_weather");
    expect(toolCalls[0].input).toEqual({ city: "Paris" });
  });

  it("streams text deltas", async () => {
    const model = vercelAIModel(new MockProvider([{ say: "streamed answer" }]));
    const result = streamText({ model: model as never, prompt: "hi" });
    const chunks: string[] = [];
    for await (const part of result.textStream) chunks.push(part);
    expect(chunks.join("")).toBe("streamed answer");
  });
});
