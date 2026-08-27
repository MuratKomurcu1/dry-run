import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CassetteStore,
  createDocument,
  parseCassette,
  recorder,
  replayer,
} from "../src/cassette.ts";
import { cachedTools, stableKey } from "../src/cached-tools.ts";
import { evaluateAssertion, evaluateAssertionAsync } from "../src/assertions.ts";
import { runScenarios, selectScenarios } from "../src/runner.ts";
import { scenario } from "../src/scenario.ts";
import { installIsolation } from "../src/isolation.ts";
import { traceToCassette, traceToTrajectory } from "../src/integrations/otel.ts";
import { langGraphAgent } from "../src/integrations/langgraph.ts";
import { a2aAgent } from "../src/integrations/a2a.ts";
import { HttpProvider } from "../src/providers/http.ts";
import { OpenAIResponsesProvider } from "../src/providers/responses.ts";
import { writeJsonReport, writeSarifReport } from "../src/report-files.ts";
import type { ChatRequest, LLMProvider, Trajectory } from "../src/types.ts";

const directories: string[] = [];
const request: ChatRequest = { model: "model", messages: [{ role: "user", content: "hello" }], tools: [{ name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } }] };
const response = { text: "done", toolCalls: [] };

function temp(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "dryrun-v1-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cassette v2", () => {
  it("writes a versioned, checksummed envelope and migrates v1", async () => {
    const directory = temp();
    const store = new CassetteStore(directory);
    const provider: LLMProvider = { chat: async () => response };
    await recorder(provider, store, "safe-name").chat(request);
    const raw = JSON.parse(readFileSync(store.fileFor("safe-name"), "utf8"));
    expect(raw.kind).toBe("dry-run.cassette");
    expect(raw.version).toBe(2);
    expect(raw.metadata.gitSha).toMatch(/^[a-f0-9]{7,40}$/);
    expect(raw.interactions[0].fingerprints.canonical).toMatch(/^sha256:/);
    expect(() => parseCassette(raw, "safe-name", { verifyChecksum: true })).not.toThrow();

    const legacy = parseCassette([{ request, response }], "legacy");
    expect(legacy.metadata.source).toEqual({ migratedFrom: 1 });
    expect(legacy.metadata.matching).toBe("shape");
  });

  it("defaults to canonical matching but permits explicit shape and custom policies", async () => {
    const directory = temp();
    const store = new CassetteStore(directory);
    store.saveDocumentSync("matching", createDocument("matching", [{ request, response }], { matching: "canonical" }));
    await expect(replayer(store, "matching").chat({ ...request, messages: [{ role: "user", content: "changed" }] })).rejects.toThrow(/canonical mode[\s\S]*messages\[0\]\.content/);
    await expect(replayer(store, "matching").chat({ ...request, temperature: 0.2 })).rejects.toThrow(/temperature/);
    await expect(replayer(store, "matching", { matching: "shape" }).chat({ ...request, messages: [{ role: "user", content: "changed" }] })).resolves.toEqual(response);
    await expect(replayer(store, "matching", { matcher: () => ({ matched: false, message: "policy rejected request" }) }).chat(request)).rejects.toThrow(/policy rejected request/);
  });

  it("uses collision-resistant filenames", () => {
    const store = new CassetteStore(temp());
    expect(store.fileFor("foo/bar")).not.toBe(store.fileFor("foo-bar"));
  });
});

describe("assertion engine", () => {
  const trajectory: Trajectory = {
    steps: [
      { kind: "llm", usage: { inputTokens: 10, outputTokens: 2 }, costUsd: 0.01 },
      { kind: "tool", toolCall: { id: "1", name: "search", arguments: { q: "cats", limit: 3 } }, result: [] },
      { kind: "tool", toolCall: { id: "2", name: "read", arguments: { id: 1 } }, result: {} },
    ],
    output: JSON.stringify({ answer: "ok" }),
  };

  it("supports trajectory modes, schemas, budgets and async custom checks", async () => {
    expect(evaluateAssertion({ type: "trajectory", tools: ["search", "read"], mode: "strict" }, trajectory).passed).toBe(true);
    expect(evaluateAssertion({ type: "trajectory", tools: ["read", "search"], mode: "unordered" }, trajectory).passed).toBe(true);
    expect(evaluateAssertion({ type: "toolArgsSchema", tool: "search", schema: { type: "object", required: ["q"], properties: { q: { type: "string" } } } }, trajectory).passed).toBe(true);
    expect(evaluateAssertion({ type: "outputJsonSchema", schema: { type: "object", required: ["answer"] } }, trajectory).passed).toBe(true);
    expect(evaluateAssertion(
      { type: "outputJsonSchema", schema: { type: "object", properties: { email: { type: "string", format: "email" } } } },
      { steps: [], output: JSON.stringify({ email: "not-an-email" }) },
    ).passed).toBe(false);
    expect(evaluateAssertion({ type: "maxLLMCalls", count: 1 }, trajectory).passed).toBe(true);
    expect(evaluateAssertion({ type: "maxCost", usd: 0.005 }, trajectory).passed).toBe(false);
    expect((await evaluateAssertionAsync({ type: "custom", name: "async", evaluate: async () => true }, trajectory)).passed).toBe(true);
  });

  it("fails on the third identical tool call with the default 2x limit", () => {
    const looping: Trajectory = { steps: [1, 2, 3].map((id) => ({ kind: "tool" as const, toolCall: { id: String(id), name: "search", arguments: {} } })), output: "" };
    expect(evaluateAssertion({ type: "noRepeatedToolCalls" }, looping).passed).toBe(false);
  });
});

describe("scaled fail-closed runner", () => {
  it("fails semantic and unavailable metric assertions unless skips are explicitly allowed", async () => {
    const semantic = scenario({ name: "semantic", agent: async () => ({ steps: [], output: "ok" }), input: "x", expect: [{ type: "semantic", criteria: "good" }] });
    expect((await runScenarios([semantic])).failed).toBe(1);
    const tokens = scenario({ name: "tokens", agent: async () => ({ steps: [], output: "ok" }), input: "x", expect: [{ type: "maxTokens", count: 10 }] });
    expect((await runScenarios([tokens])).failed).toBe(1);
    expect((await runScenarios([tokens], { allowSkipped: true })).failed).toBe(0);
    const junit = path.join(temp(), "skipped.xml");
    await runScenarios([tokens], { junitPath: junit });
    expect(readFileSync(junit, "utf8")).toContain("no token usage recorded");
  });

  it("aborts timed-out agents and supports retries, trials, concurrency and selection", async () => {
    let aborted = false;
    const timeout = scenario({
      name: "timeout",
      timeoutMs: 15,
      input: "x",
      expect: [],
      agent: async (_input, context) => new Promise((_resolve, reject) => context!.signal.addEventListener("abort", () => { aborted = true; reject(context!.signal.reason); }, { once: true })),
    });
    expect((await runScenarios([timeout])).failed).toBe(1);
    expect(aborted).toBe(true);

    let calls = 0;
    const flaky = scenario({ name: "flaky", tags: ["smoke"], retries: 1, input: "x", expect: [{ type: "outputEquals", value: "ok" }], agent: async () => ({ steps: [], output: ++calls === 1 ? "bad" : "ok" }) });
    const summary = await runScenarios([flaky], { trials: 2, concurrency: 2 });
    expect(summary.total).toBe(2);
    expect(summary.results[0].attempts).toBe(2);
    expect(selectScenarios([flaky, { ...flaky, name: "other", tags: ["slow"] }], { tags: ["smoke"] })).toHaveLength(1);
    expect(selectScenarios([flaky, { ...flaky, name: "other" }], { shard: { index: 2, total: 2 } })[0].name).toBe("other");
  });
});

describe("safe tool cache and isolation", () => {
  it("canonicalizes rich arguments, rejects cycles and serializes concurrent cache misses", async () => {
    expect(stableKey({ value: 1n, set: new Set([2, 1]), missing: undefined })).toContain("bigint");
    const circular: any = {}; circular.self = circular;
    expect(() => stableKey(circular)).toThrow(/circular/);
    let calls = 0;
    const tools = cachedTools({ lookup: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 15)); return "ok"; } }, { dir: temp() });
    expect(await Promise.all([tools.lookup({ q: 1 }), tools.lookup({ q: 1 })])).toEqual(["ok", "ok"]);
    expect(calls).toBe(1);
  });

  it("freezes time and randomness and blocks fetch", async () => {
    const handle = installIsolation({ denyNetwork: true, seed: "test", fixedTime: "2026-01-01T00:00:00Z" });
    const first = Math.random();
    const uuid = randomUUID();
    expect(Date.now()).toBe(1767225600000);
    expect(Date()).toContain("2026");
    expect(() => fetch("https://example.com")).toThrow(/network isolation/);
    handle.restore();
    expect(Math.random()).not.toBe(first);
    const second = installIsolation({ seed: "test" });
    expect(randomUUID()).toBe(uuid);
    second.restore();
  });
});

describe("framework and protocol adapters", () => {
  it("imports OTLP spans into both trajectories and v2 cassettes", () => {
    const trace = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "chat gpt", attributes: [
      { key: "gen_ai.request.model", value: { stringValue: "gpt-test" } },
      { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify([{ role: "user", content: "hi" }]) } },
      { key: "gen_ai.output.text", value: { stringValue: "hello" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "3" } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: "1" } },
    ] }] }] }] };
    expect(traceToTrajectory(trace).output).toBe("hello");
    const cassette = traceToCassette(trace, "otel");
    expect(cassette.interactions[0].request.model).toBe("gpt-test");
    expect(cassette.metadata.source).toEqual({ type: "opentelemetry" });
  });

  it("adapts LangGraph state into a dry-run trajectory", async () => {
    const agent = langGraphAgent({ invoke: async () => ({ messages: [
      { role: "assistant", content: "", tool_calls: [{ id: "1", name: "search", args: { q: "x" } }] },
      { role: "tool", name: "search", tool_call_id: "1", content: "result" },
      { role: "assistant", content: "final" },
    ] }) });
    const trajectory = await agent("hi");
    expect(trajectory.output).toBe("final");
    expect(trajectory.steps.find((step) => step.kind === "tool")?.result).toBe("result");
  });

  it("supports generic HTTP, A2A and OpenAI Responses APIs", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        if (parsed.method === "message/send") res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { message: { parts: [{ kind: "text", text: "a2a-ok" }] } } }));
        else if (req.url === "/responses") res.end(JSON.stringify({ id: "resp_1", status: "completed", output_text: "responses-ok", output: [], usage: { input_tokens: 2, output_tokens: 1 } }));
        else res.end(JSON.stringify({ text: "http-ok", toolCalls: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      expect((await new HttpProvider({ url: `${base}/chat` }).chat({ model: "x", messages: [] })).text).toBe("http-ok");
      expect((await a2aAgent({ url: `${base}/a2a` })("hi")).output).toBe("a2a-ok");
      expect((await new OpenAIResponsesProvider({ apiKey: "test", baseURL: base }).chat({ model: "x", messages: [] })).text).toBe("responses-ok");
    } finally { server.close(); }
  });
});

describe("CI report formats", () => {
  it("writes JSON and SARIF reports", () => {
    const directory = temp();
    const summary = { results: [{ name: "broken", passed: false, assertions: [], durationMs: 1, error: "boom" }], total: 1, passed: 0, failed: 1, durationMs: 1 };
    const json = path.join(directory, "report.json");
    const sarif = path.join(directory, "report.sarif");
    writeJsonReport(json, summary);
    writeSarifReport(sarif, summary);
    expect(JSON.parse(readFileSync(json, "utf8")).schemaVersion).toBe(1);
    expect(JSON.parse(readFileSync(sarif, "utf8")).version).toBe("2.1.0");
  });
});
