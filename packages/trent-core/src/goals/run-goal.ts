/**
 * D4 — the decision at the end of a run: evidence before judgment.
 *
 * The order is the design. Gates first, because they are deterministic, cheap and cannot be argued
 * with; the judge only if every one of them exited 0, because a model asked "is this done?" over a
 * red build will sometimes say yes. Then `verify_on_stop`, because a run that edited code and can
 * show no fresh evidence has not earned a final answer either, goal or no goal.
 *
 * A red gate does not fail the run — it GATES it. The difference matters: failed means something
 * broke, gated means the work is not finished and the next step is known, which is why the gate's
 * own output tail becomes the continuation prompt rather than a log line nobody reads.
 */

import { firstRed, gateReport, runGates, type GateBackend } from "./gates.js";
import type { GoalStore } from "./store.js";
import { verifyOnStop, type UnverifiedRefusal, type VerifyOnStopInput } from "./verify.js";
import type { VerificationLedger } from "./evidence.js";
import {
  type GateResult,
  type GoalContinuation,
  type GoalMessage,
  type GoalRecord,
  type GoalRunRecord,
} from "./types.js";

/** The model judge. Consulted only behind green gates; absent, a run behind green gates is simply done. */
export type GoalJudge = (input: { readonly goal: GoalRecord; readonly gates: readonly GateResult[] }) => Promise<GoalJudgement>;

export interface GoalJudgement {
  readonly done: boolean;
  readonly reason: string;
}

export type RunOutcome = "completed" | "gated" | "unverified";

export interface RunVerdict {
  readonly runId: string;
  readonly outcome: RunOutcome;
  /** One plain sentence a surface prints as it stands. */
  readonly reason: string;
  readonly gates: readonly GateResult[];
  /** True only when a judge was consulted, which only happens behind green gates. */
  readonly judged: boolean;
  readonly goalId?: string;
  readonly refusal?: UnverifiedRefusal;
}

export interface FinishGoalRunInput {
  readonly runId: string;
  /** The goal this run belongs to; absent for an ordinary run, which still gets verify_on_stop. */
  readonly goal?: GoalRecord;
  readonly backend?: GateBackend;
  readonly store?: GoalStore;
  readonly judge?: GoalJudge;
  readonly verify: VerifyOnStopInput;
  /** Gate results are recorded here, so a green gate is also this turn's verification evidence. */
  readonly evidence?: VerificationLedger;
  readonly now?: () => string;
}

function record(goal: GoalRecord, entry: GoalRunRecord, status: GoalRecord["status"]): GoalRecord {
  return { ...goal, status, runs: [...goal.runs, entry] };
}

/**
 * Runs the goal's gates, consults the judge only behind green ones, and applies `verify_on_stop`.
 *
 * @returns how the run ended and why, in one sentence a surface can print unchanged.
 */
export async function finishGoalRun(input: FinishGoalRunInput): Promise<RunVerdict> {
  const at = (input.now ?? (() => new Date().toISOString()))();
  const goal = input.goal;
  let gates: GateResult[] = [];

  if (goal !== undefined && goal.gates.length > 0) {
    if (input.backend === undefined) {
      return {
        runId: input.runId,
        outcome: "gated",
        reason: `The goal ${goal.id} has ${goal.gates.length} quality gate(s) and this session has no sandbox to run them in, so nothing was judged.`,
        gates: [],
        judged: false,
        goalId: goal.id,
      };
    }
    gates = await runGates(goal.gates, input.backend);
    // A green gate is a verification command that exited 0, which is exactly what verify_on_stop
    // is looking for; recording it here is why a gated goal never also reports "unverified".
    for (const result of gates) {
      input.evidence?.record({ command: result.command, exitCode: result.exitCode, at: Date.now() });
    }
  }

  const red = firstRed(gates);
  if (red !== undefined && goal !== undefined) {
    const entry: GoalRunRecord = { run_id: input.runId, at, outcome: "gated", gate: red.name, exit_code: red.exitCode, tail: gateReport(red) };
    input.store?.save(record(goal, entry, "gated"));
    return {
      runId: input.runId,
      outcome: "gated",
      reason: `The quality gate ${red.name} exited ${red.exitCode}, so the judge was not consulted. Its output is the next run's starting point.`,
      gates,
      judged: false,
      goalId: goal.id,
    };
  }

  // Every gate green is this turn's verification, whatever the gates' argv: the profile named them
  // as what must pass, which is a stronger statement than `verify_commands` makes.
  const gatePassedAt = gates.length > 0 ? Date.now() : undefined;
  const refusal = verifyOnStop(gatePassedAt === undefined ? input.verify : { ...input.verify, gatePassedAt });
  if (refusal !== undefined) {
    if (goal !== undefined) {
      input.store?.save(record(goal, { run_id: input.runId, at, outcome: "unverified" }, "open"));
    }
    return {
      runId: input.runId,
      outcome: "unverified",
      reason: refusal.reason,
      gates,
      judged: false,
      refusal,
      ...(goal === undefined ? {} : { goalId: goal.id }),
    };
  }

  if (goal === undefined) {
    return { runId: input.runId, outcome: "completed", reason: "", gates, judged: false };
  }

  const judgement = input.judge === undefined ? undefined : await input.judge({ goal, gates });
  const done = judgement === undefined || judgement.done;
  input.store?.save(record(goal, { run_id: input.runId, at, outcome: done ? "completed" : "gated" }, done ? "completed" : "open"));
  return {
    runId: input.runId,
    outcome: "completed",
    reason:
      judgement === undefined
        ? `Every quality gate on ${goal.id} exited 0; no judge is configured for this profile, so the gates are the whole verdict.`
        : judgement.reason,
    gates,
    judged: judgement !== undefined,
    goalId: goal.id,
  };
}

/**
 * The next run of a gated goal, or nothing when it is not owed one.
 *
 * Nothing is owed when the goal is not gated, or when it has already started `max` continuations.
 * The cap is what stops a red gate and an eager `auto_continue` from spending a night's budget on
 * the same failing build.
 */
export function continuationFor(goal: GoalRecord, max: number): GoalContinuation | undefined {
  if (goal.status !== "gated" || goal.continuations >= max) return undefined;
  const history: GoalMessage[] = [];
  for (const run of goal.runs) {
    if (run.outcome === "gated" && run.tail !== undefined) history.push({ role: "user", content: run.tail });
  }
  if (history.length === 0) return undefined;
  return { goalId: goal.id, attempt: goal.continuations + 1, objective: goal.objective, history };
}

/** The goal with one more continuation started. Saved by the caller that actually launches the run. */
export function markContinued(goal: GoalRecord): GoalRecord {
  return { ...goal, status: "open", continuations: goal.continuations + 1 };
}
