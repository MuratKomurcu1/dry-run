# Where dry-run fits

`dry-run` 0.8 is a local-first AI quality platform, deterministic trajectory-regression layer, and optional free self-hosted team service. It implements dataset → task → scorer → experiment → trace → online rule → review → promoted regression, then adds checksummed provider/tool replay for zero-network CI.

This document compares product boundaries, not marketing claims. Hosted products change quickly; follow the linked official projects for their current details.

## Four exact workflow advantages

As of 2026-08-26, Dry Run exposes four narrowly defined complete workflows whose full equivalents were not found in the cited public documentation: deterministic no-network agent replay, durable production-failure routing, production trace → executable regression, and tamper-evident regression bundles. This is a documented-capability audit, not an overall or statistical product ranking. The [workflow evidence page](LEADERSHIP.md) publishes the completion rules, official competitor sources, 5,600 Dry Run contract checks, confidence intervals, raw JSON, and explicit limitations.

## Capability map

| Capability | dry-run 0.8 | DeepEval | Langfuse / Braintrust | Promptfoo |
| --- | ---: | ---: | ---: | ---: |
| Versioned local datasets and deterministic splits | yes | yes | yes | yes |
| Repeated experiments, retries, resume and baseline comparison | yes | yes | yes | yes |
| Exact/schema/trajectory/tool/budget scorers | yes | yes | yes | yes |
| Retrieval, groundedness, rubric and pairwise scorers | 63 composable scorer constructors total | broad specialized semantic catalog | yes | yes |
| Multi-turn evaluation ontology | typed turns/expected turns/facts + deterministic and semantic Python/TS suites | yes | varies | varies |
| Multimodal evaluation ontology | typed image/audio/video/document evidence + deterministic and semantic Python/TS suites | yes | varies | varies |
| BLEU, ROUGE-N/L, chrF, token P/R/F1, AP/P/R/hit@k, MRR, nDCG and citations | built in, deterministic | traditional NLP via custom/scorer APIs | scorer-dependent | assertion-dependent |
| Composite, DAG and custom async scorers | yes | yes | yes | yes |
| Multi-judge consensus and labeled-score calibration | equal-judge ensemble, deterministic bootstrap interval, spread/uncertainty gates, Wilson accuracy, Brier, MAE and ECE | broader metric ecosystem | platform-dependent | provider/assertion-dependent |
| Judge reliability operations | repeatability, pair agreement, Cohen kappa, Pearson, bias, calibration and drift reports | metric-dependent | mature managed evaluator workflows | provider/assertion-dependent |
| Synthetic dataset generation | provider-pluggable | broader | varies | varies |
| Deterministic adversarial variants | 40 single-turn + 10 multi-turn + 8 multimodal attacks | 40+ vulnerabilities / 10+ enhancements | varies | broader provider/payload catalog |
| Nested agent/LLM/tool/retriever/scorer traces | local/distributed storage + standard OTLP HTTP JSON/protobuf ingest/export + OpenInference mapping | evaluation tracing | managed/local deployment | evaluation logs |
| Human/code/external feedback records | local API/files | yes | managed workflows | assertions/results |
| Immutable prompt versions and movable labels | local registry | limited | managed registry | prompt configs |
| Local dashboard without an account | yes | reports | self-host/cloud | web viewer |
| Free self-hosted organization/RBAC | organization, named invites, custom role ceilings, reusable groups/project scopes, service accounts and rotation | collaboration is adjacent platform territory | more mature enterprise administration | varies |
| Restrictive object authorization | revisioned member/key grants under project RBAC for 8 resource types; admin bypass; collection/detail/action enforcement | platform-dependent | mature managed object policies | varies |
| Remote trace/experiment ingestion | bounded durable spool + batched API | production tracing integrations | mature high-volume ingestion | evaluation runs |
| Storage quotas and bounded reads | project byte/file quotas + cursor pages + scan/body budgets | deployment-dependent | mature database/query limits | deployment-dependent |
| Shared annotation queues | single/double-blind/adjudicated, deterministic assignment, SLA, gold calibration, consensus, conflict-safe bulk actions and Krippendorff alpha | platform integration | mature review workflows | varies |
| Online/production evaluation | revisioned filters, deterministic sampling, durable jobs, idempotent results and failure routing | production integrations vary | mature production evaluators | deployment-dependent |
| Persistent quality/SLO monitors | continuous revisioned pass/failure/latency/token/cost windows with retained status history | platform-dependent | mature production monitoring | deployment-dependent |
| Production intelligence | release Wilson intervals, JS/KS drift, MAD anomalies, failure clusters and ranked correlates | platform-dependent | mature production analytics | deployment-dependent |
| Trace → reviewed regression | checksummed dataset + canonical cassette + generated agent test | dataset/test workflows | dataset/test workflows | test generation varies |
| Account-free prompt playground | 2–6 variants × 100 cases on loopback local models, immutable result/promotion | evaluation runner | mature managed playgrounds | yes |
| Free local semantic judge discovery | Ollama, vLLM and LM Studio; explicit loopback boundary | local models configurable | provider integrations | local providers configurable |
| PR experiment report/comment | regressions, improvements, scores, pass rate, latency, tokens and cost; create-or-update comment | test reports | managed comparison UI | reports |
| Scheduled retention | workspace defaults + project overrides + server receipt time + locked revalidation/delete | platform integration | mature configurable policies | deployment-dependent |
| Audit events | append-only attributed log + bounded JSONL/CSV export | platform integration | richer administrative audit/control | varies |
| Enterprise identity and directory lifecycle | OIDC PKCE + group mapping + SCIM 2.0 | adjacent hosted platform | mature managed options | deployment-dependent |
| Shared analytical plane | idempotent ClickHouse event search, time series, facets, percentiles and payload drill-down | platform-dependent | mature distributed analytics | deployment-dependent |
| Distributed canonical trace plane | PostgreSQL revision/outbox + S3/MinIO checksummed CAS + NATS JetStream event delivery | platform-dependent | mature distributed storage | deployment-dependent |
| Stateless application nodes | encrypted S3 workspace snapshots + PostgreSQL advisory/CAS coordination; no RWX volume in distributed Helm mode | platform-dependent | managed by vendor | deployment-dependent |
| Trace/experiment UI | timeline/tree/conversation/raw trace and score/case inspection | evaluation reports | mature hosted/self-host UI | result viewer |
| Operations signals | probes, Prometheus, alerts, graceful drain, Compose HA, Helm/HPA/PDB/NetworkPolicy, backup/restore, load gate + authenticated read/write failover gate | platform-dependent | mature managed operations | deployment-dependent |
| Python SDK | dependency-free tracing, sync/async API, experiments, pytest and common framework hooks | Python-native and broader ecosystem | official SDKs | Python/JS CLI ecosystem |
| Import portability | clean-room DeepEval/Langfuse/Braintrust JSON adapters | ecosystem-specific | exports/APIs | varies |
| Recorded LLM/tool replay with request integrity | first-class | no | no | provider caching differs |
| Offline, no-key CI after recording | first-class | tests may call judges/models | varies | configured providers may call models |
| Checksummed cassette committed beside code | yes | no | no | no |
| JUnit, SARIF, JSON, HTML and GitHub reports | yes | primarily test/report outputs | platform exports | yes |
| Vendor-operated SLA / multi-region service | no—self-hosted controls only | adjacent hosted platform | yes on managed offerings | hosted options vary |

“Yes” does not mean identical maturity or adoption. `dry-run` exposes 63 TypeScript scorer constructors plus deterministic and judge-backed Python suites, judge reliability, typed multi-turn/multimodal evidence, 40 single-turn attacks, 10 conversation attacks, and 8 multimodal attacks. The production plane includes distributed trace storage/delivery, detailed ClickHouse queries, statistical release intelligence, monitors, durable rules, organization governance, double-blind/adjudicated review, a unified UI, reviewed trace promotion, Helm operations, backup/restore, and repeatable integration/failover checks. DeepEval still has a larger established Python contributor/user ecosystem. Langfuse and Braintrust still have more years of production-scale evidence, finer enterprise-policy composition, managed multi-region operations, UI refinement, and actual user adoption. Dry Run’s differentiated case is zero-license-cost self-hosting and a direct trace → rule → review → checksummed offline CI contract without a hosted account.

## Direct alternatives

- [DeepEval](https://github.com/confident-ai/deepeval): the closest metric-oriented comparison, especially for Python/pytest users. Its [official metric catalog](https://deepeval.com/docs/metrics-introduction) documents metrics across agent, RAG, multi-turn, safety, and multimodal use cases; its red-team guide documents [40+ vulnerabilities and 10+ attack enhancements](https://deepeval.com/guides/guides-red-teaming). Dry Run now covers the same top-level evaluation ontology with TypeScript constructors and a dependency-free Python judge/DAG/suite layer, while adding self-hosted production analytics and deterministic provider/tool replay. DeepEval retains a larger mature Python ecosystem and more specialized named metrics.
- [Langfuse](https://github.com/langfuse/langfuse): stronger as an established production observability and collaboration system. Its official documentation covers [organization/project RBAC](https://langfuse.com/docs/administration/rbac), [OIDC SSO](https://langfuse.com/docs/administration/authentication-and-sso), [SCIM and organization APIs](https://langfuse.com/docs/administration/scim-and-org-api), and [ClickHouse deployment](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse). Dry Run now provides OIDC/SCIM/project RBAC, detailed ClickHouse analytics, trace drill-down, human review, retention, and Helm deployment without a license fee; Langfuse retains broader organization controls, larger-scale field evidence, and managed operations.
- [Braintrust](https://github.com/braintrustdata/braintrust-sdk): stronger as an established managed experiment/playground/team experience. Its [official access-control docs](https://www.braintrust.dev/docs/admin/access-control) cover organization, project, object-level permissions and service accounts; its [self-hosting model](https://www.braintrust.dev/docs/admin/self-hosting) uses a managed control plane plus a customer data plane. Dry Run now covers trace hierarchy/conversation/raw inspection, experiment score/case analysis, complete review decisions and agreement, identity, restrictive object policies, detailed analytics/monitors, backup/restore, Helm, and authenticated load/HA verification in an all-OSS deployment. Braintrust retains broader organization-policy composition, polished managed workflows, and vendor-operated service evidence.
- [Promptfoo](https://github.com/promptfoo/promptfoo): broader provider and adversarial testing coverage. `dry-run` goes deeper on full tool trajectories, record/replay integrity, trace-to-test conversion, and no-network PR gates.
- [LangChain AgentEvals](https://github.com/langchain-ai/agentevals): focused trajectory evaluators with a natural LangGraph fit. `dry-run` includes actual LangGraph contract tests and adds provider/tool recording, experiment persistence, prompt versions, tracing, and Studio.

## Use dry-run when

- every PR must run without provider credentials, network, or spend;
- the same prompt/tool/model request must map to the correct recorded response, with stale fixtures failing loudly;
- correctness depends on tool order, arguments, errors, loops, budgets, retrieval evidence, privacy, or structured output;
- datasets, experiment evidence, prompts, traces, and baselines must remain on the developer machine or in source-controlled artifacts;
- an OTLP/Jaeger/OpenAI Agents run should become an editable offline regression test;
- local and CI workflows need the same exit codes and JUnit/SARIF/JSON evidence.

## Use a mature hosted platform as well when

- multiple organizations need deep hierarchy, inherited nested policies beyond Dry Run's role/group/object model, or managed cloud dashboards;
- production services need vendor-operated high-volume canonical trace storage, multi-region recovery, or a contractual uptime SLA;
- a very broad vulnerability/metric library matters more than deterministic replay;
- non-technical reviewers need a managed prompt playground and approval workflow;
- scenario or tool code is untrusted and requires container or microVM isolation.

## Remaining honest gaps

- Real adoption cannot be manufactured in code. Dry Run still needs independent users, integrations, contributors, public production references, and long-duration scale evidence; `ADOPTERS.md` deliberately contains no invented logos.
- DeepEval retains more specialized named Python metrics and a larger Python-native ecosystem. Dry Run’s Python semantic layer is provider-neutral and complete at the ontology level, but has less field history.
- Langfuse and Braintrust retain more mature enterprise-policy administration and vendor-operated multi-region support. Dry Run ships organization/group/project/object controls; operators own infrastructure, on-call, recovery objectives, and SLA.
- PostgreSQL/MinIO/NATS plus encrypted workspace snapshots remove the shared POSIX requirement from application replicas. This is code-level statelessness, not vendor-operated cross-region replication, capacity management, or an SLA.
- Deterministic contextual/groundedness signals remain lexical by definition. Use the cached semantic judge when nuance matters and retain judge/model provenance.
- Node 22/24 receive runtime network guards; the permission-enforced boundary requires Node 26+.
- Scenario and tool code remains trusted executable code.
