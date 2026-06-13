import { store } from "@/lib/store";
import type { AgentRole, Company, ToolCallRecord } from "@/lib/types";
import { ceoChatResponse } from "@/lib/ai";
import { makeId, nowIso } from "@/lib/utils";
import { emitJobEvent } from "@/lib/job-events";
import { writeEpisodicMemory } from "@/lib/memory-tiers";
import { buildContentMissionApprovalRequests } from "@/lib/content-mission-approvals";
import {
  finalizeContentMissionRun,
  recordContentMissionRun,
  syncContentMissionActionApprovals,
} from "@/lib/content-mission-store";
import { persistContentMissionMemoryLog } from "@/lib/content-mission-memory-log";
import {
  auditTransition,
  consolidateRun,
  createApprovalForSeatTool,
  createApprovalForStep,
  createTaskForStep,
  critiqueStepOutput,
  executeStepWithRuntime,
  generateOrchestrationPlan,
  SeatLoopAwaitingApprovalError,
  type StepHandoff,
  type StepRecord,
} from "@/lib/orchestrator-runtime";
import { reviseOrchestrationPlanTail } from "@/lib/orchestrator-replan";
import { buildDelegatedStepsForWorkRequests } from "@/lib/orchestrator-delegation";
import { recallRelevantMemory } from "@/lib/semantic-router";
import { buildOperatingStateBundle } from "@/lib/operating-state";
import { persistCeoDecisionJournal } from "@/lib/ceo-decision-journal";
import { persistSeatRegistryMemory } from "@/lib/seat-memory-registries";
import { assembleMorningBriefing } from "@/lib/scheduler";
import { recordHandoff, type HandoffEvent } from "@/lib/planner";
import { handleStepCritique, type OrchestrationRun } from "@/lib/orchestrator";
import { cacheOrchestrationRun } from "@/lib/orchestrator-cache";
import {
  buildCompletedHandoffs,
  buildCompletedOutputs,
  emitPersistedOrcEvent,
  persistStep,
  persistSteps,
} from "@/lib/orchestrator-run-persist";
import { enqueueReadyOrchestrationSteps } from "@/lib/orchestrator-run-queue";
import { isFatalStepOutcome } from "@/lib/orchestrator-step-outcome";

export function buildRecordedHandoffEvent(input: {
  cycleId: string;
  depId: string;
  stepId: string;
  from: AgentRole;
  to: AgentRole;
  toStepTitle: string;
  handoff: StepHandoff;
  timestamp: string;
}): HandoffEvent {
  return {
    cycleId: input.cycleId,
    from: input.from,
    to: input.to,
    reason: `structured handoff ${input.depId} → ${input.stepId}`,
    severity: "green",
    summary: input.handoff.summary,
    nextActions: input.handoff.nextActions.length ? input.handoff.nextActions : [input.toStepTitle],
    risks: input.handoff.risks,
    payloadRef: input.handoff.artifactRefs[0] ?? `step:${input.depId}`,
    whatIDidNotDo: input.handoff.whatIDidNotDo,
    contractVersion: input.handoff.contractVersion,
    timestamp: input.timestamp,
  };
}

export function buildSeatToolApprovalRequest(
  err: SeatLoopAwaitingApprovalError,
): { adapter: string; action: string; summary: string } | undefined {
  const pending = err.seatLoopState.pendingToolCall;
  const pendingRecord = [...err.toolCalls]
    .reverse()
    .find((record: ToolCallRecord) =>
      record.status === "needs_approval"
      && record.adapter.toLowerCase() === pending.name.toLowerCase()
      && record.action === pending.action,
    );
  if (!pendingRecord) return undefined;
  return {
    adapter: pending.name,
    action: pending.action,
    summary: pendingRecord.summary,
  };
}

async function markRunAwaitingApproval(
  run: OrchestrationRun,
  step: StepRecord,
  detail = `Awaiting approval: ${step.title}`,
): Promise<void> {
  run.status = "awaiting_approval";
  cacheOrchestrationRun(run);
  await store.updateOrchestratorRun(run.id, { status: "awaiting_approval" }).catch(() => undefined);
  await emitPersistedOrcEvent(run, {
    kind: "run_awaiting_approval",
    runId: run.id,
    at: nowIso(),
    detail,
    run: {
      id: run.id,
      status: run.status,
      summary: detail,
    },
    step,
  });
}

export async function processPlanPhase(run: OrchestrationRun, company: Company): Promise<void> {
  await emitPersistedOrcEvent(run, { kind: "plan_start", runId: run.id, at: nowIso() });
  const recalled = await recallRelevantMemory(company.id, run.objective, { k: 5, tokenBudget: 1200 });
  const memory = recalled.text;
  // §1 P0-2 — plan from the REAL operating state (open/stale tasks, pending
  // approvals, budget vs burn, last cycle), not from amnesia.
  const stateBundle = await buildOperatingStateBundle(company, run.objective).catch(() => null);
  const plan = await generateOrchestrationPlan(company, run.objective, memory, {
    fullTeam: run.fullTeam,
    runId: run.id,
    operatingState: stateBundle?.text,
  });
  run.plan = plan;
  run.steps = plan.steps.map((step) => ({ ...step, status: "pending" }));
  run.status = "running";
  await store.updateOrchestratorRun(run.id, { status: run.status }).catch(() => undefined);
  await persistSteps(run);
  cacheOrchestrationRun(run);

  emitJobEvent({
    jobRunId: run.id,
    companyId: run.companyId,
    status: "step",
    summary: `Plan ready — ${plan.steps.length} steps`,
    at: nowIso(),
    step: { phase: "plan_end", label: "plan ready" },
  });
  await emitPersistedOrcEvent(run, { kind: "plan_end", runId: run.id, at: nowIso(), run: { plan, steps: run.steps } });
  await enqueueReadyOrchestrationSteps(run);
}

export async function processExecuteStepPhase(run: OrchestrationRun, company: Company, stepId: string): Promise<void> {
  const step = run.steps.find((item) => item.id === stepId);
  if (!step) return;
  if (step.status === "completed" || step.status === "failed") {
    await enqueueReadyOrchestrationSteps(run);
    return;
  }

  const outputs = buildCompletedOutputs(run.steps);
  const handoffs = buildCompletedHandoffs(run.steps);
  const unmet = step.dependsOn.find((dep) => !(dep in outputs));
  if (unmet) {
    const depStep = run.steps.find((item) => item.id === unmet);
    // A fatal dependency will never produce usable output. Marking this step
    // "blocked" would strand it (the scheduler only re-selects "pending" steps),
    // silently dropping it from the final brief. Degraded-but-usable failures
    // satisfy dependencies via buildCompletedOutputs(); truly fatal ones cascade.
    if (depStep && isFatalStepOutcome(depStep)) {
      step.status = "failed";
      step.completedAt = nowIso();
      step.output = `Skipped — dependency "${depStep.title}" failed.`;
      if (step.taskId) await store.updateTask(step.taskId, { status: "failed" }).catch(() => undefined);
      await persistStep(run, step);
      await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: nowIso(), step });
      await enqueueReadyOrchestrationSteps(run);
      return;
    }
    step.status = "blocked";
    await persistStep(run, step);
    await emitPersistedOrcEvent(run, { kind: "step_blocked", runId: run.id, at: nowIso(), step });
    await enqueueReadyOrchestrationSteps(run);
    return;
  }

  if (step.needsApproval) {
    if (!step.approvalId) {
      const approval = await createApprovalForStep(company, run.id, step);
      step.status = "awaiting_approval";
      step.approvalId = approval.id;
      await persistStep(run, step);
      await auditTransition(run.companyId, "step_start", run.id, `Awaiting approval: ${step.title}`);
      await emitPersistedOrcEvent(run, { kind: "step_awaiting_approval", runId: run.id, at: nowIso(), step });
      await markRunAwaitingApproval(run, step);
      emitJobEvent({
        jobRunId: run.id,
        companyId: run.companyId,
        status: "step",
        summary: `${step.agentRole} awaiting approval: ${step.title}`,
        at: nowIso(),
        step: { phase: "approval_required", role: step.agentRole, label: step.title },
      });
      return;
    }
    const approval = await store.getApproval(step.approvalId).catch(() => undefined);
    if (approval?.status === "pending") {
      step.status = "awaiting_approval";
      await persistStep(run, step);
      await markRunAwaitingApproval(run, step);
      return;
    }
    if (approval?.status === "rejected") {
      await enqueueReadyOrchestrationSteps(run);
      return;
    }
  }

  if (run.status === "awaiting_approval") {
    run.status = "running";
    cacheOrchestrationRun(run);
    await store.updateOrchestratorRun(run.id, { status: "running" }).catch(() => undefined);
  }

  step.status = "running";
  step.startedAt = step.startedAt ?? nowIso();
  const stepTask = await createTaskForStep(run.companyId, run.id, step).catch(() => undefined);
  step.taskId = stepTask?.id;
  await persistStep(run, step);
  await auditTransition(run.companyId, "step_start", run.id, `${step.agentRole}: ${step.title}`);
  await emitPersistedOrcEvent(run, { kind: "step_start", runId: run.id, at: nowIso(), step });

  // §1 P1-3 — audit every structured-handoff edge this step consumes.
  await Promise.all(
    step.dependsOn
      .filter((dep) => dep in handoffs)
      .map((dep) => {
        const depStep = run.steps.find((item) => item.id === dep);
        return recordHandoff(run.companyId, buildRecordedHandoffEvent({
          cycleId: run.cycleId ?? run.id,
          depId: dep,
          stepId: step.id,
          from: depStep?.agentRole ?? "ceo",
          to: step.agentRole,
          toStepTitle: step.title,
          handoff: handoffs[dep],
          timestamp: nowIso(),
        })).catch(() => undefined);
      }),
  );

  emitJobEvent({
    jobRunId: run.id,
    companyId: run.companyId,
    status: "step",
    summary: `${step.agentRole} → ${step.title}`,
    at: nowIso(),
    step: { phase: "agent_start", role: step.agentRole, label: step.title },
  });

  const approvalGranted = Boolean(step.approvalId);
  try {
    const exec = await executeStepWithRuntime({
      step,
      company,
      previousOutputs: outputs,
      previousHandoffs: handoffs,
      cycleId: run.cycleId,
      approvalGranted,
      resumeSeed: step.seatLoopState,
      objective: run.objective,
    });
    step.output = exec.output;
    step.handoff = exec.handoff;
    step.model = exec.model;
    step.tokens = exec.tokens;
    step.costCents = exec.costCents;
    step.toolCalls = exec.toolCalls;
    await persistStep(run, step);
    await store.saveExecution(exec.execution);

    if (exec.maxStepsReached) {
      step.status = "failed";
      step.completedAt = nowIso();
      step.output = exec.output;
      step.seatLoopState = undefined;
      if (step.taskId) await store.updateTask(step.taskId, { status: "failed" }).catch(() => undefined);
      await persistStep(run, step);
      await emitPersistedOrcEvent(run, { kind: "step_output", runId: run.id, at: nowIso(), step });
      await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: nowIso(), step });
      await enqueueReadyOrchestrationSteps(run);
      return;
    }

    const upstreamHandoffs = step.dependsOn.map((dep) => handoffs[dep]).filter((handoff): handoff is StepHandoff => Boolean(handoff));
    const critiqueResult = await critiqueStepOutput(step, exec.output, { companyId: run.companyId, runId: run.id }, upstreamHandoffs);
    step.critique = critiqueResult;
    await persistStep(run, step);

    let effectiveCritique = critiqueResult;
    if (critiqueResult.verdict === "retry") {
      const exec2 = await executeStepWithRuntime({
        step: { ...step, expectedOutput: `${step.expectedOutput}\nImprovement: ${critiqueResult.improvement ?? "tighten the result"}` },
        company,
        previousOutputs: outputs,
        previousHandoffs: handoffs,
        cycleId: run.cycleId,
        approvalGranted,
        objective: run.objective,
      });
      await store.saveExecution(exec2.execution);
      step.model = exec2.model;
      step.output = exec2.output;
      step.handoff = exec2.handoff;
      step.tokens = (step.tokens ?? 0) + exec2.tokens;
      step.costCents = (step.costCents ?? 0) + exec2.costCents;
      step.toolCalls = [...(step.toolCalls ?? []), ...exec2.toolCalls];
      await persistStep(run, step);

      // RC2 invariant (Fix Plan Slice 1): a critic 'retry' is NOT a pass.
      // The revised output must be critiqued again; a second failure marks
      // the step failed (degraded) instead of silently completing.
      const recheck = await critiqueStepOutput(step, exec2.output, { companyId: run.companyId, runId: run.id }, upstreamHandoffs);
      step.critique = recheck;
      effectiveCritique = recheck;
      await persistStep(run, step);
      if (recheck.verdict === "retry") {
        const hasUsableOutput = Boolean(step.output?.trim());
        step.status = hasUsableOutput ? "completed" : "failed";
        step.completedAt = nowIso();
        step.output = [
          step.output ?? "",
          "",
          `DEGRADED: output failed critic review twice (${recheck.reason}). Founder review recommended.`,
        ].join("\n");
        step.seatLoopState = undefined;
        if (step.taskId) {
          await store.updateTask(step.taskId, { status: hasUsableOutput ? "completed" : "failed" }).catch(() => undefined);
        }
        await persistStep(run, step);
        await emitPersistedOrcEvent(run, { kind: "step_critic", runId: run.id, at: nowIso(), step });
        await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: nowIso(), step });
        await enqueueReadyOrchestrationSteps(run);
        return;
      }
    }
    if (effectiveCritique.verdict === "replan" || effectiveCritique.verdict === "escalate") {
      if (shouldCompleteAfterCriticInfrastructureFailure(step, effectiveCritique)) {
        step.status = "completed";
        step.completedAt = nowIso();
        step.output = [
          step.output ?? "",
          "",
          `DEGRADED: critic infrastructure failed after completed tool-backed work (${effectiveCritique.reason}). Founder review recommended, but the completed tool evidence remains usable for downstream steps.`,
        ].join("\n");
        step.seatLoopState = undefined;
        if (step.taskId) await store.updateTask(step.taskId, { status: "completed" }).catch(() => undefined);
        await persistStep(run, step);
        await persistSeatRegistryMemory({
          companyId: run.companyId,
          runId: run.id,
          step,
        }).catch(() => undefined);
        await emitPersistedOrcEvent(run, { kind: "step_output", runId: run.id, at: nowIso(), step });
        await emitPersistedOrcEvent(run, { kind: "step_critic", runId: run.id, at: nowIso(), step });
        await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: nowIso(), step });
        await enqueueReadyOrchestrationSteps(run);
        return;
      }
      const recalled = await recallRelevantMemory(company.id, run.objective, { k: 5, tokenBudget: 1200 });
      const completedSteps = run.steps.filter((item) => item.status === "completed");
      const proposedReplan = run.plan
        ? await reviseOrchestrationPlanTail(company, run.objective, recalled.text, {
            plan: run.plan,
            completedSteps,
            failedStep: { ...step, output: step.output ?? exec.output },
            critique: effectiveCritique,
          })
        : undefined;
      const completedIds = new Set(completedSteps.map((item) => item.id));
      const revisedTail = proposedReplan?.steps.filter((item) => !completedIds.has(item.id));
      const critiqueOutcome = await handleStepCritique({
        run,
        stepId: step.id,
        critique: effectiveCritique,
        revisedTail,
        proposedReplan,
      });
      await persistSteps(run);
      cacheOrchestrationRun(run);
      await emitPersistedOrcEvent(run, { kind: "step_critic", runId: run.id, at: nowIso(), step });
      if (critiqueOutcome.action === "replan_applied") {
        await emitPersistedOrcEvent(run, { kind: "plan_end", runId: run.id, at: nowIso(), run: { plan: run.plan, steps: run.steps, replanCount: run.replanCount } });
        await enqueueReadyOrchestrationSteps(run);
        return;
      }
      if (critiqueOutcome.action === "escalate") {
        await enqueueReadyOrchestrationSteps(run);
        return;
      }
    }

    step.status = "completed";
    step.completedAt = nowIso();
    step.seatLoopState = undefined;
    if (step.taskId) await store.updateTask(step.taskId, { status: "completed" }).catch(() => undefined);
    await persistStep(run, step);
    await persistSeatRegistryMemory({
      companyId: run.companyId,
      runId: run.id,
      step,
    }).catch(() => undefined);
    await emitPersistedOrcEvent(run, { kind: "step_output", runId: run.id, at: nowIso(), step });
    await emitPersistedOrcEvent(run, { kind: "step_critic", runId: run.id, at: nowIso(), step });
    await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: nowIso(), step });

    const workReqs = exec.workRequests ?? [];
    if (workReqs.length > 0) {
      const insertIdx = run.steps.findIndex((item) => item.id === step.id) + 1;
      const delegated = await buildDelegatedStepsForWorkRequests({
        runId: run.id,
        companyId: run.companyId,
        sourceStep: step,
        existingSteps: run.steps,
        requests: workReqs,
        makeIdFn: makeId,
      });
      run.steps.splice(insertIdx, 0, ...delegated.steps);
      for (const newStep of delegated.steps) {
        await persistStep(run, newStep);
        await emitPersistedOrcEvent(run, { kind: "step_pending", runId: run.id, at: nowIso(), step: newStep });
      }
    }
    cacheOrchestrationRun(run);
    await enqueueReadyOrchestrationSteps(run);
  } catch (err) {
    if (err instanceof SeatLoopAwaitingApprovalError) {
      const approvalRequest = buildSeatToolApprovalRequest(err);
      if (!approvalRequest) {
        step.status = "failed";
        step.completedAt = nowIso();
        step.output = "Step failed because the seat loop paused for approval without a matching needs-approval tool record.";
        step.seatLoopState = undefined;
        step.toolCalls = err.toolCalls;
        step.tokens = err.tokens;
        step.costCents = err.costCents;
        step.model = err.model;
        if (step.taskId) await store.updateTask(step.taskId, { status: "failed" }).catch(() => undefined);
        await persistStep(run, step);
        await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: nowIso(), step });
        await enqueueReadyOrchestrationSteps(run);
        return;
      }
      const approval = await createApprovalForSeatTool(company, run.id, step, approvalRequest);
      step.status = "awaiting_approval";
      step.approvalId = approval.id;
      step.seatLoopState = err.seatLoopState;
      step.toolCalls = err.toolCalls;
      step.tokens = err.tokens;
      step.costCents = err.costCents;
      step.model = err.model;
      if (step.taskId) {
        await store.updateTask(step.taskId, { status: "waiting_approval" }).catch(() => undefined);
      }
      await persistStep(run, step);
      await auditTransition(run.companyId, "step_start", run.id, `Awaiting tool approval: ${step.title}`);
      await emitPersistedOrcEvent(run, { kind: "step_awaiting_approval", runId: run.id, at: nowIso(), step });
      await markRunAwaitingApproval(run, step, `Awaiting tool approval: ${step.title}`);
      emitJobEvent({
        jobRunId: run.id,
        companyId: run.companyId,
        status: "step",
        summary: `${step.agentRole} awaiting tool approval: ${err.seatLoopState.pendingToolCall.name}`,
        at: nowIso(),
        step: { phase: "approval_required", role: step.agentRole, label: step.title },
      });
      return;
    }

    step.status = "failed";
    step.completedAt = nowIso();
    step.output = err instanceof Error ? err.message : "Step failed.";
    step.seatLoopState = undefined;
    if (step.taskId) await store.updateTask(step.taskId, { status: "failed" }).catch(() => undefined);
    await persistStep(run, step);
    await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: nowIso(), step });
    await enqueueReadyOrchestrationSteps(run);
  }
}

function shouldCompleteAfterCriticInfrastructureFailure(
  step: StepRecord,
  critique: { verdict: string; reason?: string },
) {
  if (critique.verdict !== "escalate") return false;
  if (!/critic LLM call failed|schema validation|failed schema/i.test(critique.reason ?? "")) return false;
  if (!step.output?.trim()) return false;
  if (step.riskLevel === "high") return false;
  return true;
}

export async function processConsolidatePhase(run: OrchestrationRun, company: Company): Promise<void> {
  if (!run.plan) return;
  await emitPersistedOrcEvent(run, { kind: "consolidate_start", runId: run.id, at: nowIso() });
  run.summary = await consolidateRun(run.plan, run.steps, { companyId: run.companyId, runId: run.id });

  // Fix Plan Slice 1 (approval semantics): when the brief asks the founder to
  // approve something, back it with a REAL approval record — never imply an
  // approval gate that doesn't exist. If creation fails, relabel as review.
  if (run.summary && /\bfounder\b[^.\n]{0,80}\bapprov/i.test(run.summary)) {
    const approval = await store.createApproval({
      companyId: run.companyId,
      action: `Review run output: ${run.objective.slice(0, 120)}`,
      reason: "The consolidated brief asks for founder approval of this run's output.",
      previewContent: run.summary.slice(0, 2000),
      previewKind: "generic",
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      toolName: `orchestration:${run.id}:consolidated`,
    }).catch(() => undefined);
    run.summary = approval
      ? `${run.summary}\n\n[Approval ${approval.id} created — pending in the Approvals queue.]`
      : `${run.summary}\n\n[FOR REVIEW: no approval record could be created — treat the ask above as informal review, not a gate.]`;
  }

  run.status = hasFatalOrchestrationOutcome(run.steps) ? "failed" : "completed";
  run.completedAt = nowIso();
  await store.updateOrchestratorRun(run.id, {
    status: run.status,
    summary: run.summary,
    completedAt: run.completedAt,
    costCents: run.steps.reduce((total, step) => total + (step.costCents ?? 0), 0),
  }).catch(() => undefined);
  cacheOrchestrationRun(run);

  const allTasks = await store.listTasks(run.companyId).catch(() => []);
  const followUp = await ceoChatResponse(
    company,
    [],
    `You just finished ${run.fullTeam ? "a full autonomous company run across every seat" : "an ad-hoc orchestration"}. ` +
      `Based on what the agents produced, propose concrete next actions and flag anything the founder must do personally.`,
    { tasks: allTasks, lastCycle: undefined },
  ).catch(() => null);
  const suggestions = followUp?.suggestions ?? [];
  await Promise.all(
    suggestions.map((suggestion) => store.addCeoSuggestion({ companyId: run.companyId, ...suggestion })),
  ).catch(() => {});
  await persistCeoDecisionJournal(run, suggestions).catch(() => {});

  const { buildRunMarkdownReport } = await import("@/lib/orchestrator") as typeof import("@/lib/orchestrator");
  const markdownReport = buildRunMarkdownReport(run, suggestions);
  await emitPersistedOrcEvent(run, { kind: "consolidate_end", runId: run.id, at: nowIso(), run: { summary: run.summary, status: run.status } });

  const actionApprovals = buildContentMissionApprovalRequests({
    companyId: run.companyId,
    runId: run.id,
    plan: run.plan,
    steps: run.steps,
  });
  await Promise.all(actionApprovals.map((approval) => store.createApproval(approval))).catch(() => undefined);

  const runStatus = run.status === "completed" ? "completed" : "failed";
  const missionCostCents = run.steps.reduce((total, step) => total + (step.costCents ?? 0), 0);
  const persistedRun = await store.getOrchestratorRun(run.id).catch(() => undefined);
  const mission = await recordContentMissionRun({
    companyId: run.companyId,
    runId: run.id,
    cycleId: run.cycleId,
    plan: run.plan,
    steps: run.steps,
    budgetCents: persistedRun?.budgetCents ?? 0,
    status: runStatus,
  }).catch(() => null);
  if (mission) {
    const approvals = await store.listApprovals(run.companyId).catch(() => []);
    await syncContentMissionActionApprovals({ runId: run.id, approvals }).catch(() => undefined);
    await finalizeContentMissionRun({
      runId: run.id,
      status: runStatus,
      summary: run.summary,
      costCents: missionCostCents,
    }).catch(() => undefined);
    await persistContentMissionMemoryLog(run.id, {
      plan: run.plan,
      steps: run.steps,
      finalSummary: run.summary,
    }).catch(() => undefined);
  }

  await store.createDocument({
    companyId: run.companyId,
    type: "weekly_report",
    title: `Orchestration · ${run.objective.slice(0, 60)}`,
    content: run.summary,
    source: `orchestration:${run.id}`,
    version: 1,
  }).catch(() => {});

  const memoryLogDocument = await store.createDocument({
    companyId: run.companyId,
    type: "agent_note",
    title: `Memory log · ${run.objective.slice(0, 60)}`,
    content: markdownReport,
    source: `orchestration:${run.id}:memory-log.md`,
    version: 1,
    memoryTier: "episodic",
    validFrom: run.completedAt,
  }).catch(() => {});

  if (memoryLogDocument) {
    await store.createArtifact({
      companyId: run.companyId,
      sourceCycleId: run.cycleId ?? run.id,
      sourceDocumentId: memoryLogDocument.id,
      type: "operating_memo",
      status: "ready",
      title: `Memory log · ${run.objective.slice(0, 60)}`,
      summary: `Full orchestration memory log for ${run.objective}`,
      content: markdownReport,
      exportFormat: "markdown",
      storageKey: `orchestration/${run.id}/memory-log.md`,
      createdByAgent: "ceo",
      provenance: {
        prompt: run.objective,
        sources: [
          `orchestrator:${run.id}`,
          ...run.steps.map((item) => `step:${item.id}:${item.agentRole}`),
        ],
        model: "orchestrator-runtime",
        tokens: run.steps.reduce((total, item) => total + (item.tokens ?? 0), 0),
        costCents: run.steps.reduce((total, item) => total + (item.costCents ?? 0), 0),
        generatedAt: run.completedAt ?? nowIso(),
      },
    }).catch(() => {});
  }

  await store.addCeoMessage({
    companyId: run.companyId,
    direction: "from_ceo",
    kind: "autopilot_update",
    content: markdownReport,
  }).catch(() => {});

  const memoryTrigger = run.trigger === "scheduled" ? "scheduled" : "manual";
  await writeEpisodicMemory({
    companyId: run.companyId,
    cycleId: run.cycleId ?? run.id,
    trigger: memoryTrigger,
    summary: run.summary ?? "",
    agentResults: run.steps.map((item) => ({
      role: item.agentRole,
      success: item.status === "completed",
      summary: item.output?.slice(0, 160),
    })),
  }).catch(() => {});

  await store.updateCycle(run.cycleId ?? run.id, {
    status: run.status === "completed" ? "completed" : "failed",
    summary: run.summary,
    completedAt: run.completedAt,
  }).catch(() => {});

  // §1 P0-1 — Engine A's report/cadence tail is now the consolidation phase:
  // scheduled operating cycles routed through the durable orchestrator still
  // produce a cycle report and advance the company's cycle cadence.
  const cycles = await store.listCycles(run.companyId).catch(() => []);
  const cycleRecord = cycles.find((item) => item.id === (run.cycleId ?? run.id));
  if (cycleRecord?.kind === "scheduled") {
    const completedSteps = run.steps.filter((item) => item.status === "completed");
    await store.createReport({
      companyId: run.companyId,
      type: "cycle",
      title: "Operating Cycle Report",
      findings: completedSteps.slice(0, 8).map(
        (item) => `${item.agentRole}: ${(item.handoff?.summary ?? item.output ?? item.title).slice(0, 200)}`,
      ),
      recommendations: suggestions.slice(0, 5).map((item) => item.title),
    }).catch(() => {});
    const completedAt = run.completedAt ?? nowIso();
    await store.updateCompany(run.companyId, {
      lastCycleAt: completedAt,
      nextCycleAt: nextCycleAtFromCompleted(company.cycleFrequency, completedAt),
    }).catch(() => {});
    if (shouldAssembleNightlyBriefing(run, company, cycleRecord.startedAt)) {
      await assembleMorningBriefing(run.companyId).catch((error) =>
        store.addAudit(
          run.companyId,
          "system",
          "morning_briefing.failed",
          "cycle",
          cycleRecord.id,
          `Morning briefing failed after scheduled cycle completion: ${error instanceof Error ? error.message : String(error)}`,
        ).catch(() => undefined),
      );
    }
  }

  await auditTransition(
    run.companyId,
    run.status === "completed" ? "run_done" : "run_failed",
    run.id,
    run.summary ?? "Orchestration finished",
  );

  emitJobEvent({
    jobRunId: run.id,
    companyId: run.companyId,
    status: run.status === "completed" ? "completed" : "failed",
    summary: markdownReport.slice(0, 200),
    at: nowIso(),
  });
  await emitPersistedOrcEvent(run, {
    kind: run.status === "completed" ? "run_done" : "run_failed",
    runId: run.id,
    at: nowIso(),
    run: { id: run.id, status: run.status, summary: run.summary, completedAt: run.completedAt },
  });
}

export function hasFatalOrchestrationOutcome(
  steps: Pick<StepRecord, "status" | "critique" | "output">[],
): boolean {
  return steps.some(isFatalStepOutcome);
}

/**
 * §1 P0-1 — when the durable orchestrator finishes a scheduled cycle, advance
 * the company's `nextCycleAt` cadence. Mirrors `nextCycleAt` in lib/cycles.ts.
 */
function nextCycleAtFromCompleted(
  frequency: Company["cycleFrequency"],
  fromIso: string,
): string | undefined {
  if (frequency === "manual") return undefined;
  const date = new Date(fromIso);
  date.setDate(date.getDate() + (frequency === "daily" ? 1 : 7));
  return date.toISOString();
}

function shouldAssembleNightlyBriefing(
  run: OrchestrationRun,
  company: Company,
  cycleStartedAt: string,
): boolean {
  if (run.trigger !== "scheduled") return false;
  if (company.nightlyRunHour === undefined) return false;
  return new Date(cycleStartedAt).getUTCHours() === company.nightlyRunHour;
}
