import { createHmac } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import type { AnalyticsEventView, AnalyticsQuery, AnalyticsStore } from "./analytics.ts";
import { atomicWriteJson, ensurePrivateDirectory, newId, readJsonFile, withFileLock } from "./storage.ts";

export type IntelligenceDimension = "model" | "provider" | "environment" | "release" | "status" | "name" | "tag";
export type NumericMetric = "durationMs" | "tokens" | "costUsd";

export interface IntelligenceWindow { since?: string; until?: string; release?: string; environment?: string }
export interface MetricComparison { baseline: number; candidate: number; absoluteDelta: number; relativeDelta?: number }
export interface PassRateComparison extends MetricComparison { baselineInterval95: [number, number]; candidateInterval95: [number, number]; statisticallyDistinct: boolean }
export interface ReleaseComparison {
  baseline: { count: number; release?: string };
  candidate: { count: number; release?: string };
  passRate: PassRateComparison;
  averageLatencyMs: MetricComparison;
  p95LatencyMs: MetricComparison;
  averageTokens: MetricComparison;
  averageCostUsd: MetricComparison;
}
export interface DistributionDrift {
  dimension: IntelligenceDimension | NumericMetric;
  method: "jensen-shannon" | "kolmogorov-smirnov";
  score: number;
  threshold: number;
  drifted: boolean;
  baselineCount: number;
  candidateCount: number;
  categories?: Array<{ value: string; baselineShare: number; candidateShare: number; delta: number }>;
}
export interface IntelligenceAnomaly { eventId: string; occurredAt: string; metric: NumericMetric; value: number; median: number; robustZ: number; severity: "warning" | "critical" }
export interface FailureCluster { id: string; signature: string; count: number; shareOfFailures: number; status: string; name: string; tags: string[]; sampleEventIds: string[]; firstSeenAt: string; lastSeenAt: string }
export interface RootCauseCandidate { dimension: IntelligenceDimension; value: string; events: number; failures: number; failureRate: number; baselineFailureRate: number; lift: number; riskDifference: number; phi: number }
export interface IntelligenceReport {
  kind: "dry-run.intelligence-report";
  version: 1;
  id: string;
  createdAt: string;
  workspaceId: string;
  projectId: string;
  baselineWindow: IntelligenceWindow;
  candidateWindow: IntelligenceWindow;
  sample: { baseline: number; candidate: number; failures: number };
  releaseComparison: ReleaseComparison;
  drift: DistributionDrift[];
  anomalies: IntelligenceAnomaly[];
  failureClusters: FailureCluster[];
  rootCauses: RootCauseCandidate[];
  verdict: "improved" | "stable" | "degraded" | "insufficient-data";
  reasons: string[];
}
export interface IntelligenceAnalyzeOptions { baseline: IntelligenceWindow; candidate: IntelligenceWindow; minimumEvents?: number; driftThreshold?: number; anomalyThreshold?: number; maxEvents?: number }

export class IntelligenceStore {
  readonly dir: string;
  constructor(dir = path.resolve(".dryrun/intelligence")) { this.dir = path.resolve(dir); ensurePrivateDirectory(this.dir); }
  async save(report: IntelligenceReport): Promise<IntelligenceReport> {
    validateReport(report);
    const file = this.file(report.id);
    return withFileLock(file, () => {
      if (existsSync(file)) return validateReport(readJsonFile(file));
      atomicWriteJson(file, report);
      return structuredClone(report);
    });
  }
  load(id: string): IntelligenceReport { return validateReport(readJsonFile(this.file(id))); }
  list(limit = 100): IntelligenceReport[] {
    const boundedLimit = integer(limit, 1, 2_000, "Intelligence report limit");
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
      try { return [validateReport(readJsonFile(path.join(this.dir, name)))]; } catch { return []; }
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, boundedLimit);
  }
  private file(id: string): string { validId(id); return path.join(this.dir, `${id}.json`); }
}

export class ProductionIntelligenceEngine {
  private readonly analytics: AnalyticsStore;
  private readonly store?: IntelligenceStore;
  constructor(analytics: AnalyticsStore, store?: IntelligenceStore) { this.analytics = analytics; this.store = store; }
  async analyze(workspaceId: string, projectId: string, options: IntelligenceAnalyzeOptions): Promise<IntelligenceReport> {
    if (!this.analytics.queryEvents) throw new Error("The analytics backend does not support production intelligence queries");
    const maxEvents = integer(options.maxEvents ?? 20_000, 20, 100_000, "maxEvents");
    const [baseline, candidate] = await Promise.all([
      collectEvents(this.analytics, workspaceId, projectId, windowQuery(options.baseline), maxEvents),
      collectEvents(this.analytics, workspaceId, projectId, windowQuery(options.candidate), maxEvents),
    ]);
    const report = analyzeProductionEvents(baseline, candidate, { workspaceId, projectId, baseline: options.baseline, candidate: options.candidate, minimumEvents: options.minimumEvents, driftThreshold: options.driftThreshold, anomalyThreshold: options.anomalyThreshold });
    return this.store ? this.store.save(report) : report;
  }
}

export function analyzeProductionEvents(baseline: AnalyticsEventView[], candidate: AnalyticsEventView[], options: Omit<IntelligenceAnalyzeOptions, "maxEvents"> & { workspaceId?: string; projectId?: string }): IntelligenceReport {
  const minimumEvents = integer(options.minimumEvents ?? 20, 1, 1_000_000, "minimumEvents");
  const driftThreshold = bounded(options.driftThreshold ?? 0.1, 0, 1, "driftThreshold");
  const anomalyThreshold = bounded(options.anomalyThreshold ?? 3.5, 1, 100, "anomalyThreshold");
  const comparison = compareEventSets(baseline, candidate, options.baseline.release, options.candidate.release);
  const drift = [
    ...(["model", "provider", "environment", "release", "status", "name", "tag"] as IntelligenceDimension[]).map((dimension) => categoricalDrift(baseline, candidate, dimension, driftThreshold)),
    ...(["durationMs", "tokens", "costUsd"] as NumericMetric[]).map((metric) => numericDrift(baseline, candidate, metric, driftThreshold)),
  ];
  const anomalies = detectRobustAnomalies(baseline, candidate, anomalyThreshold);
  const failures = candidate.filter((event) => !event.passed);
  const clusters = clusterFailures(failures);
  const rootCauses = rankRootCauses(candidate);
  const reasons: string[] = [];
  let verdict: IntelligenceReport["verdict"] = "stable";
  if (baseline.length < minimumEvents || candidate.length < minimumEvents) {
    verdict = "insufficient-data";
    reasons.push(`At least ${minimumEvents} events are required in each window`);
  } else {
    const passDelta = comparison.passRate.absoluteDelta;
    if (comparison.passRate.statisticallyDistinct && passDelta < 0) reasons.push(`Pass rate regressed by ${round(Math.abs(passDelta) * 100, 2)} percentage points`);
    if (comparison.p95LatencyMs.relativeDelta != null && comparison.p95LatencyMs.relativeDelta > 0.2) reasons.push(`P95 latency increased by ${round(comparison.p95LatencyMs.relativeDelta * 100, 1)}%`);
    const materialDrift = drift.filter((entry) => entry.drifted);
    if (materialDrift.length) reasons.push(`Material drift detected in ${materialDrift.map((entry) => entry.dimension).join(", ")}`);
    if ((comparison.passRate.statisticallyDistinct && passDelta < 0) || reasons.some((reason) => reason.startsWith("P95"))) verdict = "degraded";
    else if (comparison.passRate.statisticallyDistinct && passDelta > 0 && (comparison.p95LatencyMs.relativeDelta ?? 0) <= 0.2) verdict = "improved";
    if (!reasons.length) reasons.push(verdict === "improved" ? "Pass rate improved without a material latency regression" : "No statistically material quality regression detected");
  }
  return validateReport({
    kind: "dry-run.intelligence-report", version: 1, id: newId("intelligence"), createdAt: new Date().toISOString(), workspaceId: options.workspaceId ?? "local", projectId: options.projectId ?? "local",
    baselineWindow: validatedWindow(options.baseline), candidateWindow: validatedWindow(options.candidate), sample: { baseline: baseline.length, candidate: candidate.length, failures: failures.length },
    releaseComparison: comparison, drift, anomalies, failureClusters: clusters, rootCauses, verdict, reasons,
  });
}

export function compareEventSets(baseline: AnalyticsEventView[], candidate: AnalyticsEventView[], baselineRelease?: string, candidateRelease?: string): ReleaseComparison {
  const baselinePassed = baseline.filter((event) => event.passed).length, candidatePassed = candidate.filter((event) => event.passed).length;
  const baselineRate = ratio(baselinePassed, baseline.length), candidateRate = ratio(candidatePassed, candidate.length);
  const baselineInterval = wilsonInterval(baselinePassed, baseline.length), candidateInterval = wilsonInterval(candidatePassed, candidate.length);
  return {
    baseline: { count: baseline.length, ...(baselineRelease ? { release: baselineRelease } : {}) }, candidate: { count: candidate.length, ...(candidateRelease ? { release: candidateRelease } : {}) },
    passRate: { ...comparison(baselineRate, candidateRate), baselineInterval95: baselineInterval, candidateInterval95: candidateInterval, statisticallyDistinct: baselineInterval[1] < candidateInterval[0] || candidateInterval[1] < baselineInterval[0] },
    averageLatencyMs: comparison(mean(baseline.map((event) => event.durationMs)), mean(candidate.map((event) => event.durationMs))),
    p95LatencyMs: comparison(percentile(baseline.map((event) => event.durationMs), 0.95), percentile(candidate.map((event) => event.durationMs), 0.95)),
    averageTokens: comparison(mean(baseline.map((event) => event.tokens)), mean(candidate.map((event) => event.tokens))),
    averageCostUsd: comparison(mean(baseline.map((event) => event.costUsd)), mean(candidate.map((event) => event.costUsd))),
  };
}

export function categoricalDrift(baseline: AnalyticsEventView[], candidate: AnalyticsEventView[], dimension: IntelligenceDimension, threshold = 0.1): DistributionDrift {
  const left = frequencies(baseline.flatMap((event) => values(event, dimension))), right = frequencies(candidate.flatMap((event) => values(event, dimension)));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort(), totalLeft = sum([...left.values()]), totalRight = sum([...right.values()]);
  let divergence = 0;
  const categories = keys.map((value) => {
    const p = ratio(left.get(value) ?? 0, totalLeft), q = ratio(right.get(value) ?? 0, totalRight), middle = (p + q) / 2;
    if (p > 0) divergence += 0.5 * p * Math.log2(p / middle);
    if (q > 0) divergence += 0.5 * q * Math.log2(q / middle);
    return { value, baselineShare: round(p), candidateShare: round(q), delta: round(q - p) };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 20);
  const score = round(divergence);
  return { dimension, method: "jensen-shannon", score, threshold, drifted: score >= threshold, baselineCount: baseline.length, candidateCount: candidate.length, categories };
}

export function numericDrift(baseline: AnalyticsEventView[], candidate: AnalyticsEventView[], metric: NumericMetric, threshold = 0.1): DistributionDrift {
  const left = baseline.map((event) => finite(event[metric])).sort((a, b) => a - b), right = candidate.map((event) => finite(event[metric])).sort((a, b) => a - b);
  const score = round(kolmogorovSmirnov(left, right));
  return { dimension: metric, method: "kolmogorov-smirnov", score, threshold, drifted: score >= threshold, baselineCount: left.length, candidateCount: right.length };
}

export function detectRobustAnomalies(baseline: AnalyticsEventView[], candidate: AnalyticsEventView[], threshold = 3.5): IntelligenceAnomaly[] {
  const anomalies: IntelligenceAnomaly[] = [];
  for (const metric of ["durationMs", "tokens", "costUsd"] as NumericMetric[]) {
    const source = baseline.map((event) => finite(event[metric]));
    if (source.length < 3) continue;
    const center = median(source), mad = median(source.map((value) => Math.abs(value - center))), scale = mad || Math.max(Math.abs(center) * 0.01, Number.EPSILON);
    for (const event of candidate) {
      const value = finite(event[metric]), robustZ = 0.67448975 * (value - center) / scale;
      if (Math.abs(robustZ) >= threshold) anomalies.push({ eventId: event.id, occurredAt: event.occurredAt, metric, value, median: center, robustZ: round(robustZ), severity: Math.abs(robustZ) >= threshold * 2 ? "critical" : "warning" });
    }
  }
  return anomalies.sort((left, right) => Math.abs(right.robustZ) - Math.abs(left.robustZ)).slice(0, 200);
}

export function clusterFailures(failures: AnalyticsEventView[]): FailureCluster[] {
  const groups = new Map<string, AnalyticsEventView[]>();
  for (const event of failures) { const signature = `${event.status.toLowerCase()}|${event.name.toLowerCase()}|${[...event.tags].sort().slice(0, 5).join(",")}`; groups.set(signature, [...(groups.get(signature) ?? []), event]); }
  return [...groups.entries()].map(([signature, events]) => {
    const ordered = events.toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return { id: `failure_${stableHash(signature)}`, signature, count: events.length, shareOfFailures: round(ratio(events.length, failures.length)), status: events[0].status, name: events[0].name, tags: [...new Set(events.flatMap((event) => event.tags))].sort().slice(0, 10), sampleEventIds: events.slice(0, 5).map((event) => event.id), firstSeenAt: ordered[0].occurredAt, lastSeenAt: ordered.at(-1)!.occurredAt };
  }).sort((left, right) => right.count - left.count || left.signature.localeCompare(right.signature)).slice(0, 100);
}

export function rankRootCauses(events: AnalyticsEventView[]): RootCauseCandidate[] {
  const totalFailures = events.filter((event) => !event.passed).length, globalRate = ratio(totalFailures, events.length), candidates: RootCauseCandidate[] = [];
  for (const dimension of ["model", "provider", "environment", "release", "status", "name", "tag"] as IntelligenceDimension[]) {
    const buckets = new Map<string, AnalyticsEventView[]>();
    for (const event of events) for (const value of values(event, dimension)) buckets.set(value, [...(buckets.get(value) ?? []), event]);
    for (const [value, selected] of buckets) {
      if (!value || selected.length < 2) continue;
      const failures = selected.filter((event) => !event.passed).length, rate = ratio(failures, selected.length);
      candidates.push({ dimension, value, events: selected.length, failures, failureRate: round(rate), baselineFailureRate: round(globalRate), lift: round(globalRate ? rate / globalRate : rate ? Number.MAX_SAFE_INTEGER : 1), riskDifference: round(rate - globalRate), phi: round(phiCoefficient(events.length, totalFailures, selected.length, failures)) });
    }
  }
  return candidates.filter((candidate) => candidate.riskDifference > 0).sort((a, b) => Math.abs(b.phi) - Math.abs(a.phi) || b.riskDifference - a.riskDifference).slice(0, 50);
}

export interface IntelligenceWebhookOptions { url: string; secret?: string; allowPrivateNetwork?: boolean; timeoutMs?: number; fetch?: typeof fetch }
export class IntelligenceWebhookNotifier {
  private readonly endpoint: URL; private readonly request: typeof fetch; private readonly options: IntelligenceWebhookOptions;
  constructor(options: IntelligenceWebhookOptions) {
    this.options = options;
    this.endpoint = validateWebhookUrl(options.url, options.allowPrivateNetwork ?? false);
    if (options.secret != null && (options.secret.length < 16 || options.secret.length > 4_096)) throw new Error("Webhook secret must contain 16-4096 characters");
    this.request = options.fetch ?? fetch;
  }
  async send(report: IntelligenceReport): Promise<void> {
    const payload = JSON.stringify({ version: "1", type: "dry-run.intelligence", report }), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), integer(this.options.timeoutMs ?? 10_000, 100, 120_000, "Webhook timeout")); timer.unref();
    try {
      const response = await this.request(this.endpoint, { method: "POST", redirect: "manual", signal: controller.signal, headers: { "content-type": "application/json", "user-agent": "dry-run-intelligence/1", ...(this.options.secret ? { "x-dry-run-signature": `sha256=${createHmac("sha256", this.options.secret).update(payload).digest("hex")}` } : {}) }, body: payload });
      if (response.status >= 300 && response.status < 400) throw new Error("Webhook redirects are refused");
      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    } finally { clearTimeout(timer); }
  }
}

async function collectEvents(analytics: AnalyticsStore, workspaceId: string, projectId: string, query: AnalyticsQuery, maximum: number): Promise<AnalyticsEventView[]> {
  const result: AnalyticsEventView[] = []; let cursor: string | undefined;
  do { const page = await analytics.queryEvents!(workspaceId, projectId, { ...query, limit: Math.min(500, maximum - result.length), ...(cursor ? { cursor } : {}) }); result.push(...page.items); cursor = page.hasMore ? page.nextCursor : undefined; } while (cursor && result.length < maximum);
  return result.slice(0, maximum);
}
function windowQuery(window: IntelligenceWindow): AnalyticsQuery { return { since: window.since, until: window.until, release: window.release, environment: window.environment }; }
function validatedWindow(window: IntelligenceWindow): IntelligenceWindow {
  if (window.since && !Number.isFinite(Date.parse(window.since))) throw new Error("Window since must be an ISO timestamp");
  if (window.until && !Number.isFinite(Date.parse(window.until))) throw new Error("Window until must be an ISO timestamp");
  if (window.since && window.until && window.since > window.until) throw new Error("Window since cannot be after until");
  for (const value of [window.release, window.environment]) if (value != null && (!value.trim() || value.length > 256)) throw new Error("Invalid intelligence window filter");
  return structuredClone(window);
}
function comparison(baseline: number, candidate: number): MetricComparison { return { baseline: round(baseline), candidate: round(candidate), absoluteDelta: round(candidate - baseline), ...(baseline !== 0 ? { relativeDelta: round((candidate - baseline) / Math.abs(baseline)) } : {}) }; }
function wilsonInterval(successes: number, count: number): [number, number] { if (!count) return [0, 1]; const z = 1.959963984540054, p = successes / count, divisor = 1 + z * z / count, center = (p + z * z / (2 * count)) / divisor, margin = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / divisor; return [round(Math.max(0, center - margin)), round(Math.min(1, center + margin))]; }
function values(event: AnalyticsEventView, dimension: IntelligenceDimension): string[] { if (dimension === "tag") return event.tags.length ? event.tags : ["(none)"]; const value = event[dimension]; return [typeof value === "string" && value ? value : "(none)"]; }
function frequencies(input: string[]): Map<string, number> { const result = new Map<string, number>(); for (const value of input) result.set(value, (result.get(value) ?? 0) + 1); return result; }
function kolmogorovSmirnov(left: number[], right: number[]): number { if (!left.length || !right.length) return 0; const allValues = [...new Set([...left, ...right])].sort((a, b) => a - b); let li = 0, ri = 0, maximum = 0; for (const value of allValues) { while (li < left.length && left[li] <= value) li += 1; while (ri < right.length && right[ri] <= value) ri += 1; maximum = Math.max(maximum, Math.abs(li / left.length - ri / right.length)); } return maximum; }
function phiCoefficient(total: number, totalFailures: number, selected: number, selectedFailures: number): number { const a = selectedFailures, b = selected - selectedFailures, c = totalFailures - a, d = total - a - b - c, denominator = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d)); return denominator ? (a * d - b * c) / denominator : 0; }
function percentile(values: number[], quantile: number): number { if (!values.length) return 0; const sorted = values.toSorted((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))]; }
function median(values: number[]): number { if (!values.length) return 0; const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function mean(values: number[]): number { return ratio(sum(values), values.length); }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function ratio(value: number, total: number): number { return total ? value / total : 0; }
function finite(value: number): number { return Number.isFinite(value) ? value : 0; }
function round(value: number, precision = 6): number { if (!Number.isFinite(value)) return value; const multiplier = 10 ** precision; return Math.round(value * multiplier) / multiplier; }
function bounded(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`); return value; }
function integer(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`); return value; }
function stableHash(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }
function validId(value: string): void { if (!/^[A-Za-z0-9_.-]{1,192}$/.test(value)) throw new Error("Invalid intelligence report id"); }
function validateReport(value: unknown): IntelligenceReport { if (!record(value) || value.kind !== "dry-run.intelligence-report" || value.version !== 1 || typeof value.id !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !record(value.sample) || !Array.isArray(value.drift) || !Array.isArray(value.anomalies) || !Array.isArray(value.failureClusters) || !Array.isArray(value.rootCauses) || !Array.isArray(value.reasons) || !["improved", "stable", "degraded", "insufficient-data"].includes(String(value.verdict))) throw new Error("Invalid intelligence report"); validId(value.id); return value as unknown as IntelligenceReport; }
function validateWebhookUrl(raw: string, allowPrivate: boolean): URL { const url = new URL(raw); if (url.username || url.password || url.hash) throw new Error("Webhook URL cannot contain credentials or a fragment"); if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivate)) throw new Error("Webhook requires HTTPS"); if (!allowPrivate && isPrivateHost(url.hostname)) throw new Error("Webhook cannot target a private network"); return url; }
function isPrivateHost(hostname: string): boolean { const host = hostname.replace(/^\[|\]$/g, "").toLowerCase(); if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true; if (!isIP(host)) return false; if (host === "::1" || host === "0.0.0.0" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true; const parts = host.split(".").map(Number); return parts.length === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
