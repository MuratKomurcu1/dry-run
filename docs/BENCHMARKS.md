# Benchmark methodology

The benchmark measures local `dry-run` replay overhead. It does not estimate provider latency and does not compare synthetic replay against a paid API call.

For the four-workflow correctness and integrity gate, see [Four evidence-backed workflow advantages](LEADERSHIP.md).

Run the reproducible suite:

```bash
npm run benchmark -- --scenarios 250 --iterations 15 \
  --output benchmarks/replay-local.json
```

The command:

1. builds the package;
2. creates a one-turn cassette in a temporary directory;
3. performs two warm-up suites;
4. constructs a fresh cassette replayer for every scenario;
5. reads and verifies a cassette-v2 checksum, canonical-matches the request, executes one agent turn, and evaluates `outputEquals`;
6. records every raw suite sample plus median and p95;
7. launches the real example CLI in a fresh Node.js process for a second, user-visible measurement;
8. fails if any replayed assertion or CLI run fails.

No result is uploaded automatically by the CLI. CI publishes its JSON only as a public Actions artifact.

## Recorded implementation check

On 2026-08-25, 250 single-turn cassette scenarios were measured for 15 iterations on arm64 macOS, Apple M5, Node 26.7.0:

| Metric | Result |
| --- | ---: |
| In-process suite median | 7.55 ms |
| In-process suite p95 | 8.89 ms |
| Median throughput | 33,112.58 scenarios/s |
| Fresh-process example CLI median | 46.97 ms |
| Fresh-process example CLI p95 | 48.96 ms |
| Provider network calls | 0 |
| Provider cost | $0 |

Raw v0.4 samples and platform details are committed in [`benchmarks/replay-macos-arm64-2026-08-25-v0.4.0.json`](../benchmarks/replay-macos-arm64-2026-08-25-v0.4.0.json). The older v0.3 sample remains in the directory for historical comparison; the formats and correctness work performed per replay differ.

## Control-plane ingest check

The separate control-plane benchmark starts a real team server and workspace, sends unique authenticated trace documents with bounded concurrency, waits for every response, and then checks analytics cardinality. Run it with:

```bash
npm run benchmark:control-plane -- --requests 2000 --concurrency 32 \
  --output benchmarks/control-plane-local.json
```

On 2026-08-26, arm64 macOS, Apple M5, Node 26.7.0, the 2,000-request run recorded:

| Metric | Result |
| --- | ---: |
| Accepted requests | 2,000 / 2,000 |
| Errors | 0 |
| Analytics unique resources | 2,000 / 2,000 |
| Throughput | 232.67 requests/s |
| p50 / p95 / p99 | 133.81 / 227.98 / 286.66 ms |
| Max latency | 353.94 ms |

The raw result is committed in [`benchmarks/control-plane-macos-arm64-2026-08-26-v0.7.0.json`](../benchmarks/control-plane-macos-arm64-2026-08-26-v0.7.0.json). This measures the local POSIX workspace plus in-memory analytical backend on one laptop. It is not a clustered ClickHouse capacity claim. Kubernetes storage, ingress, TLS, document size, and concurrent readers change the result; rerun the script on the target environment.

## Interpretation

- The high in-process throughput comes from a tiny, warm-filesystem, single-turn fixture. It is an implementation check, not a universal capacity claim.
- Real suites with large cassettes, multi-turn trajectories, tool execution, HTML output, or semantic judges will take longer.
- The fresh-process CLI measurement includes Node.js startup and module loading, but its example uses a deterministic mock rather than a network provider.
- Live-provider latency and cost are intentionally absent. Those values depend on the selected vendor, model, region, token count, and pricing date.
- The control-plane check uses one-span synthetic traces and a memory analytics backend. Its purpose is repeatable regression evidence and accepted-write/cardinality integrity, not a universal production sizing number.
- Filesystem cache, CPU power mode, Node version, antivirus, and background load affect results. Publish raw samples and platform details when sharing a number.

## Distributed dependency contract

`npm run verify:distributed` is a correctness/integration probe, not a capacity benchmark. It connects two independent Dry Run runtimes to real PostgreSQL 17, MinIO, and NATS JetStream services, then verifies optimistic revisions, stale-write rejection, checksum validation, idempotent concurrent trace writes, pagination, queue delivery, queue-triggered online evaluation, dependency readiness, and a trace written through one HTTP replica and read through the other.

The upgraded 2026-08-27 macOS arm64 run passed 17 contracts, adding serialized migrations, encrypted cold-node hydration, cross-replica non-trace state, DLQ redrive, and portable recovery. Dependency health values are single local samples, not throughput percentiles or production sizing claims. The machine-readable report is [`benchmarks/distributed-macos-arm64-2026-08-27-v0.8.0.json`](../benchmarks/distributed-macos-arm64-2026-08-27-v0.8.0.json).

## Stateless HA capacity and node eviction

Run the configurable real-service profile with:

```bash
npm run verify:chaos -- --nodes 4 --traces 1000000 --batch-size 500 --concurrency 32 --output ha-million.json
```

The 2026-08-27 run used four independent workspace directories, PostgreSQL 17, MinIO, NATS JetStream, encrypted remote state, and batched trace artifacts. It gracefully evicted one application node at 33% completion, retried through the remaining nodes, checked exact PostgreSQL index cardinality, and read samples after failover. Results: 1,000,000 accepted, 1,000,000 indexed, zero duplicates, zero loss, 12,196.56 traces/s, batch p50 1,289.24 ms, p95 1,396.71 ms, and p99 1,453.96 ms. Raw evidence: [`benchmarks/ha-million-macos-arm64-2026-08-27-v0.8.0.json`](../benchmarks/ha-million-macos-arm64-2026-08-27-v0.8.0.json).

This is not an abrupt SIGKILL, dependency partition, multi-region, or soak test. Throughput depends on payload size, batch size, PostgreSQL/MinIO placement, disk, TLS, and machine capacity. Re-run it on the intended environment; do not convert one laptop run into an SLA.

## Leadership correctness and integrity gate

`npm run benchmark:leadership` measures four implementation contracts rather than inventing a speed race against hosted products. The 2026-08-26 Apple M5 run observed:

| Contract | Result | 95% Wilson interval |
| --- | ---: | ---: |
| Checksum-verified offline replay | 3,500 / 3,500 | 99.8904%–100% |
| Production trace → evaluation → review | 1,400 / 1,400 | 99.7264%–100% |
| Duplicate review items on cached retry | 0 / 1,400 | 0%–0.2736% occurrence |
| Complete and verified promoted regression | 100 / 100 | 96.3007%–100% |
| Deliberate artifact mutation detected | 600 / 600 | 99.3638%–100% |

The full method, exact workflow definitions, competitor-documentation boundary, rerun command, and limitations are in [`LEADERSHIP.md`](LEADERSHIP.md). Machine-readable raw samples are in [`benchmarks/leadership-macos-arm64-2026-08-26-v0.8.0.json`](../benchmarks/leadership-macos-arm64-2026-08-26-v0.8.0.json). CI executes a smaller smoke profile and retains the JSON artifact. The samples validate Dry Run itself; they do not statistically measure competitor implementations.
