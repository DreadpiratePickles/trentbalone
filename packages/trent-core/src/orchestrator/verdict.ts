/**
 * [P2-11] The verdict of a run that lost model calls part-way.
 *
 * Before this, a run whose seat, planner or consolidator call failed at the provider mid-run ended one
 * of three ways, none of which a person or a cron incident could read: `completed` (the app counts a
 * failed step with an error message as degraded-but-usable, and keeps its fallback literal when the
 * consolidator fails), `failed` with only the LAST provider's refusal in the text, or no terminal frame
 * at all when the drain died, which `trent run` reports as "the run ended without a verdict".
 *
 * Now every run that failed at a provider (or whose drain died) ends with ONE `run_failed` frame
 * carrying `verdict`, and the snapshot carries the same object:
 *   - `reason`: `model_calls_failed` when a provider (or the transport to it) refused a call;
 *     `run_error` when the run stopped on anything else;
 *   - `failedSteps`: seat, step, error class, provider, status, the wait it asked for, attempts;
 *   - `completedSteps` / `totalSteps`, `costCents` (what the run's frames charged), `consolidation`;
 *   - `summary`: one line naming the class and the provider, e.g.
 *     "1 of 4 steps failed: google HTTP 429 rate_limit (You exceeded your current quota) on content;
 *      consolidation skipped; retry after 3600s".
 * `types.ts` mirrors the app and is not grown: the verdict rides as an extra field, read by `verdictOf`.
 *
 * `applySeatFailureOverride` and `applyPlannerFailure` moved here from `index.ts`, which sits at the
 * repository's 500-line ceiling; they are run-end writes like the verdict's own.
 */
import { redactText } from "../errors/index.js";
import type { ErrorClass } from "../model-gateway/retry.js";
import type { ModelGateway } from "../model-gateway/types.js";
import { classifyRecoveryError, type AutoRecovery, type RecoveryFailure } from "./auto-recovery.js";
import type { Libs, LiveRun } from "./libs.js";
import { takeOrchestrationCharge } from "./run-hooks.js";
import { applyStepFailures, type SeatTally } from "./seat-guard.js";
import type { OrcEvent, OrchestrationRunSnapshot } from "./types.js";

export type RunFailureReason = "model_calls_failed" | "run_error";
/** `completed`: a brief exists. `failed`: the consolidator's call failed. `skipped`: none was asked for. */
export type ConsolidationOutcome = "completed" | "failed" | "skipped";

/** One failed model call as a reader needs it. The message is redacted and bounded. */
export interface ModelCallFailure {
  readonly errorClass: ErrorClass;
  readonly message: string;
  readonly provider?: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}

export interface FailedStep extends ModelCallFailure {
  readonly seat: string;
  readonly step: string;
  readonly title: string;
  /** How many attempts of the step ended at a provider (auto-recovery cycles + 1). */
  readonly attempts: number;
}

export interface RunFailureVerdict {
  readonly reason: RunFailureReason;
  readonly summary: string;
  readonly failedSteps: readonly FailedStep[];
  readonly completedSteps: number;
  readonly totalSteps: number;
  /** Integer cents the run's frames charged (`step_end` + `consolidate_end`), as `trent run` adds them. */
  readonly costCents: number;
  readonly consolidation: ConsolidationOutcome;
  readonly consolidationError?: ModelCallFailure;
  /** The longest wait any provider of this run asked for. */
  readonly retryAfterSeconds?: number;
}

/** The terminal frame and the snapshot, each with the verdict on it. */
export type RunFailedFrame = OrcEvent & { readonly verdict: RunFailureVerdict };
export type VerdictSnapshot = OrchestrationRunSnapshot & { readonly verdict?: RunFailureVerdict };

export interface VerdictInput {
  readonly steps: ReadonlyArray<{ readonly id: string; readonly title: string; readonly agentRole?: string; readonly status: string; readonly output?: string }>;
  /** Every provider failure a step's attempts ended on, in order, by step id. */
  readonly failures: ReadonlyMap<string, readonly ModelCallFailure[]>;
  readonly consolidation: { readonly outcome: ConsolidationOutcome; readonly error?: ModelCallFailure };
  readonly costCents: number;
  /** The planner's call failed: no plan, so no step ran. */
  readonly planner?: ModelCallFailure;
  /** The drain died on this: the run never reached its own end. */
  readonly stopped?: string;
}

const MESSAGE_CHARS = 300;
const GIST_CHARS = 100;

function bounded(text: string, max: number): string {
  const flat = redactText(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function toModelFailure(failure: RecoveryFailure): ModelCallFailure {
  return {
    errorClass: failure.errorClass,
    message: bounded(failure.message, MESSAGE_CHARS),
    ...(failure.provider === undefined ? {} : { provider: failure.provider }),
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.ceil(failure.retryAfterMs / 1_000) }),
  };
}

/** A thrown provider error, or the message the app kept of one, classified the way the gateway does. */
export function describeModelFailure(error: unknown): ModelCallFailure {
  return toModelFailure(classifyRecoveryError(error));
}

/** A provider (or the transport to it) answered; `internal` may be a defect and is never blamed on one. */
const atProvider = (failure: ModelCallFailure): boolean => failure.errorClass !== "internal";

/** "google HTTP 429 rate_limit (You exceeded your current quota)". */
function causeOf(failure: ModelCallFailure): string {
  const head = [failure.provider, failure.status === undefined ? undefined : `HTTP ${failure.status}`, failure.errorClass].filter(Boolean).join(" ");
  const own = /request failed with HTTP \d{3}\s*([^:]*?)\s*(?::\s*(.*))?$/s.exec(failure.message);
  const gist = bounded(own === null ? failure.message : (own[2] ?? own[1] ?? ""), GIST_CHARS);
  return gist === "" ? head : `${head} (${gist})`;
}

/** Each distinct cause of one step's attempts, in order. */
function causesOf(attempts: readonly ModelCallFailure[]): string {
  const distinct: string[] = [];
  for (const attempt of attempts) {
    const cause = causeOf(attempt);
    if (distinct.at(-1) !== cause) distinct.push(cause);
  }
  return distinct.join(", then ");
}

export function buildVerdict(input: VerdictInput): RunFailureVerdict | undefined {
  const totalSteps = input.steps.length;
  const failedSteps: FailedStep[] = [];
  const causes = new Map<string, string[]>();
  for (const step of input.steps) {
    const attempts = input.failures.get(step.id) ?? [];
    const last = attempts.at(-1);
    if (last === undefined) continue;
    const seat = step.agentRole ?? "seat";
    failedSteps.push({ seat, step: step.id, title: step.title, ...last, attempts: attempts.length });
    const cause = causesOf(attempts);
    causes.set(cause, [...(causes.get(cause) ?? []), seat]);
  }
  const failed = new Set(failedSteps.map((f) => f.step));
  const completedSteps = input.steps.filter((step) => step.status === "completed" && !failed.has(step.id)).length;
  const consolidationError = input.consolidation.outcome === "failed" ? input.consolidation.error : undefined;
  const providerFailed = failedSteps.length > 0 || (input.planner !== undefined && atProvider(input.planner)) || (consolidationError !== undefined && atProvider(consolidationError));
  if (!providerFailed && input.planner === undefined && input.stopped === undefined) return undefined;

  const parts: string[] = [];
  if (input.planner !== undefined) parts.push(`planner call failed: ${causeOf(input.planner)}`, "no step ran");
  else {
    if (input.stopped !== undefined) parts.push(`the run stopped on an error: ${bounded(input.stopped, GIST_CHARS * 2)}`);
    if (failedSteps.length > 0) {
      parts.push(`${failedSteps.length} of ${totalSteps} steps failed: ${[...causes].map(([cause, seats]) => `${cause} on ${[...new Set(seats)].join(", ")}`).join("; ")}`);
      const other = totalSteps - failedSteps.length - completedSteps;
      if (other > 0) parts.push(`${other} more did not complete`);
    } else parts.push(completedSteps === totalSteps ? `all ${totalSteps} steps completed` : `${completedSteps} of ${totalSteps} steps completed`);
    parts.push(consolidationError === undefined ? `consolidation ${input.consolidation.outcome}` : `consolidation failed: ${causeOf(consolidationError)}`);
  }
  const waits = [...failedSteps, input.planner, consolidationError].map((f) => f?.retryAfterSeconds).filter((s): s is number => s !== undefined);
  const retryAfterSeconds = waits.length === 0 ? undefined : Math.max(...waits);
  if (retryAfterSeconds !== undefined) parts.push(`retry after ${retryAfterSeconds}s`);

  return {
    reason: providerFailed ? "model_calls_failed" : "run_error",
    summary: parts.join("; "),
    failedSteps,
    completedSteps,
    totalSteps,
    costCents: input.costCents,
    consolidation: input.consolidation.outcome,
    ...(consolidationError === undefined ? {} : { consolidationError }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

/** The verdict on a terminal frame or a snapshot; undefined for anything else. */
export function verdictOf(value: unknown): RunFailureVerdict | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const verdict = (value as { verdict?: unknown }).verdict;
  if (typeof verdict !== "object" || verdict === null) return undefined;
  const candidate = verdict as Partial<RunFailureVerdict>;
  if (candidate.reason !== "model_calls_failed" && candidate.reason !== "run_error") return undefined;
  if (typeof candidate.summary !== "string" || !Array.isArray(candidate.failedSteps)) return undefined;
  return verdict as RunFailureVerdict;
}

/** The verdict as `trent run`'s result line carries it, in that line's own snake_case keys. */
export type VerdictResultFields = {
  reason: RunFailureReason;
  failed_steps: Array<{ seat: string; step: string; error_class: string; message: string; provider?: string; status?: number; retry_after_seconds?: number }>;
  completed_steps: number;
  total_steps: number;
  consolidation: ConsolidationOutcome;
  retry_after_seconds?: number;
};

export function verdictResultFields(verdict: RunFailureVerdict | undefined): Partial<VerdictResultFields> {
  if (verdict === undefined) return {};
  const failed_steps = verdict.failedSteps.map((f) => ({
    seat: f.seat,
    step: f.step,
    error_class: f.errorClass,
    message: f.message,
    ...(f.provider === undefined ? {} : { provider: f.provider }),
    ...(f.status === undefined ? {} : { status: f.status }),
    ...(f.retryAfterSeconds === undefined ? {} : { retry_after_seconds: f.retryAfterSeconds }),
  }));
  const wait = verdict.retryAfterSeconds === undefined ? {} : { retry_after_seconds: verdict.retryAfterSeconds };
  return { reason: verdict.reason, failed_steps, completed_steps: verdict.completedSteps, total_steps: verdict.totalSteps, consolidation: verdict.consolidation, ...wait };
}

function failedFrame(event: OrcEvent, verdict: RunFailureVerdict): RunFailedFrame {
  return { ...event, kind: "run_failed", detail: verdict.summary, run: { ...event.run, status: "failed", summary: `Run failed: ${verdict.summary}` }, verdict };
}

const whole = (cents: number | undefined): number => (Number.isFinite(cents) && (cents ?? 0) > 0 ? Math.trunc(cents ?? 0) : 0);

/**
 * One run's verdict, kept while its frames are delivered (`index.ts` `drive`). It counts what the
 * frames charged, learns how consolidation went, stamps the verdict on the terminal frame, and
 * writes it last at run end so no earlier summary overwrites it.
 */
export class VerdictBook {
  readonly #recovery: Pick<AutoRecovery, "modelFailures">;
  readonly #live: () => LiveRun | undefined;
  #costCents = 0;
  #consolidation: { outcome: ConsolidationOutcome; error?: ModelCallFailure } | undefined;
  #terminal = false;
  #verdict: RunFailureVerdict | undefined;

  constructor(recovery: Pick<AutoRecovery, "modelFailures">, live: () => LiveRun | undefined) {
    this.#recovery = recovery;
    this.#live = live;
  }

  /**
   * The wrapper consolidator's gateway. A provider that already refused this run on a rate limit or
   * its credentials is not asked again for the brief (the step's failure is the answer); a call
   * that fails is booked as the consolidation's failure.
   */
  consolidatorGateway(gateway: ModelGateway): ModelGateway {
    return {
      ...gateway,
      complete: async (request) => {
        const refused = this.#failures().flatMap(([, attempts]) => attempts).find((f) => f.errorClass === "rate_limit" || f.errorClass === "auth");
        if (refused !== undefined) {
          this.#consolidation = { outcome: "skipped" };
          throw new Error(`consolidation skipped: a step already failed on ${causeOf(refused)}`);
        }
        try {
          return await gateway.complete(request);
        } catch (error) {
          this.#consolidation = { outcome: "failed", error: describeModelFailure(error) };
          throw error;
        }
      },
    };
  }

  /** Every delivered bus frame passes here: costs are counted, and a terminal frame gets the verdict. */
  observe(event: OrcEvent): OrcEvent {
    if (event.kind === "step_end" || event.kind === "consolidate_end") this.#costCents += whole(event.step?.costCents);
    if (event.kind === "consolidate_end") this.#consolidation ??= { outcome: "completed" };
    if (event.kind === "run_cancelled") this.#terminal = true;
    if (event.kind !== "run_done" && event.kind !== "run_failed") return event;
    this.#terminal = true;
    this.#verdict = this.#build({});
    return this.#verdict === undefined ? event : failedFrame(event, this.#verdict);
  }

  /** The planner's `run_failed` frame, with the verdict on it. */
  plannerFailed(event: OrcEvent, message: string): OrcEvent {
    this.#terminal = true;
    this.#verdict = this.#build({ planner: describeModelFailure(message) });
    return this.#verdict === undefined ? event : failedFrame(event, this.#verdict);
  }

  /**
   * Run end, after every other summary was written: the verdict is written last, into the live
   * cache the snapshot reads and the store. A drain that ended with no terminal frame after steps
   * failed at a provider (not a cancel, not a park) gets one here.
   */
  async finish(libs: Libs, runId: string, options: { readonly interrupted: boolean; readonly deliver: (event: OrcEvent) => void }): Promise<void> {
    const parked = this.#live()?.status === "awaiting_approval";
    if (!this.#terminal && !options.interrupted && !parked && this.#failures().length > 0) this.#synthesize(runId, {}, options.deliver);
    if (this.#verdict !== undefined) await persistVerdict(libs, runId, this.#verdict);
  }

  /** The drain died (a job or a frame threw): the stream still ends with a verdict naming why. */
  async abandon(libs: Libs, runId: string, error: unknown, deliver: (event: OrcEvent) => void): Promise<void> {
    if (!this.#terminal) this.#synthesize(runId, { stopped: error instanceof Error ? error.message : String(error) }, deliver);
    if (this.#verdict !== undefined) await persistVerdict(libs, runId, this.#verdict);
  }

  /** The snapshot `result()` resolves with, carrying the verdict when there is one. */
  attach(snapshot: OrchestrationRunSnapshot): VerdictSnapshot {
    return this.#verdict === undefined ? snapshot : { ...snapshot, verdict: this.#verdict };
  }

  #failures(): Array<[string, readonly ModelCallFailure[]]> {
    return [...this.#recovery.modelFailures()].map(([stepId, attempts]) => [stepId, attempts.map(toModelFailure)]);
  }

  #build(extra: { planner?: ModelCallFailure; stopped?: string }): RunFailureVerdict | undefined {
    return buildVerdict({
      steps: this.#live()?.steps ?? [],
      failures: new Map(this.#failures()),
      consolidation: this.#consolidation ?? { outcome: "skipped" },
      costCents: this.#costCents,
      ...extra,
    });
  }

  #synthesize(runId: string, extra: { stopped?: string }, deliver: (event: OrcEvent) => void): void {
    // No consolidate_end will carry the planner's and the critic's charge now: count it here.
    this.#costCents += takeOrchestrationCharge(runId)?.cents ?? 0;
    this.#terminal = true;
    this.#verdict = this.#build(extra);
    if (this.#verdict === undefined) return;
    const at = new Date().toISOString();
    deliver(failedFrame({ kind: "run_failed", runId, at, run: { id: runId, completedAt: at } }, this.#verdict));
  }
}

async function persistVerdict(libs: Libs, runId: string, verdict: RunFailureVerdict): Promise<void> {
  const summary = `Run failed: ${verdict.summary}`;
  const live = libs.orchestrator.getOrchestrationRun(runId);
  if (live?.status === "cancelled") return;
  const completedAt = live?.completedAt ?? new Date().toISOString();
  if (live) {
    live.status = "failed";
    live.summary = summary;
    live.completedAt = completedAt;
    libs.cache.cacheOrchestrationRun(live);
  }
  await libs.store.updateOrchestratorRun(runId, { status: "failed", summary, completedAt }).catch(() => undefined);
}

// --- Run-end writes moved from index.ts (unchanged) ---------------------------------------------

/**
 * D1b: the pipeline marks a step `completed` even when its seat never reached a model (the seat
 * loop turns a provider error into the summary "Model returned an invalid tool-use turn." and the
 * offline critic auto-passes). When the guard saw every call fail, the run is failed here — in the
 * live cache the snapshot reads from AND in the store — with the provider's own message.
 */
export async function applySeatFailureOverride(libs: Libs, runId: string, tally: SeatTally): Promise<void> {
  const runFailure = tally.runFailure();
  // B2: a step the wrapper ended itself (a seat past its cap) is failed here too, whatever the run did.
  if (runFailure === undefined && tally.abortedSteps().length === 0) return;
  const summary = runFailure === undefined ? undefined : `Run failed: every model call failed: ${runFailure}`;
  const completedAt = new Date().toISOString();
  const live = libs.orchestrator.getOrchestrationRun(runId);
  if (live) {
    if (summary !== undefined) {
      live.status = "failed";
      live.summary = summary;
      live.completedAt = live.completedAt ?? completedAt;
    }
    applyStepFailures(live.steps, tally);
    libs.cache.cacheOrchestrationRun(live);
  }
  if (summary !== undefined) await libs.store.updateOrchestratorRun(runId, { status: "failed", summary, completedAt }).catch(() => undefined);
}

/**
 * With a provider configured, a planner failure is an error, not a canned plan: the pipeline's
 * `callJsonWithFallback` swallowed it, so the wrapper fails the run — live cache and store — with
 * the provider's own message. Returns the summary written.
 */
export async function applyPlannerFailure(libs: Libs, runId: string, message: string): Promise<{ summary: string; completedAt: string }> {
  const summary = `Run failed: planner call failed: ${message}`;
  const completedAt = new Date().toISOString();
  const live = libs.orchestrator.getOrchestrationRun(runId);
  if (live) {
    live.status = "failed";
    live.summary = summary;
    live.completedAt = live.completedAt ?? completedAt;
    libs.cache.cacheOrchestrationRun(live);
  }
  await libs.store.updateOrchestratorRun(runId, { status: "failed", summary, completedAt }).catch(() => undefined);
  return { summary, completedAt };
}
