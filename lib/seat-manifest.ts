import { z } from "zod";
import type { AgentQualityLabel, AgentRole, ApprovalPreviewKind, DocumentMemoryTier } from "@/lib/types";

export type SeatModelTier = "haiku" | "sonnet" | "opus";
export type ReversibilityClass = "reversible" | "costly_to_reverse" | "irreversible";
export type SeatToolAuthRequirement = "none" | "company_connection" | "provider_key" | "user_oauth" | "approval";
export type SeatToolExecutionMode = "read" | "draft" | "sandbox" | "external_write";

export type SeatToolSpec = {
  name: string;
  purpose: string;
  description: string;
  authRequirement: SeatToolAuthRequirement;
  parameterSchema: z.ZodTypeAny;
  allowedContextKeys: string[];
  actions: string[];
  reversibility: ReversibilityClass;
  approvalRequired: boolean;
  previewKind?: ApprovalPreviewKind;
  executionMode: SeatToolExecutionMode;
  outputSchema: z.ZodTypeAny;
  audit: {
    category: "read" | "draft" | "sandbox" | "external_write";
    pii: "none" | "possible" | "likely";
    storesArtifact: boolean;
  };
  composio?: { toolkit: string; action: string } | null;
};

export type SeatMemoryPlan = {
  namespaceTemplate: string;
  readsOnStart: Array<{ tier: DocumentMemoryTier; keys: string[] }>;
  writesOnFinish: Array<{ tier: DocumentMemoryTier; keys: string[] }>;
};

export type SeatManifest = {
  role: AgentRole;
  name: string;
  modelTier: SeatModelTier;
  qualityLabel: AgentQualityLabel;
  whenToUse: string;
  whenNotToUse: string;
  methodology: string;
  toolUseStrategy: string;
  antiPatterns: string[];
  definitionOfDone: string;
  contextNeeds: string[];
  inputContract: string[];
  toolContract: string[];
  outputContract: string[];
  successCriteria: string[];
  handoffContract: string[];
  budgetContract: string[];
  memoryContract: string[];
  evalRubric: string[];
  tools: SeatToolSpec[];
  memory: SeatMemoryPlan;
};

export type SeatToolDossier = Pick<
  SeatToolSpec,
  | "name"
  | "purpose"
  | "description"
  | "authRequirement"
  | "allowedContextKeys"
  | "actions"
  | "reversibility"
  | "approvalRequired"
  | "previewKind"
  | "executionMode"
  | "audit"
>;

export type OrchestratorSeatDossier = {
  routingRule: string;
  seats: Array<
    Pick<
      SeatManifest,
      | "role"
      | "name"
      | "modelTier"
      | "qualityLabel"
      | "whenToUse"
      | "whenNotToUse"
      | "methodology"
      | "toolUseStrategy"
      | "contextNeeds"
      | "inputContract"
      | "toolContract"
      | "outputContract"
      | "successCriteria"
      | "handoffContract"
      | "budgetContract"
      | "memoryContract"
    >
    & { tools: SeatToolDossier[] }
  >;
};

const sharedAntiPatterns = [
  "Never claim to send, spend, merge, deploy, publish, or change customer state without an approval record.",
  "Never ask another seat for work directly; emit a typed WorkRequest for CEO authorization.",
  "Never copy full raw artifacts into handoffs when an artifact reference is enough.",
];

const sharedSteelTools = ["steel_scrape", "steel_screenshot", "steel_pdf", "steel_sessions"];

export const SEAT_MANIFESTS: Record<AgentRole, SeatManifest> = {
  ceo: seat("ceo", "CEO Orchestrator", "opus", "supervised", {
    whenToUse: "Ambiguous, cross-functional, prioritization, routing, planning, and synthesis work.",
    whenNotToUse: "Specialized execution after a clear seat and contract are already known.",
    methodology: "Decompose the request into typed subtasks, choose the smallest capable seat set, budget each subtask, and synthesize artifact references into a decision.",
    toolUseStrategy: "Read company state, capability memory, Plug registry, active approvals, and spend summaries before routing. Log why each seat was chosen.",
    contextNeeds: ["companyBrief", "activeTasks", "metrics", "approvals", "budget", "capabilityMemory", "plugRegistry", "contentMission", "platformReadiness"],
    outputContract: ["operating_plan", "routing_decisions", "risks", "artifact_refs", "approval_requests"],
    evalRubric: ["correct routing", "budget adherence", "minimal fan-out", "clear escalation", "useful synthesis"],
    tools: ["memory_read", "tasks_create", "reports_create", "approvals_request", "audit_create"],
  }),
  engineer: seat("engineer", "Lead Engineer", "sonnet", "supervised", {
    whenToUse: "Code changes, PR plans, technical debugging, tests, architecture implementation, deployment preparation.",
    whenNotToUse: "Marketing strategy, financial reconciliation, customer replies, or broad company prioritization.",
    methodology: "Read code before deciding, isolate blast radius, write tests first, implement the smallest safe diff, verify before completion.",
    toolUseStrategy: "Use code search before file reads; run targeted tests before broad checks; draft GitHub work through approvals; never merge/deploy directly.",
    contextNeeds: ["repoContext", "taskSpec", "testFailures", "technicalConstraints", "approvalPolicy"],
    outputContract: ["implementation_plan", "diff_summary", "test_plan", "risk_notes", "approval_requests"],
    evalRubric: ["tests pass", "minimal diff", "no secret leak", "correct file ownership", "clear rollback"],
    tools: ["code_search", "read_file_lines", "run_tests", "github_pr_draft", "deploy_plan"],
  }),
  growth: seat("growth", "Growth Strategist", "sonnet", "supervised", {
    whenToUse: "Acquisition experiments, campaigns, audiences, funnels, paid or organic growth strategy.",
    whenNotToUse: "Ledger correctness, engineering implementation, legal commitments, or support replies.",
    methodology: "Start with hypothesis, channel fit, audience, budget, measurement plan, and approval gate before any launch.",
    toolUseStrategy: "Read ICP, offer, channel history, CRM/Stripe aggregates, and brand memory. Draft campaigns; route spend/launch to approval.",
    contextNeeds: ["companyBrief", "icp", "offer", "metrics", "channelHistory", "brandVoice", "budget", "experiments", "contentMission", "platformReadiness"],
    outputContract: ["experiment_brief", "audience", "channel_plan", "measurement_plan", "approval_requests"],
    evalRubric: ["testable hypothesis", "CAC realism", "channel fit", "budget awareness", "policy-safe"],
    tools: [
      "analytics_read",
      "crm_segments",
      "ads_draft",
      "email_draft",
      "social_draft",
    ],
  }),
  content: seat("content", "Content Operator", "sonnet", "supervised", {
    whenToUse: "Landing copy, emails, social drafts, content briefs, creative variants, docs, brand voice.",
    whenNotToUse: "Ad budget allocation, engineering, finance, or regulated legal promises.",
    methodology: "Ground every draft in ICP, offer, brand voice, proof, CTA, and distribution context. Produce variants with rationale.",
    toolUseStrategy: "Read brand memory and campaign brief first; use policy/brand checks; draft only until approval.",
    contextNeeds: ["brandVoice", "icp", "offer", "campaignBrief", "approvedClaims", "contentCalendar", "contentMission", "platformReadiness"],
    outputContract: ["draft_variants", "rationale", "brand_alignment", "approval_requests"],
    evalRubric: ["brand fit", "factual accuracy", "CTA clarity", "policy-safe", "variant diversity"],
    tools: ["documents_write", "brand_voice_check", "social_draft", "email_draft", "asset_prompt"],
  }),
  support: seat("support", "Support / Ops", "haiku", "supervised", {
    whenToUse: "Ticket triage, reply drafts, customer issue summaries, escalation detection, and operational follow-through.",
    whenNotToUse: "Legal advice, refunds/charges, product roadmap commitments, or security incident ownership.",
    methodology: "Classify first, ground in customer context and docs, draft empathetically, escalate money/legal/security/distress cases.",
    toolUseStrategy: "Read the ticket, customer context, docs, and prior interactions; draft replies only; send requires approval.",
    contextNeeds: ["ticket", "customerContext", "productDocs", "tonePolicy", "priorInteractions", "contentMission", "platformReadiness"],
    outputContract: ["ticket_classification", "reply_draft", "escalation_flag", "source_notes"],
    evalRubric: ["classification accuracy", "tone", "doc grounding", "safe escalation", "no overpromise"],
    tools: ["support_read", "docs_search", "email_draft", "escalation_request"],
  }),
  finance: seat("finance", "Finance/Ops Controller", "opus", "supervised", {
    whenToUse: "Spend caps, billing, reconciliation, margin, refunds, payouts, financial approvals.",
    whenNotToUse: "Brand copy, product design, or technical implementation except cost/risk review.",
    methodology: "Reconcile before recommending, enforce double-entry invariants, soft-warn at 80%, hard-stop at 100%, escalate money movement.",
    toolUseStrategy: "Read usage, invoices, Stripe summaries, budget, and approvals; draft financial actions; never charge/refund/payout directly.",
    contextNeeds: ["budget", "usage", "billingState", "invoices", "approvals", "ledger", "contentMission", "platformReadiness"],
    outputContract: ["spend_summary", "reconciliation", "risk_flags", "approval_requests"],
    evalRubric: ["ledger correctness", "cap enforcement", "reconciliation accuracy", "money-movement gating"],
    tools: [
      "usage_read",
      "billing_read",
      "stripe_draft",
      "approvals_request",
      "audit_create",
    ],
  }),
  analyst: seat("analyst", "Research / Analyst", "sonnet", "supervised", {
    whenToUse: "Research, competitor review, web evidence gathering, metrics, trends, dashboards, attribution, anomaly analysis, and decision support.",
    whenNotToUse: "Writing code, sending customer messages, making strategy without data caveats, or authenticated browser side effects.",
    methodology: "Define the research question or metric, inspect sources, label assumptions, separate signal from noise, and recommend one measurable next action.",
    toolUseStrategy: "Read metrics, reports, public pages, and screenshots only; cite data source and freshness; never invent missing numbers.",
    contextNeeds: ["researchGoal", "allowedDomains", "metrics", "reports", "usage", "experiments", "dataFreshness", "contentMission", "platformReadiness"],
    outputContract: ["research_brief", "metric_readout", "trend", "anomaly", "assumptions", "sources", "recommendation"],
    evalRubric: ["source accuracy", "metric correctness", "assumption labeling", "citation", "no hallucinated numbers", "decision relevance"],
    tools: ["analytics_read", "reports_read", "usage_read", "chart_plan", "browser_extract", "screenshot_capture", "source_archive"],
  }),
  escalation: seat("escalation", "Critic / Escalation / Auditor", "haiku", "autonomous", {
    whenToUse: "Critique, audit, and any public, financial, destructive, legal, privacy, deploy, merge, or ambiguous-consent decision.",
    whenNotToUse: "Routine reversible read-only work with high confidence and no external effect.",
    methodology: "Critique weak outputs, freeze risky action, state decision needed, explain consequence/reversibility, recommend safest option, route to human.",
    toolUseStrategy: "Create approval cards, block tasks, write audit entries, and provide safe alternatives.",
    contextNeeds: ["action", "riskClass", "reversibility", "costForecast", "preview", "policy", "contentMission", "platformReadiness"],
    outputContract: ["critique", "audit_finding", "approval_card", "risk_reason", "recommended_decision", "safe_alternative"],
    evalRubric: ["risk recall", "critique quality", "clear decision", "complete preview", "policy adherence"],
    tools: ["approvals_create", "tasks_block", "audit_create", "digest_notify"],
  }),
  sales: seat("sales", "Sales", "sonnet", "supervised", {
    whenToUse: "Sales prospecting, lead qualification, CRM hygiene, account research, outreach drafts, and follow-up planning.",
    whenNotToUse: "Marketing campaign strategy, support replies, signed commitments, discounts, or sending outbound without approval.",
    methodology: "Qualify against ICP, identify a concrete trigger, draft concise outreach, plan the next step, and gate every external send.",
    toolUseStrategy: "Read ICP, offer, CRM notes, and public prospect context; draft only until approval; never promise pricing or terms.",
    contextNeeds: ["icp", "offer", "crmNotes", "pipelineState", "approvedClaims", "approvalPolicy", "contentMission", "platformReadiness"],
    outputContract: ["prospect_list", "qualification_notes", "outreach_draft", "follow_up_plan", "approval_requests"],
    evalRubric: ["ICP fit", "specific trigger", "clear next step", "no unapproved send", "pipeline hygiene"],
    tools: ["crm_read", "prospect_research", "email_draft", "follow_up_plan", "approvals_request"],
  }),
};

function seat(
  role: AgentRole,
  name: string,
  modelTier: SeatModelTier,
  qualityLabel: AgentQualityLabel,
  input: Omit<
    SeatManifest,
    | "role"
    | "name"
    | "modelTier"
    | "qualityLabel"
    | "antiPatterns"
    | "definitionOfDone"
    | "memory"
    | "tools"
    | "inputContract"
    | "toolContract"
    | "successCriteria"
    | "handoffContract"
    | "budgetContract"
    | "memoryContract"
  > & {
    tools: string[];
    inputContract?: string[];
    toolContract?: string[];
    successCriteria?: string[];
    handoffContract?: string[];
    budgetContract?: string[];
    memoryContract?: string[];
  }
): SeatManifest {
  return {
    ...input,
    role,
    name,
    modelTier,
    qualityLabel,
    antiPatterns: sharedAntiPatterns,
    definitionOfDone: `${name} returns ${input.outputContract.join(", ")} with cited assumptions, artifact references, risk gates, and a concrete next action or blocker.`,
    inputContract: input.inputContract ?? [
      "Receive only context keys declared in contextNeeds.",
      "Receive objective, boundaries, budget, approval policy, and relevant artifact references.",
    ],
    toolContract: input.toolContract ?? [
      "Use only listed tools and their declared execution modes.",
      "External writes and irreversible/costly actions require approval before execution.",
    ],
    successCriteria: input.successCriteria ?? input.evalRubric,
    handoffContract: input.handoffContract ?? [
      "Emit typed WorkRequests for another seat instead of direct same-seat delegation.",
      "Include capability, input object, artifact refs, and reason for handoff.",
    ],
    budgetContract: input.budgetContract ?? [
      `${modelTier} model tier by default.`,
      "Stop or escalate when estimated cost exceeds the seat budget or approval policy.",
    ],
    memoryContract: input.memoryContract ?? [
      "Read semantic memory on start for declared context needs.",
      "Write episodic run summary with decisions, artifacts, risks, and next action on finish.",
    ],
    memory: {
      namespaceTemplate: `company:{companyId}/agent:${role}`,
      readsOnStart: [{ tier: "semantic", keys: input.contextNeeds }],
      writesOnFinish: [{ tier: "episodic", keys: [`last_${role}_run`] }],
    },
    tools: [...input.tools, ...sharedSteelTools].map((tool) => ({
      name: tool,
      purpose: `${role} ${tool.replace(/_/g, " ")}`,
      description: `${name} may use ${tool.replace(/_/g, " ")} only within the seat's context and approval contract.`,
      authRequirement: inferToolAuth(tool),
      parameterSchema: z.object({
        companyId: z.string().optional(),
        objective: z.string().optional(),
        artifactId: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
      }).passthrough(),
      allowedContextKeys: input.contextNeeds,
      actions: ["read", "draft", "request_approval"],
      reversibility: inferToolReversibility(tool),
      approvalRequired: inferToolApprovalRequired(tool),
      previewKind: "generic",
      executionMode: inferToolExecutionMode(tool),
      outputSchema: z.object({
        status: z.enum(["completed", "mocked", "needs_approval", "failed"]),
        summary: z.string(),
        artifactRefs: z.array(z.string()).optional(),
      }).passthrough(),
      audit: {
        category: inferToolExecutionMode(tool),
        pii: tool.includes("customer") || tool.includes("email") || tool.includes("crm") || tool.includes("billing") ? "possible" : "none",
        storesArtifact: tool.includes("draft") || tool.includes("report") || tool.includes("screenshot") || tool.includes("generate"),
      },
      composio: null,
    })),
  };
}

function inferToolReversibility(tool: string): ReversibilityClass {
  if (inferToolExecutionMode(tool) === "external_write") return "irreversible";
  if (tool.includes("launch") || tool.includes("deploy") || tool.includes("stripe") || tool.includes("billing")) return "costly_to_reverse";
  return "reversible";
}

function inferToolApprovalRequired(tool: string): boolean {
  return inferToolExecutionMode(tool) === "external_write"
    || tool.includes("launch")
    || tool.includes("deploy")
    || tool.includes("stripe")
    || tool.includes("billing")
    || tool.includes("approvals_request")
    || tool.includes("approvals_create");
}

function inferToolExecutionMode(tool: string): SeatToolExecutionMode {
  if (tool.includes("sandbox") || tool.includes("fincept") || tool.includes("hyperframes") || tool.includes("open_gen_ai")) return "sandbox";
  if (tool.includes("draft") || tool.includes("plan") || tool.includes("prompt")) return "draft";
  if (tool.includes("send") || tool.includes("deploy") || tool.includes("launch") || tool.includes("stripe")) return "external_write";
  return "read";
}

function inferToolAuth(tool: string): SeatToolAuthRequirement {
  if (inferToolApprovalRequired(tool)) return "approval";
  if (tool.startsWith("steel_") || tool.includes("browser")) return "provider_key";
  if (tool.includes("gmail") || tool.includes("email") || tool.includes("crm") || tool.includes("github")) return "company_connection";
  return "none";
}

export function getSeatManifest(role: AgentRole): SeatManifest {
  return SEAT_MANIFESTS[role];
}

function formatToolContractLine(tool: SeatToolSpec): string {
  const artifactFlag = tool.audit.storesArtifact ? "true" : "false";
  return [
    `${tool.name}: ${tool.description}`,
    `auth=${tool.authRequirement}`,
    `mode=${tool.executionMode}`,
    `approval=${tool.approvalRequired}`,
    `reversibility=${tool.reversibility}`,
    `actions=${tool.actions.join(", ")}`,
    `context=${tool.allowedContextKeys.join(", ")}`,
    `audit=${tool.audit.category}/pii:${tool.audit.pii}/artifact:${artifactFlag}`,
  ].join("; ");
}

export function buildSeatSystemPrompt(role: AgentRole): string {
  const manifest = getSeatManifest(role);
  return [
    `Role: ${manifest.name}`,
    `When to use: ${manifest.whenToUse}`,
    `When not to use: ${manifest.whenNotToUse}`,
    `Methodology. ${manifest.methodology}`,
    `Tool-use strategy. ${manifest.toolUseStrategy}`,
    `Anti-patterns. ${manifest.antiPatterns.join(" ")}`,
    `Definition of done. ${manifest.definitionOfDone}`,
    `Allowed tools. ${manifest.tools.map((tool) => `${tool.name}(${tool.reversibility})`).join(", ")}`,
    `Tool details.\n${manifest.tools.map(formatToolContractLine).join("\n")}`,
    `Tool contract. ${manifest.toolContract.join(" ")}`,
    `Context needs. ${manifest.contextNeeds.join(", ")}`,
    `Input contract. ${manifest.inputContract.join(" ")}`,
    `Output contract. ${manifest.outputContract.join(", ")}`,
    `Success criteria. ${manifest.successCriteria.join(", ")}`,
    `Handoff contract. ${manifest.handoffContract.join(" ")}`,
    `Budget contract. ${manifest.budgetContract.join(" ")}`,
    `Memory contract. ${manifest.memoryContract.join(" ")}`,
  ].join("\n");
}

export function buildSeatContextBundle(
  role: AgentRole,
  context: Record<string, unknown>
): Record<string, unknown> {
  const allowed = new Set(getSeatManifest(role).contextNeeds);
  return Object.fromEntries(Object.entries(context).filter(([key]) => allowed.has(key)));
}

export function buildOrchestratorSeatDossier(): OrchestratorSeatDossier {
  return {
    routingRule:
      "CEO routes to the smallest capable seat set and passes only need-to-know context named by each seat manifest.",
    seats: Object.values(SEAT_MANIFESTS).map((manifest) => ({
      role: manifest.role,
      name: manifest.name,
      modelTier: manifest.modelTier,
      qualityLabel: manifest.qualityLabel,
      whenToUse: manifest.whenToUse,
      whenNotToUse: manifest.whenNotToUse,
      methodology: manifest.methodology,
      toolUseStrategy: manifest.toolUseStrategy,
      contextNeeds: manifest.contextNeeds,
      inputContract: manifest.inputContract,
      toolContract: manifest.toolContract,
      outputContract: manifest.outputContract,
      successCriteria: manifest.successCriteria,
      handoffContract: manifest.handoffContract,
      budgetContract: manifest.budgetContract,
      memoryContract: manifest.memoryContract,
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        purpose: tool.purpose,
        description: tool.description,
        authRequirement: tool.authRequirement,
        allowedContextKeys: tool.allowedContextKeys,
        actions: tool.actions,
        reversibility: tool.reversibility,
        approvalRequired: tool.approvalRequired,
        previewKind: tool.previewKind,
        executionMode: tool.executionMode,
        audit: tool.audit,
      })),
    })),
  };
}
