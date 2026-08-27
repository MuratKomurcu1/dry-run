# Release process

1. Update `CHANGELOG.md`, `package.json`, and `package-lock.json`.
2. Run the complete gate:

   ```bash
   npm run verify
   npm audit
   npm pack --dry-run
   ```

3. Install the tarball into a temporary consumer project and run the packaged CLI.
4. In the clean consumer, run the packaged offline experiment example, verify persisted experiment/trace files, start Studio on an ephemeral port, and query its authenticated health/experiment/trace/prompt APIs.
5. Exercise the v0.8 loop: create/run an online rule against a fixture trace, verify deduplicated review routing, promote the trace, tamper-check the regression manifest, run a mock-provider Playground matrix, promote its winner, and generate a baseline/candidate PR report.
6. Start PostgreSQL, MinIO, and NATS JetStream, then run `npm run verify:distributed` to prove migrations, encrypted cold-node state, cross-replica control/trace reads, concurrent idempotency, DLQ redrive, portable recovery, transactional events, and queue-triggered online evaluation.
7. Run `npm run verify:chaos -- --nodes 4 --traces 1000000 --batch-size 500 --concurrency 32 --output benchmark.json` on production-equivalent hardware and retain the exact machine-readable report; do not generalize one machine into an SLA.
8. Verify a v2 cassette from both runtimes, run all Python tests, and build the Python wheel with `python3 -m pip wheel --no-deps ./python`.
9. Confirm `npm audit` reports no known runtime or development vulnerability and review install-script notices before approval.
10. Build and actually start the non-root container, run the real ClickHouse contract, lint minimal and stateless distributed Helm profiles, and complete a browser smoke of Setup/import, Intelligence, Judge Reliability, Governance, Human Review, Quality rules, Playground, and promotion.
11. Commit and push `main`; require the Node 22/24/26 public CI matrix and real production-contract job to pass.
12. Create an immutable version tag and GitHub Release.
13. Let the release workflow publish the exact npm/Python/GHCR artifacts only after registry environments are configured; attach SBOM, checksums, image digest, and provenance to the GitHub release.
14. Verify `npm view @muratkomurcu/dry-run version` and install from the registry in a clean temporary directory.

Package scope and GitHub owner intentionally differ:

- npm: `@muratkomurcu/dry-run`
- GitHub: `MuratKomurcu1/dry-run`

Every GitHub-facing URL must use the latter.
