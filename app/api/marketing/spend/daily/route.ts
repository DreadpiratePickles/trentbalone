import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { runDailyAdSpendCharge } from "@/lib/marketing/spend-loop";
import { withRlsContext } from "@/lib/with-rls";

type DailySpendBody = {
  companyId?: unknown;
  billingDate?: unknown;
  feeBps?: unknown;
};

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as DailySpendBody;
  const parsed = parseBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "admin", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const result = await runDailyAdSpendCharge(
      parsed.value.companyId,
      parsed.value.billingDate,
      parsed.value.feeBps === undefined ? {} : { feeBps: parsed.value.feeBps }
    );
    return NextResponse.json(result);
  });
}

function parseBody(body: DailySpendBody):
  | { ok: true; value: { companyId: string; billingDate: string; feeBps?: number } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const billingDate = requiredString(body.billingDate);
  if (!companyId) return { ok: false, error: "companyId is required" };
  if (!billingDate || !/^\d{4}-\d{2}-\d{2}$/.test(billingDate)) {
    return { ok: false, error: "billingDate must be YYYY-MM-DD" };
  }

  const feeBps = body.feeBps;
  if (feeBps !== undefined) {
    if (typeof feeBps !== "number" || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
      return { ok: false, error: "feeBps must be an integer between 0 and 10000" };
    }
    return { ok: true, value: { companyId, billingDate, feeBps } };
  }

  return { ok: true, value: { companyId, billingDate } };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
