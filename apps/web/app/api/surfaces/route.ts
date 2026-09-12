import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { createMcpServerDescriptor, createPublicApiDescriptor, createWebhookSurface } from "@/lib/surfaces/developer-surfaces";
import { buildSurfaceRegistry } from "@/lib/surfaces/registry";
import { createWebPolishPlan } from "@/lib/surfaces/web-polish";
import { withRlsContext } from "@/lib/with-rls";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    return NextResponse.json({
      surfaces: buildSurfaceRegistry(),
      web: createWebPolishPlan({
        routes: ["/companies/[id]", "/companies/[id]/approvals", "/companies/[id]/workbench"],
        dataSources: ["company", "approvals", "usage", "workbench"],
      }),
      publicApi: createPublicApiDescriptor(),
      webhooks: createWebhookSurface(),
      mcp: createMcpServerDescriptor(),
    });
  });
}
