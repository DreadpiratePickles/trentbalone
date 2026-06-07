/**
 * Row-Level Security application layer.
 *
 * Sets the `app.current_company_id` Postgres session variable inside a
 * transaction so RLS policies filter all queries to the correct tenant.
 *
 * Usage:
 *   const result = await withCompanyContext(companyId, async (tx) => {
 *     return tx.task.findMany();
 *   });
 *
 * On SQLite (dev/test), the SET LOCAL call is skipped and `fn` runs on the
 * global Prisma client so tests work without a Postgres instance.
 */

import { db } from "@/lib/db";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Subset of PrismaClient available inside a transaction.
 * Add models as needed; this mirrors the Prisma-generated type.
 */
export type TxClient = Parameters<Parameters<typeof db["$transaction"]>[0]>[0];

// ── Context helper ─────────────────────────────────────────────────────────────

const IS_POSTGRES = !!(process.env.DATABASE_URL?.startsWith("postgres"));

/**
 * Run `fn` inside a Prisma transaction with `app.current_company_id` set.
 *
 * - Postgres: uses SET LOCAL so the variable is automatically cleared when
 *   the transaction commits or rolls back.
 * - SQLite (tests): runs without the SET call — RLS is not enforced at the
 *   DB level but the application filters by companyId explicitly.
 */
export async function withCompanyContext<T>(
  companyId: string,
  fn: (tx: TxClient) => Promise<T>
): Promise<T> {
  if (!IS_POSTGRES) {
    return db.$transaction(async (tx) => fn(tx));
  }

  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_company_id', $1, TRUE)`,
      companyId
    );
    return fn(tx);
  });
}

/**
 * Set `app.current_company_id` for the current session (not transaction-scoped).
 * Use only when a single long-lived connection can be guaranteed (e.g. WebSocket).
 * Prefer `withCompanyContext` for request handlers.
 */
export async function setCompanyContext(companyId: string): Promise<void> {
  if (!IS_POSTGRES) return;
  await db.$executeRawUnsafe(
    `SELECT set_config('app.current_company_id', $1, FALSE)`,
    companyId
  );
}

/**
 * Clear the tenant context. Call after a request completes if using
 * session-scoped context instead of transaction-scoped.
 */
export async function clearCompanyContext(): Promise<void> {
  if (!IS_POSTGRES) return;
  await db.$executeRawUnsafe(
    `SELECT set_config('app.current_company_id', '', FALSE)`
  );
}

// ── Next.js / Express middleware helper ───────────────────────────────────────

export type CompanyContextRequest = {
  companyId?: string;
  headers?: { get?: (name: string) => string | null };
};

/**
 * Extract the company ID for a request from either:
 * 1. `req.companyId` (set by auth middleware)
 * 2. `X-Company-Id` header (service-to-service calls)
 */
export function extractCompanyId(req: CompanyContextRequest): string | undefined {
  return (
    req.companyId ??
    req.headers?.get?.("x-company-id") ??
    undefined
  );
}

/**
 * Verify that a resolved companyId matches the expected one.
 * Throws if they differ — protects against IDOR when `companyId` comes from
 * the request body or URL params alongside a session-derived one.
 */
export function assertCompanyMatch(
  sessionCompanyId: string,
  requestCompanyId: string
): void {
  if (sessionCompanyId !== requestCompanyId) {
    throw Object.assign(
      new Error("Company ID mismatch — cross-tenant access denied"),
      { code: "COMPANY_MISMATCH", statusCode: 403 }
    );
  }
}
