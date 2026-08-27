import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { AnalyticsStore, AnalyticsSummary } from "./analytics.ts";
import { atomicWriteJson, ensurePrivateDirectory, newId, readJsonFile, sha256, withFileLock } from "./storage.ts";

export interface QualityMonitorThresholds {
  minPassRate?: number;
  maxFailureRate?: number;
  maxAverageLatencyMs?: number;
  maxP95LatencyMs?: number;
  maxP99LatencyMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface QualityMonitor {
  kind: "dry-run.quality-monitor";
  version: 1;
  id: string;
  revision: number;
  name: string;
  description?: string;
  enabled: boolean;
  windowMinutes: number;
  minEvents: number;
  thresholds: QualityMonitorThresholds;
  createdAt: string;
  updatedAt: string;
}

export interface QualityMonitorObserved {
  events: number;
  passRate: number;
  failureRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  tokens: number;
  costUsd: number;
}

export interface QualityMonitorViolation {
  metric: keyof QualityMonitorThresholds;
  operator: ">=" | "<=";
  threshold: number;
  observed: number;
}

export interface QualityMonitorResult {
  kind: "dry-run.quality-monitor-result";
  version: 1;
  id: string;
  monitorId: string;
  monitorRevision: number;
  monitorName: string;
  status: "healthy" | "breached" | "insufficient-data";
  since: string;
  until: string;
  observed: QualityMonitorObserved;
  violations: QualityMonitorViolation[];
  evaluatedAt: string;
}

export class QualityMonitorStore {
  readonly dir: string;
  readonly monitorsDir: string;
  readonly resultsDir: string;

  constructor(dir = path.resolve(".dryrun/monitors")) {
    this.dir = path.resolve(dir);
    this.monitorsDir = path.join(this.dir, "definitions");
    this.resultsDir = path.join(this.dir, "results");
    ensurePrivateDirectory(this.monitorsDir);
    ensurePrivateDirectory(this.resultsDir);
  }

  async create(input: { name: string; description?: string; enabled?: boolean; windowMinutes?: number; minEvents?: number; thresholds: QualityMonitorThresholds }): Promise<QualityMonitor> {
    const now = new Date().toISOString();
    const monitor = validateMonitor({
      kind: "dry-run.quality-monitor", version: 1, id: newId("monitor"), revision: 1,
      name: input.name, ...(input.description ? { description: input.description } : {}), enabled: input.enabled ?? true,
      windowMinutes: input.windowMinutes ?? 60, minEvents: input.minEvents ?? 20, thresholds: input.thresholds,
      createdAt: now, updatedAt: now,
    });
    await withFileLock(this.monitorFile(monitor.id), () => atomicWriteJson(this.monitorFile(monitor.id), monitor));
    return structuredClone(monitor);
  }

  async update(id: string, patch: Partial<Pick<QualityMonitor, "name" | "description" | "enabled" | "windowMinutes" | "minEvents" | "thresholds">>): Promise<QualityMonitor> {
    const file = this.monitorFile(id);
    return withFileLock(file, () => {
      const current = this.load(id);
      const monitor = validateMonitor({ ...current, ...structuredClone(patch), id: current.id, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() });
      atomicWriteJson(file, monitor);
      return structuredClone(monitor);
    });
  }

  async remove(id: string): Promise<void> {
    const file = this.monitorFile(id);
    await withFileLock(file, () => { if (existsSync(file)) unlinkSync(file); });
  }

  load(id: string): QualityMonitor { return validateMonitor(readJsonFile(this.monitorFile(id))); }
  list(): QualityMonitor[] { return documents(this.monitorsDir, validateMonitor).sort((left, right) => left.name.localeCompare(right.name)); }
  listResults(opts: { monitorId?: string; status?: QualityMonitorResult["status"]; limit?: number } = {}): QualityMonitorResult[] {
    const limit = integer(opts.limit ?? 100, 1, 2_000, "Monitor result limit");
    return documents(this.resultsDir, validateResult)
      .filter((result) => !opts.monitorId || result.monitorId === opts.monitorId)
      .filter((result) => !opts.status || result.status === opts.status)
      .sort((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt))
      .slice(0, limit);
  }

  async evaluate(id: string, analytics: AnalyticsStore, workspaceId: string, projectId: string, now = new Date()): Promise<QualityMonitorResult> {
    const monitor = this.load(id);
    const until = now.toISOString();
    const since = new Date(now.getTime() - monitor.windowMinutes * 60_000).toISOString();
    const summary = await analytics.summary(workspaceId, projectId, { since, until });
    const candidate = monitorResult(monitor, summary, since, until);
    const result = await withFileLock(this.resultFile(candidate.id), () => {
      if (existsSync(this.resultFile(candidate.id))) return validateResult(readJsonFile(this.resultFile(candidate.id)));
      atomicWriteJson(this.resultFile(candidate.id), candidate);
      return candidate;
    });
    return structuredClone(result);
  }

  async evaluateAll(analytics: AnalyticsStore, workspaceId: string, projectId: string, now = new Date()): Promise<QualityMonitorResult[]> {
    const results: QualityMonitorResult[] = [];
    for (const monitor of this.list().filter((candidate) => candidate.enabled)) results.push(await this.evaluate(monitor.id, analytics, workspaceId, projectId, now));
    return results;
  }

  private monitorFile(id: string): string { validId(id); return path.join(this.monitorsDir, `${id}.json`); }
  private resultFile(id: string): string { validId(id); return path.join(this.resultsDir, `${id}.json`); }
}

export function evaluateQualityThresholds(monitor: QualityMonitor, summary: AnalyticsSummary, since: string, until: string): QualityMonitorResult {
  return monitorResult(validateMonitor(monitor), summary, since, until);
}

export function validateQualityMonitorResult(value: unknown): QualityMonitorResult { return validateResult(value); }

function monitorResult(monitor: QualityMonitor, summary: AnalyticsSummary, since: string, until: string): QualityMonitorResult {
  const observed: QualityMonitorObserved = {
    events: summary.totals.count,
    passRate: summary.passRate,
    failureRate: summary.totals.count ? summary.totals.failed / summary.totals.count : 0,
    averageLatencyMs: summary.latency.averageMs,
    p95LatencyMs: summary.latency.p95Ms,
    p99LatencyMs: summary.latency.p99Ms,
    tokens: summary.totals.tokens,
    costUsd: summary.totals.costUsd,
  };
  const violations: QualityMonitorViolation[] = [];
  const minimum = (metric: keyof QualityMonitorThresholds, value: number): void => { const threshold = monitor.thresholds[metric]; if (threshold != null && value < threshold) violations.push({ metric, operator: ">=", threshold, observed: value }); };
  const maximum = (metric: keyof QualityMonitorThresholds, value: number): void => { const threshold = monitor.thresholds[metric]; if (threshold != null && value > threshold) violations.push({ metric, operator: "<=", threshold, observed: value }); };
  minimum("minPassRate", observed.passRate);
  maximum("maxFailureRate", observed.failureRate);
  maximum("maxAverageLatencyMs", observed.averageLatencyMs);
  maximum("maxP95LatencyMs", observed.p95LatencyMs);
  maximum("maxP99LatencyMs", observed.p99LatencyMs);
  maximum("maxTokens", observed.tokens);
  maximum("maxCostUsd", observed.costUsd);
  const status = observed.events < monitor.minEvents ? "insufficient-data" : violations.length ? "breached" : "healthy";
  return validateResult({
    kind: "dry-run.quality-monitor-result", version: 1, id: resultId(monitor, since, until), monitorId: monitor.id,
    monitorRevision: monitor.revision, monitorName: monitor.name, status, since, until, observed,
    violations: status === "insufficient-data" ? [] : violations, evaluatedAt: new Date().toISOString(),
  });
}
function resultId(monitor: QualityMonitor, since: string, until: string): string { return `monitor_result_${sha256(`${monitor.id}\0${monitor.revision}\0${since}\0${until}`).slice(7, 39)}`; }

function validateMonitor(value: unknown): QualityMonitor {
  if (!record(value) || value.kind !== "dry-run.quality-monitor" || value.version !== 1 || typeof value.id !== "string" || typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 || typeof value.enabled !== "boolean") throw new Error("Invalid quality monitor");
  validId(value.id);
  integer(value.revision, 1, Number.MAX_SAFE_INTEGER, "Monitor revision");
  integer(value.windowMinutes, 1, 525_600, "Monitor windowMinutes");
  integer(value.minEvents, 1, 1_000_000_000, "Monitor minEvents");
  if (!record(value.thresholds) || !Object.keys(value.thresholds).length) throw new Error("Quality monitor requires at least one threshold");
  const allowed = new Set(["minPassRate", "maxFailureRate", "maxAverageLatencyMs", "maxP95LatencyMs", "maxP99LatencyMs", "maxTokens", "maxCostUsd"]);
  for (const [name, raw] of Object.entries(value.thresholds)) {
    if (!allowed.has(name) || typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new Error(`Invalid quality monitor threshold: ${name}`);
    if ((name === "minPassRate" || name === "maxFailureRate") && raw > 1) throw new Error(`${name} must be between 0 and 1`);
  }
  iso(value.createdAt, "Monitor createdAt"); iso(value.updatedAt, "Monitor updatedAt");
  return value as unknown as QualityMonitor;
}

function validateResult(value: unknown): QualityMonitorResult {
  if (!record(value) || value.kind !== "dry-run.quality-monitor-result" || value.version !== 1 || typeof value.id !== "string" || typeof value.monitorId !== "string" || !["healthy", "breached", "insufficient-data"].includes(String(value.status)) || !record(value.observed) || !Array.isArray(value.violations)) throw new Error("Invalid quality monitor result");
  validId(value.id); validId(value.monitorId); iso(value.since, "Monitor result since"); iso(value.until, "Monitor result until"); iso(value.evaluatedAt, "Monitor result evaluatedAt");
  return value as unknown as QualityMonitorResult;
}
function documents<T>(dir: string, validate: (value: unknown) => T): T[] { if (!existsSync(dir)) return []; return readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => { try { return [validate(readJsonFile(path.join(dir, name)))]; } catch { return []; } }); }
function validId(value: string): void { if (!/^[A-Za-z0-9_.-]{1,192}$/.test(value)) throw new Error("Invalid monitor id"); }
function integer(value: unknown, minimum: number, maximum: number, name: string): number { if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return Number(value); }
function iso(value: unknown, name: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`); return value; }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
