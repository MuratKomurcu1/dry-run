# Security policy

## Supported versions

Security fixes are applied to the latest published minor line. The current source line is `0.8.x`.

## Trust boundaries

`dry-run` is a test runner and record/replay library. Its optional network boundary is **not** a general-purpose code sandbox.

- Scenario files are executable JavaScript or TypeScript and run with the invoking user's permissions.
- Agent tool implementations run with the permissions the host application gives them.
- Record and passthrough modes send prompts, tool schemas, and conversation state to the configured provider.
- Replay mode reads local cassette data and performs no provider call. Scenario-owned network code is blocked only when `--deny-network` is enabled.
- HTML and JUnit reports may contain agent output. Treat them with the same sensitivity as the source cassette.
- Datasets, experiment results, traces, feedback, and prompt versions may contain user inputs, retrieved context, business data, and model output.
- Synthetic generation sends supplied source material to the configured provider. Use a local provider when documents must not leave the machine.

Do not run untrusted scenarios, generated tests, native addons, Python code, or tool implementations. Cassettes are data, but generated tests are executable code and must be reviewed.

## Cassette and tool-cache data

Cassettes intentionally persist LLM requests and responses. Secret-shaped values are redacted before a recorder writes them:

- common OpenAI, classic and fine-grained GitHub, npm, AWS, Slack, bearer-token, and JWT forms;
- scalar values under keys resembling `authorization`, `apiKey`, `secret`, `token`, `password`, `cookie`, or `session`.

Cached-tool arguments are represented on disk by SHA-256 keys instead of raw values and secret-shaped tool results are redacted before persistence. The serializer distinguishes bigint, undefined, dates, maps, sets and non-finite numbers and rejects circular inputs. Legacy caches are migrated on read. Provider error snippets are redacted before they are surfaced. Cassette, tool-cache, dataset, experiment, trace, and prompt writes use owner-only modes (`0700` directories and `0600` files) on POSIX; mutable stores use locks, stale-lock recovery, temporary files, and atomic replacement.

Replay cache-miss errors expose only the argument fingerprint, never the raw arguments. Invalid `DRYRUN_MODE` values fail closed instead of falling back to auto mode. The composite GitHub Action passes inputs through quoted environment variables and arrays, validates its mode allowlist, and pins third-party Action code to full commit SHAs.

Redaction is defense in depth, not a data-loss-prevention system. It cannot identify every proprietary identifier, personal record, arbitrary password embedded in prose, or newly invented credential format. Review every cassette and report before committing, uploading, or sharing it. Keep `.dryrun/tools/` out of version control unless its contents have been explicitly reviewed.

The PII safety scorer recognizes common patterns and masks findings in its result details. It is a regression signal, not comprehensive DLP or regulatory compliance evidence.

`DRYRUN_NO_REDACT=1` disables built-in redaction. Use it only with synthetic data in a controlled environment.

Online rule results, playground runs, regression bundles, and PR reports can repeat trace inputs and model outputs. They use the same owner-only persistence and redaction boundary, but redaction is not a guarantee. Review promoted datasets/cassettes/tests and generated reports before committing or uploading them. Generated regression tests are executable source code.

## Integrity and replay semantics

- A malformed cassette fails loudly; it is never treated as an empty successful recording.
- New recordings default to canonical matching over prompt content, prior tool results/arguments, tool schemas, model and supported generation parameters. `exact`, `shape` and custom policies are explicit alternatives.
- Every v2 recording stores request fingerprints and a SHA-256 checksum over canonicalized interactions. A checksum detects corruption or unreviewed manual edits; it is not a signature and provides no authenticity against a malicious writer.
- Legacy v1 arrays migrate with `shape` matching for compatibility. Migrate them explicitly before relying on the stronger canonical default.
- Protect trusted cassettes and baselines with normal Git review and branch protection.

## Network and credentials

`dry-run` has no vendor-operated hosted control plane. Its optional team server runs only when the operator starts it. Runtime dependencies include Ajv for JSON Schema assertions and opt-in PostgreSQL, S3-compatible, and NATS clients for distributed mode. Provider credentials are read from the local process environment and sent only to the explicitly configured provider base URL. Custom model, HTTP/A2A/team, PostgreSQL, S3, NATS, OIDC, SCIM, webhook, and OTLP endpoints expand that trust boundary; review and isolate them before use.

With `--deny-network`, Node 26+ re-executes the test process under Node permissions without `--allow-net`, then also guards `fetch`, HTTP(S), TCP, TLS and UDP entry points. Node 22/24 receive the runtime guards but not the permission-enforced network boundary. The CLI prints which level is active. Record and passthrough runs should not use this option because they intentionally require network access.

Timeout cancellation uses `AbortSignal`. Built-in providers and the ReAct harness honor it. Custom agents and tools must propagate the supplied signal to stop their own in-flight side effects.

Local-judge discovery and Playground automatic configuration accept only `localhost`, `127.0.0.1`, or `::1` endpoints without URL credentials, query, or fragment. Ollama, vLLM, and LM Studio receive evaluation prompts and trace-derived content; their model files, plugins, logs, and host process remain outside Dry Run's trust boundary. A local model has no provider bill but still consumes local compute.

GitHub PR comments use `GITHUB_TOKEN` only in an authorization header, refuse non-HTTPS or credential-bearing API URLs, and refuse redirects. Grant `issues: write` only to trusted workflows. Fork pull requests usually have read-only tokens; do not work around that by running untrusted code with `pull_request_target` privileges.

## Local Studio

Studio is designed for local use only. It accepts only `127.0.0.1` or `::1`, generates a random bearer token, places the initial token in the URL fragment, validates `Host`, validates `Origin` on writes, limits JSON request bodies, and sets CSP, frame, content-type, referrer, and no-store headers. It loads no external JavaScript, CSS, fonts, images, or analytics.

Do not reverse-proxy or expose Studio to a LAN or the internet. It has no user accounts, TLS termination, rate limiting, organization authorization, or remote-session hardening. The bearer token protects local API access; it does not convert the process into a multi-user service.

## Self-hosted team server

Team mode is a separate opt-in service; Studio's loopback-only boundary is unchanged. The team server:

- defaults to `127.0.0.1` and refuses non-loopback plaintext listeners unless the operator supplies the development-only override;
- supports in-process TLS 1.2+ certificates/keys and should otherwise sit behind a correctly configured TLS reverse proxy only on a trusted network;
- stores API, member-session, and invitation tokens only as SHA-256 hashes and shows raw tokens once;
- supports custom roles beneath built-in capability ceilings, reusable member/project groups, service accounts, and bounded key-rotation grace periods;
- supports expiring one-time invitations, named members, expiring member bearer tokens, project scopes, role changes, and immediate suspension; ingest-only automation remains a separate service identity;
- optionally supports OIDC Authorization Code + PKCE S256 with state/nonce, signed short-lived transaction cookies, exact issuer/audience/`azp`/time checks, JWKS signature verification, verified-email policy, safe return paths, and group-to-role/project mapping;
- optionally supports SCIM 2.0 user discovery/filter/create/replace/patch/suspend/deprovision behind a separate bearer token; the SCIM token is compared through fixed-length hashes and is never accepted as a team API credential;
- enforces `admin`, `editor`, `viewer`, and `ingest` capabilities server-side; a scoped principal is centrally barred from workspace-global member/key/project/audit/retention administration;
- supports restrictive, revisioned per-object member/key grants beneath project RBAC for traces, experiments, prompts, review queues, online rules, playground runs, regressions, and quality monitors; project role remains a ceiling and administrators bypass object policy for recovery;
- applies CSP, framing, MIME, referrer, permissions, HSTS-on-TLS, no-store, CORS allowlist, request-size, concurrent-body, timeout, and per-key/IP rate limits;
- bounds cumulative project storage with atomically checked byte/file quotas and bounds collection responses with cursor pagination and scan limits;
- redacts credential-shaped audit detail fields and never writes Authorization headers or raw request bodies to audit records;
- validates resource identifiers before mapping them to filesystem paths;
- leaves retention disabled by default. Workspace policy can be overridden per project, an authorized admin must enable it, and direct CLI deletion also requires `--yes`.

OIDC trusts the configured issuer and its signing keys. Use HTTPS, pin the expected issuer/client/callback values, rotate the cookie/client secrets, restrict accepted email domains where appropriate, and map groups narrowly. Stateless signed login transactions allow callbacks on any replica but do not make a compromised signing secret safe. SCIM is an administrative provisioning surface: place it behind TLS and network policy, use a high-entropy dedicated token, rotate it deliberately, and review audit/lifecycle changes.

Optional ClickHouse analytics send credentials only in headers, refuse redirects, validate SQL identifiers, and parameterize tenant/time filters. Object policy is enforced on canonical trace/experiment payload drill-down, but aggregate counts, time series, facets, and percentiles are project-level; the aggregate table is not a row-level authorization boundary. Use TLS outside a private loopback/bridge, a least-privilege ClickHouse account, encryption at rest, network ACLs, retention limits, and protected backups. Canonical experiments and non-distributed traces remain in the workspace; distributed mode places trace bodies/indexes in S3/PostgreSQL while retaining a workspace cache for online evaluation.

Distributed mode requires PostgreSQL, S3/MinIO, and NATS together. PostgreSQL operations are parameterized and tenant-scoped; trace artifacts are content-addressed and verified by SHA-256; the transactional outbox prevents an accepted index write from silently losing its queue event; JetStream delivery is explicit-ack with bounded redelivery. Use TLS and separate least-privilege credentials outside a private network, assign one stream per workspace, enable storage encryption/versioning/backups, and restrict dependency ingress. The artifact checksum detects corruption or mismatch, not a malicious operator with write access to every state plane. Standard `/v1/traces` ingest requires a team token and project authorization; ordinary OTLP exporters therefore carry a bearer credential.

Prometheus metrics require either a dedicated `DRYRUN_METRICS_TOKEN` or a read-capable team identity. Prefer the dedicated token so the monitoring system has no project/admin capability. Metrics normalize project and resource identifiers to bounded route labels, but endpoint names, status codes, request rates, and latency remain operational metadata.

These controls do not provide passwords, password recovery, social login, automated email delivery, network firewalling, volumetric DDoS protection, distributed consensus for the remaining workspace store, database row-level security, encrypted application payloads at rest, managed backups, multi-region disaster recovery, or a vendor-operated SLA. Named members are attributable when each person uses their own invitation/session; shared service keys are not. Deliver invitation tokens through a secure out-of-band channel, issue one least-privilege key per service, and use OS/disk encryption plus protected backups when traces contain sensitive data.

The checked-in Compose stack is a local reference deployment and intentionally enables plaintext backend HTTP, an insecure local issuer, and non-Secure cookies on `*.localhost`. Never expose it unchanged. The production procedure in [`docs/OPERATIONS.md`](docs/OPERATIONS.md) requires public HTTPS and removal of all three insecure-development flags.

`RemoteTraceExporter` accepts plaintext HTTP only for an explicitly enabled loopback endpoint, rejects redirects and endpoint URLs containing credentials/query/fragment, and never logs its bearer token. It spools redacted trace documents to owner-only local files before upload and deletes a file only after the server accepts the exact version that was sent. Default fail-closed limits are 512 MiB, 50,000 files, and a 64 MiB free-space floor; tune them for the host. A compromised endpoint still receives trace content, so validate its certificate and ownership. The embedding application remains responsible for secret injection and rotation.

Retention deletes only validated trace/experiment JSON files, completed/skipped annotation records, and quality-monitor results older than the cutoff. Remote traces use a server-owned receipt timestamp. Immediately before deletion, the service acquires the writer lock, re-reads the current document, and rechecks schema/state/time; invalid, refreshed, or replaced files and prompt history are left untouched. Preview with `team retention plan`, back up required evidence, then apply deliberately.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials or private cassette data. Use GitHub's private vulnerability reporting for [`MuratKomurcu1/dry-run`](https://github.com/MuratKomurcu1/dry-run/security), or contact the repository owner privately before disclosure.

Include the affected version, platform, minimal reproduction, expected impact, and whether any credential or recorded data may have been exposed.
