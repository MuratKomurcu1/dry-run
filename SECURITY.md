# Security policy

## Supported versions

Security fixes are applied to the latest published minor line. At the time of this release, that is `0.3.x`.

## Trust boundaries

`dry-run` is a test runner and record/replay library. It is **not** a sandbox.

- Scenario files are executable JavaScript or TypeScript and run with the invoking user's permissions.
- Agent tool implementations run with the permissions the host application gives them.
- Record and passthrough modes send prompts, tool schemas, and conversation state to the configured provider.
- Replay mode reads local cassette data and performs no provider call unless the scenario itself contains unrelated network code.
- HTML and JUnit reports may contain agent output. Treat them with the same sensitivity as the source cassette.

Do not run untrusted scenarios, cassettes, generated tests, or tool implementations.

## Cassette and tool-cache data

Cassettes intentionally persist LLM requests and responses. Secret-shaped values are redacted before a recorder writes them:

- common OpenAI, classic and fine-grained GitHub, npm, AWS, Slack, bearer-token, and JWT forms;
- scalar values under keys resembling `authorization`, `apiKey`, `secret`, `token`, `password`, `cookie`, or `session`.

Starting with `0.3.1`, cached-tool arguments are represented on disk by SHA-256 keys instead of raw JSON and secret-shaped tool results are redacted before persistence. Legacy caches are migrated on read. Provider error snippets are redacted before they are surfaced. Cassette and tool-cache writes use an atomic replacement and owner-only modes (`0700` directories and `0600` files) on POSIX systems.

Replay cache-miss errors expose only the argument fingerprint, never the raw arguments. Invalid `DRYRUN_MODE` values fail closed instead of falling back to auto mode. The composite GitHub Action passes inputs through quoted environment variables and arrays, validates its mode allowlist, and pins third-party Action code to full commit SHAs.

Redaction is defense in depth, not a data-loss-prevention system. It cannot identify every proprietary identifier, personal record, arbitrary password embedded in prose, or newly invented credential format. Review every cassette and report before committing, uploading, or sharing it. Keep `.dryrun/tools/` out of version control unless its contents have been explicitly reviewed.

`DRYRUN_NO_REDACT=1` disables built-in redaction. Use it only with synthetic data in a controlled environment.

## Integrity and replay semantics

- A malformed cassette fails loudly; it is never treated as an empty successful recording.
- Replay checks conversation shape: model, message roles, tool-call sequence, and available tool names.
- Prompt wording is deliberately excluded from the signature so harmless copy edits can reuse a recording.
- Shape signatures detect stale fixtures; they are not cryptographic authenticity proofs.
- Cassette JSON is reviewable and editable. Protect trusted baselines with normal Git review and branch protection.

## Network and credentials

`dry-run` has zero runtime package dependencies and no hosted control plane. Provider credentials are read from the local process environment and sent only to the explicitly configured provider base URL. Custom `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` values expand that trust boundary; review them before use.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials or private cassette data. Use GitHub's private vulnerability reporting for [`MuratKomurcu1/dry-run`](https://github.com/MuratKomurcu1/dry-run/security), or contact the repository owner privately before disclosure.

Include the affected version, platform, minimal reproduction, expected impact, and whether any credential or recorded data may have been exposed.
