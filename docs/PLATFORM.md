# Local evaluation platform

This guide covers the v0.8 dataset, scorer, experiment, tracing, online evaluation, feedback, local playground, prompt, generation, Studio, analytics, and self-hosted team APIs. All persistent state is local under `.dryrun/` by default; networked team mode is opt-in.

## 1. Define a dataset experiment

```ts
import {
  Dataset,
  exactMatchScorer,
  toolCorrectnessScorer,
  groundednessScorer,
  type ExperimentDefinition,
} from "@muratkomurcu/dry-run";

const experiment: ExperimentDefinition = {
  name: "support-quality",
  dataset: Dataset.create("support-golden", [
    {
      id: "refund",
      input: "What is the refund window?",
      expected: "30 days",
      retrievalContext: ["Refunds are available for 30 days after purchase."],
      expectedTools: [{ name: "search_policy", arguments: { topic: "refund" } }],
    },
  ]),
  task: async (input, { signal, trial, caseId }) => {
    return myAgent(input, { signal, metadata: { trial, caseId } });
  },
  scorers: [exactMatchScorer(), groundednessScorer(), toolCorrectnessScorer()],
};

export default experiment;
```

The task may return a plain value, a Dry Run `Trajectory`, or `{ output, trajectory, metadata }`.

```bash
dry-run eval quality.eval.ts --concurrency 8 --trials 3 --retries 1 --timeout 30000
```

Exit code is non-zero when any case fails. Results are progressively and atomically stored, so an interrupted run can continue:

```bash
dry-run eval quality.eval.ts --resume support-quality_<id>
```

Resume refuses changed dataset checksums, experiment names, or scorer configuration.

## 2. Compare experiments

```bash
dry-run experiments list
dry-run experiments show <id>
dry-run experiments compare <baseline-id> <candidate-id>
```

Comparison exits non-zero on a case regression or negative aggregate score delta, making it suitable for CI gates.

## 3. Compose scorers

```ts
import {
  compositeScorer,
  contextualPrecisionScorer,
  contextualRecallScorer,
  groundednessScorer,
  piiSafetyScorer,
  rubricScorer,
} from "@muratkomurcu/dry-run";

const quality = compositeScorer("quality", [
  { scorer: contextualPrecisionScorer(), weight: 1 },
  { scorer: contextualRecallScorer(), weight: 2 },
  { scorer: groundednessScorer(), weight: 3 },
  { scorer: piiSafetyScorer(), weight: 4 },
], 0.8);

const rubric = rubricScorer({
  provider: localOrRemoteProvider,
  model: "judge-model",
  threshold: 0.8,
  criteria: [
    { name: "correct", description: "All claims are factually correct", weight: 3 },
    { name: "direct", description: "The answer directly addresses the request", weight: 1 },
  ],
});
```

`defineScorer(name, implementation, threshold)` is the extension point for project-specific sync or async metrics. Errors and invalid/non-finite values become failed scores.

Traditional deterministic metrics are available alongside model judges:

```ts
import {
  bleuScorer,
  characterFScoreScorer,
  rougeNScorer,
  rougeLScorer,
  retrievalPrecisionScorer,
  retrievalRecallScorer,
  retrievalHitRateScorer,
  retrievalAveragePrecisionScorer,
  meanReciprocalRankScorer,
  ndcgScorer,
  citationScorer,
  citationCompletenessScorer,
  scorerDag,
} from "@muratkomurcu/dry-run";

const gate = scorerDag("rag-release", [
  { id: "recall", scorer: retrievalRecallScorer(10) },
  {
    id: "citations",
    scorer: citationScorer(),
    dependsOn: ["recall"],
    when: (results) => results.get("recall")?.passed === true,
  },
], { requireAll: true, threshold: 0.8 });
```

Dataset cases may carry `retrievalResults`, `expectedRetrievalIds`, and `expectedCitations`. The 63 exported scorer constructors also include token precision/recall/F1, Jaccard, keyword coverage, completeness, conciseness, and length gates. Security controls include PII, configured secret, system-prompt fragment, authorized-tool, and refusal scorers. Semantic judge wrappers cover hallucination, bias, summarization, instruction following, tool-use quality, multimodal evidence, and two-to-nine-judge consensus with a fail-closed disagreement spread; they accept any `LLMProvider`, including a free local model. `calibrateScores` measures labeled accuracy with a Wilson interval plus Brier score, MAE, ECE, confusion counts, and inspectable calibration bins rather than treating judge scores as ground truth.

Multi-turn cases use typed `turns`/`expectedTurns` and `expectedFacts`. Media descriptors support image, audio, video, and document kinds with MIME type, digest, size, URI, OCR, transcript, alt text, and metadata fields. These are evaluation descriptors—Dry Run does not silently fetch a URI or decode an attachment.

```ts
const conversation = Dataset.create("support-conversations", [{
  input: "Continue this support session",
  turns: [
    { role: "user", content: "My order is 42." },
    { role: "assistant", content: "I will remember order 42." },
    { role: "user", content: "Which order are we discussing?" },
  ],
  expectedFacts: ["42"],
  media: [
    { id: "receipt", kind: "image", mimeType: "image/png", sha256: `sha256:${"0".repeat(64)}`, ocrText: "Order 42" },
    { id: "transcript", kind: "document", mimeType: "text/plain", sha256: `sha256:${"1".repeat(64)}`, transcript: "Support session for order 42" },
  ],
}]);

const scorers = [
  conversationCompletenessScorer(),
  turnCoherenceScorer(),
  knowledgeRetentionScorer(),
  roleAdherenceScorer(),
  modalityCoverageScorer(["image", "document"]),
  mediaIntegrityScorer(),
  multimodalGroundednessScorer(),
  crossModalConsistencyScorer(),
];
```

## 4. Import and generate datasets

```bash
dry-run dataset validate cases.jsonl
dry-run dataset import cases.csv -o .dryrun/datasets/cases.json
dry-run dataset split .dryrun/datasets/cases.json --ratio 0.8
dry-run dataset red-team .dryrun/datasets/cases.json --attacks prompt-injection,tool-output-injection,memory-poisoning,data-exfiltration
```

With no `--attacks` filter, CLI generation creates 40 deterministic single-turn variants per source case across 15 core vulnerability classes. `generateMultiTurnAdversarialDataset` adds 10 delayed/cross-turn/session attacks; `generateMultimodalAdversarialDataset` adds 8 OCR, transcript, metadata, QR, hidden-marker, and cross-modal conflict attacks. The three exported catalogs expose exact coverage; generation itself needs no model or network access.

Programmatic synthetic generation accepts an `LLMProvider`; it has no mandatory vendor:

```ts
const dataset = await generateSyntheticDataset({
  provider: ollamaCompatibleProvider,
  model: "local-model",
  name: "support-synthetic",
  sources: policyDocuments,
  casesPerSource: 4,
});
```

## 5. Trace application code

```ts
import { Tracer, TraceStore } from "@muratkomurcu/dry-run";

const tracer = new Tracer([new TraceStore()]);
const answer = await tracer.withSpan("support-agent", {
  type: "agent",
  input: question,
  tags: ["production"],
}, async () => {
  return tracer.withSpan("policy-search", { type: "retriever", input: question }, searchPolicy);
});
```

Experiment runs trace cases automatically unless `trace: false` or `--no-store` is used. `observe()` wraps an ordinary function. `traceToOtlpJson()` exports the local document in OTLP JSON form.

```bash
dry-run traces list --type tool --tag production --query refund
dry-run traces show <trace-id>
```

## 6. Version prompts

```bash
dry-run prompts publish support-answer prompt.txt --label candidate
dry-run prompts show support-answer candidate
dry-run prompts label support-answer 2 production
dry-run prompts render support-answer --label production --values values.json
```

Publishing identical template/variable content is idempotent. New content creates the next immutable numeric version.

## 7. Inspect Studio

```bash
dry-run studio
dry-run studio --port 4318 --no-open
```

Studio binds to loopback only. The CLI prints a URL containing a random token in its fragment; the page removes the fragment and uses it as an API bearer token. It shows experiment history, pass rates, trace spans, prompt versions, labels, and raw local details.

## 8. Feedback API

Studio APIs require `Authorization: Bearer <token>`.

```text
POST /api/experiments/:id/feedback
{"caseKey":"refund#1","source":"human","score":1,"comment":"correct"}

POST /api/traces/:id/feedback
{"spanId":"span_...","source":"human","label":"approved"}
```

Scores must be within 0..1. Feedback appends a new record; it does not rewrite the original output or score result.

## 9. Close the production feedback loop

Create a revisioned quality rule from flags or JSON. Deterministic sampling hashes the rule and trace IDs, so the same trace is never randomly included on one retry and excluded on another:

```bash
dry-run online create --rule examples/evaluation/production-rule.json
dry-run online list
dry-run online run --local-judge
dry-run online results --limit 100
```

Team trace ingestion enqueues a durable leased job automatically. Results are idempotent by rule revision and trace; failures are deduplicated into the configured annotation queue. Promoting an accepted trace creates a checksummed dataset and, when LLM spans carry request/response data, a canonical cassette plus generated agent test:

```bash
dry-run promote trace <trace-id> --name "refund regression"
```

Use the account-free local-model playground from the CLI or the team dashboard:

```bash
dry-run judge detect
dry-run judge test
dry-run playground run examples/evaluation/playground.json
dry-run playground promote <run-id> <variant-id> --label production
```

Promotion publishes an immutable prompt version and stores the selected matrix as an immutable experiment. `dry-run pr-report <baseline> <candidate>` converts experiment deltas into a CI-failing Markdown report, GitHub job summary, and optional idempotent bot comment. The complete model, failure policy, endpoints, and security boundary are in [Production loop](PRODUCTION_LOOP.md).

## 10. Run free self-hosted team mode

Initialize once. The initial admin token is printed once and only its SHA-256 hash is persisted:

```bash
dry-run team init --name "AI Quality" --retention-days 90
export DRYRUN_TEAM_TOKEN='drk_...'
dry-run team project create --name production
dry-run team key create --name prod-collector --role ingest --projects production
dry-run team invite create --email reviewer@example.com --role editor --projects production
```

Roles are deliberately small and auditable:

| Role | Capabilities |
| --- | --- |
| `viewer` | read projects, traces, experiments, prompts, queues, and quality monitors allowed by object policy |
| `ingest` | upload traces and experiments only |
| `editor` | read, ingest, annotate, evaluate monitors, and publish prompt versions within object-policy restrictions |
| `admin` | all editor capabilities plus members, invitations, projects, keys, object policies, audit, and retention |

An unscoped admin is a workspace administrator. A project-scoped admin may perform project retention and ordinary project operations only inside its explicit scopes; it cannot administer members/invitations/keys, create projects, read the workspace audit log, or change global retention. This rule is enforced inside `TeamWorkspace`, so HTTP, CLI, and library callers share the same boundary.

Invitations are one-time, expire by default after seven days, and are stored only as hashes. Joining creates a named principal and a 90-day member token by default; changing a member's project scopes/role takes effect on its existing tokens, and suspension invalidates them immediately:

```bash
# Admin: copy the one-time dri_ token through a secure channel.
dry-run team invite create --email reviewer@example.com --role editor --projects production

# Reviewer: invitation secrets never appear in argv.
export DRYRUN_INVITATION_TOKEN='dri_...'
dry-run team join --endpoint https://quality.example.com --name "Ada Reviewer"

# Admin lifecycle operations.
dry-run team member list
dry-run team member update member_... --role viewer --projects production
dry-run team member update member_... --status suspended
```

There is deliberately no email-delivery dependency: the operator chooses the secure channel. Ingest automation should use a dedicated ingest service key rather than a member token.

Start on loopback for local team testing:

```bash
dry-run team serve
```

For a network listener, configure TLS. Plaintext non-loopback binding is rejected unless the explicit development-only override is supplied:

```bash
dry-run team serve \
  --host 0.0.0.0 \
  --tls-cert /etc/dry-run/tls.crt \
  --tls-key /etc/dry-run/tls.key \
  --cors-origin https://quality.example.com \
  --max-project-bytes 1073741824 \
  --max-project-files 100000 \
  --no-open
```

Optional enterprise identity, provisioning, analytics, and operations remain free/self-hosted:

```bash
export DRYRUN_OIDC_ISSUER='https://id.example.com/realms/quality'
export DRYRUN_OIDC_CLIENT_ID='dry-run'
export DRYRUN_OIDC_REDIRECT_URI='https://quality.example.com/api/v1/auth/oidc/callback'
export DRYRUN_OIDC_COOKIE_SECRET='at-least-32-random-characters...'
export DRYRUN_SCIM_TOKEN='separate-high-entropy-provisioning-token...'
export DRYRUN_CLICKHOUSE_URL='https://clickhouse.example.com'
export DRYRUN_METRICS_TOKEN='separate-high-entropy-metrics-token...'
dry-run team serve --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem --no-open
```

OIDC uses Authorization Code + PKCE and verified signed ID tokens; SCIM 2.0 manages user create/filter/replace/patch/activation/suspension/deprovisioning. Shared ClickHouse analytics are idempotent across multiple application nodes. `/api/v1/health/live`, `/api/v1/health/ready`, and authenticated `/api/v1/metrics` support load balancers and Prometheus. See [the operations guide](OPERATIONS.md) for all variables, the open-source two-node stack, TLS changes, SLOs, and backup/restore.

The **Setup & import** view calls `/api/v1/setup/diagnostics` to report local/distributed state, PostgreSQL migration version, analytics, OTLP, and local-judge readiness without exposing secrets. It can create an idempotent 24-trace v1/v2 demo with no model call, preview DeepEval/Langfuse/Braintrust JSON conversion, and persist the redacted import into the selected project. The same checks are available through `dry-run team diagnostics` or `--endpoint` for a remote server.

Organization governance is available without OIDC. Administrators can define custom roles beneath built-in capability ceilings, place members into reusable project-scoped groups, create service accounts, rotate their keys with a bounded grace window, and export the attributable audit log as JSONL or CSV. The same actions are available in the **Governance** UI and under `/api/v1/admin/organization`, `/roles`, `/groups`, `/service-accounts`, and `/audit/export`.

Create continuous quality monitors over shared analytics. Enabled monitors run once per minute by default, persist `healthy`, `breached`, or `insufficient-data` results, deduplicate the same time bucket across replicas, respect project storage quotas, and follow project retention:

```http
POST /api/v1/projects/production/monitors
Content-Type: application/json

{
  "name": "Production answer quality",
  "windowMinutes": 60,
  "minEvents": 100,
  "thresholds": {
    "minPassRate": 0.95,
    "maxP95LatencyMs": 1500,
    "maxCostUsd": 25
  }
}
```

`POST /api/v1/projects/:project/monitors/:id/evaluate` evaluates immediately; `GET .../:id/results` returns retained history. The dashboard's **Monitors** view exposes the same lifecycle and observed threshold violations.

Human-review queues support `single`, `double-blind`, and `adjudicated` modes; manual, round-robin, or deterministic-random assignment; multiple reviewers per target; hidden early decisions; an optional adjudication queue; SLA aging; gold-label calibration; and conflict-safe bulk operations. `GET /api/v1/projects/:project/queues/:queue/agreement` returns rated/unrated counts, overlap, category distribution, consensus/ties, observed/expected agreement, and nominal Krippendorff's alpha. Agreement describes reviewer consistency; it does not prove ground-truth correctness.

The **Intelligence** view compares two release labels from analytics and persists Wilson pass-rate intervals, categorical/numeric drift, robust anomalies, failure clusters, and likely root-cause correlates. `POST /api/v1/projects/:project/intelligence` performs the same analysis. The **Judge reliability** view and `/judge-reliability` API persist labeled calibration, repeatability, pair agreement, bias, equal-judge ensemble uncertainty, and drift gates. Root-cause ranking is correlation evidence, and judge reliability is measurement evidence—not ground truth.

Project admins can add restrictive object policies for `trace`, `experiment`, `prompt`, `annotation-queue`, `online-rule`, `playground-run`, `regression`, and `quality-monitor` objects:

```http
PUT /api/v1/projects/production/access/policies/trace/trace_123
Content-Type: application/json

{
  "grants": [
    { "subject": { "type": "member", "id": "member_abc" }, "capabilities": ["read", "annotate"] },
    { "subject": { "type": "key", "id": "key_exporter" }, "capabilities": ["read"] }
  ]
}
```

No policy means “inherit project RBAC.” Once a policy exists, only its member/key grants can use the named capability; project role remains a ceiling, and admins bypass policies for recovery and administration. Supply `revision` on `PUT`/`DELETE` for optimistic concurrency. Collection, detail, and mutation routes enforce policies, while project-level analytical aggregates may still reveal counts and dimensions; object policies protect canonical payload access, not database row-level security.

Defaults are 1 GiB and 100,000 files per project, a 5 MiB request body, 64 concurrent bodies, a 64 MiB aggregate in-flight body budget, and 600 requests/minute per key/IP. The byte/file limits are checked under a project-wide reservation lock before remote writes. Inspect current usage without loading stored documents:

```text
GET /api/v1/projects/:project/usage
```

Retention is disabled initially to prevent surprising data loss. Preview, enable, and apply it explicitly:

```bash
dry-run team retention plan --project production --days 90
dry-run team retention configure --days 90 --enable
dry-run team retention configure --project production --days 30 --enable
dry-run team retention apply --project production --days 90 --yes
```

Workspace retention is the default; each project may override its enabled state and duration, including from a project-scoped admin. The running server evaluates those effective policies hourly. Invalid files are never deleted; only validated, expired trace/experiment files, completed annotations, and quality-monitor result history are candidates. Remote traces receive a server-owned `receivedAt`; retention uses that value rather than trusting client time. Every candidate is locked, re-read, schema-validated, and checked against the cutoff immediately before unlink, so a fresh same-ID replacement is preserved.

### Durable remote ingestion

`RemoteTraceExporter` writes every trace to an owner-only local spool before attempting upload. Successful batches are removed; failures remain for the next flush or process restart.

```ts
import { RemoteTraceExporter, Tracer } from "@muratkomurcu/dry-run";

const remote = new RemoteTraceExporter({
  endpoint: "https://quality.example.com",
  project: "production",
  token: process.env.DRYRUN_TEAM_TOKEN!, // use an ingest-scoped key
  batchSize: 50,
  flushIntervalMs: 1000,
  maxSpoolBytes: 512 * 1024 * 1024,
  maxSpoolFiles: 50_000,
  minFreeBytes: 64 * 1024 * 1024,
});

const tracer = new Tracer([remote]);
process.once("beforeExit", () => void tracer.shutdown());
```

Existing local state can be uploaded in bounded batches:

```bash
DRYRUN_TEAM_TOKEN='drk_...' dry-run team push \
  --endpoint https://quality.example.com \
  --project production
```

The exporter rejects endpoint URLs containing embedded credentials/query/fragment, refuses redirects, and fails closed before a write would exceed the configured spool bytes/files or free-space floor. `spoolUsage()` exposes its current high-water state.

`POST /api/v1/projects/:project/traces` remains the bounded batch-ingestion endpoint. `PUT /api/v1/projects/:project/traces/:trace` accepts one trace, requires the body ID to match the path, and provides an idempotent write contract for health-aware proxy retry. Repetition replaces the same canonical trace and the online evaluator reuses rule/trace idempotency keys; non-idempotent collection `POST` operations are not proxy-retried by the reference stack.

### Drop-in OTLP and OpenInference

Standard OpenTelemetry exporters may post OTLP HTTP JSON or protobuf to `/v1/traces`. Use `x-dry-run-project` to select the project and the ordinary team bearer token for authentication. The explicit project path `/api/v1/projects/:project/otel/v1/traces` is also available. OpenInference `openinference.span.kind`, input/output values, model and token attributes map into native trace fields; later partial batches merge by trace/span ID.

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT='https://quality.example.com'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer drk_...,x-dry-run-project=production'
```

### Python SDK

The dependency-free Python package includes the same cassette/evaluation core plus tracing, a secure synchronous/asynchronous team client, bounded experiments, pytest registration, and duck-typed framework hooks:

```bash
python3 -m pip wheel --no-deps --wheel-dir ./dist-python ./python
python3 -m pip install ./dist-python/dry_run_agent-0.8.0-py3-none-any.whl
```

```python
import os

from dryrun import TeamClient, TeamClientOptions, Tracer, RemoteTraceExporter

client = TeamClient(TeamClientOptions(
    endpoint="https://quality.example.com",
    token=os.environ["DRYRUN_TEAM_TOKEN"],
    project="production",
))
tracer = Tracer([RemoteTraceExporter(client)])

with tracer.start_span("support-agent", span_type="agent", input=question) as span:
    span.set_output(answer)
```

The hooks cover LangChain, LlamaIndex, OpenAI, Anthropic, DSPy, and CrewAI without importing those packages eagerly. PyPI publication is a separate release action; the repository and local wheel are the authoritative current distribution.

The server API is versioned under `/api/v1/`; it enforces bearer authentication, named-member/service identity, project scope, server-side role capabilities, request body/in-flight limits, rate limits, CORS allowlists, and security headers. Trace, experiment, prompt, queue, and annotation collection reads require a bounded `limit` (default 100, maximum 500) and return `page.nextCursor`/`page.hasMore`; filtered trace/annotation pages also cap the number of files scanned per request. Audit records attribute member actions, strip credential-shaped fields, and are read through a bounded tail window. Read the security policy before exposing it outside a trusted network.

## Storage layout

```text
.dryrun/
├── cassettes/     # checksummed provider interactions
├── datasets/      # normalized dataset documents
├── experiments/   # progressive and completed runs
├── traces/        # nested span documents
├── prompts/       # immutable versions and labels
├── online/        # revisioned rules, idempotent results and durable jobs
├── playground/    # immutable local-model comparison runs
├── regressions/   # promoted dataset/cassette/test bundles
├── intelligence/  # statistical production comparison reports
├── judges/        # judge reliability and drift reports
├── remote-spool/  # durable pending team uploads
├── team/          # workspace config, projects, audit and annotations
├── tools/         # hashed tool-result cache
└── golden/        # trajectory regression baselines
```

These files may contain business inputs and model outputs even after secret-shaped redaction. Keep `.dryrun/` ignored by default and commit only reviewed artifacts intentionally.
