# dry-run

**Local-first evaluation, tracing, and deterministic E2E testing for AI agents.**
Evaluate quality. Replay real trajectories. Inspect everything locally.

[![npm](https://img.shields.io/npm/v/@muratkomurcu%2fdry-run)](https://www.npmjs.com/package/@muratkomurcu/dry-run)
[![CI](https://github.com/MuratKomurcu1/dry-run/actions/workflows/ci.yml/badge.svg)](https://github.com/MuratKomurcu1/dry-run/actions)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-5FA04E)](package.json)

<p align="center">
  <img src="docs/assets/dry-run-terminal.gif" alt="A real dry-run CLI replay completing an agent trajectory test offline" width="100%" />
</p>

`dry-run` combines dataset experiments, production quality rules, judge reliability, production intelligence, double-blind human review, a local prompt playground, agent traces, prompt versioning, red-team generation, a token-protected local Studio, and an opt-in self-hosted team server with its original cassette replay engine. Use live or local models when measuring quality; turn real failures into recorded regressions when every pull request must be deterministic, offline, and free.

**[Platform guide](docs/PLATFORM.md) · [Production loop](docs/PRODUCTION_LOOP.md) · [Operations](docs/OPERATIONS.md) · [Migrations](docs/MIGRATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Cassette v2 spec](docs/CASSETTE_SPEC.md) · [Benchmarks](docs/BENCHMARKS.md) · [Workflow audit](docs/LEADERSHIP.md) · [Evidence](docs/EVIDENCE.md) · [Security](SECURITY.md) · [Comparison](docs/COMPARISON.md)**

## The problem

Testing AI agents in CI is broken:

- **Live LLM calls are non-deterministic** — the same test passes locally, fails in CI
- **They're slow** — 5–30s per call destroys your feedback loop
- **They're expensive** — a full regression suite can cost more than your API budget

Unit-testing your prompts isn't enough either. Real failures happen in the *trajectory*: the agent calls the wrong tool, forgets to call a guardrail, loops forever.

## Two loops, one local platform

Quality evaluation and deterministic regression are different jobs. `dry-run` supports both:

1. **Evaluate:** run versioned datasets through exact, schema, retrieval, groundedness, trajectory, rubric, pairwise, privacy, budget, or custom scorers. Persist immutable experiment results and compare candidates against a baseline.
2. **Lock it down:** record a good real trajectory once, then replay it offline on every commit with no provider key, spend, or model variance.

### Production failure → reviewed regression

v0.8 closes the loop between observability and testing:

```text
production trace → sampled quality rule → failure queue → human decision
       → checksummed dataset + cassette + test → deterministic PR gate
```

Rules can enforce duration, cost, tokens, tools, tool errors, loops, output/schema/trajectory contracts, or a semantic rubric. Semantic checks and the playground can use a free local Ollama, vLLM, or LM Studio model; deterministic checks and replay need no model at all.

```bash
dry-run judge detect
dry-run online create --name "Production guard" --max-duration 3000 --no-tool-errors --no-loops --queue "Quality inbox"
dry-run online run --local-judge
dry-run promote trace <trace-id> --name "refund regression"
```

Team mode evaluates newly ingested traces through durable, idempotent background jobs and automatically mines failures into review queues. The dashboard adds Quality rules and a two-to-six-variant local Playground. See the [complete production-loop guide](docs/PRODUCTION_LOOP.md).

### Seven free platform layers

| Layer | Included implementation | Mandatory paid service |
| --- | --- | ---: |
| Distributed backend | PostgreSQL control records/outbox, S3 or MinIO artifacts, NATS JetStream jobs | None |
| Organization access | organizations, custom roles, groups, service accounts, key rotation, OIDC/SCIM | None |
| Python SDK | tracing, sync/async team client, experiment runner, pytest and framework hooks | None |
| Human review | single/double-blind/adjudicated flows, assignment, SLA, gold calibration | None |
| Production intelligence | release comparison, Wilson intervals, JS/KS drift, anomalies, clusters, root-cause ranking | None |
| Judge reliability | calibration, repeatability, agreement, bias, ensemble uncertainty and drift gates | None |
| Drop-in observability | authenticated OTLP HTTP JSON/protobuf with OpenInference semantic mapping | None |

Every layer runs locally or on infrastructure you control. “Free” means no required license, hosted account, or model/API purchase; compute, storage, networking, certificates, and operations remain the operator's responsibility.

### Four narrow, evidence-backed workflow advantages

An audit of public first-class workflows documented by DeepEval, Langfuse, Braintrust, and Promptfoo on 2026-08-26 found a Dry Run advantage in four backend workflows: deterministic no-network agent replay, durable production-failure routing, production trace → executable regression, and a tamper-evident dataset/cassette/test bundle. “Not documented” is not evidence that a competitor cannot implement the same workflow with private or custom code.

This is intentionally narrower than “best evaluation platform” or a statistical competitor ranking. A committed reproducible run completed 3,500/3,500 Dry Run replays, routed 1,400/1,400 Dry Run production traces without a duplicate review item, generated and verified 100/100 executable regression bundles, and detected 600/600 deliberate artifact mutations. Read the [definitions, confidence intervals, raw evidence, competitor-source audit, and limitations](docs/LEADERSHIP.md).

### Deterministic regression: VCR for agents

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
| `maxLLMCalls` / `maxDuration` / `maxCost` | call, latency, and cost regressions |
| `trajectory` / `toolOrder` | strict, unordered, subset, or superset path drift |
| `toolArgsSchema` / `outputJsonSchema` | malformed tool input or structured output |
| `noToolErrors` | swallowed tool failures |
| `custom` | sync or async project-specific gates |
| `semantic` *(opt-in)* | fuzzy quality via LLM-as-judge |

## Measured replay overhead

The committed implementation check runs 250 fresh single-turn cassette replayers per suite, including disk reads and a deterministic output assertion:

| Measurement | Result |
| --- | ---: |
| 250-scenario in-process median | **7.55 ms** |
| In-process p95 | **8.89 ms** |
| Fresh Node process + real example CLI median | **46.97 ms** |
| Provider network calls / provider cost | **0 / $0** |

These are v0.4 cassette-v2 canonical/checksum replay results on Apple M5, Node 26.7.0 and a warm filesystem—not a live-provider comparison or universal guarantee. The [methodology, raw samples, limitations, and rerun command](docs/BENCHMARKS.md) are public.

## Quickstart

```bash
npm install --save-dev @muratkomurcu/dry-run
npx @muratkomurcu/dry-run init     # scaffold tests/smoke.agentest.ts
npx @muratkomurcu/dry-run run      # green in milliseconds, offline
```

## Dataset experiments

Create `quality.eval.ts`:

```ts
import {
  Dataset,
  exactMatchScorer,
  groundednessScorer,
  toolCorrectnessScorer,
} from "@muratkomurcu/dry-run";

export default {
  name: "support-agent-quality",
  dataset: Dataset.create("support-golden", [
    {
      id: "refund-policy",
      input: "How long do I have to request a refund?",
      expected: "30 days",
      retrievalContext: ["Refunds are available for 30 days after purchase."],
      expectedTools: [{ name: "search_policy", arguments: { topic: "refund" } }],
      tags: ["support", "rag"],
    },
  ]),
  task: async (input, { signal }) => myAgent(input, { signal }),
  scorers: [
    exactMatchScorer(),
    groundednessScorer(),
    toolCorrectnessScorer(),
  ],
};
```

Run, repeat, compare, and inspect:

```bash
dry-run eval quality.eval.ts --concurrency 8 --trials 3 --retries 1
dry-run experiments list
dry-run experiments compare <baseline-id> <candidate-id>
dry-run studio                    # loopback-only, random bearer token, opens locally
```

Each case automatically creates nested `task → agent → scorer` spans. Results, 95% confidence intervals, token/cost totals, Git SHA, feedback, and traces remain under `.dryrun/` with owner-only atomic persistence.

### Scorers and datasets

The catalog exposes 63 ready-to-compose scorer constructors: exact/contains/regex/edit similarity, token precision/recall/F1, Jaccard, BLEU, ROUGE-N/ROUGE-L, character F-score, keyword coverage, completeness/conciseness/length, JSON Schema, strict/unordered/subset/superset trajectory matching, tool-call precision/recall/F1, latency/token/cost budgets, retrieval precision/recall/hit-rate/average-precision@k, MRR, nDCG, citation correctness/completeness, contextual precision/recall/relevancy, deterministic groundedness, PII/secret/system-prompt leakage, authorized-tool and refusal controls, weighted rubric judging, blind pairwise preference, multi-judge consensus, scorer DAGs, composite scorers, and fully custom sync/async scorers. Multi-turn metrics cover completeness, coherence, retained facts, role adherence, and safety. Multimodal metrics cover modality coverage, media metadata/digest integrity, groundedness, cross-modal consistency, and a provider-neutral judge. Judge wrappers accept any `LLMProvider`, including local Ollama/vLLM-compatible endpoints, and fail closed; consensus rejects excessive judge spread instead of hiding disagreement behind an average.

Datasets load JSON, JSONL/NDJSON, or CSV, receive deterministic case IDs and checksums, and can be filtered, tagged, imported, or split reproducibly:

```bash
dry-run dataset validate cases.jsonl
dry-run dataset import cases.csv -o .dryrun/datasets/support.json
dry-run dataset split .dryrun/datasets/support.json --ratio 0.8
dry-run dataset red-team .dryrun/datasets/support.json --attacks prompt-injection,base64
```

Synthetic generation is provider-pluggable, so a local model works without a paid service. The red-team generator itself is deterministic and offline: 40 single-turn transformations cover 15 core vulnerability classes, plus 10 conversation attacks and 8 multimodal injection/conflict attacks. The exported catalogs make every case inspectable. Canary, forbidden-output, secret, system-prompt, refusal, conversation-safety, media-integrity, and unauthorized-tool scorers turn those cases into repeatable gates.

### Versioned prompts

```bash
dry-run prompts publish support-answer prompt.txt --label candidate
dry-run prompts label support-answer 2 production
dry-run prompts render support-answer --label production --values '{"question":"refunds"}'
```

Prompt versions are immutable and checksummed; labels such as `candidate` and `production` are movable pointers. Studio shows experiments, traces, and prompt history without a hosted account.

### Free self-hosted team mode

Local mode remains the default. Team mode is an explicit, account-free server for sharing selected projects on infrastructure you control:

```bash
dry-run team init --name "AI Quality"
# Save the one-time admin token printed by init:
export DRYRUN_TEAM_TOKEN='drk_...'

dry-run team key create --name production-ingest --role ingest --projects default
dry-run team invite create --email reviewer@example.com --role editor --projects default
dry-run team serve                         # loopback dashboard + API
```

The invite token is displayed once and shared through a secure channel. A reviewer joins without a paid identity provider; the invitation token is read from the environment rather than process arguments:

```bash
export DRYRUN_INVITATION_TOKEN='dri_...'
dry-run team join --endpoint https://quality.example.com --name "Ada Reviewer"
```

Remote deployments refuse plaintext by default. Terminate TLS in the process:

```bash
dry-run team serve --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem --no-open
```

The server provides an organization identity, custom least-privilege roles, dynamic groups and project scopes, named member identities, one-time invitations, expiring member tokens, service accounts, key rotation with a grace window, and active/suspended lifecycle. Standards-based OIDC Authorization Code + PKCE SSO and SCIM 2.0 provisioning are optional. Token hashes—not raw tokens—are persisted. It also provides attributable JSONL/CSV audit export, revisioned object policies, double-blind/adjudicated review programs, remote trace/experiment ingestion, continuously evaluated quality monitors, production intelligence, judge-reliability reports, configurable retention, bounded reads/quotas/backpressure, and a no-external-assets dashboard. Scoped admins cannot cross into workspace administration. None of these features requires a paid component.

Multiple team-server nodes can run without shared POSIX storage. PostgreSQL holds revisioned control state and serialized migrations, S3-compatible MinIO holds encrypted immutable workspace snapshots plus content-addressed trace batches, and NATS JetStream carries transactional events with a dead-letter/redrive path. Trace batches use one NDJSON object and one PostgreSQL transaction for as many as 500 traces. Public liveness/readiness probes, authenticated low-cardinality Prometheus metrics, graceful draining, and an open-source Caddy + Keycloak + PostgreSQL + MinIO + NATS + ClickHouse + Prometheus + Grafana reference stack are included. Set a private 32+ character `DRYRUN_STATE_ENCRYPTION_KEY` before starting the distributed profile:

```bash
docker compose --env-file deploy/.env -f deploy/compose.ha.yml up -d --build
```

The built-in control-plane UI adds guided setup diagnostics, a provider-free demo workspace, previewable DeepEval/Langfuse/Braintrust imports, production time-series/facet analytics, statistical release intelligence, p50/p95/p99 latency, persistent SLO monitors, trace hierarchy/timeline/conversation/raw views, experiment scores and confidence intervals, judge reliability, organization governance, and single/double-blind/adjudicated review workflows. See the [operations guide](docs/OPERATIONS.md) for Compose and Helm deployment, secrets, production TLS, portable recovery points, DLQ redrive, SLOs, and the exact boundary between shipped reliability controls and a vendor-operated SLA.

Application traces can use a disk-backed at-least-once spool, so a temporary server outage does not discard them:

```ts
import { RemoteTraceExporter, Tracer } from "@muratkomurcu/dry-run";

const exporter = new RemoteTraceExporter({
  endpoint: "https://quality.example.com",
  project: "default",
  token: process.env.DRYRUN_TEAM_TOKEN!,
  maxSpoolBytes: 512 * 1024 * 1024,
  maxSpoolFiles: 50_000,
});
const tracer = new Tracer([exporter]);
```

Existing OpenTelemetry SDKs can send OTLP directly—no Dry Run instrumentation wrapper is required. Both OTLP HTTP JSON and protobuf are accepted, and OpenInference span attributes map into native agent/LLM/tool/retriever spans:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4320'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf' # http/json also works
export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer drk_...,x-dry-run-project=default'
```

See the [platform guide](docs/PLATFORM.md#10-run-free-self-hosted-team-mode) and [security boundary](SECURITY.md#self-hosted-team-server) before exposing it remotely.

### The headline: record once, replay forever

Wrap any provider in `autoCassette`:

```ts
import { defineAgent, OpenAIProvider, autoCassette } from "@muratkomurcu/dry-run";

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

**Verified replay.** New cassettes default to canonical request matching: prompt content, prior tool results and arguments, model, tool schemas, response format, and generation parameters participate in the fingerprint. A mismatch fails with a redacted field-level diff instead of serving plausible but wrong data. Choose `exact`, `canonical`, or the deliberately looser `shape` policy per cassette; migrated v1 recordings retain `shape` for compatibility.

Every v2 cassette carries a schema version, producer/runtime provenance, Git SHA when available, redaction policy, three request fingerprints, creation timestamps, and a SHA-256 integrity checksum. Upgrade and validate committed fixtures explicitly:

```bash
dry-run cassette migrate .dryrun/cassettes/*.json
dry-run cassette verify .dryrun/cassettes/*.json
```

**Secret-shaped values are redacted by default.** Cassettes are filtered before they touch disk (`sk-…`, `Bearer …`, JWTs, AWS keys, and scalar values stored under credential-like keys). Redaction is defense in depth, not a guarantee: review cassettes before committing them and read the [security boundary](SECURITY.md).

Cassettes are plain JSON — review them in PRs next to your prompt changes.

## Slow or flaky tools? Cache them too.

```ts
import { cachedTools } from "@muratkomurcu/dry-run";

execute: (call) => myTools[call.name](call.arguments)
// becomes:
const safeTools = cachedTools({ lookup_order, charge_card });  // recorded & replayed at the tool boundary
```

First run hits the real API; every later run replays recorded results — even for paid third-party APIs. Cache keys use a typed canonical serializer, concurrent writers use file locks, and writes are atomic.

## Works with Vercel AI SDK

Drop-in model wrapper — test your real `generateText` / `streamText` pipelines offline. Recorded stream events preserve text/tool event order and optional timing offsets:

```ts
import { generateText } from "ai";
import { vercelAIModel, MockProvider } from "@muratkomurcu/dry-run";

const { text } = await generateText({
  model: vercelAIModel(myCassetteBackedProvider),
  prompt: "Refund order #1234",
});
```

Write a scenario:

```ts
import { defineAgent, scenario } from "@muratkomurcu/dry-run";

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
import { defineAgent, OpenAIProvider, AnthropicProvider } from "@muratkomurcu/dry-run";

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

Native providers ship for **OpenAI Chat Completions**, **OpenAI Responses API**, and **Anthropic (Claude)** — and any
OpenAI-compatible endpoint works out of the box, including **Ollama**,
**LiteLLM**, **vLLM**, and **Azure OpenAI** via `OPENAI_BASE_URL`.

Framework/protocol bridges are also included:

- `openAIAgentsAgent()` and `createDryRunTraceProcessor()` for OpenAI Agents SDK-style runs and spans;
- `langGraphAgent()` / `trajectoryFromLangGraph()` for LangGraph state;
- `traceToCassette()` / `traceToTrajectory()` for OTLP JSON and Jaeger JSON;
- `HttpProvider` for arbitrary JSON APIs and `a2aAgent()` for A2A `message/send` endpoints.

Existing evaluation history is portable. Documented JSON exports from DeepEval, Langfuse, and Braintrust can be normalized into checksummed Dry Run datasets and nested traces:

```bash
dry-run migrate deepeval deepeval-export.json -o dry-run-import.json
dry-run migrate langfuse langfuse-export.json -o dry-run-import.json
dry-run migrate braintrust braintrust-export.json -o dry-run-import.json
```

The importer is a clean-room schema adapter, preserves historical scores as metadata/feedback, redacts secret-shaped values, and reports lossy mappings instead of inventing data. See [Migrations](docs/MIGRATIONS.md).

## Add to CI

Drop this into your workflow:

```yaml
- uses: MuratKomurcu1/dry-run/.github/actions/dry-run@v0.8.0
  with:
    paths: tests
    mode: replay          # never dial out from CI
    junit-path: report.xml
    deny-network: true
    matching: canonical
```

To compare two stored experiments in a PR, give the workflow `issues: write`, pass both experiment references, and enable the idempotent quality comment:

```yaml
permissions:
  contents: read
  issues: write

steps:
  - uses: MuratKomurcu1/dry-run/.github/actions/dry-run@v0.8.0
    with:
      baseline-experiment: .dryrun/experiments/baseline.json
      candidate-experiment: .dryrun/experiments/candidate.json
      pr-comment: true
```

Fork pull requests normally receive a read-only token; in that case keep `pr-comment: false` and upload the generated Markdown/job summary instead of using a privileged `pull_request_target` workflow for untrusted code.

Or roll your own — it's one command:

```yaml
- run: npx @muratkomurcu/dry-run run tests --replay --junit report.xml
```

JUnit XML plugs into GitHub, GitLab, Jenkins, and everything else. `--github` writes native annotations and a job summary; `--json` and `--sarif` provide machine-readable artifacts.

## Recording cassettes

```ts
import { CassetteStore, recorder, replayer } from "@muratkomurcu/dry-run";

const store = new CassetteStore();

// Record (run locally, once):
const recorded = recorder(new OpenAIProvider(), store, "support-flow");

// Replay (run in CI):
const agent = defineAgent({ provider: replayer(store, "support-flow"), ... });
```

## Regression toolkit

**Generate tests from cassettes.** Recorded a run once? Turn it into an editable scenario:

```bash
dry-run generate .dryrun/cassettes/support-refund.json -o tests/refund.agentest.ts
```

The generated file references `autoCassette("support-refund")` — commit both and CI replays real model traffic offline, with assertions pre-filled from what actually happened.

**Generate a cassette from a trace.** No provider wrapper is required when the agent already emits OpenTelemetry or Jaeger JSON:

```bash
dry-run import-trace trace.json -o .dryrun/cassettes/support-flow.json --name support-flow
dry-run generate .dryrun/cassettes/support-flow.json -o tests/support.agentest.ts
```

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

**Scale the same suite locally and in CI.** Selection is stable and the final result order remains deterministic:

```bash
dry-run run tests --tag smoke --filter refund --concurrency 8 --trials 3 --retries 1
dry-run run tests --shard 2/4 --json result.json --sarif result.sarif --github
```

Skipped judges or unavailable token/cost metrics fail closed by default. `--allow-skipped` must be explicit.

**Replay with an isolation boundary.** On Node 26+, `--deny-network` re-executes the suite under Node's network permission boundary and also installs guards for `fetch`, HTTP(S), sockets, TLS, and UDP. Older supported Node versions receive the guards and print that the stronger permission boundary requires Node 26+. `--seed` and `--time` make `Math.random`, `randomUUID`, `Date`, and `Date.now` repeatable.

```bash
dry-run run tests --replay --deny-network --seed pr-184 --time 2026-01-01T00:00:00Z
```

This blocks accidental network access; scenario code is still trusted executable code, not a general-purpose untrusted-code sandbox.

## Where it fits

`dry-run` covers the local core shared by evaluation and observability products: datasets, 63 scorer constructors, multi-turn/multimodal cases, repeated experiments, baseline comparison, feedback, traces/spans, prompt versions, synthetic/adversarial cases, statistical production intelligence, judge reliability, local Studio, and an optional self-hosted team control plane. Its differentiator is that the same package also turns a selected real run into a checksummed cassette and enforces that trajectory offline in ordinary CI.

Team mode is self-hosted infrastructure, not a managed SaaS. It has organization governance, custom roles/groups, service identities, OIDC/SCIM, stateless application nodes, encrypted distributed state, batched trace ingestion, shared ClickHouse analytics, continuous quality monitors, paginated reads, agreement-aware review, attributable audit, quota telemetry, readiness/Prometheus signals, portable recovery points, and race-safe retention. It still does not provide a vendor on-call team, contractual SLA, managed cross-region replication, billing, or password/social authentication. Use `dry-run` when local ownership, source-controlled evidence, deterministic CI, and zero required license/service cost matter; keep a managed platform when buying operations is the requirement. See [the evidence-based comparison](docs/COMPARISON.md).

## Python runtime

The dependency-free Python 3.10+ runtime under [`python/`](python/) reads the same cassettes and provides `CassetteStore`, `Replayer`, tracing spans/exporters, a secure sync/async `TeamClient`, a bounded experiment runner, a pytest plugin, and duck-typed LangChain, LlamaIndex, OpenAI, Anthropic, DSPy, and CrewAI hooks. It also exposes deterministic/semantic RAG, conversation, multimodal, trajectory, privacy, and red-team metrics. Build the wheel locally with `python3 -m pip wheel --no-deps ./python`. The release workflow can publish the npm package, Python wheel, GHCR image, CycloneDX SBOM, checksums, and GitHub provenance after the corresponding free registry credentials/environment are configured.

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

Release history and the reproducible release gate live in [CHANGELOG.md](CHANGELOG.md) and [docs/RELEASE.md](docs/RELEASE.md).

## Configuration

Optional `dryrun.config.json` at your repo root:

```json
{
  "include": ["tests"],
  "mode": "auto",
  "junitPath": "report.xml",
  "concurrency": 4,
  "retries": 1,
  "trials": 2,
  "tags": ["smoke"],
  "excludeTags": ["live"],
  "allowSkipped": false,
  "judge": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
}
```

CLI flags override config values.

## License

[MIT](./LICENSE)
