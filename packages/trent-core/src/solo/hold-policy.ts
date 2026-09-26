/**
 * [S2] What a held call does on a surface with no human to decide it (council B8).
 *
 * A held call parks the solo run and waits for a decision. That is right where a human is attached:
 * the REPL, and the gateway when `gateway.owner` receives approval cards. Everywhere else (cron, the
 * heartbeat, a one-off `trent run` without a terminal, ACP) a parked run is a run nobody can answer,
 * and every tick would file another pending bound row. Hermes fails closed on those surfaces
 * (`approvals.cron_mode` et al. default `deny`), and so does this.
 *
 *   park       every hold parks the run; a decision continues it.
 *   questions  an `ask_human` / `clarify` question parks (its answer is ordinary input, which a
 *              conversational peer such as an A2A caller can give); a side-effect hold is refused.
 *              A peer never approves a side effect.
 *   deny       every hold is refused.
 *
 * A refused hold never reaches the adapter's own `dryRun`, so no bound approval row is filed for a
 * call nobody can decide. The call's result is a `blocked` record the model reads, and the loop's
 * misuse stop counts it like any other refusal. A hold that `execute` itself returns (a provenance
 * hold) is turned into the same refusal: the row it filed stays, and the run does not park on it.
 */
import { CARD_ADAPTER_NAMES } from "../tools/human/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";

export type SoloHoldPolicy = "park" | "questions" | "deny";

export const SOLO_HOLD_POLICIES: readonly SoloHoldPolicy[] = ["park", "questions", "deny"];

/** The words every refused hold carries, so a reader (and a test) can find them. */
export const NO_HUMAN_ATTACHED = "not run: no human is attached to this surface to approve it";

function refusal(adapter: string, action: string, surface: string | undefined, held?: string): ToolCallRecord {
  const where = surface === undefined ? "" : ` (${surface})`;
  const why = held === undefined ? "" : ` The hold was: ${held}`;
  return {
    adapter,
    action,
    status: "blocked",
    summary: `${adapter}: ${NO_HUMAN_ATTACHED}${where}. Say what you would have done; the person can run it from the REPL or the gateway.${why}`,
  };
}

/**
 * The adapter with its holds refused. A Proxy, so a class-based adapter keeps its own `this` and
 * every other member (name, scopes, instructions, `requiresApproval`) is the adapter's own.
 */
function refusingHolds(adapter: TrentToolAdapter, surface: string | undefined): TrentToolAdapter {
  const dryRun = async (action: string): Promise<ToolCallRecord> => refusal(adapter.name, action, surface);
  const execute = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
    const record = await adapter.execute(action, payload);
    return record.status === "needs_approval" ? refusal(adapter.name, action, surface, record.summary) : record;
  };
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "dryRun") return dryRun;
      if (property === "execute") return execute;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** True when the adapter's hold is a question to the person, never a side effect. */
export function isQuestionAdapter(name: string): boolean {
  return CARD_ADAPTER_NAMES.includes(name);
}

/** The adapters a conversation's runner gets under its surface's policy. */
export function applyHoldPolicy(adapters: readonly TrentToolAdapter[], policy: SoloHoldPolicy, surface?: string): TrentToolAdapter[] {
  if (policy === "park") return [...adapters];
  return adapters.map((adapter) => (policy === "questions" && isQuestionAdapter(adapter.name) ? adapter : refusingHolds(adapter, surface)));
}
