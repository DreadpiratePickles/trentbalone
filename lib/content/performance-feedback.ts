import { getMarketingPlatformAdapter, type MarketingPlatformAdapter } from "@/lib/marketing/platform-adapter";
import type { AdCampaign, MarketingAccount, OptimizationRunInput } from "@/lib/marketing/types";
import { getSocialPlatformAdapter, type SocialAnalytics, type SocialPlatformAdapter } from "@/lib/social/platform-adapter";
import type { SocialAccount, SocialAnalyticsSnapshot, SocialPost } from "@/lib/social/types";
import { store as appStore } from "@/lib/store";
import type { AgentMissionEvent, Document, JobRun } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export type ContentPerformanceFeedbackStore = {
  listSocialAccounts(companyId: string): Promise<SocialAccount[]>;
  listSocialPosts(companyId: string): Promise<SocialPost[]>;
  upsertSocialAnalyticsSnapshot(input: Omit<SocialAnalyticsSnapshot, "id" | "createdAt" | "updatedAt">): Promise<SocialAnalyticsSnapshot>;
  listMarketingAccounts(companyId: string): Promise<MarketingAccount[]>;
  listAdCampaigns(companyId: string): Promise<AdCampaign[]>;
  createOptimizationRun(input: OptimizationRunInput): Promise<unknown>;
  createDocument(input: Omit<Document, "id" | "createdAt" | "version"> & { version?: number }): Promise<Document>;
  createJobRun?(input: Omit<JobRun, "id" | "startedAt">): Promise<JobRun>;
  getJobRun?(id: string): Promise<JobRun | undefined>;
  updateJobRun?(id: string, patch: Partial<JobRun>): Promise<JobRun | undefined>;
  appendAgentMissionEvent?(input: {
    runId: string;
    companyId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<AgentMissionEvent | unknown>;
};

export type QueueContentPerformanceFeedbackInput = {
  companyId: string;
  missionRunId?: string;
  since?: string;
  until?: string;
  trigger?: JobRun["trigger"];
  enqueue?: boolean;
  store?: ContentPerformanceFeedbackStore;
};

export type ContentPerformanceFeedbackJobResult = {
  status: "completed" | "failed" | "skipped";
  jobRun: JobRun;
  result?: ContentPerformanceFeedbackResult;
  error?: string;
};

export type ContentPerformanceFeedbackInput = {
  companyId: string;
  missionRunId?: string;
  since?: string;
  until?: string;
  store?: ContentPerformanceFeedbackStore;
  socialAdapterFactory?: (platform: SocialAccount["platform"]) => SocialPlatformAdapter;
  marketingAdapterFactory?: (platform: MarketingAccount["platform"]) => MarketingPlatformAdapter;
  now?: () => string;
};

export type ContentPerformanceFeedbackResult = {
  status: "completed" | "partial" | "blocked";
  socialSnapshots: number;
  adOptimizationRuns: number;
  recommendations: string[];
  blockers: string[];
  documentId?: string;
};

export async function ingestContentPerformanceFeedback(
  input: ContentPerformanceFeedbackInput,
): Promise<ContentPerformanceFeedbackResult> {
  const feedbackStore = input.store ?? requireContentPerformanceFeedbackStore();
  const now = input.now ?? nowIso;
  const since = input.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = input.until ?? now();
  const blockers: string[] = [];
  const recommendations: string[] = [];

  const [socialAccounts, socialPosts, marketingAccounts, campaigns] = await Promise.all([
    feedbackStore.listSocialAccounts(input.companyId),
    feedbackStore.listSocialPosts(input.companyId),
    feedbackStore.listMarketingAccounts(input.companyId),
    feedbackStore.listAdCampaigns(input.companyId),
  ]);

  let socialSnapshots = 0;
  const socialAccountById = new Map(socialAccounts.map((account) => [account.id, account]));
  for (const post of socialPosts.filter((item) => item.status === "published" && item.externalPostId)) {
    const account = socialAccountById.get(post.socialAccountId);
    if (!account || account.status !== "active") continue;
    try {
      const adapter = (input.socialAdapterFactory ?? getSocialPlatformAdapter)(account.platform);
      const analytics = await adapter.fetchAnalytics({
        companyId: input.companyId,
        socialAccountId: account.id,
        externalAccountId: account.externalAccountId,
        externalPostId: post.externalPostId,
        since,
        until,
      });
      const recommendation = socialRecommendation(post, analytics);
      recommendations.push(recommendation);
      await feedbackStore.upsertSocialAnalyticsSnapshot({
        companyId: input.companyId,
        socialAccountId: account.id,
        platform: account.platform,
        periodStart: since,
        periodEnd: until,
        metrics: { ...analytics, postId: post.id, externalPostId: post.externalPostId },
        report: {
          loop: "content_performance_feedback",
          postId: post.id,
          externalPostId: post.externalPostId,
          variantKey: variantKey(post),
          recommendation,
          engagementRate: rate(analytics.engagements, analytics.impressions),
          clickRate: rate(analytics.clicks, analytics.impressions),
        },
      });
      socialSnapshots += 1;
    } catch (error) {
      blockers.push(`social ${post.platform} ${post.id}: ${errorMessage(error)}`);
    }
  }

  let adOptimizationRuns = 0;
  const marketingAccountById = new Map(marketingAccounts.map((account) => [account.id, account]));
  for (const campaign of campaigns.filter((item) => item.status !== "archived" && item.externalCampaignId)) {
    const account = marketingAccountById.get(campaign.marketingAccountId);
    if (!account || account.status !== "active") continue;
    try {
      const adapter = (input.marketingAdapterFactory ?? getMarketingPlatformAdapter)(account.platform);
      const insights = await adapter.fetchInsights({
        companyId: input.companyId,
        marketingAccountId: account.id,
        externalAccountId: account.externalAccountId,
        externalCampaignId: campaign.externalCampaignId ?? "",
        since,
        until,
      });
      const decisions = adDecisions(campaign, insights);
      recommendations.push(...decisions.map((decision) => `${title(campaign.platform)} campaign ${campaign.name}: ${decision.reason}`));
      await feedbackStore.createOptimizationRun({
        companyId: input.companyId,
        marketingAccountId: account.id,
        runDate: until.slice(0, 10),
        status: "completed",
        inputMetrics: { campaignId: campaign.id, externalCampaignId: campaign.externalCampaignId, ...insights },
        decisions,
      });
      adOptimizationRuns += 1;
    } catch (error) {
      blockers.push(`ads ${campaign.platform} ${campaign.id}: ${errorMessage(error)}`);
    }
  }

  const document = await feedbackStore.createDocument({
    companyId: input.companyId,
    type: "agent_note",
    title: `Content performance feedback ${until.slice(0, 10)}`,
    content: feedbackMarkdown({ since, until, socialSnapshots, adOptimizationRuns, recommendations, blockers }),
    source: "content-performance-feedback",
    memoryTier: "semantic",
    validFrom: until,
  });
  await appendMissionEvent(feedbackStore, input, {
    socialSnapshots,
    adOptimizationRuns,
    recommendations,
    blockers,
    documentId: document.id,
  });

  return {
    status: blockers.length === 0 ? "completed" : (socialSnapshots > 0 || adOptimizationRuns > 0 ? "partial" : "blocked"),
    socialSnapshots,
    adOptimizationRuns,
    recommendations,
    blockers,
    documentId: document.id,
  };
}

export async function queueContentPerformanceFeedbackIngestion(
  input: QueueContentPerformanceFeedbackInput,
): Promise<JobRun> {
  const feedbackStore = input.store ?? requireContentPerformanceFeedbackStore();
  if (typeof feedbackStore.createJobRun !== "function") {
    throw new Error("Content performance feedback queue store methods are not available");
  }
  const job = await feedbackStore.createJobRun({
    type: "content_performance_ingest",
    status: "running",
    companyId: input.companyId,
    trigger: input.trigger ?? "system",
    summary: "Ingest content and ad performance feedback",
    resultCount: 0,
    metadata: {
      kind: "content_performance_feedback",
      companyId: input.companyId,
      missionRunId: input.missionRunId,
      since: input.since,
      until: input.until,
    },
  });
  if (!input.store && input.enqueue !== false) {
    const { enqueueExistingJobRunForProcessing } = await import("@/lib/queue");
    await enqueueExistingJobRunForProcessing("content_performance_ingest", {
      jobRunId: job.id,
      companyId: input.companyId,
      trigger: input.trigger ?? "system",
    });
  }
  return job;
}

export async function executeContentPerformanceFeedbackJob(
  jobRunId: string,
  deps: {
    store?: ContentPerformanceFeedbackStore;
    socialAdapterFactory?: (platform: SocialAccount["platform"]) => SocialPlatformAdapter;
    marketingAdapterFactory?: (platform: MarketingAccount["platform"]) => MarketingPlatformAdapter;
  } = {},
): Promise<ContentPerformanceFeedbackJobResult> {
  const feedbackStore = deps.store ?? requireContentPerformanceFeedbackStore();
  if (typeof feedbackStore.getJobRun !== "function" || typeof feedbackStore.updateJobRun !== "function") {
    throw new Error("Content performance feedback queue store methods are not available");
  }
  const job = await feedbackStore.getJobRun(jobRunId);
  if (!job) throw new Error(`Content performance feedback job not found: ${jobRunId}`);
  if (job.type !== "content_performance_ingest") return { status: "skipped", jobRun: job };
  if (job.status !== "running") return { status: "skipped", jobRun: job };

  try {
    const metadata = parseFeedbackJobMetadata(job);
    const result = await ingestContentPerformanceFeedback({
      companyId: metadata.companyId,
      missionRunId: metadata.missionRunId,
      since: metadata.since,
      until: metadata.until,
      store: feedbackStore,
      socialAdapterFactory: deps.socialAdapterFactory,
      marketingAdapterFactory: deps.marketingAdapterFactory,
    });
    const updated = await feedbackStore.updateJobRun(job.id, {
      status: "completed",
      completedAt: nowIso(),
      summary: "Completed content and ad performance feedback ingestion",
      resultCount: 1,
      metadata: { ...job.metadata, result },
    });
    return { status: "completed", jobRun: updated ?? job, result };
  } catch (error) {
    const message = errorMessage(error);
    const updated = await feedbackStore.updateJobRun(job.id, {
      status: "failed",
      completedAt: nowIso(),
      error: message,
      resultCount: 0,
      metadata: { ...job.metadata, error: message },
    });
    return { status: "failed", jobRun: updated ?? job, error: message };
  }
}

function socialRecommendation(post: SocialPost, analytics: SocialAnalytics) {
  const variant = variantKey(post);
  const engagementRate = rate(analytics.engagements, analytics.impressions);
  if (engagementRate >= 0.12) return `Repurpose ${variant}; engagement rate ${(engagementRate * 100).toFixed(1)}% is above the 12% learning threshold.`;
  if (analytics.clicks > 0) return `Keep ${variant} but strengthen the CTA; clicks exist but engagement is ${analytics.engagements}.`;
  return `Refresh ${variant}; low visible engagement means the next iteration needs a clearer hook.`;
}

function adDecisions(campaign: AdCampaign, insights: { clicks: number; spendCents: number; conversions: number }) {
  const cpa = insights.conversions > 0 ? Math.round(insights.spendCents / insights.conversions) : undefined;
  if (insights.conversions > 0 && cpa !== undefined && cpa <= campaign.dailyBudgetCents) {
    return [{ action: "scale_winner", reason: `CPA ${cpa}c is within the daily budget guardrail.` }];
  }
  if (insights.clicks > 0) return [{ action: "refresh_creative", reason: "Clicks exist but conversions are weak; test a sharper offer." }];
  return [{ action: "pause_or_rework", reason: "No meaningful click or conversion signal yet." }];
}

function feedbackMarkdown(input: {
  since: string;
  until: string;
  socialSnapshots: number;
  adOptimizationRuns: number;
  recommendations: string[];
  blockers: string[];
}) {
  return [
    "# Content Performance Feedback",
    "",
    `Window: ${input.since} -> ${input.until}`,
    `Social snapshots: ${input.socialSnapshots}`,
    `Ad optimization runs: ${input.adOptimizationRuns}`,
    "",
    "## Recommendations",
    ...(input.recommendations.length ? input.recommendations.map((item) => `- ${item}`) : ["- No performance recommendations yet."]),
    "",
    "## Blockers",
    ...(input.blockers.length ? input.blockers.map((item) => `- ${item}`) : ["- None"]),
  ].join("\n");
}

async function appendMissionEvent(
  store: ContentPerformanceFeedbackStore,
  input: ContentPerformanceFeedbackInput,
  payload: Record<string, unknown>,
) {
  if (!input.missionRunId || typeof store.appendAgentMissionEvent !== "function") return;
  await store.appendAgentMissionEvent({
    runId: input.missionRunId,
    companyId: input.companyId,
    kind: "content_performance_feedback_ingested",
    payload,
  });
}

function requireContentPerformanceFeedbackStore(): ContentPerformanceFeedbackStore {
  const store = appStore as typeof appStore & Partial<ContentPerformanceFeedbackStore>;
  if (
    typeof store.listSocialAccounts !== "function" ||
    typeof store.listSocialPosts !== "function" ||
    typeof store.upsertSocialAnalyticsSnapshot !== "function" ||
    typeof store.listMarketingAccounts !== "function" ||
    typeof store.listAdCampaigns !== "function" ||
    typeof store.createOptimizationRun !== "function" ||
    typeof store.createDocument !== "function"
  ) {
    throw new Error("Content performance feedback store methods are not available");
  }
  return store as typeof appStore & ContentPerformanceFeedbackStore;
}

function parseFeedbackJobMetadata(job: JobRun) {
  const metadata = job.metadata ?? {};
  const companyId = typeof metadata.companyId === "string" ? metadata.companyId : job.companyId;
  if (!companyId) throw new Error("Content performance feedback job companyId is missing");
  return {
    companyId,
    missionRunId: typeof metadata.missionRunId === "string" ? metadata.missionRunId : undefined,
    since: typeof metadata.since === "string" ? metadata.since : undefined,
    until: typeof metadata.until === "string" ? metadata.until : undefined,
  };
}

function variantKey(post: SocialPost) {
  const value = post.metadata.variantKey;
  return typeof value === "string" && value.trim() ? value.trim() : post.content.slice(0, 40);
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function title(value: string) {
  return value === "meta" ? "Meta" : value[0]?.toUpperCase() + value.slice(1);
}
