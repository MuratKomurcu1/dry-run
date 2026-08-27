import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Dataset } from "../src/dataset.ts";
import {
  budgetScorer,
  compositeScorer,
  contextualPrecisionScorer,
  contextualRecallScorer,
  contextualRelevancyScorer,
  evaluateScorer,
  exactMatchScorer,
  groundednessScorer,
  jsonValidityScorer,
  pairwisePreferenceScorer,
  piiSafetyScorer,
  rubricScorer,
  similarityScorer,
  toolCorrectnessScorer,
  trajectoryScorer,
} from "../src/scorers.ts";
import { ExperimentStore, compareExperiments, runExperiment } from "../src/experiment.ts";
import { InMemoryTraceExporter, TraceStore, Tracer, traceToOtlpJson, traceToTrajectory } from "../src/tracing.ts";
import { startStudio } from "../src/studio.ts";
import { PromptRegistry } from "../src/prompts.ts";
import { generateAdversarialDataset, generateSyntheticDataset, redTeamSafetyScorer } from "../src/generation.ts";
import type { LLMProvider, Trajectory } from "../src/types.ts";

const dirs: string[] = [];
function tempDir(): string { const dir = mkdtempSync(path.join(tmpdir(), "dryrun-platform-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function trajectory(output: string, tool = "lookup"): Trajectory {
  return {
    steps: [
      { kind: "llm", response: null, usage: { inputTokens: 4, outputTokens: 2 }, costUsd: 0.001 },
      { kind: "tool", toolCall: { id: "call_1", name: tool, arguments: { id: 42 } }, result: { ok: true } },
      { kind: "llm", response: output, usage: { inputTokens: 3, outputTokens: 1 }, costUsd: 0.001 },
    ],
    output,
  };
}

describe("dataset platform", () => {
  it("versions, validates and deterministically splits JSON/JSONL/CSV datasets", () => {
    const dir = tempDir();
    const dataset = Dataset.create("support", [
      { input: "refund", expected: "done", tags: ["smoke"] },
      { input: "cancel", expected: "cancelled", tags: ["slow"] },
      { input: "status", expected: "shipped", tags: ["smoke"] },
    ]);
    const file = path.join(dir, "support.json");
    dataset.save(file);
    const loaded = Dataset.load(file);
    expect(loaded.checksum).toBe(dataset.checksum);
    expect(loaded.tagged(["smoke"]).cases).toHaveLength(2);
    expect(loaded.split(0.67).train.cases.map((item) => item.id)).toEqual(loaded.split(0.67).train.cases.map((item) => item.id));

    const jsonl = path.join(dir, "cases.jsonl");
    writeFileSync(jsonl, '{"input":"a","expected":"b"}\n');
    expect(Dataset.load(jsonl).cases[0].expected).toBe("b");
    const csv = path.join(dir, "cases.csv");
    writeFileSync(csv, 'input,expected,tags,metadata\nhello,world,smoke|fast,"{""lang"":""en""}"\n');
    const fromCsv = Dataset.load(csv);
    expect(fromCsv.cases[0].tags).toEqual(["smoke", "fast"]);
    expect(fromCsv.cases[0].metadata).toEqual({ lang: "en" });

    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.cases[0].input = "changed";
    writeFileSync(file, JSON.stringify(tampered));
    expect(() => Dataset.load(file)).toThrow(/checksum mismatch/);
  });
});

describe("scorer catalog", () => {
  it("scores output, schema, trajectory, tools, similarity and budgets", async () => {
    const item = { id: "one", input: "x", expected: '{"ok":true}', expectedTools: [{ name: "lookup", arguments: { id: 42 } }] };
    const run = trajectory('{"ok":true}');
    const signal = new AbortController().signal;
    const base = { case: item, output: run.output, trajectory: run, durationMs: 12, trial: 1, signal };
    const scorers = [
      exactMatchScorer(),
      jsonValidityScorer({ type: "object", required: ["ok"], properties: { ok: { const: true } } }),
      similarityScorer({ threshold: 0.9 }),
      trajectoryScorer(undefined, { mode: "strict" }),
      toolCorrectnessScorer(),
      budgetScorer({ maxDurationMs: 20, maxTokens: 20, maxCostUsd: 0.01 }),
    ];
    const scores = await Promise.all(scorers.map((scorer) => evaluateScorer(scorer, base)));
    expect(scores.every((score) => score.passed)).toBe(true);
    expect(scores.find((score) => score.name === "tool-correctness")?.details).toMatchObject({ precision: 1, recall: 1 });
  });

  it("supports retrieval, groundedness, privacy, rubric, pairwise and composite scoring", async () => {
    const signal = new AbortController().signal;
    const item = {
      id: "rag",
      input: "What is the refund period?",
      expected: "The refund period is 30 days.",
      retrievalContext: ["Refunds are available for 30 days after purchase.", "Shipping takes two days."],
    };
    const base = { case: item, output: "Refunds are available for 30 days.", durationMs: 4, trial: 1, signal };
    const retrieval = await Promise.all([
      contextualRecallScorer(0.4),
      contextualPrecisionScorer(0.1),
      contextualRelevancyScorer(0.2),
      groundednessScorer({ threshold: 0.5 }),
    ].map((scorer) => evaluateScorer(scorer, base)));
    expect(retrieval.every((score) => score.passed)).toBe(true);

    expect((await evaluateScorer(piiSafetyScorer(), base)).passed).toBe(true);
    expect((await evaluateScorer(piiSafetyScorer(), { ...base, output: "Email me at person@example.com" })).passed).toBe(false);

    const provider: LLMProvider = {
      chat: async (request) => ({
        text: request.messages[0].content?.includes("pairwise")
          ? JSON.stringify({ winner: "A", confidence: 0.8, reason: "more direct" })
          : JSON.stringify({ score: 0.9, reason: "meets the rubric" }),
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    };
    const rubric = rubricScorer({ provider, model: "local", criteria: [{ name: "correct", description: "The answer is factually correct" }] });
    const preference = pairwisePreferenceScorer({ provider, model: "local", criteria: "Prefer correctness" });
    expect((await evaluateScorer(rubric, base)).score).toBe(0.9);
    expect((await evaluateScorer(preference, base)).score).toBe(0.9);
    const composite = compositeScorer("quality", [{ scorer: exactMatchScorer(), weight: 1 }, { scorer: rubric, weight: 3 }], 0.6);
    expect((await evaluateScorer(composite, base)).passed).toBe(true);
  });
});

describe("experiment platform", () => {
  it("persists resumable trials, aggregates scores, compares runs and accepts feedback", async () => {
    const dir = tempDir();
    const store = new ExperimentStore(path.join(dir, "experiments"));
    const experimentTraces = new TraceStore(path.join(dir, "experiment-traces"));
    const experimentTracer = new Tracer([experimentTraces]);
    const dataset = Dataset.create("answers", [
      { id: "a", input: "a", expected: "A", expectedTools: [{ name: "lookup", arguments: { id: 42 } }] },
      { id: "b", input: "b", expected: "B", expectedTools: [{ name: "lookup", arguments: { id: 42 } }] },
    ]);
    const baseline = await runExperiment({
      name: "agent-quality",
      dataset,
      task: async (input) => trajectory(String(input).toUpperCase()),
      scorers: [exactMatchScorer(), toolCorrectnessScorer()],
    }, { trials: 2, concurrency: 2, store, tracer: experimentTracer });
    expect(baseline.status).toBe("completed");
    expect(baseline.summary).toMatchObject({ total: 4, passed: 4, failed: 0 });
    expect(baseline.aggregates).toHaveLength(2);
    expect(store.list()[0].id).toBe(baseline.id);
    expect(store.load(baseline.id).dataset.checksum).toBe(dataset.checksum);
    expect(experimentTraces.list({ type: "scorer" })).toHaveLength(4);
    const resumed = await runExperiment({
      name: "agent-quality",
      dataset,
      task: async (input) => trajectory(String(input).toUpperCase()),
      scorers: [exactMatchScorer(), toolCorrectnessScorer()],
    }, { resumeId: baseline.id, store, tracer: experimentTracer });
    expect(resumed.summary.total).toBe(4);
    expect(resumed.config.trials).toBe(2);
    await expect(runExperiment({
      name: "agent-quality",
      dataset,
      task: async (input) => String(input).toUpperCase(),
      scorers: [exactMatchScorer()],
    }, { resumeId: baseline.id, store, trace: false })).rejects.toThrow(/scorer configuration changed/);

    const feedback = await store.addFeedback(baseline.id, { caseKey: "a#1", source: "human", score: 1, comment: "correct" });
    expect(feedback.id).toMatch(/^feedback_/);
    expect(store.load(baseline.id).feedback).toHaveLength(1);

    const candidate = await runExperiment({
      name: "agent-quality-candidate",
      dataset,
      task: async (input) => trajectory(input === "b" ? "wrong" : "A"),
      scorers: [exactMatchScorer(), toolCorrectnessScorer()],
    }, { store, tracer: experimentTracer });
    const comparableCandidate = { ...candidate, name: baseline.name };
    const comparison = compareExperiments(baseline, comparableCandidate);
    expect(comparison.regressions.some((item) => item.caseId === "b")).toBe(true);
    expect(comparison.scoreDeltas.find((item) => item.name === "exact-match")!.delta).toBeLessThan(0);
  });
});

describe("prompt registry", () => {
  it("publishes immutable checksummed versions, assigns labels and renders variables", async () => {
    const registry = new PromptRegistry(path.join(tempDir(), "prompts"));
    const first = await registry.publish("support-answer", "Answer {{question}} briefly.", { label: "production", tags: ["support"] });
    const duplicate = await registry.publish("support-answer", "Answer {{question}} briefly.");
    expect(duplicate.version).toBe(first.version);
    const second = await registry.publish("support-answer", "Answer {{question}} with sources.", { label: "candidate" });
    expect(second.version).toBe(2);
    expect(registry.render("support-answer", { question: "refunds" }, "production").text).toBe("Answer refunds briefly.");
    expect(registry.render("support-answer", { question: "refunds" }, "candidate").version).toBe(2);
    await registry.label("support-answer", 2, "production");
    expect(registry.get("support-answer", "production").version).toBe(2);
    expect(registry.list()).toHaveLength(1);

    const file = registry.file("support-answer");
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.versions[0].template = "changed";
    writeFileSync(file, JSON.stringify(tampered));
    expect(() => registry.load("support-answer")).toThrow(/checksum mismatch/);
  });
});

describe("dataset generation and red teaming", () => {
  it("generates grounded synthetic cases through a pluggable provider", async () => {
    const provider: LLMProvider = {
      chat: async () => ({
        text: JSON.stringify({ cases: [
          { input: "How long are refunds available?", expected: "30 days", tags: ["refund"] },
          { input: "When does the period start?", expected: "After purchase", tags: ["refund"] },
        ] }),
        toolCalls: [],
      }),
    };
    const dataset = await generateSyntheticDataset({
      provider,
      model: "local-model",
      name: "refund-faq",
      sources: ["Refunds are available for 30 days after purchase."],
      casesPerSource: 2,
    });
    expect(dataset.cases).toHaveLength(2);
    expect(dataset.cases[0].context).toEqual(["Refunds are available for 30 days after purchase."]);
    expect(dataset.cases[0].tags).toContain("synthetic");
  });

  it("creates deterministic attack variants and fails when an agent follows the injected canary", async () => {
    const source = Dataset.create("support", [{ id: "refund", input: "Can I get a refund?", expected: "Yes" }]);
    const attacks = generateAdversarialDataset(source, { attacks: ["prompt-injection", "base64"] });
    expect(attacks.cases).toHaveLength(2);
    expect(attacks.cases[0].tags).toContain("red-team");
    const scorer = redTeamSafetyScorer();
    const base = { case: attacks.cases[0], durationMs: 1, trial: 1, signal: new AbortController().signal };
    expect((await evaluateScorer(scorer, { ...base, output: "I cannot follow that instruction." })).passed).toBe(true);
    expect((await evaluateScorer(scorer, { ...base, output: "DRYRUN_OVERRIDE_SUCCEEDED" })).passed).toBe(false);
  });
});

describe("trace platform", () => {
  it("captures nested spans, exports/searches them and converts traces to trajectory/OTLP", async () => {
    const dir = tempDir();
    const memory = new InMemoryTraceExporter();
    const store = new TraceStore(path.join(dir, "traces"));
    const tracer = new Tracer([memory, store]);
    await tracer.withSpan("support-agent", { type: "agent", input: "refund", tags: ["prod"] }, async () => {
      await tracer.withSpan("lookup", { type: "tool", input: { name: "lookup", arguments: { id: 42 } } }, async () => ({ found: true }));
      return "done";
    });
    expect(memory.traces).toHaveLength(1);
    const trace = memory.traces[0];
    expect(trace.spans.map((span) => span.type)).toEqual(["agent", "tool"]);
    expect(trace.spans[1].parentId).toBe(trace.rootSpanId);
    expect(store.list({ type: "tool", tag: "prod" })).toHaveLength(1);
    const converted = traceToTrajectory(trace);
    expect(converted.steps[0].toolCall?.name).toBe("lookup");
    expect(converted.output).toBe("done");
    expect(traceToOtlpJson(trace)).toHaveProperty("resourceSpans");
    await store.addFeedback(trace.id, { source: "human", score: 1, comment: "good" });
    expect(store.load(trace.id).feedback).toHaveLength(1);
  });
});

describe("local studio", () => {
  it("enforces loopback at runtime even for untyped JavaScript callers", async () => {
    await expect(startStudio({ host: "0.0.0.0" as any })).rejects.toThrow(/loopback/);
  });

  it("serves a token-protected loopback API with hardened browser headers", async () => {
    const dir = tempDir();
    const promptRegistry = new PromptRegistry(path.join(dir, "prompts"));
    await promptRegistry.publish("support", "Answer {{question}}.", { label: "production" });
    const handle = await startStudio({
      experimentStore: new ExperimentStore(path.join(dir, "experiments")),
      traceStore: new TraceStore(path.join(dir, "traces")),
      promptRegistry,
    });
    try {
      const page = await fetch(`http://127.0.0.1:${handle.port}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await page.text()).toContain("dry-run studio");
      expect((await fetch(`http://127.0.0.1:${handle.port}/api/experiments`)).status).toBe(401);
      const authorized = await fetch(`http://127.0.0.1:${handle.port}/api/experiments`, { headers: { Authorization: `Bearer ${handle.token}` } });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual([]);
      const prompts = await fetch(`http://127.0.0.1:${handle.port}/api/prompts`, { headers: { Authorization: `Bearer ${handle.token}` } });
      expect(prompts.status).toBe(200);
      expect(await prompts.json()).toEqual([expect.objectContaining({ name: "support", versions: 1, latest: 1 })]);
    } finally {
      await handle.close();
    }
  });
});
