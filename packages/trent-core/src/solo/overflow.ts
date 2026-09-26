/**
 * [C12] A context-length refusal is not a dead run (council C12; Hermes `agent/turn_overflow.py`).
 *
 * When the provider refuses a turn's request because the prompt does not fit its window
 * (`model-gateway/retry.ts` `context_overflow`), the run gets ONE recovery:
 *   1. the conversation is compacted once, mid-run: S3's `compactConversation`, forced, through the runner's
 *      compactor (`compaction.ts` `compactForRun`), with the run's own opening kept verbatim, so everything before
 *      the run is pruned and summarised and the run itself is untouched;
 *   2. the run's request is rebuilt over the compacted history: the frozen system prefix byte-identical (the same
 *      object, never rebuilt), the history re-read from the session, the run's own messages as they were sent. The
 *      shape is `runner.ts` `rebuild`'s for a park;
 *   3. the call is made again, once.
 * A second refusal in the same run, a compaction that shrank nothing, or a runner that cannot compact ends the run
 * with a verdict naming the window, so the same oversized request is never sent a third time (coding rule 6:
 * repeating the same failure is not progress). Hermes allows several attempts; one is the council's bound.
 *
 * The recovery is per run, kept in a WeakSet on the run's state, as `repeat-stop.ts` keeps its count.
 */
import { redactText } from "../errors/index.js";
import { classifyProviderError } from "../model-gateway/retry.js";
import type { GatewayMessage } from "../model-gateway/types.js";
import { describeCompaction, type SoloCompactionOutcome } from "./compaction.js";
import { clip, type SoloEvent } from "./events.js";
import { historyMessages, mergeRoles } from "./prompt.js";
import type { TurnDeps, TurnState } from "./turn.js";
import type { SoloMessage } from "./types.js";

/** The runs whose one recovery is spent. */
const RECOVERED = new WeakSet<object>();

const count = (n: number): string => n.toLocaleString("en-US");
const ADVICE = "Start a new session, lower agent.solo.max_tool_result_chars, or use a model with a larger window.";

/** "context window (200,000 tokens)", or where to name it when this process does not know it. */
export function windowName(windowTokens: number | undefined): string {
  return windowTokens === undefined ? "context window (its size is not known here; model_overrides.<model>.context_window names it)" : `context window (${count(windowTokens)} tokens)`;
}

/** True when the compaction changed what the next request carries. */
function shrank(outcome: SoloCompactionOutcome): boolean {
  return outcome.status === "compacted" || outcome.status === "pruned" || (outcome.status === "skipped" && outcome.pruned > 0);
}

/**
 * The run's request over the compacted history: the system message kept as it is, the history before the run's
 * opening re-rendered, the run's own messages (its opening as sent, then everything after it) unchanged. False when
 * the session no longer holds the run's opening, so there is nothing to rebuild around.
 */
export function rebuildRunMessages(state: TurnState, history: readonly SoloMessage[], maxToolResultChars: number): boolean {
  const index = history.findIndex((message) => message.runId === state.runId && message.role === "user");
  const system = state.messages[0];
  if (index === -1 || system?.role !== "system") return false;
  const own: GatewayMessage[] = [{ role: "user", content: state.opening }, ...state.messages.slice(state.openedAt)];
  const next = [system, ...mergeRoles([...historyMessages(history.slice(0, index), maxToolResultChars), ...own])];
  state.messages.splice(0, state.messages.length, ...next);
  state.openedAt = next.length - (own.length - 1);
  return true;
}

export type OverflowDeps = Pick<TurnDeps, "budget" | "compactOnOverflow" | "session" | "maxToolResultChars">;

/**
 * Undefined when `error` is not a context-length refusal (the caller's usual failure path); `retry` after the one
 * compaction, with the request rebuilt and one step note yielded; otherwise the stop verdict's summary.
 */
export async function* recoverFromOverflow(state: TurnState, deps: OverflowDeps, error: unknown): AsyncGenerator<SoloEvent, "retry" | string | undefined> {
  if (classifyProviderError(error).errorClass !== "context_overflow") return undefined;
  const window = windowName(deps.budget?.windowTokens);
  const said = clip(redactText(error instanceof Error ? error.message : String(error)), 300);
  if (RECOVERED.has(state)) return `the conversation does not fit the model's ${window} even after one compaction in this run; the provider said: ${said}. ${ADVICE}`;
  RECOVERED.add(state);
  if (deps.compactOnOverflow === undefined) return `the prompt is over the model's ${window} and this conversation cannot be compacted; the provider said: ${said}. ${ADVICE}`;
  const outcome = await deps.compactOnOverflow(state.runId);
  const done = describeCompaction(outcome, "during this run");
  if (!shrank(outcome)) return `the prompt is over the model's ${window} and one compaction could not shrink it (${done}); the provider said: ${said}. ${ADVICE}`;
  if (!rebuildRunMessages(state, await deps.session.history(), deps.maxToolResultChars)) {
    return `the prompt is over the model's ${window}; the conversation was compacted (${done}), but the run's opening message is no longer in the session to rebuild the request around. ${ADVICE}`;
  }
  yield state.events.note(state.step, `The request was over the model's ${window}. ${done} Asking the model again, once.`);
  return "retry";
}
