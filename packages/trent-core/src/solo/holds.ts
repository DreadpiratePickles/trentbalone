/**
 * [S1.1] Council review B6: what the solo loop knows about approvals inside one run.
 *
 * The app's seat loop never re-parks on a hold that comes back after a grant
 * (`apps/web/lib/seat-agent-loop.ts`: `needs_approval && !approvalGranted`); a solo run follows the
 * same rule with the pieces here. The same call a human approved earlier in this run is recognised
 * by the key the idempotency store and the bound rows use (`{adapter:tool, canonical args}`), so it
 * is run again under that approval and the store answers it; a call of the same tool with other
 * arguments is held once, and its hold says exactly which arguments changed; a hold that `execute`
 * returns is the call's result and says how a human decides it. The row a hold filed is named by
 * the bound row for exactly that call, else by the id in the hold's own summary.
 */
import type { BoundApprovalRow, BoundApprovalStore } from "../governance/bound-approvals.js";
import { canonicalJson } from "../governance/IdempotencyManager.js";
import { toolNameOf } from "../governance/idempotent-dispatch.js";
import type { ToolCallRecord } from "../tools/types.js";
import { clip, type SoloStep } from "./events.js";
import type { SoloAction } from "./parse.js";

/** [S1.1] B6: a call a human approved in this run, as the same call is recognised again. */
export interface ApprovedCall {
  readonly adapter: string;
  readonly action: string;
  readonly approvalId?: string;
}

/** The run a call belongs to, as the bound rows key it. */
export interface RunRef {
  readonly runId: string;
  readonly step: Pick<SoloStep, "id">;
}

/** The arguments exactly as the autonomy wrapper binds them (`autonomy-dispatch.ts` classifiable). */
function argsOfAction(action: string): unknown {
  const trimmed = action.trim();
  const brace = trimmed.indexOf("{");
  if (brace === -1) return action;
  try {
    return JSON.parse(trimmed.slice(brace)) as unknown;
  } catch {
    return action;
  }
}

export const callKey = (adapter: string, action: string): string => `${adapter}\u0000${toolNameOf(action)}\u0000${canonicalJson(argsOfAction(action))}`;

const APPROVAL_ID = /\bappr_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*/;

/** [S1.1] The bound approval row for exactly this call in this run, keyed as the autonomy wrapper keys it. */
export function boundRowOf(state: RunRef, bindings: BoundApprovalStore | undefined, call: SoloAction): BoundApprovalRow | undefined {
  return bindings?.find({ adapter: call.adapter.name, action: call.action, tool: toolNameOf(call.action), args: argsOfAction(call.action), runId: state.runId, stepId: state.step.id });
}

/** [S1.1] The row a hold filed: the bound row for exactly this call when the build has one, else the id its summary names. */
export function approvalIdOf(state: RunRef, bindings: BoundApprovalStore | undefined, call: SoloAction, held: ToolCallRecord): string | undefined {
  return boundRowOf(state, bindings, call)?.id ?? APPROVAL_ID.exec(held.summary)?.[0];
}

function shown(value: unknown): string {
  return value === undefined ? "(absent)" : clip(JSON.stringify(value) ?? String(value), 80);
}

/** [S1.1] B6: what a held call changed against a call of the same tool a human approved in this run. */
export function differenceNote(approvedCalls: readonly ApprovedCall[], call: SoloAction): string {
  const tool = toolNameOf(call.action);
  const approved = [...approvedCalls].reverse().find((entry) => entry.adapter === call.adapter.name && toolNameOf(entry.action) === tool);
  if (approved === undefined) return "";
  const before = argsOfAction(approved.action);
  const after = argsOfAction(call.action);
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const changes =
    isObject(before) && isObject(after)
      ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))
          .map((key) => `${key}: ${shown(before[key])} -> ${shown(after[key])}`)
      : [`arguments: ${shown(before)} -> ${shown(after)}`];
  const which = approved.approvalId === undefined ? "earlier in this run" : `as ${approved.approvalId}`;
  return ` This call differs from the call approved ${which}, so it needs its own approval: ${changes.join("; ")}.`;
}

/** [S1.1] B6: a hold `execute` returned is the call's result; say how it is decided, and that nothing waits for it. */
export function heldByExecute(result: ToolCallRecord, approvedAs: string | undefined): ToolCallRecord {
  const newId = APPROVAL_ID.exec(result.summary)?.[0];
  const again = approvedAs !== undefined && newId !== undefined && newId !== approvedAs ? ` It was approved as ${approvedAs} and then held again as ${newId}, a different approval.` : "";
  return {
    ...result,
    summary: `${result.summary}${again} Not run, and this run does not wait for it: a human decides it with trent approvals approve or reject, then asks again.`,
  };
}
