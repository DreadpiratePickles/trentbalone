import { NextResponse } from "next/server";
import { exchangePlatformOAuthCode, readPlatformOAuthState } from "@/lib/platform-oauth";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return NextResponse.json({ error: "OAuth provider rejected authorization", detail: error }, { status: 400 });
  if (!code || !state) return NextResponse.json({ error: "code and state are required" }, { status: 400 });

  let tenant;
  try {
    tenant = readPlatformOAuthState(state);
  } catch {
    return NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "admin", { companyId: tenant.companyId });
  if (!check.ok) return forbidden();
  const limit = await checkRateLimit(user.id, tenant.companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(tenant.companyId, async () => {
    try {
      const result = await exchangePlatformOAuthCode({ code, state });
      return NextResponse.json({ result });
    } catch (exchangeError) {
      return NextResponse.json({
        error: "OAuth exchange failed",
        detail: exchangeError instanceof Error ? exchangeError.message : "Unknown OAuth exchange failure",
      }, { status: 400 });
    }
  });
}
