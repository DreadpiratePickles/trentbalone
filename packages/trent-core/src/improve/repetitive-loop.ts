/**
 * The repetitive-loop tag (task I.15; CS329A L8 @22:56-23:41).
 *
 * METR's five agent failure modes are poor planning, wrong tool, wrong reasoning, premature
 * abandonment and repetitive loops. The last is detectable from the tool calls alone, with no
 * model call: the same tool invoked with the same arguments N times in a row (N = 3 by default).
 * The tag is `repetitive_loop:<tool>`, one per looping tool, so it lands in a trace's
 * `failureTags`, in a gate fixture's failure tags (and so in the frontier's cluster profile), and
 * the gate refuses to promote a candidate that loops (`blockedBy: "repetitive_loop"`).
 *
 * A call may be a bare string (a trace row's `adapter:tool` entries carry no arguments, so two
 * identical strings count as the same call) or `{ name, args }` from an executor that reports
 * arguments. Argument equality is structural: keys are sorted before hashing.
 */

export const REPETITIVE_LOOP_TAG = "repetitive_loop";
export const DEFAULT_LOOP_LENGTH = 3;

export interface ToolInvocation {
  readonly name: string;
  readonly args?: unknown;
}

export type ToolCallLike = string | ToolInvocation;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(",")}}`;
}

/** A stable identity for one call: the tool name plus its arguments in canonical form. */
export function invocationKey(call: ToolCallLike): string {
  if (typeof call === "string") return call;
  return call.args === undefined ? call.name : `${call.name} ${canonical(call.args)}`;
}

function nameOf(call: ToolCallLike): string {
  return typeof call === "string" ? call : call.name;
}

/**
 * The tags for every tool that was called identically `n` or more times in a row. Each tool is
 * tagged once, in the order its loop was first seen. Under `n` consecutive repeats is not a loop.
 */
export function detectRepetitiveLoops(calls: readonly ToolCallLike[], n: number = DEFAULT_LOOP_LENGTH): string[] {
  const minimum = Math.max(2, Math.trunc(n));
  const tags: string[] = [];
  let previous: string | undefined;
  let run = 0;
  for (const call of calls) {
    const key = invocationKey(call);
    run = key === previous ? run + 1 : 1;
    previous = key;
    if (run === minimum) {
      const tag = `${REPETITIVE_LOOP_TAG}:${nameOf(call)}`;
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

export function isRepetitiveLoopTag(tag: string): boolean {
  return tag === REPETITIVE_LOOP_TAG || tag.startsWith(`${REPETITIVE_LOOP_TAG}:`);
}
