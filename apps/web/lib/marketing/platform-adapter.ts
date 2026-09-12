import { createMetaAdapter } from "@/lib/marketing/meta-adapter";

export const MARKETING_PLATFORMS = ["meta", "google", "tiktok", "linkedin", "reddit"] as const;

export type MarketingPlatform = typeof MARKETING_PLATFORMS[number];

export const PLATFORM_CAPABILITY_KEYS = [
  "campaignDrafts",
  "conversionSource",
  "serverEvents",
  "insights",
  "budgetUpdates",
  "pauseCampaigns",
] as const;

export type PlatformCapabilities = Record<typeof PLATFORM_CAPABILITY_KEYS[number], boolean>;

export const REQUIRED_ADAPTER_METHODS = [
  "createCampaignDraft",
  "createAdSet",
  "createCreative",
  "ensureConversionSource",
  "sendConversionEvent",
  "fetchInsights",
  "pauseCampaign",
  "setBudget",
] as const;

export type CampaignDraftInput = {
  companyId: string;
  marketingAccountId: string;
  externalAccountId: string;
  name: string;
  objective: string;
  dailyBudgetCents: number;
};

export type PlatformCampaignDraft = {
  platform: MarketingPlatform;
  externalCampaignId: string;
  status: "draft";
};

export type AdSetInput = CampaignDraftInput & {
  externalCampaignId: string;
  audienceRef?: string;
};

export type PlatformAdSet = {
  platform: MarketingPlatform;
  externalAdSetId: string;
  status: "draft";
};

export type CreativeInput = {
  companyId: string;
  marketingAccountId: string;
  externalAccountId: string;
  externalAdSetId?: string;
  headline: string;
  primaryText: string;
  cta?: string;
  assetUrl?: string;
};

export type PlatformCreative = {
  platform: MarketingPlatform;
  externalCreativeId: string;
  status: "draft";
};

export type ConversionSourceInput = {
  companyId: string;
  marketingAccountId: string;
  externalAccountId: string;
  name?: string;
};

export type PlatformConversionSource = {
  platform: MarketingPlatform;
  externalConversionSourceId: string;
  status: "ready" | "sandbox";
};

export type ConversionEventInput = {
  companyId: string;
  marketingAccountId: string;
  externalAccountId: string;
  eventId: string;
  eventName: string;
  occurredAt: string;
  hashedUserData?: Record<string, string>;
};

export type PlatformConversionEventResult = {
  platform: MarketingPlatform;
  eventId: string;
  delivered: boolean;
  status: "sent" | "sandbox";
};

export type InsightsInput = {
  companyId: string;
  marketingAccountId: string;
  externalAccountId: string;
  externalCampaignId: string;
  since?: string;
  until?: string;
};

export type PlatformInsights = {
  platform: MarketingPlatform;
  impressions: number;
  clicks: number;
  spendCents: number;
  conversions: number;
};

export type CampaignControlInput = {
  companyId: string;
  marketingAccountId: string;
  externalAccountId: string;
  externalCampaignId: string;
};

export type BudgetInput = CampaignControlInput & {
  dailyBudgetCents: number;
};

export type CampaignControlResult = {
  platform: MarketingPlatform;
  externalCampaignId: string;
  status: "paused" | "budget_updated" | "sandbox";
};

export type MarketingPlatformAdapter = {
  platform: MarketingPlatform;
  capabilities: PlatformCapabilities;
  createCampaignDraft(input: CampaignDraftInput): Promise<PlatformCampaignDraft>;
  createAdSet(input: AdSetInput): Promise<PlatformAdSet>;
  createCreative(input: CreativeInput): Promise<PlatformCreative>;
  ensureConversionSource(input: ConversionSourceInput): Promise<PlatformConversionSource>;
  sendConversionEvent(input: ConversionEventInput): Promise<PlatformConversionEventResult>;
  fetchInsights(input: InsightsInput): Promise<PlatformInsights>;
  pauseCampaign(input: CampaignControlInput): Promise<CampaignControlResult>;
  setBudget(input: BudgetInput): Promise<CampaignControlResult>;
};

export function isMarketingPlatform(value: unknown): value is MarketingPlatform {
  return typeof value === "string" && MARKETING_PLATFORMS.includes(value as MarketingPlatform);
}

export function getMarketingPlatformAdapter(platform: MarketingPlatform): MarketingPlatformAdapter {
  if (platform === "meta") return createMetaAdapter();
  throw new Error(`Marketing platform adapter not implemented: ${platform}`);
}
