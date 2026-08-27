import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("HA deployment contract", () => {
  it("retries idempotent API traffic across replica health transitions", () => {
    const caddy = readFileSync("deploy/caddy/Caddyfile", "utf8");
    expect(caddy).toContain("reverse_proxy dryrun-a:4320 dryrun-b:4320");
    expect(caddy).toMatch(/lb_try_duration\s+5s/);
    expect(caddy).toMatch(/lb_try_interval\s+50ms/);
    expect(caddy).toMatch(/lb_retry_match\s*\{[\s\S]*method GET PUT[\s\S]*\}/);
    expect(caddy).toMatch(/health_interval\s+2s/);
  });

  it("keeps a machine-readable zero-loss failover result", () => {
    const report = JSON.parse(readFileSync("benchmarks/ha-macos-arm64-2026-08-26-unreleased.json", "utf8"));
    expect(report.schema).toBe("dry-run.ha-verification.v2");
    expect(report.summary).toMatchObject({
      expectedTransactions: 248,
      successfulTransactions: 248,
      failedTransactions: 0,
      failedOperations: 0,
      failedProbes: 0,
      exactReadAfterWriteCardinality: true,
    });
    expect(report.failures).toEqual([]);
  });
});
