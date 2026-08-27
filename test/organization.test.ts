import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamWorkspace } from "../src/team.ts";

const dirs: string[] = [];
function tempDir(): string { const dir = mkdtempSync(path.join(tmpdir(), "dryrun-org-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("organization governance", () => {
  it("resolves group project access, inherited object policy, custom roles, and safe key rotation", async () => {
    const { workspace, admin } = await TeamWorkspace.initialize(tempDir(), "Quality organization");
    const owner = workspace.authenticate(admin.token)!;
    expect(workspace.organization(owner)).toMatchObject({ name: "Quality organization" });
    const project = await workspace.createProject(owner, "production");

    const reviewerRole = await workspace.createCustomRole(owner, {
      name: "Calibrated reviewer",
      baseRole: "editor",
      capabilities: ["read", "annotate"],
    });
    await expect(workspace.createCustomRole(owner, {
      name: "Escalating viewer",
      baseRole: "viewer",
      capabilities: ["read", "manage-members"],
    })).rejects.toThrow(/exceeds base role/);

    const invitation = await workspace.createInvitation(owner, "reviewer@example.com", "editor", [], 1);
    const accepted = await workspace.acceptInvitation(invitation.token, "Reviewer");
    const group = await workspace.createGroup(owner, {
      name: "Production reviewers",
      memberIds: [accepted.member.id],
      projectIds: [project.id],
      customRoleId: reviewerRole.id,
    });
    const reviewer = workspace.authorize(accepted.session.token, "read", project.id);
    expect(reviewer.groupIds).toEqual([group.id]);
    expect(reviewer.projectIds).toEqual([project.id]);

    await workspace.setObjectAccess(owner, project.id, "trace", "*", [{ subject: { type: "group", id: group.id }, capabilities: ["read"] }]);
    expect(workspace.authorizeObject(accepted.session.token, "read", project.id, "trace", "trace_any").memberId).toBe(accepted.member.id);

    const outsider = await workspace.createKey(owner, "outsider", "viewer", [project.id]);
    expect(() => workspace.authorizeObject(outsider.token, "read", project.id, "trace", "trace_any")).toThrow(/not granted/);

    const service = await workspace.createServiceAccount(owner, "production collector", "ingest", [project.id]);
    expect(workspace.authorize(service.token, "ingest", project.id).keyId).toBe(service.key.id);
    const rotated = await workspace.rotateKey(owner, service.key.id, 0);
    expect(workspace.authenticate(service.token)).toBeUndefined();
    expect(workspace.authorize(rotated.token, "ingest", project.id).keyId).toBe(rotated.key.id);
    expect(workspace.listKeys(owner).find((key) => key.id === service.key.id)).toMatchObject({ rotatedToKeyId: rotated.key.id });
    expect(workspace.exportAudit(owner, { format: "csv" })).toContain("key.rotate");
  });
});
