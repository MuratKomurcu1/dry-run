import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalyticsEventView } from "../src/analytics.ts";
import { IntelligenceStore, IntelligenceWebhookNotifier, analyzeProductionEvents, detectRobustAnomalies } from "../src/intelligence.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("production intelligence", () => {
  it("detects a statistically material release regression, drift, clusters, and likely causes", async () => {
    const baseline = Array.from({ length: 100 }, (_, index) => event(`base-${index}`, index < 90, "v1", "model-a", 100 + index % 5));
    const candidate = Array.from({ length: 100 }, (_, index) => event(`next-${index}`, index < 45, "v2", index < 40 ? "model-a" : "model-b", index === 99 ? 10_000 : 150 + index % 5));
    const report = analyzeProductionEvents(baseline, candidate, { baseline: { release: "v1" }, candidate: { release: "v2" }, minimumEvents: 20 });

    expect(report.verdict).toBe("degraded");
    expect(report.releaseComparison.passRate).toMatchObject({ baseline: 0.9, candidate: 0.45, statisticallyDistinct: true });
    expect(report.drift.find((entry) => entry.dimension === "model")?.drifted).toBe(true);
    expect(report.drift.find((entry) => entry.dimension === "durationMs")?.method).toBe("kolmogorov-smirnov");
    expect(report.anomalies.some((entry) => entry.eventId === "next-99" && entry.metric === "durationMs")).toBe(true);
    expect(report.failureClusters[0]).toMatchObject({ status: "error", count: 55 });
    expect(report.rootCauses.some((cause) => cause.dimension === "model" && cause.value === "model-b" && cause.riskDifference > 0)).toBe(true);

    const dir = mkdtempSync(path.join(tmpdir(), "dryrun-intelligence-")); dirs.push(dir);
    const store = new IntelligenceStore(dir);
    await store.save(report);
    expect(store.load(report.id).verdict).toBe("degraded");
    expect(store.list()).toHaveLength(1);
  });

  it("uses median absolute deviation without being distorted by an existing outlier", () => {
    const baseline = [100, 101, 99, 100, 101, 10_000].map((duration, index) => event(`base-${index}`, true, "v1", "model-a", duration));
    const anomalies = detectRobustAnomalies(baseline, [event("normal", true, "v2", "model-a", 102), event("outlier", true, "v2", "model-a", 1_000)]);
    expect(anomalies.some((entry) => entry.eventId === "outlier" && entry.metric === "durationMs")).toBe(true);
    expect(anomalies.some((entry) => entry.eventId === "normal" && entry.metric === "durationMs")).toBe(false);
  });

  it("signs webhooks, refuses redirects, and blocks private destinations by default", async () => {
    const baseline = Array.from({ length: 20 }, (_, index) => event(`b-${index}`, true, "v1", "a", 100));
    const report = analyzeProductionEvents(baseline, baseline, { baseline: { release: "v1" }, candidate: { release: "v1" } });
    let signature = "";
    const notifier = new IntelligenceWebhookNotifier({ url: "https://alerts.example/hook", secret: "0123456789abcdef", fetch: async (_input, init) => { signature = new Headers(init?.headers).get("x-dry-run-signature") ?? ""; return new Response(null, { status: 204 }); } });
    await notifier.send(report);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(() => new IntelligenceWebhookNotifier({ url: "http://127.0.0.1/hook" })).toThrow(/HTTPS/);
    const redirect = new IntelligenceWebhookNotifier({ url: "https://alerts.example/hook", fetch: async () => new Response(null, { status: 302 }) });
    await expect(redirect.send(report)).rejects.toThrow(/redirects/);
  });
});

function event(id: string, passed: boolean, release: string, model: string, durationMs: number): AnalyticsEventView {
  return { kind: "trace", id, name: "support-agent", occurredAt: new Date(Date.UTC(2026, 7, 1, 0, 0, Number(id.replace(/\D/g, "")) % 60)).toISOString(), status: passed ? "ok" : "error", passed, durationMs, tokens: passed ? 100 : 150, costUsd: passed ? 0.001 : 0.002, itemCount: 1, tags: ["production", passed ? "success" : "timeout"], model, provider: "openai-compatible", environment: "production", release };
}
