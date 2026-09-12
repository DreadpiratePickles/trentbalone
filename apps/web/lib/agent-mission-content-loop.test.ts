import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAgentMissionForApproval } from "@/lib/agent-mission-approval-hook";
import { runAgentMission } from "@/lib/agent-mission-runtime";
import { saveCreativeConnection } from "@/lib/creative-connections";
import { saveMarketingPlatformConnection, saveSocialPlatformConnection } from "@/lib/platform-connections";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

describe("agent mission content growth loops", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("persists viral trend, analytics feedback, publishing schedule, and approval dashboard evidence", async () => {
    const company = await store.createCompany({ name: `MissionLoops ${makeId("co")}`, brief: { vision: "test" } });
    const { account: socialAccount } = await saveSocialPlatformConnection(company.id, {
      platform: "tiktok",
      accessToken: "tiktok_token_123456789",
      externalAccountId: "acct_tiktok",
      autoPublishEnabled: true,
    });
    const { account: marketingAccount } = await saveMarketingPlatformConnection(company.id, {
      platform: "meta",
      accessToken: "meta_token_123456789",
      externalAccountId: "act_meta",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Research the market for viral ideas, make content, schedule and publish to TikTok, reply to buyer DMs, launch Meta ads, and report to CEO.",
      trigger: "command",
      budgetCents: 7500,
    });

    const storageKeys = result.artifacts.map((artifact) => artifact.storageKey);
    const trendArtifact = result.artifacts.find((artifact) =>
      artifact.storageKey === `agent-missions/${result.run.id}/loops/viral-trend-research.md`
    );
    expect(storageKeys).toEqual(expect.arrayContaining([
      `agent-missions/${result.run.id}/loops/viral-trend-research.md`,
      `agent-missions/${result.run.id}/loops/analytics-feedback.md`,
      `agent-missions/${result.run.id}/loops/publishing-schedule.md`,
      `agent-missions/${result.run.id}/loops/human-approval-dashboard.md`,
    ]));
    expect(trendArtifact?.summary).toContain("sourced trend signals");
    expect(trendArtifact?.content).toContain("## Sourced Signals");
    expect(trendArtifact?.content).toContain("https://trends.local/");
    expect(trendArtifact?.content).toContain("## Recommended Content Angles");
    expect(result.finalSummary).toContain("Viral trend research loop");
    expect(result.finalSummary).toContain("Analytics feedback loop");
    expect(result.finalSummary).toContain("Publishing schedule");
    expect(result.finalSummary).toContain("Human approval dashboard");
    expect(result.finalSummary).toContain("Meta");

    const trendMemory = (await store.listDocuments(company.id)).find((document) =>
      document.source === `agent-mission-trend-research:${result.run.id}`
    );
    expect(trendMemory).toEqual(expect.objectContaining({
      memoryTier: "semantic",
      type: "research",
      title: expect.stringContaining("Viral trend research"),
    }));
    expect(trendMemory?.content).toContain("Sourced Signals");

    const events = await store.listAgentMissionEvents(result.run.id);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "viral_trend_research_ready",
      "analytics_feedback_ready",
      "publishing_schedule_ready",
      "approval_dashboard_ready",
    ]));

    const scheduledPosts = (await store.listSocialPosts(company.id)).filter((post) =>
      post.metadata.runId === result.run.id && post.metadata.kind === "mission_schedule",
    );
    const publishApproval = result.approvals.find((approval) => approval.action === "agent_mission.public_publish");
    expect(publishApproval).toBeDefined();
    expect(scheduledPosts).toEqual([
      expect.objectContaining({
        socialAccountId: socialAccount.id,
        platform: "tiktok",
        status: "scheduled",
        scheduledFor: expect.any(String),
        approvalId: publishApproval?.id,
      }),
    ]);

    const snapshots = await store.listSocialAnalyticsSnapshots(company.id);
    expect(snapshots).toEqual([
      expect.objectContaining({
        socialAccountId: socialAccount.id,
        platform: "tiktok",
        report: expect.objectContaining({
          runId: result.run.id,
          loop: "content_analytics_feedback",
        }),
      }),
    ]);
    await expect(store.getOptimizationRun(marketingAccount.id, result.run.startedAt.slice(0, 10)))
      .resolves.toEqual(expect.objectContaining({
        companyId: company.id,
        marketingAccountId: marketingAccount.id,
        status: "planned",
        decisions: expect.arrayContaining([
          expect.objectContaining({ action: "monitor_meta_ads" }),
        ]),
      }));
  });

  it("submits connected Higgsfield creative generation and keeps other creative apps review-only", async () => {
    vi.stubEnv("HIGGSFIELD_GENERATION_MODE", "live");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      job_id: "hf_job_live_1",
      status: "processing",
      video_url: "https://cdn.higgsfield.test/live.mp4",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const company = await store.createCompany({ name: `MissionCreativeAssets ${makeId("co")}`, brief: { vision: "test" } });
    await saveSocialPlatformConnection(company.id, {
      platform: "tiktok",
      accessToken: "tiktok_creative_token_123456789",
      externalAccountId: "acct_tiktok_creative",
      autoPublishEnabled: true,
    });
    await saveCreativeConnection(company.id, { app: "higgsfield", apiKey: "higgs_live_123456789" });
    await saveCreativeConnection(company.id, { app: "hyperframes", apiKey: "hyper_live_123456789" });
    await saveCreativeConnection(company.id, { app: "open_generative_ai", apiKey: "open_gen_live_123456789" });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Create Higgsfield videos, HyperFrames launch motion, Open Generative AI campaign assets, and publish the video to TikTok for a viral launch.",
      trigger: "command",
      budgetCents: 7500,
    });

    expect(result.platformReadiness.blockers).not.toContain("higgsfield creative credentials are missing");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/video/generate"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer higgs_live_123456789",
          "Content-Type": "application/json",
        }),
      }),
    );
    const creativeArtifacts = result.artifacts.filter((artifact) => artifact.storageKey?.includes("/creative/"));
    expect(creativeArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Higgsfield generated creative asset",
        storageKey: `agent-missions/${result.run.id}/creative/higgsfield-asset.md`,
        createdByAgent: "growth",
        status: "ready",
      }),
      expect.objectContaining({
        title: "HyperFrames sandbox creative asset",
        storageKey: `agent-missions/${result.run.id}/creative/hyperframes-asset.md`,
        createdByAgent: "growth",
        status: "ready",
      }),
      expect.objectContaining({
        title: "Open Generative AI sandbox creative asset",
        storageKey: `agent-missions/${result.run.id}/creative/open-generative-ai-asset.md`,
        createdByAgent: "growth",
        status: "ready",
      }),
    ]));
    const higgsfieldArtifact = creativeArtifacts.find((artifact) => artifact.storageKey?.includes("higgsfield-asset.md"));
    expect(higgsfieldArtifact?.content).toContain("Provider job: hf_job_live_1");
    expect(higgsfieldArtifact?.content).toContain("Status: processing");
    expect(higgsfieldArtifact?.content).toContain("Video URL: https://cdn.higgsfield.test/live.mp4");
    const scheduledPosts = (await store.listSocialPosts(company.id)).filter((post) =>
      post.metadata.runId === result.run.id && post.metadata.kind === "mission_schedule"
    );
    expect(scheduledPosts).toEqual([
      expect.objectContaining({
        platform: "tiktok",
        status: "scheduled",
        mediaUrls: ["https://cdn.higgsfield.test/live.mp4"],
        metadata: expect.objectContaining({
          creativeAssetSource: "higgsfield",
          creativeAssetUrl: "https://cdn.higgsfield.test/live.mp4",
        }),
      }),
    ]);
    const publishApproval = result.approvals.find((approval) => approval.action === "agent_mission.public_publish");
    const resolvedApproval = await store.resolveApproval(publishApproval?.id ?? "missing", "approved");
    expect(resolvedApproval).toBeDefined();
    await syncAgentMissionForApproval(resolvedApproval!);
    const providerActions = (await store.listJobRuns(company.id)).filter((job) =>
      job.type === "platform_action" && job.metadata.runId === result.run.id
    );
    expect(providerActions).toEqual([
      expect.objectContaining({
        status: "completed",
        metadata: expect.objectContaining({
          action: "social.publish",
          payload: expect.objectContaining({
            mediaUrls: ["https://cdn.higgsfield.test/live.mp4"],
          }),
        }),
      }),
    ]);
    expect(creativeArtifacts.map((artifact) => artifact.content).join("\n")).toContain("No public upload, post, ad launch, or external publish happened.");
    expect(result.finalSummary).toContain("Creative Assets");
    expect(result.finalSummary).toContain("Higgsfield generated creative asset");
    expect(result.finalSummary).toContain("HyperFrames sandbox creative asset");
    expect(result.finalSummary).toContain("Open Generative AI sandbox creative asset");

    const events = await store.listAgentMissionEvents(result.run.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "creative_asset_ready",
        payload: expect.objectContaining({
          app: "higgsfield",
          providerJobId: "hf_job_live_1",
          status: "processing",
          videoUrl: "https://cdn.higgsfield.test/live.mp4",
        }),
      }),
      expect.objectContaining({
        kind: "creative_asset_ready",
        payload: expect.objectContaining({ app: "hyperframes" }),
      }),
      expect.objectContaining({
        kind: "creative_asset_ready",
        payload: expect.objectContaining({ app: "open_generative_ai" }),
      }),
    ]));
  });

  it("creates approval-gated engagement and sales outreach drafts before external sends", async () => {
    const company = await store.createCompany({ name: `MissionEngagementDrafts ${makeId("co")}`, brief: { vision: "test" } });
    await saveSocialPlatformConnection(company.id, {
      platform: "linkedin",
      accessToken: "linkedin_token_123456789",
      externalAccountId: "acct_linkedin",
      autoPublishEnabled: true,
    });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Reply to comments, keep up with DMs, qualify buyer leads, and send sales outreach on LinkedIn.",
      trigger: "command",
      budgetCents: 7500,
    });

    const drafts = await store.listSocialOutreachDrafts(company.id);
    const replyApproval = result.approvals.find((approval) => approval.action === "agent_mission.comment_or_dm_reply");
    const salesApproval = result.approvals.find((approval) => approval.action === "agent_mission.email_or_sales_send");
    expect(replyApproval).toBeDefined();
    expect(salesApproval).toBeDefined();
    const missionContact = (await store.listSocialContacts(company.id)).find((contact) =>
      contact.externalContactId === `agent-mission-${result.run.id}`
    );
    expect(missionContact).toEqual(expect.objectContaining({
      platform: "linkedin",
      displayName: "AgentMission engagement target",
    }));
    expect(drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contactId: missionContact?.id,
        platform: "linkedin",
        purpose: "comment_or_dm_reply",
        status: "pending_approval",
        approvalId: replyApproval?.id,
        riskFlags: expect.arrayContaining([`agent_mission:${result.run.id}`]),
      }),
      expect.objectContaining({
        contactId: missionContact?.id,
        platform: "linkedin",
        purpose: "email_or_sales_send",
        status: "pending_approval",
        approvalId: salesApproval?.id,
        riskFlags: expect.arrayContaining([`agent_mission:${result.run.id}`]),
      }),
    ]));
    expect(drafts.map((draft) => draft.message).join("\n")).toContain("requires approval");
    expect(result.finalSummary).toContain("Engagement Draft Queue");

    const events = await store.listAgentMissionEvents(result.run.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "engagement_draft_ready",
        payload: expect.objectContaining({ purpose: "comment_or_dm_reply" }),
      }),
      expect.objectContaining({
        kind: "sales_outreach_draft_ready",
        payload: expect.objectContaining({ purpose: "email_or_sales_send" }),
      }),
    ]));
  });

  it("ingests connected inbox messages during comment and DM missions", async () => {
    vi.stubEnv("SOCIAL_INBOX_INGESTION_MODE", "live");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          id: "tweet_1",
          text: "Can Trent publish clips and reply to comments for us?",
          author_id: "buyer_ops",
          conversation_id: "thread_1",
          created_at: "2026-06-06T12:00:00.000Z",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const company = await store.createCompany({ name: `MissionInboxIngestion ${makeId("co")}`, brief: { vision: "test" } });
    await saveSocialPlatformConnection(company.id, {
      platform: "x",
      accessToken: "x_token_123456789",
      externalAccountId: "user_1",
      autoPublishEnabled: true,
    });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Reply to comments, keep up with DMs and mentions on X, and report to CEO.",
      trigger: "command",
      budgetCents: 7500,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://api.x.com/2/users/user_1/mentions"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer x_token_123456789" }),
      }),
    );
    const conversations = await store.listSocialConversations(company.id);
    expect(conversations).toEqual([
      expect.objectContaining({
        platform: "x",
        externalThreadId: "thread_1",
      }),
    ]);
    const messages = await store.listSocialMessagesForConversation(company.id, conversations[0].id);
    expect(messages).toEqual([
      expect.objectContaining({
        direction: "inbound",
        kind: "mention",
        content: "Can Trent publish clips and reply to comments for us?",
        externalMessageId: "tweet_1",
      }),
    ]);
    const drafts = await store.listSocialOutreachDrafts(company.id);
    expect(drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: "x",
        purpose: "comment_or_dm_reply",
        status: "pending_approval",
        riskFlags: expect.arrayContaining([`agent_mission:${result.run.id}`]),
      }),
    ]));
    const replyDraft = drafts.find((draft) => draft.purpose === "comment_or_dm_reply");
    expect(replyDraft).toBeDefined();
    await expect(store.getSocialContact(company.id, replyDraft?.contactId ?? "missing"))
      .resolves.toEqual(expect.objectContaining({
        platform: "x",
        externalContactId: "buyer_ops",
      }));
    expect(replyDraft?.message).toContain("Can Trent publish clips and reply to comments for us?");
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Inbox ingestion loop",
        storageKey: `agent-missions/${result.run.id}/loops/inbox-ingestion.md`,
        createdByAgent: "support",
      }),
    ]));
    expect(result.finalSummary).toContain("Inbox ingestion loop");

    const events = await store.listAgentMissionEvents(result.run.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "social_inbox_ingested",
        payload: expect.objectContaining({
          platform: "x",
          fetchedMessages: 1,
          importedMessages: 1,
        }),
      }),
      expect.objectContaining({
        kind: "inbox_ingestion_ready",
        payload: expect.objectContaining({
          accountCount: 1,
          importedMessages: 1,
          fetchedMessages: 1,
        }),
      }),
    ]));
  });

  it("loads prior analytics and ad optimization feedback into the next mission report", async () => {
    const company = await store.createCompany({ name: `MissionAnalyticsRecall ${makeId("co")}`, brief: { vision: "test" } });
    const { account: socialAccount } = await saveSocialPlatformConnection(company.id, {
      platform: "instagram",
      accessToken: "instagram_token_123456789",
      externalAccountId: "acct_instagram",
      autoPublishEnabled: true,
    });
    const { account: marketingAccount } = await saveMarketingPlatformConnection(company.id, {
      platform: "meta",
      accessToken: "meta_token_123456789",
      externalAccountId: "act_meta_recall",
      dailyBudgetCents: 3000,
      paymentStatus: "ready",
    });
    await store.upsertSocialAnalyticsSnapshot({
      companyId: company.id,
      socialAccountId: socialAccount.id,
      platform: "instagram",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-06-02T00:00:00.000Z",
      metrics: { impressions: 12000, engagements: 1440, clicks: 240, replies: 32, saves: 310 },
      report: {
        topFormat: "founder teardown reel",
        winningHook: "I rebuilt our AI workflow in public",
        recommendation: "Make the next video a before/after workflow teardown.",
      },
    });
    await store.createOptimizationRun({
      companyId: company.id,
      marketingAccountId: marketingAccount.id,
      runDate: "2026-06-02",
      status: "completed",
      inputMetrics: { platform: "meta", ctr: 0.032, cpaCents: 1800 },
      decisions: [
        { action: "scale_winner", reason: "CTR above target" },
        { action: "refresh_creative", reason: "second variant fatigued" },
      ],
    });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Research viral Instagram ideas, make content, publish after approval, and launch Meta ads.",
      trigger: "command",
      budgetCents: 7500,
    });

    const events = await store.listAgentMissionEvents(result.run.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "analytics_context_loaded",
        payload: expect.objectContaining({
          socialSnapshotCount: 1,
          adOptimizationRunCount: 1,
          recommendations: expect.arrayContaining([
            "Make the next video a before/after workflow teardown.",
          ]),
        }),
      }),
    ]));
    expect(result.finalSummary).toContain("## Prior Analytics Feedback");
    expect(result.finalSummary).toContain("Instagram");
    expect(result.finalSummary).toContain("founder teardown reel");
    expect(result.finalSummary).toContain("scale_winner");
    expect(result.finalSummary).toContain("refresh_creative");
  });
});
