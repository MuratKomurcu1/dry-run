# Operating Dry Run with free, open-source infrastructure

Dry Run ships the controls needed to operate a service reliably; it does not sell or claim a managed SLA. The operator owns capacity, upgrades, backups, incident response, certificates, and the resulting availability commitment.

The reference stack uses only open-source components:

```text
browser / Python SDK / OTLP exporter
      │
  Caddy load balancer ───────────── Keycloak + PostgreSQL
      │                              OIDC login
      ├──────────────┐
 Dry Run A       Dry Run B ───────── ClickHouse analytics
      │              │
      ├──── PostgreSQL control/outbox/migrations
      ├──── MinIO encrypted state + batched trace artifacts
      ├──── NATS JetStream jobs + DLQ
      └──── independent ephemeral disks ── Prometheus → Alertmanager → Grafana
```

It demonstrates independent stateless HTTP nodes, standards-based SSO, a shared analytical plane, distributed control/data/job dependencies, health-aware routing, monitoring, alerts, and graceful shutdown. PostgreSQL stores revisioned pointers, migrations, and outbox events; MinIO stores encrypted workspace snapshots and content-addressed NDJSON trace batches; NATS JetStream carries durable jobs and dead letters. On one Docker host this protects against an application-process failure, not host or region failure.

## Start the reference stack

Requirements are Docker Engine with Compose v2 and `openssl`. The checked-in stack listens on `quality.localhost:8080`; Grafana and Prometheus listen only on loopback.

```bash
cp deploy/.env.example deploy/.env
mkdir -p deploy/secrets
chmod 700 deploy/secrets
openssl rand -hex 32 > deploy/secrets/dryrun_metrics_token
chmod 600 deploy/secrets/dryrun_metrics_token
```

Set every value in `deploy/.env`. `DRYRUN_METRICS_TOKEN` must exactly equal the single line in `DRYRUN_METRICS_TOKEN_FILE`; use an absolute file path. Initialize the workspace once and retain the one-time admin token outside the repository:

```bash
docker compose --env-file deploy/.env -f deploy/compose.ha.yml --profile tools run --rm dryrun-init
docker compose --env-file deploy/.env -f deploy/compose.ha.yml up -d --build
```

Open `http://quality.localhost:8080`. Keycloak's bootstrap administrator can create users in the `dryrun` realm and assign `/dryrun-admins`, `/dryrun-editors`, or `/dryrun-viewers`. The bundled client uses Authorization Code + PKCE. Grafana is at `http://127.0.0.1:3000`; Prometheus is at `http://127.0.0.1:9090`.

The reference stack deliberately uses HTTP on the local Docker bridge and `*.localhost`. Before any public deployment, remove `--allow-insecure-remote`, `--oidc-allow-insecure`, and `--oidc-insecure-cookies`; use HTTPS for the public issuer/callback and either in-process TLS or a private backend network behind a TLS reverse proxy.

## Kubernetes and Helm

The chart defaults to two replicas and includes rolling updates, startup/liveness/readiness probes, HPA, PDB, pod anti-affinity, topology spread, restricted non-root/read-only containers, NetworkPolicy, optional Ingress, and optional Prometheus Operator `ServiceMonitor`. Local mode uses a PVC. Distributed mode uses a bootstrap Job plus independent `emptyDir` caches; it does not request RWX storage.

```bash
helm lint deploy/helm/dry-run \
  --set-string secrets.metricsToken="$(openssl rand -hex 32)"

helm upgrade --install dry-run deploy/helm/dry-run \
  --namespace dry-run --create-namespace \
  --values production-values.yaml
```

Use an existing Kubernetes Secret in production; do not commit secret values in Helm values. Configure external PostgreSQL, S3-compatible storage, NATS, HTTPS ClickHouse, TLS ingress, and OIDC as needed. Set `distributed.enabled=true`, provide the dependency endpoints, and set `secrets.stateEncryptionKey` to a private 32+ character value. The bootstrap Job prints the one-time initial admin token in its logs; capture it through your secret-management procedure and then delete those logs according to policy. `helm lint` covers minimal and stateless-distributed profiles.

## Identity and provisioning

OIDC configuration uses these variables:

| Variable | Purpose |
| --- | --- |
| `DRYRUN_OIDC_ISSUER` | Exact issuer used for discovery and ID-token validation |
| `DRYRUN_OIDC_CLIENT_ID` / `DRYRUN_OIDC_CLIENT_SECRET` | Public or confidential OIDC client |
| `DRYRUN_OIDC_REDIRECT_URI` | Exact callback URI |
| `DRYRUN_OIDC_COOKIE_SECRET` | HMAC key for short-lived stateless login transactions |
| `DRYRUN_OIDC_ROLE_MAPPINGS` | JSON group-to-role/project mapping array |
| `DRYRUN_OIDC_ALLOWED_DOMAINS` | Optional comma-separated email domain allowlist |

The implementation validates state, nonce, issuer, audience/`azp`, timestamps, JWKS signatures, verified email, PKCE S256, safe return paths, and supported RS256/PS256/ES256 algorithms. Login transactions are signed rather than node-local, so callbacks can land on either replica.

SCIM 2.0 is enabled by `DRYRUN_SCIM_TOKEN` and supports discovery, filtering, create/replace/patch, activation, suspension, and deprovisioning at `/scim/v2/Users`. Use a separate high-entropy SCIM bearer token; it is not a team API key. `DRYRUN_SCIM_BASE_URL`, default role, and default projects are optional.

## Shared analytics

Set `DRYRUN_CLICKHOUSE_URL` on every Dry Run node. Inserts are idempotent by workspace, project, resource kind, and resource ID; `ReplacingMergeTree(version)` plus `argMax` summaries prevent a retried or updated resource from being counted twice. Credentials are sent in headers, redirects are refused, identifiers are validated, and summary filters are parameterized.

The included ClickHouse is one analytical node shared by both application replicas. For host-level analytical HA, deploy ClickHouse Keeper plus replicated local tables and a Distributed table named as Dry Run expects (default `dryrun.dryrun_events`), set `DRYRUN_CLICKHOUSE_CREATE_SCHEMA=false`, and point every application node at the clustered HTTPS endpoint. Dry Run then uses the same insert/query contract without owning cluster orchestration.

When distributed mode is disabled, canonical detailed documents remain in the local workspace. When enabled, trace bodies/indexes use MinIO/PostgreSQL and non-trace stores are captured in encrypted immutable snapshots coordinated by a PostgreSQL advisory lock and CAS pointer. A cold replica hydrates from that pointer before accepting work. Node-local files are projections/caches; no shared filesystem is required. ClickHouse remains the analytical search/retention plane.

## Distributed trace plane

Distributed mode activates only when all required variables are present:

| Variable | Purpose |
| --- | --- |
| `DRYRUN_POSTGRES_URL` | revisioned scoped control records and transactional outbox |
| `DRYRUN_S3_ENDPOINT` / `DRYRUN_S3_BUCKET` | content-addressed trace artifacts |
| `DRYRUN_S3_ACCESS_KEY` / `DRYRUN_S3_SECRET_KEY` | optional paired S3 credentials |
| `DRYRUN_NATS_URL` | JetStream work queue and outbox delivery |
| `DRYRUN_STATE_ENCRYPTION_KEY` | 32+ character application-layer key for AES-256-GCM workspace/recovery encryption |
| `DRYRUN_WORKSPACE_ALIAS` | stable bootstrap identity used by empty nodes; defaults to `default` |

Optional schema, pool, region, TLS, path-style, stream, subject-prefix, replica, and relay-interval variables are represented in Helm and Compose. Startup fails on a partial configuration or a missing/short state key. Readiness checks PostgreSQL, the artifact bucket, NATS, and the encrypted state revision. `npm run verify:distributed` exercises serialized migrations, optimistic revisions, checksums, cold-node hydration, cross-replica non-trace state, batch/single trace paths, DLQ redrive, portable recovery, and queue-triggered evaluation.

The batch endpoint accepts 1–500 traces. In distributed mode a multi-trace request produces one immutable NDJSON object, one PostgreSQL batch upsert, and one JetStream batch event. Use `npm run verify:chaos -- --nodes 4 --traces 1000000 --batch-size 500 --concurrency 32 --output report.json` for the full capacity profile on the target hardware.

## Health, metrics, and shutdown

| Endpoint | Authentication | Meaning |
| --- | --- | --- |
| `/api/v1/health/live` | none | Process accepts HTTP |
| `/api/v1/health/ready` | none | Workspace and configured analytics/distributed dependencies are healthy |
| `/api/v1/metrics` | dedicated metrics token, or a read-capable team token when none is configured | Prometheus counters, active requests, 5xx counters, and bounded route latency histograms |

`DRYRUN_METRICS_TOKEN` creates a metrics-only credential path so Prometheus does not need a team administrator key. Route labels replace project/resource IDs to control cardinality. Set `DRYRUN_METRICS_ENABLED=false` to remove the endpoint. `DRYRUN_GRACEFUL_SHUTDOWN_MS` defaults to 30 seconds; SIGTERM stops new connections, drains active requests, then closes remaining sockets.

The provided alerts cover replica loss, a sustained 5xx ratio above 1%, and p95 latency above one second. Configure a real Alertmanager receiver before production; the checked-in receiver intentionally sends nothing.

Reproduce the local control-plane load gate and active-replica failure test with:

```bash
npm run benchmark:control-plane -- --requests 2000 --concurrency 32
DRYRUN_TEAM_TOKEN='drk_...' npm run verify:ha -- \
  --yes --endpoint http://quality.localhost:8080 --service dryrun-a \
  --requests 200 --concurrency 8 --output ha-verification.json
```

The HA script requires explicit `--yes` and reads a project key with both `read` and `ingest` access only from `DRYRUN_TEAM_TOKEN`. It starts unique authenticated trace write/read transactions before shutdown, stops only the named Compose replica, continues through the load-balancer transition and surviving replica, restarts the replica in a `finally` block, waits for readiness, and performs a recovery round. The v2 JSON report contains exact read-after-write cardinality, round durations, operation/probe failures, and p50/p95/p99 latency; it never serializes the token. Any failed transaction or probe exits non-zero.

The reference Caddy route performs active readiness checks every two seconds and retries `GET` plus idempotent trace-ID `PUT` writes against another healthy replica during shutdown convergence. It deliberately does not retry non-idempotent collection `POST` operations. Quota scans ignore transient lock/temp files and tolerate durable job files that another replica completes between directory enumeration and metadata lookup. The committed single-host run completed 248/248 authenticated write/read transactions with zero operation or probe failures; see the [raw report](../benchmarks/ha-macos-arm64-2026-08-26-unreleased.json). This validates application-process failover on the reference stack only, not host, shared-volume, or multi-region failure.

Enabled quality monitors evaluate shared analytics once per minute. Every scheduled boundary creates a content-addressed result, so multiple application replicas converge on one result rather than multiplying history. Writes use project quota reservations and configured retention removes expired monitor results with the same lock/revalidate rule as other retained documents.

## Suggested SLO and error budget

A reasonable starting service-level objective for an internally operated installation is:

- 99.9% successful availability over 30 days for authenticated API requests, excluding explicit 4xx responses;
- p95 server latency below one second over rolling five-minute windows;
- zero accepted-ingest loss, monitored by exporter spool age/size in the embedding service;
- readiness removed from load balancing whenever the workspace or required analytics plane is unavailable.

At 99.9%, the 30-day error budget is about 43 minutes. This is an operator target, not a warranty from the project. Tighten it only after measuring restore time and dependency behavior.

## Backups and recovery

Back up every configured state domain:

For the distributed control/data plane, create, verify, and restore a portable encrypted recovery point:

```bash
dry-run team recovery create --label before-v0-9
dry-run team recovery verify --label before-v0-9
dry-run team recovery list
dry-run team recovery restore --label before-v0-9 --yes
```

The recovery point contains an encrypted PostgreSQL control snapshot plus immutable copies of every referenced MinIO object. Restore verifies checksums, recreates missing original objects, and then imports control records. Keep independent PostgreSQL PITR, bucket versioning/replication, and off-site backups as defense in depth. Recover poison jobs after fixing their cause with `dry-run team dlq redrive --limit 100`.

1. Workspace: use `dry-run team backup --dir /data/team --output /backups/team-YYYYMMDD`. The command refuses symlinks/special files and in-tree destinations, hashes every payload, and removes a partial destination on failure. For a strict point-in-time snapshot, quiesce writers or use a filesystem snapshot first.
2. Control PostgreSQL: use `pg_dump` or a database-native consistent snapshot.
3. S3/MinIO: enable versioning or snapshot the bucket and retain object checksums together with PostgreSQL.
4. NATS JetStream: back up its file store when queued/outbox work must survive dependency loss; the PostgreSQL outbox can republish unpublished events.
5. ClickHouse and identity PostgreSQL: use their supported backup/snapshot procedures and protect OIDC/SCIM secrets separately.

Verify and restore workspace backups with:

```bash
dry-run team restore --input /backups/team-YYYYMMDD --verify-only
dry-run team restore --input /backups/team-YYYYMMDD --dir /restore/team --yes
dry-run team restore --input /backups/team-YYYYMMDD --dir /data/team --replace --yes
```

Restore verifies the full manifest before touching the target. `--replace` moves an existing workspace to a timestamped `before-restore` path instead of deleting it, providing a rollback path. Test restoration on a schedule. A backup that has never been restored is not availability evidence.

## Upgrade procedure

Build an immutable image tag, run `npm run verify`, create and verify a recovery point, upgrade one Dry Run replica, wait for readiness, inspect Prometheus, and then upgrade the remaining replicas. PostgreSQL migrations run under a schema-scoped advisory lock and are recorded in `schema_migrations`, allowing concurrent rolling starts. For ClickHouse or Keycloak major upgrades, follow those projects' supported migration paths independently.

## What this closes—and what it does not

This stack closes the product-level gaps around OIDC/SCIM, organization governance, stateless application replicas, encrypted distributed state, a batched trace/control/job plane, portable recovery, shared multi-node analytics, health probes, metrics, alerts, graceful draining, and a reproducible OSS deployment. It does not turn a repository into a vendor-operated global service: cross-region replication, capacity engineering, 24/7 on-call, contractual support, recovery objectives, and a financially backed SLA remain operational services rather than code features.
