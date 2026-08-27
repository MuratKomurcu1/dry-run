import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { Dataset, type DatasetCase } from "./dataset.ts";
import { redactDeep } from "./cassette.ts";
import { totalCost, totalTokens } from "./assertions.ts";
import { evaluateScorer, type Scorer, type ScoreResult } from "./scorers.ts";
import type { Trajectory } from "./types.ts";
import { Tracer, TraceStore } from "./tracing.ts";
import { DRY_RUN_VERSION } from "./version.ts";
import {
  atomicWriteJson,
  currentGitSha,
  ensurePrivateDirectory,
  newId,
  readJsonFile,
  slug,
  withFileLock,
} from "./storage.ts";

export interface ExperimentTaskContext {
  signal: AbortSignal;
  trial: number;
  caseId: string;
}

export interface ExperimentTaskEnvelope<Output = unknown> {
  output: Output;
  trajectory?: Trajectory;
  metadata?: Record<string, unknown>;
}

export type ExperimentTaskResult<Output = unknown> = Output | Trajectory | ExperimentTaskEnvelope<Output>;
export type ExperimentTask<Input = unknown, Output = unknown> = (
  input: Input,
  context: ExperimentTaskContext,
) => ExperimentTaskResult<Output> | Promise<ExperimentTaskResult<Output>>;

export interface ExperimentDefinition<Input = unknown, Expected = unknown, Output = unknown> {
  name: string;
  dataset: Dataset<Input, Expected>;
  task: ExperimentTask<Input, Output>;
  scorers: Scorer<Input, Expected, Output>[];
  description?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface ExperimentRunOptions {
  concurrency?: number;
  trials?: number;
  retries?: number;
  timeoutMs?: number;
  store?: ExperimentStore;
  persist?: boolean;
  resumeId?: string;
  signal?: AbortSignal;
  onResult?: (result: ExperimentCaseResult) => void;
  trace?: boolean;
  tracer?: Tracer;
}

export interface ExperimentCaseResult {
  key: string;
  caseId: string;
  name?: string;
  trial: number;
  input: unknown;
  expected?: unknown;
  output?: unknown;
  trajectory?: Trajectory;
  metadata?: Record<string, unknown>;
  tags?: string[];
  scores: ScoreResult[];
  passed: boolean;
  durationMs: number;
  attempts: number;
  tokens?: number;
  costUsd?: number;
  error?: string;
}

export interface ScoreAggregate {
  name: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  passRate: number;
  passed: number;
  failed: number;
  confidence95: { low: number; high: number };
}

export interface ExperimentFeedback {
  id: string;
  caseKey: string;
  source: "human" | "code" | "external";
  score?: number;
  label?: string;
  comment?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ExperimentDocument {
  kind: "dry-run.experiment";
  version: 1;
  id: string;
  name: string;
  description?: string;
  status: "running" | "completed" | "aborted";
  passed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  dataset: { name: string; checksum: string; cases: number };
  config: {
    concurrency: number;
    trials: number;
    retries: number;
    timeoutMs: number;
    scorers?: Array<{ name: string; threshold: number }>;
  };
  provenance: {
    producer: { name: "@muratkomurcu/dry-run"; version: string };
    runtime: { name: "node"; version: string; platform: NodeJS.Platform; arch: string };
    gitSha?: string;
  };
  metadata?: Record<string, unknown>;
  tags?: string[];
  results: ExperimentCaseResult[];
  aggregates: ScoreAggregate[];
  feedback: ExperimentFeedback[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    durationMs: number;
    tokens?: number;
    costUsd?: number;
  };
}

export interface ExperimentComparison {
  baseline: { id: string; name: string };
  candidate: { id: string; name: string };
  scoreDeltas: Array<{ name: string; baseline: number; candidate: number; delta: number; passRateDelta: number }>;
  regressions: Array<{ caseId: string; trial: number; reason: string }>;
  improvements: Array<{ caseId: string; trial: number; reason: string }>;
  added: string[];
  removed: string[];
}

export interface ExperimentPage {
  items: ExperimentDocument[];
  limit: number;
  scanned: number;
  hasMore: boolean;
  nextCursor?: string;
}

export class ExperimentStore {
  readonly dir: string;

  constructor(dir = path.resolve(".dryrun/experiments")) {
    this.dir = dir;
    ensurePrivateDirectory(this.dir);
  }

  file(id: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("Invalid experiment id");
    return path.join(this.dir, `${id}.json`);
  }

  async save(document: ExperimentDocument): Promise<void> {
    const file = this.file(document.id);
    document.updatedAt = new Date().toISOString();
    await withFileLock(file, () => atomicWriteJson(file, redactDeep(document, true)));
  }

  load(id: string): ExperimentDocument {
    const value = readJsonFile(this.file(id));
    return validateExperiment(value);
  }

  list(): ExperimentDocument[] {
    if (!existsSync(this.dir)) return [];
    const documents: ExperimentDocument[] = [];
    for (const file of readdirSync(this.dir).filter((name) => name.endsWith(".json"))) {
      try { documents.push(validateExperiment(readJsonFile(path.join(this.dir, file)))); }
      catch { /* A partial or unrelated file is not an experiment. */ }
    }
    return documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  page(opts: { limit?: number; cursor?: string } = {}): ExperimentPage {
    const limit = boundedPageInteger(opts.limit ?? 100, 1, 500, "Experiment page limit");
    const names = existsSync(this.dir) ? readdirSync(this.dir).filter((name) => name.endsWith(".json")).sort() : [];
    const after = decodePageCursor(opts.cursor, "Experiment");
    let index = after ? names.findIndex((name) => name > after) : 0;
    if (index < 0) index = names.length;
    const items: ExperimentDocument[] = [];
    let scanned = 0;
    let lastScanned: string | undefined;
    while (index < names.length && scanned < limit && items.length < limit) {
      const name = names[index++];
      lastScanned = name;
      scanned += 1;
      try { items.push(validateExperiment(readJsonFile(path.join(this.dir, name)))); }
      catch { /* Invalid files still advance the cursor. */ }
    }
    return {
      items,
      limit,
      scanned,
      hasMore: index < names.length,
      ...(lastScanned && index < names.length ? { nextCursor: Buffer.from(lastScanned, "utf8").toString("base64url") } : {}),
    };
  }

  async addFeedback(id: string, feedback: Omit<ExperimentFeedback, "id" | "createdAt">): Promise<ExperimentFeedback> {
    const file = this.file(id);
    return withFileLock(file, () => {
      const document = this.load(id);
      if (!document.results.some((result) => result.key === feedback.caseKey)) throw new Error(`Unknown experiment case key: ${feedback.caseKey}`);
      if (feedback.score != null && (!Number.isFinite(feedback.score) || feedback.score < 0 || feedback.score > 1)) {
        throw new Error("Feedback score must be between 0 and 1");
      }
      const record: ExperimentFeedback = { ...feedback, id: newId("feedback"), createdAt: new Date().toISOString() };
      document.feedback.push(record);
      document.updatedAt = new Date().toISOString();
      atomicWriteJson(file, redactDeep(document, true));
      return record;
    });
  }
}

function decodePageCursor(cursor: string | undefined, label: string): string | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 512) throw new Error(`${label} cursor is invalid`);
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[a-zA-Z0-9_.-]+\.json$/.test(value)) throw new Error(`${label} cursor is invalid`);
  return value;
}

function boundedPageInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

export async function runExperiment<Input = unknown, Expected = unknown, Output = unknown>(
  definition: ExperimentDefinition<Input, Expected, Output>,
  opts: ExperimentRunOptions = {},
): Promise<ExperimentDocument> {
  validateDefinition(definition);
  const store = opts.store ?? new ExperimentStore();
  const resumed = opts.resumeId ? store.load(opts.resumeId) : undefined;
  const concurrency = positiveInteger(opts.concurrency ?? resumed?.config.concurrency ?? 4, "concurrency");
  const trials = positiveInteger(opts.trials ?? resumed?.config.trials ?? 1, "trials");
  const retries = nonNegativeInteger(opts.retries ?? resumed?.config.retries ?? 0, "retries");
  const timeoutMs = positiveInteger(opts.timeoutMs ?? resumed?.config.timeoutMs ?? 30_000, "timeoutMs");
  const shouldPersist = opts.persist ?? true;
  const tracer = opts.tracer ?? (opts.trace === false || !shouldPersist ? undefined : new Tracer([new TraceStore()]));
  const started = performance.now();
  const now = new Date().toISOString();

  let document: ExperimentDocument;
  if (resumed) {
    document = resumed;
    if (document.dataset.checksum !== definition.dataset.checksum) throw new Error("Cannot resume: dataset checksum changed");
    if (document.name !== definition.name) throw new Error("Cannot resume: experiment name changed");
    if (document.config.scorers && JSON.stringify(document.config.scorers) !== JSON.stringify(scorerConfiguration(definition.scorers))) {
      throw new Error("Cannot resume: scorer configuration changed");
    }
    document.status = "running";
  } else {
    const gitSha = currentGitSha();
    document = {
      kind: "dry-run.experiment",
      version: 1,
      id: newId(slug(definition.name)),
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      status: "running",
      passed: false,
      createdAt: now,
      updatedAt: now,
      dataset: { name: definition.dataset.name, checksum: definition.dataset.checksum, cases: definition.dataset.cases.length },
      config: { concurrency, trials, retries, timeoutMs, scorers: scorerConfiguration(definition.scorers) },
      provenance: {
        producer: { name: "@muratkomurcu/dry-run", version: DRY_RUN_VERSION },
        runtime: { name: "node", version: process.version, platform: process.platform, arch: process.arch },
        ...(gitSha ? { gitSha } : {}),
      },
      ...(definition.metadata ? { metadata: safeData(definition.metadata) as Record<string, unknown> } : {}),
      ...(definition.tags ? { tags: [...definition.tags] } : {}),
      results: [],
      aggregates: [],
      feedback: [],
      summary: { total: definition.dataset.cases.length * trials, passed: 0, failed: 0, durationMs: 0 },
    };
  }

  if (shouldPersist) await store.save(document);
  const completed = new Set(document.results.map((result) => result.key));
  const work = definition.dataset.cases.flatMap((item) => Array.from({ length: trials }, (_unused, index) => ({ item, trial: index + 1 })))
    .filter(({ item, trial }) => !completed.has(caseKey(item.id!, trial)));
  let cursor = 0;
  let persistChain: Promise<void> = Promise.resolve();

  const persist = () => {
    if (!shouldPersist) return;
    persistChain = persistChain.then(() => store.save(document));
  };

  const worker = async () => {
    while (true) {
      opts.signal?.throwIfAborted();
      const index = cursor++;
      const entry = work[index];
      if (!entry) return;
      const runCase = () => runExperimentCase(entry.item, entry.trial, definition, { retries, timeoutMs, signal: opts.signal, tracer });
      const result = tracer
        ? await tracer.withSpan(`${definition.name}/${entry.item.name ?? entry.item.id}`, {
            type: "task",
            input: entry.item.input,
            traceName: `${definition.name}: ${entry.item.name ?? entry.item.id}`,
            traceMetadata: { experimentId: document.id, caseId: entry.item.id, trial: entry.trial },
            tags: [...new Set(["experiment", ...(definition.tags ?? []), ...(entry.item.tags ?? [])])],
          }, async (span) => {
            const caseResult = await runCase();
            span.setAttribute("dryrun.experiment.id", document.id);
            span.setAttribute("dryrun.case.id", caseResult.caseId);
            span.setMetric("dryrun.score.pass", caseResult.passed ? 1 : 0);
            if (caseResult.tokens != null) span.setMetric("gen_ai.usage.total_tokens", caseResult.tokens);
            if (caseResult.costUsd != null) span.setMetric("gen_ai.usage.cost", caseResult.costUsd);
            return caseResult;
          })
        : await runCase();
      const previous = document.results.findIndex((item) => item.key === result.key);
      if (previous >= 0) document.results[previous] = result;
      else document.results.push(result);
      document.results.sort(compareCaseResult);
      refreshSummary(document, Math.round(performance.now() - started));
      opts.onResult?.(result);
      persist();
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, work.length)) }, worker));
    await persistChain;
    document.status = "completed";
    document.completedAt = new Date().toISOString();
    refreshSummary(document, Math.round(performance.now() - started));
    document.passed = document.summary.failed === 0 && document.summary.total === definition.dataset.cases.length * trials;
  } catch (error) {
    document.status = "aborted";
    refreshSummary(document, Math.round(performance.now() - started));
    if (shouldPersist) await store.save(document);
    throw error;
  }
  if (shouldPersist) await store.save(document);
  return document;
}

export function compareExperiments(baseline: ExperimentDocument, candidate: ExperimentDocument): ExperimentComparison {
  const baselineScores = new Map(baseline.aggregates.map((score) => [score.name, score]));
  const candidateScores = new Map(candidate.aggregates.map((score) => [score.name, score]));
  const names = [...new Set([...baselineScores.keys(), ...candidateScores.keys()])].sort();
  const scoreDeltas = names.map((name) => {
    const left = baselineScores.get(name);
    const right = candidateScores.get(name);
    return {
      name,
      baseline: left?.mean ?? 0,
      candidate: right?.mean ?? 0,
      delta: (right?.mean ?? 0) - (left?.mean ?? 0),
      passRateDelta: (right?.passRate ?? 0) - (left?.passRate ?? 0),
    };
  });
  const baselineCases = new Map(baseline.results.map((result) => [result.key, result]));
  const candidateCases = new Map(candidate.results.map((result) => [result.key, result]));
  const regressions: ExperimentComparison["regressions"] = [];
  const improvements: ExperimentComparison["improvements"] = [];
  for (const [key, current] of candidateCases) {
    const previous = baselineCases.get(key);
    if (!previous) continue;
    if (previous.passed && !current.passed) regressions.push({ caseId: current.caseId, trial: current.trial, reason: summarizeFailure(current) });
    if (!previous.passed && current.passed) improvements.push({ caseId: current.caseId, trial: current.trial, reason: "case now passes" });
  }
  return {
    baseline: { id: baseline.id, name: baseline.name },
    candidate: { id: candidate.id, name: candidate.name },
    scoreDeltas,
    regressions,
    improvements,
    added: [...candidateCases.keys()].filter((key) => !baselineCases.has(key)),
    removed: [...baselineCases.keys()].filter((key) => !candidateCases.has(key)),
  };
}

async function runExperimentCase<Input, Expected, Output>(
  item: DatasetCase<Input, Expected>,
  trial: number,
  definition: ExperimentDefinition<Input, Expected, Output>,
  opts: { retries: number; timeoutMs: number; signal?: AbortSignal; tracer?: Tracer },
): Promise<ExperimentCaseResult> {
  const started = performance.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
    timer.unref?.();
    try {
      const task = () => definition.task(item.input, { signal: controller.signal, trial, caseId: item.id! });
      const invoke = () => Promise.race([
        Promise.resolve(task()),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("aborted")), { once: true })),
      ]);
      const raw = await (opts.tracer
        ? opts.tracer.withSpan("agent-task", { type: "agent", input: item.input, attributes: { trial, attempt } }, invoke)
        : invoke());
      const normalized = normalizeTaskResult(raw);
      const durationMs = Math.round(performance.now() - started);
      const scoringInput = { case: item, output: normalized.output, trajectory: normalized.trajectory, durationMs, trial, signal: controller.signal };
      const scores = await Promise.all(definition.scorers.map((scorer) => opts.tracer
        ? opts.tracer.withSpan(`score:${scorer.name}`, { type: "scorer", attributes: { threshold: scorer.threshold } }, async (span) => {
            const score = await evaluateScorer(scorer, scoringInput);
            span.setMetric("dryrun.score", score.score);
            span.setMetric("dryrun.score.pass", score.passed ? 1 : 0);
            return score;
          })
        : evaluateScorer(scorer, scoringInput)));
      const tokens = normalized.trajectory ? totalTokens(normalized.trajectory) : null;
      const cost = normalized.trajectory ? totalCost(normalized.trajectory) : null;
      return {
        key: caseKey(item.id!, trial),
        caseId: item.id!,
        ...(item.name ? { name: item.name } : {}),
        trial,
        input: safeData(item.input),
        ...(item.expected !== undefined ? { expected: safeData(item.expected) } : {}),
        output: safeData(normalized.output),
        ...(normalized.trajectory ? { trajectory: safeData(normalized.trajectory) as unknown as Trajectory } : {}),
        ...(normalized.metadata ? { metadata: safeData(normalized.metadata) as Record<string, unknown> } : {}),
        ...(item.tags ? { tags: [...item.tags] } : {}),
        scores,
        passed: scores.every((score) => score.passed),
        durationMs,
        attempts: attempt,
        ...(tokens != null ? { tokens } : {}),
        ...(cost != null ? { costUsd: cost } : {}),
      };
    } catch (error) {
      lastError = error;
      if (attempt === opts.retries + 1) break;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortFromParent);
    }
  }
  return {
    key: caseKey(item.id!, trial),
    caseId: item.id!,
    ...(item.name ? { name: item.name } : {}),
    trial,
    input: safeData(item.input),
    ...(item.expected !== undefined ? { expected: safeData(item.expected) } : {}),
    ...(item.tags ? { tags: [...item.tags] } : {}),
    scores: [],
    passed: false,
    durationMs: Math.round(performance.now() - started),
    attempts: opts.retries + 1,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

function normalizeTaskResult<Output>(value: ExperimentTaskResult<Output>): ExperimentTaskEnvelope<Output> {
  if (isTrajectory(value)) return { output: value.output as unknown as Output, trajectory: value };
  if (isRecord(value) && "output" in value && ("trajectory" in value || "metadata" in value)) {
    const envelope = value as unknown as ExperimentTaskEnvelope<Output>;
    if (envelope.trajectory != null && !isTrajectory(envelope.trajectory)) throw new Error("Task envelope trajectory is invalid");
    return envelope;
  }
  return { output: value as Output };
}

function refreshSummary(document: ExperimentDocument, durationMs: number): void {
  document.aggregates = aggregateScores(document.results);
  const passed = document.results.filter((result) => result.passed).length;
  const tokens = document.results.map((result) => result.tokens).filter((value): value is number => value != null);
  const costs = document.results.map((result) => result.costUsd).filter((value): value is number => value != null);
  document.summary = {
    total: document.results.length,
    passed,
    failed: document.results.length - passed,
    durationMs,
    ...(tokens.length ? { tokens: tokens.reduce((sum, value) => sum + value, 0) } : {}),
    ...(costs.length ? { costUsd: costs.reduce((sum, value) => sum + value, 0) } : {}),
  };
  document.passed = document.status === "completed" && document.summary.failed === 0;
}

function aggregateScores(results: ExperimentCaseResult[]): ScoreAggregate[] {
  const groups = new Map<string, ScoreResult[]>();
  for (const result of results) for (const score of result.scores) groups.set(score.name, [...(groups.get(score.name) ?? []), score]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, scores]) => {
    const values = scores.map((score) => score.score);
    const passed = scores.filter((score) => score.passed).length;
    return {
      name,
      count: values.length,
      mean: mean(values),
      min: Math.min(...values),
      max: Math.max(...values),
      passRate: passed / values.length,
      passed,
      failed: values.length - passed,
      confidence95: meanConfidence95(values),
    };
  });
}

function meanConfidence95(values: number[]): { low: number; high: number } {
  const average = mean(values);
  if (values.length < 2) return { low: average, high: average };
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { low: Math.max(0, average - margin), high: Math.min(1, average + margin) };
}

function validateDefinition<Input, Expected, Output>(definition: ExperimentDefinition<Input, Expected, Output>): void {
  if (!definition.name?.trim()) throw new Error("Experiment name cannot be empty");
  if (!(definition.dataset instanceof Dataset)) throw new Error("Experiment requires a Dataset instance");
  if (typeof definition.task !== "function") throw new Error("Experiment task must be a function");
  if (!Array.isArray(definition.scorers) || definition.scorers.length === 0) throw new Error("Experiment requires at least one scorer");
}

function validateExperiment(value: unknown): ExperimentDocument {
  if (!isRecord(value) || value.kind !== "dry-run.experiment" || value.version !== 1) throw new Error("Unsupported experiment document");
  if (typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.results) || !Array.isArray(value.aggregates)) {
    throw new Error("Experiment document is incomplete");
  }
  return value as unknown as ExperimentDocument;
}

function summarizeFailure(result: ExperimentCaseResult): string {
  return result.error ?? (result.scores.filter((score) => !score.passed).map((score) => `${score.name}: ${score.reason ?? score.error ?? score.score}`).join("; ") || "case failed");
}

function compareCaseResult(a: ExperimentCaseResult, b: ExperimentCaseResult): number {
  return a.caseId.localeCompare(b.caseId) || a.trial - b.trial;
}

function caseKey(id: string, trial: number): string { return `${id}#${trial}`; }
function mean(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function positiveInteger(value: number, label: string): number { if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`); return value; }
function nonNegativeInteger(value: number, label: string): number { if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); return value; }
function scorerConfiguration(scorers: Scorer[]): Array<{ name: string; threshold: number }> {
  return scorers.map((scorer) => ({ name: scorer.name, threshold: scorer.threshold }));
}
function isTrajectory(value: unknown): value is Trajectory { return isRecord(value) && Array.isArray(value.steps) && typeof value.output === "string"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function safeData(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (error) { throw new Error(`Experiment data is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`); }
}
