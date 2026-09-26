/**
 * [S1] One solo turn: model -> tool calls -> results -> model, until an answer, a stop or a park.
 *
 * Per reply, in order:
 *   - the calls it asked for run one by one. A call whose adapter `requiresApproval` goes through
 *     the gate instead: `dryRun` inside the run's tool-call context, which stamps the bound
 *     approval row with what the human is shown (`governance/autonomy-dispatch.ts`); a held record
 *     parks the run. `execute` of a held call happens only after a human's yes, in the same
 *     `(runId, stepId)` context, which is what makes the bound row grant exactly that call.
 *   - every result goes back to the model as ONE user message, after its reply.
 * Bounded four ways (coding rule 9): the tool-call cap, the same failing call three times
 * (the app's `repeatedToolMisuse` idea, `apps/web/lib/seat-agent-loop.ts`, keyed on the call
 * itself), one repair per malformed reply, and the meter's budget before every model call.
 *
 * `driveTurn` emits every frame of the turn, terminal ones included, and returns `parked` when it
 * stopped on a held call; what happens to a parked run is the runner's business (`runner.ts`).
 */
import { redactText } from "../errors/index.js";
import { runWithToolCallContext } from "../governance/tool-call-context.js";
import type { GatewayCompletion, GatewayMessage, GatewayStreamRequest } from "../model-gateway/types.js";
import { record as toRecord } from "../tools/action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { clip, modelFailureVerdict, stopVerdict, type SoloEvent, type SoloEvents, type SoloStep } from "./events.js";
import type { RunFailureVerdict } from "../orchestrator/verdict.js";
import { parseReply, TOOL_CALL_CLOSE, TOOL_CALL_OPEN, type SoloAction } from "./parse.js";
import { renderToolResult } from "./prompt.js";
import { SOLO_MISUSE_REPEATS, SOLO_SEAT, type SoloGateway, type SoloMeter, type SoloSession } from "./types.js";

/** Everything one run carries between model calls, and across a park. */
export interface TurnState {
  readonly runId: string;
  readonly step: SoloStep;
  readonly events: SoloEvents;
  readonly messages: GatewayMessage[];
  /** Every record of the step, in order: the cumulative list the frames carry. */
  readonly toolCalls: ToolCallRecord[];
  /** Calls of the last reply not run yet. While parked, the first is the held one. */
  pending: SoloAction[];
  /** Results of the last reply's calls, not yet handed back to the model. */
  results: string[];
  callsMade: number;
  costCents: number;
  tokens: number;
  model: string | undefined;
  /** Failed or refused records per call, for the misuse stop. */
  readonly failures: Map<string, number>;
  malformedStreak: number;
  /** The held record while parked. */
  held: ToolCallRecord | undefined;
  /** The human's decision on the held call; the runner sets it before the loop continues. */
  decision: "approved" | "rejected" | undefined;
}

export interface TurnDeps {
  readonly gateway: SoloGateway;
  readonly adapters: readonly TrentToolAdapter[];
  readonly session: SoloSession;
  readonly meter: SoloMeter;
  readonly maxToolCalls: number;
  /** What every request carries besides its messages and signal: the role, the pin, sampling. */
  readonly request: Omit<GatewayStreamRequest, "messages" | "signal">;
  /** The seat loop's payload: `{ companyId }` when the surface has one. */
  readonly payload: Record<string, unknown>;
}

export type TurnEnd = "ended" | "parked";

type Frames = Generator<SoloEvent, TurnEnd, unknown>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const whole = (n: number | undefined): number => (Number.isFinite(n) && (n ?? 0) > 0 ? Math.trunc(n ?? 0) : 0);

export function repairPrompt(error: string): string {
  return [
    `Your last reply could not be run: ${error}`,
    `Reply again with either one or more blocks in exactly this form:`,
    TOOL_CALL_OPEN,
    '<tool> {"key": "value"}',
    TOOL_CALL_CLOSE,
    `or your final answer in plain text with no ${TOOL_CALL_OPEN} block.`,
  ].join("\n");
}

function usage(state: TurnState) {
  return { tokens: state.tokens, costCents: state.costCents, ...(state.model === undefined ? {} : { model: state.model }) };
}

function* fail(state: TurnState, verdict: RunFailureVerdict): Frames {
  yield state.events.stepEnd(state.step, "failed", usage(state));
  yield state.events.runFailed(verdict);
  return "ended";
}

function* cancel(state: TurnState, signal: AbortSignal): Frames {
  const reason: unknown = signal.reason;
  const why = reason instanceof Error && reason.message !== "" ? `: ${reason.message}` : typeof reason === "string" && reason !== "" ? `: ${reason}` : "";
  yield state.events.stepEnd(state.step, "failed", usage(state));
  yield state.events.runCancelled(`the run was cancelled${why}`);
  return "ended";
}

/** Both gate frames for the held call, as the bus emits a seat's gate. */
export function* gateFrames(state: TurnState): Generator<SoloEvent, void, unknown> {
  const call = state.pending[0];
  const held = state.held;
  if (call === undefined || held === undefined) return;
  const title = `${call.adapter.name} ${call.action}`;
  yield state.events.gate("step_awaiting_approval", state.step, title, held, state.toolCalls);
  yield state.events.gate("run_awaiting_approval", state.step, title, held, state.toolCalls);
}

/** An adapter call inside the run's tool-call context. A throw is the call's failed result, never the run's. */
async function inContext(state: TurnState, call: SoloAction, fn: () => Promise<ToolCallRecord>): Promise<ToolCallRecord> {
  try {
    return await runWithToolCallContext({ runId: state.runId, stepId: state.step.id }, fn);
  } catch (error) {
    return toRecord(call.adapter.name, call.action, "failed", `${call.adapter.name}: the call threw: ${clip(redactText(messageOf(error)), 300)}`);
  }
}

/** The gate, or the call itself. A decision on a held call is spent here, once. */
async function runCall(state: TurnState, deps: TurnDeps, call: SoloAction): Promise<ToolCallRecord> {
  const decision = state.decision;
  state.decision = undefined;
  state.held = undefined;
  if (decision === "rejected") {
    return toRecord(call.adapter.name, call.action, "blocked", `${call.adapter.name}: a human rejected this call (${state.step.id}); it did not run.`);
  }
  if (decision === undefined && call.adapter.requiresApproval(call.action)) {
    const dryRun = call.adapter.dryRun;
    return inContext(state, call, async () =>
      dryRun !== undefined
        ? dryRun.call(call.adapter, call.action, deps.payload)
        : toRecord(call.adapter.name, call.action, "needs_approval", `${call.adapter.name} action requires approval before execution.`),
    );
  }
  return inContext(state, call, () => call.adapter.execute(call.action, deps.payload));
}

/** Counts a failed or refused record; the third of the same call is the stop. */
function misuseOf(state: TurnState, call: SoloAction, result: ToolCallRecord): string | undefined {
  if (result.status !== "failed" && result.status !== "blocked") return undefined;
  const key = `${call.adapter.name}\u0000${call.action.replace(/\s+/g, " ").trim()}`;
  const count = (state.failures.get(key) ?? 0) + 1;
  state.failures.set(key, count);
  if (count < SOLO_MISUSE_REPEATS) return undefined;
  return `the same tool call failed ${count} times: ${call.adapter.name} ${clip(call.action, 200)}: ${clip(result.summary, 200)}`;
}

function charge(state: TurnState, deps: TurnDeps, completion: GatewayCompletion): void {
  const cents = deps.meter.record(state.runId, {
    seat: SOLO_SEAT,
    stepId: state.step.id,
    model: completion.model,
    provider: completion.provider,
    ...(completion.providerAlias === undefined ? {} : { providerAlias: completion.providerAlias }),
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    cachedInputTokens: completion.cachedInputTokens ?? 0,
    estimated: completion.estimated,
    costCents: completion.costCents,
  });
  state.costCents += whole(cents);
  state.tokens += whole(completion.inputTokens) + whole(completion.outputTokens);
  if (completion.model !== "") state.model = completion.model;
}

/** Runs the pending calls of the last reply. Returns how the turn ended, or undefined to ask the model again. */
async function* runPending(state: TurnState, deps: TurnDeps, signal: AbortSignal | undefined): AsyncGenerator<SoloEvent, TurnEnd | undefined> {
  while (state.pending.length > 0) {
    if (signal?.aborted) return yield* cancel(state, signal);
    const call = state.pending[0]!;
    if (state.decision === undefined && state.callsMade >= deps.maxToolCalls) {
      const summary = `stopped at the solo loop's cap of ${deps.maxToolCalls} tool calls; the model asked for another: ${call.adapter.name} ${clip(call.action, 200)}`;
      return yield* fail(state, stopVerdict(summary, state.costCents));
    }
    const result = await runCall(state, deps, call);
    state.toolCalls.push(result);
    await deps.session.append([{ role: "tool", content: renderToolResult(result), runId: state.runId, record: result }]);
    yield state.events.toolResults(state.step, state.toolCalls);
    if (result.status === "needs_approval") {
      // Parked: the held record is the call's answer for now, and the call stays first in line.
      state.held = result;
      yield* gateFrames(state);
      return "parked";
    }
    state.pending.shift();
    state.callsMade += 1;
    state.results.push(renderToolResult(result));
    const misuse = misuseOf(state, call, result);
    if (misuse !== undefined) return yield* fail(state, stopVerdict(misuse, state.costCents));
  }
  return undefined;
}

async function* loop(state: TurnState, deps: TurnDeps, signal: AbortSignal | undefined): AsyncGenerator<SoloEvent, TurnEnd> {
  for (;;) {
    const ended = yield* runPending(state, deps, signal);
    if (ended !== undefined) return ended;
    if (state.results.length > 0) {
      state.messages.push({ role: "user", content: state.results.join("\n\n") });
      state.results = [];
    }

    if (signal?.aborted) return yield* cancel(state, signal);
    const stop = deps.meter.stopReason?.(state.runId);
    if (stop !== undefined) return yield* fail(state, stopVerdict(stop, state.costCents));
    let completion: GatewayCompletion;
    try {
      completion = await deps.gateway.complete({ ...deps.request, messages: [...state.messages], ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (signal?.aborted) return yield* cancel(state, signal);
      return yield* fail(state, modelFailureVerdict(state.step, error, state.costCents));
    }
    charge(state, deps, completion);
    if (signal?.aborted) return yield* cancel(state, signal);

    const reply = parseReply(completion.text, deps.adapters);
    if (reply.kind === "malformed") {
      if (state.malformedStreak >= 1) {
        return yield* fail(state, stopVerdict(`the model's reply could not be parsed twice in a row: ${clip(reply.error, 300)}`, state.costCents));
      }
      state.malformedStreak += 1;
      state.messages.push({ role: "assistant", content: completion.text }, { role: "user", content: repairPrompt(reply.error) });
      yield state.events.note(state.step, `the model's tool call could not be parsed (${clip(reply.error, 200)}); asking it once to repair the reply`);
      continue;
    }
    state.malformedStreak = 0;
    if (reply.kind === "answer") {
      await deps.session.append([{ role: "assistant", content: reply.text, runId: state.runId }]);
      yield state.events.answer(state.step, reply.text, state.toolCalls);
      yield state.events.stepEnd(state.step, "completed", usage(state));
      yield state.events.runDone(reply.text);
      return "ended";
    }
    state.messages.push({ role: "assistant", content: completion.text });
    await deps.session.append([{ role: "assistant", content: completion.text, runId: state.runId }]);
    if (reply.narration !== "") yield state.events.note(state.step, reply.narration);
    state.pending = [...reply.actions];
  }
}

/**
 * Drives the turn from wherever `state` stands. Anything that throws out of the loop itself (a
 * session write, say) still ends the run with ONE terminal frame naming it, never with none.
 */
export async function* driveTurn(state: TurnState, deps: TurnDeps, signal: AbortSignal | undefined): AsyncGenerator<SoloEvent, TurnEnd> {
  try {
    return yield* loop(state, deps, signal);
  } catch (error) {
    return yield* fail(state, stopVerdict(`the run stopped on an error: ${clip(redactText(messageOf(error)), 300)}`, state.costCents));
  }
}
