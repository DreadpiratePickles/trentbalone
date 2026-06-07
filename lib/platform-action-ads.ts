import {
  reconcileAgentMissionPaidSpend,
  reserveAgentMissionPaidSpend,
} from "@/lib/agent-mission-spend";
import {
  getMarketingPlatformAdapter,
  isMarketingPlatform,
  type MarketingPlatformAdapter,
} from "@/lib/marketing/platform-adapter";
import { isPlatformActionLiveMode, platformActionExecutionMode } from "@/lib/platform-action-mode";
import type { AdCampaign, AdCreativeVariant, MarketingAccount } from "@/lib/marketing/types";
import { store } from "@/lib/store";
import type { MarketingPlatform } from "@/lib/types";

export type PlatformActionAdsMetadata = {
  platform: string;
  provider: string;
  targetId: string;
};

export type PlatformActionAdsDeps = {
  marketingAdapterFor?: (platform: MarketingPlatform) => MarketingPlatformAdapter;
};

export async function executeAdsLaunch(
  metadata: PlatformActionAdsMetadata,
  deps: PlatformActionAdsDeps,
): Promise<Record<string, unknown> & { externalRef: string }> {
  if (!isMarketingPlatform(metadata.platform)) throw new Error(`Unsupported marketing platform: ${metadata.platform}`);
  const campaign = await store.getAdCampaign(metadata.targetId);
  if (!campaign) throw new Error(`Ad campaign not found: ${metadata.targetId}`);
  const account = (await store.listMarketingAccounts(campaign.companyId))
    .find((item) => item.id === campaign.marketingAccountId);
  if (!account) throw new Error(`Marketing account not found: ${campaign.marketingAccountId}`);

  await reserveAgentMissionPaidSpend(campaign.companyId, campaign.dailyBudgetCents, campaign.id);

  const adapter = deps.marketingAdapterFor?.(metadata.platform) ?? defaultMarketingAdapter(metadata.platform);
  if (!adapter.capabilities.campaignDrafts) throw new Error(`${metadata.provider} does not support campaign drafts`);
  const platformCampaign = await adapter.createCampaignDraft({
    companyId: campaign.companyId,
    marketingAccountId: account.id,
    externalAccountId: account.externalAccountId,
    name: campaign.name,
    objective: campaign.objective,
    dailyBudgetCents: campaign.dailyBudgetCents,
  });

  await store.updateAdCampaign(campaign.id, {
    externalCampaignId: platformCampaign.externalCampaignId,
    status: platformCampaign.status,
  });
  const platformCreative = await createPlatformCreativeForCampaign(campaign, account, adapter);

  await reconcileAgentMissionPaidSpend({
    companyId: campaign.companyId,
    dailyBudgetCents: campaign.dailyBudgetCents,
    campaignId: campaign.id,
    externalRef: platformCampaign.externalCampaignId,
  });

  return {
    externalRef: platformCampaign.externalCampaignId,
    status: platformCampaign.status,
    platform: platformCampaign.platform,
    executionMode: platformActionExecutionMode(),
    ...(platformCreative ? {
      externalCreativeId: platformCreative.externalCreativeId,
      creativeVariantId: platformCreative.variantId,
      assetUrl: platformCreative.assetUrl,
    } : {}),
  };
}

async function createPlatformCreativeForCampaign(
  campaign: AdCampaign,
  account: MarketingAccount,
  adapter: MarketingPlatformAdapter,
): Promise<{ variantId: string; externalCreativeId: string; assetUrl?: string } | undefined> {
  const variant = await selectCampaignCreativeVariant(campaign);
  if (!variant) return undefined;
  if (variant.externalCreativeId) {
    return {
      variantId: variant.id,
      externalCreativeId: variant.externalCreativeId,
      assetUrl: variant.assetUrl,
    };
  }
  const platformCreative = await adapter.createCreative({
    companyId: campaign.companyId,
    marketingAccountId: account.id,
    externalAccountId: account.externalAccountId,
    headline: variant.headline,
    primaryText: variant.primaryText,
    cta: variant.cta,
    assetUrl: variant.assetUrl,
  });
  const updated = await store.updateAdCreativeVariant(variant.id, {
    externalCreativeId: platformCreative.externalCreativeId,
  });
  return {
    variantId: variant.id,
    externalCreativeId: updated?.externalCreativeId ?? platformCreative.externalCreativeId,
    assetUrl: updated?.assetUrl ?? variant.assetUrl,
  };
}

async function selectCampaignCreativeVariant(campaign: AdCampaign): Promise<AdCreativeVariant | undefined> {
  const variants = (await store.listAdCreativeVariants(campaign.companyId, campaign.id))
    .filter((variant) =>
      variant.moderationStatus === "approved"
      && variant.brandSafetyStatus === "approved"
    );
  return variants.find((variant) => Boolean(variant.assetUrl)) ?? variants[0];
}

function defaultMarketingAdapter(platform: MarketingPlatform): MarketingPlatformAdapter {
  if (isPlatformActionLiveMode()) return getMarketingPlatformAdapter(platform);
  if (platform === "meta") return getSandboxMetaMarketingAdapter();
  throw new Error(`Sandbox marketing platform adapter not implemented: ${platform}`);
}

function getSandboxMetaMarketingAdapter(): MarketingPlatformAdapter {
  return {
    platform: "meta",
    capabilities: {
      campaignDrafts: true,
      conversionSource: false,
      serverEvents: false,
      insights: true,
      budgetUpdates: true,
      pauseCampaigns: true,
    },
    createCampaignDraft: async (input) => ({
      platform: "meta",
      externalCampaignId: sandboxMarketingRef("campaign", input.companyId, input.marketingAccountId, input.name),
      status: "draft",
    }),
    createAdSet: async (input) => ({
      platform: "meta",
      externalAdSetId: sandboxMarketingRef("adset", input.companyId, input.marketingAccountId, input.name),
      status: "draft",
    }),
    createCreative: async (input) => ({
      platform: "meta",
      externalCreativeId: sandboxMarketingRef("creative", input.companyId, input.marketingAccountId, input.headline),
      status: "draft",
    }),
    ensureConversionSource: async (input) => ({
      platform: "meta",
      externalConversionSourceId: sandboxMarketingRef("pixel", input.companyId, input.marketingAccountId, input.name ?? "pixel"),
      status: "sandbox",
    }),
    sendConversionEvent: async (input) => ({
      platform: "meta",
      eventId: input.eventId,
      delivered: false,
      status: "sandbox",
    }),
    fetchInsights: async () => ({ platform: "meta", impressions: 0, clicks: 0, spendCents: 0, conversions: 0 }),
    pauseCampaign: async (input) => ({ platform: "meta", externalCampaignId: input.externalCampaignId, status: "sandbox" }),
    setBudget: async (input) => ({ platform: "meta", externalCampaignId: input.externalCampaignId, status: "sandbox" }),
  };
}

function sandboxMarketingRef(kind: string, companyId: string, marketingAccountId: string, name: string) {
  return `sandbox_meta_${kind}_${companyId}_${marketingAccountId}_${slugify(name)}`;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "item";
}
