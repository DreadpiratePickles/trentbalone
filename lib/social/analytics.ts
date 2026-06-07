import type {
  SocialAccount,
  SocialAnalyticsSnapshot,
  SocialAnalyticsSnapshotInput,
  SocialPlatform,
} from "./types";

export type SocialAnalyticsMetrics = {
  impressions: number;
  reach: number;
  engagements: number;
  clicks: number;
  followersGained: number;
  postsPublished: number;
  replies: number;
  shares: number;
  saves: number;
  profileVisits: number;
};

export type SocialAnalyticsStore = {
  upsertSocialAnalyticsSnapshot(input: SocialAnalyticsSnapshotInput): Promise<SocialAnalyticsSnapshot>;
};

export type WeeklyAccountMetrics = {
  account: SocialAccount;
  metrics: SocialAnalyticsMetrics;
  topPosts?: Array<{ id: string; content: string; engagements: number }>;
};

export type WeeklyAnalyticsReport = {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  aggregate: {
    totals: SocialAnalyticsMetrics;
    engagementRate: number;
    byPlatform: Partial<Record<SocialPlatform, SocialAnalyticsMetrics>>;
  };
  snapshots: SocialAnalyticsSnapshot[];
  recommendations: string[];
};

const EMPTY_METRICS: SocialAnalyticsMetrics = {
  impressions: 0,
  reach: 0,
  engagements: 0,
  clicks: 0,
  followersGained: 0,
  postsPublished: 0,
  replies: 0,
  shares: 0,
  saves: 0,
  profileVisits: 0,
};

export function normalizeSocialAnalyticsMetrics(input: Partial<SocialAnalyticsMetrics>): SocialAnalyticsMetrics {
  return {
    impressions: numberOrZero(input.impressions),
    reach: numberOrZero(input.reach),
    engagements: numberOrZero(input.engagements),
    clicks: numberOrZero(input.clicks),
    followersGained: numberOrZero(input.followersGained),
    postsPublished: numberOrZero(input.postsPublished),
    replies: numberOrZero(input.replies),
    shares: numberOrZero(input.shares),
    saves: numberOrZero(input.saves),
    profileVisits: numberOrZero(input.profileVisits),
  };
}

export async function createWeeklyAnalyticsReport(input: {
  store: SocialAnalyticsStore;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  accountMetrics: WeeklyAccountMetrics[];
}): Promise<WeeklyAnalyticsReport> {
  if (input.accountMetrics.length === 0) {
    throw new Error("At least one social account metric set is required");
  }

  const totals = { ...EMPTY_METRICS };
  const byPlatform: Partial<Record<SocialPlatform, SocialAnalyticsMetrics>> = {};
  const snapshots: SocialAnalyticsSnapshot[] = [];

  for (const item of input.accountMetrics) {
    if (item.account.companyId !== input.companyId) {
      throw new Error("Social account does not belong to company");
    }
    const normalized = normalizeSocialAnalyticsMetrics(item.metrics);
    addMetrics(totals, normalized);
    byPlatform[item.account.platform] ??= { ...EMPTY_METRICS };
    addMetrics(byPlatform[item.account.platform] as SocialAnalyticsMetrics, normalized);

    const accountReport = {
      accountId: item.account.id,
      platform: item.account.platform,
      engagementRate: rate(normalized.engagements, normalized.impressions),
      topPosts: item.topPosts ?? [],
    };
    snapshots.push(await input.store.upsertSocialAnalyticsSnapshot({
      companyId: input.companyId,
      socialAccountId: item.account.id,
      platform: item.account.platform,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      metrics: normalized,
      report: accountReport,
    }));
  }

  return {
    companyId: input.companyId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    aggregate: {
      totals,
      engagementRate: rate(totals.engagements, totals.impressions),
      byPlatform,
    },
    snapshots,
    recommendations: recommendationsFor(totals),
  };
}

function addMetrics(target: SocialAnalyticsMetrics, source: SocialAnalyticsMetrics) {
  for (const key of Object.keys(EMPTY_METRICS) as Array<keyof SocialAnalyticsMetrics>) {
    target[key] += source[key];
  }
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function recommendationsFor(metrics: SocialAnalyticsMetrics) {
  const recommendations: string[] = [];
  const engagementRate = rate(metrics.engagements, metrics.impressions);
  if (engagementRate >= 0.08) {
    recommendations.push("Double down on the strongest formats from this week.");
  } else {
    recommendations.push("Test sharper hooks and narrower audience-specific posts next week.");
  }
  if (metrics.clicks < metrics.engagements * 0.1) {
    recommendations.push("Add clearer calls to action where conversion is the goal.");
  }
  return recommendations;
}
