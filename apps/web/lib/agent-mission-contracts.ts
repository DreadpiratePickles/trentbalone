import { z } from "zod";
import type { AgentRole } from "@/lib/types";
import { getSeatManifest, type SeatToolSpec } from "@/lib/seat-manifest";

export type MissionApprovalLevel = "none" | "required";

export type MissionSeatContract = {
  role: AgentRole;
  inputContextKeys: string[];
  allowedTools: string[];
  outputSchema: z.ZodTypeAny;
  outputFields: string[];
  successCriteria: string[];
  handoffRules: string[];
  approvalRules: string[];
  memoryRules: string[];
  budgetCapCents: number;
  timeCapMs: number;
};

export type MissionInputContract = {
  objective: string;
  missionType: string;
  contextKeys: string[];
};

export type MissionOutputContract = {
  role: AgentRole;
  fields: string[];
};

export type MissionMemoryContract = {
  readsOnStart: string[];
  writesOnFinish: string[];
};

export const REQUIRED_MISSION_SEATS: AgentRole[] = [
  "ceo",
  "analyst",
  "growth",
  "content",
  "finance",
  "support",
  "sales",
  "escalation",
  "engineer",
];

// Maps the mission's external action gates to whether human approval is mandatory.
export const MISSION_APPROVAL_POLICY: Record<string, MissionApprovalLevel> = {
  public_publish: "required",
  comment_or_dm_reply: "required",
  email_or_sales_send: "required",
  paid_spend_or_boost: "required",
  platform_auth_or_scope_gap: "required",
};

const stringList = z.array(z.string().min(1)).min(1);

const SEAT_OUTPUT_SCHEMAS: Record<AgentRole, z.ZodTypeAny> = {
  analyst: z.object({
    trendSignals: stringList,
    viralFormats: stringList,
    competitorFindings: stringList,
    audienceInsights: stringList,
    recommendedAngles: stringList,
  }),
  growth: z.object({
    campaignHypothesis: z.string().min(1),
    channels: stringList,
    distributionPlan: z.string().min(1),
    adPlanDraft: z.string().optional(),
    successMetrics: stringList,
  }),
  content: z.object({
    contentBriefs: stringList,
    scripts: stringList,
    captions: stringList,
    creativeAssets: z.array(z.string()),
    publishingDrafts: z.array(z.string()),
  }),
  finance: z.object({
    spendLimit: z.number().nonnegative(),
    approvedBudgetCents: z.number().nonnegative(),
    blockedReasons: z.array(z.string()),
    roiAssumptions: stringList,
  }),
  support: z.object({
    replyGuidelines: stringList,
    dmTriageRules: stringList,
    escalationTriggers: stringList,
  }),
  sales: z.object({
    leadCriteria: stringList,
    outreachDrafts: z.array(z.string()),
    crmActionsDraft: z.array(z.string()),
  }),
  escalation: z.object({
    riskFindings: z.array(z.string()),
    complianceIssues: z.array(z.string()),
    approvalRecommendation: z.string().min(1),
  }),
  ceo: z.object({
    missionSummary: z.string().min(1),
    approvalPacket: stringList,
    finalDecision: z.string().min(1),
    nextActions: stringList,
  }),
  engineer: z.object({
    integrationPlan: stringList,
    diffSummary: z.string().optional(),
    riskNotes: z.array(z.string()),
  }),
};

function outputFieldsOf(schema: z.ZodTypeAny): string[] {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  return Object.keys(shape);
}

function buildContract(
  role: AgentRole,
  overrides: { budgetCapCents: number; timeCapMs: number; successCriteria: string[] },
): MissionSeatContract {
  const manifest = getSeatManifest(role);
  const schema = SEAT_OUTPUT_SCHEMAS[role];
  return {
    role,
    inputContextKeys: manifest.contextNeeds,
    allowedTools: manifest.tools.map((tool) => tool.name),
    outputSchema: schema,
    outputFields: outputFieldsOf(schema),
    successCriteria: overrides.successCriteria,
    handoffRules: manifest.handoffContract,
    approvalRules: manifest.toolContract,
    memoryRules: manifest.memoryContract,
    budgetCapCents: overrides.budgetCapCents,
    timeCapMs: overrides.timeCapMs,
  };
}

export const MISSION_SEAT_CONTRACTS: Record<AgentRole, MissionSeatContract> = {
  ceo: buildContract("ceo", {
    budgetCapCents: 2000,
    timeCapMs: 120000,
    successCriteria: ["coherent approval packet", "explicit final decision", "named next actions"],
  }),
  analyst: buildContract("analyst", {
    budgetCapCents: 1500,
    timeCapMs: 90000,
    successCriteria: ["cited trend signals", "concrete viral formats", "audience grounding"],
  }),
  growth: buildContract("growth", {
    budgetCapCents: 1500,
    timeCapMs: 90000,
    successCriteria: ["testable hypothesis", "channel fit", "measurable success metrics"],
  }),
  content: buildContract("content", {
    budgetCapCents: 1500,
    timeCapMs: 90000,
    successCriteria: ["on-brand drafts", "platform-ready variants", "drafts stay unpublished"],
  }),
  finance: buildContract("finance", {
    budgetCapCents: 1000,
    timeCapMs: 60000,
    successCriteria: ["spend cap enforced", "ROI assumptions stated", "money movement gated"],
  }),
  support: buildContract("support", {
    budgetCapCents: 800,
    timeCapMs: 60000,
    successCriteria: ["clear triage rules", "safe escalation triggers", "no unapproved sends"],
  }),
  sales: buildContract("sales", {
    budgetCapCents: 1000,
    timeCapMs: 60000,
    successCriteria: ["ICP-fit lead criteria", "specific outreach drafts", "no unapproved send"],
  }),
  escalation: buildContract("escalation", {
    budgetCapCents: 800,
    timeCapMs: 60000,
    successCriteria: ["risk recall", "compliance findings", "clear approval recommendation"],
  }),
  engineer: buildContract("engineer", {
    budgetCapCents: 2000,
    timeCapMs: 120000,
    successCriteria: ["scoped integration plan", "minimal diff", "rollback noted"],
  }),
};

export function getMissionSeatContract(role: AgentRole): MissionSeatContract {
  return MISSION_SEAT_CONTRACTS[role];
}

// Invariant: every tool a mission seat may use that performs an external write must require approval.
export function findExternalWriteToolsMissingApproval(): string[] {
  const offenders: string[] = [];
  for (const contract of Object.values(MISSION_SEAT_CONTRACTS)) {
    const manifest = getSeatManifest(contract.role);
    const byName = new Map<string, SeatToolSpec>(manifest.tools.map((tool) => [tool.name, tool]));
    for (const toolName of contract.allowedTools) {
      const tool = byName.get(toolName);
      if (!tool) continue;
      if (tool.executionMode === "external_write" && !tool.approvalRequired) {
        offenders.push(`${contract.role}:${toolName}`);
      }
    }
  }
  return offenders;
}
