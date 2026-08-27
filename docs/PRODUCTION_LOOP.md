# Production evaluation loop

Dry Run 0.8 turns an observed production failure into a reviewed, deterministic regression without requiring a hosted account or paid model API.

```text
trace ingest
   │
   ▼
durable job ──► revisioned rule + deterministic sampling
   │                         │
   │                         ├─ pass ─► immutable result
   │                         │
   │                         └─ fail ─► deduplicated review item
   │                                              │
   └──────────────────────────────────────────────┘
                                                  ▼
                                      human review / approval
                                                  │
                                                  ▼
                          dataset + cassette + generated agent test
                                                  │
                                                  ▼
                              offline replay + experiment PR report
```

## 1. Detect a free local judge

Dry Run probes only loopback endpoints: Ollama at `127.0.0.1:11434`, vLLM at `127.0.0.1:8000`, and LM Studio at `127.0.0.1:1234`. It ignores embedding models when choosing a default.

```bash
dry-run judge detect
dry-run judge test

# Optional explicit selection
DRYRUN_LOCAL_JUDGE_URL=http://127.0.0.1:11434/v1 \
DRYRUN_LOCAL_JUDGE_MODEL=qwen3:8b \
dry-run judge test
```

No provider credential or per-request charge is involved. The model still consumes the machine's CPU/GPU, memory, and electricity. Automatic configuration rejects non-loopback endpoints; connect remote inference explicitly through an application-owned provider instead of presenting it as local.

## 2. Define production rules

Create a rule from flags:

```bash
dry-run online create \
  --name "Support production guard" \
  --tag production \
  --sample 0.25 \
  --max-duration 3000 \
  --max-tokens 2500 \
  --no-tool-errors \
  --no-loops \
  --required-tool search_policy \
  --queue "Production quality inbox"
```

Or keep a reviewable JSON rule in source control:

```bash
dry-run online create --rule examples/evaluation/production-rule.json
```

Filters support trace name, tags, status, environment, release, provider, model, and a `0..1` sample rate. Checks support serializable built-in output, regex, schema, trajectory, tool, loop, duration, cost, token, and semantic assertions. Custom JavaScript assertions are deliberately excluded from remotely stored rules.

Every edit creates a new rule revision. A result ID is derived from rule ID, revision, and trace ID. Retrying ingestion therefore returns the same evidence instead of duplicating scores or review work. Sampling is also hash-derived, so retry order cannot change membership.

`unavailable: "fail"` is the safe default for semantic checks: a missing/broken judge keeps the rule red. Choose `"skip"` only when a missing semantic signal should be visible but non-blocking.

## 3. Run continuously or in a batch

Local traces can be evaluated directly:

```bash
dry-run online run --local-judge
dry-run online results --limit 100
```

In team mode, every accepted trace is persisted first and then queued. Jobs have a lease, survive process restart, retry with bounded backoff, and stop after the maximum attempt count. A failed check is routed once to the rule's annotation queue with its rule revision and result provenance.

Local/team-default mode uses the file-backed job store to coordinate processes sharing one POSIX workspace. Optional distributed mode publishes accepted traces through a PostgreSQL transactional outbox to a shared NATS JetStream durable consumer; the consumer materializes an idempotent workspace job and triggers evaluation on one replica. This is a single-region work-queue contract, not multi-region consensus.

Relevant team endpoints are:

```text
POST            /api/v1/projects/:project/traces
PUT             /api/v1/projects/:project/traces/:trace
GET|POST       /api/v1/projects/:project/online/rules
GET|PATCH|DELETE /api/v1/projects/:project/online/rules/:rule
GET             /api/v1/projects/:project/online/results
POST            /api/v1/projects/:project/online/batch
POST            /api/v1/projects/:project/traces/:trace/promote
GET             /api/v1/projects/:project/regressions/:id?
```

Collection `POST` accepts batches. Trace-ID `PUT` accepts one document, requires its body ID to match the path, and is safe for load-balancer retry because a repeated request replaces the same canonical trace and reuses rule/trace idempotency keys.

Rule writes, batch evaluation, promotion, quota reservations, and audit events use existing project RBAC. Ingest-only service keys cannot alter rules or promote evidence.

## 4. Review and promote

Open Human Review in the team dashboard, claim the mined failure, inspect the full trace, and record the reviewer decision. The trace drawer and review target both expose **Promote to test**.

The CLI equivalent is:

```bash
dry-run promote trace <trace-id> \
  --name "refund-policy regression" \
  --online-result <result-id> \
  --annotation <annotation-id>
```

Each bundle under `.dryrun/regressions/<id>/` contains:

- `dataset.json`: one checksummed case with input, expected output, expected tools, tags, and source trace provenance;
- `cassette.json`: a canonical, checksummed cassette when LLM spans include messages and response data;
- `regression.agentest.ts`: an editable generated scenario when a cassette could be produced;
- `manifest.json`: filenames, checksums, warnings, trace/result/review provenance.

Loading a bundle verifies dataset, cassette, and generated-scenario checksums. If the trace lacks usable LLM request/response spans, promotion still preserves the dataset and writes an explicit warning instead of inventing provider traffic.

## 5. Compare prompts locally

The Playground evaluates two to six variants against up to 100 cases (maximum 300 generations per run). It bounds concurrency, time, output size, and requested tokens; supports exact, contains, and semantic scoring; stores immutable run evidence; and chooses a winner by score, pass rate, cost, latency, then stable ID.

```bash
dry-run playground run examples/evaluation/playground.json
dry-run playground show <run-id>
dry-run playground promote <run-id> concise --label production
```

Promotion publishes an immutable prompt version and stores the selected matrix as an immutable experiment. It does not silently deploy application code or mutate an existing prompt version.

The dashboard exposes the same flow under Playground when `team serve` detects a local judge. Its HTTP surface is:

```text
GET|POST /api/v1/projects/:project/playground/runs
GET      /api/v1/projects/:project/playground/runs/:run
POST     /api/v1/projects/:project/playground/runs/:run/promote
```

## 6. Gate a pull request

```bash
dry-run pr-report <baseline-experiment> <candidate-experiment> \
  --output dry-run-quality.md
```

The report includes case regressions/improvements plus score, pass-rate, latency, token, and cost deltas. It exits non-zero on a regression unless `--no-fail` is explicit. In GitHub Actions it also appends to `GITHUB_STEP_SUMMARY`.

An optional bot comment is create-or-update, not one comment per rerun:

```yaml
permissions:
  contents: read
  issues: write

- uses: MuratKomurcu1/dry-run/.github/actions/dry-run@v0.8.2
  with:
    baseline-experiment: .dryrun/experiments/baseline.json
    candidate-experiment: .dryrun/experiments/candidate.json
    pr-comment: true
```

GitHub's API endpoint must be credential-free HTTPS, redirects are refused, and the token remains in an authorization header. Fork pull requests commonly receive a read-only token; leave comments disabled there and publish the Markdown artifact/job summary. Do not run untrusted pull-request code in a privileged `pull_request_target` workflow.

## Operational boundaries

- Online checks evaluate stored trace content. Redaction is defense in depth; use retention, encryption at rest, least-privilege access, and reviewed datasets for sensitive workloads.
- Local semantic output is probabilistic. Pin the model name/version where possible, keep criteria and provenance, and pair semantic judgments with deterministic checks.
- Promoted tests are executable source code. Review them before running, exactly like any pull-request code.
- Online job and result files are included by workspace backup and project quota accounting. Regression bundles should be copied into the repository deliberately only after reviewing their content.
- This loop supplies code and reproducible evidence; it does not claim independent adoption, a vendor-operated SLA, or automatic model correctness.
