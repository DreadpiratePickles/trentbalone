/**
 * The hooks whose state is scoped to ONE run.
 *
 * Two of them exist — the fleet-memory prelude and the delegation ledger — and both have the same
 * lifecycle: told the run has started (with the objective and, when a surface has one, the
 * conversation so far), told it has finished so their per-run state is released. Keeping the pair
 * behind one call means a third hook is added in one place, and means `index.ts` does not repeat
 * the same four fields twice.
 */

import type { ConversationMessage, OrcEvent } from "./types.js";

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

/** A hook that reports something the run's reader should see. `FleetMemoryHook` satisfies it. */
export interface ContextNoticeSource {
  setNoticeSink(sink: (notice: { readonly runId: string; readonly detail: string }) => void): void;
}

/**
 * Carries the fleet-memory hook's context-pressure notices onto the run bus.
 *
 * The bus has no `context_pressure` kind and cannot grow one: its 20 kinds mirror
 * `apps/web/lib/orchestrator-events.ts`, which is read-only. `step_note` is the kind the pipeline
 * already uses for a remark about a step in flight, and a pressure warning is exactly that.
 *
 * `deliverFor` resolves the run's own `deliver` at notice time, because one hook serves every
 * concurrent run: a notice for a run that has already closed its channel resolves to `undefined`
 * and is dropped rather than delivered to whoever happens to be streaming.
 */
export function bridgeContextNotices(
  source: ContextNoticeSource | undefined,
  deliverFor: (runId: string) => ((event: OrcEvent) => void) | undefined,
  now: () => string = () => new Date().toISOString(),
): void {
  if (!source) return;
  source.setNoticeSink((notice) => {
    deliverFor(notice.runId)?.({ kind: "step_note", runId: notice.runId, at: now(), detail: notice.detail });
  });
}

/**
 * The bridge plus the live runs' deliverers. It is a `RunScopedHook` so `index.ts` closes it on the
 * same line it closes the others; only `open` is extra, because that is where the run's `deliver`
 * first exists.
 */
export interface ContextNoticeBus extends RunScopedHook {
  /** This run is streaming: notices naming it go to `deliver`. */
  open(runId: string, deliver: (event: OrcEvent) => void): void;
}

export function createContextNoticeBus(source: ContextNoticeSource | undefined): ContextNoticeBus {
  const deliverers = new Map<string, (event: OrcEvent) => void>();
  bridgeContextNotices(source, (runId) => deliverers.get(runId));
  return {
    open: (runId, deliver) => void deliverers.set(runId, deliver),
    // A run cannot register before it has an id, so `runStarted` has nothing to do here.
    runStarted: () => undefined,
    runFinished: (runId) => void deliverers.delete(runId),
  };
}
