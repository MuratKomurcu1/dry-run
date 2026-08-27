import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverLocalJudge } from "../src/local-judge.ts";
import { OnlineEvaluationEngine, OnlineEvaluationProcessor, OnlineEvaluationStore } from "../src/online-evaluation.ts";
import { PlaygroundStore, promotePlaygroundVariant, runPlayground } from "../src/playground.ts";
import { RegressionStore } from "../src/promotion.ts";
import { createPrQualityReport, postGithubPrComment } from "../src/pr-report.ts";
import { AnnotationStore, TeamWorkspace } from "../src/team.ts";
import { startTeamServer, type TeamServerHandle } from "../src/team-server.ts";
import { TraceStore, type TraceDocument } from "../src/tracing.ts";
import { PromptRegistry } from "../src/prompts.ts";
import { ExperimentStore, type ExperimentDocument } from "../src/experiment.ts";

const roots: string[] = [];
const handles: TeamServerHandle[] = [];
function tempDir(): string { const root = mkdtempSync(path.join(os.tmpdir(), "dry-run-v08-")); roots.push(root); return root; }
afterEach(async () => { while (handles.length) await handles.pop()!.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("v0.8 production-to-regression loop", () => {
  it("evaluates durable online rules idempotently and mines failures into review", async () => {
    const root = tempDir();
    const online = new OnlineEvaluationStore(path.join(root, "online"));
    const annotations = new AnnotationStore(path.join(root, "annotations"));
    const traces = new TraceStore(path.join(root, "traces"));
    const rule = await online.create({
      name: "latency and tool safety",
      filter: { tags: ["production"], sampleRate: 1 },
      checks: [{ type: "maxDuration", ms: 50 }, { type: "noToolErrors" }],
      action: { queueName: "Production failures", labels: ["release-blocker"] },
    });
    const trace = productionTrace("trace_online");
    await traces.export(trace);
    const engine = new OnlineEvaluationEngine(online, { annotations });
    const processor = new OnlineEvaluationProcessor(online, traces, engine);
    await processor.enqueue([trace.id]);
    await processor.drain();

    const results = online.listResults();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ruleId: rule.id, traceId: trace.id, passed: false });
    expect(results[0].annotationItemId).toBeTruthy();
    expect(annotations.listQueues()[0].name).toBe("Production failures");
    expect(annotations.listItems({ queueId: annotations.listQueues()[0].id })).toHaveLength(1);
    await expect(engine.evaluateTrace(trace)).resolves.toMatchObject({ cached: 1 });
    expect(annotations.listItems({ queueId: annotations.listQueues()[0].id })).toHaveLength(1);
    const revised = await online.update(rule.id, { checks: [{ type: "maxDuration", ms: 500 }] });
    expect(revised.revision).toBe(2);
    await expect(engine.evaluateTrace(trace)).resolves.toMatchObject({ cached: 0, results: [expect.objectContaining({ passed: true, ruleRevision: 2 })] });
    expect(online.listResults()).toHaveLength(2);
  });

  it("promotes an attributed production trace into dataset, cassette, and executable scenario", async () => {
    const store = new RegressionStore(path.join(tempDir(), "regressions"));
    const bundle = await store.promote(productionTrace("trace_promote"), { name: "refund safety", onlineResultId: "online_1", annotationItemId: "item_1" });
    expect(bundle.manifest.dataset.cases).toBe(1);
    expect(bundle.manifest.cassette?.interactions).toBe(1);
    expect(bundle.manifest.warnings).toEqual([]);
    expect(bundle.dataset.cases[0]).toMatchObject({ expected: "Refund approved", tags: expect.arrayContaining(["production-regression"]) });
    expect(bundle.scenario).toContain("generated from cassette");
    expect(store.load(bundle.manifest.id).manifest.provenance).toMatchObject({ onlineResultId: "online_1", annotationItemId: "item_1" });
    const cassetteFile = path.join(store.dir, bundle.manifest.id, "cassette.json");
    const cassetteSource = readFileSync(cassetteFile, "utf8");
    const cassette = JSON.parse(cassetteSource);
    cassette.interactions[0].response.text = "tampered";
    writeFileSync(cassetteFile, `${JSON.stringify(cassette, null, 2)}\n`);
    expect(() => store.load(bundle.manifest.id)).toThrow(/checksum mismatch/);
    writeFileSync(cassetteFile, cassetteSource);
    writeFileSync(path.join(store.dir, bundle.manifest.id, "regression.agentest.ts"), "tampered");
    expect(() => store.load(bundle.manifest.id)).toThrow(/scenario checksum mismatch/);
  });

  it("auto-detects a loopback Ollama judge and chooses a non-embedding model", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }, { name: "qwen3:8b" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const profile = await discoverLocalJudge({ endpoint: "http://127.0.0.1:11434", fetch: request as typeof fetch });
    expect(profile).toMatchObject({ kind: "ollama", endpoint: "http://127.0.0.1:11434/v1", model: "qwen3:8b" });
    await expect(discoverLocalJudge({ endpoint: "http://example.com:11434", fetch: request as typeof fetch })).rejects.toThrow(/loopback/);
  });

  it("runs a local prompt matrix, selects a winner, and promotes it to prompt plus experiment", async () => {
    const root = tempDir();
    const runs = new PlaygroundStore(path.join(root, "runs"));
    const run = await runPlayground({
      name: "refund prompt",
      promptName: "refund-answer",
      variants: [
        { id: "candidate-a", name: "Candidate A", template: "A {{input}}", model: "local" },
        { id: "candidate-b", name: "Candidate B", template: "B {{input}}", model: "local" },
      ],
      cases: [{ id: "one", input: "one", expected: "good:one" }, { id: "two", input: "two", expected: "good:two" }],
      scorer: { type: "exact" },
      concurrency: 2,
    }, {
      store: runs,
      provider: (variant) => ({ chat: async (request) => ({ text: variant.id === "candidate-a" ? `good:${request.messages.at(-1)?.content?.split(" ").at(-1)}` : "bad", toolCalls: [] }) }),
    });
    expect(run.winner).toBe("candidate-a");
    expect(run.summaries.find((item) => item.variantId === "candidate-a")?.passRate).toBe(1);
    const promoted = await promotePlaygroundVariant(run, "candidate-a", new PromptRegistry(path.join(root, "prompts")), new ExperimentStore(path.join(root, "experiments")));
    expect(promoted.prompt.version).toBe(1);
    expect(promoted.experiment).toMatchObject({ status: "completed", passed: true, summary: { passed: 2, failed: 0 } });
  });

  it("renders a regression-aware PR report and creates a reusable GitHub bot comment", async () => {
    const baseline = experiment("baseline", true, 1);
    const candidate = experiment("candidate", false, 0);
    const report = createPrQualityReport(baseline, candidate);
    expect(report.fail).toBe(true);
    expect(report.markdown).toContain("1 regression(s)");
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, html_url: "https://github.test/comment/42" }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const posted = await postGithubPrComment(report.markdown, { token: "token", repository: "owner/repo", pullRequest: 7, fetch: request as typeof fetch });
    expect(posted).toEqual({ action: "created", id: 42, url: "https://github.test/comment/42" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("exposes the complete rule, ingest, review, promotion, and playground loop over team API", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(path.join(tempDir(), "team"), "v08 team");
    const handle = await startTeamServer({
      workspace,
      port: 0,
      playgroundProvider: (variant) => ({ chat: async (request) => ({ text: variant.id === "a" ? String(request.messages.at(-1)?.content).replace(/^A /, "") : "wrong", toolCalls: [] }) }),
    });
    handles.push(handle);
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };
    const ruleResponse = await fetch(`${handle.url}/api/v1/projects/default/online/rules`, { method: "POST", headers, body: JSON.stringify({ name: "production latency", filter: { tags: ["production"] }, checks: [{ type: "maxDuration", ms: 50 }] }) });
    expect(ruleResponse.status).toBe(201);
    const ingest = await fetch(`${handle.url}/api/v1/projects/default/traces`, { method: "POST", headers, body: JSON.stringify(productionTrace("trace_api")) });
    expect(ingest.status).toBe(202);
    let results: any[] = [];
    for (let attempt = 0; attempt < 30 && !results.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      results = (await (await fetch(`${handle.url}/api/v1/projects/default/online/results`, { headers })).json() as any).results;
    }
    expect(results[0]).toMatchObject({ traceId: "trace_api", passed: false });
    const promotedResponse = await fetch(`${handle.url}/api/v1/projects/default/traces/trace_api/promote`, { method: "POST", headers, body: JSON.stringify({ onlineResultId: results[0].id }) });
    expect(promotedResponse.status).toBe(201);
    expect((await promotedResponse.json() as any).regression.manifest.cassette).toBeTruthy();

    const playgroundResponse = await fetch(`${handle.url}/api/v1/projects/default/playground/runs`, { method: "POST", headers, body: JSON.stringify({
      name: "api playground", promptName: "api-prompt", variants: [{ id: "a", name: "A", template: "A {{input}}", model: "local" }, { id: "b", name: "B", template: "B {{input}}", model: "local" }], cases: [{ id: "x", input: "expected", expected: "expected" }], scorer: { type: "exact" },
    }) });
    expect(playgroundResponse.status).toBe(201);
    const playgroundRun = (await playgroundResponse.json() as any).run;
    expect(playgroundRun.winner).toBe("a");
    const promoteWinner = await fetch(`${handle.url}/api/v1/projects/default/playground/runs/${playgroundRun.id}/promote`, { method: "POST", headers, body: JSON.stringify({ variantId: "a" }) });
    expect(promoteWinner.status).toBe(201);
    expect((await promoteWinner.json() as any).promoted.experiment.passed).toBe(true);
  });
});

function productionTrace(id: string): TraceDocument {
  const startedAt = "2026-08-26T08:00:00.000Z";
  const endedAt = "2026-08-26T08:00:00.100Z";
  return {
    kind: "dry-run.trace",
    version: 1,
    id,
    name: "refund-agent",
    status: "ok",
    startedAt,
    endedAt,
    durationMs: 100,
    rootSpanId: "span_root",
    tags: ["production"],
    metadata: { environment: "production", release: "v1" },
    feedback: [],
    spans: [
      { id: "span_root", traceId: id, name: "refund-agent", type: "agent", status: "ok", startedAt, endedAt, durationMs: 100, input: "refund order 42", output: "Refund approved", attributes: {}, metrics: {}, events: [] },
      {
        id: "span_llm", traceId: id, parentId: "span_root", name: "model", type: "llm", status: "ok", startedAt, endedAt, durationMs: 80,
        input: { model: "local-model", messages: [{ role: "user", content: "refund order 42" }] },
        output: { text: "Refund approved", toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 } },
        attributes: { "gen_ai.request.model": "local-model" }, metrics: {}, events: [],
      },
    ],
  };
}

function experiment(id: string, passed: boolean, score: number): ExperimentDocument {
  const now = "2026-08-26T08:00:00.000Z";
  return {
    kind: "dry-run.experiment", version: 1, id, name: id, status: "completed", passed, createdAt: now, updatedAt: now, completedAt: now,
    dataset: { name: "dataset", checksum: "sha256:test", cases: 1 }, config: { concurrency: 1, trials: 1, retries: 0, timeoutMs: 1, scorers: [{ name: "quality", threshold: 1 }] },
    provenance: { producer: { name: "@muratkomurcu/dry-run", version: "0.8.0" }, runtime: { name: "node", version: process.version, platform: process.platform, arch: process.arch } },
    results: [{ key: "case#1", caseId: "case", trial: 1, input: "x", output: "y", scores: [{ name: "quality", score, threshold: 1, passed }], passed, durationMs: passed ? 100 : 120, attempts: 1 }],
    aggregates: [{ name: "quality", count: 1, mean: score, min: score, max: score, passRate: passed ? 1 : 0, passed: passed ? 1 : 0, failed: passed ? 0 : 1, confidence95: { low: score, high: score } }],
    feedback: [], summary: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, durationMs: passed ? 100 : 120 },
  };
}
