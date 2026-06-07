/**
 * app/api/teardown/confirm/route.ts
 *
 * POST — confirm permanent deletion after the 30-day cooling-off period.
 *
 * Phase 3 hard rule:
 *   - confirmDeletion() throws if cooling-off has NOT expired.
 *   - After this call, the teardown-engine transitions to state=deleted.
 *   - The orchestrator must be called separately (or triggered by n8n) to
 *     invoke each provisioner's rollback() and permanently delete resources.
 *
 * This endpoint ONLY advances the state machine — it does not call provider APIs.
 * Actual resource deletion is performed by the n8n post-confirm workflow.
 */

import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";
import { confirmDeletion } from "@/lib/provisioning/teardown-engine";

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as { companyId?: string };

  if (!body.companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const company = await store.getCompany(body.companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  // Admin only — permanent deletion
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  return withRlsContext(company.id, async () => {
    try {
      const record = await confirmDeletion({ companyId: company.id, confirmedBy: user.id });
      return NextResponse.json({ teardown: record });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // confirmDeletion throws a descriptive error when cooling-off hasn't expired
      return NextResponse.json({ error: msg }, { status: 409 });
    }
  });
}
