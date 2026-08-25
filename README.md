# dry-run

**Deterministic end-to-end testing for AI agents.**
Record once. Replay forever. Ship with confidence.

[![npm](https://img.shields.io/npm/v/dry-run)](https://www.npmjs.com/package/dry-run)
[![CI](https://github.com/muratkomurcu/dry-run/actions/workflows/ci.yml/badge.svg)](https://github.com/muratkomurcu/dry-run/actions)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

<!-- TODO: replace with a real GIF of `npx dry-run run` output -->

## The problem

Testing AI agents in CI is broken:

- **Live LLM calls are non-deterministic** — the same test passes locally, fails in CI
- **They're slow** — 5–30s per call destroys your feedback loop
- **They're expensive** — a full regression suite can cost more than your API budget

Unit-testing your prompts isn't enough either. Real failures happen in the *trajectory*: the agent calls the wrong tool, forgets to call a guardrail, loops forever.

## The fix: VCR for agents

`dry-run` records your agent's actual LLM traffic into **cassettes**, then replays them deterministically on every CI run — milliseconds, zero dollars, byte-for-byte reproducible.

```
┌─────────┐   record    ┌───────────┐    replay     ┌──────────────┐
│ live run│ ──────────▶ │ cassettes │ ────────────▶ │ every commit │
└─────────┘  (once)     └───────────┘  (free, ms)  └──────────────┘
```

Then assert on what actually matters:

| Assertion | What it catches |
|---|---|
| `toolCalled` / `notToolCalled` | wrong or missing tool usage |
| `argsContains` | wrong arguments to tools |
| `outputContains` / `outputEquals` / `outputMatches` | bad final answers |
| `maxSteps` | runaway loops and step inflation |
| `noRepeatedToolCalls` | agents stuck calling the same tool over and over |
| `maxTokens` | token budget violations |
| `semantic` *(opt-in)* | fuzzy quality via LLM-as-judge |

## Quickstart

```bash
npx dry-run init     # scaffold tests/smoke.agentest.ts
npx dry-run run      # green in milliseconds, offline
```

### The headline: record once, replay forever

Wrap any provider in `autoCassette`:

```ts
import { defineAgent, OpenAIProvider, autoCassette } from "dry-run";

const provider = autoCassette("support-flow", () => new OpenAIProvider({ model: "gpt-4o-mini" }));
```

Then:

```bash
dry-run run             # first run records the cassette (.dryrun/cassettes/support-flow.json)
dry-run run             # every later run replays it — $0, milliseconds, byte-for-byte
dry-run run --replay    # CI mode: never dial out; a stale cassette fails loudly
dry-run run --record    # intentionally re-record
dry-run run --watch     # re-run on every save — TDD for agents
```

**Verified replay.** Replays are matched by conversation *shape* (roles, tool calls, tools, model) — not by exact strings. Reword a prompt and the cassette still works. Change the shape and it fails loudly with a diff instead of silently serving wrong data.

**Secret-safe by default.** Cassettes are redacted before they touch disk (`sk-…`, `Bearer …`, JWTs, AWS keys, and anything stored under a key named like a credential). Commit them without fear.

Cassettes are plain JSON — review them in PRs next to your prompt changes.

## Slow or flaky tools? Cache them too.

```ts
import { cachedTools } from "dry-run";

execute: (call) => myTools[call.name](call.arguments)
// becomes:
const safeTools = cachedTools({ lookup_order, charge_card });  // recorded & replayed at the tool boundary
```

First run hits the real API; every later run replays recorded results — even for paid third-party APIs.

## Works with Vercel AI SDK

Drop-in model wrapper — test your real `generateText` / `streamText` pipelines offline:

```ts
import { generateText } from "ai";
import { vercelAIModel, MockProvider } from "dry-run";

const { text } = await generateText({
  model: vercelAIModel(myCassetteBackedProvider),
  prompt: "Refund order #1234",
});
```

Write a scenario:

```ts
import { defineAgent, scenario } from "dry-run";

export default [
  scenario({
    name: "support agent refunds correctly",
    agent: mySupportAgent,          // any (input) => Promise<Trajectory>
    input: "I want a refund for order #1234",
    expect: [
      { type: "toolCalled", tool: "lookup_order", argsContains: { id: "1234" } },
      { type: "toolCalled", tool: "issue_refund", times: 1 },
      { type: "notToolCalled", tool: "delete_account" },
      { type: "outputContains", value: "refund" },
      { type: "maxSteps", count: 6 },
    ],
  }),
];
```

Run it:

```
 ✓ support agent refunds correctly (3ms)
     ✓ calls tool "lookup_order"
     ✓ calls tool "issue_refund"
     ✓ never calls tool "delete_account"
     ✓ output contains "refund"
     ✓ uses at most 6 steps

 All 1 scenario(s) passed · 3ms
```

## Works with any agent

Bring your own loop — anything that returns a `{ steps, output }` trajectory works.
Or use the built-in ReAct harness:

```ts
import { defineAgent, OpenAIProvider, AnthropicProvider } from "dry-run";

export const gptAgent = defineAgent({
  provider: new OpenAIProvider({ model: "gpt-4o-mini" }),
  system: "You are a helpful support agent.",
  tools: [lookupOrder, issueRefund],
  execute: (call) => myToolRegistry.run(call),
});

export const claudeAgent = defineAgent({
  provider: new AnthropicProvider({ model: "claude-sonnet-4-5" }),
  system: "You are a helpful support agent.",
  tools: [lookupOrder, issueRefund],
  execute: (call) => myToolRegistry.run(call),
});
```

Native providers ship for **OpenAI** and **Anthropic (Claude)** — and any
OpenAI-compatible endpoint works out of the box, including **Ollama**,
**LiteLLM**, **vLLM**, and **Azure OpenAI** via `OPENAI_BASE_URL`.

## Add to CI

Drop this into your workflow:

```yaml
- uses: muratkomurcu/dry-run/.github/actions/dry-run@main
  with:
    paths: tests
    mode: replay          # never dial out from CI
    junit-path: report.xml
```

Or roll your own — it's one command:

```yaml
- run: npx dry-run run tests --replay --junit report.xml
```

JUnit XML plugs into GitHub test annotations, GitLab, Jenkins, and everything else.

## Recording cassettes

```ts
import { CassetteStore, recorder, replayer } from "dry-run";

const store = new CassetteStore();

// Record (run locally, once):
await using recorded = recorder(new OpenAIProvider(), store, "support-flow");

// Replay (run in CI):
const agent = defineAgent({ provider: await replayer(store, "support-flow"), ... });
```

## Regression toolkit

**Generate tests from cassettes.** Recorded a run once? Turn it into an editable scenario:

```bash
dry-run generate .dryrun/cassettes/support-refund.json -o tests/refund.agentest.ts
```

The generated file references `autoCassette("support-refund")` — commit both and CI replays real model traffic offline, with assertions pre-filled from what actually happened.

**Diff two cassettes.** Did this prompt change actually change behavior?

```bash
$ dry-run diff .dryrun/cassettes/v1.json .dryrun/cassettes/v2.json
 1 drift(s) detected
   OUTPUT "Your refund for order #1234 has been processed."
      → "Your refund has been escalated to a manager."
```

Exit code `1` on drift — drop it straight into CI.

**Golden baselines.** Lock in current behavior across all scenarios, then fail on any deviation:

```bash
dry-run golden save baseline     # snapshot tool paths + outputs
dry-run golden check baseline    # exit 1 if anything drifted
```

**HTML trajectory reports.** Every step your agent took, visualized:

```bash
dry-run run tests --replay --html report.html   # self-contained file, dark mode, zero JS deps
```

With a golden baseline present, each scenario shows its drift status inline.

## Why not promptfoo / deepeval?

Those are great **eval** tools. `dry-run` is an **E2E test** tool — closer to Playwright than to a benchmark:

| | Eval frameworks | dry-run |
|---|---|---|
| Deterministic in CI | ✗ (live model variance) | ✓ (cassette replay) |
| Cost per run | $$ per case | $0 |
| Speed | seconds–minutes | **milliseconds** |
| Asserts on trajectories | limited | first-class |
| Loop / budget detection | rare | `noRepeatedToolCalls`, `maxTokens` |
| Stale cassette detection | — | shape-signature fails loudly |
| Test generation from runs | — | `generate` |
| Golden-set regression gates | — | `golden save/check` + `diff` |
| Trajectory visualization | cloud dashboards | self-contained HTML report |
| Fails like a unit test | report-style | exit code + assertion diff + JUnit |

## Roadmap

- [ ] Python SDK (`pip install dry-run`)
- [ ] LangGraph.js / Claude Agent SDK adapters
- [ ] Streaming + MCP tool-call recording

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## Configuration

Optional `dryrun.config.json` at your repo root:

```json
{
  "include": ["tests"],
  "mode": "auto",
  "junitPath": "report.xml",
  "judge": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
}
```

CLI flags override config values.

## License

[MIT](./LICENSE)
