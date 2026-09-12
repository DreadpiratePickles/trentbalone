import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetAgentMissionRun,
  mockListAgentMissionSteps,
  mockListAgentMissionEvents,
  mockListApprovals,
  mockListArtifacts,
  mockListSocialPosts,
  mockListSocialOutreachDrafts,
  mockListAdCampaigns,
  mockListAdCreativeVariants,
  mockListSocialAccounts,
  mockListMarketingAccounts,
  mockListJobRuns,
  mockListDocuments,
  mockListSocialAnalyticsSnapshots,
  mockListOptimizationRuns,
  mockListSocialConversations,
  mockGetSocialContact,
  mockListSocialMessagesForConversation,
  mockListCreativeConnectionStatuses,
  mockGetMarketingCredentialMap,
  mockGetSocialCredentialMap,
  mockListPlatformConnectionStatuses,
  rlsState,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  rlsState: { active: false },
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => {
    rlsState.active = true;
    try {
      return await fn();
    } finally {
      rlsState.active = false;
    }
  }),
  mockGetAgentMissionRun: vi.fn(),
  mockListAgentMissionSteps: vi.fn(),
  mockListAgentMissionEvents: vi.fn(),
  mockListApprovals: vi.fn(),
  mockListArtifacts: vi.fn(),
  mockListSocialPosts: vi.fn(),
  mockListSocialOutreachDrafts: vi.fn(),
  mockListAdCampaigns: vi.fn(),
  mockListAdCreativeVariants: vi.fn(),
  mockListSocialAccounts: vi.fn(),
  mockListMarketingAccounts: vi.fn(),
  mockListJobRuns: vi.fn(),
  mockListDocuments: vi.fn(),
  mockListSocialAnalyticsSnapshots: vi.fn(),
  mockListOptimizationRuns: vi.fn(),
  mockListSocialConversations: vi.fn(),
  mockGetSocialContact: vi.fn(),
  mockListSocialMessagesForConversation: vi.fn(),
  mockListCreativeConnectionStatuses: vi.fn(),
  mockGetMarketingCredentialMap: vi.fn(),
  mockGetSocialCredentialMap: vi.fn(),
  mockListPlatformConnectionStatuses: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: () => new Response("rate limited", { status: 429 }),
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getAgentMissionRun: mockGetAgentMissionRun,
    listAgentMissionSteps: mockListAgentMissionSteps,
    listAgentMissionEvents: mockListAgentMissionEvents,
    listApprovals: mockListApprovals,
    listArtifacts: mockListArtifacts,
    listSocialPosts: mockListSocialPosts,
    listSocialOutreachDrafts: mockListSocialOutreachDrafts,
    listAdCampaigns: mockListAdCampaigns,
    listAdCreativeVariants: mockListAdCreativeVariants,
    listSocialAccounts: mockListSocialAccounts,
    listMarketingAccounts: mockListMarketingAccounts,
    listJobRuns: mockListJobRuns,
    listDocuments: mockListDocuments,
    listSocialAnalyticsSnapshots: mockListSocialAnalyticsSnapshots,
    listOptimizationRuns: mockListOptimizationRuns,
    listSocialConversations: mockListSocialConversations,
    getSocialContact: mockGetSocialContact,
    listSocialMessagesForConversation: mockListSocialMessagesForConversation,
  },
}));

vi.mock("@/lib/creative-connections", () => ({
  listCreativeConnectionStatuses: mockListCreativeConnectionStatuses,
}));

vi.mock("@/lib/platform-connections", () => ({
  getMarketingCredentialMap: mockGetMarketingCredentialMap,
  getSocialCredentialMap: mockGetSocialCredentialMap,
  listPlatformConnectionStatuses: mockListPlatformConnectionStatuses,
}));

import { GET } from "./route";

const PARAMS = { params: Promise.resolve({ id: "co_1", runId: "amr_1" }) };
const RUN = {
  id: "amr_1",
  companyId: "co_1",
  objective: "Create Higgsfield videos, publish to TikTok, and run Meta ads.",
  missionType: "content_social_ads",
  status: "awaiting_approval",
  trigger: "command",
  ownerSeat: "ceo",
  budgetCents: 5000,
  costCents: 0,
  approvalPolicy: {},
  modelPolicy: {},
  finalSummary: "CEO Mission Report",
  startedAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

describe("GET /api/companies/[id]/agent-missions/[runId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetAgentMissionRun.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return RUN;
    });
    mockListAgentMissionSteps.mockResolvedValue([{ id: "step_1", runId: "amr_1", companyId: "co_1", seq: 1, agentRole: "analyst" }]);
    mockListAgentMissionEvents.mockResolvedValue([
      { id: "event_1", runId: "amr_1", companyId: "co_1", seq: 1, kind: "run_start" },
      {
        id: "event_feedback",
        runId: "amr_1",
        companyId: "co_1",
        seq: 2,
        kind: "content_performance_feedback_ingested",
        payload: {
          documentId: "doc_feedback",
          recommendations: [
            "Repurpose the proof demo.",
            "Meta campaign AgentMission amr_1: CPA is inside the guardrail.",
          ],
        },
      },
      {
        id: "event_inbox",
        runId: "amr_1",
        companyId: "co_1",
        seq: 3,
        kind: "social_inbox_ingested",
        payload: {
          socialAccountId: "social_1",
          platform: "instagram",
          fetchedMessages: 1,
          importedMessages: 1,
          skippedDuplicates: 0,
        },
      },
    ]);
    mockListDocuments.mockResolvedValue([
      { id: "doc_feedback", companyId: "co_1", type: "agent_note", title: "Content performance feedback 2026-06-05", source: "content-performance-feedback", content: "Repurpose the proof demo.", memoryTier: "semantic", createdAt: "2026-06-05T00:00:00.000Z" },
      { id: "doc_other", companyId: "co_1", type: "agent_note", title: "Other feedback", source: "content-performance-feedback", content: "Other", memoryTier: "semantic", createdAt: "2026-06-05T00:00:00.000Z" },
    ]);
    mockListApprovals.mockResolvedValue([
      {
        id: "approval_1",
        companyId: "co_1",
        action: "agent_mission.public_publish",
        status: "pending",
        reason: "Public post requires approval",
        toolName: "agent_mission:amr_1:public_publish",
        previewKind: "post",
        previewContent: "Mission amr_1 requires approval",
        createdAt: "2026-06-04T00:00:03.000Z",
      },
      {
        id: "approval_other",
        companyId: "co_1",
        action: "agent_mission.public_publish",
        status: "pending",
        reason: "Other public post requires approval",
        toolName: "agent_mission:amr_other:public_publish",
        previewContent: "Mission amr_other requires approval",
        createdAt: "2026-06-04T00:00:03.000Z",
      },
    ]);
    mockListArtifacts.mockResolvedValue([
      { id: "artifact_1", companyId: "co_1", storageKey: "agent-missions/amr_1/memory-log.md", title: "Memory" },
      { id: "artifact_other", companyId: "co_1", storageKey: "agent-missions/amr_other/memory-log.md", title: "Other" },
    ]);
    mockListSocialPosts.mockResolvedValue([
      { id: "post_1", companyId: "co_1", approvalId: "approval_1", platform: "instagram", status: "queued", content: "Approved post", metadata: { runId: "amr_1" } },
      { id: "post_other", companyId: "co_1", approvalId: "approval_other", platform: "instagram", status: "queued", content: "Other post", metadata: { runId: "amr_other" } },
    ]);
    mockListSocialOutreachDrafts.mockResolvedValue([
      { id: "draft_1", companyId: "co_1", approvalId: "approval_1", contactId: "soccontact_1", platform: "instagram", purpose: "comment_or_dm_reply", status: "approved", message: "Approved reply" },
      { id: "draft_other", companyId: "co_1", approvalId: "approval_other", contactId: "agent-mission-amr_other", platform: "instagram", purpose: "comment_or_dm_reply", status: "approved", message: "Other reply" },
    ]);
    mockListAdCampaigns.mockResolvedValue([
      { id: "campaign_1", companyId: "co_1", approvalId: "approval_1", platform: "meta", name: "AgentMission amr_1", status: "draft", dailyBudgetCents: 5000 },
      { id: "campaign_other", companyId: "co_1", approvalId: "approval_other", platform: "meta", name: "AgentMission amr_other", status: "draft", dailyBudgetCents: 5000 },
    ]);
    mockListAdCreativeVariants.mockResolvedValue([
      {
        id: "creative_1",
        companyId: "co_1",
        campaignId: "campaign_1",
        variantKey: "higgsfield-video",
        headline: "See Trent ship the launch",
        primaryText: "Generated campaign creative",
        cta: "Learn More",
        assetUrl: "https://cdn.higgsfield.test/launch.mp4",
        moderationStatus: "approved",
        brandSafetyStatus: "approved",
        externalCreativeId: "sandbox_meta_creative_123",
        metrics: { source: "higgsfield" },
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
      {
        id: "creative_other",
        companyId: "co_1",
        campaignId: "campaign_other",
        variantKey: "other",
        headline: "Other",
        primaryText: "Other",
        cta: "Learn More",
        assetUrl: "https://cdn.higgsfield.test/other.mp4",
        moderationStatus: "approved",
        brandSafetyStatus: "approved",
        metrics: {},
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ]);
    mockListSocialAccounts.mockResolvedValue([
      {
        id: "social_1",
        companyId: "co_1",
        platform: "tiktok",
        status: "active",
        externalAccountId: "tiktok_acct",
        displayName: "Trent TikTok",
        scopes: ["post:write"],
        credentialsRef: "connection_social",
        autoPublishEnabled: true,
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ]);
    mockListMarketingAccounts.mockResolvedValue([
      {
        id: "marketing_1",
        companyId: "co_1",
        platform: "meta",
        status: "active",
        externalAccountId: "act_123",
        displayName: "Trent Meta",
        currency: "USD",
        dailyBudgetCents: 5000,
        paymentStatus: "ready",
        consentForServerEvents: true,
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ]);
    mockListJobRuns.mockResolvedValue([
      {
        id: "job_1",
        type: "platform_action",
        status: "failed",
        companyId: "co_1",
        trigger: "system",
        startedAt: "2026-06-04T00:00:04.000Z",
        summary: "Queued platform action: ads.launch meta",
        resultCount: 0,
        error: "Meta Graph createCreative failed: Ad creative was rejected by policy review",
        metadata: {
          kind: "agent_mission_platform_action",
          runId: "amr_1",
          approvalId: "approval_1",
          action: "ads.launch",
          platform: "meta",
          provider: "Ads:Meta",
          targetId: "campaign_1",
          error: "Meta Graph createCreative failed: Ad creative was rejected by policy review",
          errorCode: "rejected_ad_creative",
          errorKind: "rejected_creative",
          recoverable: false,
        },
      },
      {
        id: "job_other",
        type: "platform_action",
        status: "running",
        companyId: "co_1",
        trigger: "system",
        startedAt: "2026-06-04T00:00:05.000Z",
        summary: "Queued platform action: ads.launch meta",
        resultCount: 0,
        metadata: {
          kind: "agent_mission_platform_action",
          runId: "amr_other",
          approvalId: "approval_other",
          action: "ads.launch",
          platform: "meta",
          provider: "Ads:Meta",
          targetId: "campaign_other",
        },
      },
    ]);
    mockListSocialAnalyticsSnapshots.mockResolvedValue([
      {
        id: "snapshot_1",
        companyId: "co_1",
        socialAccountId: "social_1",
        platform: "instagram",
        periodStart: "2026-06-04T00:00:00.000Z",
        periodEnd: "2026-06-05T00:00:00.000Z",
        metrics: { postId: "post_1", impressions: 12000, engagements: 1800, clicks: 220 },
        report: {
          loop: "content_performance_feedback",
          postId: "post_1",
          recommendation: "Repurpose the proof demo.",
          engagementRate: 0.15,
        },
      },
      {
        id: "snapshot_other",
        companyId: "co_1",
        socialAccountId: "social_1",
        platform: "instagram",
        periodStart: "2026-06-04T00:00:00.000Z",
        periodEnd: "2026-06-05T00:00:00.000Z",
        metrics: { postId: "post_other", impressions: 10 },
        report: { postId: "post_other", recommendation: "Other" },
      },
    ]);
    mockListOptimizationRuns.mockResolvedValue([
      {
        id: "opt_1",
        companyId: "co_1",
        marketingAccountId: "marketing_1",
        runDate: "2026-06-05",
        status: "completed",
        inputMetrics: { campaignId: "campaign_1", externalCampaignId: "ext_campaign_1", clicks: 260, spendCents: 3100, conversions: 11 },
        decisions: [{ action: "scale_winner", reason: "CPA is inside the guardrail." }],
      },
      {
        id: "opt_other",
        companyId: "co_1",
        marketingAccountId: "marketing_1",
        runDate: "2026-06-05",
        status: "completed",
        inputMetrics: { campaignId: "campaign_other" },
        decisions: [{ action: "other" }],
      },
    ]);
    mockListSocialConversations.mockResolvedValue([
      {
        id: "socconv_1",
        companyId: "co_1",
        socialAccountId: "social_1",
        platform: "instagram",
        externalThreadId: "thread_1",
        contactId: "soccontact_1",
        status: "open",
        lastMessageAt: "2026-06-04T00:10:00.000Z",
        metadata: { source: "social_inbox_ingestion" },
        createdAt: "2026-06-04T00:10:00.000Z",
        updatedAt: "2026-06-04T00:10:00.000Z",
      },
      {
        id: "socconv_other",
        companyId: "co_1",
        socialAccountId: "social_other",
        platform: "instagram",
        externalThreadId: "thread_other",
        contactId: "soccontact_other",
        status: "open",
        lastMessageAt: "2026-06-04T00:10:00.000Z",
        metadata: {},
        createdAt: "2026-06-04T00:10:00.000Z",
        updatedAt: "2026-06-04T00:10:00.000Z",
      },
    ]);
    mockGetSocialContact.mockImplementation(async (_companyId: string, contactId: string) => {
      if (contactId === "soccontact_1") {
        return {
          id: "soccontact_1",
          companyId: "co_1",
          platform: "instagram",
          externalContactId: "buyer_ops",
          handle: "buyer_ops",
          displayName: "Buyer Ops",
          engagementState: "engaged",
          optOutStatus: "not_opted_out",
          memory: {},
          createdAt: "2026-06-04T00:10:00.000Z",
          updatedAt: "2026-06-04T00:10:00.000Z",
        };
      }
      return undefined;
    });
    mockListSocialMessagesForConversation.mockImplementation(async (_companyId: string, conversationId: string) => {
      if (conversationId === "socconv_1") {
        return [{
          id: "socmsg_1",
          companyId: "co_1",
          conversationId: "socconv_1",
          contactId: "soccontact_1",
          direction: "inbound",
          kind: "comment",
          content: "Can Trent publish clips for us?",
          externalMessageId: "comment_1",
          sentAt: "2026-06-04T00:10:00.000Z",
          metadata: { username: "buyer_ops" },
          createdAt: "2026-06-04T00:10:00.000Z",
          updatedAt: "2026-06-04T00:10:00.000Z",
        }];
      }
      return [{
        id: "socmsg_other",
        companyId: "co_1",
        conversationId,
        direction: "inbound",
        kind: "comment",
        content: "Other conversation",
        sentAt: "2026-06-04T00:10:00.000Z",
        metadata: {},
        createdAt: "2026-06-04T00:10:00.000Z",
        updatedAt: "2026-06-04T00:10:00.000Z",
      }];
    });
    mockListCreativeConnectionStatuses.mockResolvedValue([
      { app: "higgsfield", provider: "Higgsfield", status: "needs_credentials", source: "missing", scopes: ["creative:generate"] },
      { app: "hyperframes", provider: "HyperFrames", status: "connected", source: "env", scopes: ["creative:generate"], apiKey: "hyp...1234" },
    ]);
    mockGetMarketingCredentialMap.mockResolvedValue({});
    mockGetSocialCredentialMap.mockResolvedValue({});
    mockListPlatformConnectionStatuses.mockResolvedValue({
      social: [
        {
          platform: "tiktok",
          provider: "Social:TikTok",
          status: "needs_credentials",
          source: "company",
          scopes: ["post:write"],
          lastCheckedAt: "2026-06-04T00:00:00.000Z",
        },
      ],
      marketing: [
        {
          platform: "meta",
          provider: "Ads:Meta",
          status: "connected",
          source: "company",
          scopes: ["ads:read"],
          lastCheckedAt: "2026-06-04T00:00:00.000Z",
        },
      ],
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/companies/co_1/agent-missions/amr_1"), PARAMS);
    expect(res.status).toBe(401);
  });

  it("returns 404 when the mission is missing or belongs to another company", async () => {
    mockGetAgentMissionRun.mockResolvedValue({ ...RUN, companyId: "co_other" });
    const res = await GET(new Request("http://x/api/companies/co_1/agent-missions/amr_1"), PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns run, steps, events, approvals, artifacts, memory log, and execution records inside RLS", async () => {
    const res = await GET(new Request("http://x/api/companies/co_1/agent-missions/amr_1"), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(body.run.id).toBe("amr_1");
    expect(body.steps).toHaveLength(1);
    expect(body.events).toHaveLength(3);
    expect(body.approvals.map((item: { id: string }) => item.id)).toEqual(["approval_1"]);
    expect(body.artifacts.map((item: { id: string }) => item.id)).toEqual(["artifact_1"]);
    expect(body.memoryLog.id).toBe("artifact_1");
    expect(body.executions.socialPosts.map((item: { id: string }) => item.id)).toEqual(["post_1"]);
    expect(body.executions.outreachDrafts.map((item: { id: string }) => item.id)).toEqual(["draft_1"]);
    expect(body.executions.adCampaigns.map((item: { id: string }) => item.id)).toEqual(["campaign_1"]);
    expect(body.executions.adCreativeVariants.map((item: { id: string }) => item.id)).toEqual(["creative_1"]);
    expect(body.executions.adCreativeVariants[0]).toEqual(expect.objectContaining({
      campaignId: "campaign_1",
      variantKey: "higgsfield-video",
      assetUrl: "https://cdn.higgsfield.test/launch.mp4",
      externalCreativeId: "sandbox_meta_creative_123",
    }));
    expect(body.executions.providerActions.map((item: { id: string }) => item.id)).toEqual(["job_1"]);
    expect(body.executions.providerActions[0].metadata).toEqual(expect.objectContaining({
      action: "ads.launch",
      platform: "meta",
      provider: "Ads:Meta",
      targetId: "campaign_1",
    }));
    expect(body.approvalDashboard.summary).toEqual(expect.objectContaining({
      total: 1,
      pending: 1,
      approved: 0,
      rejected: 0,
      linkedTargets: 4,
      providerActions: 1,
    }));
    expect(body.approvalDashboard.groups).toEqual([
      expect.objectContaining({
        gate: "public_publish",
        label: "Public publish",
        total: 1,
        pending: 1,
        executionMode: "external_write",
        riskLabel: "Public channel write",
      }),
    ]);
    expect(body.approvalDashboard.cards).toEqual([
      expect.objectContaining({
        approvalId: "approval_1",
        gate: "public_publish",
        label: "Public publish",
        status: "pending",
        executionMode: "external_write",
        riskLabels: expect.arrayContaining(["Public channel write", "Provider action queued"]),
        nextAction: "Approve to execute queued provider actions; reject to fail the mission safely.",
        targets: expect.arrayContaining([
          expect.objectContaining({ kind: "social_post", id: "post_1", platform: "instagram", status: "queued" }),
          expect.objectContaining({ kind: "reply_draft", id: "draft_1", platform: "instagram", status: "approved" }),
          expect.objectContaining({ kind: "ad_campaign", id: "campaign_1", platform: "meta", status: "draft" }),
          expect.objectContaining({ kind: "provider_action", id: "job_1", platform: "meta", status: "failed" }),
        ]),
      }),
    ]);
    expect(body.platformFailures.summary).toEqual({
      total: 1,
      recoverable: 0,
      manualReview: 1,
      rateLimited: 0,
      expiredTokens: 0,
    });
    expect(body.platformFailures.failures).toEqual([
      expect.objectContaining({
        jobRunId: "job_1",
        action: "ads.launch",
        provider: "Ads:Meta",
        platform: "meta",
        targetId: "campaign_1",
        status: "failed",
        error: "Meta Graph createCreative failed: Ad creative was rejected by policy review",
        errorCode: "rejected_ad_creative",
        errorKind: "rejected_creative",
        recoverable: false,
        nextAction: "Revise the creative/content and resubmit for approval before retrying.",
      }),
    ]);
    expect(body.inboxEvidence.summary).toEqual(expect.objectContaining({
      conversations: 1,
      inboundMessages: 1,
      outboundMessages: 0,
      replyDrafts: 1,
      openConversations: 1,
    }));
    expect(body.inboxEvidence.conversations).toEqual([
      expect.objectContaining({
        conversationId: "socconv_1",
        platform: "instagram",
        externalThreadId: "thread_1",
        status: "open",
        contact: expect.objectContaining({
          id: "soccontact_1",
          handle: "buyer_ops",
          externalContactId: "buyer_ops",
        }),
        latestMessage: expect.objectContaining({
          id: "socmsg_1",
          direction: "inbound",
          kind: "comment",
          content: "Can Trent publish clips for us?",
        }),
        replyDrafts: [
          expect.objectContaining({
            id: "draft_1",
            status: "approved",
            message: "Approved reply",
          }),
        ],
      }),
    ]);
    expect(body.performanceFeedback.socialSnapshots.map((item: { id: string }) => item.id)).toEqual(["snapshot_1"]);
    expect(body.performanceFeedback.adOptimizationRuns.map((item: { id: string }) => item.id)).toEqual(["opt_1"]);
    expect(body.performanceFeedback.documents.map((item: { id: string }) => item.id)).toEqual(["doc_feedback"]);
    expect(body.performanceFeedback.recommendations).toEqual(expect.arrayContaining([
      "Repurpose the proof demo.",
      "Meta campaign AgentMission amr_1: CPA is inside the guardrail.",
    ]));
    expect(body.platformReadiness.ready).toBe(false);
    expect(body.platformReadiness.requirements.requiredSocialPlatforms).toEqual(["tiktok"]);
    expect(body.platformReadiness.requirements.requiredMarketingPlatforms).toEqual(["meta"]);
    expect(body.platformReadiness.requirements.requiredCreativeApps).toEqual(["higgsfield"]);
    expect(body.platformReadiness.blockers).toEqual(expect.arrayContaining([
      "higgsfield creative credentials are missing",
      "tiktok social credentials are missing",
      "meta ads credentials are missing",
    ]));
    expect(body.platformReadiness.creativeConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ app: "higgsfield", status: "needs_credentials", source: "missing" }),
    ]));
    expect(mockGetSocialCredentialMap).toHaveBeenCalledWith("co_1");
    expect(mockListPlatformConnectionStatuses).toHaveBeenCalledWith("co_1");
    expect(body.platformReadiness.socialConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "tiktok", provider: "Social:TikTok", status: "needs_credentials", source: "company" }),
    ]));
    expect(body.platformReadiness.marketingConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "meta", provider: "Ads:Meta", status: "connected", source: "company" }),
    ]));
  });
});
