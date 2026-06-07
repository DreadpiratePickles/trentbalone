import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";
import { normalizeSocialAccountInput } from "@/lib/social/accounts";

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

    const accounts = await store.listSocialAccounts(company.id);
    return NextResponse.json({ accounts });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({}));
  let input;
  try {
    input = normalizeSocialAccountInput(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId: input.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, input.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(input.companyId, async () => {
    const company = await store.getCompany(input.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const account = await store.upsertSocialAccount({ ...input, companyId: company.id });
    return NextResponse.json({ account }, { status: 201 });
  });
}
