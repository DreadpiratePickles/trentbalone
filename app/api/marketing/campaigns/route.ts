import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import { getMarketingPlatformAdapter, isMarketingPlatform } from "@/lib/marketing/platform-adapter";
import { withRlsContext } from "@/lib/with-rls";
import type { MarketingPlatform } from "@/lib/marketing/platform-adapter";

type CampaignBody = {
  companyId?: unknown;
  marketingAccountId?: unknown;
  platform?: unknown;
  name?: unknown;
  objective?: unknown;
  dailyBudgetCents?: unknown;
};

type MarketingAccountForDraft = {
  id: string;
  companyId: string;
  platform: unknown;
  externalAccountId?: string | null;
};

type MarketingCampaignStore = {
  getMarketingAccount(companyId: string, platform: MarketingPlatform): Promise<MarketingAccountForDraft | null>;
  createAdCampaign(input: {
    companyId: string;
    marketingAccountId: string;
    platform: MarketingPlatform;
    externalCampaignId: string;
    name: string;
    objective: string;
    status: "draft";
    dailyBudgetCents: number;
  }): Promise<unknown>;
};

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as CampaignBody;
  const parsed = parseCampaignBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const company = await store.getCompany(parsed.value.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const marketingStore = requireMarketingStore();
    const account = await marketingStore.getMarketingAccount(company.id, parsed.value.platform);
    if (!account || account.companyId !== company.id || account.id !== parsed.value.marketingAccountId) {
      return NextResponse.json({ error: "Marketing account not found" }, { status: 404 });
    }
    if (account.platform !== parsed.value.platform) {
      return NextResponse.json({ error: "Unsupported marketing platform" }, { status: 400 });
    }
    const externalAccountId = account.externalAccountId?.trim();
    if (!externalAccountId) {
      return NextResponse.json({ error: "Marketing account externalAccountId is required" }, { status: 400 });
    }

    let adapter;
    try {
      adapter = getMarketingPlatformAdapter(parsed.value.platform);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Marketing platform adapter not implemented" },
        { status: 400 }
      );
    }
    const platformDraft = await adapter.createCampaignDraft({
      companyId: company.id,
      marketingAccountId: account.id,
      externalAccountId,
      name: parsed.value.name,
      objective: parsed.value.objective,
      dailyBudgetCents: parsed.value.dailyBudgetCents,
    });
    const campaign = await marketingStore.createAdCampaign({
      companyId: company.id,
      marketingAccountId: account.id,
      platform: parsed.value.platform,
      externalCampaignId: platformDraft.externalCampaignId,
      name: parsed.value.name,
      objective: parsed.value.objective,
      status: "draft",
      dailyBudgetCents: parsed.value.dailyBudgetCents,
    });

    return NextResponse.json({ campaign, platformDraft });
  });
}

function parseCampaignBody(body: CampaignBody):
  | { ok: true; value: {
    companyId: string;
    marketingAccountId: string;
    platform: MarketingPlatform;
    name: string;
    objective: string;
    dailyBudgetCents: number;
  } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const marketingAccountId = requiredString(body.marketingAccountId);
  const platform = requiredString(body.platform);
  const name = requiredString(body.name);
  const objective = requiredString(body.objective);
  const dailyBudgetCents = integerValue(body.dailyBudgetCents);

  if (!companyId || !marketingAccountId || !platform || !name || !objective) {
    return { ok: false, error: "companyId, marketingAccountId, platform, name, and objective are required" };
  }
  if (!isMarketingPlatform(platform)) {
    return { ok: false, error: "platform is not supported" };
  }
  if (dailyBudgetCents === null || dailyBudgetCents <= 0) {
    return { ok: false, error: "dailyBudgetCents must be a positive integer" };
  }
  return {
    ok: true,
    value: { companyId, marketingAccountId, platform, name, objective, dailyBudgetCents },
  };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerValue(value: unknown) {
  return Number.isInteger(value) ? value as number : null;
}

function requireMarketingStore() {
  const marketingStore = store as typeof store & Partial<MarketingCampaignStore>;
  if (
    typeof marketingStore.getMarketingAccount !== "function" ||
    typeof marketingStore.createAdCampaign !== "function"
  ) {
    throw new Error("Marketing campaign store methods are not available");
  }
  return marketingStore as typeof store & MarketingCampaignStore;
}
