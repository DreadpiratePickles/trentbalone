import { db } from "@/lib/db";
import { makeId } from "@/lib/utils";
import type {
  AdCampaign,
  AdCampaignInput,
  AdCreativeVariant,
  AdCreativeVariantInput,
  AdSpendCharge,
  AdSpendChargeInput,
  ConversionEvent,
  ConversionEventInput,
  CreativePerformanceMemory,
  CreativePerformanceMemoryInput,
  MarketingAccount,
  MarketingAccountInput,
  MarketingPlatform,
  OptimizationRun,
  OptimizationRunInput,
  OptimizationRunPatch,
} from "./marketing/types";
import { toIso, toIsoReq } from "./prisma-store-mappers";

const client = db as any;

function mapMarketingAccount(row: any): MarketingAccount {
  return {
    id: row.id,
    companyId: row.companyId,
    platform: row.platform,
    status: row.status,
    externalAccountId: row.externalAccountId,
    externalBusinessId: row.externalBusinessId ?? undefined,
    currency: row.currency,
    dailyBudgetCents: row.dailyBudgetCents ?? undefined,
    paymentStatus: row.paymentStatus,
    consentForServerEvents: row.consentForServerEvents,
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapConversionEvent(row: any): ConversionEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    eventId: row.eventId,
    eventName: row.eventName,
    occurredAt: toIsoReq(row.occurredAt),
    sourceUrl: row.sourceUrl ?? undefined,
    userAgentHash: row.userAgentHash ?? undefined,
    fbp: row.fbp ?? undefined,
    fbc: row.fbc ?? undefined,
    hashedUserData: row.hashedUserData ?? {},
    deliveryStatus: row.deliveryStatus,
    diagnostics: row.diagnostics ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapAdCampaign(row: any): AdCampaign {
  return {
    id: row.id,
    companyId: row.companyId,
    marketingAccountId: row.marketingAccountId,
    platform: row.platform,
    externalCampaignId: row.externalCampaignId ?? undefined,
    name: row.name,
    objective: row.objective,
    status: row.status,
    dailyBudgetCents: row.dailyBudgetCents,
    approvalId: row.approvalId ?? undefined,
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapAdCreativeVariant(row: any): AdCreativeVariant {
  return {
    id: row.id,
    companyId: row.companyId,
    campaignId: row.campaignId,
    variantKey: row.variantKey,
    headline: row.headline,
    primaryText: row.primaryText,
    cta: row.cta,
    assetUrl: row.assetUrl ?? undefined,
    moderationStatus: row.moderationStatus,
    brandSafetyStatus: row.brandSafetyStatus,
    externalCreativeId: row.externalCreativeId ?? undefined,
    metrics: row.metrics ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapAdSpendCharge(row: any): AdSpendCharge {
  return {
    id: row.id,
    companyId: row.companyId,
    billingDate: toDateKey(row.billingDate),
    stripePaymentIntentId: row.stripePaymentIntentId ?? undefined,
    adSpendCents: row.adSpendCents,
    platformFeeCents: row.platformFeeCents,
    status: row.status,
    failureCode: row.failureCode ?? undefined,
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapOptimizationRun(row: any): OptimizationRun {
  return {
    id: row.id,
    companyId: row.companyId,
    marketingAccountId: row.marketingAccountId,
    runDate: toDateKey(row.runDate),
    status: row.status,
    inputMetrics: row.inputMetrics ?? {},
    decisions: row.decisions ?? [],
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapCreativePerformanceMemory(row: any): CreativePerformanceMemory {
  return {
    id: row.id,
    companyId: row.companyId,
    featureKey: row.featureKey,
    outcome: row.outcome,
    sampleSize: row.sampleSize,
    sourceCampaignIds: Array.isArray(row.sourceCampaignIds) ? row.sourceCampaignIds : [],
    privacyScope: row.privacyScope,
    validFrom: toIsoReq(row.validFrom),
    validTo: toIso(row.validTo),
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export const prismaStoreMarketing = {
  async upsertMarketingAccount(input: MarketingAccountInput): Promise<MarketingAccount> {
    const update: Record<string, unknown> = {
      externalAccountId: input.externalAccountId,
    };
    if (input.externalBusinessId !== undefined) update.externalBusinessId = input.externalBusinessId;
    if (input.currency !== undefined) update.currency = input.currency;
    if (input.dailyBudgetCents !== undefined) update.dailyBudgetCents = input.dailyBudgetCents;
    if (input.consentForServerEvents !== undefined) update.consentForServerEvents = input.consentForServerEvents;
    if (input.status !== undefined) update.status = input.status;
    if (input.paymentStatus !== undefined) update.paymentStatus = input.paymentStatus;

    const row = await client.marketingAccount.upsert({
      where: { companyId_platform: { companyId: input.companyId, platform: input.platform } },
      update,
      create: {
        id: makeId("mktacct"),
        companyId: input.companyId,
        platform: input.platform,
        status: input.status ?? "active",
        externalAccountId: input.externalAccountId,
        externalBusinessId: input.externalBusinessId ?? null,
        currency: input.currency ?? "USD",
        dailyBudgetCents: input.dailyBudgetCents ?? null,
        paymentStatus: input.paymentStatus ?? "ready",
        consentForServerEvents: input.consentForServerEvents ?? false,
      },
    });
    return mapMarketingAccount(row);
  },

  async getMarketingAccount(companyId: string, platform: MarketingPlatform): Promise<MarketingAccount | undefined> {
    const row = await client.marketingAccount.findUnique({
      where: { companyId_platform: { companyId, platform } },
    });
    return row ? mapMarketingAccount(row) : undefined;
  },

  async getMarketingAccountById(id: string): Promise<MarketingAccount | undefined> {
    const row = await client.marketingAccount.findUnique({ where: { id } });
    return row ? mapMarketingAccount(row) : undefined;
  },

  async listMarketingAccounts(companyId: string): Promise<MarketingAccount[]> {
    const rows = await client.marketingAccount.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapMarketingAccount);
  },

  async updateMarketingAccount(id: string, patch: Partial<MarketingAccount>): Promise<MarketingAccount | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.platform !== undefined) data.platform = patch.platform;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.externalAccountId !== undefined) data.externalAccountId = patch.externalAccountId;
    if (patch.externalBusinessId !== undefined) data.externalBusinessId = patch.externalBusinessId ?? null;
    if (patch.currency !== undefined) data.currency = patch.currency;
    if (patch.dailyBudgetCents !== undefined) data.dailyBudgetCents = patch.dailyBudgetCents ?? null;
    if (patch.paymentStatus !== undefined) data.paymentStatus = patch.paymentStatus;
    if (patch.consentForServerEvents !== undefined) data.consentForServerEvents = patch.consentForServerEvents;
    const row = await client.marketingAccount.update({ where: { id }, data }).catch(() => null);
    return row ? mapMarketingAccount(row) : undefined;
  },

  async createConversionEvent(input: ConversionEventInput): Promise<ConversionEvent> {
    const row = await client.conversionEvent.create({
      data: {
        id: makeId("conversion"),
        companyId: input.companyId,
        eventId: input.eventId,
        eventName: input.eventName,
        occurredAt: new Date(input.occurredAt),
        sourceUrl: input.sourceUrl ?? null,
        userAgentHash: input.userAgentHash ?? null,
        fbp: input.fbp ?? null,
        fbc: input.fbc ?? null,
        hashedUserData: input.hashedUserData,
        deliveryStatus: input.deliveryStatus,
        diagnostics: input.diagnostics,
      },
    });
    return mapConversionEvent(row);
  },

  async getConversionEventByEventId(eventId: string): Promise<ConversionEvent | undefined> {
    const row = await client.conversionEvent.findUnique({ where: { eventId } });
    return row ? mapConversionEvent(row) : undefined;
  },

  async updateConversionEvent(id: string, patch: Partial<ConversionEvent>): Promise<ConversionEvent> {
    const data: Record<string, unknown> = {};
    if (patch.deliveryStatus !== undefined) data.deliveryStatus = patch.deliveryStatus;
    if (patch.diagnostics !== undefined) data.diagnostics = patch.diagnostics;
    if (patch.sourceUrl !== undefined) data.sourceUrl = patch.sourceUrl ?? null;
    if (patch.userAgentHash !== undefined) data.userAgentHash = patch.userAgentHash ?? null;
    if (patch.fbp !== undefined) data.fbp = patch.fbp ?? null;
    if (patch.fbc !== undefined) data.fbc = patch.fbc ?? null;
    if (patch.hashedUserData !== undefined) data.hashedUserData = patch.hashedUserData;
    const row = await client.conversionEvent.update({ where: { id }, data });
    return mapConversionEvent(row);
  },

  async createAdCampaign(input: AdCampaignInput): Promise<AdCampaign> {
    const row = await client.adCampaign.create({
      data: {
        id: makeId("campaign"),
        companyId: input.companyId,
        marketingAccountId: input.marketingAccountId,
        platform: input.platform,
        externalCampaignId: input.externalCampaignId ?? null,
        name: input.name,
        objective: input.objective,
        status: input.status,
        dailyBudgetCents: input.dailyBudgetCents,
        approvalId: input.approvalId ?? null,
      },
    });
    return mapAdCampaign(row);
  },

  async listAdCampaigns(companyId: string): Promise<AdCampaign[]> {
    const rows = await client.adCampaign.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapAdCampaign);
  },

  async updateAdCampaign(id: string, patch: Partial<AdCampaign>): Promise<AdCampaign | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.externalCampaignId !== undefined) data.externalCampaignId = patch.externalCampaignId ?? null;
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.objective !== undefined) data.objective = patch.objective;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.dailyBudgetCents !== undefined) data.dailyBudgetCents = patch.dailyBudgetCents;
    if (patch.approvalId !== undefined) data.approvalId = patch.approvalId ?? null;
    const row = await client.adCampaign.update({ where: { id }, data }).catch(() => null);
    return row ? mapAdCampaign(row) : undefined;
  },

  async getAdCampaign(id: string): Promise<AdCampaign | undefined> {
    const row = await client.adCampaign.findUnique({ where: { id } });
    return row ? mapAdCampaign(row) : undefined;
  },

  async createAdCreativeVariant(input: AdCreativeVariantInput): Promise<AdCreativeVariant> {
    const row = await client.adCreativeVariant.create({
      data: {
        id: makeId("creative"),
        companyId: input.companyId,
        campaignId: input.campaignId,
        variantKey: input.variantKey,
        headline: input.headline,
        primaryText: input.primaryText,
        cta: input.cta,
        assetUrl: input.assetUrl ?? null,
        moderationStatus: input.moderationStatus,
        brandSafetyStatus: input.brandSafetyStatus,
        externalCreativeId: input.externalCreativeId ?? null,
        metrics: input.metrics,
      },
    });
    return mapAdCreativeVariant(row);
  },

  async updateAdCreativeVariant(
    id: string,
    patch: Partial<AdCreativeVariant>
  ): Promise<AdCreativeVariant | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.variantKey !== undefined) data.variantKey = patch.variantKey;
    if (patch.headline !== undefined) data.headline = patch.headline;
    if (patch.primaryText !== undefined) data.primaryText = patch.primaryText;
    if (patch.cta !== undefined) data.cta = patch.cta;
    if (patch.assetUrl !== undefined) data.assetUrl = patch.assetUrl ?? null;
    if (patch.moderationStatus !== undefined) data.moderationStatus = patch.moderationStatus;
    if (patch.brandSafetyStatus !== undefined) data.brandSafetyStatus = patch.brandSafetyStatus;
    if (patch.externalCreativeId !== undefined) data.externalCreativeId = patch.externalCreativeId ?? null;
    if (patch.metrics !== undefined) data.metrics = patch.metrics;
    const row = await client.adCreativeVariant.update({ where: { id }, data }).catch(() => null);
    return row ? mapAdCreativeVariant(row) : undefined;
  },

  async listAdCreativeVariants(companyId: string, campaignId?: string): Promise<AdCreativeVariant[]> {
    const rows = await client.adCreativeVariant.findMany({
      where: {
        companyId,
        ...(campaignId ? { campaignId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapAdCreativeVariant);
  },

  async getAdSpendCharge(companyId: string, billingDate: string): Promise<AdSpendCharge | undefined> {
    const row = await client.adSpendCharge.findUnique({
      where: {
        companyId_billingDate: {
          companyId,
          billingDate: billingDateToDate(billingDate),
        },
      },
    });
    return row ? mapAdSpendCharge(row) : undefined;
  },

  async createAdSpendCharge(input: AdSpendChargeInput): Promise<AdSpendCharge> {
    const existing = await this.getAdSpendCharge(input.companyId, input.billingDate);
    if (existing) return existing;

    const row = await client.adSpendCharge.create({
      data: {
        id: makeId("adcharge"),
        companyId: input.companyId,
        billingDate: billingDateToDate(input.billingDate),
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
        adSpendCents: input.adSpendCents,
        platformFeeCents: input.platformFeeCents,
        status: input.status,
        failureCode: input.failureCode ?? null,
      },
    });
    return mapAdSpendCharge(row);
  },

  async updateAdSpendCharge(id: string, patch: Partial<AdSpendCharge>): Promise<AdSpendCharge | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.billingDate !== undefined) data.billingDate = billingDateToDate(patch.billingDate);
    if (patch.stripePaymentIntentId !== undefined) data.stripePaymentIntentId = patch.stripePaymentIntentId ?? null;
    if (patch.adSpendCents !== undefined) data.adSpendCents = patch.adSpendCents;
    if (patch.platformFeeCents !== undefined) data.platformFeeCents = patch.platformFeeCents;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.failureCode !== undefined) data.failureCode = patch.failureCode ?? null;
    const row = await client.adSpendCharge.update({ where: { id }, data }).catch(() => null);
    return row ? mapAdSpendCharge(row) : undefined;
  },

  async getOptimizationRun(marketingAccountId: string, runDate: string): Promise<OptimizationRun | undefined> {
    const row = await client.optimizationRun.findUnique({
      where: {
        marketingAccountId_runDate: {
          marketingAccountId,
          runDate: billingDateToDate(runDate),
        },
      },
    });
    return row ? mapOptimizationRun(row) : undefined;
  },

  async listOptimizationRuns(companyId: string): Promise<OptimizationRun[]> {
    const rows = await client.optimizationRun.findMany({
      where: { companyId },
      orderBy: { runDate: "desc" },
    });
    return rows.map(mapOptimizationRun);
  },

  async createOptimizationRun(input: OptimizationRunInput): Promise<OptimizationRun> {
    const existing = await this.getOptimizationRun(input.marketingAccountId, input.runDate);
    if (existing) return existing;

    const row = await client.optimizationRun.create({
      data: {
        id: makeId("optrun"),
        companyId: input.companyId,
        marketingAccountId: input.marketingAccountId,
        runDate: billingDateToDate(input.runDate),
        status: input.status,
        inputMetrics: input.inputMetrics,
        decisions: input.decisions,
      },
    });
    return mapOptimizationRun(row);
  },

  async updateOptimizationRun(id: string, patch: OptimizationRunPatch): Promise<OptimizationRun | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.inputMetrics !== undefined) data.inputMetrics = patch.inputMetrics;
    if (patch.decisions !== undefined) data.decisions = patch.decisions;
    const row = await client.optimizationRun.update({ where: { id }, data }).catch(() => null);
    return row ? mapOptimizationRun(row) : undefined;
  },

  async createCreativePerformanceMemory(
    input: CreativePerformanceMemoryInput
  ): Promise<CreativePerformanceMemory> {
    const row = await client.creativePerformanceMemory.create({
      data: {
        id: makeId("cremem"),
        companyId: input.companyId,
        featureKey: input.featureKey,
        outcome: input.outcome,
        sampleSize: input.sampleSize,
        sourceCampaignIds: input.sourceCampaignIds,
        privacyScope: input.privacyScope,
        validFrom: new Date(input.validFrom),
        validTo: input.validTo ? new Date(input.validTo) : null,
      },
    });
    return mapCreativePerformanceMemory(row);
  },

  async listCreativePerformanceMemories(featureKey: string): Promise<CreativePerformanceMemory[]> {
    const rows = await client.creativePerformanceMemory.findMany({
      where: { featureKey },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapCreativePerformanceMemory);
  },
};

function billingDateToDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateKey(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}
