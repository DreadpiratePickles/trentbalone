/**
 * The hooks whose state is scoped to ONE run.
 *
 * Two of them exist — the fleet-memory prelude and the delegation ledger — and both have the same
 * lifecycle: told the run has started (with the objective and, when a surface has one, the
 * conversation so far), told it has finished so their per-run state is released. Keeping the pair
 * behind one call means a third hook is added in one place, and means `index.ts` does not repeat
 * the same four fields twice.
 */

import { currentSpendLedger, type SpendLedger } from "../governance/spend-ledger.js";
import { modelOverridesFromEnv, priceCallMicroCents } from "../model-gateway/pricing.js";
import { isProviderAlias } from "../model-gateway/providers.js";
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
  /**
   * [P2-8] The frame this charge was read off: a `step_end`'s step id, or `CONSOLIDATION_FRAME`.
   * A frame whose model calls the run meter already priced (`recordRunModelCall`) is not charged again.
   */
  readonly stepId?: string;
}

/** [P2-8] The `stepId` a `consolidate_end` frame's charge carries. */
export const CONSOLIDATION_FRAME = "consolidate_end";

/**
 * [P2-8] One model call as the wrapper's gateway reported it: the model that ANSWERED, the tokens it
 * billed, and the gateway's own per-call cents (used only when nothing prices the model). A call with
 * a `stepId` is a seat call; one without is orchestration (`planner`, `critic`, `consolidator`).
 */
export interface RunModelCall {
  /** The seat role, or the orchestration role: `planner`, `critic`, `consolidator`. */
  readonly seat: string;
  readonly stepId?: string;
  readonly model: string;
  readonly provider: string;
  /** The user-facing provider (`ollama`, ...) when the call went through an alias. */
  readonly providerAlias?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  /** The provider reported no usage: the tokens are the gateway's chars/4 estimate. */
  readonly estimated: boolean;
  readonly costCents: number;
}

/** Seat calls reach the frames through `step_end`; orchestration calls through `consolidate_end`. */
type Pool = "seat" | "orchestration";

interface MeteredGroup {
  readonly pool: Pool;
  readonly seat: string;
  readonly model: string;
  readonly provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  microCents: number;
  estimated: boolean;
  unpriced: boolean;
}

/** One pool's exact spend and what the frames have already charged of it. */
interface PoolMeter {
  microCents: number;
  tokens: number;
  chargedCents: number;
  chargedTokens: number;
}

const MICRO_PER_CENT = 1_000_000;

/** The surface tag used when the run options name none. */
const UNKNOWN_SURFACE = "unknown";

interface RunSpendScope {
  readonly surface: string;
  /** Charges grouped by seat, model and provider, so a long run writes a handful of rows. */
  readonly groups: Map<string, RunSpendUsage>;
  /** [P2-8] Metered model calls, grouped by pool, seat, model and provider. */
  readonly metered: Map<string, MeteredGroup>;
  /** [P2-8] Frames whose charge the meter already holds: seat step ids and `CONSOLIDATION_FRAME`. */
  readonly meteredFrames: Set<string>;
  readonly pools: Record<Pool, PoolMeter>;
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
export function recordRunSpend(runId: string, charge: RunSpendUsage): void {
  const scope = spendScopes.get(runId);
  if (scope === undefined) return;
  // [P2-8] The meter priced this frame's calls from their tokens; the frame only repeats them.
  if (charge.stepId !== undefined && scope.meteredFrames.has(charge.stepId)) return;
  const { stepId: _frame, ...usage } = charge;
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

const whole = (count: number | undefined): number => (Number.isFinite(count) && (count ?? 0) > 0 ? Math.trunc(count ?? 0) : 0);

/** Cents newly due on a pool: the true running total rounded up, less what was already charged. */
function takePool(pool: PoolMeter): { cents: number; tokens: number } {
  const cents = Math.ceil(pool.microCents / MICRO_PER_CENT) - pool.chargedCents;
  const tokens = pool.tokens - pool.chargedTokens;
  pool.chargedCents += cents;
  pool.chargedTokens = pool.tokens;
  return { cents, tokens };
}

/**
 * [P2-8] Meters one model call against its run at the ANSWERING model's list price
 * (`model-gateway/pricing.ts`), in exact micro-cents, and returns the whole cents newly due on the
 * seat pool — the true running total rounded up, less what earlier calls already reported — so a
 * seat's step reports list price and ten sub-cent calls add up to one cent, not ten. An
 * orchestration call returns 0: its charge rides `consolidate_end` (`takeOrchestrationCharge`).
 * A model nothing prices keeps the gateway's own per-call cents and its row says `unpriced`.
 * Undefined for a run nobody opened: the charge is not attributed to anyone.
 */
export function recordRunModelCall(runId: string | undefined, call: RunModelCall): number | undefined {
  const scope = runId === undefined ? undefined : spendScopes.get(runId);
  if (scope === undefined) return undefined;
  const pool: Pool = call.stepId === undefined ? "orchestration" : "seat";
  const inputTokens = whole(call.inputTokens);
  const outputTokens = whole(call.outputTokens);
  const cachedInputTokens = Math.min(inputTokens, whole(call.cachedInputTokens));
  const alias = call.providerAlias !== undefined && isProviderAlias(call.providerAlias) ? call.providerAlias : undefined;
  const priced = priceCallMicroCents({ model: call.model, inputTokens, outputTokens, cachedInputTokens, overrides: modelOverridesFromEnv(), ...(alias ? { alias } : {}) });
  const microCents = priced?.microCents ?? whole(Math.ceil(call.costCents)) * MICRO_PER_CENT;
  const provider = call.providerAlias ?? call.provider;
  const key = `${pool}|${call.seat}|${call.model}|${provider}`;
  const group = scope.metered.get(key) ?? { pool, seat: call.seat, model: call.model, provider, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, microCents: 0, estimated: false, unpriced: false };
  group.inputTokens += inputTokens;
  group.outputTokens += outputTokens;
  group.cachedInputTokens += cachedInputTokens;
  group.microCents += microCents;
  group.estimated ||= call.estimated;
  group.unpriced ||= priced === undefined;
  scope.metered.set(key, group);
  scope.meteredFrames.add(call.stepId ?? CONSOLIDATION_FRAME);
  const meter = scope.pools[pool];
  meter.microCents += microCents;
  meter.tokens += inputTokens + outputTokens;
  return pool === "seat" ? takePool(meter).cents : 0;
}

/**
 * [P2-8] The charge `consolidate_end` carries: the WHOLE run's exact spend rounded up once, less
 * what the seat frames already charged, and the orchestration tokens (planner, critic,
 * consolidator) not yet on a frame. So the frames a surface adds up come to the same figure the
 * ledger apportions at run end: the run's true cost, rounded up once.
 */
export function takeOrchestrationCharge(runId: string | undefined): { cents: number; tokens: number } | undefined {
  const scope = runId === undefined ? undefined : spendScopes.get(runId);
  if (scope === undefined) return undefined;
  const { seat, orchestration } = scope.pools;
  const cents = Math.max(0, Math.ceil((seat.microCents + orchestration.microCents) / MICRO_PER_CENT) - seat.chargedCents - orchestration.chargedCents);
  const tokens = orchestration.tokens - orchestration.chargedTokens;
  orchestration.chargedCents += cents;
  orchestration.chargedTokens = orchestration.tokens;
  return { cents, tokens };
}

/**
 * Whole cents per row that add up to the pool's exact total rounded up ONCE: each row gets its own
 * floor, and the cents left over go to the rows with the largest remainders (largest-remainder
 * apportionment). Every row is within one cent of its exact figure.
 */
function apportion(micro: readonly number[]): number[] {
  const total = Math.ceil(micro.reduce((sum, value) => sum + value, 0) / MICRO_PER_CENT);
  const cents = micro.map((value) => Math.floor(value / MICRO_PER_CENT));
  let left = total - cents.reduce((sum, value) => sum + value, 0);
  const order = micro.map((value, index) => ({ index, rest: value % MICRO_PER_CENT })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    cents[index] = (cents[index] ?? 0) + 1;
    left -= 1;
  }
  return cents;
}

/**
 * [P2-8] The metered rows: one per seat (or orchestration role), model and provider, their cents
 * apportioned so the run's rows add up to its exact spend rounded up ONCE.
 */
function writeMeteredRows(ledger: SpendLedger, runId: string, scope: RunSpendScope): void {
  const groups = [...scope.metered.values()];
  const cents = apportion(groups.map((group) => group.microCents));
  groups.forEach((group, index) => {
    const tokens = group.inputTokens + group.outputTokens;
    if (tokens === 0 && (cents[index] ?? 0) === 0) return;
    ledger.append({
      surface: scope.surface,
      run_id: runId,
      seat: group.seat,
      model: group.model,
      provider: group.provider,
      cents: cents[index] ?? 0,
      tokens,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      ...(group.cachedInputTokens > 0 ? { cachedInputTokens: group.cachedInputTokens } : {}),
      ...(group.estimated ? { estimated: true } : {}),
      ...(group.unpriced ? { unpriced: true } : {}),
    });
  });
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
  writeMeteredRows(ledger, runId, scope);
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

const emptyPool = (): PoolMeter => ({ microCents: 0, tokens: 0, chargedCents: 0, chargedTokens: 0 });

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
  spendScopes.set(runId, {
    surface: options.surface ?? UNKNOWN_SURFACE,
    groups: new Map(),
    metered: new Map(),
    meteredFrames: new Set(),
    pools: { seat: emptyPool(), orchestration: emptyPool() },
  });
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
