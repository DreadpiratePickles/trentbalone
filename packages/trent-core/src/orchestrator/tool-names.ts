/**
 * The seat tool-name guard.
 *
 * The seat loop (`apps/web/lib/seat-agent-loop.ts`) accepts a tool call only when `toolCall.name`
 * is EXACTLY a registered adapter name. In the live proof the model sent
 * `{name:"memory", action:"read"}` for the tool advertised as `memory:read`; the loop recorded
 * `Tool "memory" is not allowed for this seat.` and the seat guessed an answer with no tool call
 * (finding F3). That file is read-only, so the wrapper normalises the obvious forms before the
 * loop sees them — and refuses when the mapping is ambiguous, because a wrong guess would run a
 * different tool than the model asked for.
 */

export interface RawToolCall {
  readonly name?: unknown;
  readonly action?: unknown;
}

export type ToolNameResolution =
  /** `name` is already a registered adapter. Nothing to do. */
  | { readonly kind: "exact"; readonly name: string }
  /** A single registered adapter matched; use these fields instead. */
  | { readonly kind: "normalised"; readonly name: string; readonly action: string; readonly from: string }
  /** More than one registered adapter could be meant. Refused; the loop records the miss. */
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  /** Nothing registered resembles it. Left alone. */
  | { readonly kind: "unknown" };

const SEPARATORS = /[.\/]/g;

function findExact(candidate: string, registered: readonly string[]): string | undefined {
  const lower = candidate.toLowerCase();
  return registered.find((name) => name.toLowerCase() === lower);
}

/**
 * Resolves a model-supplied tool call against the exact registered names the seat advertised.
 *
 * Forms accepted, in order:
 *   1. an exact (case-insensitive) match on `name`;
 *   2. `name` with `.` or `/` in place of `:` — `memory.read`, `steel/scrape`;
 *   3. `name` + the first word of `action` — `{name:"memory", action:"read"}` -> `memory:read`,
 *      with the remaining words kept as the action (or the original action when nothing remains);
 *   4. `name` as the prefix of exactly one registered `name:*` adapter.
 * Two or more candidates at step 4 is ambiguous and is refused.
 */
export function resolveToolName(call: RawToolCall, registered: readonly string[]): ToolNameResolution {
  if (typeof call.name !== "string") return { kind: "unknown" };
  const name = call.name.trim();
  const action = typeof call.action === "string" ? call.action.trim() : "";
  if (name === "") return { kind: "unknown" };

  const exact = findExact(name, registered);
  if (exact !== undefined) return { kind: "exact", name: exact };

  const separated = name.replace(SEPARATORS, ":");
  const viaSeparator = separated === name ? undefined : findExact(separated, registered);
  if (viaSeparator !== undefined) return { kind: "normalised", name: viaSeparator, action, from: name };

  const [verb, ...rest] = action.split(/\s+/).filter((part) => part !== "");
  if (verb !== undefined) {
    const joined = findExact(`${name}:${verb.replace(/[^\w-]/g, "")}`, registered);
    if (joined !== undefined) {
      return { kind: "normalised", name: joined, action: rest.length > 0 ? rest.join(" ") : action, from: name };
    }
  }

  const prefix = `${name.toLowerCase()}:`;
  const candidates = registered.filter((tool) => tool.toLowerCase().startsWith(prefix));
  if (candidates.length === 1) return { kind: "normalised", name: candidates[0]!, action, from: name };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "unknown" };
}

/**
 * Applies {@link resolveToolName} to a parsed seat turn. Returns the same object when nothing
 * changes, or a shallow copy with `toolCall` rewritten when a single adapter matched.
 */
export function normaliseSeatTurn<T>(output: T, registered: readonly string[]): T {
  if (output === null || typeof output !== "object") return output;
  const turn = output as { toolCall?: RawToolCall | null };
  const call = turn.toolCall;
  if (!call || typeof call !== "object") return output;
  const resolution = resolveToolName(call, registered);
  if (resolution.kind !== "normalised") return output;
  return { ...output, toolCall: { ...call, name: resolution.name, action: resolution.action } };
}
