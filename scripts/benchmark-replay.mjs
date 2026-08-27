#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch, release, cpus } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import {
  CassetteStore,
  defineAgent,
  replayer,
  runScenarios,
  scenario,
} from "../dist/index.js";

const args = process.argv.slice(2);
const scenarioCount = numberArg("--scenarios", 250);
const iterations = numberArg("--iterations", 15);
const output = stringArg("--output");

if (!Number.isInteger(scenarioCount) || scenarioCount < 1) {
  throw new Error("--scenarios must be a positive integer");
}
if (!Number.isInteger(iterations) || iterations < 3) {
  throw new Error("--iterations must be an integer >= 3");
}

const dir = mkdtempSync(path.join(tmpdir(), "dryrun-benchmark-"));
const store = new CassetteStore(dir);
store.saveSync("single-turn", [
  {
    request: {
      model: "benchmark-model",
      messages: [{ role: "user", content: "recorded benchmark request" }],
    },
    response: {
      text: "deterministic replay",
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  },
]);

try {
  for (let i = 0; i < 2; i++) await executeSuite();

  const samplesMs = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    const summary = await executeSuite();
    const elapsed = performance.now() - started;
    if (summary.failed !== 0 || summary.passed !== scenarioCount) {
      throw new Error(`benchmark correctness failure: ${summary.failed} scenario(s) failed`);
    }
    samplesMs.push(round(elapsed));
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);
  const medianMs = percentile(sorted, 0.5);
  const p95Ms = percentile(sorted, 0.95);
  runCliExample();
  const cliSamplesMs = [];
  for (let i = 0; i < Math.min(iterations, 7); i++) {
    const started = performance.now();
    runCliExample();
    cliSamplesMs.push(round(performance.now() - started));
  }
  const sortedCli = [...cliSamplesMs].sort((a, b) => a - b);
  const result = {
    generatedAt: new Date().toISOString(),
    package: "@muratkomurcu/dry-run",
    benchmark: "single-turn cassette replay with one deterministic assertion",
    methodology:
      "Two warmups followed by measured in-process suites. Each scenario constructs a fresh replayer, reads and checksum-verifies cassette v2, canonical-matches the request, runs one agent turn, and evaluates outputEquals.",
    platform: {
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
    },
    scenarioCount,
    iterations,
    samplesMs,
    medianMs,
    p95Ms,
    medianScenariosPerSecond: round((scenarioCount / medianMs) * 1000),
    cliExample: {
      command: "node dist/cli.js run examples",
      samplesMs: cliSamplesMs,
      medianMs: percentile(sortedCli, 0.5),
      p95Ms: percentile(sortedCli, 0.95),
      processModel: "fresh Node.js process per sample",
    },
    networkCalls: 0,
    providerCostUsd: 0,
    notes: [
      "This measures dry-run replay overhead, not live-provider latency.",
      "Machine, filesystem, Node version, background load, and suite shape affect results.",
      "Use the committed raw samples and rerun this command before making environment-specific claims.",
    ],
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    const target = path.resolve(output);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, json);
  }
  process.stdout.write(json);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function runCliExample() {
  const run = spawnSync(process.execPath, ["dist/cli.js", "run", "examples"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (run.status !== 0) {
    throw new Error(`CLI example failed during benchmark:\n${run.stderr || run.stdout}`);
  }
}

async function executeSuite() {
  const scenarios = Array.from({ length: scenarioCount }, (_, index) =>
    scenario({
      name: `replay-${index}`,
      agent: defineAgent({
        provider: replayer(store, "single-turn"),
        model: "benchmark-model",
      }),
      input: "recorded benchmark request",
      expect: [{ type: "outputEquals", value: "deterministic replay" }],
    }),
  );
  return runScenarios(scenarios);
}

function stringArg(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function numberArg(name, fallback) {
  const raw = stringArg(name);
  return raw == null ? fallback : Number(raw);
}

function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}
