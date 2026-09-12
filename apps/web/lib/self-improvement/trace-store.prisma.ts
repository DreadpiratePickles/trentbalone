/**
 * Prisma-backed TraceStore implementation.
 *
 * Stores agent execution traces in the AgentTrace table, keyed by company +
 * task type. Reads/writes are wrapped in withRlsContext so RLS policies fire
 * on Postgres (no-op on SQLite/dev).
 *
 * Implements the TraceStore interface from lib/trace-store.ts.
 */

import { db } from "@/lib/db";
import { withRlsContext } from "@/lib/with-rls";
import type { TraceStore, TraceRecord } from "@/lib/trace-store";
import type { AgentRole } from "@/lib/types";
import type { OrchestrationCritique } from "@/lib/orchestrator-runtime";

function rowToRecord(row: {
  id: string;
  companyId: string;
  runId: string;
  taskType: string;
  agentRole: string;
  stepTitle: string;
  status: string;
  toolCalls: unknown;
  toolCallCount: number;
  critiqueVerdict: string | null;
  improvement: string | null;
  evalScore: number | null;
  costCents: number;
  latencyMs: number | null;
  humanCorrected: boolean;
  createdAt: Date;
}): TraceRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    runId: row.runId,
    taskType: row.taskType,
    agentRole: row.agentRole as AgentRole,
    stepTitle: row.stepTitle,
    status: row.status as TraceRecord["status"],
    toolCalls: Array.isArray(row.toolCalls) ? (row.toolCalls as string[]) : [],
    toolCallCount: row.toolCallCount,
    critiqueVerdict: row.critiqueVerdict as OrchestrationCritique["verdict"] | undefined ?? undefined,
    improvement: row.improvement ?? undefined,
    evalScore: row.evalScore ?? undefined,
    costCents: row.costCents,
    latencyMs: row.latencyMs ?? undefined,
    humanCorrected: row.humanCorrected,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaTraceStore implements TraceStore {
  async append(record: TraceRecord): Promise<void> {
    await withRlsContext(record.companyId, async () => {
      await db.agentTrace.create({
        data: {
          id: record.id,
          companyId: record.companyId,
          runId: record.runId,
          taskType: record.taskType,
          agentRole: record.agentRole,
          stepTitle: record.stepTitle,
          status: record.status,
          toolCalls: record.toolCalls,
          toolCallCount: record.toolCallCount,
          critiqueVerdict: record.critiqueVerdict ?? null,
          improvement: record.improvement ?? null,
          evalScore: record.evalScore ?? null,
          costCents: record.costCents,
          latencyMs: record.latencyMs ?? null,
          humanCorrected: record.humanCorrected,
          createdAt: new Date(record.createdAt),
        },
      });
    });
  }

  async query(companyId: string, taskType?: string): Promise<TraceRecord[]> {
    return withRlsContext(companyId, async () => {
      const rows = await db.agentTrace.findMany({
        where: {
          companyId,
          ...(taskType !== undefined ? { taskType } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(rowToRecord);
    });
  }

  async byRun(runId: string): Promise<TraceRecord[]> {
    const rows = await db.agentTrace.findMany({
      where: { runId },
    });
    return rows.map(rowToRecord);
  }
}
