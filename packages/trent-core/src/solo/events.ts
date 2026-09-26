/**
 * [S1] The solo loop as orchestrator events. Only the 20 kinds of `orchestrator/types.ts` exist and
 * no surface may be taught a new one, so each part of a turn takes the kind its consumers already
 * read:
 *   run_start                     the objective (REPL "Objective:", `rememberRun`)
 *   step_start                    one step per run, seat `trent`
 *   step_note                     the model's own words beside a tool call; a repair notice
 *   step_output + toolCalls       a tool result: the step's CUMULATIVE record list, which is what
 *                                 the REPL draws its tool lines from (`repl/render.ts`), and what
 *                                 `questionFromEvent` and `TurnOutcome` read
 *   step_output + output          the answer, printed by the REPL and folded as progress text
 *   step_awaiting_approval,       a held call, as the bus reports a seat's gate: both frames, the
 *   run_awaiting_approval         held record on `toolCalls`, the record's summary as `detail`
 *   step_approved                 the held call was approved and runs now
 *   step_end                      status, model, tokens and the step's integer cents (the REPL
 *                                 ticker, the TUI and `trent run` add these up); no `output`, so
 *                                 the TUI shows the answer once, from `run_done`
 *   run_done                      the answer as `run.summary`: the run's artifact (the fold)
 *   run_failed                    the P2-11 verdict riding the frame (`orchestrator/verdict.ts`)
 *   run_cancelled                 an abort
 */
import {
  buildVerdict,
  describeModelFailure,
  type RunFailedFrame,
  type RunFailureVerdict,
} from "../orchestrator/verdict.js";
import type { OrcEvent, OrcEventKind, OrchestrationStepSnapshot } from "../orchestrator/types.js";
import type { ToolCallRecord } from "../tools/types.js";
import { SOLO_SEAT } from "./types.js";

/** A step frame with the seat loop's record list on it, as the app's frames carry it. */
export type SoloStepFrame = Partial<OrchestrationStepSnapshot> & { readonly toolCalls?: readonly ToolCallRecord[] };
export type SoloEvent = Omit<OrcEvent, "step"> & { readonly step?: SoloStepFrame };

/** The one step of a run, as every frame names it. */
export interface SoloStep {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string;
}

export interface StepUsage {
  readonly model?: string;
  readonly tokens: number;
  readonly costCents: number;
}

const TITLE_CHARS = 120;

export function clip(text: string, max: number = TITLE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export class SoloEvents {
  readonly #runId: string;
  readonly #objective: string;
  readonly #clock: () => Date;

  constructor(runId: string, objective: string, clock: () => Date) {
    this.#runId = runId;
    this.#objective = objective;
    this.#clock = clock;
  }

  #at(): string {
    return this.#clock().toISOString();
  }

  #frame(kind: OrcEventKind, extra: Omit<SoloEvent, "kind" | "runId" | "at">): SoloEvent {
    return { kind, runId: this.#runId, at: this.#at(), ...extra };
  }

  #step(step: SoloStep, fields: SoloStepFrame): SoloStepFrame {
    return { id: step.id, title: step.title, agentRole: SOLO_SEAT, ...fields };
  }

  runStart(startedAt: string): SoloEvent {
    return this.#frame("run_start", { run: { id: this.#runId, objective: this.#objective, status: "running", startedAt, trigger: "manual" } });
  }

  stepStart(step: SoloStep): SoloEvent {
    return this.#frame("step_start", { step: this.#step(step, { status: "running", startedAt: step.startedAt, dependsOn: [], riskLevel: "low", needsApproval: false }) });
  }

  note(step: SoloStep, detail: string): SoloEvent {
    return this.#frame("step_note", { step: this.#step(step, { status: "running" }), detail });
  }

  toolResults(step: SoloStep, toolCalls: readonly ToolCallRecord[]): SoloEvent {
    return this.#frame("step_output", { step: this.#step(step, { status: "running", toolCalls: [...toolCalls] }) });
  }

  answer(step: SoloStep, text: string, toolCalls: readonly ToolCallRecord[]): SoloEvent {
    return this.#frame("step_output", { step: this.#step(step, { status: "running", output: text, ...(toolCalls.length === 0 ? {} : { toolCalls: [...toolCalls] }) }) });
  }

  /** One gate frame. The title is the held call, which is what an approval card shows (`RunApprovalLink`). */
  gate(kind: "step_awaiting_approval" | "run_awaiting_approval", step: SoloStep, call: string, held: ToolCallRecord, toolCalls: readonly ToolCallRecord[]): SoloEvent {
    const frame = this.#step(step, { title: clip(call), status: "awaiting_approval", needsApproval: true, toolCalls: [...toolCalls] });
    return this.#frame(kind, {
      step: frame,
      detail: held.summary,
      ...(kind === "run_awaiting_approval" ? { run: { id: this.#runId, status: "awaiting_approval" as const } } : {}),
    });
  }

  approved(step: SoloStep): SoloEvent {
    return this.#frame("step_approved", { step: this.#step(step, { status: "running" }) });
  }

  stepEnd(step: SoloStep, status: "completed" | "failed", usage: StepUsage): SoloEvent {
    return this.#frame("step_end", {
      step: this.#step(step, {
        status,
        startedAt: step.startedAt,
        completedAt: this.#at(),
        tokens: usage.tokens,
        costCents: usage.costCents,
        ...(usage.model === undefined ? {} : { model: usage.model }),
      }),
    });
  }

  runDone(summary: string): SoloEvent {
    return this.#frame("run_done", { run: { id: this.#runId, objective: this.#objective, status: "completed", summary, completedAt: this.#at() } });
  }

  /** The `run_failed` frame exactly as `verdict.ts` stamps one: summary as detail, "Run failed: ..." as the run's summary. */
  runFailed(verdict: RunFailureVerdict): SoloEvent & Pick<RunFailedFrame, "verdict"> {
    const at = this.#at();
    return {
      kind: "run_failed",
      runId: this.#runId,
      at,
      detail: verdict.summary,
      run: { id: this.#runId, objective: this.#objective, status: "failed", summary: `Run failed: ${verdict.summary}`, completedAt: at },
      verdict,
    };
  }

  runCancelled(detail: string): SoloEvent {
    return this.#frame("run_cancelled", { detail, run: { id: this.#runId, status: "cancelled", completedAt: this.#at() } });
  }
}

/** A stop that is not a provider's refusal: the cap, the misuse stop, the budget, a parse failure. */
export function stopVerdict(summary: string, costCents: number): RunFailureVerdict {
  return { reason: "run_error", summary, failedSteps: [], completedSteps: 0, totalSteps: 1, costCents, consolidation: "skipped" };
}

/** A model call that failed at the provider, through the fleet's own builder (P2-11). */
export function modelFailureVerdict(step: SoloStep, error: unknown, costCents: number): RunFailureVerdict {
  const failure = describeModelFailure(error);
  const verdict = buildVerdict({
    steps: [{ id: step.id, title: step.title, agentRole: SOLO_SEAT, status: "failed" }],
    failures: new Map([[step.id, [failure]]]),
    consolidation: { outcome: "skipped" },
    costCents,
  });
  return verdict ?? stopVerdict(`the model call failed: ${failure.message}`, costCents);
}
