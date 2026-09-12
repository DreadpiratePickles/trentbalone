import { describe, expect, it } from "vitest";
import { executeApprovedAgentMissionAction } from "@/lib/agent-mission-executor";
import { store } from "@/lib/store";
import type { AgentMissionRun, Approval } from "@/lib/types";

describe("executeApprovedAgentMissionAction", () => {
  it("creates a queued social post record after public publish approval", async () => {
    await store.upsertSocialAccount({
      companyId: "co_exec",
      platform: "tiktok",
      externalAccountId: "acct_tiktok",
      scopes: ["post:write"],
      credentialsRef: "cred_tiktok",
      autoPublishEnabled: true,
    });
    const result = await executeApprovedAgentMissionAction({
      run: run("Publish to TikTok."),
      approval: approval("public_publish"),
      gate: "public_publish",
    });

    expect(result.status).toBe("executed");
    expect(result.externalRef).toMatch(/^socpost_/);
    expect(result.artifactContent).toContain("social_post");
    expect(await store.listSocialPosts("co_exec")).toEqual([
      expect.objectContaining({
        platform: "tiktok",
        status: "queued",
        approvalId: "approval_public_publish",
      }),
    ]);
    expect(await store.listJobRuns("co_exec")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "platform_action",
        status: "running",
        summary: "Queued platform action: social.publish tiktok",
        metadata: expect.objectContaining({
          kind: "agent_mission_platform_action",
          action: "social.publish",
          runId: "amr_exec",
          approvalId: "approval_public_publish",
          gate: "public_publish",
          platform: "tiktok",
          provider: "Social:TikTok",
          targetId: result.externalRef,
          payload: expect.objectContaining({
            content: "approved public_publish",
            postId: result.externalRef,
          }),
        }),
      }),
    ]));
  });

  it("queues the existing scheduled mission post instead of creating a duplicate", async () => {
    const runWithDraft = run("Publish to TikTok.", "co_exec_existing", "amr_exec_existing");
    const linkedApproval = approval("public_publish", runWithDraft.companyId, runWithDraft.id);
    const account = await store.upsertSocialAccount({
      companyId: runWithDraft.companyId,
      platform: "tiktok",
      externalAccountId: "acct_tiktok_existing",
      scopes: ["post:write"],
      credentialsRef: "cred_tiktok_existing",
      autoPublishEnabled: true,
    });
    const draftPost = await store.createSocialPost({
      companyId: runWithDraft.companyId,
      socialAccountId: account.id,
      platform: "tiktok",
      status: "scheduled",
      content: "Scheduled draft content",
      mediaUrls: [],
      scheduledFor: "2026-06-06T00:00:00.000Z",
      approvalId: linkedApproval.id,
      metadata: {
        runId: runWithDraft.id,
        kind: "mission_schedule",
        approvalGate: "public_publish",
      },
    });

    const result = await executeApprovedAgentMissionAction({
      run: runWithDraft,
      approval: linkedApproval,
      gate: "public_publish",
    });

    const posts = await store.listSocialPosts(runWithDraft.companyId);
    expect(result.status).toBe("executed");
    expect(result.externalRef).toBe(draftPost.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual(expect.objectContaining({
      id: draftPost.id,
      platform: "tiktok",
      status: "queued",
      approvalId: linkedApproval.id,
      content: "approved public_publish",
      metadata: expect.objectContaining({
        runId: runWithDraft.id,
        kind: "mission_schedule",
        approvalGate: "public_publish",
      }),
    }));
    expect(await store.listJobRuns(runWithDraft.companyId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "platform_action",
        metadata: expect.objectContaining({
          action: "social.publish",
          targetId: draftPost.id,
          payload: expect.objectContaining({ postId: draftPost.id }),
        }),
      }),
    ]));
  });

  it("reuses an existing provider action when the same publish approval is executed twice", async () => {
    const runWithReplay = run("Publish to TikTok.", "co_exec_replay", "amr_exec_replay");
    const linkedApproval = approval("public_publish", runWithReplay.companyId, runWithReplay.id);
    await store.upsertSocialAccount({
      companyId: runWithReplay.companyId,
      platform: "tiktok",
      externalAccountId: "acct_tiktok_replay",
      scopes: ["post:write"],
      credentialsRef: "cred_tiktok_replay",
      autoPublishEnabled: true,
    });

    const first = await executeApprovedAgentMissionAction({
      run: runWithReplay,
      approval: linkedApproval,
      gate: "public_publish",
    });
    const second = await executeApprovedAgentMissionAction({
      run: runWithReplay,
      approval: linkedApproval,
      gate: "public_publish",
    });

    const jobs = await store.listJobRuns(runWithReplay.companyId);
    expect(first.status).toBe("executed");
    expect(second.status).toBe("executed");
    expect(second.externalRef).toBe(first.externalRef);
    expect(jobs.filter((job) =>
      job.type === "platform_action"
      && job.metadata.runId === runWithReplay.id
      && job.metadata.approvalId === linkedApproval.id
      && job.metadata.targetId === first.externalRef
    )).toHaveLength(1);
    expect(second.providerActionId).toBe(first.providerActionId);
  });

  it("creates a draft ad campaign record after paid spend approval", async () => {
    await store.upsertMarketingAccount({
      companyId: "co_exec",
      platform: "meta",
      externalAccountId: "act_meta",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });
    const result = await executeApprovedAgentMissionAction({
      run: run("Run Meta ads."),
      approval: approval("paid_spend_or_boost"),
      gate: "paid_spend_or_boost",
    });

    const campaigns = await store.listAdCampaigns("co_exec");
    expect(result.status).toBe("executed");
    expect(result.externalRef).toBe(campaigns[0]?.id);
    expect(result.artifactContent).toContain("ad_campaign");
    expect(campaigns).toEqual([
      expect.objectContaining({
        platform: "meta",
        status: "draft",
        approvalId: "approval_paid_spend_or_boost",
      }),
    ]);
    expect(await store.listJobRuns("co_exec")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "platform_action",
        status: "running",
        summary: "Queued platform action: ads.launch meta",
        metadata: expect.objectContaining({
          kind: "agent_mission_platform_action",
          action: "ads.launch",
          runId: "amr_exec",
          approvalId: "approval_paid_spend_or_boost",
          gate: "paid_spend_or_boost",
          platform: "meta",
          provider: "Ads:Meta",
          targetId: result.externalRef,
          payload: expect.objectContaining({
            campaignId: result.externalRef,
            objective: "Run Meta ads.",
            dailyBudgetCents: 2500,
          }),
        }),
      }),
    ]));
  });

  it("reuses an existing draft ad campaign for repeated paid spend approval execution", async () => {
    const runWithCampaign = run("Run Meta ads.", "co_exec_ads_existing", "amr_exec_ads_existing");
    const linkedApproval = approval("paid_spend_or_boost", runWithCampaign.companyId, runWithCampaign.id);
    const account = await store.upsertMarketingAccount({
      companyId: runWithCampaign.companyId,
      platform: "meta",
      externalAccountId: "act_meta_existing",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });
    const existingCampaign = await store.createAdCampaign({
      companyId: runWithCampaign.companyId,
      marketingAccountId: account.id,
      platform: "meta",
      name: `AgentMission ${runWithCampaign.id}`,
      objective: runWithCampaign.objective,
      status: "draft",
      dailyBudgetCents: 2000,
      approvalId: linkedApproval.id,
    });

    const result = await executeApprovedAgentMissionAction({
      run: runWithCampaign,
      approval: linkedApproval,
      gate: "paid_spend_or_boost",
    });

    const campaigns = await store.listAdCampaigns(runWithCampaign.companyId);
    expect(result.status).toBe("executed");
    expect(result.externalRef).toBe(existingCampaign.id);
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]).toEqual(expect.objectContaining({
      id: existingCampaign.id,
      platform: "meta",
      status: "draft",
      approvalId: linkedApproval.id,
      dailyBudgetCents: 2000,
    }));
    expect(await store.listJobRuns(runWithCampaign.companyId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "platform_action",
        metadata: expect.objectContaining({
          action: "ads.launch",
          targetId: existingCampaign.id,
          payload: expect.objectContaining({ campaignId: existingCampaign.id }),
        }),
      }),
    ]));
  });

  it("does not mark platform auth gaps as sent external actions", async () => {
    const result = await executeApprovedAgentMissionAction({
      run: run("Create Higgsfield videos."),
      approval: approval("platform_auth_or_scope_gap"),
      gate: "platform_auth_or_scope_gap",
    });

    expect(result.status).toBe("blocked");
    expect(result.externalRef).toBeUndefined();
    expect(result.artifactStatus).toBe("failed");
    expect(result.artifactContent).toContain("credentials or scopes are still missing");
  });
});

function run(objective: string, companyId = "co_exec", id = "amr_exec"): AgentMissionRun {
  return {
    id,
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

function approval(gate: string, companyId = "co_exec", runId = "amr_exec"): Approval {
  return {
    id: `approval_${gate}`,
    companyId,
    action: `agent_mission.${gate}`,
    status: "approved",
    reason: "approved",
    toolName: `agent_mission:${runId}:${gate}`,
    previewContent: `approved ${gate}`,
    createdAt: "2026-06-04T00:00:00.000Z",
    resolvedAt: "2026-06-04T00:01:00.000Z",
  } as Approval;
}
