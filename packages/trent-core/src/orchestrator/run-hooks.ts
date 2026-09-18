/**
 * The hooks whose state is scoped to ONE run.
 *
 * Two of them exist — the fleet-memory prelude and the delegation ledger — and both have the same
 * lifecycle: told the run has started (with the objective and, when a surface has one, the
 * conversation so far), told it has finished so their per-run state is released. Keeping the pair
 * behind one call means a third hook is added in one place, and means `index.ts` does not repeat
 * the same four fields twice.
 */

import type { ConversationMessage } from "./types.js";

export interface RunScopeInput {
  readonly runId: string;
  readonly companyId: string;
  readonly objective: string;
  /** The surface's earlier turns, oldest first. Absent for a scheduled or delegated run. */
  readonly history?: readonly ConversationMessage[];
}

/** What a run-scoped hook must answer to. `FleetMemoryHook` and the delegate port both satisfy it. */
export interface RunScopedHook {
  runStarted(input: RunScopeInput): void;
  runFinished(runId: string): void;
}

/** The run options this module reads; `OrchestratorRunOptions` satisfies it structurally. */
export interface RunScopeOptions {
  readonly companyId: string;
  readonly objective: string;
  readonly history?: readonly ConversationMessage[];
}

/** Opens the run on every hook present. Absent hooks are simply not told. */
export function openRunScope(
  hooks: readonly (RunScopedHook | undefined)[],
  runId: string,
  options: RunScopeOptions,
): void {
  const input: RunScopeInput = {
    runId,
    companyId: options.companyId,
    objective: options.objective,
    // A run with no conversation must not carry an empty `history` key: the hooks branch on absence.
    ...(options.history === undefined ? {} : { history: options.history }),
  };
  for (const hook of hooks) hook?.runStarted(input);
}

/** Closes it. A run that never got an id (it failed before launch) closes nothing. */
export function closeRunScope(hooks: readonly (RunScopedHook | undefined)[], runId: string | undefined): void {
  if (runId === undefined) return;
  for (const hook of hooks) hook?.runFinished(runId);
}
