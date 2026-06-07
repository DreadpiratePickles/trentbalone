/**
 * Prisma-backed IterationLog implementation.
 *
 * Stores self-improvement iteration records in the SelfImprovementIteration
 * table. Reads/writes are wrapped in withRlsContext so RLS policies fire on
 * Postgres (no-op on SQLite/dev).
 *
 * Implements the IterationLog interface from lib/self-improvement/iteration-log.ts.
 */

import { db } from "@/lib/db";
import { withRlsContext } from "@/lib/with-rls";
import type { IterationLog, SelfImprovementIteration, IterationCandidateKind, IterationDecision } from "@/lib/self-improvement/iteration-log";

function rowToIteration(row: {
  id: string;
  companyId: string;
  taskType: string;
  candidateId: string | null;
  candidateKind: string | null;
  score: number | null;
  delta: number | null;
  decision: string;
  triggers: unknown;
  approvalId: string | null;
  blockedBy: string | null;
  createdAt: Date;
}): SelfImprovementIteration {
  return {
    id: row.id,
    companyId: row.companyId,
    taskType: row.taskType,
    candidateId: row.candidateId ?? undefined,
    candidateKind: row.candidateKind ? (row.candidateKind as IterationCandidateKind) : undefined,
    score: row.score ?? undefined,
    delta: row.delta ?? undefined,
    decision: row.decision as IterationDecision,
    triggers: Array.isArray(row.triggers) ? (row.triggers as string[]) : [],
    approvalId: row.approvalId ?? undefined,
    blockedBy: row.blockedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaIterationLog implements IterationLog {
  async append(record: SelfImprovementIteration): Promise<void> {
    await withRlsContext(record.companyId, async () => {
      await db.selfImprovementIteration.create({
        data: {
          id: record.id,
          companyId: record.companyId,
          taskType: record.taskType,
          candidateId: record.candidateId ?? null,
          candidateKind: record.candidateKind ?? null,
          score: record.score ?? null,
          delta: record.delta ?? null,
          decision: record.decision,
          triggers: record.triggers,
          approvalId: record.approvalId ?? null,
          blockedBy: record.blockedBy ?? null,
          createdAt: new Date(record.createdAt),
        },
      });
    });
  }

  async list(companyId: string): Promise<SelfImprovementIteration[]> {
    return withRlsContext(companyId, async () => {
      const rows = await db.selfImprovementIteration.findMany({
        where: { companyId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(rowToIteration);
    });
  }
}
