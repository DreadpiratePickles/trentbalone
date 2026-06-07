import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { runAgentMission } from "@/lib/agent-mission-runtime";
import {
  parseAgentMissionApprovalRef,
  syncAgentMissionForApproval,
} from "@/lib/agent-mission-approval-hook";
import { saveMarketingPlatformConnection, saveSocialPlatformConnection } from "@/lib/platform-connections";
import { makeId } from "@/lib/utils";
import type { Approval } from "@/lib/types";

describe("parseAgentMissionApprovalRef", () => {
  it("extracts run id and gate from agent mission approval toolName", () => {
    expect(parseAgentMissionApprovalRef({
      toolName: "agent_mission:amr_123:public_publish",
    } as Approval)).toEqual({ runId: "amr_123", gate: "public_publish" });
  });

  it("returns undefined for unrelated approvals", () => {
    expect(parseAgentMissionApprovalRef({ toolName: "content_mission:orc_1:action_public_publish" } as Approval)).toBeUndefined();
    expect(parseAgentMissionApprovalRef({ toolName: "agent_mission.public_publish" } as Approval)).toBeUndefined();
    expect(parseAgentMissionApprovalRef({} as Approval)).toBeUndefined();
  });
});

async function connectTikTok(companyId: string, suffix = "default") {
  return saveSocialPlatformConnection(companyId, {
    platform: "tiktok",
    accessToken: `tiktok_token_${suffix}_123456789`,
    externalAccountId: `acct_tiktok_${suffix}`,
    scopes: ["post:write"],
    autoPublishEnabled: true,
  });
}

async function connectLinkedIn(companyId: string) {
  return saveSocialPlatformConnection(companyId, {
    platform: "linkedin",
    accessToken: "linkedin_token_123456789",
    externalAccountId: "acct_linkedin",
    scopes: ["post:write"],
    autoPublishEnabled: true,
  });
}

describe("syncAgentMissionForApproval", () => {
  it("records approved external action evidence and completes the run after all approvals resolve", async () => {
    const company = await store.createCompany({ name: `AgentMissionHook ${makeId("co")}`, brief: { vision: "test" } });
    await connectTikTok(company.id);
    await saveMarketingPlatformConnection(company.id, {
      platform: "meta",
      accessToken: "meta_token_123456789",
      externalAccountId: "act_meta",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok, reply to DMs, route leads to sales, and run Meta ads.",
      trigger: "command",
    });
    const approvals = await store.listApprovals(company.id);
    const missionApprovals = approvals.filter((approval) => approval.toolName?.startsWith(`agent_mission:${mission.run.id}:`));
    expect(missionApprovals.map((approval) => approval.toolName)).toEqual(expect.arrayContaining([
      `agent_mission:${mission.run.id}:public_publish`,
      `agent_mission:${mission.run.id}:comment_or_dm_reply`,
      `agent_mission:${mission.run.id}:email_or_sales_send`,
      `agent_mission:${mission.run.id}:paid_spend_or_boost`,
    ]));
    expect(missionApprovals).toHaveLength(4);

    const first = await store.resolveApproval(missionApprovals[0].id, "approved");
    const partial = await syncAgentMissionForApproval(first!);
    expect(partial?.status).toBe("awaiting_approval");
    let events = await store.listAgentMissionEvents(mission.run.id);
    expect(events.some((event) => event.kind === "approval_resolved" && event.payload.approvalId === first!.id)).toBe(true);
    let artifacts = await store.listArtifacts(company.id);
    expect(artifacts.some((artifact) =>
      artifact.storageKey === `agent-missions/${mission.run.id}/approvals/${first!.id}.md`
      && artifact.status === "sent"
    )).toBe(true);

    for (const approval of missionApprovals.slice(1)) {
      const resolved = await store.resolveApproval(approval.id, "approved");
      await syncAgentMissionForApproval(resolved!);
    }
    const completed = await store.getAgentMissionRun(mission.run.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeTruthy();
  });

  it("executes an approved publish provider action through the sandbox runner", async () => {
    const company = await store.createCompany({ name: `AgentMissionPublishRunner ${makeId("co")}`, brief: { vision: "test" } });
    await connectTikTok(company.id);
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName === `agent_mission:${mission.run.id}:public_publish`)!;

    const resolved = await store.resolveApproval(approval.id, "approved");
    await syncAgentMissionForApproval(resolved!);

    const providerActions = (await store.listJobRuns(company.id)).filter((job) =>
      job.type === "platform_action"
      && job.metadata.kind === "agent_mission_platform_action"
      && job.metadata.runId === mission.run.id
    );
    expect(providerActions).toEqual([
      expect.objectContaining({
        status: "completed",
        resultCount: 1,
        metadata: expect.objectContaining({
          action: "social.publish",
          result: expect.objectContaining({
            externalRef: expect.stringContaining("sandbox_tiktok_post"),
            status: "published",
          }),
        }),
      }),
    ]);
    const publishedPosts = (await store.listSocialPosts(company.id)).filter((post) => post.status === "published");
    expect(publishedPosts).toEqual([
      expect.objectContaining({
        status: "published",
        externalPostId: expect.stringContaining("sandbox_tiktok_post"),
        metadata: expect.objectContaining({
          providerAction: expect.objectContaining({ jobRunId: providerActions[0].id }),
        }),
      }),
    ]);
    const events = await store.listAgentMissionEvents(mission.run.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "provider_action_executed",
        payload: expect.objectContaining({
          approvalId: approval.id,
          gate: "public_publish",
          status: "completed",
          externalRef: expect.stringContaining("sandbox_tiktok_post"),
        }),
      }),
    ]));
  });

  it("does not append duplicate provider execution events when approval sync is replayed", async () => {
    const company = await store.createCompany({ name: `AgentMissionPublishReplay ${makeId("co")}`, brief: { vision: "test" } });
    await connectTikTok(company.id);
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName === `agent_mission:${mission.run.id}:public_publish`)!;

    const resolved = await store.resolveApproval(approval.id, "approved");
    await syncAgentMissionForApproval(resolved!);
    await syncAgentMissionForApproval(resolved!);

    const events = (await store.listAgentMissionEvents(mission.run.id)).filter((event) =>
      event.kind === "provider_action_executed" && event.payload.approvalId === approval.id
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual(expect.objectContaining({
      status: "completed",
      externalRef: expect.stringContaining("sandbox_tiktok_post"),
    }));
  });

  it("does not duplicate the completed approval summary when approval sync is replayed", async () => {
    const company = await store.createCompany({ name: `AgentMissionSummaryReplay ${makeId("co")}`, brief: { vision: "test" } });
    await connectTikTok(company.id);
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName === `agent_mission:${mission.run.id}:public_publish`)!;

    const resolved = await store.resolveApproval(approval.id, "approved");
    await syncAgentMissionForApproval(resolved!);
    await syncAgentMissionForApproval(resolved!);

    const run = await store.getAgentMissionRun(mission.run.id);
    const marker = "All AgentMission approval-gated external actions were approved and recorded.";
    expect(run?.status).toBe("completed");
    expect(run?.finalSummary?.split(marker)).toHaveLength(2);
  });

  it("queues content performance feedback once when all approvals complete", async () => {
    const company = await store.createCompany({ name: `AgentMissionFeedbackQueue ${makeId("co")}`, brief: { vision: "test" } });
    await connectTikTok(company.id);
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName === `agent_mission:${mission.run.id}:public_publish`)!;

    const resolved = await store.resolveApproval(approval.id, "approved");
    await syncAgentMissionForApproval(resolved!);
    await syncAgentMissionForApproval(resolved!);

    const feedbackJobs = (await store.listJobRuns(company.id)).filter((job) =>
      job.type === "content_performance_ingest"
      && job.metadata.kind === "content_performance_feedback"
      && job.metadata.missionRunId === mission.run.id
    );
    expect(feedbackJobs).toHaveLength(1);
    expect(feedbackJobs[0]).toEqual(expect.objectContaining({
      status: "running",
      trigger: "system",
      summary: "Ingest content and ad performance feedback",
    }));

    const events = (await store.listAgentMissionEvents(mission.run.id)).filter((event) =>
      event.kind === "content_performance_feedback_queued"
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual(expect.objectContaining({
      jobRunId: feedbackJobs[0].id,
      missionRunId: mission.run.id,
    }));
  });

  it("adds executed provider action details to the completed CEO mission summary", async () => {
    const company = await store.createCompany({ name: `AgentMissionProviderSummary ${makeId("co")}`, brief: { vision: "test" } });
    await connectTikTok(company.id, "summary");
    await saveMarketingPlatformConnection(company.id, {
      platform: "meta",
      accessToken: "meta_summary_token_123456789",
      externalAccountId: "act_meta_summary",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok, reply to DMs, route leads to sales, and run Meta ads.",
      trigger: "command",
    });
    const missionApprovals = (await store.listApprovals(company.id)).filter((approval) =>
      approval.toolName?.startsWith(`agent_mission:${mission.run.id}:`)
    );

    for (const approval of missionApprovals) {
      const resolved = await store.resolveApproval(approval.id, "approved");
      await syncAgentMissionForApproval(resolved!);
    }

    const run = await store.getAgentMissionRun(mission.run.id);
    expect(run?.status).toBe("completed");
    expect(run?.finalSummary).toContain("## Executed External Actions");
    expect(run?.finalSummary).toContain("social.publish");
    expect(run?.finalSummary).toContain("social.reply");
    expect(run?.finalSummary).toContain("sales.outreach_send");
    expect(run?.finalSummary).toContain("ads.launch");
    expect(run?.finalSummary).toContain("Social:TikTok");
    expect(run?.finalSummary).toContain("Ads:Meta");
    expect(run?.finalSummary).toContain("sandbox_tiktok_post");
    expect(run?.finalSummary).toContain("sandbox_meta_campaign");

    const documents = await store.listDocuments(company.id);
    const memoryLog = documents.find((doc) => doc.source === `agent-mission:${mission.run.id}`);
    expect(memoryLog?.content).toContain("## Executed External Actions");
    expect(memoryLog?.content).toContain("provider_action_executed");
    expect(memoryLog?.content).toContain("sandbox_tiktok_post");
    expect(memoryLog?.content).toContain("sandbox_meta_campaign");

    const memoryArtifact = (await store.listArtifacts(company.id)).find((artifact) =>
      artifact.storageKey === `agent-missions/${mission.run.id}/memory-log.md`
    );
    expect(memoryArtifact?.content).toContain("## Executed External Actions");
    expect(memoryArtifact?.content).toContain("provider_action_executed");

    const events = await store.listAgentMissionEvents(mission.run.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "memory_ingested",
        payload: expect.objectContaining({
          refreshed: true,
          approvalId: expect.any(String),
          status: expect.stringMatching(/ingested|not_connected|error/),
        }),
      }),
    ]));
  });

  it("does not duplicate approval resolved or artifact trace events when approval sync is replayed", async () => {
    const company = await store.createCompany({ name: `AgentMissionTraceReplay ${makeId("co")}`, brief: { vision: "test" } });
    await connectTikTok(company.id);
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName === `agent_mission:${mission.run.id}:public_publish`)!;

    const resolved = await store.resolveApproval(approval.id, "approved");
    await syncAgentMissionForApproval(resolved!);
    await syncAgentMissionForApproval(resolved!);

    const events = await store.listAgentMissionEvents(mission.run.id);
    expect(events.filter((event) =>
      event.kind === "approval_resolved" && event.payload.approvalId === approval.id
    )).toHaveLength(1);
    expect(events.filter((event) =>
      event.kind === "artifact_created" && event.payload.approvalId === approval.id
    )).toHaveLength(1);
  });

  it("executes an approved Meta spend provider action and records the external campaign id", async () => {
    const company = await store.createCompany({ name: `AgentMissionMetaRunner ${makeId("co")}`, brief: { vision: "test" } });
    await saveMarketingPlatformConnection(company.id, {
      platform: "meta",
      accessToken: "meta_token_123456789",
      externalAccountId: "act_meta",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Run Meta ads.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName === `agent_mission:${mission.run.id}:paid_spend_or_boost`)!;

    const resolved = await store.resolveApproval(approval.id, "approved");
    await syncAgentMissionForApproval(resolved!);

    const providerActions = (await store.listJobRuns(company.id)).filter((job) =>
      job.type === "platform_action"
      && job.metadata.kind === "agent_mission_platform_action"
      && job.metadata.runId === mission.run.id
    );
    expect(providerActions).toEqual([
      expect.objectContaining({
        status: "completed",
        resultCount: 1,
        metadata: expect.objectContaining({
          action: "ads.launch",
          provider: "Ads:Meta",
          result: expect.objectContaining({
            externalRef: expect.stringContaining("sandbox_meta_campaign"),
            status: "draft",
          }),
        }),
      }),
    ]);
    expect(await store.listAdCampaigns(company.id)).toEqual([
      expect.objectContaining({
        platform: "meta",
        status: "draft",
        externalCampaignId: expect.stringContaining("sandbox_meta_campaign"),
      }),
    ]);
  });

  it("executes approved reply and sales outreach provider actions", async () => {
    const company = await store.createCompany({ name: `AgentMissionOutboundRunner ${makeId("co")}`, brief: { vision: "test" } });
    await connectLinkedIn(company.id);
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Reply to comments, handle DMs, route leads, and send sales outreach on LinkedIn.",
      trigger: "command",
    });
    const approvals = (await store.listApprovals(company.id)).filter((approval) =>
      approval.toolName?.startsWith(`agent_mission:${mission.run.id}:`)
      && (approval.toolName.endsWith(":comment_or_dm_reply") || approval.toolName.endsWith(":email_or_sales_send"))
    );
    expect(approvals.map((approval) => approval.toolName)).toEqual(expect.arrayContaining([
      `agent_mission:${mission.run.id}:comment_or_dm_reply`,
      `agent_mission:${mission.run.id}:email_or_sales_send`,
    ]));
    const missionContact = (await store.listSocialContacts(company.id)).find((contact) =>
      contact.externalContactId === `agent-mission-${mission.run.id}`
    );
    expect(missionContact).toEqual(expect.objectContaining({
      platform: "linkedin",
      displayName: "AgentMission engagement target",
    }));
    expect(await store.listSocialOutreachDrafts(company.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        contactId: missionContact?.id,
        purpose: "comment_or_dm_reply",
        riskFlags: expect.arrayContaining([`agent_mission:${mission.run.id}`]),
        status: "pending_approval",
      }),
      expect.objectContaining({
        contactId: missionContact?.id,
        purpose: "email_or_sales_send",
        riskFlags: expect.arrayContaining([`agent_mission:${mission.run.id}`]),
        status: "pending_approval",
      }),
    ]));

    for (const approval of approvals) {
      const resolved = await store.resolveApproval(approval.id, "approved");
      await syncAgentMissionForApproval(resolved!);
    }

    const providerActions = (await store.listJobRuns(company.id)).filter((job) =>
      job.type === "platform_action"
      && job.metadata.kind === "agent_mission_platform_action"
      && job.metadata.runId === mission.run.id
    );
    expect(providerActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "completed",
        metadata: expect.objectContaining({
          action: "social.reply",
          result: expect.objectContaining({ status: "sent" }),
        }),
      }),
      expect.objectContaining({
        status: "completed",
        metadata: expect.objectContaining({
          action: "sales.outreach_send",
          result: expect.objectContaining({ status: "sent" }),
        }),
      }),
    ]));
    const drafts = await store.listSocialOutreachDrafts(company.id);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.status)).toEqual(["sent", "sent"]);
    expect(drafts.map((draft) => draft.approvalId).sort()).toEqual(approvals.map((approval) => approval.id).sort());
  });

  it("marks the mission failed when an approved platform gap is still blocked", async () => {
    const company = await store.createCompany({ name: `AgentMissionBlocked ${makeId("co")}`, brief: { vision: "test" } });
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Create Higgsfield videos, publish to TikTok, and run Meta ads.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName === `agent_mission:${mission.run.id}:platform_auth_or_scope_gap`)!;

    const resolved = await store.resolveApproval(approval.id, "approved");
    const updated = await syncAgentMissionForApproval(resolved!);

    expect(updated?.status).toBe("failed");
    expect(updated?.finalSummary).toContain("Blocked approved AgentMission action");
    const artifacts = await store.listArtifacts(company.id);
    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storageKey: `agent-missions/${mission.run.id}/approvals/${approval.id}.md`,
        status: "failed",
      }),
    ]));
    const events = await store.listAgentMissionEvents(mission.run.id);
    expect(events.some((event) =>
      event.kind === "artifact_created"
      && event.payload.approvalId === approval.id
      && event.payload.externalActionStatus === "blocked"
    )).toBe(true);
  });

  it("marks the mission failed when an external action approval is rejected", async () => {
    const company = await store.createCompany({ name: `AgentMissionReject ${makeId("co")}`, brief: { vision: "test" } });
    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Publish to TikTok and run Meta ads.",
      trigger: "command",
    });
    const approval = (await store.listApprovals(company.id))
      .find((item) => item.toolName?.startsWith(`agent_mission:${mission.run.id}:`))!;

    const rejected = await store.resolveApproval(approval.id, "rejected");
    const updated = await syncAgentMissionForApproval(rejected!);
    expect(updated?.status).toBe("failed");
    expect(updated?.finalSummary).toContain("Rejected approval");
  });

  it("returns undefined for missing runs", async () => {
    const approval = {
      id: makeId("approval"),
      companyId: makeId("company"),
      action: "agent_mission.public_publish",
      toolName: "agent_mission:missing:public_publish",
      status: "approved",
      reason: "approved",
      createdAt: new Date().toISOString(),
    } as Approval;
    await expect(syncAgentMissionForApproval(approval)).resolves.toBeUndefined();
  });
});
