# Contributing to dry-run

Thanks for helping make agent testing boring — in the good way.

## Dev setup

```bash
git clone https://github.com/MuratKomurcu1/dry-run
cd dry-run
npm install
npm run build
npm test
```

Requirements: Node >= 22.18 and Python >= 3.10 for the cross-runtime verification. Runtime dependencies must remain small, audited and justified; Ajv provides standards-compliant JSON Schema assertions.

## Project layout

```
src/
  types.ts        Core domain: Trajectory, Scenario, Assertion, LLMProvider
  agent.ts        defineAgent() ReAct harness
  providers/      Mock, OpenAI Chat/Responses, Anthropic, generic HTTP
  integrations/   OpenAI Agents, LangGraph, OTLP/Jaeger, A2A bridges
  cassette.ts     v1 migration, v2 envelope, matching, checksums, redaction
  cached-tools.ts Tool-boundary caching (cachedTools)
  dataset.ts      Versioned JSON/JSONL/CSV evaluation cases
  scorers.ts      Deterministic, judge, retrieval, security and composite scores
  experiment.ts   Trials, resume, persistence, aggregates and comparison
  tracing.ts      Nested spans, local trace store, feedback and OTLP export
  prompts.ts      Immutable checksummed prompt versions and labels
  generation.ts   Synthetic and adversarial dataset generation
  studio.ts       Token-protected loopback experiment/trace/prompt UI
  assertions.ts   Deterministic assertion evaluation
  runner.ts       Discovery, selection, parallel trials/retries, cancellation, judge wiring
  reporter.ts     Terminal output
  junit.ts        JUnit XML export
  adapters/       Vercel AI SDK generation/stream bridge
  cli.ts          regression, evaluation, dataset, trace, prompt and Studio commands
python/           cassette-compatible Python reader/replayer/runner
test/             vitest suites (all offline)
examples/         Runnable example scenarios
```

## Principles

1. **Minimal runtime surface.** A dependency must buy standards compliance or security and pass audit.
2. **Deterministic by default.** A test that passes twice and fails once is a bug in dry-run, not in flakiness.
3. **Fail loudly, never silently.** Stale cassettes and cache misses throw with instructions, never serve wrong data.
4. **Secret-shaped values are redacted before persistence.** Redaction is defense in depth, not a substitute for reviewing cassettes before commit; a leak path is a P0.
5. **Offline CI.** Every test in this repo runs without network access or API keys.

## Adding a feature

- Open an issue first if it changes public API or cassette file format (backwards compatibility matters — users commit cassettes to git).
- Add tests. PRs without tests need a very good story.
- Update `README.md` if user-facing.

## Release checklist

- [ ] `npm run verify`
- [ ] `node dist/cli.js run examples` green
- [ ] Bump version in `package.json`
- [ ] Update README badges/changelog
- [ ] `npm publish`

## License

MIT. By contributing you agree your contributions are licensed under MIT.
