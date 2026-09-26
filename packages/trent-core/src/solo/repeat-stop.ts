/**
 * [CF] C11 open item 3: the stop for a SUCCESSFUL call the model keeps repeating.
 *
 * The misuse stop (`turn.ts` `misuseOf`, `SOLO_MISUSE_REPEATS`) counts failed, refused and held calls only, so a
 * model that repeats one call that succeeds runs on to the tool-call cap: C11 live run 2
 * (docs/sessions/2026-09-26-c11-solo-live.md) made the same `read_file` call 26 times and stopped at the cap of 25.
 * A call made again with the same arguments that returns the same result told the model nothing new, so the
 * {@link SOLO_SUCCESS_REPEATS}th such result stops the run with a verdict that names the loop.
 *
 * The count is per call (adapter and arguments, whitespace folded, as `misuseOf` keys it) and per result: a call
 * whose result changed (a file that was written, a process that printed more) starts again at 1. Calls need not be
 * consecutive: A, B, A, B... is the same loop. Five, not the misuse stop's three, because one legitimate repeat
 * returns identical text: `process_manage wait` on a background job that prints nothing yet.
 *
 * Kept per run in a WeakMap on the run's state, so the turn needs no new field: `turn.ts` `runPending` asks
 * `misuseOf(state, call, result) ?? repeatedSuccessOf(state, call, result)`.
 * A park rebuilt after a restart starts a fresh count, as `misuseOf`'s `failures` does.
 */
import type { ToolCallRecord } from "../tools/types.js";
import { clip } from "./events.js";

/** How many times the SAME successful call may return the SAME result before the run stops on it. */
export const SOLO_SUCCESS_REPEATS = 5;

/** The call as the turn holds it (`SoloAction` satisfies it). */
export interface RepeatedCall {
  readonly adapter: { readonly name: string };
  readonly action: string;
}

/** Per run: each call's last successful result, and how many times that call has returned it. */
const RUNS = new WeakMap<object, Map<string, { readonly summary: string; count: number }>>();

/** Why the run stops on this result, or undefined. `run` is the run's own state object (`TurnState`). */
export function repeatedSuccessOf(run: object, call: RepeatedCall, result: ToolCallRecord): string | undefined {
  if (result.status !== "completed") return undefined;
  const seen = RUNS.get(run) ?? new Map<string, { readonly summary: string; count: number }>();
  RUNS.set(run, seen);
  const key = `${call.adapter.name}\u0000${call.action.replace(/\s+/g, " ").trim()}`;
  const last = seen.get(key);
  const entry = last !== undefined && last.summary === result.summary ? last : { summary: result.summary, count: 0 };
  entry.count += 1;
  seen.set(key, entry);
  if (entry.count < SOLO_SUCCESS_REPEATS) return undefined;
  return (
    `the same tool call succeeded ${entry.count} times with the same result, a loop: ${call.adapter.name} ${clip(call.action, 200)}: ` +
    `${clip(result.summary, 200)}. Every repeat after the first returned what the conversation already held.`
  );
}
