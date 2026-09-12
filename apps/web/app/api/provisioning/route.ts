/**
 * app/api/provisioning/route.ts
 *
 * GET  ?companyId=   — query provisioning status across all provisioners
 * POST              — trigger full infrastructure provisioning for a company
 *
 * Pre-provision guards (Phase 3 hard rules):
 *   - admin RBAC required
 *   - Phase 2 budget cap checked via spend.ts before committing any API call
 *   - RLS context set so every store read is tenant-scoped
 *   - All provisioning actions logged via appendAuditLog (inside each provisioner)
 */

import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";
import { assertToolSpendAllowed } from "@/lib/spend";
import { provisionCompany, getProvisioningStatus } from "@/lib/provisioning/orchestrator";

// Estimated cost for a full provisioning run (reservation, reconciled later by cost-attributor)
const PROVISION_ESTIMATED_CENTS = 0; // provisioning itself is free; infra costs accrue monthly

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const status = await getProvisioningStatus(companyId);
    return NextResponse.json({ status });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as {
    companyId?: string;
    companySlug?: string;
    enableHosting?: boolean;
    hostingProvider?: "vercel" | "render";
    envVars?: Record<string, string>;
  };

  if (!body.companyId || !body.companySlug?.trim()) {
    return NextResponse.json(
      { error: "companyId and companySlug are required" },
      { status: 400 }
    );
  }

  const company = await store.getCompany(body.companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  // Admin only — provisioning is an irreversible action
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(company.id, async () => {
    // Phase 2 budget gate — provisioning is free upfront but reserves a nominal slot
    // to prevent concurrent conflicting runs from both passing the check simultaneously.
    await assertToolSpendAllowed(company.id, "infra.provision", PROVISION_ESTIMATED_CENTS);

    const result = await provisionCompany({
      companyId: company.id,
      companySlug: body.companySlug!.trim(),
      enableHosting: body.enableHosting ?? true,
      hostingProvider: body.hostingProvider ?? "vercel",
      envVars: body.envVars,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          failedAt: result.failedAt,
          error: result.error,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, resources: result }, { status: 201 });
  });
}
