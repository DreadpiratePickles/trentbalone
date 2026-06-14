import { describe, expect, it } from "vitest";
import {
  buildRecordedHandoffEvent,
  buildSeatToolApprovalRequest,
  hasFatalOrchestrationOutcome,
  shouldCompleteAfterCriticInfrastructureFailure,
} from "@/lib/orchestrator-run-phases";
import { SeatLoopAwaitingApprovalError, type StepRecord } from "@/lib/orchestrator-runtime";

describe("shouldCompleteAfterCriticInfrastructureFailure (critic-failure safety policy)", () => {
  const infraFailure = {
    verdict: "escalate",
    reason: "critic LLM call failed: gpt-4.1-mini response failed schema validation: Expected string, received boolean",
  };

  it("completes a low-risk step with usable output when only the critic infra failed", () => {
    expect(shouldCompleteAfterCriticInfrastructureFailure(
      { output: "Real, usable tool-backed output.", riskLevel: "low" },
      infraFailure,
    )).toBe(true);
  });

  it("does NOT auto-complete a high-risk step even when the critic infra failed", () => {
    expect(shouldCompleteAfterCriticInfrastructureFailure(
      { output: "Output exists but the action is dangerous.", riskLevel: "high" },
      infraFailure,
    )).toBe(false);
  });

  it("does NOT auto-complete when there is no usable output", () => {
    expect(shouldCompleteAfterCriticInfrastructureFailure(
      { output: "   ", riskLevel: "low" },
      infraFailure,
    )).toBe(false);
  });

  it("does NOT treat a genuine escalate judgment (not an infra failure) as auto-completable", () => {
    expect(shouldCompleteAfterCriticInfrastructureFailure(
      { output: "Output.", riskLevel: "low" },
      { verdict: "escalate", reason: "This step leaks customer PII and must not ship." },
    )).toBe(false);
  });
});

describe("hasFatalOrchestrationOutcome", () => {
  it("treats blocked and awaiting-approval steps as unresolved fatal outcomes", () => {
    expect(hasFatalOrchestrationOutcome([step("blocked")])).toBe(true);
    expect(hasFatalOrchestrationOutcome([step("awaiting_approval")])).toBe(true);
  });

  it("does not fail runs for blocked tool-denial steps with usable guidance", () => {
    expect(hasFatalOrchestrationOutcome([
      {
        ...step("blocked"),
        output: "The escalation seat is not permitted to create an audit using the audit:create tool. Route the audit creation task to a permitted seat.",
      },
    ])).toBe(false);
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

describe("buildSeatToolApprovalRequest", () => {
  it("returns undefined for stale pauses without a needs-approval tool record", () => {
    const err = new SeatLoopAwaitingApprovalError({
      seatLoopState: {
        toolCalls: [
          {
            adapter: "analytics:read_mock",
            action: "read mock analytics",
            status: "failed",
            summary: "Tool is not allowed for this seat.",
          },
        ],
        loopStep: 3,
        tokens: 120,
        costCents: 1,
        model: "gpt-4o-mini",
        pendingToolCall: { name: "analytics:read_mock", action: "read mock analytics" },
      },
      toolCalls: [
        {
          adapter: "analytics:read_mock",
          action: "read mock analytics",
          status: "failed",
          summary: "Tool is not allowed for this seat.",
        },
      ],
      tokens: 120,
      costCents: 1,
      model: "gpt-4o-mini",
    });

    expect(buildSeatToolApprovalRequest(err)).toBeUndefined();
  });

  it("builds an approval request only from a real needs-approval tool record", () => {
    const err = new SeatLoopAwaitingApprovalError({
      seatLoopState: {
        toolCalls: [
          {
            adapter: "Stripe",
            action: "charge $50",
            status: "needs_approval",
            summary: "Stripe charge requires approval.",
          },
        ],
        loopStep: 2,
        tokens: 80,
        costCents: 1,
        model: "gpt-4o-mini",
        pendingToolCall: { name: "Stripe", action: "charge $50" },
      },
      toolCalls: [
        {
          adapter: "Stripe",
          action: "charge $50",
          status: "needs_approval",
          summary: "Stripe charge requires approval.",
        },
      ],
      tokens: 80,
      costCents: 1,
      model: "gpt-4o-mini",
    });

    expect(buildSeatToolApprovalRequest(err)).toEqual({
      adapter: "Stripe",
      action: "charge $50",
      summary: "Stripe charge requires approval.",
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
