# Where dry-run fits

`dry-run` is an offline regression-test layer for agent trajectories. It is adjacent to evaluation frameworks, tracing products, provider mocks, and browser E2E tools, but it does not replace all of them.

| Need | Best-fit category | dry-run's role |
| --- | --- | --- |
| Score answer quality across datasets | Evaluation framework | Can complement it with deterministic trajectory regression tests |
| Inspect production traces and latency | Observability platform | No hosted trace store; exports local HTML/JUnit evidence |
| Mock a single HTTP endpoint | HTTP mocking library | Records at the provider and optional tool boundary instead |
| Test browser behavior | Playwright/Cypress | Test the agent's decisions separately; use both for full-system coverage |
| Prevent prompt/tool regressions in every commit | **dry-run** | Record once, replay offline, assert, diff, and gate CI |

## Use dry-run when

- live model variance makes CI flaky;
- repeated regression runs are slow or consume provider budget;
- correctness depends on which tools were called and with what arguments;
- you need a reviewable fixture beside a prompt or agent-code change;
- a stale recording must fail loudly instead of returning a plausible wrong response.

## Use an evaluation framework as well when

- acceptable answers cannot be expressed with deterministic assertions;
- you need dataset-level quality metrics or model comparisons;
- you deliberately want to measure current live-model behavior.

## Use an observability platform as well when

- you need production traces, feedback, cost analytics, or team dashboards;
- central retention and cross-service correlation are requirements.

## Honest gaps

- JavaScript/TypeScript only; no Python SDK yet.
- Native adapters currently cover OpenAI-compatible providers, Anthropic, and the Vercel AI SDK surface tested in this repository.
- Cassette signatures detect structural drift, not semantic equivalence.
- There is no hosted dashboard or managed cassette service.
- Scenario and tool code are trusted local code, not sandboxed workloads.
