import { store } from "@/lib/store";
import type { AgentEnvironmentConfig, AgentQualityLabel, AgentRole, Document } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export type SeatCapabilityGateAction = "promote" | "demote" | "hold";

export type SeatCapabilityGateDecision = {
  role: AgentRole;
  score: number;
  criticFlagRate: number;
  qualityLabel: AgentQualityLabel;
  action: SeatCapabilityGateAction;
  removedApprovalGates: string[];
  retainedApprovalGates: string[];
  reason: string;
  decidedAt: string;
};

const AUTONOMOUS_SCORE_THRESHOLD = 90;
const SUPERVISED_SCORE_THRESHOLD = 70;
const CRITIC_FLAG_DEMOTE_THRESHOLD = 0.15;
const CRITIC_FLAG_AUTONOMOUS_MAX = 0.05;

const REVERSIBLE_APPROVAL_GATES: Partial<Record<AgentRole, string[]>> = {
  engineer: ["github.issue", "github.branch"],
};

export function computeSeatCapabilityGateDecision(input: {
  role: AgentRole;
  score: number;
  criticFlagRate: number;
  currentQualityLabel: AgentQualityLabel;
  approvalRequiredFor: string[];
  now?: () => string;
}): SeatCapabilityGateDecision {
  const score = clampScore(input.score);
  const criticFlagRate = clampRate(input.criticFlagRate);
  const reversibleGates = reversibleApprovalGatesFor(input.role, input.approvalRequiredFor);
  const canAutonomize = score >= AUTONOMOUS_SCORE_THRESHOLD
    && criticFlagRate <= CRITIC_FLAG_AUTONOMOUS_MAX
    && reversibleGates.length > 0;

  const qualityLabel: AgentQualityLabel = criticFlagRate >= CRITIC_FLAG_DEMOTE_THRESHOLD
    ? "supervised"
    : score < SUPERVISED_SCORE_THRESHOLD
      ? "experimental"
      : canAutonomize
        ? "autonomous"
        : "supervised";

  const action = qualityAction(input.currentQualityLabel, qualityLabel);
  const removedApprovalGates = qualityLabel === "autonomous" ? reversibleGates : [];
  const retainedApprovalGates = input.approvalRequiredFor.filter((gate) => !removedApprovalGates.includes(gate));

  return {
    role: input.role,
    score,
    criticFlagRate,
    qualityLabel,
    action,
    removedApprovalGates,
    retainedApprovalGates,
    reason: decisionReason({ score, criticFlagRate, qualityLabel, removedApprovalGates }),
    decidedAt: input.now?.() ?? nowIso(),
  };
}

export function applySeatCapabilityGate(
  environment: AgentEnvironmentConfig,
  decision?: SeatCapabilityGateDecision | null,
): AgentEnvironmentConfig {
  if (!decision || decision.qualityLabel !== "autonomous") {
    return cloneEnvironment(environment);
  }
  const removable = new Set(decision.removedApprovalGates);
  return {
    ...cloneEnvironment(environment),
    approvalRequiredFor: environment.approvalRequiredFor.filter((gate) => !removable.has(gate)),
  };
}

export async function recordSeatCapabilityGateDecision(input: {
  companyId: string;
  role: AgentRole;
  decision: SeatCapabilityGateDecision;
  deps?: {
    store?: Pick<typeof store, "createDocument" | "addAudit">;
  };
}): Promise<Document> {
  const targetStore = input.deps?.store ?? store;
  const content = JSON.stringify(input.decision, null, 2);
  const document = await targetStore.createDocument({
    companyId: input.companyId,
    type: "agent_note",
    title: `Capability gate: ${input.role}`,
    content,
    source: capabilityGateSource(input.role),
    memoryTier: "semantic",
    validFrom: input.decision.decidedAt,
  });
  await targetStore.addAudit(
    input.companyId,
    "system",
    "agent.capability_gate",
    "agent",
    input.role,
    auditSummary(input.decision),
  );
  return document;
}

export async function loadLatestSeatCapabilityGateDecision(
  companyId: string,
  role: AgentRole,
  deps?: {
    store?: Pick<typeof store, "listDocuments">;
  },
): Promise<SeatCapabilityGateDecision | undefined> {
  const targetStore = deps?.store ?? store;
  const documents = await targetStore.listDocuments(companyId).catch(() => []);
  return latestSeatCapabilityGateDecisionFromDocuments(role, documents);
}

export function latestSeatCapabilityGateDecisionFromDocuments(
  role: AgentRole,
  documents: Document[],
): SeatCapabilityGateDecision | undefined {
  for (const doc of documents) {
    if (doc.source !== capabilityGateSource(role) || doc.validTo) continue;
    const parsed = parseDecision(doc.content);
    if (parsed?.role === role) return parsed;
  }
  return undefined;
}

export function buildSeatCapabilityGatePrompt(decision?: SeatCapabilityGateDecision): string {
  if (!decision) return "";
  return [
    "CAPABILITY GATE",
    `quality: ${decision.qualityLabel}`,
    `score: ${decision.score}`,
    `critic flag rate: ${Math.round(decision.criticFlagRate * 100)}%`,
    `action: ${decision.action}`,
    `removed approval gates: ${decision.removedApprovalGates.join(", ") || "none"}`,
    `retained approval gates: ${decision.retainedApprovalGates.join(", ") || "none"}`,
    `reason: ${decision.reason}`,
  ].join("\n");
}

function reversibleApprovalGatesFor(role: AgentRole, gates: string[]): string[] {
  const allowed = new Set(REVERSIBLE_APPROVAL_GATES[role] ?? []);
  return gates.filter((gate) => allowed.has(gate));
}

function qualityAction(
  current: AgentQualityLabel,
  next: AgentQualityLabel,
): SeatCapabilityGateAction {
  if (current !== "autonomous" && next === "autonomous") return "promote";
  if (current === "autonomous" && next !== "autonomous") return "demote";
  return "hold";
}

function decisionReason(input: {
  score: number;
  criticFlagRate: number;
  qualityLabel: AgentQualityLabel;
  removedApprovalGates: string[];
}): string {
  if (input.qualityLabel === "autonomous") {
    return `score ${input.score} crossed ${AUTONOMOUS_SCORE_THRESHOLD} with critic flags ${Math.round(input.criticFlagRate * 100)}%; reversible gates removed: ${input.removedApprovalGates.join(", ")}`;
  }
  if (input.criticFlagRate >= CRITIC_FLAG_DEMOTE_THRESHOLD) {
    return `critic flag rate ${Math.round(input.criticFlagRate * 100)}% crossed demotion threshold ${Math.round(CRITIC_FLAG_DEMOTE_THRESHOLD * 100)}%`;
  }
  return `score ${input.score} remains below autonomous threshold or no reversible gates are eligible`;
}

function auditSummary(decision: SeatCapabilityGateDecision): string {
  const verb = decision.action === "promote"
    ? "promoted to"
    : decision.action === "demote"
      ? "demoted to"
      : "held at";
  const removed = decision.removedApprovalGates.length
    ? ` Removed gates: ${decision.removedApprovalGates.join(", ")}.`
    : "";
  return `${decision.role} ${verb} ${decision.qualityLabel} (score ${decision.score}, critic flags ${Math.round(decision.criticFlagRate * 100)}%).${removed}`;
}

function capabilityGateSource(role: AgentRole): string {
  return `capability_gate:${role}`;
}

function parseDecision(content: string): SeatCapabilityGateDecision | undefined {
  try {
    const parsed = JSON.parse(content) as SeatCapabilityGateDecision;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (!parsed.role || typeof parsed.score !== "number" || !parsed.qualityLabel) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function cloneEnvironment(environment: AgentEnvironmentConfig): AgentEnvironmentConfig {
  return {
    ...environment,
    tools: [...environment.tools],
    approvalRequiredFor: [...environment.approvalRequiredFor],
    outputContract: [...environment.outputContract],
    ...(environment.skills ? { skills: [...environment.skills] } : {}),
  };
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function clampRate(rate: number): number {
  return Math.max(0, Math.min(1, rate));
}
