# Architecture

`dry-run` is a local control plane between agent frameworks, model/tool boundaries, evaluation datasets, and CI. No hosted account or paid service is required.

## System flow

```text
                      ┌──────────────────── quality loop ────────────────────┐
JSON / JSONL / CSV ──►│ Dataset → task → scorers → experiment → PR report   │
Prompt registry ─────►│                   │                                  │
local Playground ────►│                   ▼                                  │
                      │              nested traces                           │
                      └───────────────────┬──────────────────────────────────┘
                                          ▼
                           online rules / deterministic sample
                                  │ pass           │ fail
                                  ▼                ▼
                             result evidence   review queue
                                                       │
                                                       ▼
                                  checksummed dataset/cassette/test
                                       │
                       optional durable remote spool
                                       ▼
       OIDC / SCIM ─► organization / RBAC / review / retention
                                       │
          PostgreSQL control/outbox + S3 trace CAS + NATS JetStream
                                       │
                         shared ClickHouse analytics
                                       │
                    readiness / Prometheus / OSS HA stack

OpenAI / Anthropic / Vercel AI / OpenAI Agents / LangGraph / A2A / custom
                                  │
                    record or import OTLP/Jaeger
                                  ▼
                           cassette v2
       version + provenance + fingerprints + redaction + checksum
                                  │
                     replay exact/canonical/shape
                                  ▼
                     deterministic trajectory gates
                                  │
                  JUnit / SARIF / JSON / HTML / GitHub
```

The quality loop may use a remote or local model. The regression loop replays already-recorded model/tool interactions and can be network-denied.

Online rules are revisioned documents. Trace membership is hash-sampled, results are keyed by rule revision plus trace, and durable leased jobs make team ingestion retryable. Failed results become deduplicated annotation items. Promotion preserves trace/result/reviewer provenance and never fabricates a cassette when request/response span evidence is absent.

## Evaluation core

`Dataset` normalizes JSON, JSONL/NDJSON, and CSV into a checksummed document with stable case IDs. Filtering, tags, and train/test splits are deterministic. A dataset case can carry input, expected output, context, retrieval context/results, relevant retrieval IDs, expected citations/tool calls, typed conversation turns, expected turns/facts, image/audio/video/document descriptors, tags, metadata, and review comments. Media descriptors are validated evidence references; core evaluation never fetches untrusted URIs implicitly.

An `ExperimentDefinition` contains a dataset, task, and scorer list. `runExperiment` expands trials, executes a bounded worker pool, retries failed attempts, propagates cancellation/timeouts, and atomically persists progressive results. Resume inherits the original concurrency/trial/retry/timeout configuration and refuses changed dataset checksums, names, or scorer configurations.

Results include per-case scores, pass/fail reasons, task output/trajectory, attempts, duration, token/cost totals, aggregate mean/min/max/pass rate, and a 95% mean confidence interval. `compareExperiments` reports score deltas, regressions, improvements, and added/removed case results.

## Scoring model

Every scorer implements one small interface:

```ts
interface Scorer {
  name: string;
  threshold: number;
  score(input: ScorerInput): ScoreValue | Promise<ScoreValue>;
}
```

The 63 built-in scorer constructors cover deterministic output/schema/edit/token/Jaccard/BLEU/ROUGE-N/ROUGE-L/character-F checks; completeness, conciseness, keywords, and output length; strict/unordered/subset/superset trajectories; tool-call precision, recall, F1, and argument policies; time/token/cost budgets; retrieval precision/recall/hit-rate/average-precision@k, MRR, nDCG, citation correctness/completeness, context overlap and lexical groundedness; privacy/security patterns; multi-turn completeness/coherence/memory/role/safety; multimodal coverage/integrity/grounding/consistency/judging; rubric judging; blind pairwise preference; two-to-nine-judge consensus; weighted composites; and dependency-checked conditional scorer DAGs. Exceptions, malformed judge JSON, and excessive consensus spread fail closed. Labeled calibration reports accuracy/Wilson interval, Brier score, MAE, ECE, confusion counts, and calibration bins; reviewer consistency uses variable-rater nominal Krippendorff alpha without discarding ties or unrated items.

Lexical retrieval/groundedness signals intentionally expose their method in result details. They are reproducible regression metrics, not claims of semantic truth.

## Tracing and feedback

`Tracer` uses `AsyncLocalStorage` for nested context and records agent, task, LLM, tool, retriever, scorer, and custom spans. Experiment cases automatically create a root task, an agent span, and scorer spans. Spans carry redacted input/output, attributes, metrics, events, errors, parent IDs, and high-resolution durations.

Exporters can keep traces in memory, persist owner-only JSON, emit OTLP JSON, or upload through a durable spool. The team server also accepts standard OTLP HTTP JSON/protobuf and maps OpenInference attributes into native spans while merging partial batches idempotently. `TraceStore` supports status/type/query/tag filters. Experiment and trace stores accept human, code, or external feedback records without mutating the original case results.

## Prompt and dataset generation

`PromptRegistry` persists immutable, checksummed prompt versions. Labels such as `latest`, `candidate`, and `production` point to versions and may move without altering version history. Rendering fails on missing declared template variables.

Synthetic dataset generation accepts the common `LLMProvider` interface, so it can use a local OpenAI-compatible model. Source content is delimited and treated as untrusted data. Returned JSON is validated and must contain the requested case count.

Adversarial generation is deterministic and offline. Forty single-turn transformations cover 15 core vulnerability classes: instruction hierarchy, encoded/obfuscated bypasses, structured-output injection, tool-result trust, unsafe tool use, insecure output handling, excessive agency, sensitive-data/reasoning/credential disclosure, persistent memory, tenant isolation, access control, bias/fairness, and availability. Separate catalogs add 10 multi-turn attacks and 8 multimodal injection/conflict attacks. The red-team safety scorer fails when the injected canary or configured forbidden output appears; dedicated security scorers detect configured secrets, protected system-prompt fragments, unauthorized tool calls, unsafe conversation behavior, media inconsistencies, and expected/unexpected refusals.

## Local Studio boundary

Studio binds only to `127.0.0.1` or `::1`, creates a cryptographically random bearer token, and puts that token in the initial URL fragment so it is not sent in the first HTTP request. The page removes the fragment and sends the token only in API authorization headers.

The server validates `Host`, validates `Origin` for writes, limits request bodies, sets strict timeouts and no-store/CSP/frame/content-type/referrer headers, and exposes experiment, comparison, feedback, trace, and prompt read APIs. It contains no external scripts, styles, fonts, or analytics.

## Self-hosted team boundary

`TeamWorkspace` is an optional control plane separate from Studio. It keeps organization metadata, projects, custom roles, groups, members, invitation/session/service-account hashes, audit JSONL, experiments, prompts, annotation queues, quality monitors, intelligence/judge reports, and object policies in an owner-only directory. Named members join through expiring one-time invitations; role/group/project scopes and active/suspended state are resolved on every authentication. Ingest automation uses separate service identities with rotation grace periods. Scope is enforced in domain methods and HTTP routes; custom roles cannot exceed their built-in role ceiling. Raw keys are returned once and are never written to configuration or audit.

`startTeamServer` defaults to loopback and rejects a non-loopback plaintext listener unless the operator explicitly enables the development override. It supports in-process TLS, exact CORS allowlists, bearer authorization, per-project byte/file quota reservations, aggregate in-flight body backpressure, body/time/rate limits, and hardened response headers. Collection APIs use stable filename cursors with bounded page and scan sizes; project usage counts come from filesystem metadata rather than full document loading. The dashboard stores its token only in JavaScript memory; a token supplied by URL fragment is removed before API calls.

`OidcService` implements Authorization Code + PKCE S256 with signed stateless login transactions, state/nonce, discovery/JWKS caching, issuer/audience/time/signature verification, verified-email policy, safe return paths, and group-to-role/project mapping. Supported ID-token algorithms are RS256, PS256, and ES256. `ScimService` implements SCIM 2.0 discovery and user filtering/provisioning/replace/patch/suspend/deprovision behind a separate timing-safe bearer credential. Federated subjects are stored as external identities on ordinary members, so role/project lifecycle continues through the same authorization layer.

`AnalyticsStore` separates query analytics from mutable workspace administration. `ClickHouseAnalyticsStore` uses idempotent resource keys, a versioned replacing table, parameterized filters, and `argMax` latest-resource views so retries and updates do not double count. It serves summaries, p50/p95/p99 latency, cursor event search, time series, facets, and compressed trace/experiment payload drill-down; retention applies to both planes. Multiple application nodes can share it. Project-level quality monitors evaluate those summaries on fixed minute boundaries; content-addressed result IDs and file locking collapse simultaneous replica evaluations into one history record. Public liveness/readiness, authenticated low-cardinality Prometheus metrics, dependency-aware load balancing, and bounded graceful shutdown provide the signals needed by an operator; the included Compose stack and Helm chart cover process/cluster deployment controls.

`DistributedRuntime` is opt-in. PostgreSQL stores scoped revisioned JSON control records, serialized schema migrations, advisory coordination, and a transactional outbox. S3/MinIO stores SHA-256-verified content-addressed trace artifacts and AES-256-GCM encrypted workspace snapshots. NATS JetStream provides deduplicated work-queue delivery plus dead-letter/redrive. `DistributedWorkspaceState` hydrates an empty node, serializes mutations across replicas, and publishes non-trace state with optimistic CAS; trace payloads remain in the dedicated distributed repository. Consequently application nodes use independent ephemeral disks and do not require RWX/POSIX sharing.

Batch ingest writes up to 500 traces as one immutable NDJSON artifact, one PostgreSQL batch transaction, and one JetStream event. Single-trace compare-and-swap remains available for idempotent `PUT`. `DistributedRecoveryManager` creates encrypted control-plane snapshots and portable copies of every referenced artifact, verifies them, and restores missing objects before importing control records.

`ProductionIntelligenceEngine` compares release windows with Wilson intervals, categorical Jensen-Shannon and numeric KS drift, robust MAD anomalies, failure clusters, and ranked correlates. `JudgeReliabilityStore` persists calibration, repeatability, agreement, bias, bootstrap uncertainty, ensemble, and drift reports. These statistics quantify observed evidence; they do not prove causal root cause or semantic correctness.

`RemoteTraceExporter` persists a redacted trace to an owner-only spool before upload, batches up to the server limit, retries transient failures with bounded backoff, and applies fail-closed byte/file/free-space limits. It refuses redirects so bearer tokens cannot follow a redirect, and after a successful response deletes a spool file only when its digest still matches the uploaded version. Duplicate trace IDs are idempotent file replacements on the receiver.

Retention is disabled by default. Projects can inherit the workspace policy or define their own enabled state and duration. Remote ingestion overwrites any client-supplied receipt time with a server-owned `receivedAt`. When an effective policy is enabled, the server selects only validated traces, experiments, completed/skipped annotations, and quality-monitor results older than the cutoff, then joins the writer lock and revalidates immediately before deletion. Planning and explicit CLI application expose counts without remote filesystem paths.

## Cassette v2 contract

A cassette is a `dry-run.cassette` envelope containing producer/runtime/source provenance, optional Git SHA, timestamps, matching/redaction policy, stable interaction IDs, exact/canonical/shape request fingerprints, and a SHA-256 checksum over canonicalized interactions.

Legacy arrays are read as v1 and migrated in memory with `shape` matching. `dry-run cassette migrate` writes v2; `dry-run cassette verify` validates schema and checksum.

| Matching policy | Contract |
| --- | --- |
| `exact` | JSON property/array order, strings, and values match exactly |
| `canonical` | Stable key order/newlines; prompt, tools, arguments, model, generation settings, and response format remain significant |
| `shape` | Model, roles/content types, tool names/argument shapes, schemas, and response format |
| custom | Caller returns a verdict and optional diagnostic |

New recordings default to `canonical`. Mismatches return a redacted field-level diff. Runtime `AbortSignal` values are never fingerprinted or persisted.

## Persistence and concurrency

Local stores use owner-only directories/files on POSIX, lock directories, stale-lock recovery, temporary files, fsync where applicable, and atomic rename. Tool arguments use a typed canonical serializer and only their SHA-256 fingerprint is used as a cache key. Secret-shaped values are redacted before persistence; this is defense in depth, not DLP.

## Isolation contract

In replay mode, `--deny-network` installs guards for fetch, HTTP(S), TCP, TLS, and UDP. Node 26+ also re-executes under the Node network permission boundary without `--allow-net`. `--seed` controls `Math.random` and `randomUUID`; `--time` freezes `Date` and `Date.now`. Hooks apply before scenario modules are imported.

This isolates network and deterministic inputs for trusted tests. It does not make arbitrary JavaScript, Python, native addons, or tool code safe to execute.

## Integration boundaries

| Module | Responsibility |
| --- | --- |
| `dataset.ts` | Versioned cases, JSON/JSONL/CSV import, filters and deterministic split |
| `scorers.ts` | Deterministic, judge, pairwise, retrieval, security and composite scoring |
| `experiment.ts` | Trials, retries, resume, persistence, aggregate statistics and comparison |
| `tracing.ts` | Async span context, trace persistence/search/feedback and OTLP export |
| `prompts.ts` | Immutable prompt versions, labels and rendering |
| `generation.ts` | Synthetic datasets, adversarial variants and red-team safety scorer |
| `online-evaluation.ts` | Revisioned production rules, deterministic sampling, durable jobs, idempotent results and review routing |
| `local-judge.ts` | Loopback-only Ollama/vLLM/LM Studio discovery and provider construction |
| `playground.ts` | Bounded prompt matrices, immutable evidence, winner selection and prompt/experiment promotion |
| `promotion.ts` | Trace-to-dataset/cassette/test regression bundles with manifest integrity |
| `pr-report.ts` | Experiment delta Markdown, job summaries and idempotent GitHub PR comments |
| `studio.ts` | Token-protected loopback experiment/trace/prompt UI and API |
| `team.ts` / `access.ts` | Workspaces, key/project RBAC, restrictive object policies, audit, annotation agreement and retention |
| `team-server.ts` | TLS-capable remote ingestion/review API and account-free dashboard |
| `distributed.ts` / `distributed-runtime.ts` | PostgreSQL control/outbox/migrations, batched S3/MinIO trace artifacts, NATS JetStream/DLQ and cross-replica runtime |
| `distributed-state.ts` / `distributed-recovery.ts` | encrypted stateless-node snapshots, advisory coordination, portable recovery verify/restore |
| `demo.ts` / `migration-store.ts` | zero-cost onboarding fixture and persisted clean-room platform imports |
| `identity.ts` / `scim.ts` | OIDC PKCE login, federated lifecycle and SCIM 2.0 provisioning |
| `analytics.ts` / `monitoring.ts` / `operations.ts` | Shared ClickHouse search/time-series/facets/payload analytics, continuous quality monitors, health probes and Prometheus metrics |
| `intelligence.ts` / `judge-reliability.ts` | Release intelligence, drift/anomaly/root-cause signals and judge reliability gates |
| `review.ts` | Double-blind/adjudicated assignment, consensus, calibration, SLA and bulk-review workflows |
| `otlp.ts` | OTLP HTTP JSON/protobuf decoding, OpenInference mapping and partial-batch merge |
| `team-ui.ts` | Dependency-free analytics, intelligence, judge, governance, trace/experiment and human-review control plane |
| `backup.ts` | Checksummed workspace backup verification and rollback-preserving restore |
| `remote.ts` | Retrying team API client and durable trace spool/exporter |
| `cassette.ts` / `cached-tools.ts` | Model and tool record/replay integrity |
| `integrations/*` | OpenAI Agents, LangGraph, OTLP/Jaeger and A2A bridges |
| `adapters/vercel-ai.ts` | Vercel AI SDK generation/streaming bridge |
| `python/dryrun/` | Dependency-free cassette replay, metrics, tracing, team client, experiments, pytest and framework hooks |

## Deliberate non-goals

- Hosted accounts, billing, password/social authentication, vendor-operated multi-region infrastructure, or a contractual managed SLA.
- Treating a local HA run as proof of a managed multi-region SLA; operators still own region replication, capacity, on-call, and recovery objectives.
- Claiming deterministic lexical metrics prove semantic quality.
- Running untrusted scenario/tool code as a secure sandbox.
