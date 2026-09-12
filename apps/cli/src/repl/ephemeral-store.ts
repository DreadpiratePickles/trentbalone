/**
 * The no-persistence fallback.
 *
 * The durable store's driver adapter is bun:sqlite, so a Trent started under plain Node
 * cannot open it. Rather than pretend, the REPL falls back to this and SAYS SO: nothing
 * written here survives the process, and `index.ts` prints that before the first turn.
 */

import type { ApprovalRow, JobRunRow, ReplStore, RunRow, StepRow } from "./types.js";

export class EphemeralStore implements ReplStore {
  readonly #approvals = new Map<string, ApprovalRow>();
  readonly #jobs: JobRunRow[] = [];
  #n = 0;

  #id(prefix: string): string {
    this.#n += 1;
    return `${prefix}_${this.#n.toString(36)}`;
  }

  async createApproval(input: {
    companyId: string;
    action: string;
    reason: string;
  }): Promise<ApprovalRow> {
    const record: ApprovalRow = {
      id: this.#id("apr"),
      companyId: input.companyId,
      action: input.action,
      reason: input.reason,
      status: "pending",
      createdAt: new Date(),
      resolvedAt: null,
    };
    this.#approvals.set(record.id, record);
    return record;
  }

  async getApproval(id: string): Promise<ApprovalRow | null> {
    return this.#approvals.get(id) ?? null;
  }

  async resolveApproval(id: string, status: "approved" | "rejected"): Promise<ApprovalRow> {
    const current = this.#approvals.get(id);
    if (current === undefined) throw new Error(`no approval ${id}`);
    const next: ApprovalRow = { ...current, status, resolvedAt: new Date() };
    this.#approvals.set(id, next);
    return next;
  }

  async createJobRun(input: {
    type: string;
    trigger: string;
    companyId?: string | null;
    summary?: string;
  }): Promise<JobRunRow> {
    const record: JobRunRow = {
      id: this.#id("job"),
      type: input.type,
      status: "running",
      companyId: input.companyId ?? null,
      summary: input.summary ?? "",
      startedAt: new Date(),
    };
    this.#jobs.push(record);
    return record;
  }

  async listJobRuns(companyId: string | null, limit = 50): Promise<JobRunRow[]> {
    return this.#jobs.filter((job) => companyId === null || job.companyId === companyId).slice(-limit);
  }

  /** No runs are recorded here; `/wiki` is empty until a durable store is available. */
  async getRun(_id: string): Promise<RunRow | null> {
    return null;
  }

  async listSteps(_runId: string): Promise<StepRow[]> {
    return [];
  }
}
