import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { checkModeration } from "@/lib/generation/moderation-filter";
import { generateImage } from "@/lib/generation/image-router";
import { generateText } from "@/lib/generation/text-router";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import { generateCreativeVariants } from "@/lib/marketing/creative-pipeline";
import { getMarketingPlatformAdapter } from "@/lib/marketing/platform-adapter";
import { withRlsContext } from "@/lib/with-rls";
import type { AdCampaign, MarketingAccount } from "@/lib/marketing/types";

type VariantBody = {
  companyId?: unknown;
  variantCount?: unknown;
  offer?: unknown;
  audience?: unknown;
  angle?: unknown;
};

type VariantRouteContext = {
  params: Promise<{ id: string }>;
};

type VariantStore = {
  getAdCampaign(id: string): Promise<AdCampaign | undefined | null>;
  getMarketingAccount(companyId: string, platform: AdCampaign["platform"]): Promise<MarketingAccount | undefined | null>;
  createAdCreativeVariant: typeof store.createAdCreativeVariant;
};

export async function POST(request: Request, { params }: VariantRouteContext) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const body = await request.json().catch(() => ({})) as VariantBody;
  const parsed = parseVariantBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const marketingStore = requireVariantStore();
    const campaign = await marketingStore.getAdCampaign(id);
    if (!campaign || campaign.companyId !== parsed.value.companyId) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    const marketingAccount = await marketingStore.getMarketingAccount(campaign.companyId, campaign.platform);
    if (!marketingAccount || marketingAccount.id !== campaign.marketingAccountId) {
      return NextResponse.json({ error: "Marketing account not found" }, { status: 404 });
    }
    if (!marketingAccount.externalAccountId.trim()) {
      return NextResponse.json({ error: "Marketing account externalAccountId is required" }, { status: 400 });
    }

    const platform = getMarketingPlatformAdapter(campaign.platform);
    const result = await generateCreativeVariants({
      companyId: parsed.value.companyId,
      campaign,
      marketingAccount,
      variantCount: parsed.value.variantCount,
      offer: parsed.value.offer,
      audience: parsed.value.audience,
      angle: parsed.value.angle,
    }, {
      generateText,
      generateImage,
      moderate: checkModeration,
      store: marketingStore,
      platform,
    });

    return NextResponse.json(result);
  });
}

function parseVariantBody(body: VariantBody):
  | { ok: true; value: {
    companyId: string;
    variantCount?: number;
    offer: string;
    audience: string;
    angle: string;
  } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const offer = requiredString(body.offer);
  const audience = requiredString(body.audience);
  const angle = requiredString(body.angle);
  const variantCount = optionalPositiveInteger(body.variantCount);

  if (!companyId || !offer || !audience || !angle) {
    return { ok: false, error: "companyId, offer, audience, and angle are required" };
  }
  if (body.variantCount !== undefined && variantCount === undefined) {
    return { ok: false, error: "variantCount must be a positive integer" };
  }
  return {
    ok: true,
    value: {
      companyId,
      offer,
      audience,
      angle,
      variantCount,
    },
  };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalPositiveInteger(value: unknown) {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function requireVariantStore() {
  const marketingStore = store as typeof store & Partial<VariantStore>;
  if (
    typeof marketingStore.getAdCampaign !== "function" ||
    typeof marketingStore.getMarketingAccount !== "function" ||
    typeof marketingStore.createAdCreativeVariant !== "function"
  ) {
    throw new Error("Marketing variant store methods are not available");
  }
  return marketingStore as typeof store & VariantStore;
}
