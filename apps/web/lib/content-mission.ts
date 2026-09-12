import type { OrchestrationPlan, OrchestrationStep, StepRecord } from "@/lib/orchestrator-runtime";
import { inferPlatformRequirements, type PlatformRequirementInference } from "@/lib/platform-auth-readiness";
import type { AgentRole } from "@/lib/types";
const CONTENT_MISSION_RE = /\b(content|post|publish|video|shorts?|reels?|tiktok|youtube|instagram|linkedin|tweet|thread|viral|trend|dm|comment|reply|ad|ads|campaign|paid|boost|higgsfield|hyperframes)\b/i;
const PAID_MISSION_RE = /\b(ad|ads|paid|boost|campaign|meta|google|tiktok|linkedin|reddit)\b/i;
export type ContentMissionStage = {
  id: string;
  owner: AgentRole;
  goal: string;
  approvalGate: boolean;
};

export type ContentMissionDossier = PlatformRequirementInference & {
  kind: "content_social_ads_mission";
  objective: string;
  operatingMode: "draft_only_until_approval";
  stages: ContentMissionStage[];
  seatResponsibilities: Partial<Record<AgentRole, string>>;
  approvalGates: string[];
  memoryLogFields: string[];
  creativeApps: string[];
};

export type ContentMissionExternalActionKind =
  | "public_publish"
  | "comment_or_dm_reply"
  | "email_or_sales_send"
  | "paid_spend_or_boost"
  | "platform_auth_or_scope_gap";

export type ContentMissionExternalActionStatus = "draft_only" | "needs_approval" | "blocked";

export type ContentMissionActionLedgerItem = {
  id: string;
  kind: ContentMissionExternalActionKind;
  owner: AgentRole;
  status: ContentMissionExternalActionStatus;
  approvalGate: string;
  sourceStage: string;
  reason: string;
  relatedPlatforms: string[];
};

export function isContentMissionObjective(objective: string): boolean {
  return CONTENT_MISSION_RE.test(objective);
}

export function buildContentMissionDossier(objective: string): ContentMissionDossier | null {
  if (!isContentMissionObjective(objective)) return null;
  const inferred = inferPlatformRequirements(objective);
  const paid = PAID_MISSION_RE.test(objective) || inferred.paidAdsRequested;
  const stages: ContentMissionStage[] = [
    {
      id: "market_research",
      owner: "analyst",
      goal: "Find viral market signals, competitor examples, source links, audience pain, and reusable hooks before creative work starts.",
      approvalGate: false,
    },
    {
      id: "growth_thesis",
      owner: "growth",
      goal: "Turn research into positioning, channel strategy, experiment hypothesis, cadence, audience, and success metrics.",
      approvalGate: false,
    },
    {
      id: "platform_readiness",
      owner: "support",
      goal: "Check connected accounts, OAuth scopes, credentials refs, auto-publish flags, ad payment status, and daily budgets.",
      approvalGate: true,
    },
    {
      id: "creative_production",
      owner: "content",
      goal: "Draft scripts, captions, carousels, post copy, CTAs, creative prompts, and platform-specific variants.",
      approvalGate: false,
    },
    {
      id: "safety_audit",
      owner: "escalation",
      goal: "Review public claims, brand fit, legal sensitivity, restricted content, and approval requirements.",
      approvalGate: true,
    },
    {
      id: "engagement_ops",
      owner: "support",
      goal: "Prepare comment, DM, reply, FAQ, opt-out, sentiment, and escalation playbooks.",
      approvalGate: true,
    },
    {
      id: "sales_follow_up",
      owner: "sales",
      goal: "Define lead capture signals, CRM tags, qualification notes, and approved follow-up drafts.",
      approvalGate: true,
    },
  ];
  if (paid) {
    stages.push(
      {
        id: "paid_media_guardrails",
        owner: "finance",
        goal: "Set spend caps, stop-loss rules, CAC assumptions, billing risks, and approval thresholds before launch.",
        approvalGate: true,
      },
      {
        id: "paid_campaign_drafts",
        owner: "growth",
        goal: "Draft campaign objectives, audiences, ad variants, landing-page notes, conversion events, and launch checklist.",
        approvalGate: true,
      },
    );
  }
  stages.push(
    {
      id: "ceo_approval_packet",
      owner: "ceo",
      goal: "Consolidate selected assets, schedule, platforms, risks, approvals, blocked items, and exact next decision.",
      approvalGate: true,
    },
    {
      id: "measurement_loop",
      owner: "analyst",
      goal: "Define KPI dashboard, attribution, learning cadence, creative-memory fields, and optimization triggers.",
      approvalGate: false,
    },
  );

  return {
    kind: "content_social_ads_mission",
    objective,
    operatingMode: "draft_only_until_approval",
    ...inferred,
    stages,
    seatResponsibilities: {
      ceo: "Consolidate the approval packet and decide what can publish, reply, send, boost, or stay blocked.",
      analyst: "Research viral examples, market signals, competitor angles, sources, metrics, and learning loops.",
      growth: "Own positioning, channel strategy, hooks, paid campaign drafts, audiences, cadence, and success metrics.",
      content: "Create scripts, captions, social copy, storyboards, creative prompts, and platform adaptations.",
      support: "Prepare comment and DM handling, reply drafts, escalation triggers, and operational publishing readiness.",
      sales: "Turn qualified engagement into CRM signals, lead capture paths, and approved follow-up drafts.",
      finance: "Guard budgets, paid media spend caps, billing readiness, stop-loss rules, and launch approvals.",
      escalation: "Audit brand safety, claims, public-post risk, consent, legal sensitivity, and irreversible actions.",
    },
    approvalGates: [
      "public_publish",
      "comment_or_dm_reply",
      "email_or_sales_send",
      "paid_spend_or_boost",
      "claims_or_brand_safety_exception",
      "platform_auth_or_scope_gap",
    ],
    memoryLogFields: [
      "viral_sources",
      "market_assumptions",
      "selected_hooks",
      "creative_assets",
      "platform_readiness",
      "approval_decisions",
      "published_or_blocked_actions",
      "engagement_results",
      "learning_loop",
    ],
    creativeApps: detectCreativeApps(objective),
  };
}

export function buildContentMissionApprovalPacket(plan: OrchestrationPlan, steps: StepRecord[]): string {
  const dossier = buildContentMissionDossier(plan.objective);
  if (!dossier) return "";
  const actionLedger = buildContentMissionActionLedger(plan, steps);
  const toolBlockers = collectToolBlockers(steps);
  const blockedSteps = steps.filter((step) => step.status === "failed" || step.status === "blocked");
  const gatedSteps = steps.filter((step) => step.needsApproval);
  const externalStatus = toolBlockers.length > 0 || blockedSteps.length > 0 || gatedSteps.length > 0
    ? "BLOCKED"
    : "DRAFT_READY";

  return [
    "## CEO Content Approval Packet",
    "",
    `Objective: ${plan.objective}`,
    `External action status: ${externalStatus}`,
    "Operating mode: draft_only_until_approval",
    "No public publish, comment/DM reply, sales send, boost, or ad spend should happen without approval.",
    "",
    "### Seat Reports",
    ...formatSeatReports(steps),
    "",
    "### Approval Gates",
    ...dossier.approvalGates.map((gate) => `- ${gate}`),
    "",
    "### External Action Ledger",
    ...formatActionLedger(actionLedger),
    "",
    "### Blockers / Approval Needs",
    ...formatBlockers({ toolBlockers, blockedSteps, gatedSteps }),
    "",
    "### Measurement + Memory Fields",
    ...dossier.memoryLogFields.map((field) => `- ${field}`),
  ].join("\n");
}

export function buildContentMissionActionLedger(plan: OrchestrationPlan, steps: StepRecord[]): ContentMissionActionLedgerItem[] {
  const dossier = buildContentMissionDossier(plan.objective);
  if (!dossier) return [];
  const blockers = collectToolBlockers(steps);
  const hasBlocker = blockers.length > 0 || steps.some((step) => step.status === "blocked" || step.status === "failed");
  const items: ContentMissionActionLedgerItem[] = [];

  if (dossier.socialPublishingRequested || dossier.requiredSocialPlatforms.length > 0) {
    items.push({
      id: "action_public_publish",
      kind: "public_publish",
      owner: "ceo",
      status: hasBlocker ? "blocked" : "needs_approval",
      approvalGate: "public_publish",
      sourceStage: "ceo_approval_packet",
      reason: hasBlocker ? blockers[0] ?? "A mission step is blocked." : "Publishing is ready for CEO approval only; no public post has been sent.",
      relatedPlatforms: dossier.requiredSocialPlatforms,
    });
  }

  if (/\b(dm|comment|reply|repl(?:y|ies)|inbox|engagement)\b/i.test(plan.objective)) {
    items.push({
      id: "action_comment_or_dm_reply",
      kind: "comment_or_dm_reply",
      owner: "support",
      status: hasBlocker ? "blocked" : "needs_approval",
      approvalGate: "comment_or_dm_reply",
      sourceStage: "engagement_ops",
      reason: hasBlocker ? blockers[0] ?? "Engagement is blocked by mission readiness." : "Reply playbook is draft-only until approval.",
      relatedPlatforms: dossier.requiredSocialPlatforms,
    });
  }

  if (/\b(sales|lead|leads|follow[- ]?up|prospect|crm|outreach)\b/i.test(plan.objective) || steps.some((step) => step.agentRole === "sales")) {
    items.push({
      id: "action_email_or_sales_send",
      kind: "email_or_sales_send",
      owner: "sales",
      status: "needs_approval",
      approvalGate: "email_or_sales_send",
      sourceStage: "sales_follow_up",
      reason: "Sales follow-up may be drafted, but no outbound send can happen without approval.",
      relatedPlatforms: [],
    });
  }

  if (dossier.paidAdsRequested || dossier.requiredMarketingPlatforms.length > 0) {
    items.push({
      id: "action_paid_spend_or_boost",
      kind: "paid_spend_or_boost",
      owner: "growth",
      status: hasBlocker ? "blocked" : "needs_approval",
      approvalGate: "paid_spend_or_boost",
      sourceStage: "paid_campaign_drafts",
      reason: hasBlocker ? blockers[0] ?? "Paid media launch is blocked by mission readiness." : "Paid campaign is draft-only until spend approval.",
      relatedPlatforms: dossier.requiredMarketingPlatforms,
    });
  }

  for (const blocker of blockers) {
    items.push({
      id: `action_platform_auth_or_scope_gap_${items.length + 1}`,
      kind: "platform_auth_or_scope_gap",
      owner: "support",
      status: "blocked",
      approvalGate: "platform_auth_or_scope_gap",
      sourceStage: "platform_readiness",
      reason: blocker,
      relatedPlatforms: [...dossier.requiredSocialPlatforms, ...dossier.requiredMarketingPlatforms],
    });
  }

  return items;
}

function formatActionLedger(items: ContentMissionActionLedgerItem[]): string[] {
  return items.length > 0
    ? items.map((item) => [
        `- ${item.kind} — ${item.status}`,
        `owner=${item.owner}`,
        `gate=${item.approvalGate}`,
        item.relatedPlatforms.length ? `platforms=${item.relatedPlatforms.join(",")}` : "",
        `reason=${item.reason}`,
      ].filter(Boolean).join(" — "))
    : ["- none"];
}

function formatSeatReports(steps: StepRecord[]): string[] {
  const reports = steps
    .filter((step) => step.output?.trim())
    .map((step) => `- ${step.agentRole} — ${step.title}: ${truncate(step.output ?? "", 220)}`);
  return reports.length > 0 ? reports : ["- No completed seat reports were captured."];
}

function formatBlockers(input: {
  toolBlockers: string[];
  blockedSteps: StepRecord[];
  gatedSteps: StepRecord[];
}): string[] {
  const blockers = [
    ...input.toolBlockers.map((summary) => `- platform_readiness: ${summary}`),
    ...input.blockedSteps.map((step) => `- ${step.agentRole} blocked: ${step.title}${step.output ? ` — ${truncate(step.output, 180)}` : ""}`),
    ...input.gatedSteps.map((step) => `- approval required: ${step.title}`),
  ];
  return blockers.length > 0 ? dedupe(blockers) : ["- none"];
}

function collectToolBlockers(steps: StepRecord[]): string[] {
  return steps.flatMap((step) => {
    return (step.toolCalls ?? [])
      .filter((call) => call.status === "needs_approval" || call.status === "failed")
      .map((call) => call.summary);
  });
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function detectCreativeApps(objective: string): string[] {
  const apps: string[] = [];
  if (/\bhiggsfield\b/i.test(objective)) apps.push("Higgsfield");
  if (/\bhyperframes?\b/i.test(objective)) apps.push("HyperFrames");
  if (/\bopen generative ai\b|\bopen-gen(?:erative)?-ai\b/i.test(objective)) apps.push("Open Generative AI");
  return apps;
}

export function buildContentMissionProtocolBrief(objective: string): string {
  if (!isContentMissionObjective(objective)) return "";
  return [
    "CONTENT PUBLISHING MISSION:",
    "  - Route research/viral trend discovery to analyst before creative work.",
    "  - Route positioning, channel strategy, hooks, and ads to growth.",
    "  - Route copy, scripts, carousels, captions, media prompts, and brand voice to content.",
    "  - Route comments, DMs, support-sensitive replies, and escalation rules to support.",
    "  - Route lead capture, prospect replies, and sales follow-up to sales.",
    "  - Route paid spend, campaign budget caps, and billing risk to finance before ad launch.",
    "  - Route brand safety, claims, legal/approval risk, and public-post readiness to escalation.",
    "  - Check platform auth readiness before publish, reply, schedule, boost, or ad launch: connected account, OAuth scopes, credentialsRef, auto-publish flag, payment status, and daily budget.",
    "  - CEO must consolidate an approval packet before any publish, reply, send, boost, or spend action.",
    `  - Objective being planned: ${objective}`,
  ].join("\n");
}

export function buildContentMissionFallbackPlan(objective: string): OrchestrationPlan {
  const paid = PAID_MISSION_RE.test(objective);
  const steps: OrchestrationStep[] = [
    {
      id: "s1",
      title: "Research viral market signals and audience demand",
      rationale: "Content should start from evidence, not blank-page ideation.",
      agentRole: "analyst",
      dependsOn: [],
      expectedOutput: [
        `Research the market for "${objective}".`,
        "Return: viral examples, competitor angles, audience pain, source links, reusable hooks, and what not to copy.",
      ].join(" "),
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: "Design the growth thesis and channel plan",
      rationale: "Growth turns research into a distribution experiment with measurable outcomes.",
      agentRole: "growth",
      dependsOn: ["s1"],
      expectedOutput: [
        "Define the content thesis, target audience, platform mix, hook strategy, posting cadence, success metrics, and experiment hypothesis.",
        paid ? "Include paid amplification assumptions but do not launch ads." : "Keep paid media out unless explicitly approved later.",
      ].join(" "),
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s3",
      title: "Check platform connection and auth readiness",
      rationale: "Publishing, DMs, comments, and ads can only move past drafts when connected platforms are ready.",
      agentRole: "support",
      dependsOn: ["s2"],
      expectedOutput: [
        "List required social and ad platform accounts, OAuth scopes, credentialsRef gaps, auto-publish status, payment readiness, and daily budget readiness.",
        "If anything is missing, mark publish/reply/ads as blocked and keep all outputs draft-only.",
      ].join(" "),
      riskLevel: "high",
      needsApproval: false,
    },
    {
      id: "s4",
      title: "Create the content package and media prompts",
      rationale: "Content produces the draft assets that can be reviewed, adapted, and scheduled.",
      agentRole: "content",
      dependsOn: ["s1", "s2", "s3"],
      expectedOutput: [
        "Produce 3 distinct content angles with captions, scripts/storyboards, post copy, CTA, media prompt, and platform adaptations.",
        "For video/motion, include Higgsfield, HyperFrames, or Open Generative AI instructions as draft-only creative directions.",
      ].join(" "),
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s5",
      title: "Audit brand safety, claims, and public-post risk",
      rationale: "Public creative needs a critic before any external action.",
      agentRole: "escalation",
      dependsOn: ["s4"],
      expectedOutput: "Review drafts for unsafe claims, impersonation risk, brand mismatch, restricted terms, legal sensitivity, and approval requirements.",
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s6",
      title: "Prepare comment, DM, and support response playbook",
      rationale: "Publishing creates replies and DMs that need safe handling.",
      agentRole: "support",
      dependsOn: ["s1", "s3", "s4", "s5"],
      expectedOutput: "Draft reply rules, FAQ responses, escalation triggers, opt-out handling, and sentiment triage for comments and DMs.",
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s7",
      title: "Prepare lead capture and sales follow-up path",
      rationale: "Viral content should turn qualified attention into pipeline without spam.",
      agentRole: "sales",
      dependsOn: ["s1", "s2", "s6"],
      expectedOutput: "Define lead qualification signals, CRM tags, handoff rules, outreach drafts, and non-spam follow-up constraints.",
      riskLevel: "medium",
      needsApproval: false,
    },
  ];

  if (paid) {
    steps.push(
      {
        id: "s8",
        title: "Set paid media budget guardrails",
        rationale: "Finance must approve spend boundaries before ads are created or scaled.",
        agentRole: "finance",
        dependsOn: ["s2", "s3"],
        expectedOutput: "Set spend cap, daily budget, stop-loss, expected CAC range, billing risk, and approval threshold before any ad launch.",
        riskLevel: "high",
        needsApproval: false,
      },
      {
        id: "s9",
        title: "Draft paid ad campaign package",
        rationale: "Growth can prepare ads, but launch/spend remains approval-gated.",
        agentRole: "growth",
        dependsOn: ["s4", "s5", "s8"],
        expectedOutput: "Create campaign objective, audience segments, 5 ad variants, landing-page notes, conversion event plan, and launch approval checklist. Do not spend.",
        riskLevel: "high",
        needsApproval: true,
      },
    );
  }

  const approvalDeps = steps.map((step) => step.id);
  steps.push(
    {
      id: paid ? "s10" : "s8",
      title: "Consolidate publishing approval packet",
      rationale: "CEO decides what can be published, replied to, sent, boosted, or launched.",
      agentRole: "ceo",
      dependsOn: approvalDeps,
      expectedOutput: "Create the final approval packet: selected assets, schedule, platforms, risks, required founder approvals, and no-go items. No external action without approval.",
      riskLevel: "high",
      needsApproval: true,
    },
    {
      id: paid ? "s11" : "s9",
      title: "Define measurement and learning loop",
      rationale: "Analyst closes the loop so future content improves from evidence.",
      agentRole: "analyst",
      dependsOn: [paid ? "s10" : "s8"],
      expectedOutput: "Define KPI dashboard, attribution, read cadence, creative-memory fields, and what result triggers republishing, reply follow-up, or ad optimization.",
      riskLevel: "low",
      needsApproval: false,
    },
  );

  return {
    objective,
    reasoning: "Content mission fallback: coordinate Trent's research, growth, content, support, sales, finance, critic, and CEO seats around safe publishing.",
    steps,
    successCriteria: [
      "Market-backed content package exists",
      "Publishing and engagement actions are approval-gated",
      "DM/comment response playbook exists",
      paid ? "Paid media budget guardrails exist before ad launch" : "Measurement loop exists",
    ],
    blockers: [],
  };
}
