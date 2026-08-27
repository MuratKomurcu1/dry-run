import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const repo = path.resolve(".");

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dryrun-cli-"));
  dirs.push(dir);
  return dir;
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(repo, "src/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI safety and configuration", () => {
  it("reports the installed package version through standard CLI flags", () => {
    const dir = tmpDir();
    for (const flag of ["--version", "-v", "version"]) {
      const result = cli(dir, [flag]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("0.8.2");
    }
  });

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
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(existsSync(path.join(dir, "report.xml"))).toBe(true);
    expect(readFileSync(path.join(dir, "report.xml"), "utf8")).toContain("testsuite");
  });

  it("filters by tag, runs trials and writes JSON/SARIF reports", () => {
    const dir = tmpDir();
    const testFile = path.join(dir, "matrix.agentest.mjs");
    writeFileSync(testFile, `
      const agent = async () => ({ steps: [], output: "ok" });
      export default [
        { name: "smoke", tags: ["smoke"], agent, input: "", expect: [{ type: "outputEquals", value: "ok" }] },
        { name: "slow", tags: ["slow"], agent, input: "", expect: [] },
      ];
    `);
    const run = cli(dir, ["run", testFile, "--tag", "smoke", "--trials", "2", "--concurrency", "2", "--json", "report.json", "--sarif", "report.sarif"]);
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")).total).toBe(2);
    expect(JSON.parse(readFileSync(path.join(dir, "report.sarif"), "utf8")).version).toBe("2.1.0");
  });

  it("enforces deny-network in an isolated child process", () => {
    const dir = tmpDir();
    const testFile = path.join(dir, "network.agentest.mjs");
    writeFileSync(testFile, `
      export default [{
        name: "network is denied",
        input: "",
        expect: [],
        agent: async () => {
          await fetch("https://example.com");
          return { steps: [], output: "unexpected" };
        },
      }];
    `);
    const run = cli(dir, ["run", testFile, "--deny-network"]);
    expect(run.status).toBe(1);
    expect(run.stderr + run.stdout).toContain("network isolation blocked");
    expect(run.stderr).toContain("network isolation:");
  });

  it("runs and persists a dataset experiment from the CLI", () => {
    const dir = tmpDir();
    const modulePath = path.join(dir, "quality.eval.mjs");
    writeFileSync(modulePath, `
      import { Dataset } from ${JSON.stringify(pathToFileURL(path.join(repo, "src/dataset.ts")).href)};
      import { exactMatchScorer } from ${JSON.stringify(pathToFileURL(path.join(repo, "src/scorers.ts")).href)};
      export default {
        name: "uppercase quality",
        dataset: Dataset.create("uppercase", [
          { id: "a", input: "hello", expected: "HELLO" },
          { id: "b", input: "world", expected: "WORLD" },
        ]),
        task: async (input) => input.toUpperCase(),
        scorers: [exactMatchScorer()],
      };
    `);
    const run = cli(dir, ["eval", modulePath, "--trials", "2", "--json", "result.json"]);
    expect(run.status, run.stderr + run.stdout).toBe(0);
    const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
    expect(result.summary).toMatchObject({ total: 4, passed: 4, failed: 0 });
    expect(result.aggregates[0].mean).toBe(1);
    expect(existsSync(path.join(dir, ".dryrun/experiments", `${result.id}.json`))).toBe(true);

    const list = cli(dir, ["experiments", "list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("uppercase quality");
  });

  it("normalizes and deterministically splits JSONL datasets", () => {
    const dir = tmpDir();
    const source = path.join(dir, "cases.jsonl");
    writeFileSync(source, [
      JSON.stringify({ input: "one", expected: "ONE" }),
      JSON.stringify({ input: "two", expected: "TWO" }),
      JSON.stringify({ input: "three", expected: "THREE" }),
      JSON.stringify({ input: "four", expected: "FOUR" }),
    ].join("\n"));
    const validate = cli(dir, ["dataset", "validate", source]);
    expect(validate.status).toBe(0);
    expect(validate.stdout).toContain("4 case(s)");
    const split = cli(dir, ["dataset", "split", source, "--ratio", "0.5", "--train", "train.json", "--test", "test.json"]);
    expect(split.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "train.json"), "utf8")).cases).toHaveLength(2);
    expect(JSON.parse(readFileSync(path.join(dir, "test.json"), "utf8")).cases).toHaveLength(2);
  });

  it("versions and renders prompt templates and generates red-team datasets", () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "answer.txt"), "Answer {{question}} briefly.");
    const publish = cli(dir, ["prompts", "publish", "support", "answer.txt", "--label", "production"]);
    expect(publish.status, publish.stderr + publish.stdout).toBe(0);
    const render = cli(dir, ["prompts", "render", "support", "--values", JSON.stringify({ question: "refunds" }), "--label", "production"]);
    expect(render.status).toBe(0);
    expect(render.stdout.trim()).toBe("Answer refunds briefly.");

    writeFileSync(path.join(dir, "source.json"), JSON.stringify([{ id: "one", input: "help", expected: "done" }]));
    const attack = cli(dir, ["dataset", "red-team", "source.json", "--attacks", "prompt-injection,base64", "-o", "attacks.json"]);
    expect(attack.status, attack.stderr + attack.stdout).toBe(0);
    const generated = JSON.parse(readFileSync(path.join(dir, "attacks.json"), "utf8"));
    expect(generated.cases).toHaveLength(2);
    expect(generated.cases[0].tags).toContain("red-team");
  });

  it("initializes and administers a team workspace without putting tokens in argv", () => {
    const dir = tmpDir();
    const init = cli(dir, ["team", "init", "--name", "Quality team"]);
    expect(init.status, init.stderr + init.stdout).toBe(0);
    const token = /drk_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/.exec(init.stdout)?.[0];
    expect(token).toBeTruthy();
    expect(readFileSync(path.join(dir, ".dryrun/team/workspace.json"), "utf8")).not.toContain(token!);
    const list = cli(dir, ["team", "project", "list"], { DRYRUN_TEAM_TOKEN: token! });
    expect(list.status, list.stderr + list.stdout).toBe(0);
    expect(JSON.parse(list.stdout)[0].name).toBe("default");
    const key = cli(dir, ["team", "key", "create", "--name", "collector", "--role", "ingest", "--projects", "default"], { DRYRUN_TEAM_TOKEN: token! });
    expect(key.status, key.stderr + key.stdout).toBe(0);
    expect(key.stdout).toContain("shown once");
    const invite = cli(dir, ["team", "invite", "create", "--email", "reviewer@example.com", "--role", "viewer", "--projects", "default"], { DRYRUN_TEAM_TOKEN: token! });
    expect(invite.status, invite.stderr + invite.stdout).toBe(0);
    const invitationToken = /dri_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+/.exec(invite.stdout)?.[0];
    expect(invitationToken).toBeTruthy();
    expect(readFileSync(path.join(dir, ".dryrun/team/workspace.json"), "utf8")).not.toContain(invitationToken!);
    const invitations = cli(dir, ["team", "invite", "list"], { DRYRUN_TEAM_TOKEN: token! });
    expect(invitations.status, invitations.stderr + invitations.stdout).toBe(0);
    expect(JSON.parse(invitations.stdout)[0]).toMatchObject({ email: "reviewer@example.com", role: "viewer" });
    const plan = cli(dir, ["team", "retention", "plan", "--project", "default", "--days", "30"], { DRYRUN_TEAM_TOKEN: token! });
    expect(plan.status, plan.stderr + plan.stdout).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ total: 0, applied: false });
  });

  it("creates an online rule and promotes a production trace from the CLI", () => {
    const dir = tmpDir();
    const trace = {
      kind: "dry-run.trace", version: 1, id: "trace_cli", name: "refund-agent", status: "ok",
      startedAt: "2026-08-26T08:00:00.000Z", endedAt: "2026-08-26T08:00:00.100Z", durationMs: 100, rootSpanId: "root", tags: ["production"], feedback: [],
      spans: [
        { id: "root", traceId: "trace_cli", name: "agent", type: "agent", status: "ok", startedAt: "2026-08-26T08:00:00.000Z", endedAt: "2026-08-26T08:00:00.100Z", durationMs: 100, input: "refund", output: "approved", attributes: {}, metrics: {}, events: [] },
        { id: "llm", traceId: "trace_cli", parentId: "root", name: "model", type: "llm", status: "ok", startedAt: "2026-08-26T08:00:00.000Z", endedAt: "2026-08-26T08:00:00.080Z", durationMs: 80, input: { model: "local", messages: [{ role: "user", content: "refund" }] }, output: { text: "approved", toolCalls: [] }, attributes: {}, metrics: {}, events: [] },
      ],
    };
    const tracesDir = path.join(dir, ".dryrun/traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(path.join(tracesDir, "trace_cli.json"), JSON.stringify(trace));
    writeFileSync(path.join(dir, "trace.json"), JSON.stringify(trace));
    const create = cli(dir, ["online", "create", "--name", "latency", "--max-duration", "50", "--tag", "production"]);
    expect(create.status, create.stderr + create.stdout).toBe(0);
    const run = cli(dir, ["online", "run", "trace_cli"]);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ evaluated: 1, failed: 1 });
    const promote = cli(dir, ["promote", "trace", "trace.json", "--name", "refund regression"]);
    expect(promote.status, promote.stderr + promote.stdout).toBe(0);
    expect(promote.stdout).toContain("dataset + cassette + test");
    expect(existsSync(path.join(dir, ".dryrun/regressions"))).toBe(true);
  });

  it("passes release event data to the shell through an environment variable", () => {
    const workflow = readFileSync(path.join(repo, ".github/workflows/release.yml"), "utf8");
    const dockerfile = readFileSync(path.join(repo, "Dockerfile"), "utf8");
    expect(workflow).toContain('gh release upload "$RELEASE_TAG"');
    expect(workflow).not.toContain('gh release upload "${{ github.event.release.tag_name }}"');
    expect(workflow).toContain("IMAGE: ghcr.io/muratkomurcu1/dry-run");
    expect(workflow).not.toContain("IMAGE: ghcr.io/${{ github.repository_owner }}/dry-run");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
    expect(workflow).toContain("docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130");
    expect(workflow).toContain("docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8");
    expect(workflow).toContain("dry-run-trivy-cache:/root/.cache/trivy");
    expect(workflow).toContain("IMAGE_DIGEST: ${{ steps.image.outputs.digest }}");
    expect(workflow).toContain('["linux/amd64", "linux/arm64"]');
    expect(workflow).toContain("(cd dist-python && sha256sum *.whl) >> SHA256SUMS");
    expect(workflow).not.toContain("sha256sum muratkomurcu-dry-run-*.tgz dist-python/*.whl");
    expect(workflow).toContain("timeout-minutes: 45");
    expect(dockerfile).toContain("FROM --platform=$BUILDPLATFORM node:22-alpine AS build");
  });
});
