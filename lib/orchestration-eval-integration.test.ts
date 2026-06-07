import { describe, expect, it } from "vitest";
import {
  buildOrchestrationEvalScorecard,
  meetsOrchestrationPassRateThreshold,
} from "@/lib/orchestration-eval";
import { runOrchestrationIntegrationSuite } from "@/lib/orchestration-eval-integration";
import { ORCHESTRATION_INTEGRATION_OBJECTIVE_IDS } from "@/lib/eval-mock-providers";

describe("orchestration integration eval", () => {
  it("runs golden objectives through real orchestration paths with mock providers", async () => {
    const results = await runOrchestrationIntegrationSuite();
    expect(results).toHaveLength(ORCHESTRATION_INTEGRATION_OBJECTIVE_IDS.length);
    expect(results.every((item) => item.passed)).toBe(true);

    const scorecard = buildOrchestrationEvalScorecard(results);
    expect(scorecard.passRate).toBe(1);
    expect(meetsOrchestrationPassRateThreshold(scorecard, 0.9)).toBe(true);
  }, 120_000);

  it("fails when execution is deliberately broken", async () => {
    const results = await runOrchestrationIntegrationSuite({ forceBrokenExecution: true });
    expect(results.some((item) => !item.passed)).toBe(true);
    expect(results.some((item) => item.failureTags.includes("step_failures"))).toBe(true);

    const scorecard = buildOrchestrationEvalScorecard(results);
    expect(meetsOrchestrationPassRateThreshold(scorecard, 0.9)).toBe(false);
  }, 120_000);
});
