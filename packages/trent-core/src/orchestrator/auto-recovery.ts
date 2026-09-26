/**
 * [X5] Auto-recovery cycles: a step that failed on a TRANSIENT provider or tool error is run
 * again, once per `agent.auto_recovery_cycles` (default 1), with the previous error appended to
 * its prompt as one plain sentence; then it stops.
 *
 * Why here and not in the pipeline: `apps/web` is read-only, and its `processExecuteStepPhase`
 * emits `step_end` for a failed step BEFORE it calls `enqueueReadyOrchestrationSteps(run)`. The
 * bus delivers that event synchronously, so a listener that resets the live step to `pending`
 * inside the event makes the app's own scheduler re-enqueue it, with no second queue and no race
 * against the consolidate job. The step's earlier side effects are keyed in the idempotency store
 * by `{runId, stepId, tool, args}` (`governance/idempotent-dispatch.ts`), so the re-run's repeat
 * of a write or a send is answered from the store, exactly as a resume's replay is.
 *
 * What is never re-run: an approval park (no `step_end` is emitted for it), a budget stop (the
 * wrapper aborted the step itself, `SeatTally.abort`), a dependency skip, a hardline refusal or a
 * gated result (neither classifies as transient), and any non-transient error. The gateway's own
 * `classifyProviderError` decides transience; a tool result opts in with `TRANSIENT_TOOL_ERROR_MARKER`.
 *
 * Every cycle is one `step_note` on the run, the failed cycle's spend is carried onto the step
 * that finally completes, and a step that exhausts its cycles keeps every error it saw.
 *
 * [P2-11] Three things the run's verdict (`verdict.ts`) needs from here. The REAL provider error:
 * the app's seat executor keeps only the last provider's message, so `attributeSeatErrors` watches
 * the port and hands back the first real failure. A rate limit that outlasts the recovery window is
 * not re-run into the same limit; its wait is kept. And `modelFailures()`: what each step that
 * finally failed at a provider died of, attempt by attempt.
 */
import { classifyProviderError, DEFAULT_RETRY_POLICY, type ErrorClass } from "../model-gateway/retry.js";
import type { Libs, LiveRun } from "./libs.js";
import type { SeatModelFn, SeatTally } from "./seat-guard.js";
import type { OrcEvent, SeatChatCompletionFn } from "./types.js";

/** `agent.auto_recovery_cycles` when the config says nothing. */
export const DEFAULT_AUTO_RECOVERY_CYCLES = 1;

/**
 * [P2-11] How long one re-run can wait out a rate limit: a cycle re-runs at once, and the gateway
 * waits at most `capMs` before each of its further attempts. A 429 asking for longer than this is
 * not re-run, since the re-run would meet the same limit; its wait is surfaced for the caller.
 */
export const RECOVERY_WINDOW_MS = DEFAULT_RETRY_POLICY.capMs * (DEFAULT_RETRY_POLICY.attempts - 1);

/** A tool result whose summary starts with this is a failure the tool expects to clear on its own. */
export const TRANSIENT_TOOL_ERROR_MARKER = "[transient]";

export interface RecoveryFailure {
  readonly message: string;
  readonly transient: boolean;
  readonly errorClass: ErrorClass;
  /** [P2-11] What the provider said, when it said it: its name, the HTTP status, the wait it asked for. */
  readonly provider?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

/** [P2-11] The seat port's refusal of a provider the profile has no key for: nothing was called. */
const NOT_CALLED = /\bis not configured for this profile\b|\bwas not called\b/;

/** Messages the app writes for outcomes that are not errors at all, whatever their text. */
const NEVER_TRANSIENT = /^Skipped — dependency\b|^Stopped after max tool-use steps\.|\bStep rejected by founder\b|^Model returned an invalid tool-use turn\./i;

/**
 * The failure as the gateway classifies it — from an error object when there is one, or from its
 * message, because the app's seat executor keeps only `error.message` (`model-gateway.ts`,
 * `executeSeatModel`) and the pipeline keeps only `step.output`. The status, the transport code
 * and the undici phrasing are read back out of the text; nothing else is inferred.
 */
export function classifyRecoveryError(error: unknown): RecoveryFailure {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (message.trimStart().startsWith(TRANSIENT_TOOL_ERROR_MARKER)) return { message, transient: true, errorClass: "dependency" };
  if (NEVER_TRANSIENT.test(message.trim())) return { message, transient: false, errorClass: "internal" };
  const shaped = error instanceof Error || (typeof error === "object" && error !== null) ? error : fromMessage(message);
  const direct = classifyProviderError(shaped);
  // An Error that carries neither a status nor a code may still name one in its text.
  const classified = direct.errorClass === "internal" && shaped === error ? classifyProviderError(fromMessage(message)) : direct;
  const provider = providerOf(error, message);
  return {
    message,
    transient: classified.retryable,
    errorClass: classified.errorClass,
    ...(provider === undefined ? {} : { provider }),
    ...(classified.status === undefined ? {} : { status: classified.status }),
    ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
  };
}

/** [P2-11] The provider an error names: its own field, or the gateway's "<provider> request failed with HTTP" text. */
function providerOf(error: unknown, message: string): string | undefined {
  const own = typeof error === "object" && error !== null ? (error as { provider?: unknown }).provider : undefined;
  if (typeof own === "string" && own !== "") return own;
  return /^([a-z][a-z0-9_-]*) request failed with HTTP\b/i.exec(message.trim())?.[1];
}

/** An error `classifyProviderError` reads the way it reads an SDK error: the status and the transport code back out of the text. */
function fromMessage(message: string): Error {
  // The gateway's "HTTP 429", or an SDK's leading "401 status code" / "429 RESOURCE_EXHAUSTED".
  const status = /\bHTTP (\d{3})\b/.exec(message) ?? /^(\d{3}) (?:status code\b|[A-Z][A-Z_]{3,}\b)/.exec(message.trim());
  const code = /\b(E[A-Z_]{3,}|UND_ERR_[A-Z_]+)\b/.exec(message);
  return Object.assign(new Error(message), {
    ...(status ? { status: Number(status[1]) } : {}),
    ...(code ? { code: code[1] } : {}),
  });
}

/** The live step as the pipeline holds it: the fields a cycle resets or carries. */
interface LiveStep {
  id: string;
  title: string;
  status: string;
  output?: string;
  startedAt?: string;
  completedAt?: string;
  costCents?: number;
  tokens?: number;
  seatLoopState?: unknown;
  critique?: unknown;
  handoff?: unknown;
  toolCalls?: Array<{ status: string; summary: string }>;
}

interface StepState {
  cycles: number;
  readonly errors: string[];
  /** Spend of the cycles that failed, carried onto the step when it finally ends. */
  spentCents: number;
  tokens: number;
  exhausted: boolean;
  /** [P2-11] Set when the step was not re-run because the provider asked for a longer wait. */
  heldMs?: number;
}

/** [P2-11] What a step ended on, and whether a model call (not a tool, not the pipeline) was the cause. */
interface Found {
  readonly failure: RecoveryFailure;
  readonly model: boolean;
}

export interface AutoRecoveryOptions {
  readonly cycles: number;
  readonly tally: SeatTally;
  /** Writes a reset step's row (`libs.runPersist.persistStep`); absent in the unit tests. */
  readonly persistStep?: (run: LiveRun, step: LiveRun["steps"][number]) => Promise<void>;
  readonly now?: () => string;
}

/** What one bus event became: the frames to deliver, in order, and a write to await before the next job. */
export interface Observed {
  readonly events: readonly OrcEvent[];
  readonly work?: (() => Promise<void>) | undefined;
}

export interface ExhaustedStep {
  readonly stepId: string;
  readonly errors: readonly string[];
  /** [P2-11] The provider's wait when that, not the cycle budget, is why the step was not re-run. */
  readonly retryAfterMs?: number;
}

export class AutoRecovery {
  readonly #cycles: number;
  readonly #tally: SeatTally;
  readonly #persist: AutoRecoveryOptions["persistStep"];
  readonly #now: () => string;
  readonly #steps = new Map<string, StepState>();
  /** The error the seat port threw during the cycle in flight, by step; consumed at its `step_end`. */
  readonly #thrown = new Map<string, RecoveryFailure>();
  /**
   * What the cycle in flight has cost, by step, as the port saw it call by call. The app drops a
   * cycle's cost when the seat loop throws, so the wrapper's own count is what gets carried.
   */
  readonly #meter = new Map<string, { cents: number; tokens: number }>();
  /** [P2-11] The first real provider failure the port saw in a step's latest failed call; consumed at its `step_end`. */
  readonly #portFailure = new Map<string, RecoveryFailure>();
  /** [P2-11] Every provider failure a step's attempts ended on, in order; dropped when an attempt ends otherwise. */
  readonly #modelFailures = new Map<string, RecoveryFailure[]>();

  constructor(options: AutoRecoveryOptions) {
    this.#cycles = Number.isFinite(options.cycles) ? Math.max(0, Math.floor(options.cycles)) : DEFAULT_AUTO_RECOVERY_CYCLES;
    this.#tally = options.tally;
    this.#persist = options.persistStep;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Wraps the seat executor. A thrown error is classified and remembered for the step's
   * `step_end`, then rethrown so the pipeline fails the step exactly as it did before; a re-run
   * gets the previous error appended to its prompt.
   */
  wrapSeatModel(seat: SeatModelFn): SeatModelFn {
    return async (input) => {
      const stepId = input.subtask.id;
      const state = this.#steps.get(stepId);
      const forwarded = state !== undefined && state.cycles > 0 && !state.exhausted ? withRecoverySentence(input, state, this.#cycles) : input;
      try {
        const result = await seat(forwarded);
        const meter = this.#meter.get(stepId) ?? { cents: 0, tokens: 0 };
        meter.cents += Number.isFinite(result.costCents) ? Math.max(0, Math.trunc(result.costCents)) : 0;
        meter.tokens += Number.isFinite(result.tokens) ? Math.max(0, Math.trunc(result.tokens)) : 0;
        this.#meter.set(stepId, meter);
        return result;
      } catch (error) {
        this.#thrown.set(stepId, classifyRecoveryError(error));
        throw error;
      }
    };
  }

  /**
   * [P2-11] Wraps the app's seat executor, INSIDE the run meter. The app tries every provider of its
   * route through the port and keeps only the LAST error: on a one-key profile that is the refusal of
   * a provider it has no key for, which hides the provider that answered 429. This watches every port
   * attempt, keeps the first real provider failure (never a "not configured" refusal) and hands it
   * back as the result's error, so the tally, the step's frames and the cycle decision all read what
   * the provider said, its Retry-After included.
   */
  attributeSeatErrors(seat: SeatModelFn): SeatModelFn {
    return async (input) => {
      const port = input.createChatCompletion;
      if (port === undefined) return seat(input);
      let first: RecoveryFailure | undefined;
      const watched: SeatChatCompletionFn = async (request) => {
        try {
          return await port(request);
        } catch (error) {
          const failure = classifyRecoveryError(error);
          if (first === undefined && !NOT_CALLED.test(failure.message)) first = failure;
          throw error;
        }
      };
      const result = await seat({ ...input, createChatCompletion: watched });
      if (first === undefined || result.error === undefined || result.error === "") return result;
      this.#portFailure.set(input.subtask.id, first);
      return result.error === first.message ? result : { ...result, error: first.message };
    };
  }

  /** [P2-11] What each step that finally failed at a provider died of, attempt by attempt, by step id. */
  modelFailures(): ReadonlyMap<string, readonly RecoveryFailure[]> {
    return this.#modelFailures;
  }

  /**
   * Called from the bus listener, synchronously, inside the app's own emit. For a `step_end` that
   * failed on a transient error with cycles left, resets the live step to `pending` so the app's
   * scheduler re-enqueues it, and hands back the frames to deliver in order — the step as it
   * FAILED, then the cycle note (a surface must see the failure, then the note, then the new
   * `step_start`) — plus the write that puts the reset row in the store before the next job
   * hydrates it. Every other event comes back alone, as it came.
   */
  onBusEvent(event: OrcEvent, live: LiveRun | undefined): Observed {
    if (event.kind === "run_done") return { events: [this.#runEnd(event)] };
    if (event.kind !== "step_end") return { events: [event] };
    const stepId = event.step?.id;
    if (stepId === undefined) return { events: [event] };
    const liveStep = live?.steps.find((step) => step.id === stepId) as LiveStep | undefined;
    const thrown = this.#thrown.get(stepId);
    this.#thrown.delete(stepId);
    const found = this.#failureOf(stepId, event.step as Partial<LiveStep>, thrown);
    this.#book(stepId, found); // [P2-11] with or without cycles: the verdict reads it
    if (this.#cycles === 0) return { events: [event] };
    const state = this.#steps.get(stepId);
    const failure = found?.failure;
    const persist = this.#persist;

    if (failure === undefined) {
      // The step ended without a recoverable failure; a step that had failed cycles gets their
      // spend, on the live object and in its row, which the app wrote before it emitted.
      if (state === undefined || liveStep === undefined || live === undefined || !carrySpend(liveStep, state)) return { events: [event] };
      return { events: [event], work: persist === undefined ? undefined : () => persist(live, liveStep) };
    }
    if (!failure.transient) return { events: [event] };

    const current = state ?? { cycles: 0, errors: [], spentCents: 0, tokens: 0, exhausted: false };
    this.#steps.set(stepId, current);
    current.errors.push(failure.message);
    if (liveStep === undefined || live === undefined) return { events: [event] };

    // [P2-11] A wait longer than a re-run can sit out is the provider's answer, not a transient blip.
    const held = (failure.retryAfterMs ?? 0) > RECOVERY_WINDOW_MS ? failure.retryAfterMs : undefined;
    if (current.cycles >= this.#cycles || held !== undefined) {
      current.exhausted = true;
      if (held !== undefined) current.heldMs = held;
      carrySpend(liveStep, current);
      const output = `Step ${exhaustedOutput(current)}`;
      liveStep.status = "failed";
      liveStep.output = output;
      return { events: [{ ...event, step: { ...event.step, status: "failed", output }, detail: output }] };
    }

    current.cycles += 1;
    const meter = this.#meter.get(stepId) ?? { cents: liveStep.costCents ?? 0, tokens: liveStep.tokens ?? 0 };
    this.#meter.delete(stepId);
    current.spentCents += meter.cents;
    current.tokens += meter.tokens;
    const asFailed: OrcEvent = { ...event, step: { ...event.step, status: "failed" } };
    resetForCycle(liveStep);
    const detail =
      `auto recovery cycle ${current.cycles} of ${this.#cycles} for step ${stepId} (${liveStep.title}): ` +
      `re-running after a transient ${failure.errorClass} error: ${failure.message}`;
    const note: OrcEvent = { kind: "step_note", runId: event.runId, at: this.#now(), step: { id: stepId, title: liveStep.title }, detail };
    // The app persisted the row as failed before it emitted; the next job hydrates from rows.
    return { events: [asFailed, note], work: persist === undefined ? undefined : () => persist(live, liveStep) };
  }

  /**
   * The app counts a failed step with an error message as degraded-but-usable and ends the run
   * `completed`; a step that exhausted its cycles produced no work at all, so the stream says
   * `run_failed` with the summary `finish` writes to the store.
   */
  #runEnd(event: OrcEvent): OrcEvent {
    const exhausted = this.exhausted();
    if (exhausted.length === 0) return event;
    const summary = runFailureSummary(exhausted);
    return { ...event, kind: "run_failed", detail: summary, run: { ...event.run, status: "failed", summary } };
  }

  /** The steps that ran out of cycles, with every error they saw, in the order they exhausted. */
  exhausted(): ExhaustedStep[] {
    return [...this.#steps.entries()]
      .filter(([, state]) => state.exhausted)
      .map(([stepId, state]) => ({ stepId, errors: [...state.errors], ...(state.heldMs === undefined ? {} : { retryAfterMs: state.heldMs }) }));
  }

  /**
   * Run end. A step that exhausted its cycles never produced work, so the run is failed — in the
   * live cache the snapshot reads and in the store — with a summary naming the step and every
   * error, after the seat guard's own override so both are visible. A cancelled run is left alone.
   */
  async finish(libs: Libs, runId: string): Promise<void> {
    const exhausted = this.exhausted();
    if (exhausted.length === 0) return;
    const live = libs.orchestrator.getOrchestrationRun(runId);
    if (live === undefined || live.status === "cancelled") return;
    const summary = runFailureSummary(exhausted);
    const completedAt = live.completedAt ?? this.#now();
    for (const step of exhausted) {
      const liveStep = live.steps.find((candidate) => candidate.id === step.stepId);
      if (liveStep === undefined) continue;
      liveStep.status = "failed";
      liveStep.output = `Step ${exhaustedOutput({ errors: step.errors, heldMs: step.retryAfterMs })}`;
    }
    live.status = "failed";
    live.summary = summary;
    live.completedAt = completedAt;
    libs.cache.cacheOrchestrationRun(live);
    await libs.store.updateOrchestratorRun(runId, { status: "failed", summary, completedAt }).catch(() => undefined);
  }

  /** What the step failed on, if it failed at all: the thrown error, the tally, the app's own verdict, or a marked tool result. */
  #failureOf(stepId: string, step: Partial<LiveStep>, thrown: RecoveryFailure | undefined): Found | undefined {
    const port = this.#portFailure.get(stepId);
    this.#portFailure.delete(stepId);
    // A budget stop is the wrapper's own decision about this seat; more calls are the last thing it wants.
    if (this.#tally.abortedSteps().includes(stepId)) return undefined;
    if (thrown !== undefined) return { failure: thrown, model: true };
    const everyCallFailed = this.#tally.stepFailure(stepId);
    // [P2-11] The port's own classification when it saw the call fail: it still has the Retry-After.
    if (everyCallFailed !== undefined) return { failure: port?.message === everyCallFailed ? port : classifyRecoveryError(everyCallFailed), model: true };
    if (step.status === "failed") return { failure: classifyRecoveryError(step.output ?? ""), model: false };
    const last = step.toolCalls?.at(-1);
    if (last !== undefined && (last.status === "failed" || last.status === "blocked") && (step.output ?? "").includes(last.summary)) {
      const marked = classifyRecoveryError(last.summary);
      return marked.transient ? { failure: marked, model: false } : undefined;
    }
    return undefined;
  }

  /**
   * [P2-11] Books a step attempt that ended at a provider. Only a failure the provider (or the
   * transport to it) answered counts: an `internal` one may be a defect and is never reported as the
   * provider's. Any other ending drops what the step had booked, so a later cycle that completed, or
   * a step that then died of something else, is not blamed on the provider.
   */
  #book(stepId: string, found: Found | undefined): void {
    if (found === undefined || !found.model || found.failure.errorClass === "internal") {
      this.#modelFailures.delete(stepId);
      return;
    }
    const booked = this.#modelFailures.get(stepId) ?? [];
    booked.push(found.failure);
    this.#modelFailures.set(stepId, booked);
  }
}

/** The plain sentence a re-run carries: which attempt this is and what the last one died of. */
function withRecoverySentence<T extends object>(input: T, state: StepState, cycles: number): T {
  const previous = state.errors.at(-1) ?? "";
  const sentence =
    `The previous attempt at this step failed with a transient error (${previous}); ` +
    `this is recovery cycle ${state.cycles} of ${cycles}, so do the step again from the start.`;
  // `dynamicPrompt` is the app's per-step prompt (`SeatModelExecutionInput`); the guard's input type names only what it reads.
  const existing = (input as { dynamicPrompt?: string }).dynamicPrompt ?? "";
  return { ...input, dynamicPrompt: existing === "" ? sentence : `${existing}\n\n${sentence}` };
}

function resetForCycle(step: LiveStep): void {
  step.status = "pending";
  step.output = undefined;
  step.startedAt = undefined;
  step.completedAt = undefined;
  step.costCents = undefined;
  step.tokens = undefined;
  // Cleared so the seat loop starts at turn one; its earlier side effects are answered by the idempotency store.
  step.seatLoopState = undefined;
  step.critique = undefined;
  step.handoff = undefined;
}

/** Adds the failed cycles' spend to the step. Returns whether anything changed. */
function carrySpend(step: LiveStep, state: StepState): boolean {
  if (state.spentCents === 0 && state.tokens === 0) return false;
  step.costCents = (step.costCents ?? 0) + state.spentCents;
  step.tokens = (step.tokens ?? 0) + state.tokens;
  state.spentCents = 0;
  state.tokens = 0;
  return true;
}

function runFailureSummary(exhausted: readonly ExhaustedStep[]): string {
  return `Run failed: ${exhausted.map((step) => `step ${step.stepId} ${exhaustedOutput({ errors: step.errors, heldMs: step.retryAfterMs })}`).join("; ")}`;
}

function exhaustedOutput(state: { readonly errors: readonly string[]; readonly heldMs?: number | undefined }): string {
  if (state.heldMs !== undefined) {
    const wait = Math.ceil(state.heldMs / 1_000);
    return `failed and was not re-run: the provider asked to wait ${wait}s, longer than the ${RECOVERY_WINDOW_MS / 1_000}s a re-run can wait: ${state.errors.join("; then: ")}`;
  }
  const cycles = Math.max(0, state.errors.length - 1);
  return `failed after ${cycles} auto-recovery cycle${cycles === 1 ? "" : "s"}: ${state.errors.join("; then: ")}`;
}
