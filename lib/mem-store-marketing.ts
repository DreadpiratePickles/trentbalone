import { state } from "./mem-store-state";
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
import { makeId, nowIso } from "./utils";

function marketingState() {
  const appState = state();
  appState.marketingAccounts ??= [];
  appState.conversionEvents ??= [];
  appState.adCampaigns ??= [];
  appState.adCreativeVariants ??= [];
  appState.audienceSegments ??= [];
  appState.adSpendCharges ??= [];
  appState.optimizationRuns ??= [];
  appState.creativePerformanceMemories ??= [];
  return appState;
}

export const memStoreMarketing = {
  async upsertMarketingAccount(input: MarketingAccountInput): Promise<MarketingAccount> {
    const timestamp = nowIso();
    const appState = marketingState();
    const existing = appState.marketingAccounts.find(
      (account) => account.companyId === input.companyId && account.platform === input.platform
    );
    if (existing) {
      Object.assign(existing, {
        externalAccountId: input.externalAccountId,
        externalBusinessId: input.externalBusinessId ?? existing.externalBusinessId,
        currency: input.currency ?? existing.currency,
        dailyBudgetCents: input.dailyBudgetCents ?? existing.dailyBudgetCents,
        consentForServerEvents: input.consentForServerEvents ?? existing.consentForServerEvents,
        status: input.status ?? existing.status,
        paymentStatus: input.paymentStatus ?? existing.paymentStatus,
        updatedAt: timestamp,
      });
      return existing;
    }

    const account: MarketingAccount = {
      id: makeId("mktacct"),
      companyId: input.companyId,
      platform: input.platform,
      status: input.status ?? "active",
      externalAccountId: input.externalAccountId,
      externalBusinessId: input.externalBusinessId,
      currency: input.currency ?? "USD",
      dailyBudgetCents: input.dailyBudgetCents,
      paymentStatus: input.paymentStatus ?? "ready",
      consentForServerEvents: input.consentForServerEvents ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.marketingAccounts.push(account);
    return account;
  },

  async getMarketingAccount(companyId: string, platform: MarketingPlatform): Promise<MarketingAccount | undefined> {
    return marketingState().marketingAccounts.find(
      (account) => account.companyId === companyId && account.platform === platform
    );
  },

  async getMarketingAccountById(id: string): Promise<MarketingAccount | undefined> {
    return marketingState().marketingAccounts.find((account) => account.id === id);
  },

  async listMarketingAccounts(companyId: string): Promise<MarketingAccount[]> {
    return marketingState().marketingAccounts.filter((account) => account.companyId === companyId);
  },

  async updateMarketingAccount(id: string, patch: Partial<MarketingAccount>): Promise<MarketingAccount | undefined> {
    const account = marketingState().marketingAccounts.find((item) => item.id === id);
    if (!account) return undefined;
    Object.assign(account, patch, { updatedAt: nowIso() });
    return account;
  },

  async createConversionEvent(input: ConversionEventInput): Promise<ConversionEvent> {
    const timestamp = nowIso();
    const appState = marketingState();
    if (appState.conversionEvents.some((event) => event.eventId === input.eventId)) {
      throw new Error(`Conversion event eventId already exists: ${input.eventId}`);
    }
    const event: ConversionEvent = {
      ...input,
      id: makeId("conversion"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.conversionEvents.push(event);
    return event;
  },

  async getConversionEventByEventId(eventId: string): Promise<ConversionEvent | undefined> {
    return marketingState().conversionEvents.find((event) => event.eventId === eventId);
  },

  async updateConversionEvent(id: string, patch: Partial<ConversionEvent>): Promise<ConversionEvent> {
    const event = marketingState().conversionEvents.find((item) => item.id === id);
    if (!event) throw new Error(`Conversion event not found: ${id}`);
    Object.assign(event, patch, { id, updatedAt: nowIso() });
    return event;
  },

  async createAdCampaign(input: AdCampaignInput): Promise<AdCampaign> {
    const timestamp = nowIso();
    const campaign: AdCampaign = {
      ...input,
      id: makeId("campaign"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    marketingState().adCampaigns.push(campaign);
    return campaign;
  },

  async listAdCampaigns(companyId: string): Promise<AdCampaign[]> {
    return marketingState().adCampaigns.filter((campaign) => campaign.companyId === companyId);
  },

  async updateAdCampaign(id: string, patch: Partial<AdCampaign>): Promise<AdCampaign | undefined> {
    const campaign = marketingState().adCampaigns.find((item) => item.id === id);
    if (!campaign) return undefined;
    Object.assign(campaign, patch, { updatedAt: nowIso() });
    return campaign;
  },

  async getAdCampaign(id: string): Promise<AdCampaign | undefined> {
    return marketingState().adCampaigns.find((item) => item.id === id);
  },

  async createAdCreativeVariant(input: AdCreativeVariantInput): Promise<AdCreativeVariant> {
    const timestamp = nowIso();
    const variant: AdCreativeVariant = {
      ...input,
      id: makeId("creative"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    marketingState().adCreativeVariants.push(variant);
    return variant;
  },

  async updateAdCreativeVariant(
    id: string,
    patch: Partial<AdCreativeVariant>
  ): Promise<AdCreativeVariant | undefined> {
    const variant = marketingState().adCreativeVariants.find((item) => item.id === id);
    if (!variant) return undefined;
    Object.assign(variant, patch, { updatedAt: nowIso() });
    return variant;
  },

  async listAdCreativeVariants(companyId: string, campaignId?: string): Promise<AdCreativeVariant[]> {
    return marketingState().adCreativeVariants.filter((variant) =>
      variant.companyId === companyId && (!campaignId || variant.campaignId === campaignId)
    );
  },

  async getAdSpendCharge(companyId: string, billingDate: string): Promise<AdSpendCharge | undefined> {
    return marketingState().adSpendCharges.find(
      (charge) => charge.companyId === companyId && charge.billingDate === billingDate
    );
  },

  async createAdSpendCharge(input: AdSpendChargeInput): Promise<AdSpendCharge> {
    const appState = marketingState();
    const existing = appState.adSpendCharges.find(
      (charge) => charge.companyId === input.companyId && charge.billingDate === input.billingDate
    );
    if (existing) return existing;

    const timestamp = nowIso();
    const charge: AdSpendCharge = {
      ...input,
      id: makeId("adcharge"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.adSpendCharges.push(charge);
    return charge;
  },

  async updateAdSpendCharge(id: string, patch: Partial<AdSpendCharge>): Promise<AdSpendCharge | undefined> {
    const charge = marketingState().adSpendCharges.find((item) => item.id === id);
    if (!charge) return undefined;
    Object.assign(charge, patch, { updatedAt: nowIso() });
    return charge;
  },

  async getOptimizationRun(marketingAccountId: string, runDate: string): Promise<OptimizationRun | undefined> {
    return marketingState().optimizationRuns.find(
      (run) => run.marketingAccountId === marketingAccountId && run.runDate === runDate
    );
  },

  async listOptimizationRuns(companyId: string): Promise<OptimizationRun[]> {
    return marketingState().optimizationRuns.filter((run) => run.companyId === companyId);
  },

  async createOptimizationRun(input: OptimizationRunInput): Promise<OptimizationRun> {
    const appState = marketingState();
    const existing = appState.optimizationRuns.find(
      (run) => run.marketingAccountId === input.marketingAccountId && run.runDate === input.runDate
    );
    if (existing) return existing;

    const timestamp = nowIso();
    const run: OptimizationRun = {
      ...input,
      id: makeId("optrun"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.optimizationRuns.push(run);
    return run;
  },

  async updateOptimizationRun(id: string, patch: OptimizationRunPatch): Promise<OptimizationRun | undefined> {
    const run = marketingState().optimizationRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, patch, { updatedAt: nowIso() });
    return run;
  },

  async createCreativePerformanceMemory(
    input: CreativePerformanceMemoryInput
  ): Promise<CreativePerformanceMemory> {
    const timestamp = nowIso();
    const memory: CreativePerformanceMemory = {
      ...input,
      id: makeId("cremem"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    marketingState().creativePerformanceMemories.push(memory);
    return memory;
  },

  async listCreativePerformanceMemories(featureKey: string): Promise<CreativePerformanceMemory[]> {
    return marketingState().creativePerformanceMemories.filter((memory) => memory.featureKey === featureKey);
  },
};
