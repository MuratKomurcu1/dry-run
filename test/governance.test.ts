import { describe, expect, it } from "vitest";
import { calibrateScores, nominalAgreement } from "../src/evaluation-governance.ts";

describe("evaluation governance statistics", () => {
  it("reports judge calibration, confusion, Brier score, ECE, and Wilson uncertainty", () => {
    const report = calibrateScores([
      { score: 0.95, expected: true },
      { score: 0.8, expected: true },
      { score: 0.65, expected: false },
      { score: 0.2, expected: false },
    ], { threshold: 0.7, bins: 5 });
    expect(report).toMatchObject({ samples: 4, accuracy: 1, confusion: { truePositive: 2, trueNegative: 2, falsePositive: 0, falseNegative: 0 } });
    expect(report.brierScore).toBeGreaterThan(0);
    expect(report.expectedCalibrationError).toBeGreaterThan(0);
    expect(report.accuracyConfidence95.low).toBeLessThan(1);
  });

  it("computes variable-rater nominal agreement and target consensus", () => {
    const report = nominalAgreement([
      { targetId: "a", reviewerId: "one", label: "pass" },
      { targetId: "a", reviewerId: "two", label: "pass" },
      { targetId: "b", reviewerId: "one", label: "fail" },
      { targetId: "b", reviewerId: "two", label: "pass" },
      { targetId: "c", reviewerId: "one", label: "fail" },
      { targetId: "c", reviewerId: "two", label: "fail" },
      { targetId: "c", reviewerId: "three", label: "fail" },
    ]);
    expect(report).toMatchObject({ ratings: 7, reviewers: 3, targets: 3, overlappingTargets: 3, pairComparisons: 5 });
    expect(report.observedAgreement).toBeCloseTo(5 / 7, 6);
    expect(report.krippendorffAlpha).toBe(0.5);
    expect(report.targetConsensus.find((target) => target.targetId === "b")).toMatchObject({ tied: true });
    expect(() => nominalAgreement([{ targetId: "a", reviewerId: "one", label: "pass" }, { targetId: "a", reviewerId: "one", label: "fail" }])).toThrow(/more than once/);
  });
});
