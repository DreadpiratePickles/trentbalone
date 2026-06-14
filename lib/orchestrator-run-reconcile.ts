/**
 * lib/orchestrator-run-reconcile.ts — durable run "one truth" reconciliation.
 *
 * The bug this closes: a durable orchestration can finish (steps terminal,
 * `run_done`/`run_failed` event persisted) while the run *row's* status update
 * fails or is lost — every `updateOrchestratorRun(...status...)` in the engine is
 * best-effort (`.catch(() => undefined)`). The snapshot endpoint then keeps
 * reporting `planning`/`running` forever while the trace shows the run finished.
 *
 * Reconciliation derives the truthful run status from durable evidence —
 * terminal run EVENTS first (the trace), then an all-terminal STEP set — and
 * reports HOW it decided so inconsistencies are surfaced, not hidden. It is a
 * pure, deterministic read-model: same inputs → same output, no I/O.
 *
 * Safety rules:
 *  - A persisted status that is already stable (completed/failed/cancelled or the
 *    paused awaiting_approval) is authoritative and never downgraded.
 *  - awaiting_approval is treated as paused, never "lost" or coerced to failed.
 *  - A failed dependency cascade still reports `failed` honestly.
 *  - With no terminal evidence the status is left untouched.
 */

import { isFatalStepOutcome } from "@/lib/orchestrator-step-outcome";

export type OrchestratorRunStatusValue =
  | "planning"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

/** Truly finished: no further work and no resume. */
export const TERMINAL_RUN_STATUSES = new Set<OrchestratorRunStatusValue>([
  "completed",
  "failed",
  "cancelled",
]);

/** Stable = terminal OR paused-for-approval. A stable persisted status is trusted. */
export const STABLE_RUN_STATUSES = new Set<OrchestratorRunStatusValue>([
  "completed",
  "failed",
  "cancelled",
  "awaiting_approval",
]);

/** A step is "settled" when it can no longer advance on its own. */
const SETTLED_STEP_STATUSES = new Set<string>([
  "completed",
  "failed",
  "blocked",
  "awaiting_approval",
]);

export type RunReconcileSource = "run" | "trace" | "steps";

export type RunStatusReconciliation = {
  status: OrchestratorRunStatusValue;
  reconciled: boolean;
  reconciledFrom: RunReconcileSource;
  staleSnapshotDetected: boolean;
};

export type ReconcileStepLike = {
  status: string;
  output?: string;
  critique?: { verdict?: string } | Record<string, unknown> | undefined;
};

export type ReconcileEventLike = {
  kind: string;
  seq?: number;
  payload?: Record<string, unknown> | undefined;
};

export type ReconcileRunStatusInput = {
  persistedStatus: string;
  steps: ReconcileStepLike[];
  events?: ReconcileEventLike[];
};

/**
 * Only GENUINELY terminal run events count here. `run_awaiting_approval` is a
 * PAUSE, not a terminal — a later approval resumes the run, leaving the old
 * pause event behind in the append-only log. Treating that stale event as
 * authoritative would wrongly re-pause a resumed run, so awaiting_approval is
 * derived from current STEP state instead (see deriveRunStatusFromSteps).
 */
const TERMINAL_RUN_EVENT_STATUS: Record<string, OrchestratorRunStatusValue> = {
  run_done: "completed",
  run_failed: "failed",
  run_cancelled: "cancelled",
};

function normalizeStatus(value: string): OrchestratorRunStatusValue {
  switch (value) {
    case "planning":
    case "running":
    case "awaiting_approval":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      // Unknown persisted status is treated as a nonterminal "running" so
      // reconciliation can still surface terminal evidence without inventing one.
      return "running";
  }
}

/**
 * The status implied by the latest terminal run EVENT, if any. Events are the
 * trace's record that the engine reached a terminal transition even when the
 * run row's status write was lost.
 */
export function terminalRunStatusFromEvents(
  events: ReconcileEventLike[] | undefined,
): OrchestratorRunStatusValue | undefined {
  if (!events?.length) return undefined;
  let best: { seq: number; status: OrchestratorRunStatusValue } | undefined;
  for (const evt of events) {
    const mapped = TERMINAL_RUN_EVENT_STATUS[evt.kind];
    if (!mapped) continue;
    const seq = typeof evt.seq === "number" ? evt.seq : 0;
    if (!best || seq >= best.seq) best = { seq, status: mapped };
  }
  return best?.status;
}

/**
 * The status implied by the STEP set, but only when every step has settled.
 * A still-active step (pending/running) means the run is genuinely nonterminal,
 * so we return undefined rather than guess.
 */
export function deriveRunStatusFromSteps(
  steps: ReconcileStepLike[],
): OrchestratorRunStatusValue | undefined {
  if (!steps.length) return undefined;
  // An approval-gated step pauses the WHOLE run, regardless of sibling state —
  // the run cannot reach a terminal state until the founder decides. This also
  // means a run whose row is stale at "running" still surfaces as paused.
  if (steps.some((step) => step.status === "awaiting_approval")) return "awaiting_approval";
  // Otherwise only conclude terminal when every step has settled — a still-active
  // (pending/running) step means the run is genuinely nonterminal.
  if (!steps.every((step) => SETTLED_STEP_STATUSES.has(step.status))) return undefined;
  // Honest cascade: any genuinely fatal step (failed/blocked-not-usable) fails the run.
  const fatal = steps.some((step) => isFatalStepOutcome({
    status: step.status,
    output: typeof step.output === "string" ? step.output : undefined,
    critique: extractVerdict(step.critique),
  }));
  return fatal ? "failed" : "completed";
}

function extractVerdict(
  critique: ReconcileStepLike["critique"],
): { verdict?: string } | undefined {
  if (!critique || typeof critique !== "object") return undefined;
  const verdict = (critique as { verdict?: unknown }).verdict;
  return typeof verdict === "string" ? { verdict } : undefined;
}

/**
 * Reconcile the truthful run status from persisted status + durable evidence.
 * Deterministic and side-effect free.
 */
export function reconcileRunStatus(input: ReconcileRunStatusInput): RunStatusReconciliation {
  const persisted = normalizeStatus(input.persistedStatus);

  // 1. A stable persisted status is authoritative — never downgrade a recorded
  //    terminal/paused state from softer evidence.
  if (STABLE_RUN_STATUSES.has(persisted)) {
    return { status: persisted, reconciled: false, reconciledFrom: "run", staleSnapshotDetected: false };
  }

  // 2. Trace evidence: a terminal run event wins.
  const fromEvents = terminalRunStatusFromEvents(input.events);
  if (fromEvents) {
    return {
      status: fromEvents,
      reconciled: fromEvents !== persisted,
      reconciledFrom: "trace",
      staleSnapshotDetected: fromEvents !== persisted,
    };
  }

  // 3. Step evidence: an all-settled step set implies a terminal/paused run.
  const fromSteps = deriveRunStatusFromSteps(input.steps);
  if (fromSteps) {
    return {
      status: fromSteps,
      reconciled: fromSteps !== persisted,
      reconciledFrom: "steps",
      staleSnapshotDetected: fromSteps !== persisted,
    };
  }

  // 4. No terminal evidence — leave the nonterminal status untouched.
  return { status: persisted, reconciled: false, reconciledFrom: "run", staleSnapshotDetected: false };
}

/**
 * Whether a UI poller should stop on this status. Terminal AND paused
 * (awaiting_approval) both stop polling — an approval-gated run is paused, not
 * "lost contact", so the client must treat it as terminal-ish.
 */
export function isPollTerminalRunStatus(status: string | undefined): boolean {
  if (!status) return false;
  return STABLE_RUN_STATUSES.has(status as OrchestratorRunStatusValue);
}
