# Verification evidence

`dry-run` keeps its release claims independently inspectable.

## Automated contract

The public CI matrix runs on Node.js 22, 24 and 26 and requires:

- TypeScript compilation;
- the complete offline Vitest suite;
- the dependency-free Python cassette/replay, deterministic metric, and red-team suite;
- real CLI discovery and execution of the example scenario;
- v2 cassette checksum verification and no-network replay smoke coverage;
- JSON, SARIF and GitHub job-summary generation;
- replay, control-plane, and four-workflow leadership benchmark smoke runs with machine-readable output.

The `0.5.0` local release verification contains 71 offline TypeScript tests plus Python verification. Coverage includes cassette v1 migration/v2 integrity, exact/canonical/shape/custom matching, collision-safe persistence and concurrent tool caching, credential redaction without destroying token-usage metrics, fail-closed skips, cancellation, trajectory/schema/budget/custom assertions, dataset import/checksum/split, retrieval/rubric/pairwise/composite/privacy scoring, experiment trials/resume/compare/feedback, nested trace persistence/export/search, prompt versioning/rendering, synthetic/red-team generation, Studio authentication/headers/APIs, selection/sharding/concurrency/retry/trials, OTel/HTTP/A2A/Responses integrations, isolation, golden/generated tests, Vercel AI SDK generation/streaming, JSON/SARIF/HTML/JUnit output, CLI safety, and composite-Action shell handling.

The `0.6.0` gate contains 96 offline TypeScript tests and three Python tests. It adds team-workspace coverage for hashed one-time keys/invitations, named-member acceptance and suspension, role/project authorization, scoped-admin non-escalation, quota rejection before persistence, server-owned retention timestamps, locked retention revalidation, bounded cursor pages, path-safe public errors, exporter spool backpressure, redirect refusal, first-party token redaction, and release-workflow shell-data separation. Evaluation coverage now includes 62 scorer constructors, typed multi-turn/multimodal cases, 40 single-turn attacks, 10 conversation attacks, 8 multimodal attacks, and matching TypeScript/Python core 40-attack catalogs across 15 vulnerability classes. Identity/operations tests exercise real RS256 signatures, discovery, PKCE, state/nonce rejection, group mapping, cookie sessions, SCIM lifecycle, idempotent cross-node analytics, ClickHouse parameterization, dependency readiness, non-leaking failure probes, and dedicated-token Prometheus output. The executable gate remains authoritative.

The `0.7.0` gate contains 102 offline TypeScript tests and five Python tests. It adds Python semantic judge/cache/suite/DAG and advanced RAG/conversation/multimodal/safety coverage; production analytics event pagination, time series, facets, percentiles, resource payload and retention coverage; checksummed backup/tamper/restore coverage; and clean-room DeepEval/Langfuse/Braintrust migration coverage. CI additionally starts real ClickHouse 25.8 and verifies additive schema initialization, idempotent ingest, aggregate/percentile queries, filter search, time series, facets, compressed resource drill-down, and mutation-backed retention. Both Helm profiles are linted and the runtime image is built.

The `0.8.0` gate contains 109 offline TypeScript tests and five Python tests. It adds revisioned online rules, deterministic sampling, durable leased jobs, retry/idempotency, unavailable-signal policy, deduplicated review mining, trace-to-regression promotion and tamper detection, loopback local-judge safety, bounded Playground comparison/promotion, PR delta/comment generation, and the full authenticated team API loop. `npm run verify` also executes real CLI scenarios, an offline dataset experiment, replay benchmarks, the control-plane load smoke, and the four-workflow correctness/integrity gate.

The current unreleased gate contains 136 offline TypeScript tests and eight Python tests. Beyond multi-judge consensus, monitors, object policies, and HA contracts, it now covers organization/custom-role/group/service-account governance; double-blind/adjudicated review; production intelligence; judge reliability; standard OTLP JSON/protobuf/OpenInference ingest; dependency-free Python tracing/client/experiment/framework behavior; setup diagnostics; idempotent demo seeding; and migration preview/persistence. On 2026-08-27 the TypeScript gate passed on Node.js 26.7.0/macOS arm64. The executable release gate remains authoritative for the final aggregate result.

The upgraded real distributed verifier connected independent cold-node workspaces and HTTP servers to PostgreSQL 17, MinIO, and NATS JetStream. All 17 contracts passed: serialized migrations, optimistic revisions, stale rejection, repeated/concurrent idempotency, checksum round trip, pagination, JetStream delivery, DLQ redrive, queue-triggered online evaluation, encrypted workspace state, cold-node hydration, cross-replica trace and non-trace HTTP reads, stateless readiness, and portable recovery. The [2026-08-27 machine-readable report](../benchmarks/distributed-macos-arm64-2026-08-27-v0.8.0.json) records the exact run.

The full HA capacity profile ingested 1,000,000 traces through four stateless HTTP nodes while one application node was gracefully evicted at 33% completion. PostgreSQL indexed 1,000,000/1,000,000 accepted traces with zero duplicates and zero loss. On this macOS arm64 machine the observed throughput was 12,196.56 traces/s; request-batch latency was p50 1,289.24 ms, p95 1,396.71 ms, and p99 1,453.96 ms. The [raw report](../benchmarks/ha-million-macos-arm64-2026-08-27-v0.8.0.json) is implementation evidence for this machine/configuration, not a universal SLA. The injected fault was a graceful application-node eviction, not abrupt host, dependency, or region loss.

The upgraded two-replica Compose test began authenticated traffic before stopping `dryrun-a`, continued through the proxy transition and surviving replica, restarted the replica, then ran a recovery round. It completed 248/248 idempotent trace `PUT`→`GET` transactions and 496/496 API operations with zero failed probes, exact read-after-write cardinality, p95 32.8 ms, and p99 55.56 ms. This is a single-host application-process failover result—not multi-host or storage-failure proof. The [machine-readable report](../benchmarks/ha-macos-arm64-2026-08-26-unreleased.json) and verifier are committed.

The full v0.8 leadership run adds 5,600 binary contract observations: 3,500 successful checksum-verified offline replays, 1,400 production traces evaluated and routed to exactly one review item, 100 complete and load-verified executable regression bundles, and 600 detected dataset/cassette/generated-test mutations. It observed zero replay failures, zero missing review items, zero duplicate review items, zero incomplete promotions, and zero undetected mutations. Results include Wilson 95% intervals and seeded bootstrap timing intervals; [definitions and limitations](LEADERSHIP.md) and the [machine-readable raw run](../benchmarks/leadership-macos-arm64-2026-08-26-v0.8.0.json) are committed.

The current v0.8 candidate was built as a non-root `dry-run:verification-v0.8.0` container, initialized against a clean volume, started as the team server, and returned healthy workspace readiness. Compose configuration validated, and Helm 3.18.6 linted both the minimal and distributed PostgreSQL/S3/NATS profiles successfully. Earlier v0.8 evidence also covers the real ClickHouse 25.8 analytics/retention contract and the expanded OIDC+SCIM+ClickHouse+Ingress+ServiceMonitor Helm profile.

Framework compatibility is not inferred only from lookalike objects. The suite compiles and invokes a real LangGraph, uses official LangChain `AIMessage`/`ToolMessage` instances, converts official OpenAI Agents `RunToolCallItem`/`RunToolCallOutputItem`/`RunMessageOutputItem` instances, and checks the official OpenAI Agents `TracingProcessor` lifecycle. These tests remain offline and make no model request.

The v0.7 team control plane was exercised in a real Chromium session against generated trace and review fixtures: token login, Overview, Analytics, Traces, Experiments, Human Review, trace hierarchy/timeline, conversation, raw JSON, claim, score, label, comment, complete, and the browser console were checked. The smoke test found two inline-script defects before release; both were fixed, the final end-to-end decision completed, and the current-page console had no new error.

The v0.8 UI was exercised in Chrome against an isolated local workspace: token login; an existing failed production rule/result; creation of a second rule; batch evaluation producing one pass and one fail; trace inspection and the promotion entry point; the auto-mined Human Review item and its promotion entry point; a two-variant Playground run; winner promotion to prompt v1 plus an immutable passing experiment; and the browser error/warning console. No console warning or error was present. Backend trace promotion is separately covered end-to-end through the authenticated team API and checksum-tamper test.

The expanded control-plane UI was then exercised in a fresh Chrome session against a new local workspace: token login plus Overview, Production Intelligence, Judge Reliability, Organization Governance, and the upgraded Human Review screen. Every view rendered its controls and empty state, the full-page review layout was visually checked, and the browser error console remained empty.

The composite GitHub Action is stored at [`.github/actions/dry-run/action.yml`](../.github/actions/dry-run/action.yml). Consumers can pin a tag rather than trusting a moving branch:

```yaml
- uses: MuratKomurcu1/dry-run/.github/actions/dry-run@v0.8.0
  with:
    paths: tests
    mode: replay
```

## What this evidence does not prove

- Live OpenAI, Anthropic, or compatible-provider availability.
- Semantic correctness of a particular prompt or agent response; deterministic scorers are signals and rubric judges depend on the configured model.
- Vendor-managed operations, deep nested policy inheritance, or global consensus. Team mode now has organization/custom-role/group/service-account governance, stateless replicas, encrypted state, and portable recovery. Code and local checks do not prove a contractual SLA, cross-region replication, abrupt dependency-partition recovery, long-duration soak behavior, or an operator's recovery discipline.
- Safe execution of untrusted scenario/tool code; `--deny-network` is a scoped replay boundary, not a general sandbox.
- Detection of every possible secret or personal-data format.

Those boundaries are documented in [`SECURITY.md`](../SECURITY.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).
