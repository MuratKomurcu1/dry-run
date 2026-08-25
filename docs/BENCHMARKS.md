# Benchmark methodology

The benchmark measures local `dry-run` replay overhead. It does not estimate provider latency and does not compare synthetic replay against a paid API call.

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
5. reads the cassette, executes one agent turn, and evaluates `outputEquals`;
6. records every raw suite sample plus median and p95;
7. launches the real example CLI in a fresh Node.js process for a second, user-visible measurement;
8. fails if any replayed assertion or CLI run fails.

No result is uploaded automatically by the CLI. CI publishes its JSON only as a public Actions artifact.

## Recorded implementation check

On 2026-08-25, 250 single-turn cassette scenarios were measured for 15 iterations on arm64 macOS, Apple M5, Node 26.7.0:

| Metric | Result |
| --- | ---: |
| In-process suite median | 2.96 ms |
| In-process suite p95 | 3.40 ms |
| Median throughput | 84,459.46 scenarios/s |
| Fresh-process example CLI median | 35.23 ms |
| Fresh-process example CLI p95 | 37.78 ms |
| Provider network calls | 0 |
| Provider cost | $0 |

Raw samples and platform details are committed in [`benchmarks/replay-macos-arm64-2026-08-25.json`](../benchmarks/replay-macos-arm64-2026-08-25.json).

## Interpretation

- The high in-process throughput comes from a tiny, warm-filesystem, single-turn fixture. It is an implementation check, not a universal capacity claim.
- Real suites with large cassettes, multi-turn trajectories, tool execution, HTML output, or semantic judges will take longer.
- The fresh-process CLI measurement includes Node.js startup and module loading, but its example uses a deterministic mock rather than a network provider.
- Live-provider latency and cost are intentionally absent. Those values depend on the selected vendor, model, region, token count, and pricing date.
- Filesystem cache, CPU power mode, Node version, antivirus, and background load affect results. Publish raw samples and platform details when sharing a number.
