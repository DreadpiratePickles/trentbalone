import { describe, expect, it } from "vitest";
import {
  evaluateRunToCompletion,
  isAutoRunnableStep,
  type RunToCompletionStep,
} from "@/lib/orchestrator-run-to-completion";

function step(overrides: Partial<RunToCompletionStep> = {}): RunToCompletionStep {
  return {
    id: "s1",
    title: "Reversible analysis",
    status: "pending",
    needsApproval: false,
    riskLevel: "low",
    costCents: 0,
    ...overrides,
  };
}

describe("isAutoRunnableStep", () => {
  it("treats approval-gated and high-risk steps as not auto-runnable", () => {
    expect(isAutoRunnableStep(step())).toBe(true);
    expect(isAutoRunnableStep(step({ needsApproval: true }))).toBe(false);
    expect(isAutoRunnableStep(step({ riskLevel: "high" }))).toBe(false);
  });
});

describe("evaluateRunToCompletion", () => {
  it("continues when all remaining steps are reversible and within budget", () => {
    const decision = evaluateRunToCompletion({
      steps: [step({ id: "a" }), step({ id: "b", riskLevel: "medium" })],
      budgetCents: 1000,
      costCents: 100,
    });
    expect(decision.action).toBe("continue");
  });

  it("reports done when no active work remains", () => {
    const decision = evaluateRunToCompletion({
      steps: [step({ status: "completed" }), step({ status: "failed" })],
      budgetCents: 1000,
      costCents: 100,
    });
    expect(decision.action).toBe("done");
  });

  it("pauses at the first approval-gated step and names it", () => {
    const decision = evaluateRunToCompletion({
      steps: [step({ id: "safe" }), step({ id: "gated", title: "Deploy to prod", needsApproval: true })],
      budgetCents: 100000,
      costCents: 0,
    });
    expect(decision.action).toBe("pause");
    expect(decision.blockingStepId).toBe("gated");
    expect(decision.reason).toContain("approval-gated");
  });

  it("pauses at a high-risk step even when budget is fine", () => {
    const decision = evaluateRunToCompletion({
      steps: [step({ id: "risky", title: "Drop table", riskLevel: "high" })],
      budgetCents: 100000,
      costCents: 0,
    });
    expect(decision.action).toBe("pause");
    expect(decision.reason).toContain("high-risk");
  });

  it("pauses when the next step would breach the budget cap", () => {
    const decision = evaluateRunToCompletion({
      steps: [step({ id: "next" })],
      budgetCents: 150,
      costCents: 100,
      perStepEstimateCents: 100,
    });
    expect(decision.action).toBe("pause");
    expect(decision.blockingStepId).toBe("next");
    expect(decision.reason).toContain("budget cap");
  });

  it("does not budget-pause when no cap is configured", () => {
    const decision = evaluateRunToCompletion({
      steps: [step({ id: "next" })],
      budgetCents: 0,
      costCents: 9_999_999,
    });
    expect(decision.action).toBe("continue");
  });

  it("prioritizes the irreversible gate over a budget breach", () => {
    const decision = evaluateRunToCompletion({
      steps: [step({ id: "gated", needsApproval: true }), step({ id: "next" })],
      budgetCents: 1,
      costCents: 100,
    });
    expect(decision.action).toBe("pause");
    expect(decision.blockingStepId).toBe("gated");
    expect(decision.reason).toContain("approval");
  });
});
