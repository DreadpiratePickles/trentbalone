/**
 * [C12] The tool-call cap warns before it stops (council C12; Hermes `agent/turn_iteration_prep.py`
 * `_maybe_inject_iteration_budget_warning`, `agent/iteration_budget.py`).
 *
 * `agent.solo.max_tool_calls` (default 25, `types.ts`) stopped a run the moment the model asked for one call more,
 * with no warning, so a model mid-plan lost the answer it was about to give. Once a run has made
 * {@link SOLO_WRAP_UP_RATIO} of its calls, the next model request carries ONE note naming the calls left.
 *
 * Where it goes: appended to the request's last user message (the tool results the model is about to read), never as
 * a system message. The Anthropic client joins every system message into the one cached system block
 * (`model-gateway/anthropic-client.ts` `systemBlocks`), so a system message mid-run would change the frozen prefix;
 * the tail is the only part of the request no provider has cached yet (Hermes appends to the newest tool result for the
 * same reason). It stays in the run's messages, so later requests carry it as history, and it is never added twice.
 * It is not stored in the session: a budget note belongs to the run it was about.
 *
 * Kept per run in a WeakSet on the run's state, as `repeat-stop.ts` keeps its count; so a park rebuilt after a restart
 * (a new state object) past 80 percent may be told a second time. That is harmless; scanning the run's messages for the
 * wording instead would be wrong whenever a tool result quotes it.
 */
import type { TurnState } from "./turn.js";

/** The share of `max_tool_calls` after which the model is told to wrap up. */
export const SOLO_WRAP_UP_RATIO = 0.8;

/** The runs already told. */
const TOLD = new WeakSet<object>();

/** How many calls a run makes before the note: 80 percent, at least one call before the cap; none for a cap of 1. */
export function wrapUpAfter(maxToolCalls: number): number | undefined {
  if (!Number.isInteger(maxToolCalls) || maxToolCalls <= 1) return undefined;
  return Math.min(Math.ceil(maxToolCalls * SOLO_WRAP_UP_RATIO), maxToolCalls - 1);
}

export function wrapUpNote(left: number, maxToolCalls: number): string {
  return `[system note] ${String(left)} tool call${left === 1 ? "" : "s"} left; wrap up. This run stops at ${String(maxToolCalls)} tool calls: make only the calls that still matter, then answer the person with what you have.`;
}

/** Adds the note to the request about to be sent, once per run, when the run has reached the threshold. True when it did. */
export function addWrapUpNote(state: Pick<TurnState, "messages" | "callsMade">, maxToolCalls: number): boolean {
  const after = wrapUpAfter(maxToolCalls);
  if (after === undefined || state.callsMade < after || TOLD.has(state)) return false;
  TOLD.add(state);
  const note = wrapUpNote(maxToolCalls - state.callsMade, maxToolCalls);
  const last = state.messages.at(-1);
  if (last?.role === "user") state.messages[state.messages.length - 1] = { role: "user", content: `${last.content}\n\n${note}` };
  else state.messages.push({ role: "user", content: note });
  return true;
}
