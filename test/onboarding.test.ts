import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryAnalyticsStore } from "../src/analytics.ts";
import { startTeamServer, type TeamServerHandle } from "../src/team-server.ts";
import { TeamWorkspace } from "../src/team.ts";

const roots: string[] = [];
const servers: TeamServerHandle[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("zero-cost onboarding", () => {
  it("diagnoses setup, seeds idempotent demo data, and previews/imports migrations", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-onboarding-")); roots.push(root);
    const { workspace, admin } = await TeamWorkspace.initialize(root, "Onboarding");
    const analytics = new MemoryAnalyticsStore();
    const server = await startTeamServer({ workspace, analytics, port: 0 }); servers.push(server);
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };

    const diagnostics = await getJson(`${server.url}/api/v1/setup/diagnostics`, { headers });
    expect(diagnostics.response.status).toBe(200);
    expect(diagnostics.body.ready).toBe(true);
    expect(diagnostics.body.costs).toEqual({ requiredHostedServices: 0, providerCostUsd: 0 });
    expect(diagnostics.body.checks.some((check: any) => check.id === "otlp" && check.status === "pass")).toBe(true);

    for (let run = 0; run < 2; run += 1) {
      const demo = await getJson(`${server.url}/api/v1/projects/default/demo`, { method: "POST", headers, body: JSON.stringify({ count: 24 }) });
      expect(demo.response.status).toBe(201);
      expect(demo.body).toMatchObject({ traces: 24, providerCostUsd: 0 });
    }
    expect(workspace.project("default").traces.list()).toHaveLength(24);
    expect(workspace.project("default").online.listRules().filter((rule) => rule.name === "Demo production gate")).toHaveLength(1);
    expect(workspace.project("default").annotations.listQueues().filter((queue) => queue.name === "Demo regressions")).toHaveLength(1);

    const migration = { source: "deepeval", name: "Imported quality set", input: [{ id: "one", input: "Question", expectedOutput: "Answer" }] };
    const preview = await getJson(`${server.url}/api/v1/projects/default/import`, { method: "POST", headers, body: JSON.stringify({ ...migration, dryRun: true }) });
    expect(preview.response.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ datasets: 1, cases: 1, traces: 0 });
    expect(workspace.project("default").migrations.list()).toHaveLength(0);

    const imported = await getJson(`${server.url}/api/v1/projects/default/import`, { method: "POST", headers, body: JSON.stringify(migration) });
    expect(imported.response.status).toBe(201);
    expect(imported.body.summary).toMatchObject({ datasets: 1, cases: 1, traces: 0 });
    expect(workspace.project("default").migrations.list()).toHaveLength(1);
  });
});

async function getJson(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  return { response, body: await response.json() as any };
}
