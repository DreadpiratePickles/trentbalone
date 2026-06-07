import type { AgentMissionPlan } from "@/lib/agent-mission-runtime";
import { getCreativeCredentialMap } from "@/lib/creative-connections";
import { createCreativeAssetArtifacts } from "@/lib/agent-mission-creative-evidence";
import { creativeMediaForPublishing, type MissionCreativeMedia } from "@/lib/agent-mission-creative-media";
import { createInboxIngestionEvidence } from "@/lib/agent-mission-inbox-evidence";
import { persistMissionTrendResearch } from "@/lib/content/trend-research";
import type {
  AgentMissionRun,
  Artifact,
  MarketingAccount,
  SocialAccount,
  SocialConversation,
  SocialMessage,
} from "@/lib/types";
import type { PlatformAuthReadinessResult } from "@/lib/platform-auth-readiness";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";

export type AgentMissionLoopKind =
  | "viral_trend_research"
  | "analytics_feedback"
  | "publishing_schedule"
  | "human_approval_dashboard"
  | "creative_asset"
  | "inbox_ingestion"
  | "engagement_draft";

export type AgentMissionLoopEvidence = {
  kind: AgentMissionLoopKind;
  eventKind: string;
  payload?: Record<string, unknown>;
  artifact: Artifact;
};

export async function persistAgentMissionLoopEvidence(input: {
  run: AgentMissionRun;
  plan: AgentMissionPlan;
  platformReadiness: PlatformAuthReadinessResult;
}): Promise<AgentMissionLoopEvidence[]> {
  const [socialAccounts, marketingAccounts, creativeCredentials] = await Promise.all([
    store.listSocialAccounts(input.run.companyId),
    store.listMarketingAccounts(input.run.companyId),
    getCreativeCredentialMap(input.run.companyId),
  ]);
  const trendResearch = await persistMissionTrendResearch({
    run: input.run,
    platforms: requiredSocialPlatforms(input.run.objective),
  });
  const creativeAssetEvidence = await createCreativeAssetArtifacts(input.run, creativeCredentials);
  const scheduledPosts = await createScheduledDraftPosts(
    input.run,
    input.plan,
    socialAccounts,
    creativeMediaForPublishing(creativeAssetEvidence),
  );
  const inboxIngestionEvidence = await createInboxIngestionEvidence(input.run, input.plan);
  const engagementDraftEvidence = await createPreApprovalOutreachDrafts(input.run, input.plan, socialAccounts);
  const snapshots = await createBaselineAnalyticsSnapshots(input.run, input.plan, socialAccounts);
  const optimizationRuns = await createAdOptimizationRuns(input.run, input.plan, marketingAccounts);
  const persisted: AgentMissionLoopEvidence[] = [
    {
      kind: "viral_trend_research",
      eventKind: "viral_trend_research_ready",
      payload: {
        provider: trendResearch.provider,
        status: trendResearch.status,
        signalCount: trendResearch.signalCount,
        blockers: trendResearch.blockers,
        documentId: trendResearch.document.id,
      },
      artifact: trendResearch.artifact,
    },
    ...creativeAssetEvidence,
    ...inboxIngestionEvidence,
    ...engagementDraftEvidence,
  ];
  const evidence = buildLoopArtifacts({
    ...input,
    socialAccounts,
    marketingAccounts,
    scheduledPostCount: scheduledPosts.length,
    analyticsSnapshotCount: snapshots.length,
    optimizationRunCount: optimizationRuns.length,
  });

  for (const item of evidence) {
    const artifact = await store.createArtifact({
      companyId: input.run.companyId,
      type: "campaign_report",
      status: "ready",
      title: item.title,
      summary: item.summary,
      content: item.content,
      exportFormat: "markdown",
      storageKey: `agent-missions/${input.run.id}/loops/${item.slug}.md`,
      createdByAgent: item.createdByAgent,
      provenance: {
        prompt: input.run.objective,
        sources: [input.run.id, item.kind],
        model: "deterministic-agent-mission-loop-evidence",
        tokens: 0,
        costCents: 0,
        generatedAt: nowIso(),
      },
    });
    persisted.push({ kind: item.kind, eventKind: item.eventKind, artifact });
  }
  return persisted;
}

async function createPreApprovalOutreachDrafts(
  run: AgentMissionRun,
  plan: AgentMissionPlan,
  socialAccounts: SocialAccount[],
): Promise<AgentMissionLoopEvidence[]> {
  const gates = plan.approvalGates.filter((gate) => gate === "comment_or_dm_reply" || gate === "email_or_sales_send");
  if (gates.length === 0) return [];

  const account = selectMissionSocialAccount(run.objective, socialAccounts);
  if (!account) return [];

  const seeds: MissionDraftSeed[] = [];
  if (gates.includes("comment_or_dm_reply")) {
    const inboxSeeds = await createReplyDraftSeedsFromInbox(run, account);
    seeds.push(...(inboxSeeds.length ? inboxSeeds : [await createGenericDraftSeed(run, account, "comment_or_dm_reply")]));
  }
  if (gates.includes("email_or_sales_send")) {
    seeds.push(await createGenericDraftSeed(run, account, "email_or_sales_send"));
  }

  const created = await Promise.all(seeds.map((seed) =>
    store.createSocialOutreachDraft({
      companyId: run.companyId,
      contactId: seed.contactId,
      platform: seed.platform,
      purpose: seed.purpose,
      message: seed.message,
      status: "pending_approval",
      approvalId: undefined,
      riskFlags: draftRiskFlags(run, seed.riskFlags),
    })
  ));

  const artifact = await store.createArtifact({
    companyId: run.companyId,
    type: "campaign_report",
    status: "ready",
    title: "Engagement Draft Queue",
    summary: `${created.length} reply, DM, or sales outreach drafts are waiting for human approval before external sending.`,
    content: [
      "# Engagement Draft Queue",
      "",
      `Objective: ${run.objective}`,
      `Platform: ${account.platform}`,
      "",
      ...created.map((draft) => [
        `## ${draft.purpose}`,
        `- draftId: ${draft.id}`,
        `- status: ${draft.status}`,
        `- approvalRequired: true`,
        `- message: ${draft.message}`,
      ].join("\n")),
      "",
      "No comments, DMs, replies, outreach, or sales messages were sent.",
    ].join("\n"),
    exportFormat: "markdown",
    storageKey: `agent-missions/${run.id}/loops/engagement-draft-queue.md`,
    createdByAgent: "growth",
    provenance: {
      prompt: run.objective,
      sources: [run.id, "engagement_draft"],
      model: "deterministic-agent-mission-engagement-drafts",
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
  });

  return created.map((draft) => ({
    kind: "engagement_draft" as const,
    eventKind: draft.purpose === "email_or_sales_send" ? "sales_outreach_draft_ready" : "engagement_draft_ready",
      payload: {
        draftId: draft.id,
        platform: draft.platform,
        purpose: draft.purpose,
        status: draft.status,
        contactId: draft.contactId,
      },
      artifact,
  }));
}

type MissionDraftSeed = {
  contactId: string;
  platform: SocialAccount["platform"];
  purpose: string;
  message: string;
  riskFlags?: string[];
};

async function createReplyDraftSeedsFromInbox(
  run: AgentMissionRun,
  account: SocialAccount,
): Promise<MissionDraftSeed[]> {
  const conversations = (await store.listSocialConversations(run.companyId))
    .filter((conversation) => conversation.socialAccountId === account.id && conversation.platform === account.platform)
    .sort(sortConversationsByRecency)
    .slice(0, 5);
  const seeds: MissionDraftSeed[] = [];
  for (const conversation of conversations) {
    if (!conversation.contactId) continue;
    const contact = await store.getSocialContact(run.companyId, conversation.contactId);
    if (!contact) continue;
    const latestInbound = await latestInboundMessage(run.companyId, conversation);
    seeds.push({
      contactId: contact.id,
      platform: account.platform,
      purpose: "comment_or_dm_reply",
      message: [
        `Draft reply/DM response for ${account.platform}; requires approval before sending.`,
        latestInbound ? `Incoming: ${latestInbound.content}` : "Incoming: no inbound message body captured.",
        `Contact: ${contact.displayName ?? contact.handle ?? contact.externalContactId}`,
        `Objective: ${run.objective}`,
      ].join(" "),
      riskFlags: ["inbox_context"],
    });
  }
  return seeds;
}

async function createGenericDraftSeed(
  run: AgentMissionRun,
  account: SocialAccount,
  gate: string,
): Promise<MissionDraftSeed> {
  const contact = await store.upsertSocialContact({
    companyId: run.companyId,
    platform: account.platform,
    externalContactId: `agent-mission-${run.id}`,
    displayName: "AgentMission engagement target",
    memory: {
      source: "agent_mission",
      runId: run.id,
      objective: run.objective,
    },
  });
  return {
    contactId: contact.id,
    platform: account.platform,
    purpose: gate,
    message: draftMessageForGate(gate, account.platform, run.objective),
  };
}

async function latestInboundMessage(companyId: string, conversation: SocialConversation): Promise<SocialMessage | undefined> {
  const messages = await store.listSocialMessagesForConversation(companyId, conversation.id);
  return messages
    .filter((message) => message.direction === "inbound")
    .sort(sortMessagesByRecency)[0];
}

async function createScheduledDraftPosts(
  run: AgentMissionRun,
  plan: AgentMissionPlan,
  socialAccounts: SocialAccount[],
  creativeMedia?: MissionCreativeMedia,
) {
  if (!plan.approvalGates.includes("public_publish")) return [];
  const preferred = requiredSocialPlatforms(run.objective);
  const preferredSet = new Set<string>(preferred);
  const accounts = socialAccounts.filter((account) =>
    account.status === "active"
    && account.credentialsRef
    && account.autoPublishEnabled
    && (preferredSet.size === 0 || preferredSet.has(account.platform))
  );
  const selected = accounts[0];
  if (!selected) return [];
  const scheduledFor = new Date(new Date(run.startedAt).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const post = await store.createSocialPost({
    companyId: run.companyId,
    socialAccountId: selected.id,
    platform: selected.platform,
    status: "scheduled",
    content: `Draft scheduled mission post for approval: ${run.objective}`,
    mediaUrls: creativeMedia?.mediaUrls ?? [],
    scheduledFor,
    metadata: {
      runId: run.id,
      kind: "mission_schedule",
      approvalGate: "public_publish",
      approvalRequired: true,
      ...(creativeMedia ? {
        creativeAssetSource: creativeMedia.source,
        creativeAssetUrl: creativeMedia.mediaUrls[0],
        creativeAssetArtifactId: creativeMedia.artifactId,
      } : {}),
    },
  });
  return [post];
}

async function createBaselineAnalyticsSnapshots(
  run: AgentMissionRun,
  plan: AgentMissionPlan,
  socialAccounts: SocialAccount[],
) {
  if (!plan.approvalGates.includes("public_publish") && !/\b(content|viral|social|post|publish)\b/i.test(run.objective)) {
    return [];
  }
  const preferred = requiredSocialPlatforms(run.objective);
  const preferredSet = new Set<string>(preferred);
  const accounts = socialAccounts.filter((account) =>
    account.status === "active" && (preferredSet.size === 0 || preferredSet.has(account.platform))
  );
  return Promise.all(accounts.map((account) =>
    store.upsertSocialAnalyticsSnapshot({
      companyId: run.companyId,
      socialAccountId: account.id,
      platform: account.platform,
      periodStart: run.startedAt,
      periodEnd: run.startedAt,
      metrics: {
        impressions: 0,
        engagements: 0,
        clicks: 0,
        replies: 0,
        saves: 0,
      },
      report: {
        runId: run.id,
        loop: "content_analytics_feedback",
        cadence: "24h, 72h, 7d",
        optimizationTriggers: ["low hook retention", "high saves", "qualified DM", "CPA drift"],
      },
    })
  ));
}

async function createAdOptimizationRuns(
  run: AgentMissionRun,
  plan: AgentMissionPlan,
  marketingAccounts: MarketingAccount[],
) {
  if (!plan.approvalGates.includes("paid_spend_or_boost")) return [];
  const preferred = requiredMarketingPlatforms(run.objective);
  const accounts = marketingAccounts.filter((account) =>
    account.status === "active"
    && account.paymentStatus === "ready"
    && (preferred.length === 0 || preferred.includes(account.platform))
  );
  return Promise.all(accounts.map((account) =>
    store.createOptimizationRun({
      companyId: run.companyId,
      marketingAccountId: account.id,
      runDate: run.startedAt.slice(0, 10),
      status: "planned",
      inputMetrics: {
        runId: run.id,
        platform: account.platform,
        dailyBudgetCents: account.dailyBudgetCents ?? 0,
      },
      decisions: [
        { action: `monitor_${account.platform}_ads`, cadence: "daily", guardrail: "do not scale without approved spend cap" },
        { action: "refresh_creative", trigger: "CTR below target or fatigue detected" },
        { action: "report_to_ceo", trigger: "budget drift, winning creative, or blocked conversion tracking" },
      ],
    })
  ));
}

function buildLoopArtifacts(input: {
  run: AgentMissionRun;
  plan: AgentMissionPlan;
  platformReadiness: PlatformAuthReadinessResult;
  socialAccounts: SocialAccount[];
  marketingAccounts: MarketingAccount[];
  scheduledPostCount: number;
  analyticsSnapshotCount: number;
  optimizationRunCount: number;
}) {
  const socialPlatforms = requiredSocialPlatforms(input.run.objective);
  const marketingPlatforms = requiredMarketingPlatforms(input.run.objective);
  const gates = input.plan.approvalGates.join(", ") || "none";
  return [
    {
      kind: "analytics_feedback" as const,
      eventKind: "analytics_feedback_ready",
      slug: "analytics-feedback",
      title: "Analytics feedback loop",
      summary: `Analytics loop with ${input.analyticsSnapshotCount} social baselines and ${input.optimizationRunCount} ad optimization plans.`,
      createdByAgent: "growth" as const,
      content: [
        "# Analytics feedback loop",
        "",
        `Social baselines: ${input.analyticsSnapshotCount}`,
        `Ad optimization plans: ${input.optimizationRunCount}`,
        `Ad platforms: ${marketingPlatforms.map(title).join(", ") || "none"}`,
        "- Read cadence: 24h hook signal, 72h engagement signal, 7d conversion signal.",
        "- Feed winners and losers back into memory before the next content mission.",
        "- Meta ads are optimized only after approval and finance spend guardrails.",
      ].join("\n"),
    },
    {
      kind: "publishing_schedule" as const,
      eventKind: "publishing_schedule_ready",
      slug: "publishing-schedule",
      title: "Publishing schedule",
      summary: `Publishing calendar prepared with ${input.scheduledPostCount} internal scheduled drafts; no public post before approval.`,
      createdByAgent: "content" as const,
      content: [
        "# Publishing schedule",
        "",
        `Scheduled draft posts: ${input.scheduledPostCount}`,
        `Social platforms: ${socialPlatforms.join(", ") || "connected/default"}`,
        "- Drafts can be reviewed in the mission execution panel.",
        "- Publishing stays gated by public_publish approval.",
        "- Replies and DMs stay gated by comment_or_dm_reply approval.",
      ].join("\n"),
    },
    {
      kind: "human_approval_dashboard" as const,
      eventKind: "approval_dashboard_ready",
      slug: "human-approval-dashboard",
      title: "Human approval dashboard",
      summary: `Approval dashboard covers ${gates}; platform ready=${input.platformReadiness.ready}.`,
      createdByAgent: "ceo" as const,
      content: [
        "# Human approval dashboard",
        "",
        `Approval gates: ${gates}`,
        `Platform readiness: ${input.platformReadiness.ready}`,
        input.platformReadiness.blockers.length
          ? `Blockers: ${input.platformReadiness.blockers.join("; ")}`
          : "Blockers: none",
        "- CEO sees public publish, reply/DM, sales send, and paid spend actions before anything irreversible.",
      ].join("\n"),
    },
  ];
}

function requiredSocialPlatforms(text: string) {
  const platforms = ["tiktok", "instagram", "facebook", "linkedin", "x", "youtube", "threads"] as const;
  return platforms.filter((platform) => new RegExp(`\\b${platform}\\b`, "i").test(text));
}

function requiredMarketingPlatforms(text: string) {
  const platforms = ["meta", "google", "tiktok", "linkedin", "reddit"] as const;
  return platforms.filter((platform) => new RegExp(`\\b${platform}\\b`, "i").test(text));
}

function selectMissionSocialAccount(objective: string, socialAccounts: SocialAccount[]) {
  const preferred = requiredSocialPlatforms(objective);
  const preferredSet = new Set<string>(preferred);
  const accounts = socialAccounts.filter((account) =>
    account.status === "active"
    && account.credentialsRef
    && (preferredSet.size === 0 || preferredSet.has(account.platform))
  );
  return accounts[0];
}

function draftMessageForGate(gate: string, platform: string, objective: string) {
  if (gate === "email_or_sales_send") {
    return `Draft sales outreach for ${platform}; requires approval before sending. Objective: ${objective}`;
  }
  return `Draft reply/DM response for ${platform}; requires approval before sending. Objective: ${objective}`;
}

function draftRiskFlags(run: AgentMissionRun, extra: string[] = []) {
  return ["approval_required", "agent_mission", `agent_mission:${run.id}`, ...extra];
}

function sortConversationsByRecency(a: SocialConversation, b: SocialConversation) {
  return comparableTime(b.lastMessageAt, b.updatedAt) - comparableTime(a.lastMessageAt, a.updatedAt);
}

function sortMessagesByRecency(a: SocialMessage, b: SocialMessage) {
  return comparableTime(b.sentAt, b.createdAt) - comparableTime(a.sentAt, a.createdAt);
}

function comparableTime(primary?: string, fallback?: string) {
  return new Date(primary ?? fallback ?? 0).getTime();
}

function title(value: string) {
  return value === "meta" ? "Meta" : value[0]?.toUpperCase() + value.slice(1);
}
