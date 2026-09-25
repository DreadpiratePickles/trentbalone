/**
 * The hooks whose state is scoped to ONE run.
 *
 * Two of them exist — the fleet-memory prelude and the delegation ledger — and both have the same
 * lifecycle: told the run has started (with the objective and, when a surface has one, the
 * conversation so far), told it has finished so their per-run state is released. Keeping the pair
 * behind one call means a third hook is added in one place, and means `index.ts` does not repeat
 * the same four fields twice.
 */

import { currentSpendLedger } from "../governance/spend-ledger.js";
import type { ConversationMessage, OrcEvent } from "./types.js";

export interface RunScopeInput {
  readonly runId: string;
  readonly companyId: string;
  readonly objective: string;
  /** The surface's earlier turns, oldest first. Absent for a scheduled or delegated run. */
  readonly history?: readonly ConversationMessage[];
  /** Which surface asked for this run, as the headless runtime reports it. */
  readonly surface?: string;
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
  /**
   * The surface behind the run, when the caller names one. `unknown` is recorded rather than
   * guessed, so a surface that has not been taught to say goes on the meter honestly.
   */
  readonly surface?: string;
}

/**
 * [G3] One charge, as the gateway's usage events already carry it: integer cents, the model and
 * provider that were billed, and the seat when the charge belongs to one.
 */
export interface RunSpendUsage {
  readonly model: string;
  readonly provider: string;
  readonly cents: number;
  readonly tokens: number;
  /** [P1-C] Prompt-cache hits inside `tokens`, when the charge's source reported them. */
  readonly cachedInputTokens?: number;
  readonly seat?: string;
}

/** The surface tag used when the run options name none. */
const UNKNOWN_SURFACE = "unknown";

interface RunSpendScope {
  readonly surface: string;
  /** Charges grouped by seat, model and provider, so a long run writes a handful of rows. */
  readonly groups: Map<string, RunSpendUsage>;
}

/**
 * The open runs' spend. Module-scoped for the same reason the notice bus is keyed by run id: one
 * orchestrator serves every concurrent run, and a charge names only the run it belongs to.
 */
const spendScopes = new Map<string, RunSpendScope>();

/**
 * Records one charge against a run in flight. Called by whichever surface observes the gateway's
 * usage events; a charge for a run that was never opened, or has already closed, is dropped rather
 * than attributed to the wrong run.
 */
export function recordRunSpend(runId: string, usage: RunSpendUsage): void {
  const scope = spendScopes.get(runId);
  if (scope === undefined) return;
  const key = `${usage.seat ?? ""}|${usage.model}|${usage.provider}`;
  const held = scope.groups.get(key);
  const cached = Math.trunc(usage.cachedInputTokens ?? 0) + Math.trunc(held?.cachedInputTokens ?? 0);
  scope.groups.set(
    key,
    held === undefined
      ? { ...usage, cents: Math.trunc(usage.cents), tokens: Math.trunc(usage.tokens), ...(cached > 0 ? { cachedInputTokens: cached } : {}) }
      : { ...held, cents: held.cents + Math.trunc(usage.cents), tokens: held.tokens + Math.trunc(usage.tokens), ...(cached > 0 ? { cachedInputTokens: cached } : {}) },
  );
}

/**
 * The run-end half: what the run cost goes to the one daily ledger, tagged with its surface, so
 * `budget.daily_cap` is measured across surfaces instead of once per surface. A process with no
 * ledger installed writes nothing and behaves exactly as it did before.
 */
function closeRunSpend(runId: string): void {
  const scope = spendScopes.get(runId);
  if (scope === undefined) return;
  spendScopes.delete(runId);
  const ledger = currentSpendLedger();
  if (ledger === undefined) return;
  for (const usage of scope.groups.values()) {
    ledger.append({
      surface: scope.surface,
      run_id: runId,
      ...(usage.seat === undefined ? {} : { seat: usage.seat }),
      model: usage.model,
      provider: usage.provider,
      cents: usage.cents,
      tokens: usage.tokens,
      ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    });
  }
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
    ...(options.surface === undefined ? {} : { surface: options.surface }),
  };
  // [G3] The run's meter opens with its scope, so a charge recorded mid-run has somewhere to go.
  spendScopes.set(runId, { surface: options.surface ?? UNKNOWN_SURFACE, groups: new Map() });
  for (const hook of hooks) hook?.runStarted(input);
}

/** Closes it. A run that never got an id (it failed before launch) closes nothing. */
export function closeRunScope(hooks: readonly (RunScopedHook | undefined)[], runId: string | undefined): void {
  if (runId === undefined) return;
  // [G3] The run-end hook is where the run's cost reaches the day's ledger, once, for every surface.
  closeRunSpend(runId);
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
