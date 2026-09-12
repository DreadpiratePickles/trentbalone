import { describe, expect, it, vi } from "vitest";
import { createWeeklyAnalyticsReport, type SocialAnalyticsMetrics } from "./analytics";
import type { SocialAccount } from "./types";

describe("social analytics", () => {
  it("aggregates weekly metrics and upserts idempotent account snapshots", async () => {
    const upsertSocialAnalyticsSnapshot = vi.fn(async (input) => ({
      ...input,
      id: `snapshot_${input.socialAccountId}`,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    }));

    const report = await createWeeklyAnalyticsReport({
      store: { upsertSocialAnalyticsSnapshot },
      companyId: "co_1",
      periodStart: "2026-05-18T00:00:00.000Z",
      periodEnd: "2026-05-25T00:00:00.000Z",
      accountMetrics: [
        { account: account({ id: "acct_x", platform: "x" }), metrics: metrics({ impressions: 1_000, engagements: 80 }) },
        { account: account({ id: "acct_li", platform: "linkedin" }), metrics: metrics({ impressions: 2_000, engagements: 220 }) },
      ],
    });

    expect(upsertSocialAnalyticsSnapshot).toHaveBeenCalledTimes(2);
    expect(upsertSocialAnalyticsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      socialAccountId: "acct_x",
      platform: "x",
      periodStart: "2026-05-18T00:00:00.000Z",
      periodEnd: "2026-05-25T00:00:00.000Z",
    }));
    expect(report.aggregate.totals.impressions).toBe(3_000);
    expect(report.aggregate.totals.engagements).toBe(300);
    expect(report.aggregate.engagementRate).toBe(0.1);
    expect(report.aggregate.byPlatform.linkedin?.engagements).toBe(220);
    expect(report.snapshots).toHaveLength(2);
  });

  it("rejects accounts outside the requested tenant", async () => {
    await expect(createWeeklyAnalyticsReport({
      store: { upsertSocialAnalyticsSnapshot: vi.fn() },
      companyId: "co_1",
      periodStart: "2026-05-18T00:00:00.000Z",
      periodEnd: "2026-05-25T00:00:00.000Z",
      accountMetrics: [
        { account: account({ companyId: "co_2" }), metrics: metrics() },
      ],
    })).rejects.toThrow("Social account does not belong to company");
  });
});

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "acct_1",
    companyId: "co_1",
    platform: "x",
    status: "active",
    externalAccountId: "external_1",
    externalHandle: "@trent",
    displayName: "Trent",
    scopes: [],
    autoPublishEnabled: false,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

function metrics(overrides: Partial<SocialAnalyticsMetrics> = {}): SocialAnalyticsMetrics {
  return {
    impressions: 100,
    reach: 90,
    engagements: 10,
    clicks: 4,
    followersGained: 2,
    postsPublished: 1,
    replies: 1,
    shares: 1,
    saves: 1,
    profileVisits: 3,
    ...overrides,
  };
}
