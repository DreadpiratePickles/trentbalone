import { getMarketingPlatformAdapter, type MarketingPlatformAdapter, type PlatformInsights } from "./platform-adapter";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import { writeCreativePerformanceMemoryRecords, type CreativePerformanceObservation } from "./creative-memory";
import type {
  AdCampaign,
  AdCreativeVariant,
  MarketingAccount,
  OptimizationRun,
  OptimizationRunInput,
  OptimizationRunPatch,
} from "./types";

const LOW_CTR = 0.005;
const FATIGUE_IMPRESSIONS = 1_000;
const MIN_LOSER_SPEND_CENTS = 1_000;
const SCALE_FACTOR = 1.2;

export type OptimizationDecision =
  | {
      type: "pause_loser";
      campaignId: string;
      externalCampaignId: string;
      reason: "spend_without_conversions";
    }
  | {
      type: "rotate_fatigued_creative";
      campaignId: string;
      creativeVariantId: string;
      reason: "low_ctr";
    }
  | {
      type: "scale_winner";
      campaignId: string;
      fromDailyBudgetCents: number;
      toDailyBudgetCents: number;
    }
  | {
      type: "request_budget_increase";
      campaignId: string;
      currentDailyBudgetCents: number;
      proposedDailyBudgetCents: number;
      accountDailyBudgetCapCents: number;
    };

export type DailyOptimizationInput = {
  companyId: string;
  marketingAccountId: string;
  runDate: string;
};

export type DailyOptimizationResult = {
  idempotent: boolean;
  run: OptimizationRun;
  decisions: OptimizationDecision[];
};

type OptimizerStore = {
  getOptimizationRun(marketingAccountId: string, runDate: string): Promise<OptimizationRun | undefined>;
  createOptimizationRun(input: OptimizationRunInput): Promise<OptimizationRun>;
  updateOptimizationRun(id: string, patch: OptimizationRunPatch): Promise<OptimizationRun | undefined>;
  getMarketingAccountById(id: string): Promise<MarketingAccount | undefined>;
  listAdCampaigns(companyId: string): Promise<AdCampaign[]>;
  listAdCreativeVariants(companyId: string, campaignId?: string): Promise<AdCreativeVariant[]>;
  updateAdCampaign(id: string, patch: Partial<AdCampaign>): Promise<AdCampaign | undefined>;
  updateAdCreativeVariant(id: string, patch: Partial<AdCreativeVariant>): Promise<AdCreativeVariant | undefined>;
  createApproval(input: Parameters<typeof store.createApproval>[0]): ReturnType<typeof store.createApproval>;
};

export type OptimizerDeps = {
  store: OptimizerStore;
  adapter: Pick<MarketingPlatformAdapter, "fetchInsights" | "pauseCampaign" | "setBudget">;
  now: () => string;
  writeCreativeMemoryRecords: (observations: CreativePerformanceObservation[]) => Promise<unknown>;
};

export async function runDailyOptimization(
  input: DailyOptimizationInput,
  deps?: OptimizerDeps
): Promise<DailyOptimizationResult> {
  assertRunDate(input.runDate);
  const optimizerStore = deps?.store ?? requireOptimizerStore();
  const existing = await optimizerStore.getOptimizationRun(input.marketingAccountId, input.runDate);
  if (existing) {
    return { idempotent: true, run: existing, decisions: decisionsFromRun(existing) };
  }

  const account = await optimizerStore.getMarketingAccountById(input.marketingAccountId);
  if (!account || account.companyId !== input.companyId) {
    throw new Error("Marketing account not found");
  }

  const adapter = deps?.adapter ?? getMarketingPlatformAdapter(account.platform);
  const timestamp = deps?.now() ?? nowIso();
  const pendingRun = await optimizerStore.createOptimizationRun({
    companyId: input.companyId,
    marketingAccountId: input.marketingAccountId,
    runDate: input.runDate,
    status: "running",
    inputMetrics: {},
    decisions: [],
  });
  const campaigns = (await optimizerStore.listAdCampaigns(input.companyId))
    .filter((campaign) =>
      campaign.marketingAccountId === input.marketingAccountId &&
      campaign.status === "active" &&
      Boolean(campaign.externalCampaignId)
    );

  const decisions: OptimizationDecision[] = [];
  const creativeObservations: CreativePerformanceObservation[] = [];
  const inputMetrics: Record<string, PlatformInsights> = {};

  for (const campaign of campaigns) {
    const externalCampaignId = campaign.externalCampaignId;
    if (!externalCampaignId) continue;

    const insights = await adapter.fetchInsights({
      companyId: input.companyId,
      marketingAccountId: account.id,
      externalAccountId: account.externalAccountId,
      externalCampaignId,
      since: input.runDate,
      until: input.runDate,
    });
    inputMetrics[campaign.id] = insights;

    if (insights.spendCents >= MIN_LOSER_SPEND_CENTS && insights.conversions === 0) {
      await adapter.pauseCampaign({
        companyId: input.companyId,
        marketingAccountId: account.id,
        externalAccountId: account.externalAccountId,
        externalCampaignId,
      });
      await optimizerStore.updateAdCampaign(campaign.id, { status: "paused" });
      decisions.push({
        type: "pause_loser",
        campaignId: campaign.id,
        externalCampaignId,
        reason: "spend_without_conversions",
      });
      continue;
    }

    if (isFatigued(insights)) {
      const variant = await firstActiveCreative(optimizerStore, input.companyId, campaign.id);
      if (variant) {
        await optimizerStore.updateAdCreativeVariant(variant.id, {
          metrics: {
            ...variant.metrics,
            rotationRecommendedAt: timestamp,
            rotationReason: "low_ctr",
            lastOptimizationRunDate: input.runDate,
          },
        });
        decisions.push({
          type: "rotate_fatigued_creative",
          campaignId: campaign.id,
          creativeVariantId: variant.id,
          reason: "low_ctr",
        });
        creativeObservations.push({
          companyId: input.companyId,
          featureKey: `creative:${variant.variantKey}`,
          outcome: "fatigued",
          campaignId: campaign.id,
        });
      }
      continue;
    }

    if (isWinner(insights)) {
      const proposedDailyBudgetCents = Math.ceil(campaign.dailyBudgetCents * SCALE_FACTOR);
      const cap = account.dailyBudgetCents ?? campaign.dailyBudgetCents;
      await optimizerStore.createApproval({
        companyId: input.companyId,
        action: "Approve marketing budget increase",
        reason: `Campaign ${campaign.name} is outperforming and needs approval before its budget changes.`,
        toolName: "marketing.optimize.daily",
        previewKind: "generic",
        previewContent: JSON.stringify({
          campaignId: campaign.id,
          marketingAccountId: account.id,
          runDate: input.runDate,
          currentDailyBudgetCents: campaign.dailyBudgetCents,
          proposedDailyBudgetCents,
          accountDailyBudgetCapCents: cap,
          withinApprovedCap: proposedDailyBudgetCents <= cap,
        }),
      });
      decisions.push({
        type: "request_budget_increase",
        campaignId: campaign.id,
        currentDailyBudgetCents: campaign.dailyBudgetCents,
        proposedDailyBudgetCents,
        accountDailyBudgetCapCents: cap,
      });
      creativeObservations.push({
        companyId: input.companyId,
        featureKey: `campaign:${campaign.objective}`,
        outcome: "winner",
        campaignId: campaign.id,
      });
    }
  }

  if (creativeObservations.length > 0) {
    await (deps?.writeCreativeMemoryRecords ?? writeCreativePerformanceMemoryRecords)(creativeObservations);
  }

  const run = await optimizerStore.updateOptimizationRun(pendingRun.id, {
    status: "completed",
    inputMetrics,
    decisions,
  }) ?? pendingRun;
  return { idempotent: false, run, decisions };
}

function decisionsFromRun(run: OptimizationRun) {
  return Array.isArray(run.decisions) ? run.decisions as OptimizationDecision[] : [];
}

function isFatigued(insights: PlatformInsights) {
  if (insights.impressions < FATIGUE_IMPRESSIONS) return false;
  if (insights.clicks <= 0) return true;
  return insights.clicks / insights.impressions < LOW_CTR;
}

function isWinner(insights: PlatformInsights) {
  if (insights.spendCents <= 0 || insights.conversions < 2 || insights.impressions <= 0) return false;
  return insights.clicks / insights.impressions >= 0.02;
}

async function firstActiveCreative(storeLike: OptimizerStore, companyId: string, campaignId: string) {
  const variants = await storeLike.listAdCreativeVariants(companyId, campaignId);
  return variants.find((variant) =>
    variant.campaignId === campaignId &&
    variant.moderationStatus === "approved" &&
    variant.brandSafetyStatus === "approved"
  );
}

function assertRunDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("runDate must be YYYY-MM-DD");
}

function requireOptimizerStore() {
  const marketingStore = store as typeof store & Partial<OptimizerStore>;
  const requiredMethods = [
    "getOptimizationRun",
    "createOptimizationRun",
    "updateOptimizationRun",
    "getMarketingAccountById",
    "listAdCampaigns",
    "listAdCreativeVariants",
    "updateAdCampaign",
    "updateAdCreativeVariant",
    "createApproval",
  ] as const;
  for (const method of requiredMethods) {
    if (typeof marketingStore[method] !== "function") {
      throw new Error(`Marketing optimizer store method is not available: ${method}`);
    }
  }
  return marketingStore as OptimizerStore;
}
