/**
 * The seat guard and the event shaping it drives.
 *
 * The pipeline marks a step `completed` even when its seat never reached a model: the seat loop
 * turns a provider error into the summary "Model returned an invalid tool-use turn." and the
 * offline critic auto-passes (live proof, F2). `apps/web` is read-only, so the wrapper installs
 * its own seat executor through the existing DI seam, records what every call returned, and
 * rewrites the bus events and the final snapshot in that light. The same port normalises a split
 * tool name to the exact registered adapter (F3).
 */

import { normaliseSeatTurn } from "./tool-names.js";
import {
  FALLBACK_PLANNER_APPROVAL_TRIGGERS,
  type OrcEvent,
  type OrchestrationStepSnapshot,
  type SeatChatCompletionFn,
} from "./types.js";

/** The slice of `SeatModelExecutionInput` / `SeatModelExecutionResult` the guard reads. */
export interface SeatModelInput {
  readonly subtask: { readonly id: string; readonly seat: string };
  readonly toolLoopContext?: { readonly availableTools?: readonly string[]; readonly toolInstructions?: readonly string[] };
  readonly createChatCompletion?: SeatChatCompletionFn;
}

export interface SeatModelResult {
  readonly output: unknown;
  readonly model: string;
  readonly tokens: number;
  readonly costCents: number;
  readonly fallback: boolean;
  readonly error?: string;
}

export type SeatModelFn = (input: SeatModelInput) => Promise<SeatModelResult>;

// --- The seat guard: one tally per run --------------------------------------------------------

interface StepTally {
  calls: number;
  failed: number;
  lastError?: string;
  /**
   * B2: the step was ended by the wrapper itself rather than by the provider — today only the
   * per-seat spend cap (`./seat-guard-budget.ts`). It fails the step whatever the calls returned,
   * and it is deliberately NOT counted as a failed call, so one overspending seat never turns into
   * "every model call failed" for the whole run.
   */
  abort?: string;
}

/** What the guard port observed for one run, keyed by step id. */
export class SeatTally {
  readonly #steps = new Map<string, StepTally>();

  record(stepId: string, result: SeatModelResult): void {
    const entry = this.#steps.get(stepId) ?? { calls: 0, failed: 0 };
    entry.calls += 1;
    if (typeof result.error === "string" && result.error !== "") {
      entry.failed += 1;
      entry.lastError = result.error;
    }
    this.#steps.set(stepId, entry);
  }

  /** Ends this step as failed with `message`, whatever its model calls returned. */
  abort(stepId: string, message: string): void {
    const entry = this.#steps.get(stepId) ?? { calls: 0, failed: 0 };
    entry.abort ??= message;
    this.#steps.set(stepId, entry);
  }

  /** The ids of the steps the wrapper ended itself, in the order they were aborted. */
  abortedSteps(): string[] {
    return [...this.#steps.entries()].filter(([, entry]) => entry.abort !== undefined).map(([id]) => id);
  }

  /** The message when this step was aborted, or when every call it made failed; undefined otherwise. */
  stepFailure(stepId: string | undefined): string | undefined {
    if (stepId === undefined) return undefined;
    const entry = this.#steps.get(stepId);
    if (!entry) return undefined;
    if (entry.abort !== undefined) return entry.abort;
    if (entry.calls === 0 || entry.failed < entry.calls) return undefined;
    return entry.lastError ?? "model execution failed";
  }

  /** The provider message when EVERY seat call in the run failed; undefined otherwise. */
  runFailure(): string | undefined {
    let calls = 0;
    let failed = 0;
    let lastError: string | undefined;
    for (const entry of this.#steps.values()) {
      calls += entry.calls;
      failed += entry.failed;
      if (entry.lastError !== undefined) lastError = entry.lastError;
    }
    if (calls === 0 || failed < calls) return undefined;
    return lastError ?? "model execution failed";
  }
}

/**
 * Wraps the underlying seat executor: threads the seat-level provider port through, records every
 * result on the tally, and normalises a split tool name to the exact registered adapter.
 */
export function guardSeatModel(
  underlying: SeatModelFn,
  chat: SeatChatCompletionFn | undefined,
  tally: SeatTally,
  /** Per-adapter usage text, appended to the seat prompt's tool instructions when that tool is available. */
  instructions?: ReadonlyMap<string, string>,
): SeatModelFn {
  return async (input) => {
    const forwarded = chat ? { ...input, createChatCompletion: chat } : input;
    const result = await underlying(withToolInstructions(forwarded, instructions));
    tally.record(input.subtask.id, result);
    const registered = input.toolLoopContext?.availableTools;
    if (!registered || registered.length === 0) return result;
    const output = normaliseSeatTurn(result.output, registered);
    return output === result.output ? result : { ...result, output };
  };
}

/**
 * The seat loop only teaches the model the Workbench action shape (`buildToolInstructions`,
 * `seat-agent-loop.ts`); the registered toolsets carry their own `<tool> <json>` usage text, which
 * rides in on the same `toolInstructions` list the prompt renders as "Tool-specific instructions".
 */
function withToolInstructions(input: SeatModelInput, instructions: ReadonlyMap<string, string> | undefined): SeatModelInput {
  const loop = input.toolLoopContext;
  if (!instructions || instructions.size === 0 || !loop?.availableTools?.length) return input;
  const extra = loop.availableTools.map((tool) => instructions.get(tool)).filter((text): text is string => text !== undefined);
  if (extra.length === 0) return input;
  return { ...input, toolLoopContext: { ...loop, toolInstructions: [...(loop.toolInstructions ?? []), ...extra] } };
}

// --- Event shaping --------------------------------------------------------------------------------

export function stepFailureText(stepId: string | undefined, tally: SeatTally): string | undefined {
  const message = tally.stepFailure(stepId);
  if (message === undefined) return undefined;
  // A step the wrapper ended itself did reach a model; saying "model call failed" would be a lie.
  return tally.abortedSteps().includes(stepId ?? "") ? `Step failed: ${message}` : `Model call failed: ${message}`;
}

function failedStep(step: Partial<OrchestrationStepSnapshot> | undefined, text: string): Partial<OrchestrationStepSnapshot> {
  return { ...step, status: "failed", output: text };
}

/** Marks every step the guard ended — provider failure or wrapper abort — failed, in place. */
export function applyStepFailures(steps: { id: string; status: string; output?: string }[], tally: SeatTally): void {
  for (const step of steps) {
    const text = stepFailureText(step.id, tally);
    if (text === undefined) continue;
    step.status = "failed";
    step.output = text;
  }
}

function fallbackGateDetail(step: Partial<OrchestrationStepSnapshot> | undefined): string {
  return (
    `Approval gate added by the deterministic fallback planner (no planner model answered): the objective ` +
    `contains one of ${FALLBACK_PLANNER_APPROVAL_TRIGGERS.join(", ")}. ` +
    `Approve to run "${step?.title ?? "this step"}" as planned, or reject to skip it.`
  );
}

/** A tool gate carries the pending call the seat asked for; a plan gate does not. */
function isPlanGate(step: Partial<OrchestrationStepSnapshot> | undefined): boolean {
  if (!step || step.needsApproval !== true) return false;
  const loopState = (step as { seatLoopState?: { pendingToolCall?: unknown } }).seatLoopState;
  return loopState?.pendingToolCall === undefined;
}

/**
 * Rewrites one bus event in the light of what the guard observed. Returns undefined to drop it
 * (a critic verdict on a call that never reached the model is noise, not information).
 */
export function shapeEvent(event: OrcEvent, tally: SeatTally, fallbackPlan: boolean): OrcEvent | undefined {
  const stepFailure = tally.stepFailure(event.step?.id);
  const failureText = stepFailureText(event.step?.id, tally);
  switch (event.kind) {
    case "step_output":
      return failureText === undefined ? event : { ...event, step: failedStep(event.step, failureText), detail: failureText };
    case "step_critic":
      return stepFailure === undefined ? event : undefined;
    case "step_end":
      return failureText === undefined ? event : { ...event, step: failedStep(event.step, failureText), detail: stepFailure };
    case "step_awaiting_approval":
    case "run_awaiting_approval":
      return fallbackPlan && isPlanGate(event.step) ? { ...event, detail: fallbackGateDetail(event.step) } : event;
    case "run_done": {
      const runFailure = tally.runFailure();
      if (runFailure === undefined) return event;
      const detail = `every model call failed: ${runFailure}`;
      return { ...event, kind: "run_failed", detail, run: { ...event.run, status: "failed", summary: detail } };
    }
    default:
      return event;
  }
}

