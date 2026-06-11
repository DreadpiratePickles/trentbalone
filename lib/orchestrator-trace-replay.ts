import type { AgentRole, OrchestratorEvent, OrchestratorRun, OrchestratorStep } from "@/lib/types";

export type OrchestratorReplayTimelineItem = {
  id: string;
  seq: number;
  kind: string;
  stepId?: string;
  title?: string;
  seat?: AgentRole;
  status?: string;
  detail?: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type OrchestratorReplaySeatReport = {
  stepId: string;
  seq: number;
  seat: AgentRole;
  title: string;
  status: OrchestratorStep["status"];
  output?: string;
  critique?: Record<string, unknown>;
  acceptanceCriteria: string[];
  costCents: number;
  toolCalls: string[];
};

export type OrchestratorReplayHandoffSummary = {
  total: number;
  nextActionCount: number;
  riskCount: number;
  notDoneCount: number;
  missingPayloadRefCount: number;
  amberOrRedCount: number;
};

export type OrchestratorTraceReplay = {
  runId: string;
  companyId: string;
  objective: string;
  status: OrchestratorRun["status"];
  trigger: OrchestratorRun["trigger"];
  budgetCents: number;
  costCents: number;
  ceoSummary?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  reconnectCursor: string;
  timeline: OrchestratorReplayTimelineItem[];
  seatReports: OrchestratorReplaySeatReport[];
  blockers: OrchestratorReplayTimelineItem[];
  errors: OrchestratorReplayTimelineItem[];
  toolLedger: { name: string; count: number }[];
  artifactRefs: string[];
  approvalRefs: string[];
  handoffSummary: OrchestratorReplayHandoffSummary;
};

export function buildOrchestratorTraceReplay(input: {
  run: OrchestratorRun;
  steps: OrchestratorStep[];
  events: OrchestratorEvent[];
}): OrchestratorTraceReplay {
  const stepsById = new Map(input.steps.map((step) => [step.id, step]));
  const sortedEvents = [...input.events].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
  const acceptanceByStep = buildAcceptanceMap(sortedEvents);
  const timeline = sortedEvents.map((event) => eventToTimelineItem(event, stepsById.get(event.stepId ?? "")));
  const seatReports = [...input.steps]
    .sort((a, b) => a.seq - b.seq)
    .map((step) => stepToSeatReport(step, acceptanceByStep.get(step.id) ?? []));
  const stepCost = seatReports.reduce((sum, report) => sum + report.costCents, 0);
  const approvalRefs = uniq(timeline.flatMap((item) => extractRefs(item.payload, ["approvalId", "approvalIds"])));
  const artifactRefs = uniq(timeline.flatMap((item) => extractRefs(item.payload, ["artifactId", "artifactIds", "artifacts"])));
  const errors = timeline.filter((item) => /failed|error/i.test(`${item.kind} ${item.status ?? ""} ${item.detail ?? ""}`));

  return {
    runId: input.run.id,
    companyId: input.run.companyId,
    objective: input.run.objective,
    status: input.run.status,
    trigger: input.run.trigger,
    budgetCents: input.run.budgetCents,
    costCents: input.run.costCents || stepCost,
    ceoSummary: input.run.summary,
    startedAt: input.run.startedAt,
    completedAt: input.run.completedAt,
    updatedAt: input.run.updatedAt,
    reconnectCursor: String(sortedEvents.at(-1)?.seq ?? 0),
    timeline,
    seatReports,
    blockers: timeline.filter((item) => /blocked|failed|approval/i.test(`${item.kind} ${item.status ?? ""} ${item.detail ?? ""}`)),
    errors,
    toolLedger: summarizeTools(seatReports),
    artifactRefs,
    approvalRefs,
    handoffSummary: summarizeHandoffs(timeline),
  };
}

function eventToTimelineItem(event: OrchestratorEvent, step?: OrchestratorStep): OrchestratorReplayTimelineItem {
  const payloadStep = readPayloadStep(event.payload);
  return {
    id: event.id,
    seq: event.seq,
    kind: event.kind,
    stepId: event.stepId,
    title: step?.title ?? payloadStep?.title,
    seat: step?.agentRole ?? payloadStep?.agentRole,
    status: step?.status ?? payloadStep?.status ?? readString(event.payload.status),
    detail:
      readString(event.payload.detail)
      ?? readString(event.payload.summary)
      ?? readString(event.payload.reason)
      ?? readString(event.payload.error)
      ?? readString(event.payload.message),
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

function stepToSeatReport(
  step: OrchestratorStep,
  acceptanceCriteria: string[],
): OrchestratorReplaySeatReport {
  return {
    stepId: step.id,
    seq: step.seq,
    seat: step.agentRole,
    title: step.title,
    status: step.status,
    output: step.output,
    critique: step.critique,
    acceptanceCriteria,
    costCents: step.costCents ?? 0,
    toolCalls: (step.toolCalls ?? []).map((call) => `${call.adapter}.${call.action}`),
  };
}

function buildAcceptanceMap(events: OrchestratorEvent[]): Map<string, string[]> {
  const byStep = new Map<string, string[]>();
  for (const event of events) {
    const run = event.payload.run;
    if (!isRecord(run)) continue;
    const plan = run.plan;
    if (!isRecord(plan) || !Array.isArray(plan.steps)) continue;
    for (const step of plan.steps) {
      if (!isRecord(step) || typeof step.id !== "string") continue;
      const spec = step.spec;
      if (!isRecord(spec) || !Array.isArray(spec.acceptance)) continue;
      const acceptance = spec.acceptance.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      byStep.set(step.id, acceptance);
    }
  }
  return byStep;
}

function readPayloadStep(payload: Record<string, unknown>): Partial<OrchestratorStep> | undefined {
  const step = payload.step;
  return step && typeof step === "object" ? step as Partial<OrchestratorStep> : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function summarizeHandoffs(timeline: OrchestratorReplayTimelineItem[]): OrchestratorReplayHandoffSummary {
  const handoffs = timeline.filter((item) => item.kind === "handoff_event");
  return handoffs.reduce<OrchestratorReplayHandoffSummary>(
    (summary, item) => {
      const payload = item.payload;
      const severity = readString(payload.severity);
      summary.total += 1;
      summary.nextActionCount += readStringList(payload.nextActions).length;
      summary.riskCount += readStringList(payload.risks).length;
      summary.notDoneCount += readStringList(payload.whatIDidNotDo).length;
      if (!readString(payload.payloadRef)) summary.missingPayloadRefCount += 1;
      if (severity === "amber" || severity === "red") summary.amberOrRedCount += 1;
      return summary;
    },
    {
      total: 0,
      nextActionCount: 0,
      riskCount: 0,
      notDoneCount: 0,
      missingPayloadRefCount: 0,
      amberOrRedCount: 0,
    },
  );
}

function summarizeTools(reports: OrchestratorReplaySeatReport[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const report of reports) {
    for (const tool of report.toolCalls) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }));
}

function extractRefs(payload: Record<string, unknown>, keys: string[]): string[] {
  const refs: string[] = [];
  for (const key of keys) collectRefs(payload[key], refs);
  return refs;
}

function collectRefs(value: unknown, refs: string[]) {
  if (typeof value === "string" && value.trim()) refs.push(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => collectRefs(item, refs));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    collectRefs(record.id ?? record.artifactId ?? record.approvalId, refs);
  }
}

function uniq(values: string[]) {
  return [...new Set(values)];
}
