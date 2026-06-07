/**
 * app/api/teardown/route.ts
 *
 * GET    ?companyId= — get current teardown state for a company
 * POST              — initiate teardown (transitions to cooling_off, 30-day timer starts)
 * DELETE ?companyId= — cancel teardown during cooling_off period
 *
 * Phase 3 hard rule: initiateTeardown is an irreversible-ish action.
 * The route requires admin RBAC.
 * n8n starts the 30-day cooling-off timer upon receiving the teardown.initiate webhook.
 */

import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";
import {
  initiateTeardown,
  cancelTeardown,
  getTeardownStatus,
} from "@/lib/provisioning/teardown-engine";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const record = await getTeardownStatus(companyId);
    return NextResponse.json({ teardown: record });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as { companyId?: string };

  if (!body.companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const company = await store.getCompany(body.companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  // Admin only — teardown is irreversible after cooling-off
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(company.id, async () => {
    const record = await initiateTeardown({
      companyId: company.id,
      requestedBy: user.id,
    });

    return NextResponse.json({ teardown: record }, { status: 201 });
  });
}

export async function DELETE(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  return withRlsContext(companyId, async () => {
    const record = await cancelTeardown({ companyId, cancelledBy: user.id });
    return NextResponse.json({ teardown: record });
  });
}
