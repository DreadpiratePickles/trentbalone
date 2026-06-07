import { describe, expect, it, vi } from "vitest";
import { executeApprovedAgentMissionAction } from "@/lib/agent-mission-executor";
import { executeQueuedPlatformAction } from "@/lib/platform-action-runner";
import { store } from "@/lib/store";
import type { AgentMissionRun, Approval } from "@/lib/types";
import type { MarketingPlatformAdapter } from "@/lib/marketing/platform-adapter";
import type { SocialPlatformAdapter } from "@/lib/social/platform-adapter";

describe("executeQueuedPlatformAction", () => {
  it("publishes a queued social post through the sandbox provider and completes the job", async () => {
    await store.upsertSocialAccount({
      companyId: "co_platform_runner_social",
      platform: "tiktok",
      externalAccountId: "acct_tiktok",
      scopes: ["post:write"],
      credentialsRef: "cred_tiktok",
      autoPublishEnabled: true,
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run("co_platform_runner_social", "Publish to TikTok."),
      approval: approval("co_platform_runner_social", "public_publish"),
      gate: "public_publish",
    });

    const result = await executeQueuedPlatformAction(execution.providerActionId as string);
    const post = await store.getSocialPost(execution.externalRef as string);
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("completed");
    expect(post).toEqual(expect.objectContaining({
      status: "published",
      externalPostId: expect.stringContaining("sandbox_tiktok_post"),
      publishedAt: "2026-05-29T00:00:00.000Z",
    }));
    expect(post?.metadata.providerAction).toEqual(expect.objectContaining({
      jobRunId: execution.providerActionId,
      externalRef: post?.externalPostId,
    }));
    expect(job).toEqual(expect.objectContaining({
      status: "completed",
      resultCount: 1,
      completedAt: expect.any(String),
      summary: expect.stringContaining("[Simulated]"),
      metadata: expect.objectContaining({
        executionMode: "sandbox",
        result: expect.objectContaining({
          externalRef: post?.externalPostId,
          status: "published",
          executionMode: "sandbox",
        }),
      }),
    }));
  });

  it("creates a Meta campaign draft through the provider and records the external campaign id", async () => {
    const company = await store.createCompany({ name: "Platform runner ads", brief: { vision: "test" } });
    await store.upsertMarketingAccount({
      companyId: company.id,
      platform: "meta",
      externalAccountId: "act_meta",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run(company.id, "Run Meta ads."),
      approval: approval(company.id, "paid_spend_or_boost"),
      gate: "paid_spend_or_boost",
    });

    const result = await executeQueuedPlatformAction(execution.providerActionId as string);
    const campaign = await store.getAdCampaign(execution.externalRef as string);
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("completed");
    expect(campaign).toEqual(expect.objectContaining({
      platform: "meta",
      status: "draft",
      externalCampaignId: expect.stringContaining("sandbox_meta_campaign"),
    }));
    expect(job).toEqual(expect.objectContaining({
      status: "completed",
      resultCount: 1,
      metadata: expect.objectContaining({
        result: expect.objectContaining({
          externalRef: campaign?.externalCampaignId,
          status: "draft",
        }),
      }),
    }));
  });

  it("sends an approved reply draft through the sandbox provider and completes the job", async () => {
    await store.upsertSocialAccount({
      companyId: "co_platform_runner_reply",
      platform: "tiktok",
      externalAccountId: "acct_tiktok_reply",
      scopes: ["post:write"],
      credentialsRef: "cred_tiktok_reply",
      autoPublishEnabled: true,
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run("co_platform_runner_reply", "Reply to TikTok comments."),
      approval: approval("co_platform_runner_reply", "comment_or_dm_reply"),
      gate: "comment_or_dm_reply",
    });

    const result = await executeQueuedPlatformAction(execution.providerActionId as string);
    const drafts = await store.listSocialOutreachDrafts("co_platform_runner_reply");
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("completed");
    expect(drafts).toEqual([
      expect.objectContaining({
        id: execution.externalRef,
        status: "sent",
      }),
    ]);
    expect(job).toEqual(expect.objectContaining({
      status: "completed",
      resultCount: 1,
      metadata: expect.objectContaining({
        result: expect.objectContaining({
          externalRef: expect.stringContaining("sandbox_tiktok_reply"),
          status: "sent",
        }),
      }),
    }));
  });

  it("sends an approved sales outreach draft through the sandbox provider and completes the job", async () => {
    await store.upsertSocialAccount({
      companyId: "co_platform_runner_sales",
      platform: "linkedin",
      externalAccountId: "acct_linkedin_sales",
      scopes: ["post:write"],
      credentialsRef: "cred_linkedin_sales",
      autoPublishEnabled: true,
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run("co_platform_runner_sales", "Send LinkedIn outreach to sales leads."),
      approval: approval("co_platform_runner_sales", "email_or_sales_send"),
      gate: "email_or_sales_send",
    });

    const result = await executeQueuedPlatformAction(execution.providerActionId as string);
    const drafts = await store.listSocialOutreachDrafts("co_platform_runner_sales");
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("completed");
    expect(drafts).toEqual([
      expect.objectContaining({
        id: execution.externalRef,
        status: "sent",
      }),
    ]);
    expect(job).toEqual(expect.objectContaining({
      status: "completed",
      resultCount: 1,
      metadata: expect.objectContaining({
        result: expect.objectContaining({
          externalRef: expect.stringContaining("sandbox_linkedin_dm"),
          status: "sent",
        }),
      }),
    }));
  });

  it("fails the provider job with exact detail when the target record is missing", async () => {
    const job = await store.createJobRun({
      type: "platform_action",
      status: "running",
      companyId: "co_platform_runner_missing",
      trigger: "system",
      summary: "Queued platform action: social.publish tiktok",
      resultCount: 0,
      metadata: {
        kind: "agent_mission_platform_action",
        runId: "amr_platform_runner",
        approvalId: "approval_public_publish",
        gate: "public_publish",
        action: "social.publish",
        platform: "tiktok",
        provider: "Social:TikTok",
        targetId: "socpost_missing",
        payload: {},
      },
    });

    const result = await executeQueuedPlatformAction(job.id);
    const updated = await store.getJobRun(job.id);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Social post not found");
    expect(updated).toEqual(expect.objectContaining({
      status: "failed",
      resultCount: 0,
      error: expect.stringContaining("Social post not found"),
      metadata: expect.objectContaining({
        error: expect.stringContaining("Social post not found"),
      }),
    }));
  });

  it("preserves provider retry details for queue backoff", async () => {
    await store.upsertSocialAccount({
      companyId: "co_platform_runner_rate_limit",
      platform: "tiktok",
      externalAccountId: "acct_tiktok_rate_limit",
      scopes: ["post:write"],
      credentialsRef: "cred_tiktok_rate_limit",
      autoPublishEnabled: true,
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run("co_platform_runner_rate_limit", "Publish to TikTok."),
      approval: approval("co_platform_runner_rate_limit", "public_publish"),
      gate: "public_publish",
    });
    const error = new Error("Too many requests") as Error & { code: string; retryAfterSeconds: number };
    error.code = "rate_limited";
    error.retryAfterSeconds = 45;

    const result = await executeQueuedPlatformAction(execution.providerActionId as string, {
      socialAdapterFor: (): SocialPlatformAdapter => ({
        platform: "tiktok",
        capabilities: {
          posts: true,
          replies: true,
          dms: true,
          inbox: true,
          analytics: true,
          videoUpload: true,
          storiesReels: true,
          communityPosts: true,
          moderationActions: true,
        },
        createPostDraft: async () => ({ platform: "tiktok", externalDraftId: "draft_unused", status: "draft" }),
        publishPost: async () => { throw error; },
        reply: async () => { throw new Error("not used"); },
        sendDm: async () => { throw new Error("not used"); },
        fetchInbox: async () => ({ platform: "tiktok", messages: [], status: "sandbox" }),
        fetchAnalytics: async () => ({
          platform: "tiktok",
          impressions: 0,
          engagements: 0,
          clicks: 0,
          followersDelta: 0,
          videoViews: 0,
        }),
        deleteOrHideContent: async () => ({ platform: "tiktok", externalContentId: "hidden_unused", action: "hide", status: "sandbox" }),
      }),
    });
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("rate_limited");
    expect(result.errorKind).toBe("rate_limited");
    expect(result.retryAfterSeconds).toBe(45);
    expect(job?.metadata).toMatchObject({
      errorCode: "rate_limited",
      errorKind: "rate_limited",
      recoverable: true,
      retryAfterSeconds: 45,
    });
  });

  it("normalizes expired token failures as recoverable credential errors", async () => {
    await store.upsertSocialAccount({
      companyId: "co_platform_runner_expired_token",
      platform: "x",
      externalAccountId: "acct_x_expired",
      scopes: ["post:write"],
      credentialsRef: "cred_x_expired",
      autoPublishEnabled: true,
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run("co_platform_runner_expired_token", "Publish to X."),
      approval: approval("co_platform_runner_expired_token", "public_publish"),
      gate: "public_publish",
    });
    const error = new Error("X publishPost failed: expired OAuth token") as Error & { code: string };
    error.code = "expired_token";

    const result = await executeQueuedPlatformAction(execution.providerActionId as string, {
      socialAdapterFor: () => failingSocialAdapter("x", error),
    });
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("expired_token");
    expect(result.errorKind).toBe("expired_token");
    expect(job?.metadata).toMatchObject({
      errorCode: "expired_token",
      errorKind: "expired_token",
      recoverable: true,
    });
  });

  it("refreshes expired OAuth credentials once and retries approved social publishes", async () => {
    await store.upsertSocialAccount({
      companyId: "co_platform_runner_oauth_retry",
      platform: "x",
      externalAccountId: "acct_x_retry",
      scopes: ["post:write"],
      credentialsRef: "cred_x_retry",
      autoPublishEnabled: true,
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run("co_platform_runner_oauth_retry", "Publish to X after token refresh."),
      approval: approval("co_platform_runner_oauth_retry", "public_publish"),
      gate: "public_publish",
    });
    const expired = new Error("X publishPost failed: expired OAuth token") as Error & { code: string };
    expired.code = "expired_token";
    let publishAttempts = 0;
    const refresh = vi.fn(async () => ({
      status: "refreshed" as const,
      platform: "x" as const,
      kind: "social" as const,
    }));
    const retryingAdapter = failingSocialAdapter("x", expired);
    retryingAdapter.publishPost = async () => {
      publishAttempts += 1;
      if (publishAttempts === 1) throw expired;
      return {
        platform: "x",
        externalPostId: "tweet_after_refresh",
        status: "published",
        publishedAt: "2026-06-06T00:00:00.000Z",
      };
    };

    const result = await executeQueuedPlatformAction(execution.providerActionId as string, {
      oauthRefresh: refresh,
      socialAdapterFor: () => retryingAdapter,
    });
    const post = await store.getSocialPost(execution.externalRef as string);
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("completed");
    expect(result.oauthRefresh).toEqual({
      attempted: true,
      status: "refreshed",
      kind: "social",
      platform: "x",
    });
    expect(publishAttempts).toBe(2);
    expect(refresh).toHaveBeenCalledWith({
      companyId: "co_platform_runner_oauth_retry",
      kind: "social",
      platform: "x",
    });
    expect(post).toEqual(expect.objectContaining({
      status: "published",
      externalPostId: "tweet_after_refresh",
    }));
    expect(job?.metadata).toMatchObject({
      result: expect.objectContaining({
        externalRef: "tweet_after_refresh",
        oauthRefresh: expect.objectContaining({
          attempted: true,
          status: "refreshed",
          kind: "social",
          platform: "x",
        }),
      }),
    });
  });

  it("normalizes rejected Meta creative failures as non-recoverable creative review blockers", async () => {
    const company = await store.createCompany({ name: "Platform runner rejected creative", brief: { vision: "test" } });
    await store.upsertMarketingAccount({
      companyId: company.id,
      platform: "meta",
      externalAccountId: "act_meta_rejected",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });
    const execution = await executeApprovedAgentMissionAction({
      run: run(company.id, "Run Meta ads."),
      approval: approval(company.id, "paid_spend_or_boost"),
      gate: "paid_spend_or_boost",
    });
    const error = new Error("Meta ad creative rejected by policy review") as Error & { code: string };
    error.code = "rejected_ad_creative";

    const result = await executeQueuedPlatformAction(execution.providerActionId as string, {
      marketingAdapterFor: () => failingMarketingAdapter(error),
    });
    const job = await store.getJobRun(execution.providerActionId as string);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("rejected_ad_creative");
    expect(result.errorKind).toBe("rejected_creative");
    expect(job?.metadata).toMatchObject({
      errorCode: "rejected_ad_creative",
      errorKind: "rejected_creative",
      recoverable: false,
    });
  });
});

function run(companyId: string, objective: string): AgentMissionRun {
  return {
    id: "amr_platform_runner",
    companyId,
    objective,
    missionType: "content_social_ads",
    status: "awaiting_approval",
    trigger: "command",
    ownerSeat: "ceo",
    budgetCents: 5000,
    costCents: 0,
    approvalPolicy: {},
    modelPolicy: {},
    startedAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function approval(companyId: string, gate: string): Approval {
  return {
    id: `approval_${gate}`,
    companyId,
    action: `agent_mission.${gate}`,
    status: "approved",
    reason: "approved",
    toolName: `agent_mission:amr_platform_runner:${gate}`,
    previewContent: `approved ${gate}`,
    createdAt: "2026-06-04T00:00:00.000Z",
    resolvedAt: "2026-06-04T00:01:00.000Z",
  } as Approval;
}

function failingSocialAdapter(platform: "x" | "tiktok", error: Error & { code?: string }): SocialPlatformAdapter {
  return {
    platform,
    capabilities: {
      posts: true,
      replies: true,
      dms: true,
      inbox: true,
      analytics: true,
      videoUpload: true,
      storiesReels: true,
      communityPosts: true,
      moderationActions: true,
    },
    createPostDraft: async () => ({ platform, externalDraftId: "draft_unused", status: "draft" }),
    publishPost: async () => { throw error; },
    reply: async () => { throw error; },
    sendDm: async () => { throw error; },
    fetchInbox: async () => ({ platform, messages: [], status: "sandbox" }),
    fetchAnalytics: async () => ({
      platform,
      impressions: 0,
      engagements: 0,
      clicks: 0,
      followersDelta: 0,
      videoViews: 0,
    }),
    deleteOrHideContent: async () => ({ platform, externalContentId: "hidden_unused", action: "hide", status: "sandbox" }),
  };
}

function failingMarketingAdapter(error: Error & { code?: string }): MarketingPlatformAdapter {
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
    createCampaignDraft: async () => { throw error; },
    createAdSet: async () => { throw error; },
    createCreative: async () => { throw error; },
    ensureConversionSource: async () => ({ platform: "meta", externalConversionSourceId: "pixel_unused", status: "sandbox" }),
    sendConversionEvent: async () => ({ platform: "meta", eventId: "event_unused", delivered: false, status: "sandbox" }),
    fetchInsights: async () => ({ platform: "meta", impressions: 0, clicks: 0, spendCents: 0, conversions: 0 }),
    pauseCampaign: async () => ({ platform: "meta", externalCampaignId: "campaign_unused", status: "sandbox" }),
    setBudget: async () => ({ platform: "meta", externalCampaignId: "campaign_unused", status: "sandbox" }),
  };
}
