# Verification evidence

`dry-run` keeps its release claims independently inspectable.

## Automated contract

The public CI matrix runs on Node.js 22 and 24 and requires:

- TypeScript compilation;
- the complete offline Vitest suite;
- real CLI discovery and execution of the example scenario;
- a replay benchmark smoke run with machine-readable output.

The `0.3.1` local release verification contains 37 tests across cassette/cache integrity, provider-error and persisted-data redaction, hashed and migrated tool-cache keys, replay-miss log safety, fail-closed mode handling, composite-Action shell safety, assertions, golden baselines, generated tests, HTML reports, Vercel AI SDK integration, CLI overwrite safety, and config-driven JUnit output.

The composite GitHub Action is stored at [`.github/actions/dry-run/action.yml`](../.github/actions/dry-run/action.yml). Consumers can pin a tag rather than trusting a moving branch:

```yaml
- uses: MuratKomurcu1/dry-run/.github/actions/dry-run@v0.3.1
  with:
    paths: tests
    mode: replay
```

## What this evidence does not prove

- Live OpenAI, Anthropic, or compatible-provider availability.
- Quality of a particular prompt or agent response.
- Safe execution of untrusted scenario/tool code.
- Detection of every possible secret or personal-data format.

Those boundaries are documented in [`SECURITY.md`](../SECURITY.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).
