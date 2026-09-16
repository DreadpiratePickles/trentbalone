/**
 * lib/goal-round-records.ts — the persistent records a goal round leaves behind.
 *
 * A round is a real Cycle (Cycle.goalId = the goal) and every planned step is a
 * real Task (Task.goalId, Task.cycleId), so the goal's progress can be rolled up
 * from task state (see computeGoalProgress in goal-store.ts) instead of only from
 * the criteria ledger, and the runtime receives a genuine cycle id rather than
 * the goal id in the cycle slot.
 */
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import type { Goal, GoalRoundPlan } from "@/lib/goal-types";
import type { Company, Cycle, Task } from "@/lib/types";

export async function openRoundCycle(company: Company, goal: Goal, roundN: number): Promise<Cycle> {
  return store.saveCycle({
    id: makeId("cycle"),
    companyId: company.id,
    trigger: "manual",
    kind: "ad_hoc_dag",
    status: "running",
    phases: ["plan", "execute", "critic", "review"],
    summary: `Goal round ${roundN}: ${goal.objective.slice(0, 120)}`,
    goalId: goal.id,
    startedAt: nowIso(),
  });
}

/** One Task per planned step, keyed by the plan's own task id. */
export async function createRoundTasks(
  company: Company,
  goal: Goal,
  plan: GoalRoundPlan,
  cycleId: string,
): Promise<Map<string, Task>> {
  const byPlanId = new Map<string, Task>();
  for (const t of plan.tasks) {
    const task = await store.createTask({
      companyId: company.id,
      title: t.objective.slice(0, 120),
      prompt: t.objective,
      status: "queued",
      priority: t.riskLevel === "high" ? "high" : "medium",
      agentRole: t.seat,
      tags: ["goal", ...t.targetsCriteriaIds.map((c) => `criterion:${c}`)],
      goalId: goal.id,
      cycleId,
      costCents: 0,
    });
    byPlanId.set(t.id, task);
  }
  return byPlanId;
}

export async function closeRoundCycle(cycleId: string, anyAccepted: boolean, summary: string): Promise<void> {
  await store.updateCycle(cycleId, {
    status: anyAccepted ? "completed" : "failed",
    summary: summary.slice(0, 500),
    completedAt: nowIso(),
  });
}
