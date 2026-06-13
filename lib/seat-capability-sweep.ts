import { AGENT_SLOTS, buildSlotEnvironment } from "@/lib/agent-catalog";
import { createDefaultAgents } from "@/lib/agents";
import { buildSeatEvalFixtures } from "@/lib/seat-evals";
import {
  computeSeatCapabilityGateDecision,
  latestSeatCapabilityGateDecisionFromDocuments,
  recordSeatCapabilityGateDecision,
} from "@/lib/seat-capability-gating";
import { store } from "@/lib/store";
import type { AgentQualityLabel, AgentRole, Document } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export type SeatEvalMeasurement = {
  role: AgentRole;
  score: number;
  criticFlagRate: number;
  evaluatedAt: string;
  evaluator: string;
  fixtureCount: number;
};

export type SeatCapabilitySweepResult = {
  role: AgentRole;
  status: "recorded" | "skipped";
  reason: string;
  score?: number;
  qualityLabel?: AgentQualityLabel;
  action?: string;
};

export type WeeklySeatCapabilitySweepReport = {
  companyId: string;
  evaluatedAt: string;
  recorded: number;
  skipped: number;
  results: SeatCapabilitySweepResult[];
};

const DEFAULT_QUALITY_BY_ROLE = new Map<AgentRole, AgentQualityLabel>(
  createDefaultAgents("company_template").map((agent) => [agent.role, agent.qualityLabel ?? "supervised"]),
);

export async function recordSeatEvalMeasurement(input: {
  companyId: string;
  role: AgentRole;
  score: number;
  criticFlagRate: number;
  evaluatedAt?: string;
  evaluator?: string;
  deps?: {
    store?: Pick<typeof store, "createDocument">;
  };
}): Promise<Document> {
  const targetStore = input.deps?.store ?? store;
  const measurement: SeatEvalMeasurement = {
    role: input.role,
    score: clampScore(input.score),
    criticFlagRate: clampRate(input.criticFlagRate),
    evaluatedAt: input.evaluatedAt ?? nowIso(),
    evaluator: input.evaluator ?? "seat_eval_suite",
    fixtureCount: buildSeatEvalFixtures(input.role).length,
  };
  return targetStore.createDocument({
    companyId: input.companyId,
    type: "agent_note",
    title: `Seat eval score: ${input.role}`,
    content: JSON.stringify(measurement, null, 2),
    source: seatEvalScoreSource(input.role),
    memoryTier: "semantic",
    validFrom: measurement.evaluatedAt,
  });
}

export async function runWeeklySeatCapabilityGateSweep(input: {
  companyId: string;
  atIso?: string;
  roles?: AgentRole[];
  deps?: {
    store?: Pick<typeof store, "listDocuments" | "createDocument" | "addAudit">;
  };
}): Promise<WeeklySeatCapabilitySweepReport> {
  const targetStore = input.deps?.store ?? store;
  const roles = input.roles ?? AGENT_SLOTS.map((slot) => slot.role);
  const evaluatedAt = input.atIso ?? nowIso();
  const documents = await targetStore.listDocuments(input.companyId).catch(() => []);
  const results: SeatCapabilitySweepResult[] = [];

  for (const role of roles) {
    const measurement = latestSeatEvalMeasurementFromDocuments(role, documents);
    if (!measurement) {
      results.push({
        role,
        status: "skipped",
        reason: "No measured seat eval score found; refusing to infer capability from fixture existence.",
      });
      continue;
    }

    const currentDecision = latestSeatCapabilityGateDecisionFromDocuments(role, documents);
    const environment = buildSlotEnvironment(input.companyId, role);
    const decision = computeSeatCapabilityGateDecision({
      role,
      score: measurement.score,
      criticFlagRate: measurement.criticFlagRate,
      currentQualityLabel: currentDecision?.qualityLabel ?? defaultQualityLabel(role),
      approvalRequiredFor: environment.approvalRequiredFor,
      now: () => evaluatedAt,
    });
    await recordSeatCapabilityGateDecision({
      companyId: input.companyId,
      role,
      decision,
      deps: { store: targetStore },
    });
    results.push({
      role,
      status: "recorded",
      reason: decision.reason,
      score: decision.score,
      qualityLabel: decision.qualityLabel,
      action: decision.action,
    });
  }

  return {
    companyId: input.companyId,
    evaluatedAt,
    recorded: results.filter((result) => result.status === "recorded").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    results,
  };
}

export function latestSeatEvalMeasurementFromDocuments(
  role: AgentRole,
  documents: Document[],
): SeatEvalMeasurement | undefined {
  return documents
    .filter((doc) => doc.source === seatEvalScoreSource(role) && !doc.validTo)
    .map((doc) => parseMeasurement(doc.content))
    .filter((measurement): measurement is SeatEvalMeasurement => measurement?.role === role)
    .sort((left, right) => Date.parse(right.evaluatedAt) - Date.parse(left.evaluatedAt))[0];
}

function parseMeasurement(content: string): SeatEvalMeasurement | undefined {
  try {
    const parsed = JSON.parse(content) as SeatEvalMeasurement;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (!parsed.role || typeof parsed.score !== "number" || typeof parsed.criticFlagRate !== "number") return undefined;
    return {
      ...parsed,
      score: clampScore(parsed.score),
      criticFlagRate: clampRate(parsed.criticFlagRate),
    };
  } catch {
    return undefined;
  }
}

function seatEvalScoreSource(role: AgentRole): string {
  return `seat_eval_score:${role}`;
}

function defaultQualityLabel(role: AgentRole): AgentQualityLabel {
  return DEFAULT_QUALITY_BY_ROLE.get(role) ?? "supervised";
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function clampRate(rate: number): number {
  return Math.max(0, Math.min(1, rate));
}
