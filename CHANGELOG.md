# Changelog

All notable changes to this project are documented here.

## [0.3.1] - 2026-08-25

### Fixed

- Correct every GitHub-facing URL to `MuratKomurcu1/dry-run`, including npm metadata, CLI help, CI badges, contribution instructions, and the composite Action example.
- Honor `junitPath` from `dryrun.config.json`.
- Refuse to overwrite an existing starter scenario during `dry-run init`.
- Fail loudly on corrupt or incorrectly shaped cassette files.
- Fail closed on an invalid `DRYRUN_MODE` instead of silently falling back to network-capable auto mode.
- Redact secret-shaped provider error bodies before displaying them.

### Security

- Hash cached-tool argument keys before persistence so raw arguments are not stored as JSON object keys.
- Keep cached-tool arguments out of replay-miss errors and redact fine-grained GitHub and npm token forms.
- Redact secret-shaped cached-tool results by default while preserving legacy-cache reads.
- Atomically persist cassettes and tool caches with owner-only POSIX permissions; migrate legacy raw cache keys on read.
- Remove shell interpolation of composite-Action inputs and pin every first-party GitHub Action to a full commit SHA.
- Document executable-code, provider-network, redaction, and report-data trust boundaries.

### Added

- Reproducible replay and fresh-process CLI benchmarks with raw JSON samples.
- Real CLI demo GIF and 1280×640 social artwork.
- Architecture, evidence, benchmark, comparison, release, and security documentation.
- CI benchmark smoke job with a machine-readable artifact.

## [0.3.0] - 2026-08-25

- Initial public release: record/replay cassettes, deterministic trajectory assertions, provider and Vercel AI SDK adapters, tool caching, golden baselines, diff/generate commands, HTML/JUnit output, CLI, and composite GitHub Action.

[0.3.1]: https://github.com/MuratKomurcu1/dry-run/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MuratKomurcu1/dry-run/releases/tag/v0.3.0
