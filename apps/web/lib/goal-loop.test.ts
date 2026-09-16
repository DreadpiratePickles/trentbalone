import { describe, expect, it, vi, beforeEach } from "vitest";
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import type { Goal } from "@/lib/goal-types";

const { mockExecuteStep, mockGetGoal, mockUpdateGoal, mockAddGoalRound, mockAppendGoalProgress } = vi.hoisted(() => ({
  mockExecuteStep: vi.fn(),
  mockGetGoal: vi.fn(),
  mockUpdateGoal: vi.fn(),
  mockAddGoalRound: vi.fn(),
  mockAppendGoalProgress: vi.fn(),
}));

vi.mock("@/lib/goal-store", () => ({
  getGoal: mockGetGoal,
  updateGoal: mockUpdateGoal,
  addGoalRound: mockAddGoalRound,
  appendGoalProgress: mockAppendGoalProgress,
}));

vi.mock("@/lib/orchestrator-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator-runtime")>();
  return { ...actual, executeStepWithRuntime: mockExecuteStep };
});

vi.mock("@/lib/operating-state", () => ({
  buildOperatingStateBundle: vi.fn(async () => ({
    text: "no open tasks",
    openTaskCount: 0,
    staleTaskCount: 0,
    pendingApprovalCount: 0,
    budgetRemainingCents: 5000,
    spentCents: 0,
    memoryItemCount: 0,
  })),
}));

// Planner, critic and reviewer all go through callJsonWithRepair. Rejecting with
// LlmJsonError exercises the deterministic keyword-fallback plan, the critic
// auto-pass and the degraded review, so the round runs without a model.
vi.mock("@/lib/llm-json", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-json")>();
  return {
    ...actual,
    callJsonWithRepair: vi.fn(async () => {
      throw new actual.LlmJsonError("planner offline in test");
    }),
  };
});

vi.mock("@/lib/self-improvement/goal-reflection", () => ({
  deriveSkillDraftsFromGoalRound: vi.fn(async () => []),
}));

import { runGoalRound } from "@/lib/goal-loop";

function goalFor(companyId: string): Goal {
  const at = nowIso();
  return {
    id: makeId("goal"),
    companyId,
    objective: "Ship the onboarding API and write the launch blog post",
    status: "active",
    successCriteria: [
      { id: "c1", text: "Build the onboarding API endpoint", status: "unmet", evidenceArtifactIds: [] },
      { id: "c2", text: "Publish a launch blog post", status: "unmet", evidenceArtifactIds: [] },
    ],
    constraints: { budgetCentsCap: 5000, approvalsPolicy: "gate_each_round" },
    rounds: [],
    progressLog: [],
    costCents: 0,
    createdAt: at,
    updatedAt: at,
  };
}

describe("runGoalRound links the round to a real Cycle and Tasks", () => {
  beforeEach(() => {
    mockExecuteStep.mockReset();
    mockExecuteStep.mockImplementation(async (input: { step: { id: string; agentRole: string } }) => ({
      output: `Concrete deliverable for ${input.step.id} produced by ${input.step.agentRole} with enough body to persist.`,
      handoff: { summary: "", nextActions: [], risks: [] },
      model: "test-model",
      tokens: 10,
      costCents: 3,
      toolCalls: [],
      execution: { id: makeId("exec"), status: "completed" },
    }));
    mockUpdateGoal.mockResolvedValue(null);
    mockAddGoalRound.mockResolvedValue(undefined);
    mockAppendGoalProgress.mockResolvedValue(undefined);
  });

  it("creates a Cycle whose goalId is the goal, and never passes the goal id as a cycle id", async () => {
    const company = await store.createCompany({
      name: `Goal Loop ${makeId("test")}`,
      brief: { vision: "Link goals to cycles" },
      cycleFrequency: "manual",
    });
    const goal = goalFor(company.id);
    mockGetGoal.mockResolvedValue(goal);

    const result = await runGoalRound(goal.id);
    expect(result.roundN).toBe(1);

    const cycles = await store.listCycles(company.id);
    const roundCycle = cycles.find((c) => c.goalId === goal.id);
    expect(roundCycle).toBeDefined();
    expect(roundCycle?.kind).toBe("ad_hoc_dag");
    expect(roundCycle?.status).toBe("completed");

    expect(mockExecuteStep).toHaveBeenCalled();
    for (const call of mockExecuteStep.mock.calls) {
      const input = call[0] as { cycleId?: string };
      expect(input.cycleId).not.toBe(goal.id);
      expect(input.cycleId).toBe(roundCycle?.id);
    }
  });

  it("creates one Task per planned step linked to both the goal and the round cycle", async () => {
    const company = await store.createCompany({
      name: `Goal Loop ${makeId("test")}`,
      brief: { vision: "Link goals to tasks" },
      cycleFrequency: "manual",
    });
    const goal = goalFor(company.id);
    mockGetGoal.mockResolvedValue(goal);

    await runGoalRound(goal.id);

    const tasks = (await store.listTasks(company.id)).filter((t) => t.goalId === goal.id);
    expect(tasks.length).toBe(goal.successCriteria.length);
    const cycles = await store.listCycles(company.id);
    const roundCycle = cycles.find((c) => c.goalId === goal.id);
    for (const task of tasks) {
      expect(task.cycleId).toBe(roundCycle?.id);
      expect(task.status).toBe("completed");
      expect(task.costCents).toBe(3);
    }
  });

  it("marks the task failed when the step produced no artifact", async () => {
    mockExecuteStep.mockImplementation(async () => ({
      output: "",
      handoff: { summary: "", nextActions: [], risks: [] },
      model: "test-model",
      tokens: 0,
      costCents: 0,
      toolCalls: [],
      execution: { id: makeId("exec"), status: "failed" },
    }));
    const company = await store.createCompany({
      name: `Goal Loop ${makeId("test")}`,
      brief: { vision: "Failed steps fail their task" },
      cycleFrequency: "manual",
    });
    const goal = goalFor(company.id);
    mockGetGoal.mockResolvedValue(goal);

    await runGoalRound(goal.id);

    const tasks = (await store.listTasks(company.id)).filter((t) => t.goalId === goal.id);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task.status).toBe("failed");
  });
});
