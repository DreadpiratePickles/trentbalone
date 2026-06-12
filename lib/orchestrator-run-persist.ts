import { store } from "@/lib/store";
import type { OrchestratorEventKind, OrchestratorStep } from "@/lib/types";
import { emitOrcEvent, type OrcEvent } from "@/lib/orchestrator-events";
import type { OrchestrationCritique, OrchestrationPlan, SeatLoopResumeState, StepHandoff, StepRecord } from "@/lib/orchestrator-runtime";
import type { OrchestrationRun } from "@/lib/orchestrator";
import { cacheOrchestrationRun } from "@/lib/orchestrator-cache";
import { stepSatisfiesDependency } from "@/lib/orchestrator-step-outcome";

export async function hydrateOrchestrationRun(runId: string): Promise<OrchestrationRun | undefined> {
  const persisted = await store.getOrchestratorRun(runId).catch(() => undefined);
  if (!persisted) return undefined;
  const steps = await store.listOrchestratorSteps(runId).catch(() => []);
  const plan = await readPersistedPlan(runId);
  const run: OrchestrationRun = {
    id: persisted.id,
    companyId: persisted.companyId,
    objective: persisted.objective,
    status: persisted.status,
    plan,
    steps: steps.map(fromPersistedStep),
    summary: persisted.summary,
    startedAt: persisted.startedAt,
    completedAt: persisted.completedAt,
    trigger: persisted.trigger,
    cycleId: persisted.cycleId,
    fullTeam: plan?.steps.length ? plan.steps.length > 4 : false,
    replanCount: persisted.replanCount,
  };
  cacheOrchestrationRun(run);
  return run;
}

export function buildCompletedOutputs(steps: StepRecord[]): Record<string, string> {
  // Satisfied = upstream COMPLETED (empty output still counts). See
  // buildCompletedStepOutputs in orchestrator.ts for why output-truthiness gating
  // strands dependents and hangs the run.
  return Object.fromEntries(
    steps
      .filter(stepSatisfiesDependency)
      .map((step) => [step.id, step.output ?? ""]),
  );
}

/** §1 P1-3 — validated handoff contracts of completed steps, keyed by step id. */
export function buildCompletedHandoffs(steps: StepRecord[]): Record<string, StepHandoff> {
  return Object.fromEntries(
    steps
      .filter((step) => step.status === "completed" && step.handoff)
      .map((step) => [step.id, step.handoff as StepHandoff]),
  );
}

export async function persistSteps(run: OrchestrationRun): Promise<void> {
  await Promise.all(run.steps.map((step) => persistStep(run, step)));
}

export async function persistStep(run: OrchestrationRun, step: StepRecord): Promise<void> {
  await store.upsertOrchestratorStep(toPersistedStep(run, step)).catch(() => undefined);
  const index = run.steps.findIndex((item) => item.id === step.id);
  if (index >= 0) run.steps[index] = step;
  cacheOrchestrationRun(run);
}

export async function emitPersistedOrcEvent(run: OrchestrationRun, event: OrcEvent): Promise<void> {
  emitOrcEvent(event);
  await persistOrcEvent(run, event.kind, {
    at: event.at,
    detail: event.detail,
    run: event.run,
    step: event.step,
  }, event.step?.id).catch(() => undefined);
}

async function readPersistedPlan(runId: string): Promise<OrchestrationPlan | undefined> {
  const events = await store.listOrchestratorEvents(runId).catch(() => []);
  const planEvent = [...events].reverse().find((event) => event.kind === "plan_end");
  const plan = planEvent?.payload?.run;
  if (!plan || typeof plan !== "object" || !("plan" in plan)) return undefined;
  return (plan as { plan?: OrchestrationPlan }).plan;
}

const SEAT_LOOP_RESUME_KEY = "seatLoopResume";
const STEP_HANDOFF_KEY = "stepHandoff";

function encodeCritique(
  critique: OrchestrationCritique | undefined,
  seatLoopState: SeatLoopResumeState | undefined,
  handoff: StepHandoff | undefined,
): Record<string, unknown> | undefined {
  if (!critique && !seatLoopState && !handoff) return undefined;
  return {
    ...(critique ?? {}),
    ...(seatLoopState ? { [SEAT_LOOP_RESUME_KEY]: seatLoopState } : {}),
    ...(handoff ? { [STEP_HANDOFF_KEY]: handoff } : {}),
  };
}

function decodeCritique(critique: Record<string, unknown> | undefined): {
  critique?: OrchestrationCritique;
  seatLoopState?: SeatLoopResumeState;
  handoff?: StepHandoff;
} {
  if (!critique) return {};
  const { [SEAT_LOOP_RESUME_KEY]: seatLoopResume, [STEP_HANDOFF_KEY]: stepHandoff, ...rest } = critique;
  const hasCritique = typeof rest.verdict === "string";
  return {
    critique: hasCritique ? (rest as OrchestrationCritique) : undefined,
    seatLoopState: seatLoopResume as SeatLoopResumeState | undefined,
    handoff: stepHandoff as StepHandoff | undefined,
  };
}

function toPersistedStep(run: OrchestrationRun, step: StepRecord): OrchestratorStep {
  const index = Math.max(0, run.steps.findIndex((item) => item.id === step.id));
  return {
    id: step.id,
    runId: run.id,
    companyId: run.companyId,
    seq: index + 1,
    title: step.title,
    rationale: step.rationale,
    agentRole: step.agentRole,
    dependsOn: step.dependsOn,
    expectedOutput: step.expectedOutput,
    riskLevel: step.riskLevel,
    needsApproval: step.needsApproval,
    status: step.status,
    output: step.output,
    critique: encodeCritique(step.critique, step.seatLoopState, step.handoff),
    model: step.model,
    tokens: step.tokens,
    costCents: step.costCents,
    toolCalls: step.toolCalls,
    approvalId: step.approvalId,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  };
}

function fromPersistedStep(step: OrchestratorStep): StepRecord {
  const decoded = decodeCritique(step.critique as Record<string, unknown> | undefined);
  return {
    id: step.id,
    title: step.title,
    rationale: step.rationale,
    agentRole: step.agentRole,
    dependsOn: step.dependsOn,
    expectedOutput: step.expectedOutput,
    riskLevel: step.riskLevel as StepRecord["riskLevel"],
    needsApproval: step.needsApproval,
    status: step.status as StepRecord["status"],
    output: step.output,
    critique: decoded.critique,
    seatLoopState: decoded.seatLoopState,
    handoff: decoded.handoff,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    model: step.model,
    tokens: step.tokens,
    costCents: step.costCents,
    toolCalls: step.toolCalls,
    approvalId: step.approvalId,
  };
}

async function persistOrcEvent(
  run: OrchestrationRun,
  kind: OrchestratorEventKind,
  payload: Record<string, unknown>,
  stepId?: string,
): Promise<void> {
  await store.appendOrchestratorEvent({
    runId: run.id,
    companyId: run.companyId,
    kind,
    stepId,
    payload,
  });
}
