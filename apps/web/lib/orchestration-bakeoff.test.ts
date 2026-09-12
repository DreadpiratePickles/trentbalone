import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultBakeoffVariants,
  recommendVariant,
  runOrchestrationBakeoff,
  type BakeoffVariantResult,
} from "@/lib/orchestration-bakeoff";
import {
  buildOrchestrationEvalScorecard,
  buildOrchestrationSmokeReproducibility,
  scoreOrchestrationRun,
  type OrchestrationEvalResult,
} from "@/lib/orchestration-eval";

function passingResult(objectiveId: string, costCents = 10): OrchestrationEvalResult {
  return scoreOrchestrationRun({
    objectiveId,
    planValid: true,
    stepSuccessRate: 1,
    objectiveAchieved: true,
    costCents,
    wallClockMs: 100,
  });
}

function failingResult(objectiveId: string): OrchestrationEvalResult {
  return scoreOrchestrationRun({
    objectiveId,
    planValid: false,
    stepSuccessRate: 0.5,
    objectiveAchieved: false,
    costCents: 10,
    wallClockMs: 100,
  });
}

function variantResult(variantId: string, results: OrchestrationEvalResult[]): BakeoffVariantResult {
  return {
    variantId,
    description: variantId,
    scorecard: buildOrchestrationEvalScorecard(results, buildOrchestrationSmokeReproducibility(results)),
    quarantinedCount: 0,
    wallClockMs: 500,
  };
}

afterEach(() => {
  delete process.env.CRITIC_RUBRIC_ENABLED;
  delete process.env.ORCHESTRATION_PLAN_VALIDATOR_ENABLED;
});

describe("runOrchestrationBakeoff", () => {
  it("applies each variant's env for its suite run and restores afterwards (undefined => deleted)", async () => {
    delete process.env.CRITIC_RUBRIC_ENABLED;
    const seen: Array<string | undefined> = [];
    const runSuite = vi.fn(async () => {
      seen.push(process.env.CRITIC_RUBRIC_ENABLED);
      return [passingResult("orc_a")];
    });

    const report = await runOrchestrationBakeoff({
      runSuite,
      variants: [
        { id: "baseline", description: "off", env: { CRITIC_RUBRIC_ENABLED: "" } },
        { id: "rubric", description: "on", env: { CRITIC_RUBRIC_ENABLED: "1" } },
      ],
    });

    expect(seen).toEqual([undefined, "1"]);
    // Restore must DELETE a previously-unset var, not store the string "undefined".
    expect(process.env.CRITIC_RUBRIC_ENABLED).toBeUndefined();
    expect("CRITIC_RUBRIC_ENABLED" in process.env).toBe(false);
    expect(report.variants).toHaveLength(2);
  });

  it("excludes quarantined results from each variant's scorecard", async () => {
    const runSuite = vi.fn(async () => [
      passingResult("orc_a"),
      { ...failingResult("orcgolden_q"), quarantined: true },
    ]);

    const report = await runOrchestrationBakeoff({
      runSuite,
      variants: [{ id: "baseline", description: "b", env: {} }],
    });

    expect(report.variants[0]!.scorecard.passRate).toBe(1);
    expect(report.variants[0]!.quarantinedCount).toBe(1);
  });

  it("ships four default variants covering each dark flag alone and combined", () => {
    const ids = defaultBakeoffVariants().map((variant) => variant.id);
    expect(ids).toEqual(["baseline", "rubric_critic", "plan_validator", "rubric_plus_validator"]);
  });
});

describe("recommendVariant", () => {
  it("recommends the variant with the higher pass rate", () => {
    const recommendation = recommendVariant([
      variantResult("baseline", [passingResult("a"), failingResult("b")]),
      variantResult("rubric_critic", [passingResult("a"), passingResult("b")]),
    ]);

    expect(recommendation.variantId).toBe("rubric_critic");
    expect(recommendation.rationale).toContain("No auto-promotion");
  });

  it("breaks pass-rate ties on median cost", () => {
    const recommendation = recommendVariant([
      variantResult("baseline", [passingResult("a", 20)]),
      variantResult("cheaper", [passingResult("a", 5)]),
    ]);

    expect(recommendation.variantId).toBe("cheaper");
  });

  it("keeps the baseline when variants are indistinguishable", () => {
    const recommendation = recommendVariant([
      variantResult("baseline", [passingResult("a")]),
      variantResult("identical", [passingResult("a")]),
    ]);

    expect(recommendation.variantId).toBe("baseline");
  });
});
