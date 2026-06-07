import { store } from "@/lib/store";

// ── Error classes ─────────────────────────────────────────────────────────────

export class CyclePausedError extends Error {
  constructor(companyId: string) {
    super(`Company ${companyId} is paused — all cycle execution is suspended.`);
    this.name = "CyclePausedError";
  }
}

export class CycleTimeoutError extends Error {
  constructor(
    readonly elapsedSeconds: number,
    readonly maxSeconds: number
  ) {
    super(`Cycle exceeded max runtime: ${elapsedSeconds.toFixed(0)}s > ${maxSeconds}s.`);
    this.name = "CycleTimeoutError";
  }
}

export class CycleBudgetExceededError extends Error {
  constructor(
    readonly spentCents: number,
    readonly maxCents: number
  ) {
    super(`Cycle budget exceeded: ${spentCents}¢ spent, cap is ${maxCents}¢.`);
    this.name = "CycleBudgetExceededError";
  }
}

export class TaskBudgetExceededError extends Error {
  constructor(
    readonly taskId: string,
    /** projected total after the pending spend — not yet committed to the task */
    readonly projectedCents: number,
    readonly maxCents: number
  ) {
    super(`Task ${taskId} budget exceeded: projected ${projectedCents}¢ >= cap ${maxCents}¢.`);
    this.name = "TaskBudgetExceededError";
  }
}

// ── assertKillSwitch ──────────────────────────────────────────────────────────

export async function assertKillSwitch(companyId: string): Promise<void> {
  const company = await store.getCompany(companyId);
  if (!company) throw new Error(`Company not found: ${companyId}`);
  if (company.status === "paused") throw new CyclePausedError(companyId);
}

// ── assertCycleRuntime ────────────────────────────────────────────────────────

export function assertCycleRuntime(
  startedAt: string,
  maxRuntimeSeconds: number
): number {
  const elapsedSeconds = (Date.now() - new Date(startedAt).getTime()) / 1000;
  if (isNaN(elapsedSeconds)) throw new Error(`Invalid startedAt timestamp: ${startedAt}`);
  if (elapsedSeconds > maxRuntimeSeconds) {
    throw new CycleTimeoutError(elapsedSeconds, maxRuntimeSeconds);
  }
  return elapsedSeconds;
}

// ── assertCycleBudget ─────────────────────────────────────────────────────────

export function assertCycleBudget(
  spentCents: number,
  maxCents: number,
  description: string
): void {
  if (maxCents <= 0) return;
  if (spentCents >= maxCents) {
    throw new CycleBudgetExceededError(spentCents, maxCents);
  }
}

// ── assertTaskBudget ──────────────────────────────────────────────────────────

export async function assertTaskBudget(
  taskId: string,
  additionalCents: number,
  maxCents: number
): Promise<void> {
  if (maxCents <= 0) return;
  if (additionalCents < 0) throw new Error("additionalCents must be non-negative");
  const task = await store.getTask(taskId);
  if (!task) return;
  const projectedCents = task.costCents + additionalCents;
  if (projectedCents >= maxCents) {
    throw new TaskBudgetExceededError(taskId, projectedCents, maxCents);
  }
}

// ── recordTaskSpend ───────────────────────────────────────────────────────────

export async function recordTaskSpend(
  taskId: string,
  cents: number
): Promise<void> {
  if (cents <= 0) return;
  const task = await store.getTask(taskId);
  if (!task) return;
  await store.updateTask(taskId, { costCents: task.costCents + cents });
}
