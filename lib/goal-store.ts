/**
 * lib/goal-store.ts — persistence for §2 Goals via the Prisma client.
 *
 * Goals carry four JSON columns (successCriteria, constraints, rounds,
 * progressLog). Every read validates them through the Zod contracts in
 * goal-types.ts so a malformed ledger never reaches a planning round, and every
 * write goes through the same shapes. This deliberately bypasses the big `store`
 * facade type to stay self-contained.
 */
import { db } from "@/lib/db";
import { makeId, nowIso } from "@/lib/utils";
import {
  type Goal,
  type GoalConstraints,
  type GoalRound,
  type ProgressLogEntry,
  type SuccessCriterion,
  type GoalStatus,
  goalConstraintsSchema,
  goalRoundSchema,
  progressLogEntrySchema,
  successCriterionSchema,
} from "@/lib/goal-types";

type GoalRow = {
  id: string;
  companyId: string;
  objective: string;
  status: string;
  successCriteria: unknown;
  constraints: unknown;
  rounds: unknown;
  progressLog: unknown;
  costCents: number;
  createdAt: Date;
  updatedAt: Date;
};

function fromRow(row: GoalRow): Goal {
  const criteria = successCriterionSchema.array().safeParse(row.successCriteria);
  const constraints = goalConstraintsSchema.safeParse(row.constraints ?? {});
  const rounds = goalRoundSchema.array().safeParse(row.rounds);
  const log = progressLogEntrySchema.array().safeParse(row.progressLog);
  return {
    id: row.id,
    companyId: row.companyId,
    objective: row.objective,
    status: row.status as GoalStatus,
    successCriteria: criteria.success ? criteria.data : [],
    constraints: constraints.success ? constraints.data : goalConstraintsSchema.parse({}),
    rounds: rounds.success ? rounds.data : [],
    progressLog: log.success ? log.data : [],
    costCents: row.costCents ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createGoal(input: {
  companyId: string;
  objective: string;
  successCriteria: SuccessCriterion[];
  constraints: GoalConstraints;
  status?: GoalStatus;
}): Promise<Goal> {
  const intakeLog: ProgressLogEntry = {
    at: nowIso(),
    kind: "intake",
    text: `Goal created: "${input.objective.slice(0, 160)}" with ${input.successCriteria.length} success criteria.`,
    refs: [],
  };
  const row = await db.goal.create({
    data: {
      id: makeId("goal"),
      companyId: input.companyId,
      objective: input.objective,
      status: input.status ?? "intake",
      successCriteria: input.successCriteria as object,
      constraints: input.constraints as object,
      rounds: [],
      progressLog: [intakeLog] as object,
    },
  });
  return fromRow(row as GoalRow);
}

export async function getGoal(goalId: string): Promise<Goal | null> {
  const row = await db.goal.findUnique({ where: { id: goalId } });
  return row ? fromRow(row as GoalRow) : null;
}

export async function listGoals(companyId: string): Promise<Goal[]> {
  const rows = await db.goal.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => fromRow(r as GoalRow));
}

export async function updateGoal(
  goalId: string,
  patch: Partial<{
    objective: string;
    status: GoalStatus;
    successCriteria: SuccessCriterion[];
    constraints: GoalConstraints;
    costCents: number;
  }>,
): Promise<Goal | null> {
  const data: Record<string, unknown> = {};
  if (patch.objective !== undefined) data.objective = patch.objective;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.successCriteria !== undefined) data.successCriteria = patch.successCriteria as object;
  if (patch.constraints !== undefined) data.constraints = patch.constraints as object;
  if (patch.costCents !== undefined) data.costCents = patch.costCents;
  const row = await db.goal.update({ where: { id: goalId }, data });
  return fromRow(row as GoalRow);
}

export async function appendGoalProgress(goalId: string, entry: ProgressLogEntry): Promise<void> {
  const goal = await getGoal(goalId);
  if (!goal) return;
  const next = [...goal.progressLog, progressLogEntrySchema.parse(entry)];
  await db.goal.update({ where: { id: goalId }, data: { progressLog: next as object } });
}

export async function addGoalRound(goalId: string, round: GoalRound): Promise<void> {
  const goal = await getGoal(goalId);
  if (!goal) return;
  const next = [...goal.rounds, goalRoundSchema.parse(round)];
  await db.goal.update({
    where: { id: goalId },
    data: {
      rounds: next as object,
      costCents: goal.costCents + round.costCents,
    },
  });
}

export async function deleteGoal(goalId: string): Promise<void> {
  await db.goal.delete({ where: { id: goalId } }).catch(() => undefined);
}
