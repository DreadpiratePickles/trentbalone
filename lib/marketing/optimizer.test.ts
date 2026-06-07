import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDailyOptimization } from "./optimizer";
import type { AdCampaign, AdCreativeVariant, MarketingAccount, OptimizationRun } from "./types";

const baseAccount: MarketingAccount = {
  id: "ma_1",
  companyId: "co_1",
  platform: "meta",
  status: "active",
  externalAccountId: "act_123",
  currency: "USD",
  dailyBudgetCents: 10_000,
  paymentStatus: "ready",
  consentForServerEvents: true,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:00.000Z",
};

describe("runDailyOptimization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is idempotent by marketing account and run date", async () => {
    const existingRun = optimizationRun({ id: "opt_existing" });
    const deps = optimizerDeps({
      existingRun,
    });

    const result = await runDailyOptimization({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }, deps);

    expect(result.idempotent).toBe(true);
    expect(result.run).toBe(existingRun);
    expect(deps.adapter.fetchInsights).not.toHaveBeenCalled();
    expect(deps.store.createOptimizationRun).not.toHaveBeenCalled();
  });

  it("fetches normalized platform insights and pauses losers with spend but no conversions", async () => {
    const loser = campaign({
      id: "camp_loser",
      externalCampaignId: "ext_loser",
      dailyBudgetCents: 2_500,
    });
    const deps = optimizerDeps({
      campaigns: [loser],
      insightsByCampaignId: {
        ext_loser: { impressions: 1_000, clicks: 50, spendCents: 1_200, conversions: 0 },
      },
    });

    const result = await runDailyOptimization({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }, deps);

    expect(deps.adapter.fetchInsights).toHaveBeenCalledWith({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "ext_loser",
      since: "2026-05-29",
      until: "2026-05-29",
    });
    expect(deps.store.createOptimizationRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "running",
      decisions: [],
    }));
    expect(callOrder(deps.store.createOptimizationRun)).toBeLessThan(callOrder(deps.adapter.pauseCampaign));
    expect(deps.adapter.pauseCampaign).toHaveBeenCalledWith({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "ext_loser",
    });
    expect(deps.store.updateAdCampaign).toHaveBeenCalledWith("camp_loser", { status: "paused" });
    expect(result.decisions).toContainEqual(expect.objectContaining({
      type: "pause_loser",
      campaignId: "camp_loser",
    }));
  });

  it("does not pause zero-conversion campaigns before the loser spend threshold", async () => {
    const early = campaign({
      id: "camp_early",
      externalCampaignId: "ext_early",
      dailyBudgetCents: 2_500,
    });
    const deps = optimizerDeps({
      campaigns: [early],
      insightsByCampaignId: {
        ext_early: { impressions: 1_000, clicks: 50, spendCents: 100, conversions: 0 },
      },
    });

    const result = await runDailyOptimization({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }, deps);

    expect(deps.adapter.pauseCampaign).not.toHaveBeenCalled();
    expect(deps.store.updateAdCampaign).not.toHaveBeenCalledWith("camp_early", { status: "paused" });
    expect(result.decisions).toEqual([]);
  });

  it("rotates fatigued creatives without crossing the approved account budget", async () => {
    const fatigued = campaign({
      id: "camp_fatigued",
      externalCampaignId: "ext_fatigued",
      dailyBudgetCents: 2_500,
    });
    const variant = creativeVariant({
      id: "creative_1",
      campaignId: "camp_fatigued",
      externalCreativeId: "ext_creative_1",
    });
    const deps = optimizerDeps({
      campaigns: [fatigued],
      variants: [variant],
      insightsByCampaignId: {
        ext_fatigued: { impressions: 10_000, clicks: 20, spendCents: 800, conversions: 1 },
      },
    });

    const result = await runDailyOptimization({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }, deps);

    expect(deps.store.updateAdCreativeVariant).toHaveBeenCalledWith("creative_1", {
      metrics: expect.objectContaining({
        rotationRecommendedAt: expect.any(String),
        rotationReason: "low_ctr",
      }),
    });
    expect(result.decisions).toContainEqual(expect.objectContaining({
      type: "rotate_fatigued_creative",
      campaignId: "camp_fatigued",
      creativeVariantId: "creative_1",
    }));
    expect(deps.writeCreativeMemoryRecords).toHaveBeenCalledWith([{
      companyId: "co_1",
      featureKey: "creative:v1",
      outcome: "fatigued",
      campaignId: "camp_fatigued",
    }]);
    expect(deps.adapter.setBudget).not.toHaveBeenCalled();
  });

  it("routes all winner budget increases to approvals without direct platform mutation", async () => {
    const withinCap = campaign({
      id: "camp_win",
      externalCampaignId: "ext_win",
      dailyBudgetCents: 5_000,
    });
    const overCap = campaign({
      id: "camp_over",
      externalCampaignId: "ext_over",
      dailyBudgetCents: 9_500,
    });
    const deps = optimizerDeps({
      campaigns: [withinCap, overCap],
      insightsByCampaignId: {
        ext_win: { impressions: 2_000, clicks: 120, spendCents: 2_000, conversions: 12 },
        ext_over: { impressions: 2_000, clicks: 150, spendCents: 3_000, conversions: 20 },
      },
    });

    const result = await runDailyOptimization({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }, deps);

    expect(deps.adapter.setBudget).not.toHaveBeenCalled();
    expect(deps.store.updateAdCampaign).not.toHaveBeenCalledWith("camp_win", expect.objectContaining({
      dailyBudgetCents: 6_000,
    }));
    expect(deps.store.createApproval).toHaveBeenCalledTimes(2);
    expect(deps.store.createApproval).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      action: "Approve marketing budget increase",
      toolName: "marketing.optimize.daily",
      previewKind: "generic",
    }));
    expect(JSON.parse(deps.store.createApproval.mock.calls[0]?.[0].previewContent).proposedDailyBudgetCents).toBe(6_000);
    expect(JSON.parse(deps.store.createApproval.mock.calls[1]?.[0].previewContent).proposedDailyBudgetCents).toBe(11_400);
    expect(result.decisions.map((decision) => decision.type)).toEqual([
      "request_budget_increase",
      "request_budget_increase",
    ]);
    expect(deps.writeCreativeMemoryRecords).toHaveBeenCalledWith([
      {
        companyId: "co_1",
        featureKey: "campaign:LEADS",
        outcome: "winner",
        campaignId: "camp_win",
      },
      {
        companyId: "co_1",
        featureKey: "campaign:LEADS",
        outcome: "winner",
        campaignId: "camp_over",
      },
    ]);
  });
});

function optimizerDeps(overrides: {
  account?: MarketingAccount;
  campaigns?: AdCampaign[];
  variants?: AdCreativeVariant[];
  existingRun?: OptimizationRun;
  insightsByCampaignId?: Record<string, {
    impressions: number;
    clicks: number;
    spendCents: number;
    conversions: number;
  }>;
} = {}) {
  const account = overrides.account ?? baseAccount;
  const campaigns = overrides.campaigns ?? [];
  const variants = overrides.variants ?? [];
  const insightsByCampaignId = overrides.insightsByCampaignId ?? {};
  const store = {
    getOptimizationRun: vi.fn(async () => overrides.existingRun),
    createOptimizationRun: vi.fn(async (input) => optimizationRun({
      ...input,
      decisions: input.decisions,
      inputMetrics: input.inputMetrics,
    })),
    updateOptimizationRun: vi.fn(async (id, patch) => optimizationRun({
      id,
      status: patch.status ?? "completed",
      decisions: patch.decisions ?? [],
      inputMetrics: patch.inputMetrics ?? {},
    })),
    getMarketingAccountById: vi.fn(async () => account),
    listAdCampaigns: vi.fn(async () => campaigns),
    listAdCreativeVariants: vi.fn(async () => variants),
    updateAdCampaign: vi.fn(async (id, patch) => {
      const found = campaigns.find((item) => item.id === id);
      return found ? { ...found, ...patch } : undefined;
    }),
    updateAdCreativeVariant: vi.fn(async (id, patch) => {
      const found = variants.find((item) => item.id === id);
      return found ? { ...found, ...patch } : undefined;
    }),
    createApproval: vi.fn(async (input) => ({
      id: "approval_1",
      status: "pending",
      createdAt: "2026-05-29T00:00:00.000Z",
      ...input,
    })),
  };
  const adapter = {
    fetchInsights: vi.fn(async (input) => ({
      platform: "meta" as const,
      ...(insightsByCampaignId[input.externalCampaignId] ?? {
        impressions: 0,
        clicks: 0,
        spendCents: 0,
        conversions: 0,
      }),
    })),
    pauseCampaign: vi.fn(async (input) => ({
      platform: "meta" as const,
      externalCampaignId: input.externalCampaignId,
      status: "paused" as const,
    })),
    setBudget: vi.fn(async (input) => ({
      platform: "meta" as const,
      externalCampaignId: input.externalCampaignId,
      status: "budget_updated" as const,
    })),
  };
  return {
    store,
    adapter,
    now: () => "2026-05-29T12:00:00.000Z",
    writeCreativeMemoryRecords: vi.fn(async () => []),
  };
}

function callOrder(mock: { mock: { invocationCallOrder: number[] } }) {
  return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
}

function campaign(patch: Partial<AdCampaign>): AdCampaign {
  return {
    id: "camp_1",
    companyId: "co_1",
    marketingAccountId: "ma_1",
    platform: "meta",
    externalCampaignId: "ext_campaign_1",
    name: "Launch",
    objective: "LEADS",
    status: "active",
    dailyBudgetCents: 2_500,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...patch,
  };
}

function creativeVariant(patch: Partial<AdCreativeVariant>): AdCreativeVariant {
  return {
    id: "creative_1",
    companyId: "co_1",
    campaignId: "camp_1",
    variantKey: "v1",
    headline: "Ship more",
    primaryText: "Trent ships work.",
    cta: "Book demo",
    moderationStatus: "approved",
    brandSafetyStatus: "approved",
    externalCreativeId: "ext_creative_1",
    metrics: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...patch,
  };
}

function optimizationRun(patch: Partial<OptimizationRun>): OptimizationRun {
  return {
    id: "opt_1",
    companyId: "co_1",
    marketingAccountId: "ma_1",
    runDate: "2026-05-29",
    status: "completed",
    inputMetrics: {},
    decisions: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...patch,
  };
}
