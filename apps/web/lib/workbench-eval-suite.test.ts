import { describe, expect, it } from "vitest";
import {
  buildWorkbenchEvalScorecard,
  buildWorkbenchGoldenObjectives,
  buildWorkbenchSmokeResults,
  scoreWorkbenchObjective,
} from "@/lib/workbench-eval-suite";

describe("workbench eval suite", () => {
  it("defines 10-20 golden objectives with measurable criteria", () => {
    const objectives = buildWorkbenchGoldenObjectives();
    expect(objectives.length).toBeGreaterThanOrEqual(10);
    expect(objectives.length).toBeLessThanOrEqual(20);
    for (const item of objectives) {
      expect(item.id).toMatch(/^wb_/);
      expect(item.objective.length).toBeGreaterThan(10);
      expect(item.difficulty).toMatch(/^(easy|medium|hard)$/);
    }
  });

  it("scores build-clean + interactions + critic + non-blank screenshot", () => {
    const passed = scoreWorkbenchObjective({
      objectiveId: "wb_countdown",
      buildClean: true,
      interactionsPass: true,
      criticPass: true,
      screenshotNonBlank: true,
      attempts: 1,
      costCents: 42,
      wallClockMs: 120_000,
    });
    expect(passed.passed).toBe(true);
    expect(passed.qualityScore).toBe(1);

    const potemkin = scoreWorkbenchObjective({
      objectiveId: "wb_todo",
      buildClean: true,
      interactionsPass: false,
      criticPass: true,
      screenshotNonBlank: true,
      attempts: 2,
      costCents: 80,
      wallClockMs: 180_000,
    });
    expect(potemkin.passed).toBe(false);
    expect(potemkin.failureTags).toContain("interactions_failed");
    expect(potemkin.qualityScore).toBe(0.75);
  });

  it("builds a scorecard with pass-rate and medians", () => {
    const results = buildWorkbenchSmokeResults();
    const scorecard = buildWorkbenchEvalScorecard(results);
    expect(scorecard.suite).toBe("workbench");
    expect(scorecard.objectiveCount).toBe(results.length);
    expect(scorecard.passRate).toBeGreaterThanOrEqual(0);
    expect(scorecard.passRate).toBeLessThanOrEqual(1);
    expect(typeof scorecard.medianAttempts).toBe("number");
    expect(typeof scorecard.medianCostCents).toBe("number");
    expect(typeof scorecard.medianWallClockMs).toBe("number");
    expect(scorecard.averageQualityScore).toBeGreaterThanOrEqual(0);
    expect(scorecard.averageQualityScore).toBeLessThanOrEqual(1);
    expect(Array.isArray(scorecard.objectives)).toBe(true);
  });

  it("smoke results pass the full verification contract", () => {
    const results = buildWorkbenchSmokeResults();
    expect(results.every((item) => item.passed)).toBe(true);
    const scorecard = buildWorkbenchEvalScorecard(results);
    expect(scorecard.passRate).toBe(1);
    expect(scorecard.averageQualityScore).toBe(1);
  });
});
