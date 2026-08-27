import { createHash } from "node:crypto";
import type { SpanRecord, TraceDocument } from "./tracing.ts";

/** A deterministic, provider-free dataset that makes every control-plane view useful immediately. */
export function createDemoTraces(projectId: string, count = 24): TraceDocument[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(projectId) || !Number.isSafeInteger(count) || count < 1 || count > 500) throw new Error("Demo trace parameters are invalid");
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  return Array.from({ length: count }, (_unused, index) => {
    const candidate = index >= Math.floor(count / 2);
    const failed = candidate ? index % 5 === 0 || index % 7 === 0 : index % 11 === 0;
    const traceId = `demo_${createHash("sha256").update(`${projectId}:${index}`).digest("hex").slice(0, 24)}`;
    const startedAt = new Date(base + index * 3_600_000).toISOString();
    const durationMs = 340 + (index % 7) * 85 + (candidate ? 120 : 0) + (failed ? 600 : 0);
    const endedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
    const rootId = `${traceId}_root`, llmId = `${traceId}_llm`;
    const shared = { environment: "production", release: candidate ? "v2" : "v1", provider: "local-demo", model: candidate ? "demo-large" : "demo-small", "service.version": candidate ? "v2" : "v1" };
    const spans: SpanRecord[] = [
      { id: rootId, traceId, name: "support-agent", type: "agent", status: failed ? "error" : "ok", startedAt, endedAt, durationMs, input: { question: `Demo support question ${index + 1}` }, output: { answer: failed ? "I cannot verify that claim." : "Verified answer with cited policy." }, attributes: shared, metrics: { costUsd: 0, tokens: 220 + index * 3 }, events: [], ...(failed ? { error: { name: "DemoQualityError", message: "Deliberate demo regression" } } : {}) },
      { id: llmId, traceId, parentId: rootId, name: "compose-answer", type: "llm", status: failed ? "error" : "ok", startedAt, endedAt, durationMs: Math.max(1, durationMs - 40), input: { messages: [{ role: "user", content: `Demo support question ${index + 1}` }] }, output: { text: failed ? "Unverified answer" : "Verified answer" }, attributes: { ...shared, "gen_ai.response.model": shared.model, "gen_ai.system": shared.provider }, metrics: { tokens: 220 + index * 3, costUsd: 0 }, events: [] },
    ];
    return { kind: "dry-run.trace", version: 1, id: traceId, name: "support-agent", status: failed ? "error" : "ok", startedAt, endedAt, receivedAt: endedAt, durationMs, rootSpanId: rootId, spans, metadata: { demo: true, environment: "production", release: shared.release, provider: shared.provider, model: shared.model }, tags: ["demo", "production", shared.release], feedback: [] };
  });
}
