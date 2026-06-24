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
import { logger } from "@/lib/logger";
import type { CompanyPlaybookEntry, PlaybookDeltaKind, PlaybookEntryStatus } from "@/lib/self-improvement/company-playbook";
import { selectCrossCompanyLearnings, type AnonymizedLearning } from "@/lib/self-improvement/cross-company-learning";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;

// Production privacy policy: only surface learnings independently corroborated
// by at least this many distinct companies, so no single company's free-text
// learning is ever exposed verbatim. Operators can lower it (≥1) deliberately.
const DEFAULT_MIN_CORROBORATIONS = 2;
// The across-company read is identical for every seat in a cycle; cache it
// briefly so a multi-seat run does one query, not one per step.
const CACHE_TTL_MS = 60_000;

let entryCache: { entries: CompanyPlaybookEntry[]; expiresAt: number } | null = null;

export function crossCompanyLearningEnabled(env: EnvLike = process.env): boolean {
  return env.CROSS_COMPANY_LEARNING_ENABLED === "1";
}

function minCorroborations(env: EnvLike): number {
  const raw = Number(env.CROSS_COMPANY_LEARNING_MIN_CORROBORATIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : DEFAULT_MIN_CORROBORATIONS;
}

/** Test seam: drop the cache so injected data is read fresh. */
export function resetCrossCompanyLearningCache(): void {
  entryCache = null;
}

async function fetchActiveAcrossCompanies(limit: number): Promise<CompanyPlaybookEntry[]> {
  if (entryCache && entryCache.expiresAt > Date.now()) return entryCache.entries;
  const rows = await db.companyPlaybookEntry.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const entries = rows.map((r): CompanyPlaybookEntry => ({
    id: r.id,
    companyId: r.companyId,
    kind: r.kind as PlaybookDeltaKind,
    topic: r.topic,
    text: r.text,
    sourceRunId: r.sourceRunId ?? undefined,
    status: r.status as PlaybookEntryStatus,
    createdAt: r.createdAt.toISOString(),
  }));
  entryCache = { entries, expiresAt: Date.now() + CACHE_TTL_MS };
  return entries;
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
      minCorroborations: minCorroborations(env),
    });
  } catch (err) {
    // Best-effort: a degraded cross-company read must never block a cycle, but
    // it should be visible to ops rather than silently disappearing.
    logger.warn({ err: (err as Error).message }, "cross_company_learning.load_failed");
    return [];
  }
}
