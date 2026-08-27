import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectAccessConflictError, ObjectAccessStore } from "../src/access.ts";
import { TeamWorkspace } from "../src/team.ts";
import { startTeamServer, type TeamServerHandle } from "../src/team-server.ts";
import type { TraceDocument } from "../src/tracing.ts";

const roots: string[] = [];
const handles: TeamServerHandle[] = [];
afterEach(async () => { while (handles.length) await handles.pop()!.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("object-level access policies", () => {
  it("restricts individual resources, preserves the role ceiling, and uses optimistic revisions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-access-")); roots.push(root);
    const store = new ObjectAccessStore(root);
    const policy = await store.set("trace", "trace-sensitive", [{ subject: { type: "key", id: "reader-one" }, capabilities: ["read"] }]);
    expect(store.allows({ keyId: "reader-one", role: "viewer" }, "read", "trace", "trace-sensitive")).toBe(true);
    expect(store.allows({ keyId: "reader-two", role: "viewer" }, "read", "trace", "trace-sensitive")).toBe(false);
    expect(store.allows({ keyId: "owner", role: "admin" }, "read", "trace", "trace-sensitive")).toBe(true);
    expect(store.allows({ keyId: "reader-two", role: "viewer" }, "read", "trace", "unrestricted")).toBe(true);
    await expect(store.set("trace", "trace-sensitive", [{ subject: { type: "key", id: "reader-two" }, capabilities: ["read"] }], 99)).rejects.toBeInstanceOf(ObjectAccessConflictError);
    const updated = await store.set("trace", "trace-sensitive", [{ subject: { type: "member", id: "member-one" }, capabilities: ["read", "annotate"] }], policy.revision);
    expect(updated.revision).toBe(2);
    expect(store.allows({ keyId: "session", memberId: "member-one", role: "editor" }, "annotate", "trace", "trace-sensitive")).toBe(true);
    await store.remove("trace", "trace-sensitive", updated.revision);
    expect(store.load("trace", "trace-sensitive")).toBeUndefined();
  });

  it("manages policies through the API and removes restricted objects from collection and detail reads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-access-api-")); roots.push(root);
    const { workspace, admin } = await TeamWorkspace.initialize(path.join(root, "team"), "Access API");
    const owner = workspace.authenticate(admin.token)!;
    const allowed = await workspace.createKey(owner, "allowed", "viewer");
    const denied = await workspace.createKey(owner, "denied", "viewer");
    await workspace.project("default").traces.export(trace("trace-private"));
    const handle = await startTeamServer({ workspace, port: 0 }); handles.push(handle);
    const policy = await fetch(`${handle.url}/api/v1/projects/default/access/policies/trace/trace-private`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [{ subject: { type: "key", id: allowed.key.id }, capabilities: ["read"] }] }),
    });
    expect(policy.status).toBe(200);
    const list = async (token: string) => fetch(`${handle.url}/api/v1/projects/default/traces`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await (await list(allowed.token)).json() as any).traces).toHaveLength(1);
    expect((await (await list(denied.token)).json() as any).traces).toHaveLength(0);
    const deniedDetail = await fetch(`${handle.url}/api/v1/projects/default/traces/trace-private`, { headers: { Authorization: `Bearer ${denied.token}` } });
    expect(deniedDetail.status).toBe(403);
    const allowedDetail = await fetch(`${handle.url}/api/v1/projects/default/traces/trace-private`, { headers: { Authorization: `Bearer ${allowed.token}` } });
    expect(allowedDetail.status).toBe(200);
  });
});

function trace(id: string): TraceDocument {
  const endedAt = new Date().toISOString();
  return { kind: "dry-run.trace", version: 1, id, name: id, status: "ok", startedAt: endedAt, endedAt, durationMs: 0, rootSpanId: `span_${id}`, spans: [{ id: `span_${id}`, traceId: id, name: id, type: "agent", status: "ok", startedAt: endedAt, endedAt, durationMs: 0, attributes: {}, metrics: {}, events: [] }], feedback: [] };
}
