#!/usr/bin/env node
import path from "node:path";
import { statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { discoverTestFiles, loadScenarios, runScenarios } from "./runner.ts";
import { report } from "./reporter.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { loadConfig } from "./config.ts";
import { diffCassette } from "./diff.ts";
import type { Interaction } from "./cassette.ts";
import {
  toGoldenEntry,
  saveGolden,
  loadGolden,
  compareGolden,
} from "./golden.ts";
import type { GoldenEntry } from "./golden.ts";
import { generateScenario } from "./generate.ts";
import { renderHtml } from "./html-report.ts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

const USAGE = `dry-run — deterministic E2E testing for AI agents

Usage:
  dry-run run [paths...]       Run agent test scenarios (default: tests/ examples/)
  dry-run init                 Scaffold a starter scenario
  dry-run diff <a.json> <b.json>
                               Compare two cassettes — CI-friendly drift detection
  dry-run golden save <name> [paths...]
                               Save current run as a regression baseline
  dry-run golden check <name> [paths...]
                               Re-run and fail on drift vs baseline
  dry-run generate <cassette.json> [-o out.agentest.ts] [--name NAME]
                               Generate an editable scenario file from a cassette

Run options:
  --record                     Record LLM traffic into cassettes (overwrites)
  --replay                     Replay only — fail instead of hitting the network
  --passthrough                Ignore cassettes, call the live provider
  --watch                      Re-run on file changes
  --judge-model <model>        Enable LLM-as-judge semantic assertions
  --judge-provider <p>         Judge provider: openai (default) | anthropic
  --junit <file>               Write JUnit XML report for CI annotations
  --html <file>                Write a self-contained HTML trajectory report
  -h, --help                   Show this help

Cassette modes (used by autoCassette() in your scenarios):
  auto        replay if a cassette exists, otherwise record (default)
  record      always record fresh
  replay      never dial out; a miss throws

Docs: https://github.com/muratkomurcu/dry-run
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "-h" || command === "--help") {
    console.log(USAGE);
    return 0;
  }

  if (command === "diff") return cmdDiff(argv.slice(1));
  if (command === "generate") return cmdGenerate(argv.slice(1));
  if (command === "golden") return cmdGolden(argv.slice(1));

  if (command === "init") {
    return cmdInit();
  }

  if (command !== "run") {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    return 1;
  }

  const rest = argv.slice(1);
  let judgeModel: string | undefined;
  let judgeProvider: "openai" | "anthropic" | undefined;
  let junitPath: string | undefined;
  let htmlPath: string | undefined;
  let watch = false;
  const paths: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--judge-model") {
      judgeModel = rest[++i];
    } else if (rest[i] === "--judge-provider") {
      judgeProvider = rest[++i] as "openai" | "anthropic";
    } else if (rest[i] === "--junit") {
      junitPath = rest[++i];
    } else if (rest[i] === "--html") {
      htmlPath = rest[++i];
    } else if (rest[i] === "--watch") {
      watch = true;
    } else if (rest[i] === "--record") {
      process.env.DRYRUN_MODE = "record";
    } else if (rest[i] === "--replay") {
      process.env.DRYRUN_MODE = "replay";
    } else if (rest[i] === "--passthrough") {
      process.env.DRYRUN_MODE = "passthrough";
    } else {
      paths.push(rest[i]);
    }
  }

  const cfg = loadConfig();
  if (!process.env.DRYRUN_MODE && cfg.mode) process.env.DRYRUN_MODE = cfg.mode;

  const inputs = paths.length
    ? paths
    : cfg.include?.length
      ? cfg.include
      : ["tests", "examples"];
  const files = await discoverTestFiles(inputs).catch((e) => {
    console.error(String(e.message ?? e));
    return null;
  });

  if (!files) return 1;
  if (files.length === 0) {
    console.error(`No *.agentest.{ts,js,mjs} files found in: ${inputs.join(", ")}`);
    console.error(`Run \`dry-run init\` to scaffold your first scenario.`);
    return 1;
  }

  const scenarios = [];
  for (const file of files) {
    scenarios.push(...(await loadScenarios(file)));
  }

  const effectiveJudgeProvider =
    judgeProvider ?? cfg.judge?.provider ?? "openai";
  const effectiveJudgeModel = judgeModel ?? cfg.judge?.model;

  let judge;
  if (effectiveJudgeModel) {
    judge =
      effectiveJudgeProvider === "anthropic"
        ? new AnthropicProvider({ model: effectiveJudgeModel })
        : new OpenAIProvider({ model: effectiveJudgeModel });
  }

  if (watch) {
    await runWatch(inputs, { judge, junitPath });
    return 0;
  }

  const captured = new Map<string, { trajectory: import("./types.ts").Trajectory; tokens?: number }>();
  const summary = await runScenarios(scenarios, {
    judge,
    junitPath,
    onTrajectory: (name, t) => captured.set(name, { trajectory: t, tokens: undefined }),
    onResult: (r) => {
      const entry = captured.get(r.name);
      if (entry && r.tokens != null) entry.tokens = r.tokens;
    },
  });
  report(summary);

  if (htmlPath) {
    await writeHtmlReport(htmlPath, summary.results, captured);
    console.log(` ${DIM}html report → ${htmlPath}${RESET}`);
  }

  return summary.failed === 0 ? 0 : 1;
}

async function runWatch(
  inputs: string[],
  opts: { judge?: unknown; junitPath?: string },
): Promise<never> {
  const { watch: watchDirs } = await import("node:fs");
  const dirs = new Set<string>();
  for (const input of inputs) {
    try {
      if (statSync(input).isDirectory()) dirs.add(path.resolve(input));
      else dirs.add(path.dirname(path.resolve(input)));
    } catch {
      void input;
    }
  }

  console.log(`${DIM} watching ${[...dirs].join(", ")} — press Ctrl+C to stop${RESET}\n`);

  const runOnce = async () => {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(`${DIM} dry-run --watch${RESET}\n`);
    try {
      const files = await discoverTestFiles(inputs);
      const scenarios = [];
      for (const file of files) scenarios.push(...(await loadScenarios(file, { bust: true })));
      const summary = await runScenarios(scenarios, opts as never);
      report(summary);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
    }
  };

  await runOnce();

  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const dir of dirs) {
    watchDirs(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(runOnce, 120);
    });
  }

  return new Promise<never>(() => {});
}

async function writeHtmlReport(
  htmlPath: string,
  results: import("./types.ts").ScenarioResult[],
  captured: Map<string, { trajectory: import("./types.ts").Trajectory; tokens?: number }>,
): Promise<void> {
  const goldenPath = ".dryrun/golden/latest.json";
  let baseline: GoldenEntry[] | null = null;
  try {
    baseline = loadGolden(goldenPath).entries;
  } catch {
    baseline = null;
  }

  const htmlScenarios = results.map((r) => {
    const cap = captured.get(r.name);
    const steps: ReturnType<typeof toHtmlStep>[] = [];
    if (cap) {
      for (const st of cap.trajectory.steps) {
        steps.push(toHtmlStep(st));
      }
    }
    let goldenDiff;
    if (baseline && cap) {
      const entry = toGoldenEntry(r.name, cap.trajectory, r.tokens);
      const base = baseline.find((b) => b.name === r.name);
      const [diff] = compareGolden(base ? [base] : [], [entry]);
      goldenDiff = { status: diff?.status ?? "new", changes: diff?.changes ?? [] };
    }
    return {
      name: r.name,
      passed: r.passed,
      durationMs: r.durationMs,
      tokens: r.tokens,
      error: r.error,
      assertions: r.assertions,
      trajectory: steps,
      output: cap?.trajectory.output,
      goldenDiff,
    };
  });

  await writeFile(htmlPath, renderHtml(htmlScenarios));
}

function toHtmlStep(st: import("./types.ts").Trajectory["steps"][number]) {
  if (st.kind === "tool") {
    return {
      kind: "tool" as const,
      name: st.toolCall?.name,
      args: st.toolCall?.arguments,
      error: st.error,
    };
  }
  return { kind: "llm" as const, text: st.response };
}

async function cmdDiff(argv: string[]): Promise<number> {
  const [a, b] = argv.filter((x) => !x.startsWith("-"));
  if (!a || !b || a.startsWith("-") || b.startsWith("-")) {
    console.error("Usage: dry-run diff <a.json> <b.json>");
    return 1;
  }
  const interactionsA = await readInteractions(a);
  const interactionsB = await readInteractions(b);
  if (!interactionsA || !interactionsB) return 1;

  const drifts = diffCassette(interactionsA, interactionsB);
  console.log("");
  if (drifts.length === 0) {
    console.log(` ${GREEN}${BOLD}✓ identical${RESET} ${DIM}· ${a} vs ${b}${RESET}\n`);
    return 0;
  }
  console.log(` ${RED}${BOLD}${drifts.length} drift(s) detected${RESET} ${DIM}· ${a} vs ${b}${RESET}`);
  for (const d of drifts) {
    console.log(`   ${YELLOW}${d.type}${RESET} ${d.detail}`);
  }
  console.log("");
  return 1;
}

async function cmdGenerate(argv: string[]): Promise<number> {
  let cassettePath: string | undefined;
  let outPath: string | undefined;
  let name: string | undefined;
  let importFrom: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o") outPath = argv[++i];
    else if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--import-from") importFrom = argv[++i];
    else cassettePath = argv[i];
  }

  if (!cassettePath) {
    console.error("Usage: dry-run generate <cassette.json> [-o out.agentest.ts] [--name NAME] [--import-from PKG]");
    return 1;
  }

  const interactions = await readInteractions(cassettePath);
  if (!interactions) return 1;

  const derived =
    name ?? path.basename(cassettePath).replace(/\.json$/, "").replace(/[^a-z0-9]+/gi, "-");
  const source = generateScenario(interactions, {
    scenarioName: derived,
    importFrom: importFrom ?? "dry-run",
  });

  if (outPath) {
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await writeFile(outPath, source);
    console.log(` ${GREEN}✔${RESET} generated ${path.relative(process.cwd(), outPath)} ${DIM}(from ${cassettePath})${RESET}`);
    console.log(` ${DIM}The scenario references autoCassette("${derived}") — with the cassette committed it replays real traffic offline.${RESET}`);
  } else {
    console.log(source);
  }
  return 0;
}

async function cmdGolden(argv: string[]): Promise<number> {
  const mode = argv[0];
  const name = argv[1];
  if ((mode !== "save" && mode !== "check") || !name) {
    console.error("Usage: dry-run golden save|check <name> [paths...]");
    return 1;
  }

  const cfg = loadConfig();
  const inputs = argv.slice(2).length ? argv.slice(2) : cfg.include?.length ? cfg.include : ["tests", "examples"];
  const files = await discoverTestFiles(inputs);
  const scenarios = [];
  for (const file of files) scenarios.push(...(await loadScenarios(file)));

  const judgeModel = cfg.judge?.model;
  const judge = judgeModel
    ? cfg.judge?.provider === "anthropic"
      ? new AnthropicProvider({ model: judgeModel })
      : new OpenAIProvider({ model: judgeModel })
    : undefined;

  const captured = new Map<string, { trajectory: import("./types.ts").Trajectory; tokens?: number }>();
  const summary = await runScenarios(scenarios, {
    judge,
    onTrajectory: (n, t) => captured.set(n, { trajectory: t }),
    onResult: (r) => {
      const e = captured.get(r.name);
      if (e && r.tokens != null) e.tokens = r.tokens;
    },
  });

  const entries = [...captured.entries()].map(([n, v]) =>
    toGoldenEntry(n, v.trajectory, v.tokens),
  );

  const file = `.dryrun/golden/${slugify(name)}.json`;

  if (mode === "save") {
    saveGolden(file, entries);
    console.log(` ${GREEN}✔${RESET} baseline saved → ${file} ${DIM}(${entries.length} scenario(s))${RESET}`);
    return 0;
  }

  let baselineEntries: GoldenEntry[];
  try {
    baselineEntries = loadGolden(file).entries;
  } catch {
    console.error(` No baseline at ${file}. Run \`dry-run golden save ${name}\` first.`);
    return 1;
  }

  const diffs = compareGolden(baselineEntries, entries);
  const drifted = diffs.filter((d) => d.status !== "pass");

  for (const d of diffs) {
    const icon = d.status === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const label = d.status === "pass" ? "" : ` ${YELLOW}[${d.status}]${RESET}`;
    console.log(` ${icon} ${d.name}${label}`);
    for (const c of d.changes) console.log(`     ${c}`);
  }

  const verdict =
    drifted.length === 0
      ? `${GREEN}${BOLD}No drift${RESET}`
      : `${RED}${BOLD}${drifted.length}/${diffs.length} scenario(s) drifted${RESET}`;
  console.log(`\n ${verdict} ${DIM}vs ${file}${RESET}\n`);

  await writeFile(".dryrun/golden/latest.json", JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries }, null, 2));

  return drifted.length === 0 ? 0 : 1;
}

async function readInteractions(file: string): Promise<Interaction[] | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("expected an array of interactions");
    return parsed as Interaction[];
  } catch (e) {
    console.error(` Cannot read cassette ${file}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function cmdInit(): Promise<number> {  const dir = path.join(process.cwd(), "tests");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "smoke.agentest.ts");
  await writeFile(target, TEMPLATE.trimStart());

  console.log("");
  console.log(` ${"✔"} Created ${path.relative(process.cwd(), target)}`);
  console.log("");
  console.log(" Next steps:");
  console.log(`   1. Run it:        ${"npx dry-run run"}`);
  console.log(`   2. Edit the scenario to match your real agent.`);
  console.log("");
  console.log(" The starter uses a MockProvider so it passes offline, instantly.");
  console.log(" Swap in OpenAIProvider (or any LLMProvider) when you are ready.");
  console.log("");
  return 0;
}

const TEMPLATE = `
import { defineAgent, MockProvider, scenario } from "dry-run";

const provider = new MockProvider([
  { call: "get_weather", args: { city: "Paris" } },
  { say: "It is 21C and sunny in Paris." },
]);

export const weatherAgent = defineAgent({
  provider,
  system: "You are a helpful weather assistant.",
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  execute: () => ({ temp: 21, condition: "sunny" }),
});

export default [
  scenario({
    name: "smoke - weather agent answers",
    agent: weatherAgent,
    input: "What is the weather in Paris?",
    expect: [
      { type: "toolCalled", tool: "get_weather", argsContains: { city: "Paris" } },
      { type: "outputContains", value: "21C" },
      { type: "maxSteps", count: 4 },
    ],
  }),
];
`;

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
