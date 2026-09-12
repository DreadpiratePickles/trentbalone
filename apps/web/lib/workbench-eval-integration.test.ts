import { describe, expect, it } from "vitest";
import {
  buildWorkbenchEvalScorecard,
  meetsWorkbenchPassRateThreshold,
} from "@/lib/workbench-eval-suite";
import { runWorkbenchIntegrationSuite } from "@/lib/workbench-eval-integration";
import { WORKBENCH_INTEGRATION_OBJECTIVE_IDS } from "@/lib/eval-mock-providers";

describe("workbench integration eval", () => {
  it("runs golden objectives through runWorkbenchAgent with mock providers", async () => {
    const results = await runWorkbenchIntegrationSuite();
    expect(results).toHaveLength(WORKBENCH_INTEGRATION_OBJECTIVE_IDS.length);
    expect(results.every((item) => item.passed)).toBe(true);

    const scorecard = buildWorkbenchEvalScorecard(results);
    expect(scorecard.passRate).toBe(1);
    expect(meetsWorkbenchPassRateThreshold(scorecard, 0.8)).toBe(true);
  }, 120_000);

  it("fails when build verification is deliberately broken", async () => {
    const results = await runWorkbenchIntegrationSuite({ forceBrokenBuild: true });
    expect(results.every((item) => !item.passed)).toBe(true);
    expect(results.some((item) => item.failureTags.includes("build_failed"))).toBe(true);

    const scorecard = buildWorkbenchEvalScorecard(results);
    expect(meetsWorkbenchPassRateThreshold(scorecard, 0.8)).toBe(false);
  }, 120_000);
});
