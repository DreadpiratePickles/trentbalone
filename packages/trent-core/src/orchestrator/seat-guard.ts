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

  /** The provider message when every call this step made failed; undefined otherwise. */
  stepFailure(stepId: string | undefined): string | undefined {
    if (stepId === undefined) return undefined;
    const entry = this.#steps.get(stepId);
    if (!entry || entry.calls === 0 || entry.failed < entry.calls) return undefined;
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

function failedStep(step: Partial<OrchestrationStepSnapshot> | undefined, message: string): Partial<OrchestrationStepSnapshot> {
  return { ...step, status: "failed", output: `Model call failed: ${message}` };
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
  switch (event.kind) {
    case "step_output":
      return stepFailure === undefined ? event : { ...event, step: failedStep(event.step, stepFailure), detail: `Model call failed: ${stepFailure}` };
    case "step_critic":
      return stepFailure === undefined ? event : undefined;
    case "step_end":
      return stepFailure === undefined ? event : { ...event, step: failedStep(event.step, stepFailure), detail: stepFailure };
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

