import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { createWeeklyAnalyticsReport, normalizeSocialAnalyticsMetrics, type SocialAnalyticsStore } from "@/lib/social/analytics";
import type { SocialAccount } from "@/lib/social/types";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

type WeeklyReportStore = SocialAnalyticsStore & {
  getCompany(companyId: string): Promise<{ id: string } | null | undefined>;
  getSocialAccount(companyId: string, accountId: string): Promise<SocialAccount | null | undefined>;
};

type WeeklyReportBody = {
  companyId?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  accountMetrics?: unknown;
};

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as WeeklyReportBody;
  const parsed = parseWeeklyReportBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const socialStore = requireWeeklyReportStore();
    const company = await socialStore.getCompany(parsed.value.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const accountMetrics = [];
    for (const item of parsed.value.accountMetrics) {
      const account = await socialStore.getSocialAccount(company.id, item.socialAccountId);
      if (!account) return NextResponse.json({ error: "Social account not found" }, { status: 404 });
      accountMetrics.push({ account, metrics: item.metrics });
    }

    const report = await createWeeklyAnalyticsReport({
      store: socialStore,
      companyId: company.id,
      periodStart: parsed.value.periodStart,
      periodEnd: parsed.value.periodEnd,
      accountMetrics,
    });

    return NextResponse.json({ report }, { status: 201 });
  });
}

function parseWeeklyReportBody(body: WeeklyReportBody):
  | { ok: true; value: {
    companyId: string;
    periodStart: string;
    periodEnd: string;
    accountMetrics: Array<{ socialAccountId: string; metrics: ReturnType<typeof normalizeSocialAnalyticsMetrics> }>;
  } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const periodStart = requiredString(body.periodStart);
  const periodEnd = requiredString(body.periodEnd);
  if (!companyId || !periodStart || !periodEnd) {
    return { ok: false, error: "companyId, periodStart, and periodEnd are required" };
  }
  if (!Array.isArray(body.accountMetrics) || body.accountMetrics.length === 0) {
    return { ok: false, error: "accountMetrics must be a non-empty array" };
  }

  const accountMetrics = [];
  for (const item of body.accountMetrics) {
    if (!isRecord(item)) return { ok: false, error: "accountMetrics entries must be objects" };
    const socialAccountId = requiredString(item.socialAccountId);
    if (!socialAccountId || !isRecord(item.metrics)) {
      return { ok: false, error: "Each accountMetrics entry requires socialAccountId and metrics" };
    }
    accountMetrics.push({
      socialAccountId,
      metrics: normalizeSocialAnalyticsMetrics(item.metrics),
    });
  }

  return { ok: true, value: { companyId, periodStart, periodEnd, accountMetrics } };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireWeeklyReportStore() {
  const socialStore = store as typeof store & Partial<WeeklyReportStore>;
  if (
    typeof socialStore.getCompany !== "function" ||
    typeof socialStore.getSocialAccount !== "function" ||
    typeof socialStore.upsertSocialAnalyticsSnapshot !== "function"
  ) {
    throw new Error("Social analytics store methods are not available");
  }
  return socialStore as typeof store & WeeklyReportStore;
}
