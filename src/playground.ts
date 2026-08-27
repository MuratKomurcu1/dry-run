import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { totalCost, totalTokens } from "./assertions.ts";
import { Dataset, type DatasetCase, type DatasetDocument } from "./dataset.ts";
import type { ExperimentCaseResult, ExperimentDocument, ExperimentStore, ScoreAggregate } from "./experiment.ts";
import type { PromptRegistry, PromptVersion } from "./prompts.ts";
import { containsScorer, evaluateScorer, exactMatchScorer, judgeScorer, type ScoreResult, type Scorer } from "./scorers.ts";
import { atomicWriteJson, currentGitSha, ensurePrivateDirectory, newId, readJsonFile, slug, withFileLock } from "./storage.ts";
import type { ChatResponse, LLMProvider, Trajectory } from "./types.ts";
import { DRY_RUN_VERSION } from "./version.ts";

export interface PlaygroundVariant {
  id: string;
  name: string;
  template: string;
  system?: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface PlaygroundScorerConfig {
  type: "exact" | "contains" | "semantic";
  threshold?: number;
  criteria?: string;
}

export interface PlaygroundDefinition {
  name: string;
  promptName: string;
  endpoint?: string;
  variants: PlaygroundVariant[];
  cases: DatasetCase[];
  scorer: PlaygroundScorerConfig;
  concurrency?: number;
  timeoutMs?: number;
}

export interface PlaygroundCaseResult {
  key: string;
  caseId: string;
  variantId: string;
  input: unknown;
  expected?: unknown;
  output?: string;
  score: ScoreResult;
  passed: boolean;
  durationMs: number;
  tokens?: number;
  costUsd?: number;
  error?: string;
}

export interface PlaygroundVariantSummary {
  variantId: string;
  name: string;
  model: string;
  meanScore: number;
  passRate: number;
  passed: number;
  failed: number;
  durationMs: number;
  tokens: number;
  costUsd: number;
}

export interface PlaygroundRun {
  kind: "dry-run.playground-run";
  version: 1;
  id: string;
  name: string;
  promptName: string;
  endpoint?: string;
  status: "completed" | "failed";
  createdAt: string;
  completedAt: string;
  dataset: DatasetDocument;
  scorer: PlaygroundScorerConfig;
  variants: PlaygroundVariant[];
  results: PlaygroundCaseResult[];
  summaries: PlaygroundVariantSummary[];
  winner?: string;
  provenance: { producer: "@muratkomurcu/dry-run"; version: typeof DRY_RUN_VERSION; gitSha?: string };
}

export type PlaygroundProviderFactory = (variant: PlaygroundVariant, endpoint?: string) => LLMProvider | Promise<LLMProvider>;

export class PlaygroundStore {
  readonly dir: string;
  constructor(dir = path.resolve(".dryrun/playground")) { this.dir = path.resolve(dir); ensurePrivateDirectory(this.dir); }
  file(id: string): string { validateId(id); return path.join(this.dir, `${id}.json`); }
  async save(run: PlaygroundRun): Promise<void> { await withFileLock(this.file(run.id), () => atomicWriteJson(this.file(run.id), validateRun(run))); }
  load(id: string): PlaygroundRun { return validateRun(readJsonFile(this.file(id))); }
  list(): PlaygroundRun[] {
    if (!existsSync(this.dir)) return [];
    const values: PlaygroundRun[] = [];
    for (const file of readdirSync(this.dir).filter((name) => name.endsWith(".json"))) try { values.push(validateRun(readJsonFile(path.join(this.dir, file)))); } catch { /* ignore incomplete runs */ }
    return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export async function runPlayground(
  input: PlaygroundDefinition,
  opts: { provider: PlaygroundProviderFactory; judge?: LLMProvider; store?: PlaygroundStore; persist?: boolean } ,
): Promise<PlaygroundRun> {
  const definition = validateDefinition(input);
  const dataset = Dataset.create(`${definition.name}-dataset`, definition.cases);
  const concurrency = boundedInteger(definition.concurrency ?? 4, 1, 16, "Playground concurrency");
  const timeoutMs = boundedInteger(definition.timeoutMs ?? 30_000, 100, 120_000, "Playground timeout");
  const createdAt = new Date().toISOString();
  const results: PlaygroundCaseResult[] = [];
  const work = definition.variants.flatMap((variant) => dataset.cases.map((item) => ({ variant, item })));
  let cursor = 0;
  const providers = new Map<string, LLMProvider>(await Promise.all(definition.variants.map(async (variant) => [variant.id, await opts.provider(variant, definition.endpoint)] as const)));
  const worker = async () => {
    while (true) {
      const entry = work[cursor++];
      if (!entry) return;
      const provider = providers.get(entry.variant.id)!;
      results.push(await runCase(entry.variant, entry.item, provider, opts.judge, definition.scorer, timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  results.sort((a, b) => a.variantId.localeCompare(b.variantId) || a.caseId.localeCompare(b.caseId));
  const summaries = definition.variants.map((variant) => summarizeVariant(variant, results.filter((result) => result.variantId === variant.id)));
  const winner = [...summaries].sort((a, b) => b.meanScore - a.meanScore || b.passRate - a.passRate || a.costUsd - b.costUsd || a.durationMs - b.durationMs || a.variantId.localeCompare(b.variantId))[0]?.variantId;
  const gitSha = currentGitSha();
  const completedAt = new Date().toISOString();
  const run: PlaygroundRun = {
    kind: "dry-run.playground-run",
    version: 1,
    id: newId(`playground_${slug(definition.name).slice(0, 48)}`),
    name: definition.name,
    promptName: definition.promptName,
    ...(definition.endpoint ? { endpoint: definition.endpoint } : {}),
    status: results.some((result) => result.error) && results.every((result) => result.error) ? "failed" : "completed",
    createdAt,
    completedAt,
    dataset: dataset.document,
    scorer: definition.scorer,
    variants: definition.variants,
    results,
    summaries,
    ...(winner ? { winner } : {}),
    provenance: { producer: "@muratkomurcu/dry-run", version: DRY_RUN_VERSION, ...(gitSha ? { gitSha } : {}) },
  };
  if (opts.persist !== false) await (opts.store ?? new PlaygroundStore()).save(run);
  return run;
}

export async function promotePlaygroundVariant(
  run: PlaygroundRun,
  variantId: string,
  prompts: PromptRegistry,
  experiments: ExperimentStore,
  opts: { label?: string } = {},
): Promise<{ prompt: PromptVersion; experiment: ExperimentDocument }> {
  const variant = run.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error(`Unknown playground variant: ${variantId}`);
  const selected = run.results.filter((result) => result.variantId === variantId);
  if (!selected.length) throw new Error("Playground variant has no results to promote");
  const prompt = await prompts.publish(run.promptName, variant.template, {
    label: opts.label ?? "production",
    description: `Promoted from playground run ${run.id}`,
    tags: ["playground", "production"],
    metadata: { playgroundRunId: run.id, variantId, model: variant.model, system: variant.system, temperature: variant.temperature },
  });
  const now = new Date().toISOString();
  const caseResults: ExperimentCaseResult[] = selected.map((result) => ({
    key: `${result.caseId}#1`,
    caseId: result.caseId,
    trial: 1,
    input: result.input,
    ...(result.expected !== undefined ? { expected: result.expected } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
    scores: [result.score],
    passed: result.passed,
    durationMs: result.durationMs,
    attempts: 1,
    ...(result.tokens != null ? { tokens: result.tokens } : {}),
    ...(result.costUsd != null ? { costUsd: result.costUsd } : {}),
    ...(result.error ? { error: result.error } : {}),
    metadata: { playgroundRunId: run.id, variantId },
  }));
  const summary = run.summaries.find((candidate) => candidate.variantId === variantId)!;
  const aggregate = scoreAggregate(run.scorer.type, caseResults.map((result) => result.scores[0]));
  const experiment: ExperimentDocument = {
    kind: "dry-run.experiment",
    version: 1,
    id: newId(`playground-${slug(run.name)}`),
    name: `${run.name} · ${variant.name}`,
    description: `Immutable experiment promoted from playground run ${run.id}.`,
    status: "completed",
    passed: summary.failed === 0,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    dataset: { name: run.dataset.name, checksum: run.dataset.checksum, cases: run.dataset.cases.length },
    config: { concurrency: 1, trials: 1, retries: 0, timeoutMs: 30_000, scorers: [{ name: run.scorer.type, threshold: run.scorer.threshold ?? 1 }] },
    provenance: {
      producer: { name: "@muratkomurcu/dry-run", version: DRY_RUN_VERSION },
      runtime: { name: "node", version: process.version, platform: process.platform, arch: process.arch },
      ...(run.provenance.gitSha ? { gitSha: run.provenance.gitSha } : {}),
    },
    metadata: { playgroundRunId: run.id, variantId, promptName: run.promptName, promptVersion: prompt.version, promptChecksum: prompt.checksum, model: variant.model },
    tags: ["playground", "promoted"],
    results: caseResults,
    aggregates: [aggregate],
    feedback: [],
    summary: {
      total: caseResults.length,
      passed: summary.passed,
      failed: summary.failed,
      durationMs: summary.durationMs,
      ...(summary.tokens ? { tokens: summary.tokens } : {}),
      ...(summary.costUsd ? { costUsd: summary.costUsd } : {}),
    },
  };
  await experiments.save(experiment);
  return { prompt, experiment };
}

async function runCase(variant: PlaygroundVariant, item: DatasetCase, provider: LLMProvider, judge: LLMProvider | undefined, scorerConfig: PlaygroundScorerConfig, timeoutMs: number): Promise<PlaygroundCaseResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`playground case timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  try {
    const prompt = renderTemplate(variant.template, item.input);
    const response = await provider.chat({
      model: variant.model,
      messages: [...(variant.system ? [{ role: "system" as const, content: variant.system }] : []), { role: "user", content: prompt }],
      ...(variant.temperature != null ? { temperature: variant.temperature } : {}),
      ...(variant.topP != null ? { topP: variant.topP } : {}),
      maxTokens: variant.maxTokens ?? 1_024,
      signal: controller.signal,
    });
    const output = response.text ?? "";
    if (Buffer.byteLength(output, "utf8") > 1024 * 1024) throw new Error("playground output exceeds 1 MiB");
    const trajectory = responseTrajectory(response);
    const durationMs = Math.round(performance.now() - started);
    const scorer = playgroundScorer(scorerConfig, judge ?? provider, variant.model);
    const score = await evaluateScorer(scorer, { case: item, output, trajectory, durationMs, trial: 1, signal: controller.signal });
    const tokens = totalTokens(trajectory);
    const cost = totalCost(trajectory);
    return {
      key: `${variant.id}:${item.id}`,
      caseId: item.id!,
      variantId: variant.id,
      input: item.input,
      ...(item.expected !== undefined ? { expected: item.expected } : {}),
      output,
      score,
      passed: score.passed,
      durationMs,
      ...(tokens != null ? { tokens } : {}),
      ...(cost != null ? { costUsd: cost } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      key: `${variant.id}:${item.id}`,
      caseId: item.id!,
      variantId: variant.id,
      input: item.input,
      ...(item.expected !== undefined ? { expected: item.expected } : {}),
      score: { name: scorerConfig.type, score: 0, threshold: scorerConfig.threshold ?? 1, passed: false, error: message },
      passed: false,
      durationMs: Math.round(performance.now() - started),
      error: message,
    };
  } finally { clearTimeout(timer); }
}

function playgroundScorer(config: PlaygroundScorerConfig, judge: LLMProvider, model: string): Scorer {
  if (config.type === "exact") return exactMatchScorer({ threshold: config.threshold ?? 1 });
  if (config.type === "contains") return containsScorer(undefined, { threshold: config.threshold ?? 1 });
  return judgeScorer({ provider: judge, model, threshold: config.threshold ?? 0.7, criteria: config.criteria ?? "Score factual correctness, relevance, instruction following, and absence of unsupported claims." });
}

function responseTrajectory(response: ChatResponse): Trajectory {
  return { output: response.text ?? "", steps: [{ kind: "llm", response: response.text ?? undefined, usage: response.usage, costUsd: response.costUsd }] };
}

function renderTemplate(template: string, input: unknown): string {
  const values = isRecord(input) ? { ...input, input } : { input };
  return template.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*}}/g, (_match, key: string) => stringify(resolve(values, key)));
}
function resolve(value: Record<string, unknown>, key: string): unknown { return key.split(".").reduce<unknown>((current, part) => isRecord(current) ? current[part] : undefined, value); }
function summarizeVariant(variant: PlaygroundVariant, results: PlaygroundCaseResult[]): PlaygroundVariantSummary {
  const passed = results.filter((result) => result.passed).length;
  return {
    variantId: variant.id,
    name: variant.name,
    model: variant.model,
    meanScore: mean(results.map((result) => result.score.score)),
    passRate: results.length ? passed / results.length : 0,
    passed,
    failed: results.length - passed,
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    tokens: results.reduce((sum, result) => sum + (result.tokens ?? 0), 0),
    costUsd: results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0),
  };
}
function scoreAggregate(name: string, scores: ScoreResult[]): ScoreAggregate {
  const values = scores.map((score) => score.score);
  const average = mean(values);
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) : 0;
  const margin = 1.96 * Math.sqrt(variance / Math.max(1, values.length));
  const passed = scores.filter((score) => score.passed).length;
  return { name, count: scores.length, mean: average, min: Math.min(...values), max: Math.max(...values), passRate: passed / scores.length, passed, failed: scores.length - passed, confidence95: { low: Math.max(0, average - margin), high: Math.min(1, average + margin) } };
}

function validateDefinition(value: PlaygroundDefinition): PlaygroundDefinition {
  if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 128) throw new Error("Playground name must contain 1-128 characters");
  if (typeof value.promptName !== "string" || !value.promptName.trim() || value.promptName.length > 128) throw new Error("Playground promptName must contain 1-128 characters");
  if (!Array.isArray(value.variants) || value.variants.length < 2 || value.variants.length > 6) throw new Error("Playground requires 2-6 variants");
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 100) throw new Error("Playground requires 1-100 cases");
  if (value.variants.length * value.cases.length > 300) throw new Error("Playground matrix cannot exceed 300 generations");
  if (!value.scorer || !["exact", "contains", "semantic"].includes(value.scorer.type)) throw new Error("Playground scorer must be exact, contains, or semantic");
  const ids = new Set<string>();
  for (const variant of value.variants) {
    validateId(variant.id);
    if (ids.has(variant.id)) throw new Error(`Duplicate playground variant id: ${variant.id}`);
    ids.add(variant.id);
    if (!variant.name?.trim() || !variant.template?.trim() || !variant.model?.trim()) throw new Error("Every playground variant requires name, template, and model");
    if (variant.temperature != null && (!Number.isFinite(variant.temperature) || variant.temperature < 0 || variant.temperature > 2)) throw new Error("Playground temperature must be between 0 and 2");
    if (variant.maxTokens != null && (!Number.isInteger(variant.maxTokens) || variant.maxTokens < 1 || variant.maxTokens > 8_192)) throw new Error("Playground maxTokens must be between 1 and 8192");
  }
  Dataset.create(`${value.name}-validation`, value.cases);
  return structuredClone(value);
}
function validateRun(value: unknown): PlaygroundRun { if (!isRecord(value) || value.kind !== "dry-run.playground-run" || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.variants) || !Array.isArray(value.results) || !Array.isArray(value.summaries)) throw new Error("Unsupported playground run"); return value as unknown as PlaygroundRun; }
function validateId(value: string): void { if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) throw new Error("Invalid playground id"); }
function boundedInteger(value: number, min: number, max: number, label: string): number { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`); return value; }
function mean(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function stringify(value: unknown): string { if (value == null) return ""; return typeof value === "string" ? value : JSON.stringify(value); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
