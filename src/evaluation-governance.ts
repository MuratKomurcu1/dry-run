export interface CalibrationSample {
  score: number;
  expected: boolean;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanScore: number;
  positiveRate: number;
  calibrationError: number;
}

export interface CalibrationReport {
  samples: number;
  threshold: number;
  accuracy: number;
  accuracyConfidence95: { low: number; high: number };
  brierScore: number;
  meanAbsoluteError: number;
  expectedCalibrationError: number;
  confusion: { truePositive: number; trueNegative: number; falsePositive: number; falseNegative: number };
  bins: CalibrationBin[];
}

export interface NominalRating {
  targetId: string;
  reviewerId: string;
  label: string;
}

export interface NominalAgreementReport {
  ratings: number;
  reviewers: number;
  targets: number;
  overlappingTargets: number;
  pairComparisons: number;
  observedAgreement: number | null;
  expectedAgreement: number | null;
  krippendorffAlpha: number | null;
  labels: Array<{ label: string; count: number; rate: number }>;
  targetConsensus: Array<{
    targetId: string;
    ratings: number;
    label?: string;
    agreement: number;
    tied: boolean;
  }>;
}

export function calibrateScores(samples: CalibrationSample[], opts: { threshold?: number; bins?: number } = {}): CalibrationReport {
  if (!samples.length) throw new Error("Calibration requires at least one sample");
  const threshold = probability(opts.threshold ?? 0.5, "Calibration threshold");
  const binCount = integer(opts.bins ?? 10, 2, 100, "Calibration bins");
  const normalized = samples.map((sample, index) => ({ score: probability(sample.score, `Calibration sample ${index + 1} score`), expected: Boolean(sample.expected) }));
  const confusion = { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
  let squared = 0;
  let absolute = 0;
  let correct = 0;
  for (const sample of normalized) {
    const expected = sample.expected ? 1 : 0;
    const predicted = sample.score >= threshold;
    squared += (sample.score - expected) ** 2;
    absolute += Math.abs(sample.score - expected);
    if (predicted === sample.expected) correct += 1;
    if (predicted && sample.expected) confusion.truePositive += 1;
    else if (!predicted && !sample.expected) confusion.trueNegative += 1;
    else if (predicted) confusion.falsePositive += 1;
    else confusion.falseNegative += 1;
  }
  const bins: CalibrationBin[] = [];
  let expectedCalibrationError = 0;
  for (let index = 0; index < binCount; index++) {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    const selected = normalized.filter((sample) => sample.score >= lower && (index === binCount - 1 ? sample.score <= upper : sample.score < upper));
    if (!selected.length) continue;
    const meanScore = mean(selected.map((sample) => sample.score));
    const positiveRate = selected.filter((sample) => sample.expected).length / selected.length;
    const calibrationError = Math.abs(meanScore - positiveRate);
    expectedCalibrationError += selected.length / normalized.length * calibrationError;
    bins.push({ lower: round(lower), upper: round(upper), count: selected.length, meanScore: round(meanScore), positiveRate: round(positiveRate), calibrationError: round(calibrationError) });
  }
  return {
    samples: normalized.length,
    threshold,
    accuracy: round(correct / normalized.length),
    accuracyConfidence95: wilson(correct, normalized.length),
    brierScore: round(squared / normalized.length),
    meanAbsoluteError: round(absolute / normalized.length),
    expectedCalibrationError: round(expectedCalibrationError),
    confusion,
    bins,
  };
}

export function nominalAgreement(ratings: NominalRating[]): NominalAgreementReport {
  const normalized = ratings.map((rating, index) => {
    const targetId = text(rating.targetId, `Rating ${index + 1} targetId`);
    const reviewerId = text(rating.reviewerId, `Rating ${index + 1} reviewerId`);
    const label = text(rating.label, `Rating ${index + 1} label`);
    return { targetId, reviewerId, label };
  });
  const unique = new Set<string>();
  for (const rating of normalized) {
    const key = `${rating.targetId}\0${rating.reviewerId}`;
    if (unique.has(key)) throw new Error(`Reviewer ${rating.reviewerId} rated target ${rating.targetId} more than once`);
    unique.add(key);
  }
  const byTarget = new Map<string, NominalRating[]>();
  const labelCounts = new Map<string, number>();
  for (const rating of normalized) {
    const target = byTarget.get(rating.targetId) ?? [];
    target.push(rating);
    byTarget.set(rating.targetId, target);
    labelCounts.set(rating.label, (labelCounts.get(rating.label) ?? 0) + 1);
  }
  let pairs = 0;
  const targetConsensus = [...byTarget].sort(([left], [right]) => left.localeCompare(right)).map(([targetId, values]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value.label, (counts.get(value.label) ?? 0) + 1);
    const sorted = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const localPairs = values.length * (values.length - 1) / 2;
    const localAgreements = [...counts.values()].reduce((total, count) => total + count * (count - 1) / 2, 0);
    pairs += localPairs;
    const tied = sorted.length > 1 && sorted[0][1] === sorted[1][1];
    return {
      targetId,
      ratings: values.length,
      ...(tied || !sorted.length ? {} : { label: sorted[0][0] }),
      agreement: localPairs ? round(localAgreements / localPairs) : 1,
      tied,
    };
  });
  const coincidenceUnits = [...byTarget.values()].filter((values) => values.length >= 2);
  const coincidenceMarginals = new Map<string, number>();
  let observedDisagreementTotal = 0;
  let coincidences = 0;
  for (const values of coincidenceUnits) {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value.label, (counts.get(value.label) ?? 0) + 1);
    const count = values.length;
    coincidences += count;
    observedDisagreementTotal += (count * count - [...counts.values()].reduce((sum, value) => sum + value * value, 0)) / (count - 1);
    for (const [label, value] of counts) coincidenceMarginals.set(label, (coincidenceMarginals.get(label) ?? 0) + value);
  }
  const observedDisagreement = coincidences ? observedDisagreementTotal / coincidences : null;
  const observedAgreement = observedDisagreement == null ? null : 1 - observedDisagreement;
  const total = normalized.length;
  const expectedDisagreement = coincidences > 1
    ? (coincidences * coincidences - [...coincidenceMarginals.values()].reduce((sum, count) => sum + count * count, 0)) / (coincidences * (coincidences - 1))
    : null;
  const expectedAgreement = expectedDisagreement == null ? null : 1 - expectedDisagreement;
  const alpha = observedDisagreement == null || expectedDisagreement == null
    ? null
    : expectedDisagreement <= Number.EPSILON
      ? observedDisagreement <= Number.EPSILON ? 1 : null
      : 1 - observedDisagreement / expectedDisagreement;
  return {
    ratings: total,
    reviewers: new Set(normalized.map((rating) => rating.reviewerId)).size,
    targets: byTarget.size,
    overlappingTargets: [...byTarget.values()].filter((values) => values.length >= 2).length,
    pairComparisons: pairs,
    observedAgreement: observedAgreement == null ? null : round(observedAgreement),
    expectedAgreement: expectedAgreement == null ? null : round(expectedAgreement),
    krippendorffAlpha: alpha == null ? null : round(alpha),
    labels: [...labelCounts].sort(([left], [right]) => left.localeCompare(right)).map(([label, count]) => ({ label, count, rate: total ? round(count / total) : 0 })),
    targetConsensus,
  };
}

function wilson(successes: number, total: number): { low: number; high: number } {
  if (!total) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { low: round(Math.max(0, center - margin)), high: round(Math.min(1, center + margin)) };
}
function mean(values: number[]): number { return values.reduce((total, value) => total + value, 0) / values.length; }
function probability(value: number, name: string): number { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`); return value; }
function integer(value: number, minimum: number, maximum: number, name: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return value; }
function text(value: string, name: string): string { if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${name} must contain 1-512 characters`); return value.trim(); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
