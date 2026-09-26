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
 * [S1.1] Council review, the runner-level blockers:
 *   B6  only a `dryRun` hold parks the run. A `needs_approval` that `execute` returns (after a yes,
 *       or from a gate inside the adapter) is that call's result, told how it is decided, and
 *       counted by the misuse stop, as the app's seat loop treats a hold after a grant. The same
 *       call a human approved earlier in this run is run again under that approval, so the
 *       idempotency store answers it; a call that differs from an approved one is held once, and
 *       its hold names what changed (`holds.ts`).
 *   B1  `requiresApproval` is asked INSIDE the run's tool-call context, so the policy ring it reads
 *       is the run's (the session's, when bound), not the process ring.
 *   C1  the reply is read without its `<think>`, and kept that way; a constrained-output request
 *       reads the envelope back.
 *   C2  each result reaches the model capped; a request over the window is refused before it is
 *       sent, with a verdict naming the sizes.
 *
 * `driveTurn` emits every frame of the turn, terminal ones included, and returns `parked` when it
 * stopped on a held call; what happens to a parked run is the runner's business (`runner.ts`).
 */
import { redactText } from "../errors/index.js";
import { evaluatePromptBudget } from "../fleet-memory/prompt-budget.js";
import { estimateTokens } from "../fleet-memory/tiers.js";
import type { BoundApprovalStore } from "../governance/bound-approvals.js";
import { runWithToolCallContext } from "../governance/tool-call-context.js";
import type { GatewayCompletion, GatewayMessage } from "../model-gateway/types.js";
import { record as toRecord } from "../tools/action.js";
import { CARD_ADAPTER_NAMES } from "../tools/human/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { clip, modelFailureVerdict, stopVerdict, type SoloEvent, type SoloEvents, type SoloStep } from "./events.js";
import { approvalIdOf, callKey, differenceNote, heldByExecute, type ApprovedCall } from "./holds.js";
import type { RunFailureVerdict } from "../orchestrator/verdict.js";
import { parseReply, TOOL_CALL_BODY_SHAPE, TOOL_CALL_CLOSE, TOOL_CALL_OPEN, type SoloAction } from "./parse.js";
import { renderToolResult } from "./prompt.js";
import { SOLO_MISUSE_REPEATS, SOLO_SEAT, type SoloGateway, type SoloGatewayRequest, type SoloMeter, type SoloSession } from "./types.js";
import { withEnvelopeInstruction } from "./turn-settings.js"; // [C11] a constrained request tells the model its reply format

/** Everything one run carries between model calls, and across a park. */
export interface TurnState {
  readonly runId: string;
  readonly step: SoloStep;
  readonly events: SoloEvents;
  readonly messages: GatewayMessage[];
  /** [S1.1] The run's opening message as sent, and the index of the first message after it: what a park saves. */
  readonly opening: string;
  openedAt: number;
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
  /** [S1.1] The approval row the held call filed, when one can be named. */
  heldApprovalId: string | undefined;
  /** The human's decision on the held call; the runner sets it before the loop continues. */
  decision: "approved" | "rejected" | undefined;
  /** [S1.1] B6: calls a human approved in this run. */
  readonly approved: ApprovedCall[];
}

export interface TurnDeps {
  readonly gateway: SoloGateway;
  readonly adapters: readonly TrentToolAdapter[];
  readonly session: SoloSession;
  readonly meter: SoloMeter;
  readonly maxToolCalls: number;
  /** What every request carries besides its messages and signal: the role, the pin, sampling, [S1.1] the response format. */
  readonly request: Omit<SoloGatewayRequest, "messages" | "signal">;
  /** The seat loop's payload: `{ companyId }` when the surface has one. */
  readonly payload: Record<string, unknown>;
  /** [S1.1] C2: the most of one result the model is shown. */
  readonly maxToolResultChars: number;
  /** [S1.1] C2: the window and the output reservation; absent means the provider enforces its own. */
  readonly budget?: { readonly windowTokens: number; readonly reserveTokens: number };
  /** [S1.1] The bound rows, to name the row a hold filed. */
  readonly bindings?: BoundApprovalStore;
  /** [S1.1] After every tool result (the taint may have moved): the runner saves the session state. */
  readonly afterCall?: (state: TurnState) => void;
  /** [S1.1] A run is about to park: called BEFORE the gate frames, so a crash while a human decides loses nothing. */
  readonly onPark?: (state: TurnState) => void;
}

export type TurnEnd = "ended" | "parked";

type Frames = Generator<SoloEvent, TurnEnd, unknown>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const whole = (n: number | undefined): number => (Number.isFinite(n) && (n ?? 0) > 0 ? Math.trunc(n ?? 0) : 0);
const count = (n: number): string => n.toLocaleString("en-US");

export function repairPrompt(error: string): string {
  return [
    `Your last reply could not be run: ${error}`,
    `Reply again with either one or more blocks in exactly this form:`,
    TOOL_CALL_OPEN,
    TOOL_CALL_BODY_SHAPE,
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

/** Both gate frames for the held call, as the bus emits a seat's gate; [S1.1] each names the held call. */
export function* gateFrames(state: TurnState): Generator<SoloEvent, void, unknown> {
  const call = state.pending[0];
  const held = state.held;
  if (call === undefined || held === undefined) return;
  const pending = { name: call.adapter.name, action: call.action };
  yield state.events.gate("step_awaiting_approval", state.step, pending, held, state.toolCalls);
  yield state.events.gate("run_awaiting_approval", state.step, pending, held, state.toolCalls);
}

const isCard = (call: SoloAction): boolean => CARD_ADAPTER_NAMES.includes(call.adapter.name);

interface CallOutcome {
  readonly record: ToolCallRecord;
  /** Only a `dryRun` hold parks the run (B6). */
  readonly parks: boolean;
}

/** The gate, or the call, inside the run's tool-call context. A decision on a held call is spent here, once. */
async function gateOrRun(state: TurnState, deps: TurnDeps, call: SoloAction, decision: TurnState["decision"], heldId: string | undefined): Promise<CallOutcome> {
  const execute = async (approvedAs: string | undefined): Promise<CallOutcome> => {
    const result = await call.adapter.execute(call.action, deps.payload);
    return { record: result.status === "needs_approval" ? heldByExecute(result, approvedAs) : result, parks: false };
  };
  if (decision === "approved") {
    if (!isCard(call)) state.approved.push({ adapter: call.adapter.name, action: call.action, ...(heldId === undefined ? {} : { approvalId: heldId }) });
    return execute(heldId);
  }
  if (!call.adapter.requiresApproval(call.action)) return execute(undefined);
  const key = callKey(call.adapter.name, call.action);
  const same = state.approved.find((entry) => callKey(entry.adapter, entry.action) === key);
  // B6: approved once in this run; the chain grants it against that row and idempotency answers a repeat.
  if (same !== undefined) return execute(same.approvalId);
  const held =
    call.adapter.dryRun !== undefined
      ? await call.adapter.dryRun(call.action, deps.payload)
      : toRecord(call.adapter.name, call.action, "needs_approval", `${call.adapter.name} action requires approval before execution.`);
  if (held.status !== "needs_approval") return { record: held, parks: false };
  const note = differenceNote(state.approved, call);
  return { record: note === "" ? held : { ...held, summary: `${held.summary}${note}` }, parks: true };
}

async function runCall(state: TurnState, deps: TurnDeps, call: SoloAction): Promise<CallOutcome> {
  const decision = state.decision;
  const heldId = state.heldApprovalId;
  state.decision = undefined;
  state.held = undefined;
  state.heldApprovalId = undefined;
  if (decision === "rejected") {
    return { record: toRecord(call.adapter.name, call.action, "blocked", `${call.adapter.name}: a human rejected this call (${state.step.id}); it did not run.`), parks: false };
  }
  try {
    return await runWithToolCallContext({ runId: state.runId, stepId: state.step.id }, () => gateOrRun(state, deps, call, decision, heldId));
  } catch (error) {
    // A throw is the call's failed result, never the run's.
    return { record: toRecord(call.adapter.name, call.action, "failed", `${call.adapter.name}: the call threw: ${clip(redactText(messageOf(error)), 300)}`), parks: false };
  }
}

const MISUSE_VERB: Partial<Record<ToolCallRecord["status"], string>> = { failed: "failed", blocked: "was refused", needs_approval: "was held" };

/** Counts a failed, refused or [S1.1] execute-held record; the third of the same call is the stop. */
function misuseOf(state: TurnState, call: SoloAction, result: ToolCallRecord): string | undefined {
  const verb = MISUSE_VERB[result.status];
  if (verb === undefined) return undefined;
  const key = `${call.adapter.name}\u0000${call.action.replace(/\s+/g, " ").trim()}`;
  const count = (state.failures.get(key) ?? 0) + 1;
  state.failures.set(key, count);
  if (count < SOLO_MISUSE_REPEATS) return undefined;
  return `the same tool call ${verb} ${count} times: ${call.adapter.name} ${clip(call.action, 200)}: ${clip(result.summary, 200)}`;
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

/** [S1.1] C2: why this request may not be sent, or undefined when it fits (4 characters a token, `tiers.ts`). */
export function overBudget(messages: readonly GatewayMessage[], budget: TurnDeps["budget"]): string | undefined {
  if (budget === undefined) return undefined;
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const verdict = evaluatePromptBudget({ promptTokens: estimateTokens(chars), reserveTokens: budget.reserveTokens, windowTokens: budget.windowTokens });
  if (verdict.fits) return undefined;
  const system = messages[0]?.role === "system" ? messages[0].content.length : 0;
  const conversation = messages.filter((message) => message.role !== "system");
  const largest = conversation.reduce((max, message) => Math.max(max, message.content.length), 0);
  return (
    `the prompt (~${count(verdict.promptTokens)} tokens, estimated at 4 characters a token) plus the ${count(verdict.reserveTokens)}-token output reservation ` +
    `needs ${count(verdict.needTokens)} tokens, but the model's window is ${count(verdict.windowTokens)} tokens; it was not sent, because a local server ` +
    `would cut it silently. Sizes: system prefix ${count(system)} chars, conversation ${count(chars - system)} chars in ${conversation.length} messages, ` +
    `largest message ${count(largest)} chars. Start a new session or compact this one, lower agent.solo.max_tool_result_chars, or load the model with a larger context.`
  );
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
    const { record: result, parks } = await runCall(state, deps, call);
    state.toolCalls.push(result);
    await deps.session.append([{ role: "tool", content: renderToolResult(result, deps.maxToolResultChars), runId: state.runId, record: result }]);
    deps.afterCall?.(state);
    yield state.events.toolResults(state.step, state.toolCalls);
    if (parks) {
      // Parked: the held record is the call's answer for now, and the call stays first in line.
      state.held = result;
      state.heldApprovalId = approvalIdOf(state, deps.bindings, call, result);
      deps.onPark?.(state);
      yield* gateFrames(state);
      return "parked";
    }
    state.pending.shift();
    state.callsMade += 1;
    state.results.push(renderToolResult(result, deps.maxToolResultChars));
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
    const over = overBudget(state.messages, deps.budget);
    if (over !== undefined) return yield* fail(state, stopVerdict(over, state.costCents));
    let completion: GatewayCompletion;
    try {
      completion = await deps.gateway.complete({ ...deps.request, messages: withEnvelopeInstruction(state.messages, deps.request.responseFormat), ...(signal === undefined ? {} : { signal }) }); // [C11]
    } catch (error) {
      if (signal?.aborted) return yield* cancel(state, signal);
      return yield* fail(state, modelFailureVerdict(state.step, error, state.costCents));
    }
    charge(state, deps, completion);
    if (signal?.aborted) return yield* cancel(state, signal);

    const reply = parseReply(completion.text, deps.adapters, { envelope: deps.request.responseFormat !== undefined });
    if (reply.kind === "malformed") {
      if (state.malformedStreak >= 1) {
        return yield* fail(state, stopVerdict(`the model's reply could not be parsed twice in a row: ${clip(reply.error, 300)}`, state.costCents));
      }
      state.malformedStreak += 1;
      state.messages.push({ role: "assistant", content: reply.reply === "" ? "(empty reply)" : reply.reply }, { role: "user", content: repairPrompt(reply.error) });
      yield state.events.note(state.step, `the model's tool call could not be parsed (${clip(reply.error, 200)}); asking it once to repair the reply`);
      continue;
    }
    state.malformedStreak = 0;
    if (reply.kind === "answer") {
      // [S3] item 6: the answer carries the run's cost (`cost_cents` on the stored message, the session's total).
      await deps.session.append([{ role: "assistant", content: reply.text, runId: state.runId, costCents: state.costCents, tokens: state.tokens, ...(state.model === undefined ? {} : { model: state.model }) }]);
      yield state.events.answer(state.step, reply.text, state.toolCalls);
      yield state.events.stepEnd(state.step, "completed", usage(state));
      yield state.events.runDone(reply.text);
      return "ended";
    }
    state.messages.push({ role: "assistant", content: reply.reply });
    await deps.session.append([{ role: "assistant", content: reply.reply, runId: state.runId }]);
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
