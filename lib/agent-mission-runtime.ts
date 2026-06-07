import {
  auditAgentMissionApprovalRequested,
  auditAgentMissionRunStarted,
} from "@/lib/agent-mission-audit";
import { assertAgentMissionBudget } from "@/lib/agent-mission-spend";
import { MISSION_APPROVAL_POLICY, type MissionApprovalLevel } from "@/lib/agent-mission-contracts";
import { platformActionExecutionMode } from "@/lib/platform-action-mode";
import { buildAgentMissionAnalyticsContext, formatAnalyticsContextForCeo, type AgentMissionAnalyticsContext } from "@/lib/agent-mission-analytics-context";
import { linkMissionExecutionDraftApprovals } from "@/lib/agent-mission-approval-links";
import { persistAgentMissionLoopEvidence } from "@/lib/agent-mission-loop-evidence";
import { persistAgentMissionMemoryLog } from "@/lib/agent-mission-memory-log";
import { ingestMissionMemory, recallMissionContext } from "@/lib/gbrain/gbrain-memory";
import type { GbrainRecallResult } from "@/lib/gbrain/gbrain-client";
import { getCreativeCredentialMap } from "@/lib/creative-connections";
import { getMarketingCredentialMap, getSocialCredentialMap } from "@/lib/platform-connections";
import {
  buildPlatformAuthReadiness,
  inferPlatformRequirements,
  type PlatformAuthReadinessResult,
} from "@/lib/platform-auth-readiness";
import type { AgentMissionRun, AgentMissionStep, AgentMissionTrigger, AgentRole, Approval, Artifact } from "@/lib/types";
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";

export type MissionApprovalGate = keyof typeof MISSION_APPROVAL_POLICY;

export type AgentMissionPlanStep = {
  id: string;
  seq: number;
  agentRole: AgentRole;
  title: string;
  objective: string;
  expectedOutput: string;
  dependsOn: string[];
};

export type AgentMissionPlan = {
  objective: string;
  missionType: AgentMissionRun["missionType"];
  steps: AgentMissionPlanStep[];
  approvalGates: MissionApprovalGate[];
  successCriteria: string[];
};

export type AgentMissionRunResult = {
  run: AgentMissionRun;
  plan: AgentMissionPlan;
  steps: AgentMissionStep[];
  approvals: Approval[];
  artifacts: Artifact[];
  finalSummary: string;
  platformReadiness: PlatformAuthReadinessResult;
  memoryRecall: GbrainRecallResult;
  analyticsContext: AgentMissionAnalyticsContext;
};

type RunInput = {
  companyId: string;
  objective: string;
  trigger?: AgentMissionTrigger;
  budgetCents?: number;
};

const PUBLISH_RE = /\b(publish|post|tiktok|youtube|instagram|linkedin|tweet|thread|shorts?|reels?)\b/i;
const PAID_RE = /\b(ad|ads|paid|boost|campaign|meta|google|reddit|cpc|roas)\b/i;
const ENGAGEMENT_RE = /\b(dm|dms|comment|comments|reply|replies|inbox|engagement)\b/i;
const SALES_RE = /\b(sales|lead|leads|follow[- ]?up|outreach|prospect|crm|buyer)\b/i;

export function buildAgentMissionPlan(objective: string): AgentMissionPlan {
  const needsEngagement = ENGAGEMENT_RE.test(objective);
  const needsSales = SALES_RE.test(objective);
  const gates = approvalGatesForObjective(objective);
  const steps: Omit<AgentMissionPlanStep, "id" | "seq" | "dependsOn">[] = [
    {
      agentRole: "analyst",
      title: "Research market, viral signals, and audience demand",
      objective: `Find current signals and content angles for: ${objective}`,
      expectedOutput: "trendSignals, viralFormats, competitorFindings, audienceInsights, recommendedAngles",
    },
    {
      agentRole: "growth",
      title: "Create growth thesis, channels, and campaign draft",
      objective: `Turn research into a distribution and ads-ready campaign for: ${objective}`,
      expectedOutput: "campaignHypothesis, channels, distributionPlan, successMetrics",
    },
    {
      agentRole: "content",
      title: "Create content package and creative drafts",
      objective: `Draft scripts, captions, creative prompts, and publishing drafts for: ${objective}`,
      expectedOutput: "contentBriefs, scripts, captions, creativeAssets, publishingDrafts",
    },
    {
      agentRole: "finance",
      title: "Set budget, spend caps, and ROI guardrails",
      objective: `Guard spend and budget risk for: ${objective}`,
      expectedOutput: "spendLimit, approvedBudgetCents, blockedReasons, roiAssumptions",
    },
  ];
  if (needsEngagement) {
    steps.push({
      agentRole: "support",
      title: "Prepare comment and DM operations",
      objective: `Prepare safe comment/DM handling for: ${objective}`,
      expectedOutput: "replyGuidelines, dmTriageRules, escalationTriggers",
    });
  }
  if (needsSales) {
    steps.push({
      agentRole: "sales",
      title: "Prepare lead capture and sales follow-up",
      objective: `Prepare lead routing and outbound drafts for: ${objective}`,
      expectedOutput: "leadCriteria, outreachDrafts, crmActionsDraft",
    });
  }
  steps.push(
    {
      agentRole: "escalation",
      title: "Audit claims, brand safety, and approval risk",
      objective: `Review public-risk and approval requirements for: ${objective}`,
      expectedOutput: "riskFindings, complianceIssues, approvalRecommendation",
    },
    {
      agentRole: "ceo",
      title: "Consolidate mission report and approval packet",
      objective: `Summarize all seat work, blockers, approvals, artifacts, costs, and next action for: ${objective}`,
      expectedOutput: "missionSummary, approvalPacket, finalDecision, nextActions",
    },
  );
  return {
    objective,
    missionType: "content_social_ads",
    steps: steps.map((step, index) => ({
      ...step,
      id: `mission_step_${index + 1}`,
      seq: index + 1,
      dependsOn: index === 0 ? [] : [`mission_step_${index}`],
    })),
    approvalGates: gates,
    successCriteria: [
      "research-first content plan",
      "draft-only external actions until approval",
      "CEO report includes all seat outputs, artifacts, costs, approvals, and next action",
    ],
  };
}

export async function runAgentMission(input: RunInput): Promise<AgentMissionRunResult> {
  const runId = makeId("amr");
  const budgetCents = input.budgetCents ?? 5000;
  await assertAgentMissionBudget(input.companyId, budgetCents);
  const plan = buildAgentMissionPlan(input.objective);
  const platformReadiness = await buildMissionPlatformReadiness(input.companyId, input.objective);
  if (!platformReadiness.ready && !plan.approvalGates.includes("platform_auth_or_scope_gap")) {
    plan.approvalGates.push("platform_auth_or_scope_gap");
  }
  let run = await store.createAgentMissionRun({
    id: runId,
    companyId: input.companyId,
    objective: input.objective,
    missionType: plan.missionType,
    status: "planning",
    trigger: input.trigger ?? "manual",
    ownerSeat: "ceo",
    budgetCents,
    costCents: 0,
    approvalPolicy: MISSION_APPROVAL_POLICY,
    modelPolicy: {
      planner: "deterministic",
      seatRuntime: "contract_fallback",
      externalMode: "draft_only_until_approval",
    },
  });
  await emit(run, "run_start", { objective: input.objective, platformActionMode: platformActionExecutionMode() });
  await auditAgentMissionRunStarted({
    companyId: run.companyId,
    runId: run.id,
    objective: run.objective,
    budgetCents: run.budgetCents,
  });
  await emit(run, "plan_ready", { steps: plan.steps, approvalGates: plan.approvalGates });

  const memoryRecall = await recallMissionContext({ companyId: input.companyId, objective: input.objective });
  await emit(run, "memory_recall", {
    source: memoryRecall.source,
    answer: memoryRecall.answer,
    citations: memoryRecall.citations,
    gaps: memoryRecall.gaps,
  });
  const analyticsContext = await buildAgentMissionAnalyticsContext(input.companyId);
  if (analyticsContext.socialSnapshots.length > 0 || analyticsContext.adOptimizationRuns.length > 0) {
    await emit(run, "analytics_context_loaded", {
      socialSnapshotCount: analyticsContext.socialSnapshots.length,
      adOptimizationRunCount: analyticsContext.adOptimizationRuns.length,
      recommendations: analyticsContext.recommendations,
    });
  }
  if (!platformReadiness.ready) {
    await emit(run, "step_blocked", {
      agentRole: "ceo",
      title: "Platform readiness blocked external execution",
      blockers: platformReadiness.blockers,
      instructions: platformReadiness.instructions,
    });
  }
  run = await store.updateAgentMissionRun(run.id, { status: "running" }) ?? run;

  const artifacts: Artifact[] = [];
  for (const planStep of plan.steps) {
    const stepId = `${run.id}:${planStep.id}`;
    const startedAt = nowIso();
    await store.upsertAgentMissionStep(toMissionStep(run, planStep, { status: "running", startedAt }));
    await emit(run, "step_start", { agentRole: planStep.agentRole, title: planStep.title }, stepId);

    const output = deterministicSeatOutput(planStep.agentRole, input.objective);
    const artifact = await createSeatArtifact(run, planStep, output);
    artifacts.push(artifact);
    await emit(run, "artifact_created", { artifactId: artifact.id, agentRole: planStep.agentRole }, stepId);
    await store.upsertAgentMissionStep(toMissionStep(run, planStep, {
      status: "completed",
      output,
      costCents: costForSeat(planStep.agentRole),
      startedAt,
      completedAt: nowIso(),
    }));
    await emit(run, "step_output", { agentRole: planStep.agentRole, output }, stepId);
    await emit(run, "step_end", { agentRole: planStep.agentRole, status: "completed" }, stepId);
  }

  const loopEvidence = await persistAgentMissionLoopEvidence({ run, plan, platformReadiness });
  for (const item of loopEvidence) {
    artifacts.push(item.artifact);
    await emit(run, item.eventKind, {
      ...item.payload,
      artifactId: item.artifact.id,
      storageKey: item.artifact.storageKey,
      title: item.artifact.title,
    });
  }

  const approvals = await createApprovalRequests(run, plan);
  for (const approval of approvals) {
    await emit(run, "approval_requested", { approvalId: approval.id, action: approval.action });
    const gate = approval.toolName?.split(":")[2];
    if (gate) {
      await auditAgentMissionApprovalRequested({
        companyId: run.companyId,
        runId: run.id,
        approvalId: approval.id,
        gate,
        action: approval.action,
      });
    }
  }
  const linkedExecutionDrafts = await linkMissionExecutionDraftApprovals(run, approvals);
  if (linkedExecutionDrafts.length > 0) {
    await emit(run, "approval_links_ready", { links: linkedExecutionDrafts });
  }

  const steps = await store.listAgentMissionSteps(run.id);
  const finalSummary = buildMissionFinalSummary({ run, steps, approvals, artifacts, plan, platformReadiness, memoryRecall, analyticsContext });
  const ceoArtifact = await createMissionReportArtifact(run, finalSummary);
  artifacts.push(ceoArtifact);
  await emit(run, "artifact_created", { artifactId: ceoArtifact.id, agentRole: "ceo" });
  run = await store.updateAgentMissionRun(run.id, {
    status: approvals.length ? "awaiting_approval" : "completed",
    finalSummary,
    costCents: steps.reduce((sum, step) => sum + step.costCents, 0),
    completedAt: approvals.length ? undefined : nowIso(),
  }) ?? run;
  const memoryLog = await persistAgentMissionMemoryLog({ run, steps, approvals, artifacts, finalSummary });
  artifacts.push(memoryLog.artifact);
  await emit(run, "artifact_created", { artifactId: memoryLog.artifact.id, agentRole: "ceo", memoryTier: "episodic" });

  const ingest = await ingestMissionMemory({
    companyId: run.companyId,
    runId: run.id,
    objective: run.objective,
    markdown: memoryLog.markdown,
    documentId: memoryLog.document.id,
  });
  await emit(run, "memory_ingested", { status: ingest.status, source: ingest.source, documentId: ingest.documentId });

  await emit(run, "run_done", { status: run.status, approvalCount: approvals.length, artifactCount: artifacts.length });

  return { run, plan, steps, approvals, artifacts, finalSummary, platformReadiness, memoryRecall, analyticsContext };
}

async function buildMissionPlatformReadiness(companyId: string, objective: string): Promise<PlatformAuthReadinessResult> {
  const inferred = inferPlatformRequirements(objective);
  const [socialAccounts, marketingAccounts, creativeCredentials, marketingCredentials, socialCredentials] = await Promise.all([
    store.listSocialAccounts(companyId),
    store.listMarketingAccounts(companyId),
    getCreativeCredentialMap(companyId),
    getMarketingCredentialMap(companyId),
    getSocialCredentialMap(companyId),
  ]);
  return buildPlatformAuthReadiness({
    ...inferred,
    socialAccounts,
    marketingAccounts,
    creativeCredentials,
    marketingCredentials,
    socialCredentials,
  });
}

function approvalGatesForObjective(objective: string): MissionApprovalGate[] {
  const gates: MissionApprovalGate[] = [];
  if (PUBLISH_RE.test(objective)) gates.push("public_publish");
  if (ENGAGEMENT_RE.test(objective)) gates.push("comment_or_dm_reply");
  if (SALES_RE.test(objective)) gates.push("email_or_sales_send");
  if (PAID_RE.test(objective)) gates.push("paid_spend_or_boost");
  return gates.filter((gate, index) => gates.indexOf(gate) === index);
}

function toMissionStep(
  run: AgentMissionRun,
  step: AgentMissionPlanStep,
  patch: Partial<AgentMissionStep> = {},
): AgentMissionStep {
  return {
    id: `${run.id}:${step.id}`,
    runId: run.id,
    companyId: run.companyId,
    seq: step.seq,
    agentRole: step.agentRole,
    title: step.title,
    objective: step.objective,
    status: patch.status ?? "pending",
    dependsOn: step.dependsOn.map((id) => `${run.id}:${id}`),
    expectedOutput: step.expectedOutput,
    output: patch.output,
    toolCalls: patch.toolCalls,
    costCents: patch.costCents ?? 0,
    approvalId: patch.approvalId,
    startedAt: patch.startedAt,
    completedAt: patch.completedAt,
  };
}

async function emit(
  run: AgentMissionRun,
  kind: string,
  payload: Record<string, unknown>,
  stepId?: string,
) {
  return store.appendAgentMissionEvent({ runId: run.id, companyId: run.companyId, stepId, kind, payload });
}

function deterministicSeatOutput(role: AgentRole, objective: string): string {
  const shortObjective = objective.replace(/\s+/g, " ").slice(0, 180);
  const outputs: Record<AgentRole, string> = {
    analyst: `trendSignals: creator-operator demos, build-in-public proof, and tactical breakdowns; viralFormats: teardown, checklist, before/after; recommendedAngles: ${shortObjective}`,
    growth: "campaignHypothesis: research-led creator ops content will convert through proof-heavy demos; channels: TikTok, X, LinkedIn; successMetrics: saves, replies, qualified leads, CAC.",
    content: "contentBriefs: 3 platform variants; scripts: short demo, pain-point teardown, founder POV; captions: draft-only; creativeAssets: Higgsfield prompts and thumbnail notes.",
    finance: "spendLimit: capped test budget; approvedBudgetCents: draft-only until approval; roiAssumptions: pause if CAC or CTR underperforms.",
    support: "replyGuidelines: acknowledge, qualify, route; dmTriageRules: buyer, support, risk; escalationTriggers: complaints, legal claims, unsafe requests.",
    sales: "leadCriteria: founder/operator intent; outreachDrafts: approved-send-only follow-up; crmActionsDraft: tag source campaign and next step.",
    escalation: "riskFindings: public claims and platform policy require review; complianceIssues: none approved for publish; approvalRecommendation: CEO approval required.",
    ceo: "missionSummary: draft packet ready; approvalPacket: publish, replies, sales sends, and paid spend are gated; finalDecision: awaiting approval; nextActions: review packet, approve or revise.",
    engineer: "integrationPlan: no engineering work required for this mission; riskNotes: keep external writes gated.",
  };
  return outputs[role];
}

async function createSeatArtifact(run: AgentMissionRun, step: AgentMissionPlanStep, content: string): Promise<Artifact> {
  return store.createArtifact({
    companyId: run.companyId,
    type: step.agentRole === "analyst" ? "competitive_research" : "campaign_report",
    status: "draft",
    title: `Mission ${step.agentRole}: ${step.title}`,
    summary: content.slice(0, 180),
    content,
    exportFormat: "markdown",
    storageKey: `agent-missions/${run.id}/steps/${step.seq}-${step.agentRole}.md`,
    createdByAgent: step.agentRole,
    provenance: provenance(run, [step.id], costForSeat(step.agentRole)),
  });
}

async function createMissionReportArtifact(run: AgentMissionRun, content: string): Promise<Artifact> {
  return store.createArtifact({
    companyId: run.companyId,
    type: "operating_memo",
    status: "ready",
    title: `CEO mission report: ${run.objective}`,
    summary: content.slice(0, 180),
    content,
    exportFormat: "markdown",
    storageKey: `agent-missions/${run.id}/ceo-report.md`,
    createdByAgent: "ceo",
    provenance: provenance(run, ["ceo_report"], 0),
  });
}

async function createApprovalRequests(run: AgentMissionRun, plan: AgentMissionPlan): Promise<Approval[]> {
  const approvals: Approval[] = [];
  for (const gate of plan.approvalGates) {
    if (MISSION_APPROVAL_POLICY[gate] !== "required" satisfies MissionApprovalLevel) continue;
    approvals.push(await store.createApproval({
      companyId: run.companyId,
      action: `agent_mission.${gate}`,
      reason: approvalReason(gate),
      toolName: `agent_mission:${run.id}:${gate}`,
      previewKind: gate === "paid_spend_or_boost" ? "contract" : "post",
      previewContent: `Mission ${run.id} requires approval for ${gate} before any external action. Objective: ${run.objective}`,
    }));
  }
  return approvals;
}

function approvalReason(gate: MissionApprovalGate): string {
  const reasons: Record<MissionApprovalGate, string> = {
    public_publish: "Public posts are external writes and must be approved before publishing.",
    comment_or_dm_reply: "Comment and DM replies are external sends and must be approved before sending.",
    email_or_sales_send: "Sales outreach is an external send and must be approved before sending.",
    paid_spend_or_boost: "Paid campaign launch or boost changes spend and must be approved by finance/CEO.",
    platform_auth_or_scope_gap: "Platform auth or scope changes require human approval before continuing.",
  };
  return reasons[gate];
}

function buildMissionFinalSummary(input: {
  run: AgentMissionRun;
  plan: AgentMissionPlan;
  steps: AgentMissionStep[];
  approvals: Approval[];
  artifacts: Artifact[];
  platformReadiness: PlatformAuthReadinessResult;
  memoryRecall: GbrainRecallResult;
  analyticsContext: AgentMissionAnalyticsContext;
}): string {
  return [
    "# CEO Mission Report",
    "",
    `Objective: ${input.run.objective}`,
    `Status: ${input.approvals.length ? "awaiting_approval" : "completed"}`,
    "",
    "## Prior Memory (GBrain)",
    `- source: ${input.memoryRecall.source}`,
    input.memoryRecall.answer.trim() || "- no prior memory recalled",
    ...(input.memoryRecall.gaps.length ? ["", "Knowledge gaps:", ...input.memoryRecall.gaps.map((gap) => `- ${gap}`)] : []),
    "",
    "## Prior Analytics Feedback",
    ...formatAnalyticsContextForCeo(input.analyticsContext),
    "",
    "## Seat Reports",
    ...input.steps.map((step) => `- ${step.agentRole}: ${step.output ?? "No output recorded."}`),
    "",
    "## Artifacts",
    ...input.artifacts.map((artifact) => `- ${artifact.id}: ${artifact.title} (${artifact.createdByAgent})`),
    "",
    "## Mission Loops",
    ...formatMissionLoops(input.artifacts),
    "",
    "## Creative Assets",
    ...formatCreativeAssets(input.artifacts),
    "",
    "## Approvals pending",
    ...(input.approvals.length
      ? input.approvals.map((approval) => `- ${approval.action}: ${approval.reason}`)
      : ["- none"]),
    "",
    "## Platform readiness",
    `- ready: ${input.platformReadiness.ready}`,
    ...(
      input.platformReadiness.blockers.length
        ? input.platformReadiness.blockers.map((blocker) => `- ${blocker}`)
        : ["- connected platform checks are satisfied"]
    ),
    `- instructions: ${input.platformReadiness.instructions}`,
    "",
    "## Cost",
    `- costCents: ${input.steps.reduce((sum, step) => sum + step.costCents, 0)}`,
    `- budgetCents: ${input.run.budgetCents}`,
    "",
    "## Next action",
    input.approvals.length
      ? "Review and resolve the approval packet before any public publish, reply, sales send, or paid spend."
      : "Mission packet is ready to archive into memory and measure.",
  ].join("\n");
}

function formatMissionLoops(artifacts: Artifact[]): string[] {
  const loops = artifacts.filter((artifact) => artifact.storageKey?.includes("/loops/"));
  return loops.length
    ? loops.map((artifact) => `- ${artifact.title}: ${artifact.summary}`)
    : ["- no mission loop evidence recorded"];
}

function formatCreativeAssets(artifacts: Artifact[]): string[] {
  const assets = artifacts.filter((artifact) => artifact.storageKey?.includes("/creative/"));
  return assets.length
    ? assets.map((artifact) => `- ${artifact.title}: ${artifact.summary}`)
    : ["- no creative asset evidence recorded"];
}

function costForSeat(role: AgentRole): number {
  const costs: Record<AgentRole, number> = {
    ceo: 80,
    analyst: 120,
    growth: 110,
    content: 140,
    finance: 70,
    support: 60,
    sales: 70,
    escalation: 60,
    engineer: 150,
  };
  return costs[role];
}

function provenance(run: AgentMissionRun, sources: string[], costCents: number): Artifact["provenance"] {
  return {
    prompt: run.objective,
    sources,
    model: "deterministic-agent-mission-runtime",
    tokens: 0,
    costCents,
    generatedAt: nowIso(),
  };
}
