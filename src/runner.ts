import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describeAssertion, evaluateAssertionAsync, totalCost, totalTokens } from "./assertions.ts";
import { writeJunit } from "./junit.ts";
import type { AssertionResult, LLMProvider, Scenario, ScenarioResult, RunSummary, Trajectory } from "./types.ts";

const EXT = /\.agentest\.(ts|js|mjs)$/;

export async function discoverTestFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) collect(path.resolve(input), files);
  return files.sort();
}

function collect(target: string, out: string[]): void {
  let stat;
  try { stat = statSync(target); }
  catch { throw new Error(`Path not found: ${target}`); }
  if (stat.isFile()) {
    if (EXT.test(target)) out.push(target);
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
      collect(entryPath, out);
    } else if (EXT.test(entry.name)) out.push(entryPath);
  }
}

export async function loadScenarios(file: string, opts: { bust?: boolean } = {}): Promise<Scenario[]> {
  const href = pathToFileURL(file).href;
  const url = opts.bust ? `${href}?bust=${Date.now()}-${Math.random()}` : href;
  const mod = await import(url);
  const scenarios = mod.default ?? mod.scenarios;
  if (!Array.isArray(scenarios)) {
    throw new Error(`${file}: expected a default export of Scenario[] (or named export "scenarios")`);
  }
  return scenarios;
}

export interface RunOptions {
  judge?: LLMProvider;
  junitPath?: string;
  concurrency?: number;
  retries?: number;
  trials?: number;
  allowSkipped?: boolean;
  filter?: string | RegExp;
  tags?: string[];
  excludeTags?: string[];
  shard?: { index: number; total: number };
  onResult?: (result: ScenarioResult) => void;
  onTrajectory?: (scenarioName: string, trajectory: Trajectory, trial: number) => void;
}

interface WorkItem { scenario: Scenario; trial: number }
interface RunOutcome { result: ScenarioResult; trajectory?: Trajectory }

export function selectScenarios(scenarios: Scenario[], opts: Pick<RunOptions, "filter" | "tags" | "excludeTags" | "shard">): Scenario[] {
  let selected = scenarios.filter((scenario) => {
    if (opts.filter) {
      const matches = typeof opts.filter === "string"
        ? scenario.name.toLowerCase().includes(opts.filter.toLowerCase())
        : (opts.filter.lastIndex = 0, opts.filter.test(scenario.name));
      if (!matches) return false;
    }
    const scenarioTags = scenario.tags ?? [];
    if (opts.tags?.length && !opts.tags.every((tag) => scenarioTags.includes(tag))) return false;
    if (opts.excludeTags?.some((tag) => scenarioTags.includes(tag))) return false;
    return true;
  });
  if (opts.shard) {
    const { index, total } = opts.shard;
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
      throw new Error(`Invalid shard ${index}/${total}; expected 1 <= index <= total`);
    }
    selected = selected.filter((_scenario, position) => position % total === index - 1);
  }
  return selected;
}

export async function runScenarios(scenarios: Scenario[], opts: RunOptions = {}): Promise<RunSummary> {
  const start = performance.now();
  const selected = selectScenarios(scenarios, opts);
  const trials = positiveInteger(opts.trials ?? 1, "trials");
  const concurrency = positiveInteger(opts.concurrency ?? 1, "concurrency");
  const work: WorkItem[] = selected.flatMap((scenario) =>
    Array.from({ length: trials }, (_unused, index) => ({ scenario, trial: index + 1 })),
  );
  const results = new Array<ScenarioResult>(work.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      const item = work[index];
      if (!item) return;
      const outcome = await runWithRetries(item, opts);
      results[index] = outcome.result;
      if (outcome.trajectory) opts.onTrajectory?.(item.scenario.name, outcome.trajectory, item.trial);
      opts.onResult?.(outcome.result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));

  const passed = results.filter((result) => result.passed).length;
  const summary: RunSummary = {
    results,
    total: results.length,
    failed: results.length - passed,
    passed,
    durationMs: Math.round(performance.now() - start),
  };
  if (opts.junitPath) writeJunit(summary, opts.junitPath);
  return summary;
}

async function runWithRetries(item: WorkItem, opts: RunOptions): Promise<RunOutcome> {
  const retries = nonNegativeInteger(item.scenario.retries ?? opts.retries ?? 0, "retries");
  let last: RunOutcome | undefined;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    last = await runOne(item.scenario, item.trial, opts);
    last.result.attempts = attempt;
    if (last.result.passed) break;
  }
  return last!;
}

async function runOne(scenario: Scenario, trial: number, opts: RunOptions): Promise<RunOutcome> {
  const start = performance.now();
  const timeoutMs = scenario.timeoutMs ?? 30_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const agentPromise = Promise.resolve().then(() => scenario.agent(scenario.input, { signal: controller.signal, trial }));
    const trajectory = await Promise.race([
      agentPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
    const durationMs = Math.round(performance.now() - start);
    const assertions: AssertionResult[] = [];
    for (const assertion of scenario.expect) {
      assertions.push(assertion.type === "semantic"
        ? await judgeSemantic(assertion.criteria, trajectory.output, scenario.input, opts.judge, controller.signal)
        : await evaluateAssertionAsync(assertion, trajectory, { durationMs }));
    }
    const hasDisallowedSkip = !opts.allowSkipped && assertions.some((result) => result.skipped);
    const result: ScenarioResult = {
      name: scenario.name,
      passed: assertions.every((assertion) => assertion.passed) && !hasDisallowedSkip,
      assertions,
      durationMs,
      tokens: totalTokens(trajectory) ?? undefined,
      costUsd: totalCost(trajectory) ?? undefined,
      trial,
      tags: scenario.tags,
    };
    return { result, trajectory };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        name: scenario.name,
        passed: false,
        assertions: [],
        durationMs: Math.round(performance.now() - start),
        trial,
        tags: scenario.tags,
        error: message.startsWith("timed out after") ? message : `Agent crashed: ${message}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function judgeSemantic(
  criteria: string,
  output: string,
  input: string,
  judge: LLMProvider | undefined,
  signal: AbortSignal,
): Promise<AssertionResult> {
  const label = describeAssertion({ type: "semantic", criteria });
  if (!judge) return { label, passed: false, skipped: true, message: "no judge configured (--judge-model)" };
  const response = await judge.chat({
    model: process.env.DRYRUN_JUDGE_MODEL ?? "",
    signal,
    messages: [
      { role: "system", content: "You are a strict QA judge. Respond with exactly YES or NO followed by a one-line reason." },
      { role: "user", content: `User asked: ${input}\n\nAgent answered: ${output}\n\nCriteria: ${criteria}\n\nDoes the answer satisfy the criteria?` },
    ],
  });
  const verdict = (response.text ?? "").trim().toUpperCase().startsWith("YES");
  return { label, passed: verdict, message: response.text ?? undefined };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
