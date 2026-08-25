import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../src/agent.ts";
import {
  autoCassette,
  CassetteStore,
  replayer,
} from "../src/cassette.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { evaluateAssertion, totalTokens } from "../src/assertions.ts";
import type { Trajectory } from "../src/types.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "dryrun-test-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("cassettes", () => {
  it("replays recorded traffic deterministically", async () => {
    const dir = tmpDir();
    let calls = 0;
    const store = new CassetteStore(dir);

    const recordAgent = defineAgent({
      provider: autoCassette("demo", () => {
        calls++;
        return new MockProvider([{ say: "recorded answer" }]);
      }, { dir }),
    });

    const first = await recordAgent("hi");
    expect(calls).toBe(1);
    expect(first.output).toBe("recorded answer");

    const replayAgent = defineAgent({
      provider: replayer(store, "demo"),
    });
    const second = await replayAgent("hi");
    expect(calls).toBe(1);
    expect(second.output).toBe("recorded answer");
  });

  it("autoCassette records once, then replays without constructing the provider again", async () => {
    const dir = tmpDir();
    let constructed = 0;
    const makeProvider = () => {
      constructed++;
      return new MockProvider([{ say: "pong" }]);
    };

    const first = defineAgent({ provider: autoCassette("auto-demo", makeProvider, { dir }) });
    await first("hello");
    expect(constructed).toBe(1);

    const second = defineAgent({ provider: autoCassette("auto-demo", makeProvider, { dir }) });
    const t = await second("hello");
    expect(constructed).toBe(1);
    expect(t.output).toBe("pong");
  });

  it("flags stale cassettes on model mismatch", async () => {
    const dir = tmpDir();
    const agent = defineAgent({
      provider: autoCassette("stale", () => new MockProvider([{ say: "old model" }]), { dir }),
      model: "gpt-4o-mini",
    });
    await agent("q");

    const replay = replayer(new CassetteStore(dir), "stale");
    await expect(
      replay.chat({ model: "gpt-99-turbo", messages: [] }),
    ).rejects.toThrow(/no longer matches[\s\S]*gpt-99-turbo/);
  });

  it("redacts secrets in both requests and responses", async () => {
    const dir = tmpDir();
    const agent = defineAgent({
      provider: autoCassette(
        "redact",
        () =>
          new MockProvider([
            { say: "got it, key sk-live-abcd1234567890abcdef and token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          ]),
        { dir },
      ),
    });
    await agent("my password is hunter2");

    const raw = JSON.stringify(await import("node:fs").then((fs) =>
      fs.readFileSync(new URL(`file://${dir}/redact.json`).pathname, "utf8"),
    ));
    expect(raw).not.toContain("sk-live-abcd");
    expect(raw).not.toContain("ghp_aaaa");
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain("hunter2");
  });

  it("tolerates wording drift but catches shape drift", async () => {
    const dir = tmpDir();
    const agent = defineAgent({
      provider: autoCassette("shape", () => new MockProvider([{ call: "ping" }, { say: "ok" }]), { dir }),
      tools: [{ name: "ping" }],
      execute: () => "pong",
    });
    await agent("first question");

    const replay = replayer(new CassetteStore(dir), "shape");
    await expect(
      replay.chat({
        model: "",
        messages: [{ role: "user", content: "totally different words" }],
        tools: [{ name: "ping" }],
      }),
    ).resolves.toBeTruthy();

    await expect(
      replay.chat({
        model: "",
        messages: [
          { role: "user", content: "again completely reworded" },
          { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "ping", arguments: {} }] },
          { role: "tool", content: "{}", toolCallId: "c1", name: "ping" },
        ],
        tools: [{ name: "ping" }, { name: "sneaky_extra_tool" }],
      }),
    ).rejects.toThrow(/no longer matches/);
  });
});

describe("new assertions", () => {
  const trajectoryWithUsage: Trajectory = {
    steps: [
      { kind: "llm", usage: { inputTokens: 100, outputTokens: 20 } },
      { kind: "llm", usage: { inputTokens: 50, outputTokens: 10 } },
    ],
    output: "",
  };

  it("maxTokens sums usage across steps", () => {
    expect(totalTokens(trajectoryWithUsage)).toBe(180);
    expect(evaluateAssertion({ type: "maxTokens", count: 200 }, trajectoryWithUsage).passed).toBe(true);
    expect(evaluateAssertion({ type: "maxTokens", count: 100 }, trajectoryWithUsage).passed).toBe(false);
  });

  it("maxTokens skips gracefully when no usage is recorded", () => {
    const r = evaluateAssertion(
      { type: "maxTokens", count: 100 },
      { steps: [{ kind: "llm" }], output: "" },
    );
    expect(r.skipped).toBe(true);
  });

  it("noRepeatedToolCalls detects runaway loops", () => {
    const looping: Trajectory = {
      steps: [toolStep("search"), toolStep("search"), toolStep("search"), toolStep("search")],
      output: "",
    };
    expect(evaluateAssertion({ type: "noRepeatedToolCalls" }, looping).passed).toBe(false);

    const fine: Trajectory = {
      steps: [toolStep("search"), toolStep("read"), toolStep("search")],
      output: "",
    };
    expect(evaluateAssertion({ type: "noRepeatedToolCalls" }, fine).passed).toBe(true);
  });
});

function toolStep(name: string) {
  return { kind: "tool" as const, toolCall: { id: "x", name, arguments: {} } };
}
