import { describe, expect, it } from "vitest";
import { buildRecordedHandoffEvent, hasFatalOrchestrationOutcome } from "@/lib/orchestrator-run-phases";
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

describe("buildRecordedHandoffEvent", () => {
  it("preserves upstream next actions, risks, and explicit non-work in handoff audit events", () => {
    const event = buildRecordedHandoffEvent({
      cycleId: "run_1",
      depId: "s1",
      stepId: "s2",
      from: "analyst",
      to: "growth",
      toStepTitle: "Draft growth experiment",
      timestamp: "2026-06-11T00:00:00.000Z",
      handoff: {
        stepId: "s1",
        seat: "analyst",
        summary: "Research complete.",
        keyPoints: ["Enterprise teams have the strongest pain."],
        nextActions: ["Test founder-led LinkedIn copy."],
        risks: ["Survey sample is small."],
        whatIDidNotDo: ["Did not contact prospects."],
        artifactRefs: ["artifact_research"],
        contractVersion: "v1",
      },
    });

    expect(event).toMatchObject({
      reason: "structured handoff s1 → s2",
      summary: "Research complete.",
      nextActions: ["Test founder-led LinkedIn copy."],
      risks: ["Survey sample is small."],
      whatIDidNotDo: ["Did not contact prospects."],
      payloadRef: "artifact_research",
    });
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
