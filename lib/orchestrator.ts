/**
 * Trent Orchestrator — Devin-class autonomous multi-agent runtime.
 */

import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import { emitJobEvent } from "@/lib/job-events";
import { emitOrcEvent } from "@/lib/orchestrator-events";
import { buildContentMissionApprovalPacket } from "@/lib/content-mission";
import {
  auditTransition,
  saveCycleForRun,
  type OrchestrationCritique,
  type OrchestrationPlan,
  type OrchestrationStep,
  type StepRecord,
} from "@/lib/orchestrator-runtime";
import {
  applyRevisedPlanTail,
  buildEscalationReplanPrompt,
  canApplyReplan,
} from "@/lib/orchestrator-replan";
import {
  cacheOrchestrationRun,
  deleteCachedOrchestrationRun,
  getCachedOrchestrationRun,
  listCachedOrchestrationRuns,
} from "@/lib/orchestrator-cache";
import { enqueueOrchestrationPlanJob } from "@/lib/orchestrator-run-queue";
import {
  hydrateOrchestrationRun,
  resumeOrchestrationAfterApproval,
} from "@/lib/orchestrator-run-worker";
import { buildModelPolicySnapshot } from "@/lib/model-policy";

export { decideDelegation } from "@/lib/orchestrator-delegation";
export { recallRelevantMemory } from "@/lib/semantic-router";

export type {
  OrchestrationCritique,
  OrchestrationPlan,
  OrchestrationStep,
  StepRecord,
} from "@/lib/orchestrator-runtime";

const DEFAULT_ORC_MAX_CONCURRENCY = 4;

export function getOrcMaxConcurrency(): number {
  const raw = process.env.ORC_MAX_CONCURRENCY;
  if (!raw) return DEFAULT_ORC_MAX_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ORC_MAX_CONCURRENCY;
}

export function buildCompletedStepOutputs(steps: StepRecord[]): Record<string, string> {
  // A dependency is satisfied when the upstream step has COMPLETED — regardless
  // of whether its output is non-empty. Gating on a truthy output silently strands
  // any dependents of a step that legitimately completes with empty output, which
  // hangs the whole run (it never reaches consolidation).
  return Object.fromEntries(
    steps
      .filter((step) => step.status === "completed")
      .map((step) => [step.id, step.output ?? ""]),
  );
}

export function collectReadyOrchestrationSteps(steps: StepRecord[]): StepRecord[] {
  const outputs = buildCompletedStepOutputs(steps);
  return steps.filter((step) => {
    if (step.status !== "pending") return false;
    return !step.dependsOn.some((dep) => !(dep in outputs));
  });
}

export function countInFlightOrchestrationSteps(steps: StepRecord[]): number {
  return steps.filter((step) => step.status === "running" || step.status === "awaiting_approval").length;
}

export function selectReadyStepsForEnqueue(
  steps: StepRecord[],
  maxConcurrency = getOrcMaxConcurrency(),
): StepRecord[] {
  const slots = Math.max(0, maxConcurrency - countInFlightOrchestrationSteps(steps));
  if (slots === 0) return [];
  return collectReadyOrchestrationSteps(steps).slice(0, slots);
}

export type OrchestrationDagStepExecutor = (step: StepRecord) => Promise<void>;

export async function runOrchestrationDagPool(
  steps: StepRecord[],
  executeStep: OrchestrationDagStepExecutor,
  opts?: { maxConcurrency?: number },
): Promise<void> {
  const maxConcurrency = opts?.maxConcurrency ?? getOrcMaxConcurrency();
  const terminal = new Set(["completed", "failed", "blocked", "awaiting_approval"]);

  while (steps.some((step) => !terminal.has(step.status))) {
    const ready = collectReadyOrchestrationSteps(steps);
    if (!ready.length) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }

    const inFlight = countInFlightOrchestrationSteps(steps);
    const batch = ready.slice(0, Math.max(0, maxConcurrency - inFlight));
    if (!batch.length) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }

    for (const step of batch) step.status = "running";

    await Promise.all(
      batch.map(async (step) => {
        try {
          await executeStep(step);
        } catch {
          if (step.status === "running") {
            step.status = "failed";
            step.completedAt = nowIso();
          }
        }
      }),
    );
  }
}

export type OrchestrationRun = {
  id: string;
  companyId: string;
  objective: string;
  status: "planning" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  plan?: OrchestrationPlan;
  steps: StepRecord[];
  summary?: string;
  startedAt: string;
  completedAt?: string;
  trigger: "manual" | "scheduled" | "delegated" | "heartbeat";
  cycleId?: string;
  fullTeam?: boolean;
  /** Structural replans applied so far (capped by MAX_REPLANS). */
  replanCount?: number;
};

export type StepCritiqueResult =
  | { action: "pass" }
  | { action: "retry" }
  | { action: "replan_applied" }
  | { action: "escalate"; founderPrompt: string };

export async function handleStepCritique(input: {
  run: OrchestrationRun;
  stepId: string;
  critique: OrchestrationCritique;
  revisedTail?: OrchestrationStep[];
  proposedReplan?: OrchestrationPlan;
}): Promise<StepCritiqueResult> {
  const step = input.run.steps.find((item) => item.id === input.stepId);
  if (!step) return { action: "pass" };

  if (input.critique.verdict === "retry") {
    return { action: "retry" };
  }

  if (input.critique.verdict === "replan" && canApplyReplan(input.run.replanCount ?? 0) && input.revisedTail?.length) {
    step.critique = input.critique;
    input.run.steps = applyRevisedPlanTail({
      steps: input.run.steps,
      failedStepId: input.stepId,
      revisedTail: input.revisedTail,
    });
    input.run.replanCount = (input.run.replanCount ?? 0) + 1;
    await store.updateOrchestratorRun(input.run.id, { replanCount: input.run.replanCount }).catch(() => undefined);
    if (input.run.plan) {
      const completed = input.run.steps.filter((item) => item.status === "completed");
      const revisedTailIds = new Set(input.revisedTail.map((item) => item.id));
      const sanitizedTail = input.run.steps
        .filter((item) => revisedTailIds.has(item.id))
        .map((item) => ({
          id: item.id,
          title: item.title,
          rationale: item.rationale,
          agentRole: item.agentRole,
          dependsOn: item.dependsOn,
          expectedOutput: item.expectedOutput,
          riskLevel: item.riskLevel,
          needsApproval: item.needsApproval,
        }));
      input.run.plan = {
        ...input.run.plan,
        steps: [
          ...completed.map((item) => ({
            id: item.id,
            title: item.title,
            rationale: item.rationale,
            agentRole: item.agentRole,
            dependsOn: item.dependsOn,
            expectedOutput: item.expectedOutput,
            riskLevel: item.riskLevel,
            needsApproval: item.needsApproval,
          })),
          ...sanitizedTail,
        ],
        reasoning: `${input.run.plan.reasoning} Replan ${input.run.replanCount}: ${input.critique.reason}`,
      };
    }
    return { action: "replan_applied" };
  }

  if (input.critique.verdict === "replan" || input.critique.verdict === "escalate") {
    const founderPrompt = buildEscalationReplanPrompt(step, input.critique, input.proposedReplan);
    step.status = "blocked";
    step.completedAt = nowIso();
    step.critique = input.critique;
    await store.addCeoMessage({
      companyId: input.run.companyId,
      direction: "from_ceo",
      kind: "autopilot_update",
      content: founderPrompt,
    }).catch(() => undefined);
    return { action: "escalate", founderPrompt };
  }

  return { action: "pass" };
}

export function getOrchestrationRun(id: string): OrchestrationRun | undefined {
  return getCachedOrchestrationRun(id);
}

export function listOrchestrationRuns(companyId: string): OrchestrationRun[] {
  return listCachedOrchestrationRuns(companyId);
}

export async function getOrchestrationRunSnapshot(id: string): Promise<OrchestrationRun | undefined> {
  const live = getOrchestrationRun(id);
  if (live) return live;
  return hydrateOrchestrationRun(id);
}

export async function listOrchestrationRunSnapshots(companyId: string): Promise<OrchestrationRun[]> {
  const live = listOrchestrationRuns(companyId);
  const persisted = await store.listOrchestratorRuns(companyId).catch(() => []);
  const liveIds = new Set(live.map((run) => run.id));
  const hydrated = await Promise.all(
    persisted
      .filter((run) => !liveIds.has(run.id))
      .map((run) => getOrchestrationRunSnapshot(run.id)),
  );
  return [...live, ...hydrated.filter((run): run is OrchestrationRun => Boolean(run))]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function launchOrchestration(opts: {
  companyId: string;
  objective: string;
  trigger?: OrchestrationRun["trigger"];
  fullTeam?: boolean;
  /** "scheduled" when RUN CYCLE routes through the durable engine (§1 P0-1). */
  cycleKind?: "scheduled" | "ad_hoc_dag";
}): Promise<OrchestrationRun> {
  const company = await store.getCompany(opts.companyId);
  if (!company) throw new Error("Company not found");

  const runId = makeId("orc");
  const cycleTrigger = opts.trigger === "scheduled" ? "scheduled" : "manual";
  const cycleId = await saveCycleForRun(company.id, runId, opts.objective, cycleTrigger, opts.cycleKind ?? "ad_hoc_dag");
  const run: OrchestrationRun = {
    id: runId,
    companyId: opts.companyId,
    objective: opts.objective,
    status: "planning",
    steps: [],
    startedAt: nowIso(),
    trigger: opts.trigger ?? "manual",
    cycleId,
    fullTeam: opts.fullTeam ?? false,
  };
  cacheOrchestrationRun(run);
  await store.createOrchestratorRun({
    id: run.id,
    companyId: run.companyId,
    objective: run.objective,
    trigger: run.trigger,
    status: run.status,
    modelPolicy: buildModelPolicySnapshot(),
    budgetCents: company.weeklyBudgetCents ?? company.budgetCents ?? 0,
    costCents: 0,
    replanCount: 0,
    summary: undefined,
    cycleId: run.cycleId,
    startedAt: run.startedAt,
  }).catch(() => undefined);
  await persistOrcEvent(run, "snapshot", { run: snapshotRun(run) }).catch(() => undefined);
  await persistOrcEvent(run, "run_start", { run: snapshotRun(run) }).catch(() => undefined);
  await auditTransition(company.id, "run_start", runId, `Started: ${opts.objective.slice(0, 120)}`);

  emitJobEvent({
    jobRunId: runId,
    companyId: opts.companyId,
    status: "started",
    summary: `Orchestration started: ${opts.objective.slice(0, 80)}`,
    at: nowIso(),
  });

  emitOrcEvent({
    kind: "run_start",
    runId,
    at: run.startedAt,
    run: { id: run.id, objective: run.objective, status: run.status, trigger: run.trigger },
  });

  await enqueueOrchestrationPlanJob(runId, opts.companyId);
  return run;
}

export async function cancelOrchestration(runId: string): Promise<boolean> {
  const run = getOrchestrationRun(runId);
  if (!run) return cancelPersistedOrchestration(runId);
  if (run.status === "completed" || run.status === "failed") return false;
  run.status = "cancelled";
  run.completedAt = nowIso();
  cacheOrchestrationRun(run);
  await store.updateOrchestratorRun(run.id, {
    status: "cancelled",
    completedAt: run.completedAt,
    summary: "Run cancelled by user.",
  }).catch(() => undefined);
  await persistOrcEvent(run, "run_cancelled", { run: snapshotRun(run) }).catch(() => undefined);
  await rejectPendingOrchestrationApprovals(run.companyId, runId).catch(() => undefined);
  emitOrcEvent({ kind: "run_cancelled", runId: run.id, at: nowIso() });
  return true;
}

async function cancelPersistedOrchestration(runId: string): Promise<boolean> {
  const run = await store.getOrchestratorRun(runId).catch(() => undefined);
  if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return false;
  const completedAt = nowIso();
  await store.updateOrchestratorRun(run.id, {
    status: "cancelled",
    completedAt,
    summary: "Run cancelled by user.",
  });
  if (run.cycleId) {
    await store.updateCycle(run.cycleId, {
      status: "failed",
      summary: "Run cancelled by user.",
      completedAt,
    }).catch(() => undefined);
  }
  await rejectPendingOrchestrationApprovals(run.companyId, run.id).catch(() => undefined);
  await store.appendOrchestratorEvent({
    runId: run.id,
    companyId: run.companyId,
    kind: "run_cancelled",
    payload: {
      durableFallback: true,
      run: {
        id: run.id,
        status: "cancelled",
        summary: "Run cancelled by user.",
        completedAt,
      },
    },
  }).catch(() => undefined);
  emitOrcEvent({ kind: "run_cancelled", runId: run.id, at: completedAt });
  await auditTransition(run.companyId, "run_cancelled", run.id, "Run cancelled by user.").catch(() => undefined);
  deleteCachedOrchestrationRun(runId);
  return true;
}

async function rejectPendingOrchestrationApprovals(companyId: string, runId: string): Promise<void> {
  const approvals = await store.listApprovals(companyId);
  await Promise.all(
    approvals
      .filter((approval) => approval.status === "pending" && approval.toolName?.startsWith(`orchestration:${runId}:`))
      .map((approval) => store.resolveApproval(approval.id, "rejected")),
  );
}

export function buildRunMarkdownReport(
  run: OrchestrationRun,
  suggestions: Array<{ title: string; body: string }> = [],
): string {
  const engaged = Array.from(new Set(run.steps.map((step) => step.agentRole)));
  const contentMissionEvidence = run.plan
    ? buildContentMissionApprovalPacket(run.plan, run.steps)
    : "";
  const lines = [
    `# Memory Log - ${run.objective}`,
    "",
    `- Run: ${run.id}`,
    `- Status: ${run.status}`,
    `- Started: ${run.startedAt}`,
    `- Completed: ${run.completedAt ?? "in progress"}`,
    `- Seats engaged: ${engaged.join(", ") || "none"}`,
    "",
    "## CEO Summary",
    "",
    run.summary ?? "No summary produced.",
    "",
    ...(contentMissionEvidence ? [
      "## Content Mission Evidence",
      "",
      contentMissionEvidence,
      "",
    ] : []),
    "## Agent Work",
    "",
  ];

  for (const step of run.steps) {
    lines.push(
      `### ${step.agentRole} - ${step.title}`,
      "",
      `- Status: ${step.status}`,
      `- Expected: ${step.expectedOutput}`,
      `- Model: ${step.model ?? "not recorded"}`,
      `- Tokens: ${step.tokens ?? 0}`,
      `- Cost: ${step.costCents ?? 0}c`,
      step.critique ? `- Critique: ${step.critique.verdict} - ${step.critique.reason}` : "- Critique: not recorded",
      "",
      "```text",
      step.output?.trim() || "No output recorded.",
      "```",
      "",
    );
  }

  if (run.plan?.blockers.length) {
    lines.push("## Blockers", "", ...run.plan.blockers.map((blocker) => `- ${blocker}`), "");
  }

  if (suggestions.length) {
    lines.push(
      "## Suggestions — Next Actions",
      "",
      ...suggestions.map((s) => `- **${s.title}** — ${s.body}`),
      "",
    );
  }

  return lines.join("\n");
}

export async function approveStep(runId: string, stepId: string): Promise<boolean> {
  return resumeOrchestrationAfterApproval(runId, stepId, "approved");
}

export async function rejectStep(runId: string, stepId: string): Promise<boolean> {
  return resumeOrchestrationAfterApproval(runId, stepId, "rejected");
}


function snapshotRun(run: OrchestrationRun): Record<string, unknown> {
  return {
    id: run.id,
    companyId: run.companyId,
    objective: run.objective,
    status: run.status,
    trigger: run.trigger,
    cycleId: run.cycleId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    summary: run.summary,
    plan: run.plan,
    steps: run.steps,
  };
}

async function persistOrcEvent(
  run: OrchestrationRun,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await store.appendOrchestratorEvent({
    runId: run.id,
    companyId: run.companyId,
    kind,
    payload,
  });
}
