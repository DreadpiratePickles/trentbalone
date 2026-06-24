/**
 * Opt-in loader that feeds anonymized cross-company learnings into planning.
 *
 * Disabled by default — the operator turns it on with
 * CROSS_COMPANY_LEARNING_ENABLED=1. When on, it reads ACTIVE playbook entries
 * across all companies, excludes the current one, and hands them to the pure
 * anonymize+rank pipeline (cross-company-learning.ts). Reads are best-effort:
 * any failure degrades to no learnings rather than blocking a cycle.
 *
 * Note on tenancy: CompanyPlaybookEntry carries no PII and is anonymized before
 * it ever reaches a prompt (companyId/id/sourceRunId are dropped). This is a
 * deliberate, flag-gated aggregation — not an incidental RLS bypass.
 */
import { db } from "@/lib/db";
import type { CompanyPlaybookEntry, PlaybookDeltaKind, PlaybookEntryStatus } from "@/lib/self-improvement/company-playbook";
import { selectCrossCompanyLearnings, type AnonymizedLearning } from "@/lib/self-improvement/cross-company-learning";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;

export function crossCompanyLearningEnabled(env: EnvLike = process.env): boolean {
  return env.CROSS_COMPANY_LEARNING_ENABLED === "1";
}

async function fetchActiveAcrossCompanies(limit: number): Promise<CompanyPlaybookEntry[]> {
  const rows = await db.companyPlaybookEntry.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r): CompanyPlaybookEntry => ({
    id: r.id,
    companyId: r.companyId,
    kind: r.kind as PlaybookDeltaKind,
    topic: r.topic,
    text: r.text,
    sourceRunId: r.sourceRunId ?? undefined,
    status: r.status as PlaybookEntryStatus,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function loadCrossCompanyLearnings(input: {
  objective: string;
  excludeCompanyId: string;
  env?: EnvLike;
  k?: number;
  limit?: number;
  fetchEntries?: (limit: number) => Promise<CompanyPlaybookEntry[]>;
}): Promise<AnonymizedLearning[]> {
  const env = input.env ?? process.env;
  if (!crossCompanyLearningEnabled(env)) return [];
  const limit = input.limit ?? 500;
  const fetchEntries = input.fetchEntries ?? fetchActiveAcrossCompanies;
  try {
    const entries = await fetchEntries(limit);
    return selectCrossCompanyLearnings(input.objective, entries, input.k ?? 3, {
      excludeCompanyId: input.excludeCompanyId,
    });
  } catch {
    return [];
  }
}
