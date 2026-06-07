import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { listCreativeConnectionStatuses } from "@/lib/creative-connections";
import { getMarketingCredentialMap, getSocialCredentialMap, listPlatformConnectionStatuses } from "@/lib/platform-connections";
import { buildPlatformAuthReadiness, inferPlatformRequirements, type CreativeApp } from "@/lib/platform-auth-readiness";
import { buildMissionPlatformFailures } from "@/lib/agent-mission-platform-failures";
import { platformActionExecutionMode } from "@/lib/platform-action-mode";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { listMissionInboxEvidence } from "@/lib/agent-mission-inbox-detail";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import type { AdCampaign, AdCreativeVariant, OptimizationRun } from "@/lib/marketing/types";
import type { SocialAnalyticsSnapshot, SocialOutreachDraft, SocialPost } from "@/lib/social/types";
import type { AgentMissionEvent, Document, JobRun } from "@/lib/types";

type Params = { params: Promise<{ id: string; runId: string }> | { id: string; runId: string } };

export async function GET(_request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, runId } = await context.params;

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const run = await store.getAgentMissionRun(runId);
    if (!run || run.companyId !== companyId) {
      return NextResponse.json({ error: "Agent mission not found" }, { status: 404 });
    }

    const [
      steps,
      events,
      approvals,
      artifacts,
      socialPosts,
      outreachDrafts,
      adCampaigns,
      socialAccounts,
      marketingAccounts,
      providerActions,
      adCreativeVariants,
      documents,
      socialAnalyticsSnapshots,
      optimizationRuns,
      creativeConnections,
      marketingCredentials,
      socialCredentials,
      platformConnections,
    ] = await Promise.all([
      store.listAgentMissionSteps(run.id),
      store.listAgentMissionEvents(run.id),
      store.listApprovals(companyId),
      store.listArtifacts(companyId),
      store.listSocialPosts(companyId),
      store.listSocialOutreachDrafts(companyId),
      store.listAdCampaigns(companyId),
      store.listSocialAccounts(companyId),
      store.listMarketingAccounts(companyId),
      store.listJobRuns(companyId),
      store.listAdCreativeVariants(companyId),
      store.listDocuments(companyId),
      store.listSocialAnalyticsSnapshots(companyId),
      store.listOptimizationRuns(companyId),
      listCreativeConnectionStatuses(companyId),
      getMarketingCredentialMap(companyId),
      getSocialCredentialMap(companyId),
      listPlatformConnectionStatuses(companyId),
    ]);
    const requirements = inferPlatformRequirements(run.objective);
    const readiness = buildPlatformAuthReadiness({
      ...requirements,
      socialAccounts,
      marketingAccounts,
      marketingCredentials,
      socialCredentials,
      creativeCredentials: Object.fromEntries(
        creativeConnections.map((connection) => [connection.app, connection.status === "connected"]),
      ) as Partial<Record<CreativeApp, boolean>>,
    });
    const missionApprovals = approvals.filter((approval) =>
      approval.action.startsWith("agent_mission.")
      && (approval.previewContent?.includes(run.id) ?? false)
    );
    const missionApprovalIds = new Set(missionApprovals.map((approval) => approval.id));
    const missionArtifacts = artifacts.filter((artifact) =>
      artifact.storageKey?.startsWith(`agent-missions/${run.id}/`)
    );
    const memoryLog = missionArtifacts.find((artifact) =>
      artifact.storageKey === `agent-missions/${run.id}/memory-log.md`
    ) ?? null;
    const missionSocialPosts = socialPosts.filter((post) => isMissionSocialPost(post, run.id, missionApprovalIds));
    const missionOutreachDrafts = outreachDrafts.filter((draft) => isMissionOutreachDraft(draft, run.id, missionApprovalIds));
    const missionAdCampaigns = adCampaigns.filter((campaign) => isMissionAdCampaign(campaign, run.id, missionApprovalIds));
    const missionAdCreativeVariants = adCreativeVariants.filter((variant) =>
      missionAdCampaigns.some((campaign) => campaign.id === variant.campaignId)
    );
    const missionProviderActions = providerActions.filter((job) => isMissionProviderAction(job, run.id, missionApprovalIds));
    const platformFailures = buildMissionPlatformFailures(missionProviderActions);
    const inboxEvidence = await listMissionInboxEvidence({
      companyId,
      runId: run.id,
      events,
      outreachDrafts: missionOutreachDrafts,
    });
    const performanceFeedback = buildMissionPerformanceFeedback({
      runId: run.id,
      events,
      documents,
      socialAnalyticsSnapshots,
      optimizationRuns,
      socialPosts: missionSocialPosts,
      adCampaigns: missionAdCampaigns,
    });
    const approvalDashboard = buildApprovalDashboard({
      approvals: missionApprovals,
      socialPosts: missionSocialPosts,
      outreachDrafts: missionOutreachDrafts,
      adCampaigns: missionAdCampaigns,
      providerActions: missionProviderActions,
    });

    return NextResponse.json({
      run,
      steps,
      events,
      approvals: missionApprovals,
      approvalDashboard,
      artifacts: missionArtifacts,
      memoryLog,
      executions: {
        socialPosts: missionSocialPosts,
        outreachDrafts: missionOutreachDrafts,
        adCampaigns: missionAdCampaigns,
        adCreativeVariants: missionAdCreativeVariants,
        providerActions: missionProviderActions,
      },
      performanceFeedback,
      inboxEvidence,
      platformFailures,
      platformActionMode: platformActionExecutionMode(),
      platformReadiness: {
        ...readiness,
        requirements,
        creativeConnections,
        socialConnections: platformConnections.social,
        marketingConnections: platformConnections.marketing,
      },
    });
  });
}

function buildApprovalDashboard(input: {
  approvals: AgentMissionApproval[];
  socialPosts: SocialPost[];
  outreachDrafts: SocialOutreachDraft[];
  adCampaigns: AdCampaign[];
  providerActions: JobRun[];
}) {
  const cards = input.approvals.map((approval) => buildApprovalCard(approval, input));
  const groups = Array.from(new Map(cards.map((card) => [card.gate, card])).values()).map((card) => {
    const items = cards.filter((item) => item.gate === card.gate);
    return {
      gate: card.gate,
      label: card.label,
      action: card.action,
      total: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      approved: items.filter((item) => item.status === "approved").length,
      rejected: items.filter((item) => item.status === "rejected").length,
      executionMode: card.executionMode,
      riskLabel: riskLabelForGate(card.gate),
    };
  });
  return {
    summary: {
      total: cards.length,
      pending: cards.filter((card) => card.status === "pending").length,
      approved: cards.filter((card) => card.status === "approved").length,
      rejected: cards.filter((card) => card.status === "rejected").length,
      linkedTargets: cards.reduce((total, card) => total + card.targets.length, 0),
      providerActions: cards.reduce((total, card) =>
        total + card.targets.filter((target) => target.kind === "provider_action").length, 0),
    },
    groups,
    cards,
  };
}

type AgentMissionApproval = {
  id: string;
  action: string;
  status: string;
  reason?: string;
  toolName?: string;
  previewKind?: string;
  previewContent?: string;
  createdAt?: string;
  expiresAt?: string;
};

function buildApprovalCard(approval: AgentMissionApproval, input: {
  socialPosts: SocialPost[];
  outreachDrafts: SocialOutreachDraft[];
  adCampaigns: AdCampaign[];
  providerActions: JobRun[];
}) {
  const gate = gateForApproval(approval);
  const targets = [
    ...input.socialPosts
      .filter((post) => post.approvalId === approval.id)
      .map((post) => ({
        kind: "social_post",
        id: post.id,
        label: `Post ${post.id}`,
        platform: post.platform,
        status: post.status,
      })),
    ...input.outreachDrafts
      .filter((draft) => draft.approvalId === approval.id)
      .map((draft) => ({
        kind: "reply_draft",
        id: draft.id,
        label: `${draft.purpose === "email_or_sales_send" ? "Sales draft" : "Reply draft"} ${draft.id}`,
        platform: draft.platform,
        status: draft.status,
      })),
    ...input.adCampaigns
      .filter((campaign) => campaign.approvalId === approval.id)
      .map((campaign) => ({
        kind: "ad_campaign",
        id: campaign.id,
        label: `Campaign ${campaign.id}`,
        platform: campaign.platform,
        status: campaign.status,
      })),
    ...input.providerActions
      .filter((job) => stringValue(job.metadata.approvalId) === approval.id)
      .map((job) => ({
        kind: "provider_action",
        id: job.id,
        label: stringValue(job.metadata.action) ?? job.summary,
        platform: stringValue(job.metadata.platform) ?? stringValue(job.metadata.provider),
        status: job.status,
      })),
  ];
  return {
    approvalId: approval.id,
    gate,
    label: labelForGate(gate),
    action: approval.action,
    status: approval.status,
    reason: approval.reason,
    previewKind: approval.previewKind,
    previewContent: approval.previewContent,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    executionMode: executionModeForGate(gate),
    riskLabels: uniqueStrings([
      riskLabelForGate(gate),
      targets.some((target) => target.kind === "provider_action") ? "Provider action queued" : undefined,
      targets.some((target) => target.kind === "ad_campaign") ? "Paid media asset" : undefined,
    ]),
    nextAction: nextActionForGate(gate, targets.some((target) => target.kind === "provider_action")),
    targets,
  };
}

function isMissionSocialPost(post: SocialPost, runId: string, approvalIds: Set<string>) {
  return post.metadata?.runId === runId || (post.approvalId ? approvalIds.has(post.approvalId) : false);
}

function isMissionOutreachDraft(draft: SocialOutreachDraft, runId: string, approvalIds: Set<string>) {
  return draft.contactId === `agent-mission-${runId}`
    || (draft.riskFlags ?? []).includes(`agent_mission:${runId}`)
    || (draft.approvalId ? approvalIds.has(draft.approvalId) : false);
}

function isMissionAdCampaign(campaign: AdCampaign, runId: string, approvalIds: Set<string>) {
  return campaign.name === `AgentMission ${runId}` || (campaign.approvalId ? approvalIds.has(campaign.approvalId) : false);
}

function isMissionProviderAction(job: JobRun, runId: string, approvalIds: Set<string>) {
  if (job.type !== "platform_action") return false;
  if (job.metadata.kind !== "agent_mission_platform_action") return false;
  return job.metadata.runId === runId || (typeof job.metadata.approvalId === "string" && approvalIds.has(job.metadata.approvalId));
}

function buildMissionPerformanceFeedback(input: {
  runId: string;
  events: AgentMissionEvent[];
  documents: Document[];
  socialAnalyticsSnapshots: SocialAnalyticsSnapshot[];
  optimizationRuns: OptimizationRun[];
  socialPosts: SocialPost[];
  adCampaigns: AdCampaign[];
}) {
  const feedbackDocumentIds = new Set(input.events
    .filter((event) => event.kind === "content_performance_feedback_ingested")
    .map((event) => stringValue(event.payload?.documentId))
    .filter((id): id is string => Boolean(id)));
  const socialPostIds = new Set(input.socialPosts.map((post) => post.id));
  const adCampaignIds = new Set(input.adCampaigns.map((campaign) => campaign.id));
  const socialSnapshots = input.socialAnalyticsSnapshots
    .filter((snapshot) => isMissionSocialSnapshot(snapshot, input.runId, socialPostIds))
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const adOptimizationRuns = input.optimizationRuns
    .filter((run) => isMissionOptimizationRun(run, input.runId, adCampaignIds))
    .sort((a, b) => b.runDate.localeCompare(a.runDate));
  const documents = input.documents
    .filter((document) => feedbackDocumentIds.has(document.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    socialSnapshots,
    adOptimizationRuns,
    documents,
    recommendations: uniqueStrings([
      ...input.events.flatMap((event) => recommendationArray(event.payload?.recommendations)),
      ...socialSnapshots.map((snapshot) => stringValue(snapshot.report.recommendation)),
      ...adOptimizationRuns.flatMap((run) => optimizationRecommendationLabels(run)),
    ]),
  };
}

function isMissionSocialSnapshot(snapshot: SocialAnalyticsSnapshot, runId: string, socialPostIds: Set<string>) {
  return stringValue(snapshot.report.runId) === runId
    || stringValue(snapshot.metrics.runId) === runId
    || hasSetValue(socialPostIds, snapshot.report.postId)
    || hasSetValue(socialPostIds, snapshot.metrics.postId);
}

function isMissionOptimizationRun(run: OptimizationRun, runId: string, adCampaignIds: Set<string>) {
  return stringValue(run.inputMetrics.runId) === runId
    || hasSetValue(adCampaignIds, run.inputMetrics.campaignId);
}

function optimizationRecommendationLabels(run: OptimizationRun) {
  const decisions = Array.isArray(run.decisions) ? run.decisions : [run.decisions];
  return decisions.map((decision) => {
    if (!decision || typeof decision !== "object") return undefined;
    const record = decision as Record<string, unknown>;
    const action = stringValue(record.action);
    const reason = stringValue(record.reason);
    if (!action && !reason) return undefined;
    return `${titleFromUnknown(run.inputMetrics.platform) || "Meta"} campaign ${campaignLabel(run)}: ${[action, reason].filter(Boolean).join(" - ")}`;
  });
}

function campaignLabel(run: OptimizationRun) {
  return stringValue(run.inputMetrics.campaignName)
    ?? stringValue(run.inputMetrics.campaignId)
    ?? run.id;
}

function titleFromUnknown(value: unknown) {
  const text = stringValue(value);
  if (!text) return undefined;
  return text === "meta" ? "Meta" : text[0]?.toUpperCase() + text.slice(1);
}

function gateForApproval(approval: AgentMissionApproval) {
  const toolGate = approval.toolName?.split(":")[2];
  if (toolGate) return toolGate;
  return approval.action.replace(/^agent_mission\./, "");
}

function labelForGate(gate: string) {
  if (gate === "public_publish") return "Public publish";
  if (gate === "comment_or_dm_reply") return "Reply / DM";
  if (gate === "email_or_sales_send") return "Sales send";
  if (gate === "paid_spend_or_boost") return "Paid spend";
  if (gate === "platform_auth_or_scope_gap") return "Platform access";
  return gate;
}

function executionModeForGate(gate: string) {
  if (gate === "public_publish") return "external_write";
  if (gate === "paid_spend_or_boost") return "paid_spend";
  if (gate === "platform_auth_or_scope_gap") return "platform_auth";
  if (gate === "comment_or_dm_reply" || gate === "email_or_sales_send") return "external_send";
  return "approval";
}

function riskLabelForGate(gate: string) {
  if (gate === "public_publish") return "Public channel write";
  if (gate === "comment_or_dm_reply") return "Comment/DM external send";
  if (gate === "email_or_sales_send") return "Sales outreach send";
  if (gate === "paid_spend_or_boost") return "Budget/spend change";
  if (gate === "platform_auth_or_scope_gap") return "Platform access change";
  return "External action";
}

function nextActionForGate(gate: string, hasProviderAction: boolean) {
  if (gate === "paid_spend_or_boost") {
    return "Approve only after spend, creative, and destination checks are acceptable.";
  }
  if (gate === "platform_auth_or_scope_gap") {
    return "Connect or approve the required platform access before the mission continues.";
  }
  return hasProviderAction
    ? "Approve to execute queued provider actions; reject to fail the mission safely."
    : "Approve to let the mission prepare the provider action; reject to fail safely.";
}

function recommendationArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function hasSetValue(values: Set<string>, value: unknown) {
  return typeof value === "string" && values.has(value);
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
