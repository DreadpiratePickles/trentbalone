import { syncAgentMissionForApproval } from "@/lib/agent-mission-approval-hook";
import { runAgentMission } from "@/lib/agent-mission-runtime";
import { executeContentPerformanceFeedbackJob } from "@/lib/content/performance-feedback";
import { saveCreativeConnection } from "@/lib/creative-connections";
import type { MarketingPlatformAdapter } from "@/lib/marketing/platform-adapter";
import { saveMarketingPlatformConnection, saveSocialPlatformConnection } from "@/lib/platform-connections";
import type { RuntimeAcceptanceActuals } from "@/lib/runtime-acceptance-evals";
import type { SocialPlatformAdapter } from "@/lib/social/platform-adapter";
import { store } from "@/lib/store";
import type { Approval, JobRun } from "@/lib/types";
import { makeId } from "@/lib/utils";

export const AGENT_MISSION_E2E_FIXTURE_ID = "agent_mission_research_make_publish_reply_ads_report_e2e";

export async function buildAgentMissionE2EActuals(): Promise<RuntimeAcceptanceActuals> {
  const company = await store.createCompany({
    name: `AgentMissionE2EEval ${makeId("co")}`,
    brief: { vision: "test full content, social, ads mission loop" },
  });
  await saveSocialPlatformConnection(company.id, {
    platform: "x",
    accessToken: "x_eval_token_123456789",
    externalAccountId: "acct_x_eval",
    autoPublishEnabled: true,
  });
  await saveMarketingPlatformConnection(company.id, {
    platform: "meta",
    accessToken: "meta_eval_token_123456789",
    externalAccountId: "act_meta_eval",
    dailyBudgetCents: 2500,
    paymentStatus: "ready",
  });
  await saveCreativeConnection(company.id, { app: "higgsfield", apiKey: "higgs_eval_token_123456789" });

  const mission = await runMissionWithInboxFixture(company.id);
  await approveMissionWithQueuedFeedback(mission.approvals);
  const queuedFeedbackJobs = await listMissionPerformanceFeedbackJobs(company.id, mission.run.id);
  const feedbackExecution = queuedFeedbackJobs[0]
    ? await executeContentPerformanceFeedbackJob(queuedFeedbackJobs[0].id, {
      store,
      socialAdapterFactory: () => evalSocialAdapter("analytics"),
      marketingAdapterFactory: () => evalMarketingAdapter(),
    })
    : undefined;
  const feedbackResult = feedbackExecution?.result;

  const [run, events, artifacts, posts, drafts, campaigns, adCreativeVariants, jobs] = await Promise.all([
    store.getAgentMissionRun(mission.run.id),
    store.listAgentMissionEvents(mission.run.id),
    store.listArtifacts(company.id),
    store.listSocialPosts(company.id),
    store.listSocialOutreachDrafts(company.id),
    store.listAdCampaigns(company.id),
    store.listAdCreativeVariants(company.id),
    store.listJobRuns(company.id),
  ]);
  const missionArtifacts = artifacts.filter((artifact) => artifact.storageKey?.startsWith(`agent-missions/${mission.run.id}/`));
  const approvalGates = mission.approvals.map((approval) => approval.action.replace("agent_mission.", ""));
  const platformJobs = jobs.filter((job) => job.type === "platform_action");
  const runtimePerformanceFeedbackJobs = jobs.filter((job) =>
    job.type === "content_performance_ingest"
    && job.metadata.kind === "content_performance_feedback"
    && job.metadata.missionRunId === mission.run.id
  );
  const memoryLog = missionArtifacts.find((artifact) => artifact.storageKey === `agent-missions/${mission.run.id}/memory-log.md`);
  const memoryLogRefreshed = events.some((event) =>
    event.kind === "memory_ingested" && event.payload.refreshed === true
  );
  const runtimeInboxImportedMessages = sumEventNumber(events, "social_inbox_ingested", "importedMessages");
  const text = [
    run?.finalSummary,
    ...missionArtifacts.map((artifact) => `${artifact.title} ${artifact.storageKey} ${artifact.summary} ${artifact.content}`),
    ...events.map((event) => `${event.kind} ${JSON.stringify(event.payload)}`),
    ...posts.map((post) => `public_publish ${post.platform} ${post.status} ${post.externalPostId ?? ""}`),
    ...drafts.map((draft) => `${draft.purpose} ${draft.platform} ${draft.status}`),
    ...campaigns.map((campaign) => `Meta ads ${campaign.platform} ${campaign.status} ${campaign.externalCampaignId ?? ""}`),
    ...adCreativeVariants.map((variant) => `ad_creative ${variant.variantKey} ${variant.assetUrl ?? ""} ${variant.externalCreativeId ?? ""}`),
    ...jobs.map((job) => `${job.type} ${job.status} ${job.metadata.action ?? ""} ${job.metadata.provider ?? ""}`),
    `social_inbox_ingested imported ${runtimeInboxImportedMessages}`,
    `content_performance_feedback_jobs ${runtimePerformanceFeedbackJobs.length}`,
    `content_performance_feedback_ingested ${feedbackResult?.status ?? feedbackExecution?.status ?? "missing"} ${(feedbackResult?.recommendations ?? []).join(" ")}`,
    "content package",
  ].filter(Boolean).join("\n");

  return {
    [AGENT_MISSION_E2E_FIXTURE_ID]: {
      text,
      toolCalls: ["agent_mission.run"],
      state: {
        runId: mission.run.id,
        runStatus: run?.status,
        approvals: mission.approvals.length,
        approvalGates,
        events: events.length,
        artifacts: missionArtifacts.length,
        inboxImportedMessages: runtimeInboxImportedMessages,
        runtimeInboxImportedMessages,
        manualInboxImportedMessages: 0,
        runtimePerformanceFeedbackJobs: runtimePerformanceFeedbackJobs.length,
        manualPerformanceFeedbackIngestions: 0,
        performanceFeedbackStatus: feedbackResult?.status ?? feedbackExecution?.status,
        performanceRecommendations: feedbackResult?.recommendations ?? [],
        providerActions: platformJobs.length,
        providerActionKinds: platformJobs.map((job) => job.metadata.action).filter((action): action is string => typeof action === "string"),
        providerActionStatuses: platformJobs.map((job) => job.status),
        socialCalendar: posts.map((post) => ({
          id: post.id,
          platform: post.platform,
          status: post.status,
          scheduledFor: post.scheduledFor,
          publishedAt: post.publishedAt,
          externalPostId: post.externalPostId,
          approvalId: post.approvalId,
          mediaUrls: post.mediaUrls,
          creativeAssetSource: typeof post.metadata.creativeAssetSource === "string" ? post.metadata.creativeAssetSource : undefined,
        })),
        outreachDrafts: drafts.map((draft) => ({
          id: draft.id,
          platform: draft.platform,
          purpose: draft.purpose,
          status: draft.status,
          approvalId: draft.approvalId,
        })),
        adCampaigns: campaigns.map((campaign) => ({
          id: campaign.id,
          platform: campaign.platform,
          status: campaign.status,
          externalCampaignId: campaign.externalCampaignId,
          hasExternalCampaignId: Boolean(campaign.externalCampaignId),
          approvalId: campaign.approvalId,
        })),
        adCreativeVariants: adCreativeVariants.map((variant) => ({
          id: variant.id,
          platform: campaigns.find((campaign) => campaign.id === variant.campaignId)?.platform,
          campaignId: variant.campaignId,
          variantKey: variant.variantKey,
          assetUrl: variant.assetUrl,
          externalCreativeId: variant.externalCreativeId,
          hasExternalCreativeId: Boolean(variant.externalCreativeId),
        })),
        artifactStorageKeys: missionArtifacts.map((artifact) => artifact.storageKey).filter(Boolean),
        memoryLogArtifactId: memoryLog?.id,
        memoryLogRefreshed,
        ceoSummaryIncludesNextAction: Boolean(run?.finalSummary?.includes("Next action")),
      },
    },
  };
}

async function runMissionWithInboxFixture(companyId: string): ReturnType<typeof runAgentMission> {
  const previousMode = process.env.SOCIAL_INBOX_INGESTION_MODE;
  const previousHiggsfieldMode = process.env.HIGGSFIELD_GENERATION_MODE;
  const previousFetch = globalThis.fetch;
  process.env.SOCIAL_INBOX_INGESTION_MODE = "live";
  process.env.HIGGSFIELD_GENERATION_MODE = "live";
  globalThis.fetch = evalInboxFetch(previousFetch) as typeof fetch;
  try {
    return await runAgentMission({
      companyId,
      objective: "Research market trends, make Higgsfield content, publish to X after approval, reply to comments, route leads to sales, launch Meta ads, and report results to CEO.",
      trigger: "command",
      budgetCents: 7500,
    });
  } finally {
    if (previousMode === undefined) delete process.env.SOCIAL_INBOX_INGESTION_MODE;
    else process.env.SOCIAL_INBOX_INGESTION_MODE = previousMode;
    if (previousHiggsfieldMode === undefined) delete process.env.HIGGSFIELD_GENERATION_MODE;
    else process.env.HIGGSFIELD_GENERATION_MODE = previousHiggsfieldMode;
    globalThis.fetch = previousFetch;
  }
}

async function approveMissionWithQueuedFeedback(approvals: Approval[]) {
  const previousFallback = process.env.TRENT_QUEUE_FALLBACK;
  process.env.TRENT_QUEUE_FALLBACK = "disabled";
  try {
    for (const approval of approvals) {
      const resolved = await store.resolveApproval(approval.id, "approved");
      if (resolved) await syncAgentMissionForApproval(resolved);
    }
  } finally {
    if (previousFallback === undefined) delete process.env.TRENT_QUEUE_FALLBACK;
    else process.env.TRENT_QUEUE_FALLBACK = previousFallback;
  }
}

async function listMissionPerformanceFeedbackJobs(companyId: string, runId: string): Promise<JobRun[]> {
  return (await store.listJobRuns(companyId)).filter((job) =>
    job.type === "content_performance_ingest"
    && job.metadata.kind === "content_performance_feedback"
    && job.metadata.missionRunId === runId
  );
}

function evalInboxFetch(fallback: typeof fetch) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("https://api.x.com/2/users/acct_x_eval/mentions")) {
      return new Response(JSON.stringify({
        data: [
          {
            id: "eval_comment_1",
            text: "Can Trent publish clips for us?",
            author_id: "eval_lead_1",
            conversation_id: "eval_thread_1",
            created_at: "2026-06-06T12:00:00.000Z",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/video/generate")) {
      return new Response(JSON.stringify({
        job_id: "hf_eval_job_1",
        status: "completed",
        video_url: "https://cdn.higgsfield.test/eval-video.mp4",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fallback(input, init);
  };
}

function sumEventNumber(events: Awaited<ReturnType<typeof store.listAgentMissionEvents>>, kind: string, field: string) {
  return events
    .filter((event) => event.kind === kind)
    .reduce((total, event) => total + (typeof event.payload[field] === "number" ? event.payload[field] : 0), 0);
}

function evalSocialAdapter(mode: "inbox" | "analytics"): SocialPlatformAdapter {
  return {
    platform: "x",
    capabilities: {
      posts: true,
      replies: true,
      dms: false,
      inbox: true,
      analytics: true,
      videoUpload: true,
      storiesReels: false,
      communityPosts: false,
      moderationActions: false,
    },
    async createPostDraft() {
      return { platform: "x", externalDraftId: "eval_draft", status: "draft" };
    },
    async publishPost() {
      return { platform: "x", externalPostId: "eval_post", status: "published", publishedAt: new Date().toISOString() };
    },
    async reply() {
      return { platform: "x", externalReplyId: "eval_reply", status: "sent" };
    },
    async sendDm() {
      return { platform: "x", externalMessageId: "eval_dm", status: "sent" };
    },
    async fetchInbox() {
      return {
        platform: "x",
        status: "fetched",
        messages: mode === "inbox" ? [{
          externalMessageId: "eval_comment_1",
          externalThreadId: "eval_thread_1",
          externalContactId: "eval_lead_1",
          direction: "inbound",
          kind: "comment",
          content: "Can Trent publish clips for us?",
          sentAt: "2026-06-06T12:00:00.000Z",
          metadata: { username: "buyer_ops" },
        }] : [],
      };
    },
    async fetchAnalytics() {
      return { platform: "x", impressions: 3200, engagements: 512, clicks: 90, followersDelta: 18, videoViews: 2800 };
    },
    async deleteOrHideContent(input) {
      return { platform: "x", externalContentId: input.externalContentId, action: input.action, status: "completed" };
    },
  };
}

function evalMarketingAdapter(): MarketingPlatformAdapter {
  return {
    platform: "meta",
    capabilities: {
      campaignDrafts: true,
      conversionSource: false,
      serverEvents: false,
      insights: true,
      budgetUpdates: true,
      pauseCampaigns: true,
    },
    async createCampaignDraft() {
      return { platform: "meta", externalCampaignId: "eval_campaign", status: "draft" };
    },
    async createAdSet() {
      return { platform: "meta", externalAdSetId: "eval_adset", status: "draft" };
    },
    async createCreative() {
      return { platform: "meta", externalCreativeId: "eval_creative", status: "draft" };
    },
    async ensureConversionSource() {
      return { platform: "meta", externalConversionSourceId: "eval_pixel", status: "sandbox" };
    },
    async sendConversionEvent(input) {
      return { platform: "meta", eventId: input.eventId, delivered: false, status: "sandbox" };
    },
    async fetchInsights() {
      return { platform: "meta", impressions: 4200, clicks: 260, spendCents: 3100, conversions: 11 };
    },
    async pauseCampaign(input) {
      return { platform: "meta", externalCampaignId: input.externalCampaignId, status: "paused" };
    },
    async setBudget(input) {
      return { platform: "meta", externalCampaignId: input.externalCampaignId, status: "budget_updated" };
    },
  };
}
