import { describe, expect, it } from "vitest";
import { hasFatalOrchestrationOutcome } from "@/lib/orchestrator-run-phases";
import type { StepRecord } from "@/lib/orchestrator-runtime";

describe("hasFatalOrchestrationOutcome", () => {
  it("treats blocked and awaiting-approval steps as unresolved fatal outcomes", () => {
    expect(hasFatalOrchestrationOutcome([step("blocked")])).toBe(true);
    expect(hasFatalOrchestrationOutcome([step("awaiting_approval")])).toBe(true);
  });

  it("preserves the existing replan exception for failed steps", () => {
    expect(hasFatalOrchestrationOutcome([step("failed")])).toBe(true);
    expect(hasFatalOrchestrationOutcome([step("failed", { verdict: "replan", reason: "tail replaced" })])).toBe(false);
  });

  it("does not fail runs whose steps completed cleanly", () => {
    expect(hasFatalOrchestrationOutcome([step("completed")])).toBe(false);
  });
});

function step(
  status: StepRecord["status"],
  critique?: StepRecord["critique"],
): StepRecord {
  return {
    id: `s_${status}`,
    title: "Step",
    rationale: "Needed",
    agentRole: "engineer",
    dependsOn: [],
    expectedOutput: "Output",
    riskLevel: "medium",
    needsApproval: false,
    status,
    critique,
  };
}
