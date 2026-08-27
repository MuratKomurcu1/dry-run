import { describe, expect, it } from "vitest";
import { migrateEvaluationExport } from "../src/integrations/migrations.ts";

describe("clean-room migration adapters", () => {
  it("imports DeepEval cases into a checksummed Dry Run dataset", () => {
    const bundle = migrateEvaluationExport("deepeval", { testCases: [{ input: "question", actualOutput: "old", expectedOutput: "answer", retrievalContext: ["fact"], metricsData: [{ name: "faithfulness", score: 1 }] }] });
    expect(bundle.summary).toMatchObject({ datasets: 1, cases: 1, traces: 0 });
    expect(bundle.datasets[0]).toMatchObject({ kind: "dry-run.dataset", cases: [{ input: "question", expected: "answer", retrievalContext: ["fact"] }] });
    expect(bundle.datasets[0].checksum).toMatch(/^sha256:/);
  });

  it("imports Langfuse trace observations and feedback", () => {
    const bundle = migrateEvaluationExport("langfuse", { data: [{ id: "trace/1", name: "agent", timestamp: "2026-01-01T00:00:00Z", tags: ["prod"], observations: [{ id: "root", name: "generation", type: "GENERATION", startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T00:00:01Z", input: "hello", output: "world", model: "local-model", usage: { total_tokens: 3 } }], scores: [{ name: "quality", value: 0.8 }] }] });
    expect(bundle.summary).toMatchObject({ traces: 1, spans: 1 });
    expect(bundle.traces[0]).toMatchObject({ kind: "dry-run.trace", tags: ["prod"], spans: [{ type: "llm", metrics: { total_tokens: 3 } }], feedback: [{ label: "quality", score: 0.8 }] });
  });

  it("groups Braintrust span rows into trace trees", () => {
    const bundle = migrateEvaluationExport("braintrust", [{ id: "root", root_span_id: "trace-a", name: "agent", created: "2026-01-01T00:00:00Z" }, { id: "child", root_span_id: "trace-a", parent_id: "root", name: "tool", type: "tool", created: "2026-01-01T00:00:01Z", output: { ok: true } }]);
    expect(bundle.summary).toMatchObject({ traces: 1, spans: 2 });
    expect(bundle.traces[0].spans).toEqual(expect.arrayContaining([expect.objectContaining({ id: "child", parentId: "root", type: "tool" })]));
  });
});
