import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import {
  Agent,
  RunMessageOutputItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  Span,
  Trace,
  type TracingProcessor,
} from "@openai/agents";
import { langGraphAgent, trajectoryFromLangGraph } from "../src/integrations/langgraph.ts";
import {
  createDryRunTraceProcessor,
  trajectoryFromOpenAIAgents,
} from "../src/integrations/openai-agents.ts";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "dryrun-framework-"));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("official framework contracts", () => {
  it("runs an actual compiled LangGraph and accepts official message classes", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("answer", async () => ({ messages: [new AIMessage("compiled graph answer")] }))
      .addEdge(START, "answer")
      .addEdge("answer", END)
      .compile();
    const result = await langGraphAgent(graph)("hello");
    expect(result.output).toBe("compiled graph answer");

    const messages = [
      new HumanMessage("find order 42"),
      new AIMessage({ content: "", tool_calls: [{ id: "call_42", name: "lookup", args: { id: 42 }, type: "tool_call" }] }),
      new ToolMessage({ content: JSON.stringify({ status: "shipped" }), tool_call_id: "call_42", name: "lookup" }),
      new AIMessage("Order 42 shipped."),
    ];
    const trajectory = trajectoryFromLangGraph(messages);
    expect(trajectory.output).toBe("Order 42 shipped.");
    expect(trajectory.steps.find((step) => step.kind === "tool")).toMatchObject({
      toolCall: { id: "call_42", name: "lookup", arguments: { id: 42 } },
      result: JSON.stringify({ status: "shipped" }),
    });
  });

  it("converts official OpenAI Agents run items without live model calls", () => {
    const agent = new Agent({ name: "contract-agent", instructions: "Test contract only" });
    const call = new RunToolCallItem({
      type: "function_call",
      callId: "call_42",
      name: "lookup",
      arguments: JSON.stringify({ id: 42 }),
      status: "completed",
    }, agent);
    const callOutput = new RunToolCallOutputItem({
      type: "function_call_result",
      name: "lookup",
      callId: "call_42",
      status: "completed",
      output: JSON.stringify({ status: "shipped" }),
    }, agent, JSON.stringify({ status: "shipped" }));
    const message = new RunMessageOutputItem({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Order 42 shipped." }],
    }, agent);
    const trajectory = trajectoryFromOpenAIAgents({ finalOutput: "Order 42 shipped.", newItems: [call, callOutput, message] });
    expect(trajectory.output).toBe("Order 42 shipped.");
    expect(trajectory.steps).toHaveLength(2);
    expect(trajectory.steps[0]).toMatchObject({
      kind: "tool",
      toolCall: { id: "call_42", name: "lookup", arguments: { id: 42 } },
      result: JSON.stringify({ status: "shipped" }),
    });
  });

  it("implements the official OpenAI Agents tracing processor lifecycle", async () => {
    const file = path.join(temporaryDirectory(), "agents-trace.json");
    const processor: TracingProcessor = createDryRunTraceProcessor({ file });
    const trace = new Trace({ name: "contract-trace", traceId: "trace_contract" });
    const span = new Span({
      traceId: trace.traceId,
      spanId: "span_contract",
      data: { type: "task", name: "contract-task" },
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
    }, processor);
    await processor.onTraceStart(trace);
    await processor.onSpanStart(span);
    await processor.onSpanEnd(span);
    await processor.onTraceEnd(trace);
    await processor.forceFlush();
    const document = JSON.parse(readFileSync(file, "utf8"));
    expect(document.traces).toHaveLength(1);
    expect(document.spans).toHaveLength(1);
    await processor.shutdown();
  });
});
