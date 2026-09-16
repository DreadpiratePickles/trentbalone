import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGoalFindUnique, mockTaskFindMany } = vi.hoisted(() => ({
  mockGoalFindUnique: vi.fn(),
  mockTaskFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    goal: { findUnique: mockGoalFindUnique },
    task: { findMany: mockTaskFindMany },
  },
}));

import { computeGoalProgress, getGoalProgress } from "@/lib/goal-store";
import type { Goal } from "@/lib/goal-types";

function goalRow(overrides: Partial<{ successCriteria: unknown }> = {}) {
  return {
    id: "goal_1",
    companyId: "co_1",
    objective: "Reach 100 paying customers",
    status: "active",
    successCriteria: [
      { id: "c1", text: "Pricing page live", status: "met", evidenceArtifactIds: ["art_1"] },
      { id: "c2", text: "Checkout works", status: "unmet", evidenceArtifactIds: [] },
    ],
    constraints: {},
    rounds: [],
    progressLog: [],
    costCents: 0,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function goalOf(): Goal {
  return {
    id: "goal_1",
    companyId: "co_1",
    objective: "Reach 100 paying customers",
    status: "active",
    successCriteria: [
      { id: "c1", text: "Pricing page live", status: "met", evidenceArtifactIds: ["art_1"] },
      { id: "c2", text: "Checkout works", status: "unmet", evidenceArtifactIds: [] },
    ],
    constraints: { budgetCentsCap: 5000, approvalsPolicy: "gate_each_round" },
    rounds: [],
    progressLog: [],
    costCents: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("computeGoalProgress", () => {
  it("is done/total over linked tasks when any exist: 4 tasks, 1 completed is 25 percent", () => {
    const progress = computeGoalProgress(goalOf(), [
      { status: "completed" },
      { status: "queued" },
      { status: "running" },
      { status: "failed" },
    ]);
    expect(progress).toEqual({ source: "tasks", done: 1, total: 4, percent: 25 });
  });

  it("falls back to the criteria count when no tasks are linked", () => {
    const progress = computeGoalProgress(goalOf(), []);
    expect(progress).toEqual({ source: "criteria", done: 1, total: 2, percent: 50 });
  });

  it("does not divide by zero for a goal with neither tasks nor criteria", () => {
    const goal = { ...goalOf(), successCriteria: [] };
    expect(computeGoalProgress(goal, [])).toEqual({ source: "criteria", done: 0, total: 0, percent: 0 });
  });
});

describe("getGoalProgress", () => {
  beforeEach(() => {
    mockGoalFindUnique.mockReset();
    mockTaskFindMany.mockReset();
  });

  it("loads the tasks linked to the goal by goalId and rolls them up", async () => {
    mockGoalFindUnique.mockResolvedValue(goalRow());
    mockTaskFindMany.mockResolvedValue([
      { status: "completed" },
      { status: "queued" },
      { status: "queued" },
      { status: "blocked" },
    ]);

    const progress = await getGoalProgress("goal_1");

    expect(mockTaskFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { goalId: "goal_1" } }));
    expect(progress).toEqual({ source: "tasks", done: 1, total: 4, percent: 25 });
  });

  it("keeps criteria semantics when the goal has no linked tasks", async () => {
    mockGoalFindUnique.mockResolvedValue(goalRow());
    mockTaskFindMany.mockResolvedValue([]);

    expect(await getGoalProgress("goal_1")).toEqual({ source: "criteria", done: 1, total: 2, percent: 50 });
  });

  it("returns null for an unknown goal", async () => {
    mockGoalFindUnique.mockResolvedValue(null);
    expect(await getGoalProgress("goal_missing")).toBeNull();
    expect(mockTaskFindMany).not.toHaveBeenCalled();
  });
});
