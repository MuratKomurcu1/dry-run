# Architecture

`dry-run` separates agent execution, provider traffic, persisted evidence, and deterministic assertions. It can wrap an existing agent or provide a small ReAct harness, but it does not require a hosted service.

## Data flow

```text
scenario input
     │
     ▼
agent / ReAct loop ──────── tool implementations
     │                            │
     ▼                            ▼
provider interface          cachedTools (optional)
     │                            │
     ├── record ──► redaction ────┴──► JSON cassette/cache
     │
     ├── replay ◄──────────────────── JSON cassette
     │
     └── passthrough ─────────────────► live provider
     │
     ▼
trajectory: LLM steps + tool calls + output + usage
     │
     ├── deterministic assertions
     ├── golden baseline / cassette diff
     ├── JUnit XML
     └── self-contained HTML report
```

## Core modules

| Module | Responsibility |
| --- | --- |
| `agent.ts` | Minimal provider-independent ReAct loop and trajectory capture |
| `cassette.ts` | Record/replay modes, shape signatures, persistence, redaction |
| `cached-tools.ts` | Optional tool-boundary result recording with hashed argument keys |
| `assertions.ts` | Deterministic trajectory, output, loop, and token assertions |
| `runner.ts` | Scenario discovery, timeout enforcement, execution, JUnit hooks |
| `golden.ts` / `diff.ts` | Regression baselines and human-readable drift |
| `html-report.ts` / `junit.ts` | Portable output for reviewers and CI systems |
| `providers/` | Native OpenAI-compatible and Anthropic adapters |
| `adapters/vercel-ai.ts` | Vercel AI SDK language-model bridge |
| `cli.ts` | `run`, `init`, `diff`, `golden`, and `generate` commands |

## Determinism contract

Replay returns the recorded provider response only when the current request has the same structural signature as the recording. The signature includes the selected model, ordered message roles, prior tool-call names, and available tool names. It deliberately ignores prompt wording and tool-result values.

This catches changes that alter the agent trajectory without invalidating a cassette for harmless wording edits. It does not prove semantic equivalence; use output/trajectory assertions or an explicitly configured LLM judge for that.

## Persistence contract

Cassettes are arrays of request/response interactions stored as readable JSON. A corrupt or incorrectly shaped file is an error. Recorder writes are synchronous so a completed provider turn is persisted before control returns to the agent loop.

Tool caches use a separate `.dryrun/tools/` namespace. Argument JSON is hashed before it becomes a disk key, and returned values pass through the same secret-shaped redaction layer as cassettes by default.

## Non-goals

- Sandboxing scenario or tool code.
- Replacing offline unit tests or online quality evaluations.
- Guaranteeing that every secret or personal-data pattern can be detected.
- Making live LLM output deterministic.
- Providing a hosted dashboard, trace store, or production observability backend.
