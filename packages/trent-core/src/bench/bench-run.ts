/**
 * [C16] A whole bench run: every selected task, on every harness, `runsPerTask` times, then the report.
 *
 * Order is attempt, then task, then harness, so the harnesses take turns on the same task under the same
 * conditions (the same minute of a provider's rate limit, the same load on the machine) instead of one harness
 * running all twenty first. Attempts run one at a time: the world is one set of accounts.
 *
 * A harness whose attempt throws (a bug, not a failed task) still yields a row: status `error`, graded as the
 * world stands, so a crash is visible in the report and never silently shortens the denominator.
 */
import { gradeTask } from "./grade.js";
import { buildReport, type BuiltReport, type ReportMeta } from "./report.js";
import { NO_COST } from "./cost.js";
import type { BenchTask, HarnessId, TaskRun } from "./types.js";
import type { BenchWorld } from "./world.js";

export type AttemptRunner = (task: BenchTask, attempt: number) => Promise<TaskRun>;

export interface BenchHarness {
  readonly id: HarnessId;
  readonly runAttempt: AttemptRunner;
}

export interface BenchPlan {
  readonly tasks: readonly BenchTask[];
  readonly harnesses: readonly BenchHarness[];
  readonly runsPerTask: number;
  readonly world: BenchWorld;
  /** Told each attempt as it finishes, for a progress line. */
  readonly onRun?: (run: TaskRun) => void;
}

async function crashed(harness: HarnessId, task: BenchTask, attempt: number, world: BenchWorld, error: unknown): Promise<TaskRun> {
  const grade = await gradeTask(task, world);
  return {
    taskId: task.id,
    taskClass: task.taskClass,
    harness,
    attempt,
    passed: grade.passed,
    grade,
    status: "error",
    wallMs: 0,
    ttftMs: null,
    ...NO_COST,
    error: `the ${harness} harness threw: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export async function runBench(plan: BenchPlan): Promise<TaskRun[]> {
  if (!Number.isInteger(plan.runsPerTask) || plan.runsPerTask < 1) throw new RangeError(`runs per task must be a whole number of at least 1, not ${String(plan.runsPerTask)}`);
  const runs: TaskRun[] = [];
  for (let attempt = 1; attempt <= plan.runsPerTask; attempt += 1) {
    for (const task of plan.tasks) {
      for (const harness of plan.harnesses) {
        let run: TaskRun;
        try {
          run = await harness.runAttempt(task, attempt);
        } catch (error) {
          run = await crashed(harness.id, task, attempt, plan.world, error);
        }
        runs.push(run);
        plan.onRun?.(run);
      }
    }
  }
  return runs;
}

/** The run and its report in one call. */
export async function runBenchReport(plan: BenchPlan, meta: Omit<ReportMeta, "startedAt" | "finishedAt" | "runsPerTask" | "harnesses">, now: () => Date = () => new Date()): Promise<BuiltReport> {
  const startedAt = now().toISOString();
  const runs = await runBench(plan);
  return buildReport(runs, { ...meta, runsPerTask: plan.runsPerTask, harnesses: plan.harnesses.map((harness) => harness.id), startedAt, finishedAt: now().toISOString() });
}
