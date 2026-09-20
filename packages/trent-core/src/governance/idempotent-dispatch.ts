/**
 * The dispatch point where a seat's tool call reaches a Trent adapter, made idempotent for the
 * calls that have side effects. `buildTrentTools` wraps every adapter it builds; the app's seat
 * loop then calls the wrapper's `execute` through the registry exactly as it would the adapter.
 *
 * Scope vocabulary (plan T0.7): a call is side-effecting when its tool name carries `write`,
 * `patch`, `execute`/`exec`, `send`, `network`, `terminal`, `process_manage`, `delegate` or
 * `cronjob_manage`, or [U1] one of the executors' own words: `publish`, `post`, `reply`, `book`,
 * `invoice`, `charge`, `pay`, `sms`, `refund`, `email`. Read-only tools (`read_file`,
 * `search_files`, `web_search`, ...) go straight through and are never recorded, and so does any
 * call made outside a seat turn, where there is no run/step to key on. The match is a substring,
 * so a name such as `postgres_query` is keyed too; that over-inclusion only ever collapses two
 * identical calls in one step into one result, which is the safe direction for a word that might
 * mean a post.
 *
 * Only a `completed` (or `mocked`) record is stored as the answer. `needs_approval` and `blocked`
 * are pauses, not results: the row is discarded so the call after the approval executes. A
 * `failed` record counts an attempt, matching the app's own two-attempt retry; when the attempts
 * are exhausted the wrapper returns a failed record naming the dead letter instead of throwing.
 */
import { record } from "../tools/action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { IdempotencyManager, IdempotencyRetryLimitError, toolCallKey, type ResultOutcome } from "./IdempotencyManager.js";
import { currentToolCallContext } from "./tool-call-context.js";

/** Substrings of a tool (or adapter) name that mean the call changes something outside the model's context. */
export const SIDE_EFFECT_SCOPE_TOKENS: readonly string[] = [
  "write", "patch", "execute", "exec", "send", "network", "terminal", "process_manage", "delegate", "cronjob_manage",
  // [U1] G3: what the market executors do. `orchestrator.resume` cannot double-post, double-book or double-charge.
  "publish", "post", "reply", "book", "invoice", "charge", "pay", "sms", "refund", "email",
];

function carriesSideEffectToken(name: string): boolean {
  const lowered = name.toLowerCase();
  return SIDE_EFFECT_SCOPE_TOKENS.some((token) => lowered.includes(token));
}

/**
 * Whether `tool` on `adapterName` is a side-effecting call. An action that names no tool (a bare
 * JSON object) is attributed to the adapter, so `terminal {}` and `terminal` alone agree.
 */
export function isSideEffecting(adapterName: string, tool: string): boolean {
  return tool === "" ? carriesSideEffectToken(adapterName) : carriesSideEffectToken(tool);
}

/** The `<tool>` head of a `<tool> <json>` action, lowercased; empty for a bare JSON action. */
export function toolNameOf(action: string): string {
  const trimmed = action.trim();
  const braceIndex = trimmed.indexOf("{");
  const head = (braceIndex === -1 ? trimmed : trimmed.slice(0, braceIndex)).trim();
  return (head.split(/\s+/)[0] ?? "").toLowerCase();
}

/** The arguments of an action in a form that hashes stably: the parsed JSON object, or the raw text. */
function argsOf(action: string): unknown {
  const trimmed = action.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) return trimmed;
  try {
    return JSON.parse(trimmed.slice(braceIndex)) as unknown;
  } catch {
    return trimmed;
  }
}

function outcomeOf(result: ToolCallRecord): ResultOutcome {
  if (result.status === "completed" || result.status === "mocked") return "completed";
  if (result.status === "failed") return "failed";
  return "discard";
}

function wrapExecute(adapter: TrentToolAdapter, manager: IdempotencyManager): TrentToolAdapter["execute"] {
  return async (action, payload) => {
    const context = currentToolCallContext();
    const tool = toolNameOf(action);
    if (context === undefined || !isSideEffecting(adapter.name, tool)) return adapter.execute(action, payload);
    const key = toolCallKey({ runId: context.runId, stepId: context.stepId, tool: `${adapter.name}:${tool}`, args: argsOf(action) });
    try {
      const outcome = await manager.executeWithIdempotency(key, "generic", () => adapter.execute(action, payload), { outcome: outcomeOf });
      return outcome.result;
    } catch (err: unknown) {
      if (err instanceof IdempotencyRetryLimitError) return record(adapter.name, action, "failed", err.message);
      throw err;
    }
  };
}

/**
 * Wraps each adapter so `execute` goes through `manager` for side-effecting calls. Every other
 * member is read from the original on access, so an adapter whose `scopes` is a live getter
 * (the MCP bridge) keeps working.
 */
export function idempotentAdapters(adapters: readonly TrentToolAdapter[], manager: IdempotencyManager): TrentToolAdapter[] {
  return adapters.map((adapter) => {
    const execute = wrapExecute(adapter, manager);
    return new Proxy(adapter, {
      get(target, property) {
        if (property === "execute") return execute;
        return Reflect.get(target, property, target);
      },
    });
  });
}
