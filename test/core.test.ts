import { describe, expect, it } from "vitest";
import { defineAgent } from "../src/agent.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { evaluateAssertion } from "../src/assertions.ts";
import { runScenarios } from "../src/runner.ts";
import { scenario } from "../src/scenario.ts";

function makeAgent(say: string) {
  return defineAgent({
    provider: new MockProvider([
      { call: "search", args: { q: "cats" } },
      { say },
    ]),
    tools: [{ name: "search" }],
    execute: (call) => `results for ${call.arguments.q}`,
  });
}

describe("runScenarios", () => {
  it("passes a green scenario", async () => {
    const summary = await runScenarios([
      scenario({
        name: "green",
        agent: makeAgent("Cats are great."),
        input: "tell me about cats",
        expect: [
          { type: "toolCalled", tool: "search", argsContains: { q: "cats" } },
          { type: "outputContains", value: "great" },
          { type: "maxSteps", count: 3 },
        ],
      }),
    ]);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
  });

  it("fails when output does not match", async () => {
    const summary = await runScenarios([
      scenario({
        name: "red",
        agent: makeAgent("Dogs are fine."),
        input: "tell me about cats",
        expect: [{ type: "outputContains", value: "cat" }],
      }),
    ]);
    const r = summary.results[0];
    expect(r.passed).toBe(false);
    expect(r.assertions[0].message).toContain("actual output");
  });

  it("counts tool calls exactly when asked", async () => {
    const t = await makeAgent("done")("x");
    expect(evaluateAssertion({ type: "toolCalled", tool: "search", times: 2 }, t).passed).toBe(false);
    expect(evaluateAssertion({ type: "toolCalled", tool: "search", times: 1 }, t).passed).toBe(true);
  });
});
