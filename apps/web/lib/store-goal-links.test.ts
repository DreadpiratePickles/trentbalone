import { describe, expect, it } from "vitest";
import { memStore } from "@/lib/mem-store";
import { mapCycle, mapTask } from "@/lib/prisma-store-mappers";
import { makeId, nowIso } from "@/lib/utils";

describe("task and cycle goal links round-trip through the in-memory store", () => {
  it("keeps goalId and cycleId on a created task and after an update", async () => {
    const company = await memStore.createCompany({
      name: `Links ${makeId("test")}`,
      brief: { vision: "Link tasks to goals" },
      cycleFrequency: "manual",
    });
    const cycle = await memStore.saveCycle({
      id: makeId("cycle"),
      companyId: company.id,
      trigger: "manual",
      kind: "ad_hoc_dag",
      status: "running",
      phases: [],
      summary: "goal round",
      goalId: "goal_abc",
      startedAt: nowIso(),
    });
    expect(cycle.goalId).toBe("goal_abc");
    expect((await memStore.listCycles(company.id)).find((c) => c.id === cycle.id)?.goalId).toBe("goal_abc");

    const task = await memStore.createTask({
      companyId: company.id,
      title: "Do the thing",
      prompt: "Do the thing",
      status: "queued",
      priority: "medium",
      agentRole: "engineer",
      tags: [],
      goalId: "goal_abc",
      cycleId: cycle.id,
    });
    expect(task.goalId).toBe("goal_abc");
    expect(task.cycleId).toBe(cycle.id);

    const updated = await memStore.updateTask(task.id, { status: "completed" });
    expect(updated?.goalId).toBe("goal_abc");
    expect(updated?.cycleId).toBe(cycle.id);
    expect((await memStore.getTask(task.id))?.cycleId).toBe(cycle.id);
  });
});

describe("prisma mappers carry the goal links", () => {
  const at = new Date("2026-09-15T00:00:00.000Z");

  it("maps Task.goalId and Task.cycleId, null becoming undefined", () => {
    const base = {
      id: "task_1",
      companyId: "co_1",
      title: "t",
      prompt: "p",
      status: "queued" as const,
      priority: "medium",
      agentRole: "engineer" as const,
      tags: [],
      dueDate: null,
      approvalId: null,
      recurringTemplateId: null,
      costCents: 0,
      createdAt: at,
      updatedAt: at,
    };
    const linked = mapTask({ ...base, goalId: "goal_1", cycleId: "cycle_1" });
    expect(linked.goalId).toBe("goal_1");
    expect(linked.cycleId).toBe("cycle_1");

    const unlinked = mapTask({ ...base, goalId: null, cycleId: null });
    expect(unlinked.goalId).toBeUndefined();
    expect(unlinked.cycleId).toBeUndefined();
  });

  it("maps Cycle.goalId, null becoming undefined", () => {
    const base = {
      id: "cycle_1",
      companyId: "co_1",
      trigger: "manual",
      kind: "ad_hoc_dag",
      status: "running" as const,
      phases: [],
      summary: "",
      degraded: false,
      startedAt: at,
      completedAt: null,
    };
    expect(mapCycle({ ...base, goalId: "goal_1" }).goalId).toBe("goal_1");
    expect(mapCycle({ ...base, goalId: null }).goalId).toBeUndefined();
  });
});
