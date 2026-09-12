import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { runDailyOptimization } from "@/lib/marketing/optimizer";
import { withRlsContext } from "@/lib/with-rls";

type OptimizeDailyBody = {
  companyId?: unknown;
  marketingAccountId?: unknown;
  runDate?: unknown;
};

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as OptimizeDailyBody;
  const parsed = parseBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "admin", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const result = await runDailyOptimization(parsed.value);
    return NextResponse.json(result);
  });
}

function parseBody(body: OptimizeDailyBody):
  | { ok: true; value: { companyId: string; marketingAccountId: string; runDate: string } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const marketingAccountId = requiredString(body.marketingAccountId);
  const runDate = requiredString(body.runDate);

  if (!companyId) return { ok: false, error: "companyId is required" };
  if (!marketingAccountId) return { ok: false, error: "marketingAccountId is required" };
  if (!runDate || !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    return { ok: false, error: "runDate must be YYYY-MM-DD" };
  }

  return { ok: true, value: { companyId, marketingAccountId, runDate } };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
