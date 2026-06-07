export type MarketingPlatform = "meta" | "google" | "tiktok" | "linkedin" | "reddit";

export type ConversionEventName =
  | "PageView"
  | "ViewContent"
  | "Lead"
  | "StartTrial"
  | "Subscribe"
  | "Purchase"
  | "QualifiedLead";

export type MarketingAccount = {
  id: string;
  companyId: string;
  platform: MarketingPlatform;
  status: "active" | "paused" | "disconnected";
  externalAccountId: string;
  externalBusinessId?: string;
  currency: string;
  dailyBudgetCents?: number;
  paymentStatus: "ready" | "needs_payment_method" | "blocked" | "payment_blocked";
  consentForServerEvents: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MarketingAccountInput = {
  companyId: string;
  platform: MarketingPlatform;
  externalAccountId: string;
  externalBusinessId?: string;
  currency?: string;
  dailyBudgetCents?: number;
  consentForServerEvents?: boolean;
  status?: MarketingAccount["status"];
  paymentStatus?: MarketingAccount["paymentStatus"];
};

export type ConversionEvent = {
  id: string;
  companyId: string;
  eventId: string;
  eventName: ConversionEventName;
  occurredAt: string;
  sourceUrl?: string;
  userAgentHash?: string;
  fbp?: string;
  fbc?: string;
  hashedUserData: Record<string, string>;
  deliveryStatus: "pending" | "sent" | "failed";
  diagnostics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConversionEventInput = Omit<ConversionEvent, "id" | "createdAt" | "updatedAt">;

export type AdCampaign = {
  id: string;
  companyId: string;
  marketingAccountId: string;
  platform: MarketingPlatform;
  externalCampaignId?: string;
  name: string;
  objective: string;
  status: "draft" | "active" | "paused" | "archived";
  dailyBudgetCents: number;
  approvalId?: string;
  createdAt: string;
  updatedAt: string;
};

export type AdCampaignInput = Omit<AdCampaign, "id" | "createdAt" | "updatedAt">;

export type AdCreativeVariant = {
  id: string;
  companyId: string;
  campaignId: string;
  variantKey: string;
  headline: string;
  primaryText: string;
  cta: string;
  assetUrl?: string;
  moderationStatus: "pending" | "approved" | "rejected";
  brandSafetyStatus: "pending" | "approved" | "rejected";
  externalCreativeId?: string;
  metrics: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AdCreativeVariantInput = Omit<AdCreativeVariant, "id" | "createdAt" | "updatedAt">;

export type AudienceSegment = {
  id: string;
  companyId: string;
  name: string;
  kind: string;
  source: string;
  definition: Record<string, unknown>;
  externalAudienceId?: string;
  createdAt: string;
  updatedAt: string;
};

export type AdSpendCharge = {
  id: string;
  companyId: string;
  billingDate: string;
  stripePaymentIntentId?: string;
  adSpendCents: number;
  platformFeeCents: number;
  status: "pending" | "succeeded" | "failed";
  failureCode?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdSpendChargeInput = Omit<AdSpendCharge, "id" | "createdAt" | "updatedAt">;

export type OptimizationRun = {
  id: string;
  companyId: string;
  marketingAccountId: string;
  runDate: string;
  status: string;
  inputMetrics: Record<string, unknown>;
  decisions: Record<string, unknown> | unknown[];
  createdAt: string;
  updatedAt: string;
};

export type OptimizationRunInput = Omit<OptimizationRun, "id" | "createdAt" | "updatedAt">;
export type OptimizationRunPatch = Partial<Pick<OptimizationRun, "status" | "inputMetrics" | "decisions">>;

export type CreativePerformanceMemory = {
  id: string;
  companyId: string;
  featureKey: string;
  outcome: string;
  sampleSize: number;
  sourceCampaignIds: string[];
  privacyScope: string;
  validFrom: string;
  validTo?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreativePerformanceMemoryInput =
  Omit<CreativePerformanceMemory, "id" | "createdAt" | "updatedAt">;
