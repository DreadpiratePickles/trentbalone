/**
 * Request-scoped RLS activation helper.
 *
 * Wraps an async route-handler body so that:
 *  - On Postgres: `app.current_company_id` is set for all DB queries in the handler,
 *    and cleared in the finally block regardless of success or failure.
 *  - On SQLite (dev/test): no-op — store layer filters by companyId in application code.
 *
 * Usage in a route handler:
 *   const result = await withRlsContext(companyId, async () => {
 *     return store.listTasks(companyId);
 *   });
 *
 * Prefer `withCompanyContext` (transaction-scoped) when you control the Prisma
 * client directly. Use `withRlsContext` when calling store methods that use the
 * global `db` instance internally and cannot accept a `tx` parameter.
 */

import { setCompanyContext, clearCompanyContext } from "@/lib/rls";

const IS_POSTGRES = !!(process.env.DATABASE_URL?.startsWith("postgres"));

export async function withRlsContext<T>(
  companyId: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!IS_POSTGRES) return fn();

  await setCompanyContext(companyId);
  try {
    return await fn();
  } finally {
    await clearCompanyContext();
  }
}
