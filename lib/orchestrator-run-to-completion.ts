/**
 * lib/orchestrator-run-to-completion.ts — orchestration guide Task 4.4.
 *
 * "Run to completion" = auto-continue rounds while every proposed task is
 * REVERSIBLE and the budget cap is UNBREACHED, pausing at the first
 * irreversible or over-budget gate. This is UX magic, NOT a reliability fix —
 * it never changes step correctness; it only decides whether the UI may
 * auto-advance or must stop and ask the founder.
 *
 * Pure and read-only: the decision is computed from the run's pending steps
 * and budget so the same gate backs both the "Run to completion" button's
 * preview and any auto-advance loop. The existing needsApproval gate is the
 * irreversibility signal — a step that needs approval is, by definition, not
 * safe to auto-run.
 */

export type RunToCompletionStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "awaiting_approval";
  needsApproval: boolean;
  riskLevel: "low" | "medium" | "high" | string;
  /** Per-step spend already incurred (0 for not-yet-run steps). */
  costCents?: number;
};

export type RunToCompletionInput = {
  steps: RunToCompletionStep[];
  /** Run budget cap; 0/undefined means "no cap configured" → never budget-pause. */
  budgetCents?: number;
  /** Spend already incurred on the run. */
  costCents: number;
  /**
   * Estimated cost of one not-yet-run step, used to project whether the next
   * round would breach the cap. Defaults to a conservative 100¢.
   */
  perStepEstimateCents?: number;
};

export type RunToCompletionDecision = {
  action: "continue" | "pause" | "done";
  reason: string;
  /** The step that forces a pause (irreversible or the one that would breach budget). */
  blockingStepId?: string;
};

const DEFAULT_PER_STEP_ESTIMATE_CENTS = 100;

/** A step is reversible-to-auto-run when it neither needs approval nor is high-risk. */
export function isAutoRunnableStep(step: RunToCompletionStep): boolean {
  return !step.needsApproval && step.riskLevel !== "high";
}

/**
 * Decide whether a run-to-completion loop may advance. Order matters: an
 * already-blocked irreversible step pauses even if budget is fine, and budget
 * is only checked against steps that are otherwise auto-runnable (no point
 * citing budget when an approval gate already stops us).
 */
export function evaluateRunToCompletion(input: RunToCompletionInput): RunToCompletionDecision {
  const active = input.steps.filter(
    (step) => step.status === "pending" || step.status === "running" || step.status === "awaiting_approval",
  );
  if (active.length === 0) {
    return { action: "done", reason: "No remaining work — run can finish." };
  }

  // 1. Any active step that is irreversible (needs approval) or high-risk
  //    halts auto-advance, regardless of budget.
  const irreversible = active.find((step) => !isAutoRunnableStep(step));
  if (irreversible) {
    return {
      action: "pause",
      reason: `Step "${irreversible.title}" is ${irreversible.needsApproval ? "approval-gated" : "high-risk"} — founder approval required before it can run.`,
      blockingStepId: irreversible.id,
    };
  }

  // 2. Budget gate: would running the next not-yet-started step breach the cap?
  const cap = input.budgetCents ?? 0;
  if (cap > 0) {
    const estimate = input.perStepEstimateCents ?? DEFAULT_PER_STEP_ESTIMATE_CENTS;
    const nextStep = active.find((step) => step.status === "pending");
    if (nextStep && input.costCents + estimate > cap) {
      return {
        action: "pause",
        reason: `Continuing would exceed the budget cap (spent ${input.costCents}¢ + ~${estimate}¢ next > ${cap}¢ cap).`,
        blockingStepId: nextStep.id,
      };
    }
  }

  return {
    action: "continue",
    reason: `All ${active.length} remaining step(s) are reversible and within budget — safe to auto-advance.`,
  };
}
