# Four evidence-backed workflow advantages

Status: 2026-08-26, Dry Run 0.8.0.

This page audits four deliberately narrow workflows. It does not claim that Dry Run is the largest, most adopted, most polished, fastest, or statistically best AI evaluation product overall. Within the public first-class workflows documented by DeepEval, Langfuse, Braintrust, and Promptfoo on the status date, the cited material did not document every required step of the same end-to-end contracts below. That is a useful product-boundary comparison—not proof that private features or custom integrations cannot reproduce them.

The capability audit and implementation statistics are separate:

- the comparison is a capability audit against cited official product documentation;
- the statistics are reproducible checks of Dry Run's own correctness and local performance;
- a feature not found in the cited public documentation is recorded as *not documented*, not as proof that no private integration or custom code can implement it.

## The four workflows

| Dry Run advantage | Exact workflow | Completion rule | Closest documented alternative | Audit result |
| --- | --- | --- | --- | --- |
| complete integrated contract | Deterministic no-network agent replay | recorded model response + canonical request matching + verified checksum + real agent assertion + enforced no-network CLI boundary | Promptfoo documents request-keyed provider caching and eval assertions, but its cache is TTL-based and its CI guide recommends externally restricting outbound traffic | every step is first-class in Dry Run; the complete equivalent was not found in the cited material |
| complete integrated contract | Durable production-failure routing | filter/sample + revisioned result + durable leased retry + automatic failure-to-review routing + duplicate-free rerun | Langfuse documents online evaluator rules with filters/sampling and separate annotation queues | every step is first-class in Dry Run; the complete equivalent was not found in the cited material |
| complete integrated contract | Production trace to executable regression | source-trace provenance + dataset case + canonical model cassette + generated test source + one verified manifest | Braintrust documents adding production traces to datasets with source-span provenance; Langfuse links source traces and dataset items | every step is first-class in Dry Run; the complete equivalent was not found in the cited material |
| complete integrated contract | Tamper-evident regression bundle | dataset checksum + cassette checksum + generated-test checksum + manifest binding + fail-closed loading | No equivalent three-artifact integrity contract was found in the cited public documentation | every step is first-class in Dry Run; the complete equivalent was not found in the cited material |

These are useful backend properties, not decorative categories. Together they answer one operational question: can a production failure become a reviewed, reproducible CI contract that needs no provider key, network access, or recurring model spend, and will silently edited evidence be rejected?

## Recorded statistical evidence

The committed raw run used 3,500 replay cases, 1,400 production traces, 100 trace promotions, 600 deliberate artifact mutations, seven timed suite iterations, and 10,000 seeded bootstrap resamples on Apple M5 / arm64 macOS / Node 26.7.0.

| Gate | Observed result | 95% Wilson interval | Local timing evidence |
| --- | ---: | ---: | ---: |
| Checksum-verified offline replay | 3,500 / 3,500 correct | 99.8904%–100% | 500-case median 18.20 ms; 27,478.50 scenarios/s |
| Trace → rule → deduplicated review | 1,400 / 1,400 complete | 99.7264%–100% | 200-trace median 762.96 ms; 262.14 traces/s |
| Duplicate review items on idempotent retry | 0 / 1,400 | 0%–0.2736% occurrence | 200-trace cached rerun median 8.18 ms |
| Trace → four-artifact executable bundle | 100 / 100 complete and verified | 96.3007%–100% | median 0.70 ms; bootstrap 95% interval 0.69–0.74 ms |
| Dataset/cassette/test tamper detection | 600 / 600 detected | 99.3638%–100% | 200 mutations per artifact type; zero false negatives |
| Deny-network CLI boundary | passed | binary contract check | fresh CLI process, exit code 0, boundary reported |

All measured provider-network-call and provider-cost counts in the replay and deterministic routing fixtures are zero. This is a consequence of the selected replay/local rule paths; it is not a claim that semantic judge execution is free on someone else's hardware.

Raw samples, runtime metadata, definitions, and limitations are in [`benchmarks/leadership-macos-arm64-2026-08-26-v0.8.0.json`](../benchmarks/leadership-macos-arm64-2026-08-26-v0.8.0.json).

## Reproduce or challenge the result

```bash
npm ci
npm run benchmark:leadership -- \
  --traces 200 --iterations 7 --promotions 100 \
  --mutations 600 --replays 500 --bootstrap 10000 \
  --output benchmarks/leadership-local.json
```

The command exits non-zero if any replay fails, any trace is missing an evaluation or review item, a retry produces a duplicate review item, a promoted bundle is incomplete, one deliberate mutation escapes detection, or the network-denied CLI contract fails. CI runs a smaller version and publishes its raw JSON as an Actions artifact.

Correctness proportions use two-sided 95% Wilson score intervals. Timed medians use a deterministic, seeded, nonparametric bootstrap. Raw samples are retained. The bootstrap interval for seven suite timings characterizes this recorded machine/run only; it is not a universal capacity interval or a hosted-product speed comparison.

## Competitor evidence boundary

- DeepEval officially documents trace/span evaluation and a broad catalog spanning agent, RAG, multi-turn, safety, and multimodal metrics. It remains broader in specialized Python semantic evaluation. Sources: [tracing](https://deepeval.com/docs/evaluation-llm-tracing), [metrics](https://deepeval.com/docs/metrics-introduction).
- Langfuse officially documents incoming-production evaluator rules with filters and sampling, human annotation queues, and source-trace relationships in its experiment data model. Those are mature observability/review primitives; the cited pages do not document a single promotion that emits a canonical cassette, generated executable test, and bound integrity manifest. Sources: [evaluation concepts](https://langfuse.com/docs/evaluation/core-concepts), [annotation queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues), [experiment data model](https://langfuse.com/docs/evaluation/experiments/data-model).
- Braintrust officially documents adding a production trace to a dataset with origin provenance and provides mature managed datasets, experiments, playgrounds, and tracing. Its self-hosted model keeps the UI, authentication, and platform management in a Braintrust-managed SaaS control plane. The cited dataset page does not document emitting a canonical cassette, generated test source, or bound integrity manifest. Sources: [build datasets](https://www.braintrust.dev/docs/annotate/datasets), [architecture](https://www.braintrust.dev/docs/admin/self-hosting/architecture).
- Promptfoo officially documents provider-response caching keyed by provider/request/configuration context, eval assertions, and CI integration. Its documented disk cache has a default 14-day TTL, and its CI guidance treats outbound restriction as runner configuration. That is valuable caching, but it is not the same published contract as a source-controlled, checksummed cassette plus a fail-closed network boundary. Sources: [caching](https://www.promptfoo.dev/docs/configuration/caching/), [CI/CD](https://www.promptfoo.dev/docs/integrations/ci-cd/).

## What this does not prove

- It does not prove overall superiority over DeepEval, Langfuse, Braintrust, or Promptfoo.
- It does not statistically rank competitors: no competitor implementation was executed by this benchmark.
- It does not measure hosted ingest scale, UI usability, semantic metric accuracy, model quality, multi-region availability, or community adoption.
- It does not compare competitor latency: running a local deterministic fixture against hosted network paths would be misleading.
- Zero observed failures does not mean zero future failures. The confidence intervals quantify the remaining sampling uncertainty, while CI protects only the cases encoded in the gate.
- Scenario and tool code are trusted executable code. The deny-network replay boundary is not a general untrusted-code sandbox.

If a cited competitor now exposes one of these complete workflows as a first-class public feature, open an issue with the official documentation link. The comparison should change with evidence.
