import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";
import { createOffSessionSetupIntent } from "@/lib/marketing/stripe-billing";

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.companyId !== "string" || !body.companyId.trim()) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const companyId = body.companyId.trim();

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    const result = await createOffSessionSetupIntent(company.id);
    return NextResponse.json(result);
  });
}
