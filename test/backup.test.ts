import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamBackup, restoreTeamBackup, verifyTeamBackup } from "../src/backup.ts";
import { TeamWorkspace } from "../src/team.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("team backup and restore", () => {
  it("creates a checksummed backup and restores an authentic workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-backup-test-")); dirs.push(root);
    const source = path.join(root, "source");
    const backup = path.join(root, "backup");
    const restored = path.join(root, "restored");
    const { workspace } = await TeamWorkspace.initialize(source, "Backup team");
    await createTeamBackup(source, backup);
    const verified = await verifyTeamBackup(backup);
    expect(verified.totals.files).toBeGreaterThan(0);
    await restoreTeamBackup(backup, restored);
    expect(new TeamWorkspace(restored).config()).toMatchObject({ id: workspace.config().id, name: "Backup team" });
  });

  it("detects tampering before changing the restore target", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dryrun-backup-tamper-")); dirs.push(root);
    const source = path.join(root, "source");
    const backup = path.join(root, "backup");
    await TeamWorkspace.initialize(source, "Tamper team");
    const manifest = await createTeamBackup(source, backup);
    const file = path.join(backup, "workspace", ...manifest.files[0].path.split("/"));
    writeFileSync(file, `${readFileSync(file, "utf8")}tampered`);
    await expect(verifyTeamBackup(backup)).rejects.toThrow(/checksum|manifest/i);
    await expect(restoreTeamBackup(backup, path.join(root, "target"))).rejects.toThrow();
  });
});
