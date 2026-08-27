# Changelog

All notable changes to this project are documented here.

## [0.8.0] - 2026-08-27

- Remove the shared-POSIX requirement from distributed deployments with AES-256-GCM workspace snapshots, PostgreSQL advisory/CAS coordination, cold-node hydration, ephemeral Helm volumes, and a dedicated bootstrap job.
- Add batched distributed ingestion: up to 500 traces share one immutable NDJSON artifact, one PostgreSQL transaction, and one JetStream event. A four-node one-million-trace run completed with zero indexed loss or duplicates while one application node was evicted.
- Add serialized PostgreSQL schema migrations, JetStream dead-letter/redrive, encrypted portable distributed recovery points, artifact-copy verification, and restore-before-import behavior.
- Add setup diagnostics, a deterministic zero-provider-cost demo workspace, and previewable/persisted DeepEval, Langfuse, and Braintrust imports to the control-plane UI and API.
- Expand release automation to npm provenance, Python wheel publication, GHCR images, container scanning, CycloneDX SBOM, SHA-256 assets, GitHub attestations, and scheduled CodeQL using free public-repository infrastructure.
- Replace backtracking-prone normalization and credential-redaction expressions with bounded linear scans; stop persisting runtime/OTLP stack traces and strip legacy stack fields at the authenticated API boundary.

### Free self-hosted platform expansion

- Add an optional distributed runtime with PostgreSQL revisioned control documents and transactional outbox, immutable checksummed S3/MinIO trace artifacts, NATS JetStream work queues, cross-replica reads, dependency readiness, and a real two-runtime integration verifier. Idempotent concurrent trace writes retain one logical revision.
- Add organization metadata, custom roles with capability ceilings, dynamic groups/project scopes, service accounts, rotation grace periods, and bounded JSONL/CSV audit export to the domain API and Governance UI.
- Expand the dependency-free Python package with native tracing, secure sync/async team clients, bounded experiments, pytest registration, and LangChain/LlamaIndex/OpenAI/Anthropic/DSPy/CrewAI hooks.
- Add single, double-blind, and adjudicated human-review programs with deterministic assignment, multiple reviewers, hidden early decisions, consensus, SLA aging, gold calibration, and conflict-safe bulk operations.
- Add production release intelligence with Wilson pass-rate intervals, Jensen-Shannon/KS drift, robust MAD anomalies, failure clustering, ranked root-cause correlates, persistent reports, and signed webhook support.
- Add persisted judge reliability audits for calibration, Brier/ECE, repeatability, pair agreement/Cohen kappa/Pearson/bias, equal-judge ensemble uncertainty, drift, and configurable release gates.
- Accept authenticated standard OTLP HTTP JSON and protobuf at `/v1/traces`, map OpenInference semantic attributes, merge partial batches idempotently, and expose a project-scoped OTLP endpoint.

### Evaluation governance and production quality

- Add TypeScript and Python multi-judge consensus with spread-based fail-closed behavior, labeled-score calibration with Wilson accuracy intervals/Brier/MAE/ECE, and ten additional judge-backed RAG, task, conversation, multimodal, and privacy metric families.
- Add nominal multi-reviewer agreement with overlap, ties, observed/expected agreement, and Krippendorff's alpha; expose it through the team API and Human Review UI.
- Add revisioned quality monitors for pass/failure rate, average/p95/p99 latency, token, and cost thresholds. Enabled monitors run continuously against shared analytics, use time-bucketed idempotent results across replicas, respect project quotas, participate in retention, and expose history in the API/UI.

### Authorization and reliability evidence

- Add restrictive object-level policies for traces, experiments, prompts, annotation queues, online rules, playground runs, regressions, and quality monitors. Policies grant member/key capabilities beneath project RBAC, use optimistic revisions, filter collections, protect detail/actions, and remain admin-manageable and auditable.
- Upgrade the Compose HA verifier from liveness-only probes to authenticated read-after-write traffic across baseline, active replica shutdown, surviving-node service, and recovery. Reports include exact transaction cardinality, failed operations/probes, and p50/p95/p99 latency without serializing the token.
- Add idempotent trace-ID `PUT` ingestion, make quota scans tolerate concurrently completed/deleted durable jobs, and configure health-aware proxy retries for read/idempotent-write operations. The committed two-replica run completed 248/248 authenticated write/read transactions across shutdown and recovery with zero failed API operations or probes.
- Replace unsupported TypeScript parameter-property syntax on CLI-imported modules so Node's strip-only TypeScript execution path remains covered by the real CLI suite.

### Closed-loop production evaluation

- Add revisioned online quality rules with deterministic sampling, trace/status/tag/environment/release/provider/model filters, built-in trajectory and semantic checks, idempotent results, durable leased jobs, bounded retry, and explicit fail/skip behavior when a semantic signal is unavailable.
- Evaluate every newly ingested team trace in the background and route failures into deduplicated human-review queues with rule, revision, result, and trace provenance.
- Promote a reviewed trace into a checksummed regression bundle containing a dataset, canonical cassette when request/response spans are available, generated agent test, and an integrity-checked manifest.

### Free local experimentation and PR gates

- Add an account-free prompt playground for two to six variants and up to 100 dataset cases, bounded concurrent execution, exact/contains/semantic scoring, immutable run evidence, deterministic winner selection, and one-action promotion into the prompt registry plus experiment history.
- Auto-detect Ollama, vLLM, and LM Studio on loopback, prefer capable non-embedding models, and expose local judge detection/testing through the CLI. Local semantic evaluation requires no provider account or API bill, while using the operator's own compute.
- Add baseline/candidate Markdown reports with case regressions, improvements, score/pass-rate, latency, token, and cost deltas; write GitHub job summaries and safely create or update a single bot PR comment.
- Extend the self-hosted UI with Quality rules, Playground, and trace/review promotion workflows; add matching local and team APIs, RBAC, quotas, audit events, and resource accounting.

### Release evidence

- Add end-to-end contracts for durable/idempotent online evaluation, review mining, trace promotion integrity, local judge discovery, playground comparison/promotion, PR reporting, and the complete team API loop.
- Add a reproducible four-workflow leadership gate with Wilson correctness intervals, seeded bootstrap timing intervals, CI artifacts, and committed raw evidence. The gate also exposed and closed a cassette-payload integrity gap in promoted regression loading.
- Centralize runtime provenance on `DRY_RUN_VERSION`, update the Node and Python package lines to 0.8.0, and document the production feedback loop and its security/operational boundaries.

## [0.7.0] - 2026-08-26

### Semantic evaluation and portability

- Add dependency-free Python semantic judges for OpenAI-compatible local endpoints, content-addressed judge caching, conversation test cases, composable metric suites, and conditional metric DAGs.
- Add Python contextual/RAG, multi-turn, multimodal, tool/trajectory, budget, privacy, refusal, and authorization metric families while retaining deterministic offline metrics.
- Add clean-room DeepEval, Langfuse, and Braintrust JSON migration adapters with CLI support, redaction, checksummed datasets, nested traces, feedback conversion, and explicit lossy-mapping warnings.

### Production analytics and human review

- Expand the analytics plane from summaries to parameterized event search, cursor pagination, p50/p95/p99 latency, time series, model/provider/environment/release/tag facets, detailed compressed payload drill-down, and analytics-aware retention.
- Replace the team summary page with a dependency-free control plane for production charts, trace timeline/conversation/raw inspection, experiment score/case inspection, and claim/score/label/comment/complete review workflows.

### Scale and recovery

- Add integrity-checked team backup/verify/restore commands; replacement restores preserve the previous workspace for rollback.
- Add a production Helm chart with two replicas, HPA, PDB, rolling updates, probes, RWX persistence, topology spread, anti-affinity, restricted security contexts, NetworkPolicy, Ingress, and ServiceMonitor.
- Add reproducible control-plane load and Compose failover verification scripts. The committed 2,000-request local run completed with zero errors and exact analytics cardinality.

## [0.6.0] - 2026-08-26

### Free self-hosted team control plane

- Add an opt-in team workspace with projects and `admin`, `editor`, `viewer`, and ingest-only roles; API keys may be project scoped, are displayed once, and are persisted only as SHA-256 hashes.
- Add free named-member lifecycle management: expiring one-time invitations, member-attributed principals/audit, expiring member tokens, live role/project-scope changes, suspension, CLI/API administration, and separate ingest service identities.
- Add a TLS-capable team server with versioned trace/experiment ingestion, prompt publishing, annotation queues, optimistic review revisions, append-only redacted audit events, and an account-free dashboard.
- Add secure remote defaults: loopback binding, refusal of plaintext remote listeners, explicit CORS allowlists, CSP/security headers, body and request timeouts, per-key/IP rate limits, safe resource IDs, and no external dashboard assets.
- Enforce project scope in the workspace domain layer so scoped admins cannot escape into global key/project/audit/retention administration.
- Add atomic per-project byte/file quotas, aggregate concurrent-body backpressure, metadata-only usage reporting, and bounded cursor pagination for traces, experiments, prompts, queues, and annotation items.
- Add opt-in scheduled retention with preview/apply APIs and CLI confirmation. Invalid files and prompt history are never selected for deletion.
- Make retention use a server-owned receipt time and lock/revalidate each candidate immediately before deletion, preventing timestamp bypass and fresh-replacement races.
- Add per-project scheduled retention overrides with workspace inheritance and project-scoped administration.
- Add `RemoteTeamClient` and an at-least-once `RemoteTraceExporter` with redirect refusal, bounded owner-only disk spooling, free-space backpressure, utilization reporting, and digest-checked post-acceptance deletion.
- Redact first-party `drk_` tokens in ordinary trace text, keep internal filesystem paths out of API errors, runtime-enforce Studio loopback binding, and transport release tags through environment variables rather than shell interpolation.
- Add `dry-run team init|serve|key|project|queue|retention|push` workflows; admin credentials are read from `DRYRUN_TEAM_TOKEN` instead of command-line arguments.

### Federated identity, analytics, and operations

- Add OIDC Authorization Code + PKCE S256 SSO with stateless signed transactions, state/nonce, discovery and JWKS verification, RS256/PS256/ES256 ID tokens, verified-email/domain policy, safe return paths, group-to-role/project mapping, and replica-safe member sessions.
- Add SCIM 2.0 discovery and user filter/create/replace/patch/activate/suspend/deprovision endpoints behind a separate high-entropy provisioning token.
- Add an `AnalyticsStore` abstraction plus idempotent ClickHouse ingestion and parameterized workspace/project/time summaries shared across multiple team-server nodes.
- Add public liveness/readiness, authenticated low-cardinality Prometheus histograms/counters, a dedicated metrics-only token, and bounded graceful shutdown.
- Add a production container and an all-open-source two-node reference stack using Caddy, Keycloak/PostgreSQL, ClickHouse, Prometheus, Alertmanager, and Grafana, with alert rules, dashboard provisioning, SLO guidance, backup/restore boundaries, and explicit production TLS changes.

### Metric and red-team breadth

- Expand the built-in surface to 62 scorer constructors, adding token precision/recall/F1, Jaccard, ROUGE-N, character F-score, keyword coverage, answer completeness/conciseness, output length, retrieval hit-rate/average-precision@k, citation completeness, five multi-turn metrics, and five multimodal metrics alongside BLEU, ROUGE-L, P/R@k, MRR, and nDCG.
- Add scorer DAGs with dependency ordering, cycle detection, conditional branches, weights, fail-closed child results, and token/cost aggregation.
- Add hallucination, bias, summarization, instruction-following, and tool-use judge wrappers plus secret leakage, system-prompt leakage, authorized-tool, and refusal controls.
- Extend dataset cases with ranked retrieval results, expected retrieval IDs, and expected citations.
- Expand deterministic red-team generation from six to 40 transformations across 15 inspectable vulnerability classes, including hierarchy and encoding bypasses, unsafe tool use, insecure output, excessive agency, reasoning/credential disclosure, tenant/access-control isolation, bias, availability, and persistent memory.
- Add 10 deterministic multi-turn attacks and 8 multimodal OCR/transcript/metadata/QR/hidden-channel/cross-modal attacks, with typed conversation and media dataset fields.
- Add a dependency-free Python evaluation module with deterministic lexical/NLP, retrieval/ranking, citation, JSON, and length metrics plus the same 40-attack/15-vulnerability catalog.

### Evidence and documentation

- Add end-to-end tests for token hashing, project scoping, role enforcement, redacted audit, annotation conflicts, retention safety, plaintext-listener refusal, durable exporter ingestion, advanced metrics, scorer DAGs, security controls, and all red-team categories.
- Document self-hosted operation, TLS boundaries, least-privilege keys, remote spooling, retention safety, and evidence-based boundaries against DeepEval, Langfuse, and Braintrust.

## [0.5.0] - 2026-08-26

### Local evaluation platform

- Add checksummed JSON/JSONL/CSV datasets with deterministic case IDs, filtering, tags, import, and reproducible train/test splits.
- Add persisted dataset experiments with bounded concurrency, trials, retries, cancellation/timeouts, progressive atomic writes, safe resume, Git/runtime provenance, token/cost totals, score aggregates, 95% confidence intervals, and baseline/candidate comparison.
- Add exact, contains, regex, edit, JSON Schema, trajectory, tool correctness, budget, contextual precision/recall/relevancy, groundedness, PII safety, rubric, blind pairwise, weighted composite, and custom scorers. Scorer/judge failures remain fail-closed.
- Add provider-pluggable synthetic dataset generation, six deterministic adversarial attack families, and a canary/forbidden-output red-team safety scorer.

### Tracing, prompts, and Studio

- Add nested AsyncLocalStorage traces for agent, task, LLM, tool, retriever, scorer, and custom spans with events, errors, metrics, search, feedback, owner-only persistence, trajectory conversion, and OTLP JSON export.
- Automatically trace experiment case → agent task → scorer execution and link traces to experiment/case/trial metadata.
- Add immutable checksummed prompt versions, idempotent publish, movable labels, strict template rendering, and CLI management.
- Add a macOS-style local Studio for experiments, traces, and prompts. Studio is loopback-only, bearer-token protected, Host/Origin validated, body/time limited, CSP hardened, and contains no external assets or analytics.

### CLI and integrations

- Add `eval`, `experiments`, `dataset`, `traces`, `prompts`, and `studio` command families, including CI-failing experiment comparison and deterministic red-team dataset generation.
- Parse current OpenAI Agents tool call/output/message items directly and make the trace processor conform to the official lifecycle.
- Add contract tests against a real compiled LangGraph, official LangChain message classes, official OpenAI Agents run items/traces/spans, and the existing real Vercel AI SDK surface without live model calls.
- Expand the release suite to 71 offline TypeScript tests plus the dependency-free Python cassette contract.

## [0.4.0] - 2026-08-25

### Cassette protocol

- Replace new unversioned interaction arrays with cassette v2 envelopes containing producer/runtime/source provenance, Git SHA, timestamps, redaction/matching policy, interaction IDs, request fingerprints, and an integrity checksum.
- Preserve read compatibility with v1 arrays and add `cassette migrate` / `cassette verify` commands.
- Add exact, canonical, structural, and custom request matchers with redacted field-level mismatch diagnostics. Canonical is the safe default for new recordings; migrated v1 cassettes retain structural matching.
- Add collision-resistant filenames, file locks, stale-lock recovery, owner-only atomic persistence, and a typed tool-cache serializer safe for bigint, undefined, dates, maps, sets, non-finite numbers and concurrent callers.

### Correctness and evaluation

- Fix the repeated-tool-call boundary and make missing semantic judges/metrics fail closed unless `--allow-skipped` is explicit.
- Propagate timeout cancellation through agent context, providers, judges and tool executors with `AbortSignal`.
- Compare golden token totals and record step duration/cost evidence.
- Add strict/unordered/subset/superset trajectory matching, tool order/error/argument-schema assertions, structured-output JSON Schema, LLM-call/duration/cost budgets, and sync/async custom assertions.

### Scale, protocols and CI

- Add tags, name filters, exclusions, stable sharding, bounded concurrency, retries and repeated trials while preserving deterministic result order.
- Add JSON, SARIF and GitHub annotation/job-summary reports.
- Add OpenAI Responses API, generic HTTP, A2A, OpenAI Agents, LangGraph, OTLP/Jaeger and trace-to-cassette bridges; preserve Vercel stream event order/timing when recorded.
- Add `import-trace` to turn an OTLP/Jaeger trace directly into an offline regression cassette.
- Add permission-backed `--deny-network` replay on Node 26+ with portable runtime guards, plus seeded randomness/UUIDs and frozen time.
- Add a dependency-free Python 3.10+ v2 cassette reader, replayer and concurrent scenario runner to the release gate.
- Expand CI to Node 22/24/26 and 55 offline TypeScript tests plus Python cross-runtime verification.

## [0.3.1] - 2026-08-25

### Fixed

- Correct every GitHub-facing URL to `MuratKomurcu1/dry-run`, including npm metadata, CLI help, CI badges, contribution instructions, and the composite Action example.
- Honor `junitPath` from `dryrun.config.json`.
- Refuse to overwrite an existing starter scenario during `dry-run init`.
- Fail loudly on corrupt or incorrectly shaped cassette files.
- Fail closed on an invalid `DRYRUN_MODE` instead of silently falling back to network-capable auto mode.
- Redact secret-shaped provider error bodies before displaying them.

### Security

- Hash cached-tool argument keys before persistence so raw arguments are not stored as JSON object keys.
- Keep cached-tool arguments out of replay-miss errors and redact fine-grained GitHub and npm token forms.
- Redact secret-shaped cached-tool results by default while preserving legacy-cache reads.
- Atomically persist cassettes and tool caches with owner-only POSIX permissions; migrate legacy raw cache keys on read.
- Remove shell interpolation of composite-Action inputs and pin every first-party GitHub Action to a full commit SHA.
- Document executable-code, provider-network, redaction, and report-data trust boundaries.

### Added

- Reproducible replay and fresh-process CLI benchmarks with raw JSON samples.
- Real CLI demo GIF and 1280×640 social artwork.
- Architecture, evidence, benchmark, comparison, release, and security documentation.
- CI benchmark smoke job with a machine-readable artifact.

## [0.3.0] - 2026-08-25

- Initial public release: record/replay cassettes, deterministic trajectory assertions, provider and Vercel AI SDK adapters, tool caching, golden baselines, diff/generate commands, HTML/JUnit output, CLI, and composite GitHub Action.

[0.3.1]: https://github.com/MuratKomurcu1/dry-run/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MuratKomurcu1/dry-run/releases/tag/v0.3.0
[0.4.0]: https://github.com/MuratKomurcu1/dry-run/compare/v0.3.1...v0.4.0
[0.5.0]: https://github.com/MuratKomurcu1/dry-run/compare/v0.4.0...v0.5.0
[0.6.0]: https://github.com/MuratKomurcu1/dry-run/compare/v0.5.0...v0.6.0
[0.7.0]: https://github.com/MuratKomurcu1/dry-run/compare/v0.6.0...v0.7.0
[0.8.0]: https://github.com/MuratKomurcu1/dry-run/compare/v0.7.0...v0.8.0
