/**
 * [C16] The bench's owner: the scripted human who answers every held call, the same way for every harness.
 *
 * A headless Trent run never auto-answers a hold (`apps/cli/src/commands/groups/run.ts`), and every business
 * write is on the class floor, so a bench without a human would fail every write task for Trent while a
 * harness without gates passed them. So the bench declares one: a held call is approved when its tool is in
 * the task's `approves`, rejected otherwise, and every request is written to the world's decision log (the
 * guard tasks grade it). The owner decides at Trent's tool seam: `withOperator` wraps the gated adapters that
 * solo, the fleet and, over MCP, Hermes all call, and on a yes it does exactly what a human's yes does in a
 * solo run (`solo/turn.ts` gateOrRun): `dryRun` inside the call's (run, step), which stamps the bound row with
 * the preview the human would have read, then `execute` in the same (run, step), which the chain grants as the
 * step approval (`governance/bound-approvals.ts`). No harness spends a model turn waiting for a decision.
 */
import { toolNameOf } from "../governance/idempotent-dispatch.js";
import { record } from "../tools/action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import type { BenchTask, OperatorDecision } from "./types.js";

export interface BenchOperator {
  /** The task whose policy applies from now on, and where its decisions are written. */
  begin(task: Pick<BenchTask, "approves">, log: OperatorDecision[]): void;
  /** Answers one held call and writes the answer down. */
  decide(tool: string, args: unknown): boolean;
  /**
   * A gate on a whole step (the fleet's pre-step approval) names no call: it is approved and written down as
   * tool `step`, because nothing leaves the machine at it; every call the step then makes meets the owner at
   * the tool seam on its own.
   */
  approveStep(title: string): true;
}

/** The tool name a step gate is written down under. */
export const STEP_GATE = "step";

function argsOf(action: string): unknown {
  const brace = action.indexOf("{");
  if (brace === -1) return action;
  try {
    return JSON.parse(action.slice(brace)) as unknown;
  } catch {
    return action;
  }
}

/** The BRIDGE's name for a deferred tool's call (`tool_search/index.ts`); the owner is shown the tool itself. */
const BRIDGE_CALL = "tool_call";

/** The tool the owner is asked about and its arguments: a bridged `tool_call {name, arguments}` is unwrapped. */
export function heldCallOf(action: string): { tool: string; args: unknown } {
  const tool = toolNameOf(action);
  const args = argsOf(action);
  if (tool !== BRIDGE_CALL || args === null || typeof args !== "object") return { tool, args };
  const inner = args as { name?: unknown; arguments?: unknown };
  return typeof inner.name === "string" ? { tool: inner.name, args: inner.arguments ?? {} } : { tool, args };
}

export function createOperator(): BenchOperator {
  let approves: ReadonlySet<string> = new Set();
  let log: OperatorDecision[] = [];
  return {
    begin(task, decisions) {
      approves = new Set(task.approves);
      log = decisions;
    },
    decide(tool, args) {
      const approved = approves.has(tool);
      log.push({ tool, args, approved });
      return approved;
    },
    approveStep(title) {
      log.push({ tool: STEP_GATE, args: { title }, approved: true });
      return true;
    },
  };
}

/** The line a rejected call returns, as a human's no reads in a solo run. */
export function rejectedRecord(adapter: string, action: string, tool: string): ToolCallRecord {
  return record(adapter, action, "blocked", `${adapter}: the owner rejected ${tool || adapter}; it did not run.`);
}

/**
 * The adapters with the owner at their gate. `requiresApproval` answers false, because the question is
 * answered inside `execute`; every other member is the adapter's own (a Proxy, as the gate chain wraps).
 */
export function withOperator(adapters: readonly TrentToolAdapter[], operator: BenchOperator): TrentToolAdapter[] {
  return adapters.map((adapter) => {
    const execute = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
      if (!adapter.requiresApproval(action)) return adapter.execute(action, payload);
      const shown = adapter.dryRun === undefined ? undefined : await adapter.dryRun(action, payload);
      // A preview that refuses outright (a hardline or deny rule) is the call's answer: nobody is asked.
      if (shown !== undefined && shown.status !== "needs_approval") return shown;
      const held = heldCallOf(action);
      if (!operator.decide(held.tool, held.args)) return rejectedRecord(adapter.name, action, held.tool);
      return adapter.execute(action, payload);
    };
    return new Proxy(adapter, {
      get(target, property) {
        if (property === "requiresApproval") return () => false;
        if (property === "execute") return execute;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
}
