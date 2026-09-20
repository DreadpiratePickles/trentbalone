/**
 * The autonomy level, and the safety floor that sits below it.
 *
 * The level decides HOW OFTEN a human is asked. It never decides WHETHER the floor applies:
 *
 *   hardline blocklist  (governance/hardline.ts)   -> refuse, at every level
 *   approvals.deny      (governance/deny-globs.ts) -> refuse, at every level
 *   approval floor      (tools/approval-floors.ts) -> refuse, at every level
 *   class floor         (gate-config-schema.ts)    -> ask, at every level, bound to the call
 *   ---------------------------------------------------------------------
 *   ask_always      ask for everything that is not a pure read
 *   ask_dangerous   ask exactly where the adapters' own floors already ask   [default]
 *   never           auto-approve what the floors would have asked about
 *
 * [U1] The class floor is the one floor that asks rather than refuses: a call that posts, sends,
 * books, invoices or charges (`external_send`, `money_moving`, `customer_facing`) is asked about
 * at every level, and `never` cannot lift it, because the seat loop grants approval loop-wide once
 * a human says yes and only a per-call binding (`bound-approvals.ts`) keeps the next send inside
 * the same step from riding on that yes.
 *
 * `ask_dangerous` is the default because it is what Trent already did before the level existed:
 * `file_ops` asks on a write, `terminal` and `code_execution` ask on a dangerous finding,
 * `plugins` and `mcp` ask unless `auto_approve` names the tool, `ask_human` asks unless the call
 * is delegated, and `memory`, `web`, `delegate`, `vision` and `browser` never ask. Naming that
 * behaviour is the whole point of the key; changing it silently would not be.
 */
import { z } from "zod";
import { classifyCall, type ClassifiableCall, type PolicyClass } from "./policy-rules.js";
import type { DenyHit } from "./deny-globs.js";
import type { HardlineHit } from "./hardline.js";

export const AUTONOMY_LEVELS = ["ask_always", "ask_dangerous", "never"] as const;
export const AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/** Today's behaviour, named. See the module comment for what "today" means adapter by adapter. */
export const DEFAULT_AUTONOMY: AutonomyLevel = "ask_dangerous";

export const ApprovalsConfigSchema = z.object({ deny: z.array(z.string().min(1)).default([]) });
export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>;

export type AutonomyOutcome = "allow" | "ask" | "refuse";

export interface AutonomyVerdict {
  readonly outcome: AutonomyOutcome;
  /** Empty for `allow`; otherwise what the seat and the user are told, naming the rule that fired. */
  readonly reason: string;
}

export interface AutonomyInput {
  readonly level: AutonomyLevel;
  readonly hardline: HardlineHit | null;
  readonly deny: DenyHit | null;
  /** `floorBlock`'s answer for this call's command, if it had one. Never auto-approvable. */
  readonly floor: string | null;
  /** What the adapter's own `requiresApproval` says. */
  readonly adapterAsks: boolean;
  readonly pureRead: boolean;
  /**
   * [U1] The floored classes this call carries (`classFloorOf`). Non-empty means "ask at every
   * level"; absent or empty means the level decides. Optional so the audit's probes of the three
   * refusing floors need not name it.
   */
  readonly classFloor?: readonly PolicyClass[];
}

export function autonomyVerdict(input: AutonomyInput): AutonomyVerdict {
  if (input.hardline !== null) {
    return { outcome: "refuse", reason: `Hardline rule ${input.hardline.id}: ${input.hardline.reason}. No autonomy level lifts this.` };
  }
  if (input.deny !== null) {
    return { outcome: "refuse", reason: `Refused by approvals.deny glob ${input.deny.glob}, which matched: ${input.deny.subject}` };
  }
  if (input.floor !== null) {
    return { outcome: "refuse", reason: `Approval floor: ${input.floor}. This is never auto-approvable, at any autonomy level.` };
  }
  if (input.classFloor !== undefined && input.classFloor.length > 0) {
    return {
      outcome: "ask",
      reason: `Class floor: this call is ${input.classFloor.join(" and ")}, so a human approves it at every autonomy level, bound to exactly these arguments`,
    };
  }
  if (input.level === "never") return { outcome: "allow", reason: "" };
  if (input.adapterAsks) return { outcome: "ask", reason: "this tool call needs approval before it runs" };
  if (input.level === "ask_always" && !input.pureRead) {
    return { outcome: "ask", reason: "autonomy is ask_always, so every call that is not a pure read needs approval" };
  }
  return { outcome: "allow", reason: "" };
}

/**
 * A pure read: `read_only` survived classification. `classifyCall` drops `read_only` as soon as a
 * call also writes, executes, sends, fetches or destroys, so `web_search` is a network call and
 * `read_file` is a read. A call nothing can classify is NOT a pure read, which is the safe way
 * round for `ask_always`.
 */
export function isPureRead(call: ClassifiableCall): boolean {
  return classifyCall(call).includes("read_only");
}

/**
 * [U1] The floored classes a call carries, in `floor` order. A pure read carries none: a
 * `get_contact` is `customer_facing` and a read, and a read never posts, sends, books, invoices or
 * charges anything.
 */
export function classFloorOf(call: ClassifiableCall, floor: readonly PolicyClass[]): PolicyClass[] {
  const classes = classifyCall(call);
  if (classes.includes("read_only")) return [];
  return floor.filter((cls) => classes.includes(cls));
}
