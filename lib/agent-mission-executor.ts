import { inferPlatformRequirements } from "@/lib/platform-auth-readiness";
import { creativeMediaFromMissionEvents, type MissionCreativeMedia } from "@/lib/agent-mission-creative-media";
import { store } from "@/lib/store";
import type { AdCampaign, AdCreativeVariant } from "@/lib/marketing/types";
import type { AgentMissionRun, Approval, ArtifactStatus, MarketingPlatform, SocialPlatform } from "@/lib/types";

export type AgentMissionExecutionStatus = "executed" | "blocked";

export type AgentMissionExecutionResult = {
  status: AgentMissionExecutionStatus;
  artifactStatus: ArtifactStatus;
  artifactTitle: string;
  artifactContent: string;
  externalRef?: string;
  providerActionId?: string;
};

export async function executeApprovedAgentMissionAction(input: {
  run: AgentMissionRun;
  approval: Approval;
  gate: string;
}): Promise<AgentMissionExecutionResult> {
  switch (input.gate) {
    case "public_publish":
      return executePublicPublish(input.run, input.approval);
    case "comment_or_dm_reply":
      return executeReplyDraft(input.run, input.approval, "Approved reply draft", "comment_or_dm_reply");
    case "email_or_sales_send":
      return executeReplyDraft(input.run, input.approval, "Approved sales outreach draft", "email_or_sales_send");
    case "paid_spend_or_boost":
      return executePaidSpend(input.run, input.approval);
    case "platform_auth_or_scope_gap":
      return blocked(input.run, input.approval, input.gate, "Platform credentials or scopes are still missing; no external action was sent.");
    default:
      return blocked(input.run, input.approval, input.gate, `Unsupported AgentMission approval gate: ${input.gate}`);
  }
}

async function executePublicPublish(run: AgentMissionRun, approval: Approval): Promise<AgentMissionExecutionResult> {
  const platform = await selectSocialPlatform(run);
  if (!platform) return blocked(run, approval, "public_publish", "No connected social account is available for publishing.");

  const existingPost = (await store.listSocialPosts(run.companyId)).find((post) =>
    post.approvalId === approval.id
    && post.metadata.runId === run.id
    && (post.metadata.approvalGate === "public_publish" || post.metadata.gate === "public_publish")
    && ["draft", "scheduled", "queued", "published"].includes(post.status)
  );
  const post = existingPost
    ? existingPost.status === "published"
      ? existingPost
      : await store.updateSocialPost(existingPost.id, {
      status: "queued",
      content: approval.previewContent ?? existingPost.content,
      approvalId: approval.id,
      metadata: {
        ...existingPost.metadata,
        source: "agent_mission",
        gate: "public_publish",
      },
    }) ?? existingPost
    : await store.createSocialPost({
      companyId: run.companyId,
      socialAccountId: platform.accountId,
      platform: platform.platform,
      status: "queued",
      content: approval.previewContent ?? `Approved AgentMission post for: ${run.objective}`,
      mediaUrls: [],
      approvalId: approval.id,
      metadata: {
        runId: run.id,
        source: "agent_mission",
        gate: "public_publish",
      },
    });
  const providerAction = await queuePlatformAction({
    run,
    approval,
    gate: "public_publish",
    action: "social.publish",
    platform: post.platform,
    provider: socialProvider(post.platform),
    targetId: post.id,
    payload: {
      postId: post.id,
      socialAccountId: post.socialAccountId,
      content: post.content,
      mediaUrls: post.mediaUrls,
    },
  });

  return {
    status: "executed",
    artifactStatus: "sent",
    artifactTitle: `Queued AgentMission post on ${post.platform}`,
    artifactContent: [
      "# AgentMission Executed Action",
      "",
      "- kind: social_post",
      `- runId: ${run.id}`,
      `- approvalId: ${approval.id}`,
      `- platform: ${post.platform}`,
      `- postId: ${post.id}`,
      `- providerActionId: ${providerAction.id}`,
      `- status: ${post.status}`,
    ].join("\n"),
    externalRef: post.id,
    providerActionId: providerAction.id,
  };
}

async function executeReplyDraft(
  run: AgentMissionRun,
  approval: Approval,
  title: string,
  gate: string,
): Promise<AgentMissionExecutionResult> {
  const platform = await selectSocialPlatform(run);
  if (!platform) return blocked(run, approval, gate, "No connected social account is available for reply or outreach drafting.");

  const existingDraft = (await store.listSocialOutreachDrafts(run.companyId)).find((draft) =>
    (draft.contactId === `agent-mission-${run.id}` || (draft.riskFlags ?? []).includes(`agent_mission:${run.id}`))
    && draft.purpose === gate
    && draft.status === "pending_approval"
  );
  const contact = existingDraft ? undefined : await store.upsertSocialContact({
    companyId: run.companyId,
    platform: platform.platform,
    externalContactId: `agent-mission-${run.id}`,
    displayName: "AgentMission engagement target",
    memory: {
      source: "agent_mission",
      runId: run.id,
      objective: run.objective,
    },
  });
  const draft = existingDraft
    ? await store.updateSocialOutreachDraft(existingDraft.id, {
      message: approval.previewContent ?? existingDraft.message,
      status: "approved",
      approvalId: approval.id,
      riskFlags: existingDraft.riskFlags.filter((flag) => flag !== "approval_required"),
    })
    : await store.createSocialOutreachDraft({
      companyId: run.companyId,
      contactId: contact!.id,
      platform: platform.platform,
      purpose: gate,
      message: approval.previewContent ?? `Approved AgentMission outreach for: ${run.objective}`,
      status: "approved",
      approvalId: approval.id,
      riskFlags: [`agent_mission:${run.id}`],
    });
  if (!draft) return blocked(run, approval, gate, "Unable to approve the mission outreach draft.");
  const action = gate === "email_or_sales_send" ? "sales.outreach_send" : "social.reply";
  const providerAction = await queuePlatformAction({
    run,
    approval,
    gate,
    action,
    platform: draft.platform,
    provider: gate === "email_or_sales_send" ? `Sales:${providerTitle(draft.platform)}` : socialProvider(draft.platform),
    targetId: draft.id,
    payload: {
      draftId: draft.id,
      contactId: draft.contactId,
      purpose: draft.purpose,
      message: draft.message,
    },
  });

  return {
    status: "executed",
    artifactStatus: "sent",
    artifactTitle: title,
    artifactContent: [
      "# AgentMission Executed Action",
      "",
      "- kind: outreach_draft",
      `- runId: ${run.id}`,
      `- approvalId: ${approval.id}`,
      `- platform: ${draft.platform}`,
      `- draftId: ${draft.id}`,
      `- providerActionId: ${providerAction.id}`,
      `- status: ${draft.status}`,
    ].join("\n"),
    externalRef: draft.id,
    providerActionId: providerAction.id,
  };
}

async function executePaidSpend(run: AgentMissionRun, approval: Approval): Promise<AgentMissionExecutionResult> {
  const platform = await selectMarketingPlatform(run);
  if (!platform) return blocked(run, approval, "paid_spend_or_boost", "No ready marketing account is available for paid spend.");

  const campaign = (await store.listAdCampaigns(run.companyId)).find((item) =>
    item.approvalId === approval.id
    && item.name === `AgentMission ${run.id}`
    && ["draft", "active"].includes(item.status)
  ) ?? await store.createAdCampaign({
    companyId: run.companyId,
    marketingAccountId: platform.accountId,
    platform: platform.platform,
    name: `AgentMission ${run.id}`,
    objective: run.objective,
    status: "draft",
    dailyBudgetCents: Math.min(run.budgetCents, platform.dailyBudgetCents),
    approvalId: approval.id,
  });
  const creativeVariant = await ensureMissionAdCreativeVariant(run, campaign);
  const providerAction = await queuePlatformAction({
    run,
    approval,
    gate: "paid_spend_or_boost",
    action: "ads.launch",
    platform: campaign.platform,
    provider: marketingProvider(campaign.platform),
    targetId: campaign.id,
    payload: {
      campaignId: campaign.id,
      marketingAccountId: campaign.marketingAccountId,
      objective: campaign.objective,
      dailyBudgetCents: campaign.dailyBudgetCents,
      status: campaign.status,
      ...(creativeVariant ? {
        creativeVariantId: creativeVariant.id,
        assetUrl: creativeVariant.assetUrl,
        creativeAssetSource: creativeVariant.metrics.source,
        creativeAssetArtifactId: creativeVariant.metrics.artifactId,
      } : {}),
    },
  });

  return {
    status: "executed",
    artifactStatus: "sent",
    artifactTitle: `Draft ad campaign on ${campaign.platform}`,
    artifactContent: [
      "# AgentMission Executed Action",
      "",
      "- kind: ad_campaign",
      `- runId: ${run.id}`,
      `- approvalId: ${approval.id}`,
      `- platform: ${campaign.platform}`,
      `- campaignId: ${campaign.id}`,
      creativeVariant ? `- creativeVariantId: ${creativeVariant.id}` : "- creativeVariantId: none",
      creativeVariant?.assetUrl ? `- assetUrl: ${creativeVariant.assetUrl}` : "- assetUrl: none",
      `- providerActionId: ${providerAction.id}`,
      `- status: ${campaign.status}`,
    ].join("\n"),
    externalRef: campaign.id,
    providerActionId: providerAction.id,
  };
}

async function ensureMissionAdCreativeVariant(
  run: AgentMissionRun,
  campaign: AdCampaign,
): Promise<AdCreativeVariant | undefined> {
  const creativeMedia = await missionCreativeMedia(run);
  const assetUrl = creativeMedia?.mediaUrls[0];
  if (!creativeMedia || !assetUrl) return undefined;

  const existing = (await store.listAdCreativeVariants(run.companyId, campaign.id))
    .find((variant) => variant.variantKey === "higgsfield-video");
  const patch = adCreativeVariantFields(run, campaign, creativeMedia, assetUrl);
  if (existing) {
    return await store.updateAdCreativeVariant(existing.id, patch) ?? existing;
  }
  return store.createAdCreativeVariant({
    companyId: run.companyId,
    campaignId: campaign.id,
    variantKey: "higgsfield-video",
    ...patch,
  });
}

async function missionCreativeMedia(run: AgentMissionRun): Promise<MissionCreativeMedia | undefined> {
  return creativeMediaFromMissionEvents(await store.listAgentMissionEvents(run.id));
}

function adCreativeVariantFields(
  run: AgentMissionRun,
  campaign: AdCampaign,
  creativeMedia: MissionCreativeMedia,
  assetUrl: string,
) {
  return {
    headline: "See Trent build and publish the work",
    primaryText: `Generated campaign creative for: ${run.objective}`,
    cta: "Learn More",
    assetUrl,
    moderationStatus: "approved" as const,
    brandSafetyStatus: "approved" as const,
    metrics: {
      source: creativeMedia.source,
      assetUrl,
      artifactId: creativeMedia.artifactId,
      providerJobId: creativeMedia.providerJobId,
      missionRunId: run.id,
      campaignId: campaign.id,
      approvalGate: "paid_spend_or_boost",
    },
  };
}

async function selectSocialPlatform(run: AgentMissionRun): Promise<{ platform: SocialPlatform; accountId: string } | undefined> {
  const inferred = inferPlatformRequirements(run.objective);
  const accounts = (await store.listSocialAccounts(run.companyId))
    .filter((account) => account.status === "active" && account.credentialsRef && account.scopes.includes("post:write"));
  const preferred = inferred.requiredSocialPlatforms[0];
  const account = accounts.find((item) => item.platform === preferred) ?? accounts[0];
  return account ? { platform: account.platform, accountId: account.id } : undefined;
}

async function selectMarketingPlatform(run: AgentMissionRun): Promise<{ platform: MarketingPlatform; accountId: string; dailyBudgetCents: number } | undefined> {
  const inferred = inferPlatformRequirements(run.objective);
  const accounts = (await store.listMarketingAccounts(run.companyId))
    .filter((account) => account.status === "active" && account.paymentStatus === "ready" && (account.dailyBudgetCents ?? 0) > 0);
  const preferred = inferred.requiredMarketingPlatforms[0];
  const account = accounts.find((item) => item.platform === preferred) ?? accounts[0];
  return account ? { platform: account.platform, accountId: account.id, dailyBudgetCents: account.dailyBudgetCents ?? 0 } : undefined;
}

function blocked(run: AgentMissionRun, approval: Approval, gate: string, reason: string): AgentMissionExecutionResult {
  return {
    status: "blocked",
    artifactStatus: "failed",
    artifactTitle: `Blocked AgentMission action: ${gate}`,
    artifactContent: [
      "# AgentMission Blocked External Action",
      "",
      `- runId: ${run.id}`,
      `- approvalId: ${approval.id}`,
      `- gate: ${gate}`,
      `- reason: ${reason}`,
      "",
      "No external action was sent.",
    ].join("\n"),
  };
}

async function queuePlatformAction(input: {
  run: AgentMissionRun;
  approval: Approval;
  gate: string;
  action: string;
  platform: string;
  provider: string;
  targetId: string;
  payload: Record<string, unknown>;
}) {
  const existing = (await store.listJobRuns(input.run.companyId)).find((job) =>
    job.type === "platform_action"
    && (job.status === "running" || job.status === "completed")
    && job.metadata.kind === "agent_mission_platform_action"
    && job.metadata.runId === input.run.id
    && job.metadata.approvalId === input.approval.id
    && job.metadata.gate === input.gate
    && job.metadata.action === input.action
    && job.metadata.targetId === input.targetId
  );
  if (existing) return existing;

  return store.createJobRun({
    type: "platform_action",
    status: "running",
    companyId: input.run.companyId,
    trigger: "system",
    summary: `Queued platform action: ${input.action} ${input.platform}`,
    resultCount: 0,
    metadata: {
      kind: "agent_mission_platform_action",
      runId: input.run.id,
      approvalId: input.approval.id,
      gate: input.gate,
      action: input.action,
      platform: input.platform,
      provider: input.provider,
      targetId: input.targetId,
      payload: input.payload,
    },
  });
}

function socialProvider(platform: SocialPlatform) {
  return `Social:${providerTitle(platform)}`;
}

function marketingProvider(platform: MarketingPlatform) {
  return `Ads:${providerTitle(platform)}`;
}

function providerTitle(value: string) {
  if (value === "tiktok") return "TikTok";
  if (value === "x") return "X";
  return value[0]?.toUpperCase() + value.slice(1);
}
