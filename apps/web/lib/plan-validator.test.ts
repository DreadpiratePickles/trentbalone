import { describe, expect, it } from "vitest";
import { validateOrchestrationPlan, validatePlan } from "@/lib/plan-validator";
import type { Subtask } from "@/lib/planner";
import type { OrchestrationPlan } from "@/lib/orchestrator-runtime";

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: "sub_1",
    seat: "analyst",
    objective: "Analyze churn risk",
    outputContractId: "analyst.v1",
    toolGuidance: [],
    boundaries: [],
    dependsOn: [],
    spec: { acceptance: ["Churn risks are summarized"], inputsFrom: [] },
    input: {},
    contextBundle: {},
    classification: { type: "analysis", complexity: "standard", reversibility: "reversible" },
    budgetCents: 10,
    ...overrides,
  };
}

describe("validatePlan", () => {
  const seatRoster = ["analyst", "engineer", "escalation"] as const;

  it("passes a clean subtask plan", () => {
    expect(validatePlan([subtask()], { seatRoster: [...seatRoster], budgetCapCents: 20 })).toEqual({ ok: true });
  });

  it("rejects cyclic dependencies", () => {
    const result = validatePlan([
      subtask({ id: "sub_a", dependsOn: ["sub_b"] }),
      subtask({ id: "sub_b", dependsOn: ["sub_a"] }),
    ], { seatRoster: [...seatRoster], budgetCapCents: 50 });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "cycle" })],
    });
  });

  it("rejects dangling dependencies", () => {
    const result = validatePlan([subtask({ dependsOn: ["sub_missing"] })], {
      seatRoster: [...seatRoster],
      budgetCapCents: 20,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "dangling_dependency", ids: ["sub_missing"] })],
    });
  });

  it("rejects seats outside the provided roster", () => {
    const result = validatePlan([subtask({ seat: "growth" })], {
      seatRoster: [...seatRoster],
      budgetCapCents: 20,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "off_roster_seat", ids: ["sub_1"] })],
    });
  });

  it("rejects plans whose total budget exceeds the cap", () => {
    const result = validatePlan([
      subtask({ id: "sub_a", budgetCents: 15 }),
      subtask({ id: "sub_b", budgetCents: 10 }),
    ], { seatRoster: [...seatRoster], budgetCapCents: 20 });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "budget_over_cap", totalBudgetCents: 25, budgetCapCents: 20 })],
    });
  });

  it("rejects missing acceptance criteria", () => {
    const result = validatePlan([subtask({ spec: { acceptance: [], inputsFrom: [] } })], {
      seatRoster: [...seatRoster],
      budgetCapCents: 20,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "missing_acceptance", ids: ["sub_1"] })],
    });
  });

  it("rejects irreversible work without an escalation subtask", () => {
    const result = validatePlan([
      subtask({ classification: { type: "deploy", complexity: "complex", reversibility: "irreversible" } }),
    ], { seatRoster: [...seatRoster], budgetCapCents: 20 });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "missing_escalation" })],
    });
  });
});

describe("validateOrchestrationPlan", () => {
  it("rejects orchestration plans with invalid DAG edges before execution", () => {
    const plan: OrchestrationPlan = {
      objective: "Ship the thing",
      reasoning: "test",
      successCriteria: ["complete"],
      blockers: [],
      steps: [
        {
          id: "s1",
          title: "Build",
          rationale: "build it",
          agentRole: "engineer",
          dependsOn: ["s2"],
          expectedOutput: "Built app",
          riskLevel: "medium",
          needsApproval: false,
          spec: { acceptance: ["App is built"], inputsFrom: [] },
        } as OrchestrationPlan["steps"][number],
      ],
    };

    expect(validateOrchestrationPlan(plan, { seatRoster: ["engineer"], budgetCapCents: 100 })).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "dangling_dependency" })],
    });
  });
});
