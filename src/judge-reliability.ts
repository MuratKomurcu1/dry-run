import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { calibrateScores, type CalibrationReport } from "./evaluation-governance.ts";
import { atomicWriteJson, ensurePrivateDirectory, newId, readJsonFile, withFileLock } from "./storage.ts";

export interface JudgeObservation {
  targetId: string;
  judgeId: string;
  run: number;
  score: number;
  expected?: boolean;
  latencyMs?: number;
  tokens?: number;
  occurredAt?: string;
}
export interface JudgeRepeatability {
  judgeId: string;
  observations: number;
  targets: number;
  repeatedTargets: number;
  meanWithinTargetStdDev: number;
  meanPairwiseDifference: number;
  repeatability: number;
}
export interface JudgePairAgreement {
  leftJudgeId: string;
  rightJudgeId: string;
  overlappingTargets: number;
  pearson: number | null;
  binaryAgreement: number;
  cohensKappa: number | null;
  meanScoreDifference: number;
}
export interface JudgeProfile {
  judgeId: string;
  observations: number;
  meanScore: number;
  standardDeviation: number;
  averageLatencyMs: number;
  totalTokens: number;
  calibration?: CalibrationReport;
}
export interface EnsembleDecision {
  targetId: string;
  judges: number;
  observations: number;
  score: number;
  interval95: [number, number];
  passed: boolean;
  disagreement: number;
  uncertain: boolean;
}
export interface JudgeDrift {
  judgeId: string;
  baseline: number;
  candidate: number;
  meanScoreDelta: number;
  ksStatistic: number;
  drifted: boolean;
}
export interface JudgeReliabilityPolicy {
  threshold?: number;
  maxCalibrationError?: number;
  maxBrierScore?: number;
  minRepeatability?: number;
  minPairAgreement?: number;
  maxDrift?: number;
  minimumGoldSamples?: number;
}
export interface JudgeReliabilityReport {
  kind: "dry-run.judge-reliability";
  version: 1;
  id: string;
  createdAt: string;
  threshold: number;
  samples: number;
  targets: number;
  judges: number;
  profiles: JudgeProfile[];
  repeatability: JudgeRepeatability[];
  pairAgreement: JudgePairAgreement[];
  ensemble: EnsembleDecision[];
  drift: JudgeDrift[];
  gate: { passed: boolean; violations: string[] };
}

export class JudgeReliabilityStore {
  readonly dir: string;
  constructor(dir = path.resolve(".dryrun/judges")) { this.dir = path.resolve(dir); ensurePrivateDirectory(this.dir); }
  async save(report: JudgeReliabilityReport): Promise<JudgeReliabilityReport> {
    validateReport(report); const file = this.file(report.id);
    return withFileLock(file, () => { if (existsSync(file)) return validateReport(readJsonFile(file)); atomicWriteJson(file, report); return structuredClone(report); });
  }
  load(id: string): JudgeReliabilityReport { return validateReport(readJsonFile(this.file(id))); }
  list(limit = 100): JudgeReliabilityReport[] {
    const bounded = integer(limit, 1, 2_000, "Judge report limit");
    return existsSync(this.dir) ? readdirSync(this.dir).filter((name) => name.endsWith(".json")).flatMap((name) => { try { return [validateReport(readJsonFile(path.join(this.dir, name)))]; } catch { return []; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, bounded) : [];
  }
  private file(id: string): string { validId(id); return path.join(this.dir, `${id}.json`); }
}

export function analyzeJudgeReliability(observations: JudgeObservation[], options: { policy?: JudgeReliabilityPolicy; baseline?: JudgeObservation[]; bootstrapSamples?: number } = {}): JudgeReliabilityReport {
  if (!observations.length) throw new Error("Judge reliability requires at least one observation");
  const policy = validatePolicy(options.policy ?? {}), threshold = policy.threshold ?? 0.5;
  const current = observations.map((item, index) => normalizeObservation(item, index)), baseline = (options.baseline ?? []).map((item, index) => normalizeObservation(item, index));
  const judgeIds = [...new Set(current.map((item) => item.judgeId))].sort();
  const profiles = judgeIds.map((judgeId) => judgeProfile(judgeId, current.filter((item) => item.judgeId === judgeId), threshold));
  const repeatability = judgeIds.map((judgeId) => judgeRepeatability(judgeId, current.filter((item) => item.judgeId === judgeId)));
  const pairAgreement: JudgePairAgreement[] = [];
  for (let left = 0; left < judgeIds.length; left += 1) for (let right = left + 1; right < judgeIds.length; right += 1) pairAgreement.push(pairwise(judgeIds[left], judgeIds[right], current, threshold));
  const byTarget = group(current, (item) => item.targetId);
  const bootstrapSamples = integer(options.bootstrapSamples ?? 1_000, 100, 20_000, "Bootstrap samples");
  const ensemble = [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([targetId, items]) => ensembleDecision(targetId, items, threshold, bootstrapSamples));
  const drift = judgeDrift(baseline, current, policy.maxDrift ?? 0.2);
  const violations: string[] = [];
  const minGold = policy.minimumGoldSamples ?? 20;
  for (const profile of profiles) {
    const gold = current.filter((item) => item.judgeId === profile.judgeId && item.expected != null).length;
    if (gold && gold < minGold) violations.push(`${profile.judgeId}: only ${gold}/${minGold} gold samples`);
    if (profile.calibration && profile.calibration.expectedCalibrationError > (policy.maxCalibrationError ?? 0.15)) violations.push(`${profile.judgeId}: calibration error ${profile.calibration.expectedCalibrationError}`);
    if (profile.calibration && profile.calibration.brierScore > (policy.maxBrierScore ?? 0.25)) violations.push(`${profile.judgeId}: Brier score ${profile.calibration.brierScore}`);
  }
  for (const item of repeatability) if (item.repeatedTargets && item.repeatability < (policy.minRepeatability ?? 0.8)) violations.push(`${item.judgeId}: repeatability ${item.repeatability}`);
  for (const item of pairAgreement) if (item.overlappingTargets && item.binaryAgreement < (policy.minPairAgreement ?? 0.7)) violations.push(`${item.leftJudgeId}/${item.rightJudgeId}: agreement ${item.binaryAgreement}`);
  for (const item of drift) if (item.drifted) violations.push(`${item.judgeId}: judge drift ${item.ksStatistic}`);
  return validateReport({ kind: "dry-run.judge-reliability", version: 1, id: newId("judge_report"), createdAt: new Date().toISOString(), threshold, samples: current.length, targets: byTarget.size, judges: judgeIds.length, profiles, repeatability, pairAgreement, ensemble, drift, gate: { passed: violations.length === 0, violations } });
}

export function ensembleDecision(targetId: string, observations: JudgeObservation[], threshold = 0.5, bootstrapSamples = 1_000): EnsembleDecision {
  if (!observations.length) throw new Error("Ensemble decision requires observations");
  const normalized = observations.map((item, index) => normalizeObservation(item, index));
  const perJudge = [...group(normalized, (item) => item.judgeId).values()].map((items) => mean(items.map((item) => item.score))).sort((a, b) => a - b);
  const score = trimmedMean(perJudge), interval = deterministicBootstrapInterval(perJudge, bootstrapSamples, stableSeed(targetId));
  const disagreement = standardDeviation(perJudge), passed = score >= threshold;
  return { targetId, judges: perJudge.length, observations: normalized.length, score: round(score), interval95: interval, passed, disagreement: round(disagreement), uncertain: interval[0] < threshold && interval[1] >= threshold };
}

export function judgeDrift(baseline: JudgeObservation[], candidate: JudgeObservation[], threshold = 0.2): JudgeDrift[] {
  const judges = [...new Set(candidate.map((item) => item.judgeId))].sort(), result: JudgeDrift[] = [];
  for (const judgeId of judges) {
    const left = baseline.filter((item) => item.judgeId === judgeId).map((item) => item.score).sort((a, b) => a - b), right = candidate.filter((item) => item.judgeId === judgeId).map((item) => item.score).sort((a, b) => a - b);
    if (!left.length || !right.length) continue;
    const statistic = ks(left, right);
    result.push({ judgeId, baseline: left.length, candidate: right.length, meanScoreDelta: round(mean(right) - mean(left)), ksStatistic: round(statistic), drifted: statistic >= threshold });
  }
  return result;
}

function judgeProfile(judgeId: string, items: JudgeObservation[], threshold: number): JudgeProfile {
  const scores = items.map((item) => item.score), gold = items.filter((item): item is JudgeObservation & { expected: boolean } => item.expected != null);
  return { judgeId, observations: items.length, meanScore: round(mean(scores)), standardDeviation: round(standardDeviation(scores)), averageLatencyMs: round(mean(items.map((item) => item.latencyMs ?? 0))), totalTokens: sum(items.map((item) => item.tokens ?? 0)), ...(gold.length ? { calibration: calibrateScores(gold.map((item) => ({ score: item.score, expected: item.expected })), { threshold }) } : {}) };
}
function judgeRepeatability(judgeId: string, items: JudgeObservation[]): JudgeRepeatability {
  const targets = group(items, (item) => item.targetId), repeated = [...targets.values()].filter((values) => values.length > 1), deviations = repeated.map((values) => standardDeviation(values.map((item) => item.score))), differences = repeated.flatMap((values) => pairDifferences(values.map((item) => item.score)));
  const within = mean(deviations), pairDifference = mean(differences);
  return { judgeId, observations: items.length, targets: targets.size, repeatedTargets: repeated.length, meanWithinTargetStdDev: round(within), meanPairwiseDifference: round(pairDifference), repeatability: round(Math.max(0, 1 - pairDifference)) };
}
function pairwise(leftJudgeId: string, rightJudgeId: string, items: JudgeObservation[], threshold: number): JudgePairAgreement {
  const left = group(items.filter((item) => item.judgeId === leftJudgeId), (item) => item.targetId), right = group(items.filter((item) => item.judgeId === rightJudgeId), (item) => item.targetId);
  const targets = [...left.keys()].filter((target) => right.has(target)).sort(), pairs = targets.map((target) => [mean(left.get(target)!.map((item) => item.score)), mean(right.get(target)!.map((item) => item.score))] as const);
  const agreements = pairs.filter(([a, b]) => (a >= threshold) === (b >= threshold)).length, binaryAgreement = ratio(agreements, pairs.length);
  const leftPositive = ratio(pairs.filter(([value]) => value >= threshold).length, pairs.length), rightPositive = ratio(pairs.filter(([, value]) => value >= threshold).length, pairs.length), expected = leftPositive * rightPositive + (1 - leftPositive) * (1 - rightPositive);
  return { leftJudgeId, rightJudgeId, overlappingTargets: pairs.length, pearson: pairs.length > 1 ? round(pearson(pairs.map(([value]) => value), pairs.map(([, value]) => value))) : null, binaryAgreement: round(binaryAgreement), cohensKappa: pairs.length && expected < 1 ? round((binaryAgreement - expected) / (1 - expected)) : null, meanScoreDifference: round(mean(pairs.map(([a, b]) => a - b))) };
}
function deterministicBootstrapInterval(values: number[], samples: number, seed: number): [number, number] {
  if (values.length === 1) return [round(values[0]), round(values[0])];
  const estimates: number[] = []; let state = seed || 1;
  const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  for (let sample = 0; sample < samples; sample += 1) estimates.push(trimmedMean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)])));
  estimates.sort((a, b) => a - b);
  return [round(quantile(estimates, 0.025)), round(quantile(estimates, 0.975))];
}
function trimmedMean(values: number[]): number { if (!values.length) return 0; const sorted = values.toSorted((a, b) => a - b), trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0; return mean(sorted.slice(trim, sorted.length - trim)); }
function normalizeObservation(value: JudgeObservation, index: number): JudgeObservation {
  if (!value || typeof value.targetId !== "string" || !value.targetId.trim() || value.targetId.length > 512 || typeof value.judgeId !== "string" || !value.judgeId.trim() || value.judgeId.length > 512) throw new Error(`Judge observation ${index + 1} has invalid identifiers`);
  integer(value.run, 1, 1_000_000, `Judge observation ${index + 1} run`); probability(value.score, `Judge observation ${index + 1} score`);
  if (value.latencyMs != null) nonNegative(value.latencyMs, "Judge latencyMs"); if (value.tokens != null) integer(value.tokens, 0, Number.MAX_SAFE_INTEGER, "Judge tokens"); if (value.occurredAt != null && !Number.isFinite(Date.parse(value.occurredAt))) throw new Error("Judge occurredAt must be an ISO timestamp");
  return structuredClone(value);
}
function validatePolicy(value: JudgeReliabilityPolicy): Required<Pick<JudgeReliabilityPolicy, "threshold" | "maxCalibrationError" | "maxBrierScore" | "minRepeatability" | "minPairAgreement" | "maxDrift" | "minimumGoldSamples">> { return { threshold: probability(value.threshold ?? 0.5, "Judge threshold"), maxCalibrationError: probability(value.maxCalibrationError ?? 0.15, "maxCalibrationError"), maxBrierScore: probability(value.maxBrierScore ?? 0.25, "maxBrierScore"), minRepeatability: probability(value.minRepeatability ?? 0.8, "minRepeatability"), minPairAgreement: probability(value.minPairAgreement ?? 0.7, "minPairAgreement"), maxDrift: probability(value.maxDrift ?? 0.2, "maxDrift"), minimumGoldSamples: integer(value.minimumGoldSamples ?? 20, 1, 1_000_000, "minimumGoldSamples") }; }
function validateReport(value: unknown): JudgeReliabilityReport { if (!record(value) || value.kind !== "dry-run.judge-reliability" || value.version !== 1 || typeof value.id !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.profiles) || !Array.isArray(value.repeatability) || !Array.isArray(value.pairAgreement) || !Array.isArray(value.ensemble) || !Array.isArray(value.drift) || !record(value.gate) || typeof value.gate.passed !== "boolean" || !Array.isArray(value.gate.violations)) throw new Error("Invalid judge reliability report"); validId(value.id); return value as unknown as JudgeReliabilityReport; }
function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>(); for (const item of items) result.set(key(item), [...(result.get(key(item)) ?? []), item]); return result; }
function pairDifferences(values: number[]): number[] { const result: number[] = []; for (let a = 0; a < values.length; a += 1) for (let b = a + 1; b < values.length; b += 1) result.push(Math.abs(values[a] - values[b])); return result; }
function pearson(left: number[], right: number[]): number { const lm = mean(left), rm = mean(right), numerator = sum(left.map((value, index) => (value - lm) * (right[index] - rm))), denominator = Math.sqrt(sum(left.map((value) => (value - lm) ** 2)) * sum(right.map((value) => (value - rm) ** 2))); return denominator ? numerator / denominator : 0; }
function ks(left: number[], right: number[]): number { const values = [...new Set([...left, ...right])].sort((a, b) => a - b); let li = 0, ri = 0, result = 0; for (const value of values) { while (li < left.length && left[li] <= value) li += 1; while (ri < right.length && right[ri] <= value) ri += 1; result = Math.max(result, Math.abs(li / left.length - ri / right.length)); } return result; }
function standardDeviation(values: number[]): number { if (values.length < 2) return 0; const average = mean(values); return Math.sqrt(sum(values.map((value) => (value - average) ** 2)) / (values.length - 1)); }
function quantile(sorted: number[], q: number): number { return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))))]; }
function stableSeed(value: string): number { let result = 2166136261; for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619); } return result >>> 0; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function mean(values: number[]): number { return values.length ? sum(values) / values.length : 0; }
function ratio(value: number, total: number): number { return total ? value / total : 0; }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function probability(value: number, name: string): number { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`); return value; }
function nonNegative(value: number, name: string): number { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`); return value; }
function integer(value: number, minimum: number, maximum: number, name: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return value; }
function validId(value: string): void { if (!/^[A-Za-z0-9_.-]{1,192}$/.test(value)) throw new Error("Invalid judge report id"); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
