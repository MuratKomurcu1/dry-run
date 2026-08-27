import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteSpoolFullError, RemoteTeamClient, RemoteTraceExporter } from "../src/remote.ts";
import { TeamWorkspace, AnnotationConflictError } from "../src/team.ts";
import { startTeamServer } from "../src/team-server.ts";
import { atomicWriteJson } from "../src/storage.ts";
import type { TraceDocument } from "../src/tracing.ts";

const dirs: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
function tempDir(): string { const dir = mkdtempSync(path.join(tmpdir(), "dryrun-team-")); dirs.push(dir); return dir; }
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trace(id: string, endedAt = new Date().toISOString()): TraceDocument {
  return {
    kind: "dry-run.trace",
    version: 1,
    id,
    name: `trace ${id}`,
    status: "ok",
    startedAt: endedAt,
    endedAt,
    durationMs: 1,
    rootSpanId: `span_${id}`,
    spans: [{ id: `span_${id}`, traceId: id, name: "agent", type: "agent", status: "ok", startedAt: endedAt, endedAt, durationMs: 1, attributes: {}, metrics: {}, events: [] }],
    feedback: [],
  };
}

describe("self-hosted team workspace", () => {
  it("stores only hashed keys, enforces roles/project scopes, and writes redacted audit events", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(tempDir(), "Quality team");
    const configText = readFileSync(workspace.configFile, "utf8");
    expect(configText).not.toContain(admin.token);
    expect(configText).toContain("sha256:");
    const owner = workspace.authenticate(admin.token)!;
    expect(owner.role).toBe("admin");
    const project = await workspace.createProject(owner, "production");
    const viewer = await workspace.createKey(owner, "analyst", "viewer", [project.id]);
    const viewerPrincipal = workspace.authorize(viewer.token, "read", project.id);
    expect(viewerPrincipal.role).toBe("viewer");
    expect(() => workspace.authorize(viewer.token, "ingest", project.id)).toThrow(/cannot ingest/);
    expect(() => workspace.authorize(viewer.token, "read", workspace.project("default").project.id)).toThrow(/not scoped/);
    await workspace.audit(owner, "test.secret", { details: { apiKey: "do-not-store", nested: { authorization: "Bearer bad" } } });
    const auditText = readFileSync(workspace.auditFile, "utf8");
    expect(auditText).not.toContain("do-not-store");
    expect(auditText).not.toContain("Bearer bad");
    expect(workspace.readAudit(owner).some((entry) => entry.action === "test.secret")).toBe(true);
  });

  it("enforces opt-in object restrictions without allowing grants to elevate the project role", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(tempDir(), "Object access team");
    const owner = workspace.authenticate(admin.token)!;
    const first = await workspace.createKey(owner, "first viewer", "viewer");
    const second = await workspace.createKey(owner, "second viewer", "viewer");
    const stores = workspace.project("default");
    await stores.access.set("trace", "trace-private", [{ subject: { type: "key", id: first.key.id }, capabilities: ["read", "annotate"] }]);
    expect(workspace.authorizeObject(first.token, "read", stores.project.id, "trace", "trace-private").keyId).toBe(first.key.id);
    expect(() => workspace.authorizeObject(second.token, "read", stores.project.id, "trace", "trace-private")).toThrow(/not granted/);
    expect(() => workspace.authorizeObject(first.token, "annotate", stores.project.id, "trace", "trace-private")).toThrow(/cannot annotate/);
    expect(workspace.authorizeObject(admin.token, "read", stores.project.id, "trace", "trace-private").role).toBe("admin");
  });

  it("supports optimistic annotation queues and explicit retention plan/apply", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(tempDir(), "Review team");
    const owner = workspace.authenticate(admin.token)!;
    const stores = workspace.project("default");
    const queue = await stores.annotations.createQueue("failure review");
    const item = await stores.annotations.enqueue(queue.id, { type: "trace", id: "trace_old" }, { priority: 10, labels: ["prod"] });
    const claimed = await stores.annotations.claim(item.id, "murat", item.revision);
    expect(claimed.status).toBe("claimed");
    await expect(stores.annotations.complete(item.id, { score: 1 }, item.revision)).rejects.toBeInstanceOf(AnnotationConflictError);
    const completed = await stores.annotations.complete(item.id, { score: 0.9, label: "correct", comment: "reviewed" }, claimed.revision);
    expect(completed.status).toBe("completed");

    await stores.traces.export(trace("trace_old", "2020-01-01T00:00:00.000Z"));
    const plan = await workspace.applyRetention(owner, stores.project.id, { olderThanDays: 30, dryRun: true });
    expect(plan.traces).toHaveLength(1);
    expect(existsSync(stores.traces.file("trace_old"))).toBe(true);
    const applied = await workspace.applyRetention(owner, stores.project.id, { olderThanDays: 30 });
    expect(applied.total).toBeGreaterThanOrEqual(1);
    expect(existsSync(stores.traces.file("trace_old"))).toBe(false);
  });

  it("measures multi-reviewer agreement without hiding ties or unrated decisions", async () => {
    const { workspace } = await TeamWorkspace.initialize(tempDir(), "Calibration team");
    const stores = workspace.project("default");
    const queue = await stores.annotations.createQueue("calibration");
    const first = await stores.annotations.enqueue(queue.id, { type: "trace", id: "trace_shared" });
    const second = await stores.annotations.enqueue(queue.id, { type: "trace", id: "trace_shared" });
    const third = await stores.annotations.enqueue(queue.id, { type: "trace", id: "trace_unrated" });
    const claimedFirst = await stores.annotations.claim(first.id, "reviewer-one");
    await stores.annotations.complete(first.id, { label: "pass", score: 1 }, claimedFirst.revision);
    const claimedSecond = await stores.annotations.claim(second.id, "reviewer-two");
    await stores.annotations.complete(second.id, { label: "pass", score: 0.9 }, claimedSecond.revision);
    const claimedThird = await stores.annotations.claim(third.id, "reviewer-one");
    await stores.annotations.complete(third.id, { score: 0.5 }, claimedThird.revision);
    expect(stores.annotations.agreement(queue.id)).toMatchObject({
      queueId: queue.id,
      completedItems: 3,
      unratedItems: 1,
      ratings: 2,
      reviewers: 2,
      overlappingTargets: 1,
      observedAgreement: 1,
      krippendorffAlpha: 1,
    });
  });

  it("ingests durable remote traces end-to-end and applies API RBAC", async () => {
    const root = tempDir();
    const { workspace, admin } = await TeamWorkspace.initialize(path.join(root, "team"), "Remote team");
    const owner = workspace.authenticate(admin.token)!;
    const viewer = await workspace.createKey(owner, "reader", "viewer");
    const ingest = await workspace.createKey(owner, "collector", "ingest");
    const handle = await startTeamServer({ workspace, port: 0 });
    handles.push(handle);

    const sameOriginWrite = await fetch(`${handle.url}/api/v1/projects/default/queues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json", Origin: handle.url },
      body: JSON.stringify({ name: "same-origin review" }),
    });
    expect(sameOriginWrite.status).toBe(201);

    const exporter = new RemoteTraceExporter({
      endpoint: handle.url,
      project: "default",
      token: ingest.token,
      allowInsecureHttp: true,
      spoolDir: path.join(root, "spool"),
      batchSize: 1,
      retries: 0,
    });
    await exporter.export(trace("trace_remote"));
    await exporter.flush();
    expect(exporter.pending()).toBe(0);
    expect(workspace.project("default").traces.load("trace_remote").name).toBe("trace trace_remote");
    await exporter.shutdown();

    const idempotentBody = JSON.stringify(trace("trace_remote"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const upsert = await fetch(`${handle.url}/api/v1/projects/default/traces/trace_remote`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ingest.token}`, "Content-Type": "application/json" },
        body: idempotentBody,
      });
      expect(upsert.status).toBe(202);
      expect(await upsert.json()).toMatchObject({ accepted: 1, ids: ["trace_remote"] });
    }
    const mismatchedUpsert = await fetch(`${handle.url}/api/v1/projects/default/traces/different_id`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ingest.token}`, "Content-Type": "application/json" },
      body: idempotentBody,
    });
    expect(mismatchedUpsert.status).toBe(400);

    const reader = new RemoteTeamClient({ endpoint: handle.url, project: "default", token: viewer.token, allowInsecureHttp: true, retries: 0 });
    const listed = await reader.requestJson<{ traces: TraceDocument[] }>("/api/v1/projects/default/traces");
    expect(listed.traces).toHaveLength(1);
    const collector = new RemoteTeamClient({ endpoint: handle.url, project: "default", token: ingest.token, allowInsecureHttp: true, retries: 0 });
    await expect(collector.requestJson("/api/v1/projects/default/traces")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses non-loopback plaintext exposure by default", async () => {
    const { workspace } = await TeamWorkspace.initialize(tempDir(), "Secure team");
    await expect(startTeamServer({ workspace, host: "0.0.0.0", port: 0 })).rejects.toThrow(/plaintext/);
  });

  it("prevents project-scoped admins from crossing into workspace administration", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(tempDir(), "Scoped team");
    const owner = workspace.authenticate(admin.token)!;
    const allowed = await workspace.createProject(owner, "allowed");
    const other = await workspace.createProject(owner, "other");
    const issued = await workspace.createKey(owner, "delegated admin", "admin", [allowed.id]);
    const scoped = workspace.authenticate(issued.token)!;

    expect(() => workspace.authorize(issued.token, "manage-keys")).toThrow(/workspace-wide/);
    await expect(workspace.createKey(scoped, "escape", "admin")).rejects.toThrow(/workspace-wide/);
    await expect(workspace.createProject(scoped, "escape-project")).rejects.toThrow(/workspace-wide/);
    expect(() => workspace.readAudit(scoped)).toThrow(/workspace-wide/);
    await expect(workspace.setProjectRetention(scoped, allowed.id, true, 30)).resolves.toEqual({ enabled: true, days: 30 });
    await expect(workspace.setProjectRetention(scoped, other.id, true, 30)).rejects.toThrow(/not scoped/);
    expect(await workspace.runConfiguredRetention()).toHaveLength(1);
    await expect(workspace.applyRetention(scoped, allowed.id, { dryRun: true })).resolves.toMatchObject({ projectId: allowed.id });
    await expect(workspace.applyRetention(scoped, other.id, { dryRun: true })).rejects.toThrow(/not scoped/);
  });

  it("supports one-time member invitations, named principals, scopes, and suspension", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(tempDir(), "Member team");
    const owner = workspace.authenticate(admin.token)!;
    const project = workspace.project("default").project;
    const issued = await workspace.createInvitation(owner, "Reviewer@Example.com", "viewer", [project.id], 1);
    expect(readFileSync(workspace.configFile, "utf8")).not.toContain(issued.token);
    expect(workspace.listInvitations(owner)[0]).not.toHaveProperty("tokenHash");

    const handle = await startTeamServer({ workspace, port: 0 });
    handles.push(handle);
    const acceptedResponse = await fetch(`${handle.url}/api/v1/invitations/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: issued.token, name: "Reviewer One", sessionDays: 30 }),
    });
    expect(acceptedResponse.status).toBe(201);
    const accepted = await acceptedResponse.json() as any;
    expect(accepted.member).toMatchObject({ email: "reviewer@example.com", role: "viewer", status: "active" });
    expect(accepted.session.token).toMatch(/^drk_/);

    const me = await fetch(`${handle.url}/api/v1/me`, { headers: { Authorization: `Bearer ${accepted.session.token}` } });
    expect(me.status).toBe(200);
    expect((await me.json() as any).principal).toMatchObject({ memberId: accepted.member.id, memberName: "Reviewer One", memberEmail: "reviewer@example.com" });
    const forbidden = await fetch(`${handle.url}/api/v1/admin/members`, { headers: { Authorization: `Bearer ${accepted.session.token}` } });
    expect(forbidden.status).toBe(403);
    expect(workspace.listMembers(owner)).toHaveLength(1);

    await workspace.updateMember(owner, accepted.member.id, { status: "suspended" });
    expect(workspace.authenticate(accepted.session.token)).toBeUndefined();
    const reused = await fetch(`${handle.url}/api/v1/invitations/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: issued.token, name: "Replay" }),
    });
    expect(reused.status).toBe(401);
  });

  it("paginates remote collections, owns retention time, and hides storage paths", async () => {
    const root = tempDir();
    const { workspace, admin } = await TeamWorkspace.initialize(path.join(root, "team"), "Bounded team");
    const stores = workspace.project("default");
    await stores.traces.export(trace("trace_a"));
    await stores.traces.export(trace("trace_b"));
    await stores.traces.export(trace("trace_c"));
    const handle = await startTeamServer({ workspace, port: 0 });
    handles.push(handle);
    const headers = { Authorization: `Bearer ${admin.token}` };

    const first = await (await fetch(`${handle.url}/api/v1/projects/default/traces?limit=2`, { headers })).json() as any;
    expect(first.traces).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);
    const second = await (await fetch(`${handle.url}/api/v1/projects/default/traces?limit=2&cursor=${encodeURIComponent(first.page.nextCursor)}`, { headers })).json() as any;
    expect(second.traces).toHaveLength(1);

    const missing = await fetch(`${handle.url}/api/v1/projects/default/traces/does-not-exist`, { headers });
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(root);

    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const rejected = await fetch(`${handle.url}/api/v1/projects/default/traces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(trace("future_trace", future)),
    });
    expect(rejected.status).toBe(400);
    const accepted = await fetch(`${handle.url}/api/v1/projects/default/traces`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(trace("server_time")),
    });
    expect(accepted.status).toBe(202);
    expect(stores.traces.load("server_time").receivedAt).toMatch(/Z$/);
  });

  it("enforces project and exporter disk budgets before writing", async () => {
    const root = tempDir();
    const { workspace, admin } = await TeamWorkspace.initialize(path.join(root, "team"), "Quota team");
    const handle = await startTeamServer({ workspace, port: 0, maxProjectBytes: 128, maxProjectFiles: 10 });
    handles.push(handle);
    const response = await fetch(`${handle.url}/api/v1/projects/default/traces`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(trace("too_large")),
    });
    expect(response.status).toBe(507);
    expect(existsSync(workspace.project("default").traces.file("too_large"))).toBe(false);

    const exporter = new RemoteTraceExporter({
      endpoint: "http://127.0.0.1:1",
      project: "default",
      token: admin.token,
      allowInsecureHttp: true,
      spoolDir: path.join(root, "bounded-spool"),
      maxSpoolBytes: 128,
      maxSpoolFiles: 1,
      minFreeBytes: 0,
    });
    await expect(exporter.export(trace("spool_too_large"))).rejects.toBeInstanceOf(RemoteSpoolFullError);
    expect(exporter.pending()).toBe(0);
    await exporter.shutdown();
  });

  it("revalidates retention candidates under the writer lock", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(tempDir(), "Race-safe retention");
    const owner = workspace.authenticate(admin.token)!;
    const stores = workspace.project("default");
    await stores.traces.export(trace("replace_me", "2020-01-01T00:00:00.000Z"));
    const original = workspace.planRetention.bind(workspace);
    workspace.planRetention = ((...args: Parameters<TeamWorkspace["planRetention"]>) => {
      const plan = original(...args);
      atomicWriteJson(stores.traces.file("replace_me"), trace("replace_me"));
      return plan;
    }) as TeamWorkspace["planRetention"];
    const applied = await workspace.applyRetention(owner, stores.project.id, { olderThanDays: 30 });
    expect(applied.total).toBe(0);
    expect(stores.traces.load("replace_me").endedAt).not.toContain("2020-01-01");
  });

  it("rejects endpoint redirects so bearer tokens are never forwarded", async () => {
    let redirect: RequestRedirect | undefined;
    const client = new RemoteTeamClient({
      endpoint: "https://team.example.test",
      project: "default",
      token: "drk_abcdefgh_abcdefghijklmnopqrstuvwxyzABCDEFGH123456",
      retries: 0,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        redirect = init?.redirect;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await client.requestJson("/api/v1/me");
    expect(redirect).toBe("error");
    expect(() => new RemoteTeamClient({ endpoint: "https://user:pass@team.example.test", project: "default", token: "drk_abcdefgh_abcdefghijklmnopqrstuvwxyzABCDEFGH123456" })).toThrow(/cannot contain credentials/);
  });
});
