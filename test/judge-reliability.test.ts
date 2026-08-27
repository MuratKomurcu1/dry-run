import { describe, expect, it } from "vitest";
import { analyzeJudgeReliability, ensembleDecision, judgeDrift, type JudgeObservation } from "../src/judge-reliability.ts";

describe("judge reliability", () => {
  it("measures calibration, repeatability, pair agreement, uncertainty, and policy gates", () => {
    const observations: JudgeObservation[] = [];
    for (let target = 0; target < 12; target += 1) {
      const expected = target < 6;
      for (const judgeId of ["judge-a", "judge-b"]) for (let run = 1; run <= 2; run += 1) observations.push({ targetId: `case-${target}`, judgeId, run, score: expected ? 0.9 - run * 0.01 : 0.1 + run * 0.01, expected, latencyMs: judgeId === "judge-a" ? 10 : 20, tokens: 5 });
    }
    const report = analyzeJudgeReliability(observations, { policy: { minimumGoldSamples: 12, minRepeatability: 0.95, minPairAgreement: 0.95 } });
    expect(report.gate).toMatchObject({ passed: true, violations: [] });
    expect(report.profiles).toHaveLength(2);
    expect(report.profiles[0].calibration).toMatchObject({ accuracy: 1 });
    expect(report.repeatability.every((item) => item.repeatability >= 0.98)).toBe(true);
    expect(report.pairAgreement[0]).toMatchObject({ binaryAgreement: 1, cohensKappa: 1 });
    expect(report.ensemble).toHaveLength(12);
    expect(report.ensemble.every((decision) => decision.uncertain === false)).toBe(true);
  });

  it("gives every judge equal ensemble weight and marks threshold-crossing uncertainty", () => {
    const decision = ensembleDecision("ambiguous", [
      { targetId: "ambiguous", judgeId: "verbose", run: 1, score: 0.9 },
      { targetId: "ambiguous", judgeId: "verbose", run: 2, score: 0.9 },
      { targetId: "ambiguous", judgeId: "verbose", run: 3, score: 0.9 },
      { targetId: "ambiguous", judgeId: "strict", run: 1, score: 0.1 },
    ], 0.5, 500);
    expect(decision.score).toBe(0.5);
    expect(decision.judges).toBe(2);
    expect(decision.uncertain).toBe(true);
  });

  it("detects judge score distribution drift", () => {
    const baseline = Array.from({ length: 20 }, (_, index) => ({ targetId: `case-${index}`, judgeId: "judge-a", run: 1, score: 0.1 }));
    const candidate = Array.from({ length: 20 }, (_, index) => ({ targetId: `case-${index}`, judgeId: "judge-a", run: 1, score: 0.9 }));
    expect(judgeDrift(baseline, candidate, 0.2)[0]).toMatchObject({ meanScoreDelta: 0.8, ksStatistic: 1, drifted: true });
  });
});
