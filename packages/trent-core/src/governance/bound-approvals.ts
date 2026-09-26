/**
 * [U1] G2 — an approval bound to one tool call.
 *
 * The app's seat loop grants approval for the REST OF THE STEP once a human says yes
 * (`apps/web/lib/seat-agent-loop.ts:209`), and a step that once held an approval re-runs with it
 * (`orchestrator-run-phases.ts:253`, `approvalGranted = Boolean(step.approvalId)`), so a yes to
 * "post to Instagram" would also cover the `twilio_send` the model issues next. This module is
 * the binding that stops that: a call that posts, sends, books, invoices or charges runs only when
 * an approval row exists for ITS key — the idempotency key `{runId, stepId, tool, args}`
 * (`IdempotencyManager.ts` toolCallKey) — and the row carries the preview the human was shown,
 * the way the app's social calendar binds `previewContent` to one post
 * (`apps/web/lib/social/calendar.ts:93-104`).
 *
 * Where a row lives: `<profile>/gateway.json`, the durable `ApprovalRow` table every other human
 * decision already uses (`gateway/store/GatewayStore.ts`), so `trent approvals list` shows it and
 * `trent approvals approve|reject <id>` decides it with no new command.
 *
 * How a row is granted, and the one implicit case:
 *   - `approved`: decided by a human on the row itself. Always honoured, for that key only.
 *   - `denied`: the call is refused as `blocked`, for that key only.
 *   - `pending` with `previewedAt`, inside a seat turn: the wrapper's `dryRun` stamped it at the
 *     pause where the human was shown this preview, and in the app's loop `execute` on a floored
 *     call is reached afterwards only through that step's yes (a no fails the step and it never
 *     runs again under that id). The replay is therefore granted and the row recorded as decided
 *     by the step approval. Outside a seat turn there is no step card, so nothing is implicit.
 *   - anything else: the call is parked as a new pending row and `needs_approval` is returned.
 * A second identical call after a grant is the idempotency wrapper's problem, which is inside
 * this one and returns the first result.
 */
import crypto from "node:crypto";
import path from "node:path";
import { FileGatewayStore, type ApprovalRow, type GatewayStore } from "../gateway/store/GatewayStore.js";
import { record } from "../tools/action.js";
import type { ToolCallRecord } from "../tools/types.js";
import { stampAutoReviewGrantUse } from "./auto-review-config.js"; // [H1] auto review
import { toolCallKey } from "./IdempotencyManager.js";

export const BOUND_CALL_KIND = "bound_call";
/** `decidedBy` on a row the step's own approval granted (see the module comment). */
export const STEP_APPROVAL = "step approval";
/** Outside a seat turn every key still needs a run and a step; these are the placeholders. */
const NO_RUN = "no-run";
const NO_STEP = "no-step";
/** The action line `trent approvals list` prints is clipped; the full preview stays in `details`. */
const ACTION_LINE = 160;

/** One tool call, as the binding sees it. `runId`/`stepId` absent means outside a seat turn. */
export interface BoundCall {
  readonly adapter: string;
  /** The action exactly as the seat wrote it; the record carries it back. */
  readonly action: string;
  /** The `<tool>` head of the action, lowercased; empty for a bare JSON action, as the idempotency key has it. */
  readonly tool: string;
  readonly args: unknown;
  readonly runId?: string;
  readonly stepId?: string;
  /** The seat making the call; `ApprovalRow.agentId`. */
  readonly seat?: string;
  /** The floored classes that put the call here, for the founder's card. */
  readonly classes?: readonly string[];
}

export interface BoundApprovalDetails extends Record<string, unknown> {
  readonly kind: typeof BOUND_CALL_KIND;
  readonly key: string;
  readonly adapter: string;
  readonly tool: string;
  readonly args: unknown;
  /** What the human is shown: the exact content or amount that would leave the machine. */
  readonly preview: string;
  readonly classes: readonly string[];
  /** Set by `preview()`: the instant this preview was put in front of a human at a pause. */
  previewedAt?: string;
}

export interface BoundApprovalRow extends Omit<ApprovalRow, "details"> {
  readonly details: BoundApprovalDetails;
}

export type BoundApprovalDecision =
  | { readonly granted: true; readonly row: BoundApprovalRow }
  | { readonly granted: false; readonly row?: BoundApprovalRow; readonly record: ToolCallRecord };

export interface BoundApprovalStore {
  /** The newest row for this call's key, whatever its status. */
  find(call: BoundCall): BoundApprovalRow | undefined;
  /** A human is about to be shown `preview` for this call: the pending row, stamped. */
  preview(call: BoundCall, preview: string): BoundApprovalRow;
  /** The grant for exactly this call, or the parked row and the record to return instead. */
  require(call: BoundCall, preview: string): BoundApprovalDecision;
  /** Every pending bound row, oldest first. */
  list(): BoundApprovalRow[];
  /** The programmatic decision path; `trent approvals` reaches the same rows through the bridge. */
  decide(id: string, decision: "approved" | "denied", decidedBy: string): BoundApprovalRow | undefined;
}

/** The idempotency key of a call, with the tool qualified by its adapter exactly as the idempotency wrapper does. */
export function boundCallKey(call: BoundCall): string {
  return toolCallKey({ runId: call.runId ?? NO_RUN, stepId: call.stepId ?? NO_STEP, tool: `${call.adapter}:${call.tool}`, args: call.args });
}

function isBoundRow(row: ApprovalRow): row is BoundApprovalRow {
  const details = row.details as Partial<BoundApprovalDetails> | undefined;
  return details?.kind === BOUND_CALL_KIND && typeof details.key === "string" && typeof details.preview === "string";
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= ACTION_LINE ? line : `${line.slice(0, ACTION_LINE - 3)}...`;
}

function decideLine(id: string): string {
  return `Decide it with trent approvals approve ${id} or trent approvals reject ${id}; a different argument is a different approval.`;
}

/** What the founder and the seat see the call called: the tool, or the adapter for a bare action. */
function nameOf(call: BoundCall): string {
  return call.tool === "" ? call.adapter : call.tool;
}

function parkedRecord(call: BoundCall, row: BoundApprovalRow): ToolCallRecord {
  return record(
    call.adapter,
    call.action,
    "needs_approval",
    `${call.adapter}: ${nameOf(call)} is held as ${row.id} until a human approves exactly this call: ${row.details.preview}. ${decideLine(row.id)}`,
  );
}

function deniedRecord(call: BoundCall, row: BoundApprovalRow): ToolCallRecord {
  return record(call.adapter, call.action, "blocked", `${call.adapter}: ${nameOf(call)} was rejected by ${row.decidedBy ?? "a human"} as ${row.id}; exactly this call does not run.`);
}

export function createBoundApprovalStore(options: { readonly profileDir: string } | { readonly store: GatewayStore }): BoundApprovalStore {
  const store: GatewayStore = "store" in options ? options.store : new FileGatewayStore(path.join(options.profileDir, "gateway.json"));

  const newest = (rows: readonly BoundApprovalRow[]): BoundApprovalRow | undefined =>
    rows.reduce<BoundApprovalRow | undefined>((best, row) => (best === undefined || row.createdAt > best.createdAt ? row : best), undefined);

  const findByKey = (approvals: Record<string, ApprovalRow>, key: string): BoundApprovalRow | undefined =>
    newest(Object.values(approvals).filter((row): row is BoundApprovalRow => isBoundRow(row) && row.details.key === key));

  const insert = (approvals: Record<string, ApprovalRow>, call: BoundCall, key: string, preview: string, previewedAt?: string): BoundApprovalRow => {
    const now = new Date();
    const id = `appr_${String(now.getTime())}_${crypto.randomBytes(3).toString("hex")}`;
    const details: BoundApprovalDetails = {
      kind: BOUND_CALL_KIND,
      key,
      adapter: call.adapter,
      tool: nameOf(call),
      args: call.args,
      preview,
      classes: [...(call.classes ?? [])],
      ...(previewedAt === undefined ? {} : { previewedAt }),
    };
    const row: BoundApprovalRow = {
      id,
      nonce: crypto.randomBytes(4).toString("hex"),
      agentId: call.seat ?? "orchestrator",
      action: clip(`${nameOf(call)}: ${preview}`),
      details,
      status: "pending",
      createdAt: now.toISOString(),
      deliveredTo: [],
      ...(call.runId === undefined ? {} : { runId: call.runId }),
      ...(call.stepId === undefined ? {} : { stepId: call.stepId }),
      kind: "approval",
    };
    approvals[id] = row;
    return structuredClone(row);
  };

  const find = (call: BoundCall): BoundApprovalRow | undefined => findByKey(store.snapshot().approvals, boundCallKey(call));

  return {
    find,
    preview(call, preview) {
      const key = boundCallKey(call);
      return store.mutate((state) => {
        const existing = findByKey(state.approvals, key);
        if (existing === undefined || existing.status === "expired") return insert(state.approvals, call, key, preview, new Date().toISOString());
        // The human is being shown what the row already holds; only the stamp moves.
        if (existing.status === "pending") existing.details.previewedAt = new Date().toISOString();
        return structuredClone(existing);
      });
    },
    require(call, preview) {
      const key = boundCallKey(call);
      const inStep = call.runId !== undefined && call.stepId !== undefined;
      return store.mutate((state): BoundApprovalDecision => {
        const existing = findByKey(state.approvals, key);
        if (existing === undefined || existing.status === "expired") {
          const row = insert(state.approvals, call, key, preview);
          return { granted: false, row, record: parkedRecord(call, row) };
        }
        if (existing.status === "approved") {
          // [H1] auto review: a grant the reviewer decided is stamped the first time it is honoured (the call runs now), so a human's reversal can tell whether it ran. A human's grant is untouched.
          stampAutoReviewGrantUse(existing);
          return { granted: true, row: structuredClone(existing) };
        }
        if (existing.status === "denied") return { granted: false, row: structuredClone(existing), record: deniedRecord(call, existing) };
        if (inStep && existing.details.previewedAt !== undefined) {
          existing.status = "approved";
          existing.decidedAt = new Date().toISOString();
          existing.decidedBy = STEP_APPROVAL;
          return { granted: true, row: structuredClone(existing) };
        }
        return { granted: false, row: structuredClone(existing), record: parkedRecord(call, existing) };
      });
    },
    list() {
      return Object.values(store.snapshot().approvals)
        .filter((row): row is BoundApprovalRow => isBoundRow(row) && row.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    decide(id, decision, decidedBy) {
      return store.mutate((state) => {
        const row = state.approvals[id];
        if (row === undefined || !isBoundRow(row) || row.status !== "pending") return undefined;
        row.status = decision;
        row.decidedAt = new Date().toISOString();
        row.decidedBy = decidedBy;
        return structuredClone(row);
      });
    },
  };
}

/**
 * The store this process's adapters bind against. `buildTrentTools` installs the profile's on
 * every build; a surface that builds adapters another way installs its own. Nothing is implicit:
 * with none installed `requireBoundApproval` refuses and says so.
 */
let installed: BoundApprovalStore | undefined;

export function installBoundApprovals(store: BoundApprovalStore | undefined): void {
  installed = store;
}

export function currentBoundApprovals(): BoundApprovalStore | undefined {
  return installed;
}

/**
 * What a new adapter calls inside `execute`, with the exact content or amount it is about to
 * send as `preview`, before it sends anything. Granted means a human approved exactly this call;
 * otherwise the adapter returns `record` and sends nothing. The wrapper chain performs the same
 * check for every floored call, so an adapter that forgets is still gated; an adapter that calls
 * this is gated even when it is built outside the chain.
 */
export function requireBoundApproval(call: BoundCall, preview: string, store: BoundApprovalStore | undefined = installed): BoundApprovalDecision {
  if (store === undefined) {
    return {
      granted: false,
      record: record(
        call.adapter,
        call.action,
        "needs_approval",
        `${call.adapter}: ${nameOf(call)} did not run: no approval store is open in this process, so exactly this call cannot be approved. Build the toolsets with buildTrentTools, or call installBoundApprovals first.`,
      ),
    };
  }
  return store.require(call, preview);
}
