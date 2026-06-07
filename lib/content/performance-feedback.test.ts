import { describe, expect, it, vi } from "vitest";
import {
  executeContentPerformanceFeedbackJob,
  ingestContentPerformanceFeedback,
  queueContentPerformanceFeedbackIngestion,
  type ContentPerformanceFeedbackStore,
} from "./performance-feedback";
import type { AdCampaign, MarketingAccount, OptimizationRun } from "@/lib/marketing/types";
import type { Document } from "@/lib/types";
import type { SocialAccount, SocialPost } from "@/lib/social/types";

describe("ingestContentPerformanceFeedback", () => {
  it("reads social and ad metrics, persists recommendations, and emits mission memory events", async () => {
    const snapshots: unknown[] = [];
    const optimizationRuns: OptimizationRun[] = [];
    const documents: Document[] = [];
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const store: ContentPerformanceFeedbackStore = {
      listSocialAccounts: vi.fn(async (): Promise<SocialAccount[]> => [{
        id: "soc_1",
        companyId: "co_1",
        platform: "x" as const,
        status: "active" as const,
        externalAccountId: "user_1",
        scopes: ["post:write"],
        autoPublishEnabled: false,
        createdAt: "2026-06-06T12:00:00.000Z",
        updatedAt: "2026-06-06T12:00:00.000Z",
      }]),
      listSocialPosts: vi.fn(async (): Promise<SocialPost[]> => [{
        id: "post_1",
        companyId: "co_1",
        socialAccountId: "soc_1",
        platform: "x" as const,
        status: "published" as const,
        content: "Hook: rebuild your workflow",
        mediaUrls: [],
        externalPostId: "tweet_1",
        metadata: { variantKey: "workflow-hook" },
        createdAt: "2026-06-06T12:00:00.000Z",
        updatedAt: "2026-06-06T12:00:00.000Z",
      }]),
      upsertSocialAnalyticsSnapshot: vi.fn(async (input) => {
        snapshots.push(input);
        return {
          id: "snap_1",
          createdAt: "2026-06-06T12:00:00.000Z",
          updatedAt: "2026-06-06T12:00:00.000Z",
          ...input,
        };
      }),
      listMarketingAccounts: vi.fn(async () => [marketingAccount()]),
      listAdCampaigns: vi.fn(async () => [adCampaign()]),
      createOptimizationRun: vi.fn(async (input) => {
        const run = {
          id: "optrun_1",
          createdAt: "2026-06-06T12:00:00.000Z",
          updatedAt: "2026-06-06T12:00:00.000Z",
          ...input,
        };
        optimizationRuns.push(run);
        return run;
      }),
      createDocument: vi.fn(async (input) => {
        const doc = {
          id: "doc_1",
          createdAt: "2026-06-06T12:00:00.000Z",
          version: input.version ?? 1,
          ...input,
        };
        documents.push(doc);
        return doc;
      }),
      appendAgentMissionEvent: vi.fn(async (input) => {
        events.push({ kind: input.kind, payload: input.payload });
        return {
          id: "ame_1",
          seq: events.length,
          createdAt: "2026-06-06T12:00:00.000Z",
          ...input,
        };
      }),
    };

    const result = await ingestContentPerformanceFeedback({
      companyId: "co_1",
      missionRunId: "amr_1",
      since: "2026-06-05T00:00:00.000Z",
      until: "2026-06-06T00:00:00.000Z",
      store,
      socialAdapterFactory: () => ({
        platform: "x",
        capabilities: {} as never,
        createPostDraft: vi.fn() as never,
        publishPost: vi.fn() as never,
        reply: vi.fn() as never,
        sendDm: vi.fn() as never,
        fetchInbox: vi.fn() as never,
        fetchAnalytics: vi.fn(async () => ({
          platform: "x" as const,
          impressions: 1000,
          engagements: 180,
          clicks: 40,
          followersDelta: 12,
          videoViews: 0,
        })),
        deleteOrHideContent: vi.fn() as never,
      }),
      marketingAdapterFactory: () => ({
        platform: "meta",
        capabilities: {} as never,
        createCampaignDraft: vi.fn() as never,
        createAdSet: vi.fn() as never,
        createCreative: vi.fn() as never,
        ensureConversionSource: vi.fn() as never,
        sendConversionEvent: vi.fn() as never,
        fetchInsights: vi.fn(async () => ({
          platform: "meta" as const,
          impressions: 2000,
          clicks: 120,
          spendCents: 2400,
          conversions: 8,
        })),
        pauseCampaign: vi.fn() as never,
        setBudget: vi.fn() as never,
      }),
    });

    expect(result.status).toBe("completed");
    expect(result.socialSnapshots).toBe(1);
    expect(result.adOptimizationRuns).toBe(1);
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining("workflow-hook"),
      expect.stringContaining("Meta campaign"),
    ]));
    expect(snapshots[0]).toMatchObject({
      platform: "x",
      report: expect.objectContaining({ variantKey: "workflow-hook" }),
    });
    expect(optimizationRuns[0]).toMatchObject({
      status: "completed",
      decisions: expect.arrayContaining([
        expect.objectContaining({ action: "scale_winner" }),
      ]),
    });
    expect(documents[0]).toMatchObject({
      memoryTier: "semantic",
      source: "content-performance-feedback",
    });
    expect(events[0]).toMatchObject({
      kind: "content_performance_feedback_ingested",
      payload: expect.objectContaining({ socialSnapshots: 1, adOptimizationRuns: 1 }),
    });
  });

  it("queues and executes a durable content performance ingestion job", async () => {
    const jobs = new Map<string, any>();
    const store: ContentPerformanceFeedbackStore = {
      listSocialAccounts: vi.fn(async () => []),
      listSocialPosts: vi.fn(async () => []),
      upsertSocialAnalyticsSnapshot: vi.fn() as never,
      listMarketingAccounts: vi.fn(async () => []),
      listAdCampaigns: vi.fn(async () => []),
      createOptimizationRun: vi.fn() as never,
      createDocument: vi.fn(async (input) => ({
        id: "doc_1",
        createdAt: "2026-06-06T12:00:00.000Z",
        version: input.version ?? 1,
        ...input,
      })),
      createJobRun: vi.fn(async (input) => {
        const job = { id: "job_1", startedAt: "2026-06-06T12:00:00.000Z", ...input };
        jobs.set(job.id, job);
        return job;
      }),
      getJobRun: vi.fn(async (id) => jobs.get(id)),
      updateJobRun: vi.fn(async (id, patch) => {
        const updated = { ...jobs.get(id), ...patch };
        jobs.set(id, updated);
        return updated;
      }),
    };

    const queued = await queueContentPerformanceFeedbackIngestion({
      companyId: "co_1",
      missionRunId: "amr_1",
      since: "2026-06-05T00:00:00.000Z",
      until: "2026-06-06T00:00:00.000Z",
      store,
    });
    expect(queued.type).toBe("content_performance_ingest");

    const executed = await executeContentPerformanceFeedbackJob("job_1", { store });
    expect(executed.status).toBe("completed");
    expect(store.updateJobRun).toHaveBeenCalledWith("job_1", expect.objectContaining({
      status: "completed",
      resultCount: 1,
    }));
  });
});

function marketingAccount(): MarketingAccount {
  return {
    id: "mkt_1",
    companyId: "co_1",
    platform: "meta",
    status: "active",
    externalAccountId: "act_1",
    currency: "USD",
    dailyBudgetCents: 5000,
    paymentStatus: "ready",
    consentForServerEvents: false,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
  };
}

function adCampaign(): AdCampaign {
  return {
    id: "camp_1",
    companyId: "co_1",
    marketingAccountId: "mkt_1",
    platform: "meta",
    externalCampaignId: "meta_camp_1",
    name: "Founder workflow",
    objective: "LEADS",
    status: "active",
    dailyBudgetCents: 5000,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
  };
}
