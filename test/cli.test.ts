import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const repo = path.resolve(".");

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dryrun-cli-"));
  dirs.push(dir);
  return dir;
}

function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(repo, "src/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI safety and configuration", () => {
  it("init refuses to overwrite an existing starter", () => {
    const dir = tmpDir();
    const first = cli(dir, ["init"]);
    expect(first.status).toBe(0);
    const starter = path.join(dir, "tests/smoke.agentest.ts");
    const original = readFileSync(starter, "utf8");

    writeFileSync(starter, `${original}\n// user change\n`);
    const second = cli(dir, ["init"]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("Refusing to overwrite");
    expect(readFileSync(starter, "utf8")).toContain("// user change");
  });

  it("honors junitPath from dryrun.config.json", () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "dryrun.config.json"),
      JSON.stringify({ include: [path.join(repo, "examples")], junitPath: "report.xml" }),
    );

    const run = cli(dir, ["run"]);
    expect(run.status).toBe(0);
    expect(existsSync(path.join(dir, "report.xml"))).toBe(true);
    expect(readFileSync(path.join(dir, "report.xml"), "utf8")).toContain("testsuite");
  });
});
