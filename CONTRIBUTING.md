# Contributing to dry-run

Thanks for helping make agent testing boring — in the good way.

## Dev setup

```bash
git clone https://github.com/muratkomurcu/dry-run
cd dry-run
npm install
npm run build
npm test
```

Requirements: Node >= 22.18. No runtime dependencies — ever. That's a design constraint, not an accident: a testing tool must not add install weight to the projects it protects.

## Project layout

```
src/
  types.ts        Core domain: Trajectory, Scenario, Assertion, LLMProvider
  agent.ts        defineAgent() ReAct harness
  providers/      MockProvider, OpenAIProvider (any OpenAI-compatible), AnthropicProvider
  cassette.ts     Record/replay engine, request signatures, secret redaction
  cached-tools.ts Tool-boundary caching (cachedTools)
  assertions.ts   Deterministic assertion evaluation
  runner.ts       Scenario discovery + execution + judge wiring
  reporter.ts     Terminal output
  junit.ts        JUnit XML export
  adapters/       Vercel AI SDK model wrapper
  cli.ts          dry-run run | init
test/             vitest suites (all offline)
examples/         Runnable example scenarios
```

## Principles

1. **Zero runtime dependencies.** Everything ships in the box.
2. **Deterministic by default.** A test that passes twice and fails once is a bug in dry-run, not in flakiness.
3. **Fail loudly, never silently.** Stale cassettes and cache misses throw with instructions, never serve wrong data.
4. **Secrets never hit disk.** Redaction is on by default; if you find a leak path, that's a P0.
5. **Offline CI.** Every test in this repo runs without network access or API keys.

## Adding a feature

- Open an issue first if it changes public API or cassette file format (backwards compatibility matters — users commit cassettes to git).
- Add tests. PRs without tests need a very good story.
- Update `README.md` if user-facing.

## Release checklist

- [ ] `npm run build && npm test`
- [ ] `node dist/cli.js run examples` green
- [ ] Bump version in `package.json`
- [ ] Update README badges/changelog
- [ ] `npm publish`

## License

MIT. By contributing you agree your contributions are licensed under MIT.
