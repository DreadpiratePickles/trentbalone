/**
 * 3.8 — approval gates that block input and survive a restart.
 *
 * Durability note. `StorePort` has `createApproval`/`getApproval`/`resolveApproval` but
 * deliberately no `listApprovals`, so after a restart there is no way to ask the
 * database "what is still pending?". Rather than widen a port owned by another module,
 * the gate keeps its own durable INDEX: one `JobRun` row of type `trent_approval` per
 * approval, whose `summary` is the approval id. `listJobRuns(companyId)` gives the index
 * back after a restart, and each approval row remains the single source of truth for its
 * status — so a stale index entry for an answered approval is harmless.
 */

import { GLYPHS, truncate, visibleWidth, type Theme } from "../ui/index.js";
import type { ApprovalRow, ReplStore } from "./types.js";

/** The job-run type used purely as a durable index over pending approvals. */
export const APPROVAL_INDEX_TYPE = "trent_approval";

export interface ApprovalRequest {
  action: string;
  reason: string;
  agentRole: string;
  /** Set when the approval belongs to an orchestrator step. */
  stepId?: string;
}

export interface ApprovalCard {
  id: string;
  action: string;
  reason: string;
  agentRole: string;
}

export type ApprovalAnswer = "approved" | "rejected";

/** A decision on an approval card, or the typed line that answers an `ask_human` question. */
export type GateAnswer = "approved" | "rejected" | { readonly answer: string };

/** The calls a gate answer needs. `Orchestrator` from `@trent/core` satisfies it; `answer` resumes a question. */
export interface ApprovalTarget {
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
  answer?(runId: string, stepId: string, text: string): Promise<boolean>;
}

/**
 * The `onApprovalAnswer` that releases a parked orchestrator step. Shared by `index.ts` and the
 * tests so the REPL's real approval path is the one under test. A gate with no step id (a
 * restored card from an earlier session) has nothing to release and is a no-op.
 */
export function bindApprovalAnswers(
  target: ApprovalTarget,
): (runId: string, stepId: string | undefined, answer: GateAnswer) => Promise<void> {
  return async (runId, stepId, answer) => {
    if (stepId === undefined) return;
    if (typeof answer === "object") {
      if (target.answer === undefined) throw new Error("this orchestrator cannot take an answer to ask_human");
      await target.answer(runId, stepId, answer.answer);
    } else if (answer === "approved") await target.approve(runId, stepId);
    else await target.reject(runId, stepId);
  };
}

export class ApprovalGate {
  readonly #store: ReplStore;
  readonly #companyId: string;
  #open = new Map<string, ApprovalRow>();

  constructor(store: ReplStore, companyId: string) {
    this.#store = store;
    this.#companyId = companyId;
  }

  /** True while at least one approval is unanswered. Ordinary input must be refused. */
  get blocking(): boolean {
    return this.#open.size > 0;
  }

  /** Opens an approval, persists it, and indexes it so a restart can find it again. */
  async open(request: ApprovalRequest): Promise<ApprovalRow> {
    const record = await this.#store.createApproval({
      companyId: this.#companyId,
      action: request.action,
      reason: request.reason,
      toolName: request.agentRole,
      previewContent: request.stepId ?? null,
    });
    await this.#store.createJobRun({
      type: APPROVAL_INDEX_TYPE,
      trigger: "cli",
      companyId: this.#companyId,
      summary: record.id,
    });
    this.#open.set(record.id, record);
    return record;
  }

  /**
   * Rebuilds the in-memory view from the database. This is the restart path: a fresh
   * process with no shared memory finds every approval that is still pending.
   */
  async restore(limit = 200): Promise<ApprovalRow[]> {
    this.#open.clear();
    const index = await this.#store.listJobRuns(this.#companyId, limit);
    for (const job of index) {
      if (job.type !== APPROVAL_INDEX_TYPE || job.summary === "") continue;
      const approval = await this.#store.getApproval(job.summary);
      if (approval !== null && approval.status === "pending") this.#open.set(approval.id, approval);
    }
    return [...this.#open.values()];
  }

  /** Pending approvals, oldest first, re-read from the store so the status is never stale. */
  async pending(): Promise<ApprovalRow[]> {
    const rows: ApprovalRow[] = [];
    for (const id of [...this.#open.keys()]) {
      const current = await this.#store.getApproval(id);
      if (current === null || current.status !== "pending") {
        this.#open.delete(id);
        continue;
      }
      this.#open.set(id, current);
      rows.push(current);
    }
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Answers one approval. The store is the record; memory only tracks what is open. */
  async answer(id: string, answer: ApprovalAnswer): Promise<ApprovalRow> {
    const resolved = await this.#store.resolveApproval(id, answer);
    this.#open.delete(id);
    return resolved;
  }

  /** The approval the REPL is currently showing, if any. */
  get current(): ApprovalRow | undefined {
    for (const row of this.#open.values()) return row;
    return undefined;
  }
}

// ── the card ────────────────────────────────────────────────────────────────

const LABEL_WIDTH = 9;

function row(label: string, value: string, theme: Theme, width: number): string {
  const text = truncate(`${label.padEnd(LABEL_WIDTH)}${value}`, Math.max(1, width - 2));
  return `  ${theme.body(text)}`;
}

/**
 * The card. Ember throughout, because a human decision is required, and readable from
 * the diamond glyph alone when colour is unavailable.
 */
export function renderApprovalCard(card: ApprovalCard, theme: Theme, width: number): string[] {
  const w = Math.max(24, Math.floor(width));
  const heading = truncate(`${GLYPHS.needsApproval} APPROVAL REQUIRED`, w);
  const answer = truncate("  [y] approve    [n] reject", w);
  const lines = [
    theme.needsApproval(heading),
    row("Action", card.action, theme, w),
    row("Reason", card.reason, theme, w),
    row("Agent", card.agentRole, theme, w),
    row("Id", card.id, theme, w),
    theme.needsApproval(answer),
  ];
  for (const line of lines) {
    if (visibleWidth(line) > w) throw new RangeError("approval card exceeded its width");
  }
  return lines;
}
