#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { discoverTestFiles, loadScenarios, runScenarios } from "./runner.ts";
import type { RunOptions } from "./runner.ts";
import { report } from "./reporter.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { loadConfig } from "./config.ts";
import { diffCassette } from "./diff.ts";
import type { CassetteDocument, CassetteInput, Interaction, MatchMode } from "./cassette.ts";
import { finalizeDocument, parseCassette } from "./cassette.ts";
import {
  toGoldenEntry,
  saveGolden,
  loadGolden,
  compareGolden,
} from "./golden.ts";
import type { GoldenEntry } from "./golden.ts";
import { generateScenario } from "./generate.ts";
import { renderHtml } from "./html-report.ts";
import { writeGitHubReport, writeJsonReport, writeSarifReport } from "./report-files.ts";
import { installIsolation } from "./isolation.ts";
import { traceToCassette } from "./integrations/otel.ts";
import { migrateEvaluationExport, type MigrationSource } from "./integrations/migrations.ts";
import { Dataset } from "./dataset.ts";
import {
  compareExperiments,
  ExperimentStore,
  runExperiment,
  type ExperimentDefinition,
  type ExperimentDocument,
} from "./experiment.ts";
import { TraceStore, type SpanType } from "./tracing.ts";
import { startStudio } from "./studio.ts";
import { PromptRegistry } from "./prompts.ts";
import { generateAdversarialDataset, type RedTeamAttack, type RedTeamVulnerability } from "./generation.ts";
import { TeamWorkspace, type TeamPrincipal, type TeamRole } from "./team.ts";
import { startTeamServer } from "./team-server.ts";
import { RemoteTeamClient } from "./remote.ts";
import type { OidcOptions, OidcRoleMapping } from "./identity.ts";
import type { ScimOptions } from "./scim.ts";
import { ClickHouseAnalyticsStore } from "./analytics.ts";
import { createTeamBackup, restoreTeamBackup, verifyTeamBackup } from "./backup.ts";
import { createLocalJudge, discoverLocalJudge, testLocalJudge, validateLocalEndpoint } from "./local-judge.ts";
import { OnlineEvaluationEngine, OnlineEvaluationStore } from "./online-evaluation.ts";
import { PlaygroundStore, promotePlaygroundVariant, runPlayground, type PlaygroundVariant } from "./playground.ts";
import { RegressionStore } from "./promotion.ts";
import { createPrQualityReport, postGithubPrComment, writePrQualityReport } from "./pr-report.ts";
import { distributedRuntimeFromEnv } from "./distributed-runtime.ts";
import { DistributedWorkspaceState } from "./distributed-state.ts";
import { DistributedRecoveryManager } from "./distributed-recovery.ts";
import { trimTrailingSlashes } from "./safe-text.ts";

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
  dry-run import-trace <trace.json> -o <cassette.json> [--name NAME]
                               Convert OTLP/Jaeger/OpenAI agent spans into cassette v2
  dry-run migrate <source> <export.json> -o <bundle.json>
                               Import DeepEval, Langfuse, or Braintrust JSON exports
  dry-run cassette migrate|verify <files...>
                               Upgrade legacy cassettes or verify checksums/schema
  dry-run eval <experiment.ts> [options]
                               Run a dataset-driven evaluation and persist the result
  dry-run experiments list|show|compare [ids...]
                               Inspect or compare immutable experiment runs
  dry-run dataset validate|import|split|red-team <file> [options]
                               Validate, normalize, split, or adversarially expand datasets
  dry-run traces list|show [id] [options]
                               Search locally persisted agent, LLM and tool traces
  dry-run studio [--port 4318] [--no-open]
                               Open the token-protected local experiment/trace dashboard
  dry-run prompts list|show|publish|render|label [options]
                               Version, label and render local prompt templates
  dry-run judge detect|test [--endpoint URL] [--model MODEL]
                               Auto-detect and verify loopback Ollama/vLLM/LM Studio
  dry-run online create|list|run|results [options]
                               Evaluate production traces with persistent sampling rules
  dry-run promote trace <id|trace.json> [--name NAME]
                               Turn a production trace into dataset+cassette+regression test
  dry-run playground run|list|show|promote [options]
                               Compare local prompt/model variants and promote the winner
  dry-run pr-report <baseline> <candidate> [options]
                               Write experiment deltas to GitHub summary or a PR comment
  dry-run team init|serve|join|invite|member|key|project|queue|retention|backup|restore|recovery|dlq|diagnostics|push [options]
                               Run a free self-hosted workspace with member RBAC and remote ingest

Run options:
  --record                     Record LLM traffic into cassettes (overwrites)
  --replay                     Replay only — fail instead of hitting the network
  --passthrough                Ignore cassettes, call the live provider
  --watch                      Re-run on file changes
  --judge-model <model>        Enable LLM-as-judge semantic assertions
  --judge-provider <p>         Judge provider: openai (default) | anthropic | local
  --junit <file>               Write JUnit XML report for CI annotations
  --html <file>                Write a self-contained HTML trajectory report
  --json <file>                Write a machine-readable JSON report
  --sarif <file>               Write a SARIF 2.1 report
  --github                     Emit annotations and a GitHub job summary
  --filter <text>              Run scenarios whose names contain text
  --tag <tag>                  Require a scenario tag (repeatable)
  --exclude-tag <tag>          Exclude a scenario tag (repeatable)
  --shard <index/total>        Run a stable shard, for example 2/4
  --concurrency <n>            Run up to n scenarios concurrently
  --retries <n>                Retry failed scenarios n times
  --trials <n>                 Run every selected scenario n times
  --allow-skipped              Permit unavailable metrics/judges to stay green
  --match <mode>               Cassette matching: exact | canonical | shape
  --deny-network               Run under Node network permissions plus runtime guards
  --seed <value>               Seed Math.random and randomUUID
  --time <ISO-8601>            Freeze Date/Date.now during the run
  -h, --help                   Show this help

Cassette modes (used by autoCassette() in your scenarios):
  auto        replay if a cassette exists, otherwise record (default)
  record      always record fresh
  replay      never dial out; a miss throws

Docs: https://github.com/MuratKomurcu1/dry-run
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
  if (command === "import-trace") return cmdImportTrace(argv.slice(1));
  if (command === "migrate") return cmdMigrate(argv.slice(1));
  if (command === "cassette") return cmdCassette(argv.slice(1));
  if (command === "eval") return cmdEval(argv.slice(1));
  if (command === "experiments") return cmdExperiments(argv.slice(1));
  if (command === "dataset") return cmdDataset(argv.slice(1));
  if (command === "traces") return cmdTraces(argv.slice(1));
  if (command === "studio") return cmdStudio(argv.slice(1));
  if (command === "prompts") return cmdPrompts(argv.slice(1));
  if (command === "judge") return cmdJudge(argv.slice(1));
  if (command === "online") return cmdOnline(argv.slice(1));
  if (command === "promote") return cmdPromote(argv.slice(1));
  if (command === "playground") return cmdPlayground(argv.slice(1));
  if (command === "pr-report") return cmdPrReport(argv.slice(1));
  if (command === "team") return cmdTeam(argv.slice(1));

  if (command === "init") {
    return cmdInit();
  }

  if (command !== "run") {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    return 1;
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  if (argv.includes("--deny-network") && process.env.DRYRUN_ISOLATED !== "1") {
    if (argv.includes("--record") || argv.includes("--passthrough")) {
      console.error("--deny-network cannot be combined with --record or --passthrough");
      return 1;
    }
    return runIsolated();
  }

  const rest = argv.slice(1);
  let judgeModel: string | undefined;
  let judgeProvider: "openai" | "anthropic" | "local" | undefined;
  let junitPath: string | undefined;
  let htmlPath: string | undefined;
  let jsonPath: string | undefined;
  let sarifPath: string | undefined;
  let github = false;
  let filter: string | undefined;
  const tags: string[] = [];
  const excludeTags: string[] = [];
  let shard: { index: number; total: number } | undefined;
  let concurrency: number | undefined;
  let retries: number | undefined;
  let trials: number | undefined;
  let allowSkipped = false;
  let denyNetwork = false;
  let seed: string | undefined;
  let fixedTime: string | undefined;
  let watch = false;
  const paths: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--judge-model") {
      judgeModel = rest[++i];
    } else if (rest[i] === "--judge-provider") {
      judgeProvider = rest[++i] as "openai" | "anthropic" | "local";
      if (!["openai", "anthropic", "local"].includes(judgeProvider)) throw new Error("--judge-provider must be openai, anthropic, or local");
    } else if (rest[i] === "--junit") {
      junitPath = rest[++i];
    } else if (rest[i] === "--html") {
      htmlPath = rest[++i];
    } else if (rest[i] === "--json") {
      jsonPath = rest[++i];
    } else if (rest[i] === "--sarif") {
      sarifPath = rest[++i];
    } else if (rest[i] === "--github") {
      github = true;
    } else if (rest[i] === "--filter") {
      filter = rest[++i];
    } else if (rest[i] === "--tag") {
      tags.push(rest[++i]);
    } else if (rest[i] === "--exclude-tag") {
      excludeTags.push(rest[++i]);
    } else if (rest[i] === "--shard") {
      shard = parseShard(rest[++i]);
    } else if (rest[i] === "--concurrency") {
      concurrency = parseInteger(rest[++i], "--concurrency", 1);
    } else if (rest[i] === "--retries") {
      retries = parseInteger(rest[++i], "--retries", 0);
    } else if (rest[i] === "--trials") {
      trials = parseInteger(rest[++i], "--trials", 1);
    } else if (rest[i] === "--allow-skipped") {
      allowSkipped = true;
    } else if (rest[i] === "--match") {
      const matching = rest[++i] as MatchMode;
      if (!["exact", "canonical", "shape"].includes(matching)) throw new Error("--match must be exact, canonical, or shape");
      process.env.DRYRUN_MATCH = matching;
    } else if (rest[i] === "--deny-network") {
      denyNetwork = true;
    } else if (rest[i] === "--seed") {
      seed = rest[++i];
    } else if (rest[i] === "--time") {
      fixedTime = rest[++i];
    } else if (rest[i] === "--watch") {
      watch = true;
    } else if (rest[i] === "--record") {
      process.env.DRYRUN_MODE = "record";
    } else if (rest[i] === "--replay") {
      process.env.DRYRUN_MODE = "replay";
    } else if (rest[i] === "--passthrough") {
      process.env.DRYRUN_MODE = "passthrough";
    } else if (rest[i].startsWith("-")) {
      throw new Error(`Unknown run option: ${rest[i]}`);
    } else {
      paths.push(rest[i]);
    }
  }

  const cfg = loadConfig();
  if (!process.env.DRYRUN_MODE && cfg.mode) process.env.DRYRUN_MODE = cfg.mode;
  if (denyNetwork) {
    if (judgeModel ?? cfg.judge?.model ?? ((judgeProvider ?? cfg.judge?.provider) === "local" ? "local" : undefined)) throw new Error("--deny-network cannot use a live judge; provide deterministic assertions or run the judge separately");
    process.env.DRYRUN_MODE = "replay";
  }
  junitPath ??= cfg.junitPath;
  concurrency ??= cfg.concurrency;
  retries ??= cfg.retries;
  trials ??= cfg.trials;
  filter ??= cfg.filter;
  allowSkipped ||= cfg.allowSkipped ?? false;

  const isolation = installIsolation({ denyNetwork, seed, fixedTime });

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
  if (effectiveJudgeProvider === "local") {
    const profile = await discoverLocalJudge({ ...(effectiveJudgeModel ? { model: effectiveJudgeModel } : {}) });
    if (!profile) throw new Error("No local judge detected. Start Ollama/vLLM or set DRYRUN_LOCAL_JUDGE_URL and DRYRUN_LOCAL_JUDGE_MODEL");
    judge = createLocalJudge(profile);
  } else if (effectiveJudgeModel) {
    judge =
      effectiveJudgeProvider === "anthropic"
        ? new AnthropicProvider({ model: effectiveJudgeModel })
        : new OpenAIProvider({ model: effectiveJudgeModel });
  }

  if (watch) {
    await runWatch(inputs, {
      judge,
      junitPath,
      concurrency,
      retries,
      trials,
      allowSkipped,
      filter,
      tags: tags.length ? tags : cfg.tags,
      excludeTags: excludeTags.length ? excludeTags : cfg.excludeTags,
      shard,
    });
    return 0;
  }

  const captured = new Map<string, { trajectory: import("./types.ts").Trajectory; tokens?: number }>();
  const summary = await runScenarios(scenarios, {
    judge,
    junitPath,
    concurrency,
    retries,
    trials,
    allowSkipped,
    filter,
    tags: tags.length ? tags : cfg.tags,
    excludeTags: excludeTags.length ? excludeTags : cfg.excludeTags,
    shard,
    onTrajectory: (name, t, trial) => captured.set(resultKey(name, trial), { trajectory: t, tokens: undefined }),
    onResult: (r) => {
      const entry = captured.get(resultKey(r.name, r.trial ?? 1));
      if (entry && r.tokens != null) entry.tokens = r.tokens;
    },
  });
  if (summary.total === 0) {
    isolation.restore();
    console.error("No scenarios matched the requested filter, tags, or shard.");
    return 1;
  }
  report(summary);
  isolation.restore();

  if (htmlPath) {
    await writeHtmlReport(htmlPath, summary.results, captured);
    console.log(` ${DIM}html report → ${htmlPath}${RESET}`);
  }
  if (jsonPath) writeJsonReport(jsonPath, summary);
  if (sarifPath) writeSarifReport(sarifPath, summary);
  if (github) writeGitHubReport(summary);

  return summary.failed === 0 ? 0 : 1;
}

async function runWatch(
  inputs: string[],
  opts: RunOptions,
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
      const summary = await runScenarios(scenarios, opts);
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
    const cap = captured.get(resultKey(r.name, r.trial ?? 1));
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
      name: r.trial && r.trial > 1 ? `${r.name} [trial ${r.trial}]` : r.name,
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

function resultKey(name: string, trial: number): string {
  return `${name}\u0000${trial}`;
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
    importFrom: importFrom ?? "@muratkomurcu/dry-run",
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
  const judge = cfg.judge?.provider === "local"
    ? await discoverLocalJudge({ ...(judgeModel ? { model: judgeModel } : {}) }).then((profile) => profile ? createLocalJudge(profile) : undefined)
    : judgeModel
    ? cfg.judge?.provider === "anthropic"
      ? new AnthropicProvider({ model: judgeModel })
      : new OpenAIProvider({ model: judgeModel })
    : undefined;

  const captured = new Map<string, { trajectory: import("./types.ts").Trajectory; tokens?: number }>();
  const summary = await runScenarios(scenarios, {
    judge,
    concurrency: cfg.concurrency,
    retries: cfg.retries,
    allowSkipped: cfg.allowSkipped,
    filter: cfg.filter,
    tags: cfg.tags,
    excludeTags: cfg.excludeTags,
    onTrajectory: (n, t) => captured.set(n, { trajectory: t }),
    onResult: (r) => {
      const e = captured.get(r.name);
      if (e && r.tokens != null) e.tokens = r.tokens;
    },
  });

  if (summary.failed > 0) {
    report(summary);
    console.error(" Refusing to save or compare a golden baseline because the scenario run failed.");
    return 1;
  }
  if (summary.total === 0) {
    console.error("No scenarios matched the golden configuration filters.");
    return 1;
  }

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

async function readInteractions(file: string): Promise<CassetteInput | null> {
  try {
    const raw = await readFile(file, "utf8");
    return parseCassette(JSON.parse(raw), path.basename(file, path.extname(file)), { verifyChecksum: true });
  } catch (e) {
    console.error(` Cannot read cassette ${file}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function cmdImportTrace(argv: string[]): Promise<number> {
  let tracePath: string | undefined;
  let outputPath: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "-o" || argv[index] === "--output") outputPath = argv[++index];
    else if (argv[index] === "--name") name = argv[++index];
    else tracePath ??= argv[index];
  }
  if (!tracePath || !outputPath) {
    console.error("Usage: dry-run import-trace <trace.json> -o <cassette.json> [--name NAME]");
    return 1;
  }
  try {
    const input = JSON.parse(await readFile(tracePath, "utf8"));
    const document = traceToCassette(input, name ?? path.basename(outputPath, path.extname(outputPath)));
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(finalizeDocument(document), null, 2)}\n`, { mode: 0o600 });
    console.log(` ${GREEN}✔${RESET} imported ${document.interactions.length} LLM interaction(s) → ${outputPath}`);
    return 0;
  } catch (error) {
    console.error(` Import failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function cmdMigrate(argv: string[]): Promise<number> {
  const source = argv[0]?.toLowerCase() as MigrationSource | undefined;
  const inputPath = argv[1];
  const outputPath = optionValue(argv, "-o") ?? optionValue(argv, "--output");
  const name = optionValue(argv, "--name");
  if (!source || !["deepeval", "langfuse", "braintrust"].includes(source) || !inputPath || !outputPath) {
    console.error("Usage: dry-run migrate <deepeval|langfuse|braintrust> <export.json> -o <bundle.json> [--name NAME]");
    return 1;
  }
  try {
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    const bundle = migrateEvaluationExport(source, input, name ?? `${source}-import`);
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(` ${GREEN}✔${RESET} migrated ${bundle.summary.datasets} dataset(s), ${bundle.summary.cases} case(s), ${bundle.summary.traces} trace(s), ${bundle.summary.spans} span(s) → ${outputPath}`);
    for (const warning of bundle.warnings) console.warn(` ${YELLOW}!${RESET} ${warning}`);
    return 0;
  } catch (error) {
    console.error(` Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function cmdCassette(argv: string[]): Promise<number> {
  const [mode, ...files] = argv;
  if ((mode !== "migrate" && mode !== "verify") || files.length === 0) {
    console.error("Usage: dry-run cassette migrate|verify <files...>");
    return 1;
  }
  let failed = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      const document = parseCassette(raw, path.basename(file, path.extname(file)), { verifyChecksum: mode === "verify" });
      if (mode === "migrate") {
        await writeFile(file, `${JSON.stringify(finalizeDocument(document), null, 2)}\n`, { mode: 0o600 });
        console.log(` ${GREEN}✔${RESET} migrated ${file} → cassette v2`);
      } else {
        console.log(` ${GREEN}✔${RESET} valid ${file} ${DIM}(${document.interactions.length} interaction(s), ${document.metadata.matching})${RESET}`);
      }
    } catch (error) {
      failed++;
      console.error(` ${RED}✗${RESET} ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed ? 1 : 0;
}

async function cmdEval(argv: string[]): Promise<number> {
  let file: string | undefined;
  let concurrency: number | undefined;
  let trials: number | undefined;
  let retries: number | undefined;
  let timeoutMs: number | undefined;
  let resumeId: string | undefined;
  let jsonPath: string | undefined;
  let persist = true;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--concurrency") concurrency = parseInteger(argv[++index], arg, 1);
    else if (arg === "--trials") trials = parseInteger(argv[++index], arg, 1);
    else if (arg === "--retries") retries = parseInteger(argv[++index], arg, 0);
    else if (arg === "--timeout") timeoutMs = parseInteger(argv[++index], arg, 1);
    else if (arg === "--resume") resumeId = requiredValue(argv[++index], arg);
    else if (arg === "--json") jsonPath = requiredValue(argv[++index], arg);
    else if (arg === "--no-store") persist = false;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: dry-run eval <experiment.ts> [--concurrency N] [--trials N] [--retries N] [--timeout MS] [--resume ID] [--json FILE] [--no-store]");
      return 0;
    } else if (arg.startsWith("-")) throw new Error(`Unknown eval option: ${arg}`);
    else if (!file) file = arg;
    else throw new Error(`Unexpected eval argument: ${arg}`);
  }
  if (!file) {
    console.error("Usage: dry-run eval <experiment.ts> [options]");
    return 1;
  }

  const absolute = path.resolve(file);
  if (!existsSync(absolute)) throw new Error(`Experiment module not found: ${file}`);
  const module = await import(`${pathToFileURL(absolute).href}?dryrun=${Date.now()}`) as Record<string, unknown>;
  const definitions = experimentDefinitions(module);
  if (definitions.length === 0) throw new Error("Experiment module must export an ExperimentDefinition as default, `experiment`, or `experiments`");

  let failed = 0;
  for (const definition of definitions) {
    const document = await runExperiment(definition, {
      concurrency,
      trials,
      retries,
      timeoutMs,
      resumeId,
      persist,
      onResult: (result) => {
        const icon = result.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
        const label = result.name ?? result.caseId;
        const scores = result.scores.map((score) => `${score.name}=${score.score.toFixed(3)}`).join(" ");
        console.log(` ${icon} ${label}${result.trial > 1 ? ` [trial ${result.trial}]` : ""} ${DIM}${result.durationMs}ms${scores ? ` · ${scores}` : ""}${RESET}`);
      },
    });
    printExperiment(document);
    if (jsonPath) {
      const target = definitions.length === 1 ? jsonPath : numberedOutput(jsonPath, document.id);
      await mkdir(path.dirname(path.resolve(target)), { recursive: true });
      await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      console.log(` ${DIM}json result → ${target}${RESET}`);
    }
    if (!document.passed) failed++;
  }
  return failed ? 1 : 0;
}

async function cmdExperiments(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  const store = new ExperimentStore();
  if (mode === "list") {
    const documents = store.list();
    if (documents.length === 0) {
      console.log(`${DIM}No experiments. Run \`dry-run eval <experiment.ts>\` first.${RESET}`);
      return 0;
    }
    console.log(`${BOLD}STATUS  PASS  CASES  CREATED                   ID / NAME${RESET}`);
    for (const item of documents) {
      const status = item.status.padEnd(7);
      const pass = item.passed ? `${GREEN}yes${RESET}` : `${RED}no ${RESET}`;
      console.log(`${status} ${pass}   ${String(item.summary.total).padStart(5)}  ${item.createdAt.padEnd(25)} ${item.id} · ${item.name}`);
    }
    return 0;
  }
  if (mode === "show" && args[0]) {
    console.log(JSON.stringify(store.load(args[0]), null, 2));
    return 0;
  }
  if (mode === "compare" && args[0] && args[1]) {
    const comparison = compareExperiments(store.load(args[0]), store.load(args[1]));
    console.log(`\n ${BOLD}${comparison.baseline.name} → ${comparison.candidate.name}${RESET}`);
    for (const score of comparison.scoreDeltas) {
      const color = score.delta < 0 ? RED : score.delta > 0 ? GREEN : DIM;
      console.log(` ${color}${formatSigned(score.delta)}${RESET} ${score.name} ${DIM}${score.baseline.toFixed(3)} → ${score.candidate.toFixed(3)} · pass ${formatSigned(score.passRateDelta)}${RESET}`);
    }
    for (const regression of comparison.regressions) console.log(` ${RED}▼ regression${RESET} ${regression.caseId} [${regression.trial}] · ${regression.reason}`);
    for (const improvement of comparison.improvements) console.log(` ${GREEN}▲ improvement${RESET} ${improvement.caseId} [${improvement.trial}] · ${improvement.reason}`);
    if (comparison.added.length) console.log(` ${GREEN}+${RESET} ${comparison.added.length} added case result(s)`);
    if (comparison.removed.length) console.log(` ${YELLOW}-${RESET} ${comparison.removed.length} removed case result(s)`);
    console.log("");
    return comparison.regressions.length || comparison.scoreDeltas.some((score) => score.delta < 0) ? 1 : 0;
  }
  console.error("Usage: dry-run experiments list | show <id> | compare <baseline-id> <candidate-id>");
  return 1;
}

async function cmdDataset(argv: string[]): Promise<number> {
  const [mode, file, ...args] = argv;
  if (!mode || !file) {
    console.error("Usage: dry-run dataset validate|import|split|red-team <file> [options]");
    return 1;
  }
  const dataset = Dataset.load(file);
  if (mode === "validate") {
    console.log(` ${GREEN}✔${RESET} ${dataset.name} ${DIM}· ${dataset.cases.length} case(s) · ${dataset.checksum}${RESET}`);
    return 0;
  }
  if (mode === "import") {
    const output = optionValue(args, "-o") ?? optionValue(args, "--output") ?? path.join(".dryrun", "datasets", `${slugify(dataset.name)}.json`);
    dataset.save(output);
    console.log(` ${GREEN}✔${RESET} normalized ${dataset.cases.length} case(s) → ${output}`);
    return 0;
  }
  if (mode === "split") {
    const ratio = Number(optionValue(args, "--ratio") ?? "0.8");
    if (!Number.isFinite(ratio)) throw new Error("--ratio expects a number between 0 and 1");
    const { train, test } = dataset.split(ratio);
    const trainPath = optionValue(args, "--train") ?? path.join(".dryrun", "datasets", `${slugify(dataset.name)}-train.json`);
    const testPath = optionValue(args, "--test") ?? path.join(".dryrun", "datasets", `${slugify(dataset.name)}-test.json`);
    train.save(trainPath);
    test.save(testPath);
    console.log(` ${GREEN}✔${RESET} train ${train.cases.length} → ${trainPath}`);
    console.log(` ${GREEN}✔${RESET} test  ${test.cases.length} → ${testPath}`);
    return 0;
  }
  if (mode === "red-team") {
    const attacks = optionValue(args, "--attacks")?.split(",").map((attack) => attack.trim()).filter(Boolean) as RedTeamAttack[] | undefined;
    const vulnerabilities = optionValue(args, "--vulnerabilities")?.split(",").map((value) => value.trim()).filter(Boolean) as RedTeamVulnerability[] | undefined;
    const output = optionValue(args, "-o") ?? optionValue(args, "--output") ?? path.join(".dryrun", "datasets", `${slugify(dataset.name)}-red-team.json`);
    const generated = generateAdversarialDataset(dataset, {
      ...(attacks ? { attacks } : {}),
      ...(vulnerabilities ? { vulnerabilities } : {}),
      ...(optionValue(args, "--canary") ? { canary: optionValue(args, "--canary") } : {}),
    });
    generated.save(output);
    console.log(` ${GREEN}✔${RESET} generated ${generated.cases.length} adversarial case(s) → ${output}`);
    return 0;
  }
  console.error("Usage: dry-run dataset validate|import|split|red-team <file> [options]");
  return 1;
}

async function cmdTraces(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  const store = new TraceStore();
  if (mode === "show" && args[0]) {
    console.log(JSON.stringify(store.load(args[0]), null, 2));
    return 0;
  }
  if (mode === "list") {
    const status = optionValue(args, "--status");
    if (status && status !== "ok" && status !== "error") throw new Error("--status must be ok or error");
    const type = optionValue(args, "--type");
    const spanTypes: SpanType[] = ["agent", "task", "llm", "tool", "retriever", "scorer", "custom"];
    if (type && !spanTypes.includes(type as SpanType)) throw new Error(`--type must be one of: ${spanTypes.join(", ")}`);
    const traces = store.list({
      ...(status ? { status: status as "ok" | "error" } : {}),
      ...(type ? { type: type as SpanType } : {}),
      ...(optionValue(args, "--query") ? { query: optionValue(args, "--query") } : {}),
      ...(optionValue(args, "--tag") ? { tag: optionValue(args, "--tag") } : {}),
    });
    if (!traces.length) {
      console.log(`${DIM}No matching traces.${RESET}`);
      return 0;
    }
    console.log(`${BOLD}STATUS  SPANS  DURATION  STARTED                   ID / NAME${RESET}`);
    for (const trace of traces) {
      const statusLabel = trace.status === "ok" ? `${GREEN}ok   ${RESET}` : `${RED}error${RESET}`;
      console.log(`${statusLabel}   ${String(trace.spans.length).padStart(5)}  ${formatDuration(trace.durationMs).padStart(8)}  ${trace.startedAt.padEnd(25)} ${trace.id} · ${trace.name}`);
    }
    return 0;
  }
  console.error("Usage: dry-run traces list [--status ok|error] [--type TYPE] [--query TEXT] [--tag TAG] | show <id>");
  return 1;
}

async function cmdStudio(argv: string[]): Promise<number> {
  let port = 4318;
  let shouldOpen = true;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--port") port = parseInteger(argv[++index], "--port", 0);
    else if (argv[index] === "--no-open") shouldOpen = false;
    else if (argv[index] === "-h" || argv[index] === "--help") {
      console.log("Usage: dry-run studio [--port 4318] [--no-open]");
      return 0;
    } else throw new Error(`Unknown studio option: ${argv[index]}`);
  }
  if (port > 65_535) throw new Error("--port must be <= 65535");
  const handle = await startStudio({ port });
  console.log(`\n ${GREEN}◆${RESET} ${BOLD}dry-run studio${RESET}`);
  console.log(` ${DIM}loopback only · bearer token protected · Ctrl+C to stop${RESET}`);
  console.log(` ${handle.url}\n`);
  if (shouldOpen) openBrowser(handle.url);
  await waitForShutdown();
  await handle.close();
  return 0;
}

async function cmdJudge(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  if (mode !== "detect" && mode !== "test") {
    console.error("Usage: dry-run judge detect|test [--endpoint URL] [--model MODEL] [--json]");
    return 1;
  }
  const profile = await discoverLocalJudge({ endpoint: optionValue(args, "--endpoint"), model: optionValue(args, "--model"), ...(optionValue(args, "--timeout") ? { timeoutMs: parseInteger(optionValue(args, "--timeout"), "--timeout", 100) } : {}) });
  if (!profile) {
    console.error(`${RED}✗${RESET} no local Ollama/vLLM/LM Studio judge detected`);
    console.error(`${DIM}Start a local server or set DRYRUN_LOCAL_JUDGE_URL and DRYRUN_LOCAL_JUDGE_MODEL.${RESET}`);
    return 1;
  }
  if (mode === "test") {
    const tested = await testLocalJudge(profile);
    if (args.includes("--json")) console.log(JSON.stringify({ profile, test: tested }, null, 2));
    else console.log(`${GREEN}✔${RESET} ${profile.kind} · ${profile.model} · ${profile.endpoint} · ${tested.durationMs}ms`);
  } else if (args.includes("--json")) console.log(JSON.stringify(profile, null, 2));
  else console.log(`${GREEN}✔${RESET} ${profile.kind} · ${profile.model} · ${profile.endpoint}\n${DIM}${profile.availableModels.length} local model(s) available${RESET}`);
  return 0;
}

async function cmdOnline(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  const store = new OnlineEvaluationStore(optionValue(args, "--dir") ?? path.resolve(".dryrun/online"));
  if (mode === "list") {
    const rules = store.listRules();
    if (args.includes("--json")) console.log(JSON.stringify(rules, null, 2));
    else if (!rules.length) console.log(`${DIM}No online rules. Create one with dry-run online create.${RESET}`);
    else for (const rule of rules) console.log(`${rule.enabled ? GREEN + "●" : DIM + "○"}${RESET} ${rule.id} · r${rule.revision} · ${rule.name} · sample ${Math.round((rule.filter.sampleRate ?? 1) * 100)}% · ${rule.checks.length} check(s)`);
    return 0;
  }
  if (mode === "create") {
    const ruleFile = optionValue(args, "--rule");
    const input = ruleFile ? asObject(JSON.parse(await readFile(path.resolve(ruleFile), "utf8")), "rule") : onlineRuleFromArgs(args);
    const rule = await store.create(input as any);
    console.log(`${GREEN}✔${RESET} ${rule.id} · ${rule.name} · revision ${rule.revision}`);
    return 0;
  }
  if (mode === "results") {
    const results = store.listResults({ ruleId: optionValue(args, "--rule-id"), traceId: optionValue(args, "--trace-id"), limit: optionValue(args, "--limit") ? parseInteger(optionValue(args, "--limit"), "--limit", 1) : undefined });
    console.log(JSON.stringify(results, null, 2));
    return 0;
  }
  if (mode === "run") {
    const traces = new TraceStore(optionValue(args, "--traces-dir") ?? path.resolve(".dryrun/traces"));
    const ids = positionalArgs(args, ["--dir", "--traces-dir", "--limit", "--model"]);
    const documents = ids.length ? ids.map((id) => traces.load(id)) : traces.list().slice(0, optionValue(args, "--limit") ? parseInteger(optionValue(args, "--limit"), "--limit", 1) : 500);
    const profile = args.includes("--local-judge") ? await discoverLocalJudge({ model: optionValue(args, "--model") }) : undefined;
    const annotations = new (await import("./team.ts")).AnnotationStore(path.resolve(".dryrun/annotations"));
    const summary = await new OnlineEvaluationEngine(store, { ...(profile ? { judge: createLocalJudge(profile) } : {}), annotations }).evaluateMany(documents);
    console.log(JSON.stringify({ traces: summary.traces, matched: summary.matched, evaluated: summary.evaluated, passed: summary.passed, failed: summary.failed, cached: summary.cached }, null, 2));
    return summary.failed ? 1 : 0;
  }
  console.error("Usage: dry-run online create|list|run|results [options]");
  return 1;
}

function onlineRuleFromArgs(args: string[]): Record<string, unknown> {
  const checks: Array<Record<string, unknown>> = [];
  if (optionValue(args, "--max-duration")) checks.push({ type: "maxDuration", ms: parseInteger(optionValue(args, "--max-duration"), "--max-duration", 1) });
  if (optionValue(args, "--max-cost")) checks.push({ type: "maxCost", usd: positiveNumber(optionValue(args, "--max-cost"), "--max-cost") });
  if (optionValue(args, "--max-tokens")) checks.push({ type: "maxTokens", count: parseInteger(optionValue(args, "--max-tokens"), "--max-tokens", 1) });
  for (const tool of optionValues(args, "--required-tool")) checks.push({ type: "toolCalled", tool });
  for (const tool of optionValues(args, "--forbidden-tool")) checks.push({ type: "notToolCalled", tool });
  for (const value of optionValues(args, "--output-contains")) checks.push({ type: "outputContains", value });
  for (const criteria of optionValues(args, "--semantic")) checks.push({ type: "semantic", criteria });
  if (args.includes("--no-tool-errors")) checks.push({ type: "noToolErrors" });
  if (args.includes("--no-loops")) checks.push({ type: "noRepeatedToolCalls" });
  if (!checks.length) throw new Error("Online rule requires at least one check flag or --rule JSON file");
  const sampleRate = optionValue(args, "--sample") == null ? 1 : positiveNumber(optionValue(args, "--sample"), "--sample", true);
  if (sampleRate > 1) throw new Error("--sample must be between 0 and 1");
  return {
    name: optionValue(args, "--name") ?? "Production quality rule",
    enabled: !args.includes("--disabled"),
    filter: { sampleRate, ...(optionValues(args, "--tag").length ? { tags: optionValues(args, "--tag") } : {}), ...(optionValue(args, "--trace-name") ? { traceNameContains: optionValue(args, "--trace-name") } : {}) },
    checks,
    action: { queueName: optionValue(args, "--queue") ?? "Online evaluation failures", labels: optionValues(args, "--label") },
    unavailable: args.includes("--skip-unavailable") ? "skip" : "fail",
  };
}

async function cmdPromote(argv: string[]): Promise<number> {
  const [mode, source, ...args] = argv;
  if (mode !== "trace" || !source) { console.error("Usage: dry-run promote trace <id|trace.json> [--name NAME] [--output DIR]"); return 1; }
  const trace = existsSync(path.resolve(source))
    ? JSON.parse(await readFile(path.resolve(source), "utf8"))
    : new TraceStore(optionValue(args, "--traces-dir") ?? path.resolve(".dryrun/traces")).load(source);
  const bundle = await new RegressionStore(optionValue(args, "--output") ?? path.resolve(".dryrun/regressions")).promote(trace, { ...(optionValue(args, "--name") ? { name: optionValue(args, "--name") } : {}), ...(optionValue(args, "--online-result") ? { onlineResultId: optionValue(args, "--online-result") } : {}), ...(optionValue(args, "--annotation") ? { annotationItemId: optionValue(args, "--annotation") } : {}) });
  console.log(`${GREEN}✔${RESET} ${bundle.manifest.id} · dataset${bundle.cassette ? " + cassette + test" : ""}`);
  for (const warning of bundle.manifest.warnings) console.log(`${YELLOW}!${RESET} ${warning}`);
  return 0;
}

async function cmdPlayground(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  const store = new PlaygroundStore(optionValue(args, "--dir") ?? path.resolve(".dryrun/playground"));
  if (mode === "list") { console.log(JSON.stringify(store.list().map((run) => ({ id: run.id, name: run.name, createdAt: run.createdAt, winner: run.winner, summaries: run.summaries })), null, 2)); return 0; }
  if (mode === "show" && args[0]) { console.log(JSON.stringify(store.load(args[0]), null, 2)); return 0; }
  if (mode === "run" && args[0]) {
    const definition = asObject(JSON.parse(await readFile(path.resolve(args[0]), "utf8")), "playground definition") as any;
    const explicitEndpoint = definition.endpoint as string | undefined;
    const profile = await discoverLocalJudge({ ...(explicitEndpoint ? { endpoint: explicitEndpoint } : {}), model: optionValue(args, "--model") ?? definition.variants?.[0]?.model });
    if (!profile && !explicitEndpoint) throw new Error("No local model server detected for playground");
    const provider = (variant: PlaygroundVariant, endpoint?: string) => {
      const baseURL = endpoint ?? profile?.endpoint;
      if (!baseURL) throw new Error("Playground requires a loopback endpoint");
      validateLocalEndpoint(baseURL);
      return new OpenAIProvider({ baseURL, apiKey: "dry-run-local", model: variant.model });
    };
    const run = await runPlayground(definition, { provider, ...(profile ? { judge: createLocalJudge(profile) } : {}), store });
    console.log(`${GREEN}✔${RESET} ${run.id} · winner ${run.winner ?? "none"}`);
    for (const summary of run.summaries) console.log(` ${summary.variantId === run.winner ? GREEN + "★" : DIM + "·"}${RESET} ${summary.name} · score ${summary.meanScore.toFixed(3)} · pass ${Math.round(summary.passRate * 100)}% · ${summary.durationMs}ms`);
    return run.status === "failed" ? 1 : 0;
  }
  if (mode === "promote" && args[0] && args[1]) {
    const promoted = await promotePlaygroundVariant(store.load(args[0]), args[1], new PromptRegistry(), new ExperimentStore(), { ...(optionValue(args, "--label") ? { label: optionValue(args, "--label") } : {}) });
    console.log(`${GREEN}✔${RESET} prompt v${promoted.prompt.version} + experiment ${promoted.experiment.id}`);
    return 0;
  }
  console.error("Usage: dry-run playground run <definition.json> | list | show <id> | promote <run-id> <variant-id>");
  return 1;
}

async function cmdPrReport(argv: string[]): Promise<number> {
  const [baselineRef, candidateRef, ...args] = argv;
  if (!baselineRef || !candidateRef) { console.error("Usage: dry-run pr-report <baseline-id|json> <candidate-id|json> [--output FILE] [--post-comment] [--no-fail]"); return 1; }
  const store = new ExperimentStore();
  const load = async (ref: string): Promise<ExperimentDocument> => existsSync(path.resolve(ref)) ? JSON.parse(await readFile(path.resolve(ref), "utf8")) : store.load(ref);
  const report = createPrQualityReport(await load(baselineRef), await load(candidateRef));
  writePrQualityReport(report, { ...(optionValue(args, "--output") ? { output: optionValue(args, "--output") } : {}) });
  if (!process.env.GITHUB_STEP_SUMMARY || args.includes("--stdout")) console.log(report.markdown);
  if (args.includes("--post-comment")) {
    const posted = await postGithubPrComment(report.markdown, { ...(optionValue(args, "--pr") ? { pullRequest: parseInteger(optionValue(args, "--pr"), "--pr", 1) } : {}) });
    console.log(`${GREEN}✔${RESET} GitHub PR comment ${posted.action}${posted.url ? ` · ${posted.url}` : ""}`);
  }
  return report.fail && !args.includes("--no-fail") ? 1 : 0;
}

async function cmdTeam(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  if (!mode || mode === "-h" || mode === "--help") {
    console.log("Usage: dry-run team init|serve|join|invite|member|key|project|queue|retention|backup|restore|recovery|dlq|diagnostics|push [options]\n\nTeam admin commands read DRYRUN_TEAM_TOKEN from the environment; join reads DRYRUN_INVITATION_TOKEN. Remote listeners require TLS unless the explicit development override is supplied.");
    return 0;
  }
  const teamDir = path.resolve(optionValue(args, "--dir") ?? path.join(".dryrun", "team"));
  if (mode === "init") {
    const name = optionValue(args, "--name") ?? path.basename(process.cwd());
    const retentionDays = parseInteger(optionValue(args, "--retention-days") ?? "90", "--retention-days", 1);
    const { workspace, admin } = await TeamWorkspace.initialize(teamDir, name, { retentionDays });
    const distributed = await distributedRuntimeFromEnv();
    if (distributed) {
      try {
        const encryptionSecret = process.env.DRYRUN_STATE_ENCRYPTION_KEY;
        if (!encryptionSecret) throw new Error("Distributed initialization requires DRYRUN_STATE_ENCRYPTION_KEY");
        await DistributedWorkspaceState.open(distributed, teamDir, { alias: process.env.DRYRUN_WORKSPACE_ALIAS ?? "default", encryptionSecret });
      } finally { await distributed.close(); }
    }
    console.log(`\n ${GREEN}✔${RESET} ${BOLD}Team workspace initialized${RESET}`);
    console.log(` ${DIM}${workspace.dir}${RESET}`);
    console.log(`\n ${YELLOW}Admin token — shown once:${RESET}\n ${admin.token}`);
    console.log(`\n Export it before running admin commands:\n ${DIM}export DRYRUN_TEAM_TOKEN='${admin.token}'${RESET}\n`);
    return 0;
  }
  if (mode === "serve") {
    const host = optionValue(args, "--host") ?? "127.0.0.1";
    const port = parseInteger(optionValue(args, "--port") ?? "4320", "--port", 0);
    if (port > 65_535) throw new Error("--port must be <= 65535");
    const cert = optionValue(args, "--tls-cert");
    const key = optionValue(args, "--tls-key");
    const oidc = oidcOptionsFromEnv(args);
    const scim = scimOptionsFromEnv();
    const analytics = clickHouseAnalyticsFromEnv(args);
    const distributed = await distributedRuntimeFromEnv();
    let distributedState: DistributedWorkspaceState | undefined;
    try {
      if (distributed) {
        const encryptionSecret = process.env.DRYRUN_STATE_ENCRYPTION_KEY;
        if (!encryptionSecret) throw new Error("Distributed mode requires DRYRUN_STATE_ENCRYPTION_KEY so non-trace workspace state is encrypted at rest");
        distributedState = await DistributedWorkspaceState.open(distributed, teamDir, { alias: process.env.DRYRUN_WORKSPACE_ALIAS ?? "default", encryptionSecret });
      }
    } catch (error) { await distributed?.close(); throw error; }
    const workspace = new TeamWorkspace(teamDir);
    const localProfile = process.env.DRYRUN_LOCAL_JUDGE_AUTO === "false" ? undefined : await discoverLocalJudge({ endpoint: process.env.DRYRUN_LOCAL_JUDGE_URL, model: process.env.DRYRUN_LOCAL_JUDGE_MODEL });
    const localJudge = localProfile ? createLocalJudge(localProfile) : undefined;
    const playgroundProvider = (variant: PlaygroundVariant, endpoint?: string) => {
      const baseURL = normalizeLocalBaseURL(endpoint ?? localProfile?.endpoint ?? "http://127.0.0.1:11434/v1");
      return new OpenAIProvider({ baseURL, apiKey: "dry-run-local", model: variant.model });
    };
    if (Boolean(cert) !== Boolean(key)) throw new Error("--tls-cert and --tls-key must be provided together");
    let handle;
    try { handle = await startTeamServer({
      workspace,
      host,
      port,
      ...(cert && key ? { tls: { cert, key } } : {}),
      allowInsecureRemote: args.includes("--allow-insecure-remote"),
      ...(optionValue(args, "--cors-origin") ? { corsOrigins: optionValue(args, "--cors-origin")!.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
      ...(optionValue(args, "--max-project-bytes") ? { maxProjectBytes: parseInteger(optionValue(args, "--max-project-bytes"), "--max-project-bytes", 1) } : {}),
      ...(optionValue(args, "--max-project-files") ? { maxProjectFiles: parseInteger(optionValue(args, "--max-project-files"), "--max-project-files", 1) } : {}),
      ...(optionValue(args, "--max-body-bytes") ? { maxBodyBytes: parseInteger(optionValue(args, "--max-body-bytes"), "--max-body-bytes", 1) } : {}),
      ...(optionValue(args, "--requests-per-minute") ? { requestsPerMinute: parseInteger(optionValue(args, "--requests-per-minute"), "--requests-per-minute", 1) } : {}),
      ...(oidc ? { oidc } : {}),
      ...(scim ? { scim } : {}),
      ...(analytics ? { analytics } : {}),
      ...(distributed ? { distributed } : {}),
      ...(distributedState ? { distributedState } : {}),
      ...(localJudge ? { localJudge } : {}),
      playgroundProvider,
      ...(process.env.DRYRUN_METRICS_TOKEN ? { metricsToken: process.env.DRYRUN_METRICS_TOKEN } : {}),
      metricsEnabled: process.env.DRYRUN_METRICS_ENABLED !== "false",
      ...(process.env.DRYRUN_GRACEFUL_SHUTDOWN_MS ? { gracefulShutdownMs: parseInteger(process.env.DRYRUN_GRACEFUL_SHUTDOWN_MS, "DRYRUN_GRACEFUL_SHUTDOWN_MS", 1) } : {}),
    }); } catch (error) { await distributed?.close(); throw error; }
    console.log(`\n ${GREEN}◆${RESET} ${BOLD}dry-run team${RESET}`);
    console.log(` ${DIM}${handle.secure ? "TLS" : "loopback HTTP"} · RBAC · audit · durable ingest · Ctrl+C to stop${RESET}`);
    console.log(` ${DIM}local judge · ${localProfile ? `${localProfile.model} at ${localProfile.endpoint}` : "not detected (deterministic rules still active)"}${RESET}`);
    console.log(` ${DIM}storage · ${distributed ? "PostgreSQL + encrypted S3/MinIO state + NATS JetStream · stateless nodes" : "local filesystem"}${analytics ? " · ClickHouse analytics" : ""}${RESET}`);
    console.log(` ${handle.url}\n`);
    if (!args.includes("--no-open")) openBrowser(handle.url);
    await waitForShutdown();
    await handle.close();
    return 0;
  }

  if (mode === "join") {
    const invitationToken = process.env.DRYRUN_INVITATION_TOKEN ?? "";
    if (!invitationToken) throw new Error("DRYRUN_INVITATION_TOKEN is required for team join");
    const endpoint = new URL(requiredValue(optionValue(args, "--endpoint"), "--endpoint"));
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("--endpoint cannot contain credentials, a query, or fragment");
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname.toLowerCase());
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback) && !args.includes("--allow-insecure-http")) throw new Error("Remote team join requires HTTPS");
    const response = await fetch(new URL("/api/v1/invitations/accept", endpoint), {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invitationToken, name: requiredValue(optionValue(args, "--name"), "--name"), sessionDays: parseInteger(optionValue(args, "--session-days") ?? "90", "--session-days", 1) }),
    });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(body?.error ?? `Team join failed with HTTP ${response.status}`);
    console.log(`${GREEN}✔${RESET} joined as ${body.member.name} (${body.member.role})`);
    console.log(`${YELLOW}Member token — shown once:${RESET}\n${body.session.token}`);
    return 0;
  }

  if (mode === "backup") {
    const output = path.resolve(requiredValue(optionValue(args, "--output"), "--output"));
    const manifest = await createTeamBackup(teamDir, output);
    console.log(`${GREEN}✔${RESET} backup verified · ${manifest.totals.files} files · ${manifest.totals.bytes} bytes`);
    console.log(`${DIM}${output}${RESET}`);
    return 0;
  }
  if (mode === "restore") {
    const input = path.resolve(requiredValue(optionValue(args, "--input"), "--input"));
    if (args.includes("--verify-only")) {
      const manifest = await verifyTeamBackup(input);
      console.log(`${GREEN}✔${RESET} backup integrity verified · ${manifest.totals.files} files · ${manifest.totals.bytes} bytes`);
      return 0;
    }
    if (!args.includes("--yes")) throw new Error("Restore requires explicit --yes; use --verify-only to inspect first");
    const restored = await restoreTeamBackup(input, teamDir, { replace: args.includes("--replace") });
    console.log(`${GREEN}✔${RESET} restored ${restored.manifest.totals.files} files to ${teamDir}`);
    if (restored.previous) console.log(`${YELLOW}Previous workspace retained at:${RESET} ${restored.previous}`);
    return 0;
  }

  if (mode === "recovery" || mode === "dlq") {
    const distributed = await distributedRuntimeFromEnv();
    if (!distributed) throw new Error(`${mode} requires the distributed PostgreSQL, S3/MinIO, and NATS environment variables`);
    try {
      if (mode === "dlq") {
        if (args[0] !== "redrive") throw new Error("Usage: dry-run team dlq redrive [--limit 100]");
        const result = await distributed.queue.redriveDeadLetters(parseInteger(optionValue(args, "--limit") ?? "100", "--limit", 1));
        console.log(`${GREEN}✔${RESET} dead letters redriven · ${result.redriven} redriven · ${result.invalid} invalid`);
        return result.invalid ? 1 : 0;
      }
      const secret = process.env.DRYRUN_STATE_ENCRYPTION_KEY;
      if (!secret) throw new Error("Distributed recovery requires DRYRUN_STATE_ENCRYPTION_KEY");
      const manager = new DistributedRecoveryManager(distributed, secret);
      const operation = args[0];
      if (operation === "list") { console.log(JSON.stringify(await manager.list(), null, 2)); return 0; }
      const label = requiredValue(optionValue(args, "--label"), "--label");
      if (operation === "create") { console.log(JSON.stringify(await manager.create(label), null, 2)); return 0; }
      if (operation === "verify") { console.log(JSON.stringify(await manager.verify(label), null, 2)); return 0; }
      if (operation === "restore") {
        if (!args.includes("--yes")) throw new Error("Distributed restore requires explicit --yes");
        console.log(JSON.stringify(await manager.restore(label, { replace: args.includes("--replace") }), null, 2));
        return 0;
      }
      throw new Error("Usage: dry-run team recovery create|list|verify|restore [--label NAME] [--yes] [--replace]");
    } finally { await distributed.close(); }
  }

  if (mode === "diagnostics") {
    const endpoint = optionValue(args, "--endpoint");
    if (endpoint) {
      const token = process.env.DRYRUN_TEAM_TOKEN;
      if (!token) throw new Error("Remote diagnostics requires DRYRUN_TEAM_TOKEN");
      const response = await fetch(new URL("/api/v1/setup/diagnostics", requiredValue(endpoint, "--endpoint")), { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
      const result = await response.json() as any;
      console.log(JSON.stringify(result, null, 2));
      return response.ok && result.ready !== false ? 0 : 1;
    }
    const distributed = await distributedRuntimeFromEnv();
    try {
      let state;
      if (distributed) {
        const secret = process.env.DRYRUN_STATE_ENCRYPTION_KEY;
        if (!secret) throw new Error("Distributed diagnostics requires DRYRUN_STATE_ENCRYPTION_KEY");
        state = await DistributedWorkspaceState.open(distributed, teamDir, { alias: process.env.DRYRUN_WORKSPACE_ALIAS ?? "default", encryptionSecret: secret });
      }
      const workspace = new TeamWorkspace(teamDir);
      const health = distributed ? await distributed.health() : undefined;
      const report = { ready: health?.ok ?? true, mode: state ? "stateless-distributed" : "local", workspace: { id: workspace.config().id, projects: workspace.config().projects.length }, ...(health ? { distributed: health, schemaVersion: await distributed!.control.schemaVersion() } : {}), ...(state ? { state: state.status() } : {}), costs: { requiredHostedServices: 0 } };
      console.log(JSON.stringify(report, null, 2));
      return report.ready ? 0 : 1;
    } finally { await distributed?.close(); }
  }

  const workspace = new TeamWorkspace(teamDir);
  const { token, principal } = teamPrincipal(workspace);
  if (mode === "invite") {
    const [operation] = args;
    workspace.authorize(token, "manage-members");
    if (operation === "list") {
      console.log(JSON.stringify(workspace.listInvitations(principal), null, 2));
      return 0;
    }
    if (operation === "create") {
      const role = memberRole(optionValue(args, "--role") ?? "viewer");
      const projectIds = optionValue(args, "--projects")?.split(",").map((value) => workspace.project(value.trim()).project.id);
      const issued = await workspace.createInvitation(
        principal,
        requiredValue(optionValue(args, "--email"), "--email"),
        role,
        projectIds,
        parseInteger(optionValue(args, "--expires-days") ?? "7", "--expires-days", 1),
      );
      console.log(`${GREEN}✔${RESET} invitation ${issued.invitation.id} · ${issued.invitation.email} (${issued.invitation.role})`);
      console.log(`${YELLOW}Invitation token — shown once:${RESET}\n${issued.token}`);
      return 0;
    }
    if (operation === "revoke" && args[1]) {
      await workspace.revokeInvitation(principal, args[1]);
      console.log(`${GREEN}✔${RESET} revoked invitation ${args[1]}`);
      return 0;
    }
  }
  if (mode === "member") {
    const [operation] = args;
    workspace.authorize(token, "manage-members");
    if (operation === "list") {
      console.log(JSON.stringify(workspace.listMembers(principal), null, 2));
      return 0;
    }
    if (operation === "update" && args[1]) {
      const rawProjects = optionValue(args, "--projects");
      const rawStatus = optionValue(args, "--status");
      if (rawStatus && !["active", "suspended"].includes(rawStatus)) throw new Error("--status must be active or suspended");
      const member = await workspace.updateMember(principal, args[1], {
        ...(optionValue(args, "--name") ? { name: optionValue(args, "--name") } : {}),
        ...(optionValue(args, "--role") ? { role: memberRole(optionValue(args, "--role")!) } : {}),
        ...(rawProjects === undefined ? {} : { projectIds: rawProjects === "all" ? null : rawProjects.split(",").map((value) => workspace.project(value.trim()).project.id) }),
        ...(rawStatus ? { status: rawStatus as "active" | "suspended" } : {}),
      });
      console.log(`${GREEN}✔${RESET} ${member.name} · ${member.role} · ${member.status}`);
      return 0;
    }
  }
  if (mode === "key") {
    const [operation] = args;
    if (operation === "list") {
      workspace.authorize(token, "manage-keys");
      console.log(JSON.stringify(workspace.listKeys(principal), null, 2));
      return 0;
    }
    if (operation === "create") {
      workspace.authorize(token, "manage-keys");
      const role = (optionValue(args, "--role") ?? "viewer") as TeamRole;
      const projectIds = optionValue(args, "--projects")?.split(",").map((value) => workspace.project(value.trim()).project.id);
      const issued = await workspace.createKey(principal, optionValue(args, "--name") ?? role, role, projectIds);
      console.log(`${GREEN}✔${RESET} key ${issued.key.id} (${issued.key.role})`);
      console.log(`${YELLOW}Token — shown once:${RESET}\n${issued.token}`);
      return 0;
    }
    if (operation === "revoke" && args[1]) {
      workspace.authorize(token, "manage-keys");
      await workspace.revokeKey(principal, args[1]);
      console.log(`${GREEN}✔${RESET} revoked ${args[1]}`);
      return 0;
    }
  }
  if (mode === "project") {
    const [operation] = args;
    if (operation === "list") {
      workspace.authorize(token, "read");
      console.log(JSON.stringify(workspace.listProjects(principal), null, 2));
      return 0;
    }
    if (operation === "create") {
      workspace.authorize(token, "manage-projects");
      const project = await workspace.createProject(principal, optionValue(args, "--name") ?? requiredValue(args[1], "project name"));
      console.log(`${GREEN}✔${RESET} ${project.name} · ${project.id}`);
      return 0;
    }
  }
  if (mode === "queue") {
    const [operation] = args;
    const project = workspace.project(optionValue(args, "--project") ?? "default");
    if (operation === "list") {
      workspace.authorize(token, "read", project.project.id);
      console.log(JSON.stringify(project.annotations.listQueues(), null, 2));
      return 0;
    }
    workspace.authorize(token, "annotate", project.project.id);
    if (operation === "create") {
      const queue = await project.annotations.createQueue(optionValue(args, "--name") ?? requiredValue(args[1], "queue name"), optionValue(args, "--description"));
      await workspace.audit(principal, "annotation-queue.create", { projectId: project.project.id, target: queue.id });
      console.log(`${GREEN}✔${RESET} ${queue.name} · ${queue.id}`);
      return 0;
    }
    if (operation === "enqueue") {
      const queueId = optionValue(args, "--queue") ?? requiredValue(args[1], "queue id");
      const item = await project.annotations.enqueue(queueId, {
        type: (optionValue(args, "--target-type") ?? "trace") as any,
        id: requiredValue(optionValue(args, "--target"), "--target"),
        ...(optionValue(args, "--sub-id") ? { subId: optionValue(args, "--sub-id") } : {}),
      }, {
        ...(optionValue(args, "--priority") ? { priority: Number(optionValue(args, "--priority")) } : {}),
        ...(optionValue(args, "--labels") ? { labels: optionValue(args, "--labels")!.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
      });
      await workspace.audit(principal, "annotation.enqueue", { projectId: project.project.id, target: item.id });
      console.log(`${GREEN}✔${RESET} ${item.id}`);
      return 0;
    }
    if (operation === "complete") {
      const itemId = requiredValue(args[1], "annotation id");
      const item = await project.annotations.complete(itemId, {
        ...(optionValue(args, "--score") ? { score: Number(optionValue(args, "--score")) } : {}),
        ...(optionValue(args, "--label") ? { label: optionValue(args, "--label") } : {}),
        ...(optionValue(args, "--comment") ? { comment: optionValue(args, "--comment") } : {}),
        ...(args.includes("--skip") ? { status: "skipped" } : {}),
      }, optionValue(args, "--revision") ? parseInteger(optionValue(args, "--revision"), "--revision", 1) : undefined);
      await workspace.audit(principal, "annotation.complete", { projectId: project.project.id, target: item.id });
      console.log(`${GREEN}✔${RESET} ${item.id} · ${item.status}`);
      return 0;
    }
  }
  if (mode === "retention") {
    const [operation] = args;
    if (operation === "show") {
      const projectName = optionValue(args, "--project");
      if (projectName) {
        const project = workspace.project(projectName).project;
        workspace.authorize(token, "manage-retention", project.id);
        const configured = workspace.config().projects.find((candidate) => candidate.id === project.id)?.retention;
        console.log(JSON.stringify({ retention: configured ?? workspace.config().retention, inherited: configured == null }, null, 2));
      } else {
        workspace.authorize(token, "manage-retention");
        console.log(JSON.stringify(workspace.config().retention, null, 2));
      }
      return 0;
    }
    if (operation === "configure") {
      const days = parseInteger(optionValue(args, "--days"), "--days", 1);
      const projectName = optionValue(args, "--project");
      if (projectName) {
        const project = workspace.project(projectName).project;
        workspace.authorize(token, "manage-retention", project.id);
        const current = workspace.config().projects.find((candidate) => candidate.id === project.id)?.retention ?? workspace.config().retention;
        const enabled = args.includes("--enable") ? true : args.includes("--disable") ? false : current.enabled;
        console.log(JSON.stringify(await workspace.setProjectRetention(principal, project.id, enabled, days), null, 2));
      } else {
        workspace.authorize(token, "manage-retention");
        const enabled = args.includes("--enable") ? true : args.includes("--disable") ? false : workspace.config().retention.enabled;
        console.log(JSON.stringify(await workspace.setRetention(principal, enabled, days), null, 2));
      }
      return 0;
    }
    if (operation === "plan" || operation === "apply") {
      const project = workspace.project(optionValue(args, "--project") ?? "default");
      workspace.authorize(token, "manage-retention", project.project.id);
      if (operation === "apply" && !args.includes("--yes")) throw new Error("Retention deletion requires explicit --yes; run retention plan first");
      const plan = await workspace.applyRetention(principal, project.project.id, {
        ...(optionValue(args, "--days") ? { olderThanDays: parseInteger(optionValue(args, "--days"), "--days", 1) } : {}),
        dryRun: operation === "plan",
      });
      console.log(JSON.stringify({ projectId: plan.projectId, cutoff: plan.cutoff, total: plan.total, traces: plan.traces.length, experiments: plan.experiments.length, completedAnnotations: plan.completedAnnotations.length, qualityMonitorResults: plan.qualityMonitorResults.length, applied: operation === "apply" }, null, 2));
      return 0;
    }
  }
  if (mode === "push") {
    const endpoint = requiredValue(optionValue(args, "--endpoint"), "--endpoint");
    const project = optionValue(args, "--project") ?? "default";
    const client = new RemoteTeamClient({ endpoint, project, token, allowInsecureHttp: args.includes("--allow-insecure-http") });
    const sendTraces = args.includes("--traces") || !args.includes("--experiments");
    const sendExperiments = args.includes("--experiments") || !args.includes("--traces");
    let traceCount = 0;
    let experimentCount = 0;
    if (sendTraces) {
      const traces = new TraceStore().list();
      for (let index = 0; index < traces.length; index += 500) traceCount += (await client.uploadTraces(traces.slice(index, index + 500))).accepted;
    }
    if (sendExperiments) {
      const experiments = new ExperimentStore().list();
      for (let index = 0; index < experiments.length; index += 100) experimentCount += (await client.uploadExperiments(experiments.slice(index, index + 100))).accepted;
    }
    console.log(`${GREEN}✔${RESET} uploaded ${traceCount} trace(s), ${experimentCount} experiment(s)`);
    return 0;
  }
  console.error("Usage: dry-run team init|serve|join|invite|member|key|project|queue|retention|backup|restore|recovery|dlq|diagnostics|push [options]\nAdmin commands read DRYRUN_TEAM_TOKEN from the environment.");
  return 1;
}

function teamPrincipal(workspace: TeamWorkspace): { token: string; principal: TeamPrincipal } {
  const token = process.env.DRYRUN_TEAM_TOKEN ?? "";
  if (!token) throw new Error("DRYRUN_TEAM_TOKEN is required for this team command");
  const principal = workspace.authenticate(token);
  if (!principal) throw new Error("DRYRUN_TEAM_TOKEN is invalid or revoked");
  return { token, principal };
}

function memberRole(value: string): Exclude<TeamRole, "ingest"> {
  if (!["admin", "editor", "viewer"].includes(value)) throw new Error("member role must be admin, editor, or viewer");
  return value as Exclude<TeamRole, "ingest">;
}

function oidcOptionsFromEnv(args: string[]): OidcOptions | undefined {
  const issuer = process.env.DRYRUN_OIDC_ISSUER;
  if (!issuer) return undefined;
  const clientId = requiredValue(process.env.DRYRUN_OIDC_CLIENT_ID, "DRYRUN_OIDC_CLIENT_ID");
  const redirectUri = requiredValue(process.env.DRYRUN_OIDC_REDIRECT_URI, "DRYRUN_OIDC_REDIRECT_URI");
  const cookieSecret = requiredValue(process.env.DRYRUN_OIDC_COOKIE_SECRET, "DRYRUN_OIDC_COOKIE_SECRET");
  let roleMappings: OidcRoleMapping[] | undefined;
  if (process.env.DRYRUN_OIDC_ROLE_MAPPINGS) {
    const parsed = JSON.parse(process.env.DRYRUN_OIDC_ROLE_MAPPINGS);
    if (!Array.isArray(parsed)) throw new Error("DRYRUN_OIDC_ROLE_MAPPINGS must be a JSON array");
    roleMappings = parsed as OidcRoleMapping[];
  }
  return {
    issuer,
    clientId,
    redirectUri,
    cookieSecret,
    ...(process.env.DRYRUN_OIDC_CLIENT_SECRET ? { clientSecret: process.env.DRYRUN_OIDC_CLIENT_SECRET } : {}),
    ...(process.env.DRYRUN_OIDC_ALLOWED_DOMAINS ? { allowedEmailDomains: process.env.DRYRUN_OIDC_ALLOWED_DOMAINS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) } : {}),
    ...(process.env.DRYRUN_OIDC_GROUPS_CLAIM ? { groupsClaim: process.env.DRYRUN_OIDC_GROUPS_CLAIM } : {}),
    ...(roleMappings ? { roleMappings } : {}),
    ...(process.env.DRYRUN_OIDC_DEFAULT_ROLE ? { defaultRole: memberRole(process.env.DRYRUN_OIDC_DEFAULT_ROLE) } : {}),
    sessionDays: process.env.DRYRUN_OIDC_SESSION_DAYS ? parseInteger(process.env.DRYRUN_OIDC_SESSION_DAYS, "DRYRUN_OIDC_SESSION_DAYS", 1) : 1,
    ...(process.env.DRYRUN_OIDC_TIMEOUT_MS ? { timeoutMs: parseInteger(process.env.DRYRUN_OIDC_TIMEOUT_MS, "DRYRUN_OIDC_TIMEOUT_MS", 100) } : {}),
    secureCookies: !args.includes("--oidc-insecure-cookies"),
    allowInsecureIssuer: args.includes("--oidc-allow-insecure"),
  };
}

function scimOptionsFromEnv(): ScimOptions | undefined {
  const token = process.env.DRYRUN_SCIM_TOKEN;
  if (!token) return undefined;
  return {
    token,
    ...(process.env.DRYRUN_SCIM_ISSUER ? { issuer: process.env.DRYRUN_SCIM_ISSUER } : {}),
    ...(process.env.DRYRUN_SCIM_BASE_URL ? { baseUrl: process.env.DRYRUN_SCIM_BASE_URL } : {}),
    ...(process.env.DRYRUN_SCIM_DEFAULT_ROLE ? { defaultRole: memberRole(process.env.DRYRUN_SCIM_DEFAULT_ROLE) } : {}),
    ...(process.env.DRYRUN_SCIM_DEFAULT_PROJECTS ? { defaultProjectIds: process.env.DRYRUN_SCIM_DEFAULT_PROJECTS.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
  };
}

function clickHouseAnalyticsFromEnv(args: string[]): ClickHouseAnalyticsStore | undefined {
  const endpoint = process.env.DRYRUN_CLICKHOUSE_URL;
  if (!endpoint) return undefined;
  return new ClickHouseAnalyticsStore({
    endpoint,
    ...(process.env.DRYRUN_CLICKHOUSE_DATABASE ? { database: process.env.DRYRUN_CLICKHOUSE_DATABASE } : {}),
    ...(process.env.DRYRUN_CLICKHOUSE_TABLE_PREFIX ? { tablePrefix: process.env.DRYRUN_CLICKHOUSE_TABLE_PREFIX } : {}),
    ...(process.env.DRYRUN_CLICKHOUSE_USER ? { username: process.env.DRYRUN_CLICKHOUSE_USER } : {}),
    ...(process.env.DRYRUN_CLICKHOUSE_PASSWORD ? { password: process.env.DRYRUN_CLICKHOUSE_PASSWORD } : {}),
    createSchema: process.env.DRYRUN_CLICKHOUSE_CREATE_SCHEMA !== "false",
    allowInsecureHttp: args.includes("--clickhouse-allow-insecure-http"),
  });
}

async function cmdPrompts(argv: string[]): Promise<number> {
  const [mode, ...args] = argv;
  const registry = new PromptRegistry();
  if (mode === "list") {
    const prompts = registry.list();
    if (!prompts.length) {
      console.log(`${DIM}No prompts. Run \`dry-run prompts publish <name> <template-file>\` first.${RESET}`);
      return 0;
    }
    console.log(`${BOLD}VERSIONS  LATEST  LABELS                 NAME${RESET}`);
    for (const prompt of prompts) {
      const labels = Object.entries(prompt.labels).map(([label, version]) => `${label}@${version}`).join(", ");
      console.log(`${String(prompt.versions.length).padStart(8)}  ${String(prompt.labels.latest ?? "-").padStart(6)}  ${labels.padEnd(21)}  ${prompt.name}`);
    }
    return 0;
  }
  if (mode === "publish" && args[0] && args[1]) {
    const [name, templateFile] = args;
    const template = await readFile(templateFile, "utf8");
    const version = await registry.publish(name, template, {
      ...(optionValue(args, "--label") ? { label: optionValue(args, "--label") } : {}),
      ...(optionValue(args, "--description") ? { description: optionValue(args, "--description") } : {}),
      ...(optionValue(args, "--tags") ? { tags: optionValue(args, "--tags")!.split(",").map((tag) => tag.trim()).filter(Boolean) } : {}),
    });
    console.log(` ${GREEN}✔${RESET} ${name}@${version.version} ${DIM}${version.checksum}${RESET}`);
    return 0;
  }
  if (mode === "show" && args[0]) {
    const selector = args[1] ? numericOrString(args[1]) : "latest";
    console.log(JSON.stringify(registry.get(args[0], selector), null, 2));
    return 0;
  }
  if (mode === "render" && args[0]) {
    const rawValues = optionValue(args, "--values") ?? "{}";
    const valuesSource = existsSync(rawValues) ? await readFile(rawValues, "utf8") : rawValues;
    const values = JSON.parse(valuesSource);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("--values must be a JSON object or path to a JSON file");
    const selector = numericOrString(optionValue(args, "--version") ?? optionValue(args, "--label") ?? "latest");
    const rendered = registry.render(args[0], values, selector);
    console.log(rendered.text);
    return 0;
  }
  if (mode === "label" && args[0] && args[1] && args[2]) {
    const version = parseInteger(args[1], "version", 1);
    await registry.label(args[0], version, args[2]);
    console.log(` ${GREEN}✔${RESET} ${args[0]}@${version} → ${args[2]}`);
    return 0;
  }
  console.error("Usage: dry-run prompts list | show <name> [version|label] | publish <name> <template-file> [--label LABEL] | render <name> --values JSON [--version N|--label LABEL] | label <name> <version> <label>");
  return 1;
}

function experimentDefinitions(module: Record<string, unknown>): ExperimentDefinition[] {
  const candidate = module.default ?? module.experiment ?? module.experiments;
  return (Array.isArray(candidate) ? candidate : candidate ? [candidate] : []) as ExperimentDefinition[];
}

function printExperiment(document: ExperimentDocument): void {
  const verdict = document.passed ? `${GREEN}${BOLD}PASS${RESET}` : `${RED}${BOLD}FAIL${RESET}`;
  console.log(`\n ${verdict} ${document.name} ${DIM}· ${document.summary.passed}/${document.summary.total} cases · ${formatDuration(document.summary.durationMs)} · ${document.id}${RESET}`);
  for (const score of document.aggregates) {
    console.log(`   ${score.name.padEnd(24)} ${score.mean.toFixed(3)} ${DIM}pass ${(score.passRate * 100).toFixed(1)}% · 95% CI ${score.confidence95.low.toFixed(3)}–${score.confidence95.high.toFixed(3)}${RESET}`);
  }
  console.log("");
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? requiredValue(args[index + 1], option) : undefined;
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) if (args[index] === option) values.push(requiredValue(args[index + 1], option));
  return values;
}

function positionalArgs(args: string[], valueOptions: string[]): string[] {
  const values = new Set(valueOptions);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (values.has(args[index])) { index += 1; continue; }
    if (!args[index].startsWith("-")) positional.push(args[index]);
  }
  return positional;
}

function positiveNumber(value: string | undefined, option: string, allowZero = false): number {
  const parsed = Number(requiredValue(value, option));
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw new Error(`${option} expects ${allowZero ? "a non-negative" : "a positive"} number`);
  return parsed;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function normalizeLocalBaseURL(value: string): string {
  const url = validateLocalEndpoint(value);
  const normalized = trimTrailingSlashes(url.toString());
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith("-")) throw new Error(`${option} expects a value`);
  return value;
}

function numberedOutput(file: string, id: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}-${id}${ext || ".json"}`);
}

function formatSigned(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`; }
function formatDuration(value: number): string { return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(2)}s`; }
function numericOrString(value: string): number | string { return /^\d+$/.test(value) ? Number(value) : value; }

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function runIsolated(): number {
  const args: string[] = [];
  const hardened = process.allowedNodeEnvironmentFlags.has("--allow-net");
  if (hardened) {
    args.push("--permission", "--allow-fs-read=*", "--allow-fs-write=*");
  }
  args.push(...process.argv.slice(1));
  console.error(` dry-run network isolation: ${hardened ? "Node permission boundary + runtime guards" : "runtime guards (upgrade to Node 26+ for permission enforcement)"}`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, DRYRUN_ISOLATED: "1" },
  });
  if (result.error) {
    console.error(` Failed to start isolated runner: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function parseInteger(value: string | undefined, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${flag} expects an integer >= ${minimum}`);
  return parsed;
}

function parseShard(value: string | undefined): { index: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) throw new Error("--shard expects index/total, for example 2/4");
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || total < 1 || index > total) throw new Error("--shard requires 1 <= index <= total");
  return { index, total };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function cmdInit(): Promise<number> {
  const dir = path.join(process.cwd(), "tests");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "smoke.agentest.ts");
  if (existsSync(target)) {
    console.error(` Refusing to overwrite existing ${path.relative(process.cwd(), target)}.`);
    console.error(" Move or remove it explicitly, then run `dry-run init` again.");
    return 1;
  }
  await writeFile(target, TEMPLATE.trimStart());

  console.log("");
  console.log(` ${"✔"} Created ${path.relative(process.cwd(), target)}`);
  console.log("");
  console.log(" Next steps:");
  console.log(`   1. Run it:        ${"npx @muratkomurcu/dry-run run"}`);
  console.log(`   2. Edit the scenario to match your real agent.`);
  console.log("");
  console.log(" The starter uses a MockProvider so it passes offline, instantly.");
  console.log(" Swap in OpenAIProvider (or any LLMProvider) when you are ready.");
  console.log("");
  return 0;
}

const TEMPLATE = `
import { defineAgent, MockProvider, scenario } from "@muratkomurcu/dry-run";

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
