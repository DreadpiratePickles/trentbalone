/**
 * Iteration Log — autoresearch's "log every iteration".
 *
 * Each pass of the self-improvement loop writes exactly one record here:
 * which candidate was proposed, how it scored against the frozen suite, the
 * delta vs baseline, and what the loop decided. This is the queryable history
 * the UI slice renders (timeline + diffs + Approve/Reject) and the trail that
 * makes the otherwise-headless engine observable.
 *
 * Pure + injectable like trace-store.ts: an InMemory implementation here, a
 * Prisma-backed one in Slice 1b against the same interface.
 */

import { makeId, nowIso } from "@/lib/utils";

export type IterationCandidateKind = "skill" | "prompt";

export type IterationDecision =
  | "no_candidate"      // trigger did not fire / nothing to learn from
  | "pending_approval"  // passed the eval gate; awaiting human approval
  | "promoted"          // approved + promoted to live
  | "rejected";         // blocked by the eval gate (regression / new failure cluster)

export type SelfImprovementIteration = {
  id: string;
  companyId: string;
  taskType: string;
  candidateId?: string;
  candidateKind?: IterationCandidateKind;
  /** Candidate score on the frozen suite (0..1), when scored. */
  score?: number;
  /** Signed delta vs baseline, when scored. */
  delta?: number;
  decision: IterationDecision;
  /** Why the candidate was proposed (Foundry triggers) — for explainability. */
  triggers: string[];
  /** Approval queue id when decision === "pending_approval". */
  approvalId?: string;
  /** Eval-gate block reason when decision === "rejected". */
  blockedBy?: string;
  createdAt: string;
};

export type RecordIterationInput = Omit<SelfImprovementIteration, "id" | "createdAt"> & {
  id?: string;
  now?: string;
};

/** Build a normalized iteration record (pure — no I/O). */
export function buildIteration(input: RecordIterationInput): SelfImprovementIteration {
  return {
    id: input.id ?? makeId("iter"),
    companyId: input.companyId,
    taskType: input.taskType,
    candidateId: input.candidateId,
    candidateKind: input.candidateKind,
    score: input.score,
    delta: input.delta,
    decision: input.decision,
    triggers: input.triggers,
    approvalId: input.approvalId,
    blockedBy: input.blockedBy,
    createdAt: input.now ?? nowIso(),
  };
}

/** Minimal repository contract — Prisma slice implements this later. */
export interface IterationLog {
  append(record: SelfImprovementIteration): Promise<void>;
  /** All iterations for a company, newest first. */
  list(companyId: string): Promise<SelfImprovementIteration[]>;
}

/** In-memory implementation for local dev and tests. */
export class InMemoryIterationLog implements IterationLog {
  private records: SelfImprovementIteration[] = [];

  async append(record: SelfImprovementIteration): Promise<void> {
    this.records.push(record);
  }

  async list(companyId: string): Promise<SelfImprovementIteration[]> {
    return this.records
      .filter((r) => r.companyId === companyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
