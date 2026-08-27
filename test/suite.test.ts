import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../src/agent.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { autoCassette, CassetteStore, parseCassette } from "../src/cassette.ts";
import type { Interaction } from "../src/cassette.ts";
import { diffCassette } from "../src/diff.ts";
import { compareGolden, loadGolden, saveGolden, toGoldenEntry } from "../src/golden.ts";
import { generateScenario } from "../src/generate.ts";
import { renderHtml } from "../src/html-report.ts";
import { runScenarios } from "../src/runner.ts";
import { scenario } from "../src/scenario.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "dryrun-suite-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function recordFixture(dir: string, name: string, say: string): Promise<Interaction[]> {
  const agent = defineAgent({
    provider: autoCassette(name, () => new MockProvider([{ call: "ping" }, { say }]), {
      dir,
    }),
    tools: [{ name: "ping" }],
    execute: () => "pong",
    model: "test-model",
  });
  await agent("hello");
  const raw = await import("node:fs").then((fs) =>
    fs.readFileSync(path.join(dir, `${name}.json`), "utf8"),
  );
  return parseCassette(JSON.parse(raw), name).interactions;
}

describe("diff", () => {
  it("reports identical cassettes as clean", async () => {
    const dir = tmpDir();
    const a = await recordFixture(dir, "same", "answer one");
    const b = structuredClone(a);
    expect(diffCassette(a, b)).toEqual([]);
  });

  it("detects model, tool-sequence, args and output drift", async () => {
    const dir = tmpDir();
    const a = await recordFixture(dir, "drift-a", "the original answer");
    const b = await recordFixture(dir, "drift-b", "a totally different reply");

    const drifts = diffCassette(a, b);
    const types = drifts.map((d) => d.type);
    expect(types).toContain("OUTPUT");

    const swapped = structuredClone(a);
    swapped[0].response.toolCalls[0].name = "renamed_tool";
    expect(diffCassette(a, swapped).map((d) => d.type)).toContain("TOOL_SEQUENCE");

    const extraCall = [...a, a[0]];
    expect(diffCassette(a, extraCall).map((d) => d.type)).toContain("CALL_COUNT");

    const modelChanged = structuredClone(a);
    for (const i of modelChanged) i.request.model = "other-model";
    expect(diffCassette(a, modelChanged).map((d) => d.type)).toContain("MODEL");
  });
});

describe("golden", () => {
  it("save → check roundtrip passes and detects drift", async () => {
    const dir = tmpDir();
    const run = async () => {
      const captured: ReturnType<typeof toGoldenEntry>[] = [];
      await runScenarios([
        scenario({
          name: "g · stable",
          agent: defineAgent({ provider: new MockProvider([{ say: "stable output" }]) }),
          input: "x",
          expect: [{ type: "outputContains", value: "stable" }],
        }),
      ], {
        onTrajectory: (n, t) => captured.push(toGoldenEntry(n, t)),
      });
      return captured;
    };

    const first = await run();
    const file = path.join(dir, "golden.json");
    saveGolden(file, first);

    const baseline = loadGolden(file).entries;
    const second = await run();
    expect(compareGolden(baseline, second)).toEqual([
      { name: "g · stable", status: "pass", changes: [] },
    ]);

    const driftedAgent = defineAgent({ provider: new MockProvider([{ say: "changed!" }]) });
    let driftedEntry: ReturnType<typeof toGoldenEntry> | undefined;
    await runScenarios([
      scenario({ name: "g · stable", agent: driftedAgent, input: "x", expect: [] }),
    ], { onTrajectory: (_n, t) => { driftedEntry = toGoldenEntry(_n, t); } });

    const diffs = compareGolden(baseline, [driftedEntry!]);
    expect(diffs[0].status).toBe("drift");
    expect(diffs[0].changes[0]).toContain("output changed");
  });

  it("flags missing and new scenarios", () => {
    const base = [{ name: "old", toolCalls: [], output: "" }];
    const cur = [{ name: "new", toolCalls: [], output: "" }];
    const diffs = compareGolden(base as never, cur as never);
    expect(diffs.map((d) => d.status).sort()).toEqual(["missing", "new"]);
  });

  it("detects token regressions with an optional tolerance", () => {
    const base = [{ name: "tokens", toolCalls: [], output: "ok", tokens: 100 }];
    const current = [{ name: "tokens", toolCalls: [], output: "ok", tokens: 112 }];
    expect(compareGolden(base, current)[0].status).toBe("drift");
    expect(compareGolden(base, current, { tokenTolerance: 20 })[0].status).toBe("pass");
  });
});

describe("generate", () => {
  it("produces a runnable scenario that replays the recorded cassette", async () => {
    const dir = tmpDir();
    const interactions = await recordFixture(dir, "gen-demo", "generated replay works");

    const source = generateScenario(interactions, {
      scenarioName: "gen-demo",
      importFrom: path.resolve("src/index.ts"),
    });

    const testFile = path.join(dir, "gen.agentest.ts");
    await import("node:fs").then((fs) => fs.writeFileSync(testFile, source));

    process.env.DRYRUN_CASSETTE_DIR = dir;
    const mod = await import(`${pathToFileURL(testFile).href}?bust=${Date.now()}`);
    delete process.env.DRYRUN_CASSETTE_DIR;

    const summary = await runScenarios(mod.default);
    expect(summary.failed).toBe(0);
    expect(summary.results[0].assertions.length).toBeGreaterThanOrEqual(3);
  });
});

describe("html report", () => {
  it("renders scenarios, steps and assertions", async () => {
    const agent = defineAgent({ provider: new MockProvider([{ call: "search" }, { say: "found it" }]) });
    let traj: import("../src/types.ts").Trajectory | undefined;
    const summary = await runScenarios([
      scenario({
        name: "html demo",
        agent,
        input: "q",
        expect: [{ type: "outputContains", value: "found" }],
      }),
    ], { onTrajectory: (_n, t) => { traj = t; } });

    const html = renderHtml([
      {
        name: summary.results[0].name,
        passed: true,
        durationMs: summary.results[0].durationMs,
        assertions: summary.results[0].assertions,
        trajectory: traj!.steps.map((s) =>
          s.kind === "tool"
            ? { kind: "tool" as const, name: s.toolCall?.name, args: s.toolCall?.arguments }
            : { kind: "llm" as const, text: s.response },
        ),
        output: traj!.output,
        goldenDiff: { status: "pass", changes: [] },
      },
    ]);

    expect(html).toContain("html demo");
    expect(html).toContain("TOOL");
    expect(html).toContain("LLM");
    expect(html).toContain("found it");
    expect(html).toContain("golden:");
  });
});
