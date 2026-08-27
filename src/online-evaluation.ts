import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { evaluateAssertion, describeAssertion } from "./assertions.ts";
import { canonicalStringify, redactDeep } from "./cassette.ts";
import type { LLMProvider, Assertion, AssertionResult } from "./types.ts";
import { traceToTrajectory, type TraceDocument, type TraceStore } from "./tracing.ts";
import type { AnnotationItem, AnnotationStore } from "./team.ts";
import { atomicWriteJson, ensurePrivateDirectory, newId, readJsonFile, sha256, withFileLock } from "./storage.ts";

export type OnlineCheck = Exclude<Assertion, { type: "custom" }>;

export interface OnlineRuleFilter {
  traceNameContains?: string;
  tags?: string[];
  status?: "ok" | "error";
  environments?: string[];
  releases?: string[];
  providers?: string[];
  models?: string[];
  sampleRate?: number;
}

export interface OnlineRuleAction {
  queueId?: string;
  queueName?: string;
  priority?: number;
  labels?: string[];
}

export interface OnlineRule {
  kind: "dry-run.online-rule";
  version: 1;
  id: string;
  revision: number;
  name: string;
  description?: string;
  enabled: boolean;
  filter: OnlineRuleFilter;
  checks: OnlineCheck[];
  action?: OnlineRuleAction;
  unavailable: "fail" | "skip";
  createdAt: string;
  updatedAt: string;
}

export interface OnlineEvaluationResult {
  kind: "dry-run.online-result";
  version: 1;
  id: string;
  ruleId: string;
  ruleRevision: number;
  ruleName: string;
  traceId: string;
  traceName: string;
  passed: boolean;
  checks: AssertionResult[];
  evaluatedAt: string;
  durationMs: number;
  annotationItemId?: string;
}

export interface OnlineEvaluationJob {
  kind: "dry-run.online-job";
  version: 1;
  id: string;
  traceId: string;
  state: "pending" | "running" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  leaseUntil?: string;
  nextAttemptAt?: string;
  error?: string;
}

export interface OnlineBatchSummary {
  traces: number;
  matched: number;
  evaluated: number;
  passed: number;
  failed: number;
  cached: number;
  results: OnlineEvaluationResult[];
}

export class OnlineEvaluationStore {
  readonly dir: string;
  readonly rulesDir: string;
  readonly resultsDir: string;
  readonly jobsDir: string;

  constructor(dir = path.resolve(".dryrun/online")) {
    this.dir = path.resolve(dir);
    this.rulesDir = path.join(this.dir, "rules");
    this.resultsDir = path.join(this.dir, "results");
    this.jobsDir = path.join(this.dir, "jobs");
    ensurePrivateDirectory(this.rulesDir);
    ensurePrivateDirectory(this.resultsDir);
    ensurePrivateDirectory(this.jobsDir);
  }

  async create(input: {
    name: string;
    description?: string;
    enabled?: boolean;
    filter?: OnlineRuleFilter;
    checks: OnlineCheck[];
    action?: OnlineRuleAction;
    unavailable?: "fail" | "skip";
  }): Promise<OnlineRule> {
    const now = new Date().toISOString();
    const rule = validateRule({
      kind: "dry-run.online-rule",
      version: 1,
      id: newId("rule"),
      revision: 1,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      enabled: input.enabled ?? true,
      filter: input.filter ?? {},
      checks: input.checks,
      ...(input.action ? { action: input.action } : {}),
      unavailable: input.unavailable ?? "fail",
      createdAt: now,
      updatedAt: now,
    });
    await withFileLock(this.ruleFile(rule.id), () => atomicWriteJson(this.ruleFile(rule.id), rule));
    return structuredClone(rule);
  }

  async update(id: string, patch: Partial<Pick<OnlineRule, "name" | "description" | "enabled" | "filter" | "checks" | "action" | "unavailable">>): Promise<OnlineRule> {
    const file = this.ruleFile(id);
    return withFileLock(file, () => {
      const current = this.loadRule(id);
      const updated = validateRule({
        ...current,
        ...structuredClone(patch),
        id: current.id,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
      atomicWriteJson(file, updated);
      return structuredClone(updated);
    });
  }

  async remove(id: string): Promise<void> {
    const file = this.ruleFile(id);
    await withFileLock(file, () => { if (existsSync(file)) unlinkSync(file); });
  }

  loadRule(id: string): OnlineRule { return validateRule(readJsonFile(this.ruleFile(id))); }
  listRules(): OnlineRule[] { return listDocuments(this.rulesDir, validateRule).sort((a, b) => a.name.localeCompare(b.name)); }
  listResults(opts: { ruleId?: string; traceId?: string; passed?: boolean; limit?: number } = {}): OnlineEvaluationResult[] {
    const limit = boundedInteger(opts.limit ?? 200, 1, 2_000, "Online result limit");
    return listDocuments(this.resultsDir, validateResult)
      .filter((result) => (opts.ruleId == null || result.ruleId === opts.ruleId) && (opts.traceId == null || result.traceId === opts.traceId) && (opts.passed == null || result.passed === opts.passed))
      .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))
      .slice(0, limit);
  }

  resultId(rule: OnlineRule, traceId: string): string {
    return `online_${sha256(`${rule.id}:${rule.revision}:${traceId}`).slice(7, 39)}`;
  }
  loadResult(id: string): OnlineEvaluationResult { return validateResult(readJsonFile(this.resultFile(id))); }
  hasResult(id: string): boolean { return existsSync(this.resultFile(id)); }
  async saveResult(result: OnlineEvaluationResult): Promise<void> {
    const value = validateResult(result);
    await withFileLock(this.resultFile(value.id), () => atomicWriteJson(this.resultFile(value.id), redactDeep(value, true)));
  }

  async enqueue(traceId: string): Promise<OnlineEvaluationJob> {
    validateId(traceId, "trace id");
    const id = `job_${sha256(traceId).slice(7, 39)}`;
    const file = this.jobFile(id);
    return withFileLock(file, () => {
      if (existsSync(file)) {
        const existing = validateJob(readJsonFile(file));
        if (existing.state !== "failed" || !existing.nextAttemptAt || existing.nextAttemptAt > new Date().toISOString()) return existing;
      }
      const now = new Date().toISOString();
      const job: OnlineEvaluationJob = { kind: "dry-run.online-job", version: 1, id, traceId, state: "pending", attempts: 0, createdAt: now, updatedAt: now };
      atomicWriteJson(file, job);
      return job;
    });
  }

  pendingJobs(now = new Date()): OnlineEvaluationJob[] {
    const iso = now.toISOString();
    return listDocuments(this.jobsDir, validateJob)
      .filter((job) => job.state === "pending" || (job.state === "failed" && Boolean(job.nextAttemptAt && job.nextAttemptAt <= iso)) || (job.state === "running" && Boolean(job.leaseUntil && job.leaseUntil <= iso)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async claimJob(id: string, leaseMs = 60_000): Promise<OnlineEvaluationJob | undefined> {
    const file = this.jobFile(id);
    return withFileLock(file, () => {
      if (!existsSync(file)) return undefined;
      const job = validateJob(readJsonFile(file));
      const now = new Date();
      if (job.state === "running" && job.leaseUntil && job.leaseUntil > now.toISOString()) return undefined;
      if (job.state === "failed" && job.nextAttemptAt && job.nextAttemptAt > now.toISOString()) return undefined;
      const claimed: OnlineEvaluationJob = { ...job, state: "running", attempts: job.attempts + 1, updatedAt: now.toISOString(), leaseUntil: new Date(now.getTime() + leaseMs).toISOString() };
      delete claimed.error;
      delete claimed.nextAttemptAt;
      atomicWriteJson(file, claimed);
      return claimed;
    });
  }

  async completeJob(id: string): Promise<void> {
    const file = this.jobFile(id);
    await withFileLock(file, () => { if (existsSync(file)) unlinkSync(file); });
  }

  async failJob(id: string, error: unknown, maxAttempts = 5): Promise<void> {
    const file = this.jobFile(id);
    await withFileLock(file, () => {
      if (!existsSync(file)) return;
      const job = validateJob(readJsonFile(file));
      const delayMs = Math.min(60_000, 500 * 2 ** Math.min(job.attempts, 7));
      const failed: OnlineEvaluationJob = {
        ...job,
        state: "failed",
        updatedAt: new Date().toISOString(),
        error: safeError(error),
        ...(job.attempts < maxAttempts ? { nextAttemptAt: new Date(Date.now() + delayMs).toISOString() } : {}),
      };
      delete failed.leaseUntil;
      atomicWriteJson(file, failed);
    });
  }

  private ruleFile(id: string): string { validateId(id, "rule id"); return path.join(this.rulesDir, `${id}.json`); }
  private resultFile(id: string): string { validateId(id, "result id"); return path.join(this.resultsDir, `${id}.json`); }
  private jobFile(id: string): string { validateId(id, "job id"); return path.join(this.jobsDir, `${id}.json`); }
}

export class OnlineEvaluationEngine {
  readonly store: OnlineEvaluationStore;
  private readonly options: { judge?: LLMProvider; annotations?: AnnotationStore };
  constructor(
    store: OnlineEvaluationStore,
    options: { judge?: LLMProvider; annotations?: AnnotationStore } = {},
  ) { this.store = store; this.options = options; }

  async evaluateTrace(trace: TraceDocument): Promise<{ matched: number; cached: number; results: OnlineEvaluationResult[] }> {
    const results: OnlineEvaluationResult[] = [];
    let matched = 0;
    let cached = 0;
    for (const rule of this.store.listRules().filter((candidate) => candidate.enabled)) {
      if (!matchesRule(rule, trace)) continue;
      matched += 1;
      const id = this.store.resultId(rule, trace.id);
      if (this.store.hasResult(id)) {
        let existing = this.store.loadResult(id);
        if (!existing.passed && !existing.annotationItemId && this.options.annotations) {
          const item = await enqueueFailure(this.options.annotations, rule, existing);
          existing = { ...existing, annotationItemId: item.id };
          await this.store.saveResult(existing);
        }
        results.push(existing); cached += 1; continue;
      }
      const started = performance.now();
      const trajectory = traceToTrajectory(trace);
      const checks: AssertionResult[] = [];
      for (const check of rule.checks) {
        let result: AssertionResult;
        try {
          result = check.type === "semantic"
            ? await evaluateSemantic(check.criteria, trace, trajectory.output, this.options.judge)
            : evaluateAssertion(check, trajectory, { durationMs: trace.durationMs });
        } catch (error) {
          result = { label: describeAssertion(check), passed: false, message: `check failed: ${safeError(error)}` };
        }
        checks.push(result.skipped && rule.unavailable === "fail" ? { ...result, passed: false, message: result.message ?? "required signal is unavailable" } : result);
      }
      let result: OnlineEvaluationResult = {
        kind: "dry-run.online-result",
        version: 1,
        id,
        ruleId: rule.id,
        ruleRevision: rule.revision,
        ruleName: rule.name,
        traceId: trace.id,
        traceName: trace.name,
        passed: checks.every((check) => check.passed),
        checks,
        evaluatedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
      };
      await this.store.saveResult(result);
      if (!result.passed && this.options.annotations) {
        const item = await enqueueFailure(this.options.annotations, rule, result);
        result = { ...result, annotationItemId: item.id };
        await this.store.saveResult(result);
      }
      results.push(result);
    }
    return { matched, cached, results };
  }

  async evaluateMany(traces: TraceDocument[]): Promise<OnlineBatchSummary> {
    const summary: OnlineBatchSummary = { traces: traces.length, matched: 0, evaluated: 0, passed: 0, failed: 0, cached: 0, results: [] };
    for (const trace of traces) {
      const current = await this.evaluateTrace(trace);
      summary.matched += current.matched;
      summary.cached += current.cached;
      summary.results.push(...current.results);
    }
    summary.evaluated = summary.results.length;
    summary.passed = summary.results.filter((result) => result.passed).length;
    summary.failed = summary.evaluated - summary.passed;
    return summary;
  }
}

export class OnlineEvaluationProcessor {
  private running?: Promise<void>;
  private requested = false;
  readonly store: OnlineEvaluationStore;
  readonly traceStore: TraceStore;
  readonly engine: OnlineEvaluationEngine;
  constructor(
    store: OnlineEvaluationStore,
    traceStore: TraceStore,
    engine: OnlineEvaluationEngine,
  ) { this.store = store; this.traceStore = traceStore; this.engine = engine; }

  async enqueue(traceIds: string[]): Promise<void> { for (const traceId of traceIds) await this.store.enqueue(traceId); }
  trigger(): void { this.requested = true; void this.drain(); }
  async drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doDrain().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async doDrain(): Promise<void> {
    do {
      this.requested = false;
      for (const pending of this.store.pendingJobs()) {
        const job = await this.store.claimJob(pending.id);
        if (!job) continue;
        try {
          await this.engine.evaluateTrace(this.traceStore.load(job.traceId));
          await this.store.completeJob(job.id);
        } catch (error) {
          await this.store.failJob(job.id, error);
        }
      }
    } while (this.requested || this.store.pendingJobs().length > 0);
  }
}

export function matchesRule(rule: OnlineRule, trace: TraceDocument): boolean {
  const filter = rule.filter;
  if (filter.status && trace.status !== filter.status) return false;
  if (filter.traceNameContains && !trace.name.toLowerCase().includes(filter.traceNameContains.toLowerCase())) return false;
  if (filter.tags?.length && !filter.tags.every((tag) => trace.tags?.includes(tag))) return false;
  const dimensions = traceDimensions(trace);
  if (filter.environments?.length && !filter.environments.includes(dimensions.environment ?? "")) return false;
  if (filter.releases?.length && !filter.releases.includes(dimensions.release ?? "")) return false;
  if (filter.providers?.length && !filter.providers.includes(dimensions.provider ?? "")) return false;
  if (filter.models?.length && !filter.models.includes(dimensions.model ?? "")) return false;
  const rate = filter.sampleRate ?? 1;
  if (rate < 1) {
    const bucket = Number.parseInt(sha256(`${rule.id}:${trace.id}`).slice(7, 19), 16) / 0xffffffffffff;
    if (bucket >= rate) return false;
  }
  return true;
}

async function evaluateSemantic(criteria: string, trace: TraceDocument, output: string, judge?: LLMProvider): Promise<AssertionResult> {
  const label = describeAssertion({ type: "semantic", criteria });
  if (!judge) return { label, passed: false, skipped: true, message: "no local judge is configured" };
  try {
    const root = trace.spans.find((span) => span.id === trace.rootSpanId);
    const response = await judge.chat({
      model: "",
      messages: [
        { role: "system", content: "You are a strict production QA judge. Return JSON only: {\"passed\":boolean,\"reason\":string}." },
        { role: "user", content: `Input: ${stringify(root?.input)}\n\nOutput: ${output}\n\nCriteria: ${criteria}` },
      ],
      temperature: 0,
      responseFormat: { type: "json_object" },
    });
    const parsed = JSON.parse(response.text ?? "") as unknown;
    if (!isRecord(parsed) || typeof parsed.passed !== "boolean") throw new Error("judge JSON requires passed:boolean");
    return { label, passed: parsed.passed, message: typeof parsed.reason === "string" ? parsed.reason : undefined };
  } catch (error) {
    return { label, passed: false, skipped: true, message: `judge unavailable: ${safeError(error)}` };
  }
}

async function enqueueFailure(store: AnnotationStore, rule: OnlineRule, result: OnlineEvaluationResult): Promise<AnnotationItem> {
  let queueId = rule.action?.queueId;
  if (queueId) store.loadQueue(queueId);
  if (!queueId) {
    const name = rule.action?.queueName ?? "Online evaluation failures";
    queueId = store.listQueues().find((queue) => queue.name === name)?.id ?? (await store.createQueue(name, "Automatically mined production failures awaiting human review.")).id;
  }
  const existing = store.listItems({ queueId, limit: 10_000 }).find((item) => item.metadata?.onlineResultId === result.id);
  if (existing) return existing;
  return store.enqueue(queueId, { type: "trace", id: result.traceId }, {
    priority: rule.action?.priority ?? 50,
    labels: [...new Set(["online-failure", `rule:${rule.id}`, ...(rule.action?.labels ?? [])])],
    metadata: {
      onlineResultId: result.id,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      failures: result.checks.filter((check) => !check.passed).map((check) => ({ label: check.label, message: check.message })),
    },
  });
}

function traceDimensions(trace: TraceDocument): { environment?: string; release?: string; provider?: string; model?: string } {
  const all = [trace.metadata ?? {}, ...trace.spans.map((span) => span.attributes)];
  return {
    environment: firstString(all, "environment", "deployment.environment", "dryrun.environment"),
    release: firstString(all, "release", "service.version", "dryrun.release"),
    provider: firstString(all, "provider", "gen_ai.system", "gen_ai.provider.name"),
    model: firstString(all, "model", "gen_ai.request.model", "gen_ai.response.model"),
  };
}

function validateRule(value: unknown): OnlineRule {
  if (!isRecord(value) || value.kind !== "dry-run.online-rule" || value.version !== 1) throw new Error("Unsupported online rule");
  validateId(value.id, "rule id");
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new Error("Online rule revision must be positive");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 128) throw new Error("Online rule name must contain 1-128 characters");
  if (typeof value.enabled !== "boolean" || !isRecord(value.filter) || !Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 50) throw new Error("Online rule requires enabled, filter, and 1-50 checks");
  if (value.unavailable !== "fail" && value.unavailable !== "skip") throw new Error("Online rule unavailable policy must be fail or skip");
  const filter = value.filter as OnlineRuleFilter;
  if (filter.sampleRate != null && (!Number.isFinite(filter.sampleRate) || filter.sampleRate < 0 || filter.sampleRate > 1)) throw new Error("Online rule sampleRate must be between 0 and 1");
  for (const key of ["tags", "environments", "releases", "providers", "models"] as const) if (filter[key] != null && !validStrings(filter[key])) throw new Error(`Online rule ${key} must contain non-empty strings`);
  value.checks.forEach(validateCheck);
  if (value.action != null) {
    if (!isRecord(value.action)) throw new Error("Online rule action must be an object");
    if (value.action.priority != null && (!Number.isFinite(value.action.priority) || value.action.priority < 0 || value.action.priority > 100)) throw new Error("Online rule action priority must be between 0 and 100");
    if (value.action.labels != null && !validStrings(value.action.labels)) throw new Error("Online rule action labels must contain non-empty strings");
  }
  return structuredClone(value) as unknown as OnlineRule;
}

function validateCheck(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string" || value.type === "custom") throw new Error("Online checks must be serializable built-in assertions");
  const allowed = new Set(["toolCalled", "notToolCalled", "outputEquals", "outputContains", "outputMatches", "maxSteps", "maxTokens", "maxLLMCalls", "maxDuration", "maxCost", "noRepeatedToolCalls", "noToolErrors", "toolOrder", "toolArgsSchema", "outputJsonSchema", "trajectory", "semantic"]);
  if (!allowed.has(value.type)) throw new Error(`Unsupported online check: ${value.type}`);
  if (value.type === "outputMatches" && (typeof value.pattern !== "string" || value.pattern.length > 512 || (value.flags != null && (typeof value.flags !== "string" || !/^[dgimsuvy]*$/.test(value.flags))))) throw new Error("Online outputMatches requires a pattern <= 512 characters and valid flags");
  describeAssertion(value as OnlineCheck);
}

function validateResult(value: unknown): OnlineEvaluationResult {
  if (!isRecord(value) || value.kind !== "dry-run.online-result" || value.version !== 1 || typeof value.id !== "string" || typeof value.ruleId !== "string" || typeof value.traceId !== "string" || !Array.isArray(value.checks) || typeof value.passed !== "boolean") throw new Error("Unsupported online evaluation result");
  return value as unknown as OnlineEvaluationResult;
}

function validateJob(value: unknown): OnlineEvaluationJob {
  if (!isRecord(value) || value.kind !== "dry-run.online-job" || value.version !== 1 || typeof value.id !== "string" || typeof value.traceId !== "string" || !["pending", "running", "failed"].includes(value.state) || !Number.isInteger(value.attempts)) throw new Error("Unsupported online evaluation job");
  return value as unknown as OnlineEvaluationJob;
}

function listDocuments<T>(dir: string, validate: (value: unknown) => T): T[] {
  if (!existsSync(dir)) return [];
  const values: T[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try { values.push(validate(readJsonFile(path.join(dir, file)))); } catch { /* Ignore incomplete or unrelated files. */ }
  }
  return values;
}

function firstString(values: Record<string, unknown>[], ...keys: string[]): string | undefined {
  for (const value of values) for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  return undefined;
}
function validateId(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,192}$/.test(value)) throw new Error(`Invalid ${label}`); }
function validStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 256); }
function boundedInteger(value: number, min: number, max: number, label: string): number { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`); return value; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 500); }
function stringify(value: unknown): string { if (typeof value === "string") return value; try { return canonicalStringify(value); } catch { return String(value); } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
