import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3ArtifactStore } from "../src/distributed.ts";
import { migrateEvaluationExport } from "../src/integrations/migrations.ts";
import { otlpToDryRunTraces } from "../src/otlp.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { redactUrlCredentials, sanitizeMarkdownText, trimHyphens, trimSlashes, trimTrailingSlashes } from "../src/safe-text.ts";
import { startTeamServer, type TeamServerHandle } from "../src/team-server.ts";
import { TeamWorkspace } from "../src/team.ts";
import { InMemoryTraceExporter, Tracer, type TraceDocument } from "../src/tracing.ts";

const directories: string[] = [];
const servers: TeamServerHandle[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("security regressions", () => {
  it("normalizes adversarial edge runs in linear passes", () => {
    const run = "/".repeat(100_000);
    expect(trimSlashes(`${run}artifacts${run}`)).toBe("artifacts");
    expect(trimTrailingSlashes(`https://example.test/v1${run}`)).toBe("https://example.test/v1");
    expect(trimHyphens(`${"-".repeat(100_000)}trace${"-".repeat(100_000)}`)).toBe("trace");
    const store = new S3ArtifactStore({ bucket: "dry-run-test", prefix: `${run}safe${run}` });
    expect(store.prefix).toBe("safe");
    store.client.destroy();
  });

  it("redacts URL userinfo without altering credential-free endpoints", () => {
    const message = "postgresql://alice:secret@db.internal/app and NATS://worker:token@queue.internal:4222";
    const redacted = redactUrlCredentials(message);
    expect(redacted).toBe("postgresql://[redacted]@db.internal/app and NATS://[redacted]@queue.internal:4222");
    expect(redacted).not.toContain("secret");
    expect(redactUrlCredentials("request to https://api.example.test/v1 failed")).toBe("request to https://api.example.test/v1 failed");
  });

  it("escapes every Markdown table delimiter without allowing backslash cancellation", () => {
    expect(sanitizeMarkdownText("a\\|b|c\r\n@team", { escapeTable: true, neutralizeMentions: true }))
      .toBe("a\\\\\\|b\\|c @\u200bteam");
    expect(sanitizeMarkdownText("||||", { escapeTable: true, maxLength: 3 })).toBe("\\|");
  });

  it("normalizes long provider and migration inputs without regex backtracking", async () => {
    let requested = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const provider = new OpenAIProvider({ apiKey: "test", baseURL: `https://api.example.test/v1${"/".repeat(100_000)}` });
    await provider.chat({ messages: [] });
    expect(requested).toBe("https://api.example.test/v1/chat/completions");

    const bundle = migrateEvaluationExport("langfuse", { data: [{ id: `${"-".repeat(100_000)}trace-id${"-".repeat(100_000)}`, observations: [] }] });
    expect(bundle.traces[0].id).toBe("trace-id");
  });

  it("does not capture runtime stack traces in native traces", async () => {
    const exporter = new InMemoryTraceExporter();
    const tracer = new Tracer([exporter]);
    const span = tracer.startSpan("failing operation");
    const error = new Error("safe public message");
    error.stack = "PRIVATE_STACK_SENTINEL /Users/operator/private.ts:42";
    span.recordError(error);
    await span.end();
    expect(exporter.traces).toHaveLength(1);
    expect(JSON.stringify(exporter.traces[0])).not.toContain("PRIVATE_STACK_SENTINEL");
    expect(exporter.traces[0].spans[0].error).toEqual({ name: "Error", message: "safe public message" });
  });

  it("drops externally supplied OTLP stack-trace attributes", () => {
    const result = otlpToDryRunTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{
      traceId: "00112233445566778899aabbccddeeff", spanId: "0000000000000001", name: "failing span", startTimeUnixNano: "1000000000", endTimeUnixNano: "1010000000", status: { code: 2, message: "public failure" }, attributes: [],
      events: [{ name: "exception", timeUnixNano: "1005000000", attributes: [{ key: "exception.type", value: { stringValue: "Error" } }, { key: "exception.message", value: { stringValue: "public failure" } }, { key: "exception.stacktrace", value: { stringValue: "PRIVATE_STACK_SENTINEL /srv/private.js:7" } }] }],
    }] }] }] });
    expect(result.traces).toHaveLength(1);
    expect(JSON.stringify(result.traces[0])).not.toContain("PRIVATE_STACK_SENTINEL");
    expect(result.traces[0].spans[0].error).toEqual({ name: "Error", message: "public failure" });
  });

  it("strips legacy stack fields at the authenticated team API boundary", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dryrun-security-"));
    directories.push(directory);
    const { workspace, admin } = await TeamWorkspace.initialize(directory, "Security regression team");
    const now = new Date().toISOString();
    const trace = {
      kind: "dry-run.trace", version: 1, id: "legacy_stack", name: "legacy", status: "error", startedAt: now, endedAt: now, durationMs: 1, rootSpanId: "span_legacy",
      spans: [{ id: "span_legacy", traceId: "legacy_stack", name: "agent", type: "agent", status: "error", startedAt: now, endedAt: now, durationMs: 1, attributes: {}, metrics: {}, events: [], error: { name: "Error", message: "public", stack: "PRIVATE_STACK_SENTINEL /srv/private.js:7" } }], feedback: [],
    } as unknown as TraceDocument;
    await workspace.project("default").traces.export(trace);
    const server = await startTeamServer({ workspace, port: 0 });
    servers.push(server);
    const response = await fetch(`${server.url}/api/v1/projects/default/traces/legacy_stack`, { headers: { Authorization: `Bearer ${admin.token}` } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("PRIVATE_STACK_SENTINEL");
    expect(text).not.toContain('"stack"');
    expect(text).toContain('"message":"public"');

    const malformed = await fetch(`${server.url}/api/v1/projects/default/traces`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Invalid request" });
  });
});
