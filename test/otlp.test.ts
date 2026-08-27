import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAnalyticsStore } from "../src/analytics.ts";
import { decodeOtlpHttp, otlpToDryRunTraces } from "../src/otlp.ts";
import { startTeamServer } from "../src/team-server.ts";
import { TeamWorkspace } from "../src/team.ts";

const dirs: string[] = [], handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("OTLP and OpenInference ingestion", () => {
  it("maps OTLP JSON and OpenInference semantics into native traces", () => {
    const result = otlpToDryRunTraces(payload([span("0000000000000001", "", "LLM", 1_000_000_000n, 1_010_000_000n)]), { receivedAt: "2026-08-26T10:00:00.000Z" });
    expect(result).toMatchObject({ spans: 1, rejectedSpans: 0 });
    expect(result.traces[0]).toMatchObject({ id: `otel_${TRACE_ID}`, name: "checkout-api", status: "ok", durationMs: 10, metadata: { source: "otlp", service: "checkout-api", release: "v2" } });
    expect(result.traces[0].spans[0]).toMatchObject({ id: "otelspan_0000000000000001", type: "llm", input: { question: "hello" }, output: "world", metrics: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  });

  it("decodes standard OTLP protobuf without a proprietary collector", () => {
    const protobuf = encodeRequest();
    const decoded = decodeOtlpHttp(protobuf, "application/x-protobuf");
    const result = otlpToDryRunTraces(decoded);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0].spans[0]).toMatchObject({ name: "chat", type: "llm", status: "ok" });
    expect(result.traces[0].metadata).toMatchObject({ service: "protobuf-service" });
  });

  it("accepts the standard /v1/traces endpoint and merges partial batches idempotently", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dryrun-otlp-")); dirs.push(dir);
    const { workspace, admin } = await TeamWorkspace.initialize(dir, "OTLP team");
    const analytics = new MemoryAnalyticsStore(), server = await startTeamServer({ workspace, port: 0, analytics }); handles.push(server);
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json", "x-dry-run-project": "default" };
    const root = await fetch(`${server.url}/v1/traces`, { method: "POST", headers, body: JSON.stringify(payload([span("0000000000000001", "", "AGENT", 1_000_000_000n, 1_020_000_000n)])) });
    expect(root.status).toBe(200);
    const child = await fetch(`${server.url}/v1/traces`, { method: "POST", headers, body: JSON.stringify(payload([span("0000000000000002", "0000000000000001", "TOOL", 1_005_000_000n, 1_010_000_000n)])) });
    expect(child.status).toBe(200);
    const stored = await (await fetch(`${server.url}/api/v1/projects/default/traces/otel_${TRACE_ID}`, { headers })).json() as any;
    expect(stored.traces[0].spans).toHaveLength(2);
    expect(stored.traces[0].rootSpanId).toBe("otelspan_0000000000000001");
    expect((await analytics.summary(workspace.config().id, workspace.project("default").project.id)).totals.count).toBe(1);
  });
});

const TRACE_ID = "00112233445566778899aabbccddeeff";
function payload(spans: unknown[]) {
  return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }, { key: "service.version", value: { stringValue: "v2" } }] }, scopeSpans: [{ scope: { name: "openinference" }, spans }] }] };
}
function span(spanId: string, parentSpanId: string, kind: string, start: bigint, end: bigint) {
  return { traceId: TRACE_ID, spanId, ...(parentSpanId ? { parentSpanId } : {}), name: kind === "TOOL" ? "lookup_tool" : "chat", startTimeUnixNano: start.toString(), endTimeUnixNano: end.toString(), attributes: [
    { key: "openinference.span.kind", value: { stringValue: kind } }, { key: "input.value", value: { stringValue: '{"question":"hello"}' } }, { key: "input.mime_type", value: { stringValue: "application/json" } },
    { key: "output.value", value: { stringValue: "world" } }, { key: "llm.token_count.prompt", value: { intValue: "10" } }, { key: "llm.token_count.completion", value: { intValue: "5" } },
  ], status: { code: 1 }, events: [] };
}

function encodeRequest(): Uint8Array {
  const resource = messageField(1, keyValue("service.name", anyString("protobuf-service")));
  const rawSpan = concat(
    bytesField(1, Buffer.from(TRACE_ID, "hex")), bytesField(2, Buffer.from("0000000000000001", "hex")), stringField(5, "chat"),
    fixed64Field(7, 1_000_000_000n), fixed64Field(8, 1_010_000_000n), messageField(9, keyValue("openinference.span.kind", anyString("LLM"))), messageField(15, varintField(3, 1n)),
  );
  const scope = concat(stringField(1, "openinference"), stringField(2, "1.0"));
  const scopeSpans = concat(messageField(1, scope), messageField(2, rawSpan));
  return messageField(1, concat(messageField(1, resource), messageField(2, scopeSpans)));
}
function keyValue(key: string, value: Uint8Array): Uint8Array { return concat(stringField(1, key), messageField(2, value)); }
function anyString(value: string): Uint8Array { return stringField(1, value); }
function messageField(field: number, value: Uint8Array): Uint8Array { return concat(varint(BigInt(field << 3 | 2)), varint(BigInt(value.length)), value); }
function stringField(field: number, value: string): Uint8Array { return messageField(field, new TextEncoder().encode(value)); }
function bytesField(field: number, value: Uint8Array): Uint8Array { return messageField(field, value); }
function varintField(field: number, value: bigint): Uint8Array { return concat(varint(BigInt(field << 3)), varint(value)); }
function fixed64Field(field: number, value: bigint): Uint8Array { const bytes = new Uint8Array(8); for (let index = 0; index < 8; index += 1) bytes[index] = Number(value >> BigInt(index * 8) & 255n); return concat(varint(BigInt(field << 3 | 1)), bytes); }
function varint(value: bigint): Uint8Array { const bytes: number[] = []; do { let byte = Number(value & 127n); value >>= 7n; if (value) byte |= 128; bytes.push(byte); } while (value); return Uint8Array.from(bytes); }
function concat(...values: Uint8Array[]): Uint8Array { const length = values.reduce((sum, value) => sum + value.length, 0), result = new Uint8Array(length); let offset = 0; for (const value of values) { result.set(value, offset); offset += value.length; } return result; }
