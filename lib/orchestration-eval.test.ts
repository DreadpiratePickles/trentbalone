import { describe, expect, it } from "vitest";
import {
  buildOrchestrationEvalScorecard,
  buildOrchestrationGoldenObjectives,
  buildOrchestrationSmokeRuns,
  compareOrchestrationReproducibility,
  scoreOrchestrationRun,
  validateOrchestrationPlanDag,
} from "@/lib/orchestration-eval";
import type { OrchestrationStep } from "@/lib/orchestrator-runtime";

describe("orchestration eval", () => {
  it("defines 10-20 golden objectives", () => {
    const objectives = buildOrchestrationGoldenObjectives();
    expect(objectives.length).toBeGreaterThanOrEqual(10);
    expect(objectives.length).toBeLessThanOrEqual(20);
    for (const item of objectives) {
      expect(item.id).toMatch(/^orc_/);
      expect(item.objective.length).toBeGreaterThan(10);
    }
  });

  it("validates a well-formed DAG and rejects cycles and orphan deps", () => {
    const valid: OrchestrationStep[] = [
      step("s1", []),
      step("s2", ["s1"]),
      step("s3", ["s1"]),
      step("s4", ["s2", "s3"]),
    ];
    expect(validateOrchestrationPlanDag(valid)).toEqual({ valid: true, issues: [] });

    const cycle: OrchestrationStep[] = [
      step("s1", ["s2"]),
      step("s2", ["s1"]),
    ];
    expect(validateOrchestrationPlanDag(cycle).valid).toBe(false);
    expect(validateOrchestrationPlanDag(cycle).issues).toContain("cycle_detected");

    const orphan: OrchestrationStep[] = [step("s1", ["missing"])];
    expect(validateOrchestrationPlanDag(orphan).valid).toBe(false);
    expect(validateOrchestrationPlanDag(orphan).issues).toContain("unknown_dependency");
  });

  it("scores plan validity, step success, objective achievement, cost, and wall-clock", () => {
    const scored = scoreOrchestrationRun({
      objectiveId: "orc_weekly_ops",
      planValid: true,
      stepSuccessRate: 1,
      objectiveAchieved: true,
      costCents: 120,
      wallClockMs: 45_000,
    });
    expect(scored.passed).toBe(true);

    const failed = scoreOrchestrationRun({
      objectiveId: "orc_launch_email",
      planValid: false,
      stepSuccessRate: 0.5,
      objectiveAchieved: false,
      costCents: 300,
      wallClockMs: 90_000,
    });
    expect(failed.passed).toBe(false);
    expect(failed.failureTags).toContain("invalid_plan");
  });

  it("compares reproducibility across two runs of the same objective", () => {
    const runA = scoreOrchestrationRun({
      objectiveId: "orc_churn",
      planValid: true,
      stepSuccessRate: 1,
      objectiveAchieved: true,
      costCents: 100,
      wallClockMs: 30_000,
    });
    const runB = scoreOrchestrationRun({
      objectiveId: "orc_churn",
      planValid: true,
      stepSuccessRate: 1,
      objectiveAchieved: true,
      costCents: 110,
      wallClockMs: 32_000,
    });
    expect(compareOrchestrationReproducibility(runA, runB).score).toBe(1);

    const drift = scoreOrchestrationRun({
      objectiveId: "orc_churn",
      planValid: true,
      stepSuccessRate: 0.4,
      objectiveAchieved: false,
      costCents: 400,
      wallClockMs: 120_000,
    });
    expect(compareOrchestrationReproducibility(runA, drift).score).toBeLessThan(1);
  });

  it("builds a scorecard JSON with reproducibility median", () => {
    const runs = buildOrchestrationSmokeRuns();
    const scorecard = buildOrchestrationEvalScorecard(runs);
    expect(scorecard.suite).toBe("orchestration");
    expect(scorecard.objectiveCount).toBe(runs.length);
    expect(scorecard.passRate).toBe(1);
    expect(typeof scorecard.medianReproducibility).toBe("number");
    expect(typeof scorecard.medianCostCents).toBe("number");
    expect(typeof scorecard.medianWallClockMs).toBe("number");
  });
});

function step(id: string, dependsOn: string[]): OrchestrationStep {
  return {
    id,
    title: id,
    rationale: "test",
    agentRole: "ceo",
    dependsOn,
    expectedOutput: "done",
    riskLevel: "low",
    needsApproval: false,
  };
}
