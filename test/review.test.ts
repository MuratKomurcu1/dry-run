import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewWorkflow } from "../src/review.ts";
import { AnnotationStore, TeamWorkspace } from "../src/team.ts";
import { startTeamServer } from "../src/team-server.ts";

const dirs: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
function store(): AnnotationStore { const dir = mkdtempSync(path.join(tmpdir(), "dryrun-review-")); dirs.push(dir); return new AnnotationStore(dir); }
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("review workflow", () => {
  it("assigns double-blind reviewers, hides early decisions, calibrates, and adjudicates ties", async () => {
    const annotations = store();
    const adjudication = await annotations.createQueue("Adjudication");
    const queue = await annotations.createQueue("Double blind", undefined, { mode: "adjudicated", reviewersPerTarget: 2, assignment: "deterministic-random", reviewerIds: ["reviewer-a", "reviewer-b"], adjudicationQueueId: adjudication.id, slaHours: 1 });
    const workflow = new ReviewWorkflow(annotations);
    const assignment = await workflow.assign(queue.id, { type: "trace", id: "trace_1" }, { goldLabel: "pass" });
    expect(assignment.items).toHaveLength(2);
    expect(new Set(assignment.reviewers)).toEqual(new Set(["reviewer-a", "reviewer-b"]));
    await expect(annotations.claim(assignment.items[0].id, "intruder")).rejects.toThrow(/another reviewer/);

    const first = await annotations.claim(assignment.items[0].id, assignment.items[0].assignedTo!);
    const completedFirst = await annotations.complete(first.id, { label: "pass", score: 1 }, first.revision);
    expect(workflow.blindView(completedFirst, assignment.items[1].assignedTo!)).not.toHaveProperty("label");
    const second = await annotations.claim(assignment.items[1].id, assignment.items[1].assignedTo!);
    await annotations.complete(second.id, { label: "fail", score: 0 }, second.revision);
    expect(workflow.decision(queue.id, assignment.groupId).state).toBe("disagreement");

    const routed = await workflow.routeAdjudication(queue.id, assignment.groupId);
    expect(routed.state).toBe("adjudication-pending");
    const adjudicationItem = annotations.loadItem(routed.adjudicationItemId!);
    const claimed = await annotations.claim(adjudicationItem.id, "lead-reviewer");
    await annotations.complete(claimed.id, { label: "pass", comment: "policy evidence supports pass" }, claimed.revision);
    expect(workflow.decision(queue.id, assignment.groupId)).toMatchObject({ state: "adjudicated", consensusLabel: "pass" });

    const calibration = workflow.calibration(queue.id);
    expect(calibration.reduce((sum, value) => sum + value.rated, 0)).toBe(2);
    expect(calibration.reduce((sum, value) => sum + value.correct, 0)).toBe(1);
    expect(workflow.aging(queue.id).overdue).toBe(0);
  });

  it("creates and populates a review program through the quota-aware team API", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dryrun-review-api-")); dirs.push(dir);
    const { workspace, admin } = await TeamWorkspace.initialize(dir, "Review API");
    const server = await startTeamServer({ workspace, port: 0 }); handles.push(server);
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };
    const created = await fetch(`${server.url}/api/v1/projects/default/queues`, { method: "POST", headers, body: JSON.stringify({ name: "Safety review", mode: "double-blind", assignment: "round-robin", reviewersPerTarget: 2, reviewerIds: ["reviewer-a", "reviewer-b"], slaHours: 24 }) });
    expect(created.status).toBe(201);
    const queue = (await created.json() as any).queue;
    const assigned = await fetch(`${server.url}/api/v1/projects/default/queues/${queue.id}/assign`, { method: "POST", headers, body: JSON.stringify({ target: { type: "trace", id: "trace-production-1" }, goldLabel: "pass" }) });
    expect(assigned.status).toBe(201);
    expect((await assigned.json() as any).assignment).toMatchObject({ reviewers: ["reviewer-a", "reviewer-b"] });
    const invalid = await fetch(`${server.url}/api/v1/projects/default/queues/${queue.id}/assign`, { method: "POST", headers, body: JSON.stringify({ target: { type: "file", id: "unsafe" } }) });
    expect(invalid.status).toBe(400);
  });
});
