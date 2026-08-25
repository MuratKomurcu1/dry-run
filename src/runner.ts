import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describeAssertion, evaluateAssertion, totalTokens } from "./assertions.ts";
import { writeJunit } from "./junit.ts";
import type {
  AssertionResult,
  LLMProvider,
  Scenario,
  ScenarioResult,
  RunSummary,
  Trajectory,
} from "./types.ts";

const EXT = /\.agentest\.(ts|js|mjs)$/;

export async function discoverTestFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    collect(path.resolve(input), files);
  }
  return files.sort();
}

function collect(target: string, out: string[]): void {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    throw new Error(`Path not found: ${target}`);
  }
  if (stat.isFile()) {
    if (EXT.test(target)) out.push(target);
    return;
  }
  const entries = readdirSync(target, { withFileTypes: true });
  if (!entries.some((e) => EXT.test(e.name)) && out.length === 0 && entries.length === 0) {
    throw new Error(`No test files found under ${target}`);
  }
  for (const e of entries) {
    const p = path.join(target, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      collect(p, out);
    } else if (EXT.test(e.name)) {
      out.push(p);
    }
  }
}

export async function loadScenarios(
  file: string,
  opts: { bust?: boolean } = {},
): Promise<Scenario[]> {
  const href = pathToFileURL(file).href;
  const url = opts.bust ? `${href}?bust=${Date.now()}-${Math.random()}` : href;
  const mod = await import(url);
  const scenarios = mod.default ?? mod.scenarios;
  if (!Array.isArray(scenarios)) {
    throw new Error(
      `${file}: expected a default export of Scenario[] (or named export "scenarios")`,
    );
  }
  return scenarios;
}

export interface RunOptions {
  judge?: LLMProvider;
  junitPath?: string;
  onResult?: (result: ScenarioResult) => void;
  onTrajectory?: (scenarioName: string, trajectory: Trajectory) => void;
}

export async function runScenarios(
  scenarios: Scenario[],
  opts: RunOptions = {},
): Promise<RunSummary> {
  const start = performance.now();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runOne(scenario, opts));
  }

  const passed = results.filter((r) => r.passed).length;
  const summary: RunSummary = {
    results,
    total: results.length,
    failed: results.length - passed,
    passed,
    durationMs: Math.round(performance.now() - start),
  };

  if (opts.junitPath) {
    writeJunit(summary, opts.junitPath);
  }

  return summary;
}

async function runOne(scenario: Scenario, opts: RunOptions): Promise<ScenarioResult> {
  const start = performance.now();
  const timeoutMs = scenario.timeoutMs ?? 30_000;

  try {
    const trajectory = await withTimeout(scenario.agent(scenario.input), timeoutMs);

    const assertions: AssertionResult[] = [];
    for (const a of scenario.expect) {
      if (a.type === "semantic") {
        assertions.push(
          await judgeSemantic(a.criteria, trajectory.output, scenario.input, opts.judge),
        );
      } else {
        assertions.push(evaluateAssertion(a, trajectory));
      }
    }

    const result: ScenarioResult = {
      name: scenario.name,
      passed: assertions.every((r) => r.passed),
      assertions,
      durationMs: Math.round(performance.now() - start),
      tokens: totalTokens(trajectory) ?? undefined,
    };
    opts.onTrajectory?.(scenario.name, trajectory);
    opts.onResult?.(result);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const result: ScenarioResult = {
      name: scenario.name,
      passed: false,
      assertions: [],
      durationMs: Math.round(performance.now() - start),
      error: message.startsWith("timed out after")
        ? message
        : `Agent crashed: ${message}`,
    };
    opts.onResult?.(result);
    return result;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        timer?.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function judgeSemantic(
  criteria: string,
  output: string,
  input: string,
  judge: LLMProvider | undefined,
): Promise<AssertionResult> {
  const label = describeAssertion({ type: "semantic", criteria });
  if (!judge) {
    return { label, passed: true, skipped: true, message: "no judge configured (--judge-model)" };
  }
  const res = await judge.chat({
    model: process.env.DRYRUN_JUDGE_MODEL ?? "",
    messages: [
      {
        role: "system",
        content:
          "You are a strict QA judge. Given an agent's answer and acceptance criteria, respond with exactly YES or NO followed by a one-line reason.",
      },
      {
        role: "user",
        content: `User asked: ${input}\n\nAgent answered: ${output}\n\nCriteria: ${criteria}\n\nDoes the answer satisfy the criteria?`,
      },
    ],
  });
  const text = (res.text ?? "").trim().toUpperCase();
  const verdict = text.startsWith("YES");
  return { label, passed: verdict, message: res.text ?? undefined };
}
