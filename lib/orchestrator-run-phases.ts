import { store } from "@/lib/store";
import type { Company } from "@/lib/types";
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
} from "@/lib/orchestrator-runtime";
import { reviseOrchestrationPlanTail } from "@/lib/orchestrator-replan";
import { buildDelegatedStepsForWorkRequests } from "@/lib/orchestrator-delegation";
import { recallRelevantMemory } from "@/lib/semantic-router";
import { handleStepCritique, type OrchestrationRun } from "@/lib/orchestrator";
import { cacheOrchestrationRun } from "@/lib/orchestrator-cache";
import {
  buildCompletedOutputs,
  emitPersistedOrcEvent,
  persistStep,
  persistSteps,
} from "@/lib/orchestrator-run-persist";
import { enqueueReadyOrchestrationSteps } from "@/lib/orchestrator-run-queue";

export async function processPlanPhase(run: OrchestrationRun, company: Company): Promise<void> {
  await emitPersistedOrcEvent(run, { kind: "plan_start", runId: run.id, at: nowIso() });
  const recalled = await recallRelevantMemory(company.id, run.objective, { k: 5, tokenBudget: 1200 });
  const memory = recalled.text;
  const plan = await generateOrchestrationPlan(company, run.objective, memory, { fullTeam: run.fullTeam, runId: run.id });
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
  const unmet = step.dependsOn.find((dep) => !(dep in outputs));
  if (unmet) {
    const depStep = run.steps.find((item) => item.id === unmet);
    // If the dependency FAILED it will never produce output. Marking this step
    // "blocked" would strand it (the scheduler only re-selects "pending" steps),
    // silently dropping it from the final brief. Cascade to a visible failure so
    // the run reflects reality and still terminates.
    if (depStep?.status === "failed") {
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
      return;
    }
    if (approval?.status === "rejected") {
      await enqueueReadyOrchestrationSteps(run);
      return;
    }
  }

  step.status = "running";
  step.startedAt = step.startedAt ?? nowIso();
  const stepTask = await createTaskForStep(run.companyId, run.id, step).catch(() => undefined);
  step.taskId = stepTask?.id;
  await persistStep(run, step);
  await auditTransition(run.companyId, "step_start", run.id, `${step.agentRole}: ${step.title}`);
  await emitPersistedOrcEvent(run, { kind: "step_start", runId: run.id, at: nowIso(), step });

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
      cycleId: run.cycleId,
      approvalGranted,
      resumeSeed: step.seatLoopState,
      objective: run.objective,
    });
    step.output = exec.output;
    step.model = exec.model;
    step.tokens = exec.tokens;
    step.costCents = exec.costCents;
    step.toolCalls = exec.toolCalls;
    await persistStep(run, step);
    await store.saveExecution(exec.execution);

    const critiqueResult = await critiqueStepOutput(step, exec.output, { companyId: run.companyId, runId: run.id });
    step.critique = critiqueResult;
    await persistStep(run, step);

    if (critiqueResult.verdict === "retry") {
      const exec2 = await executeStepWithRuntime({
        step: { ...step, expectedOutput: `${step.expectedOutput}\nImprovement: ${critiqueResult.improvement ?? "tighten the result"}` },
        company,
        previousOutputs: outputs,
        cycleId: run.cycleId,
        approvalGranted,
        objective: run.objective,
      });
      await store.saveExecution(exec2.execution);
      step.model = exec2.model;
      step.output = exec2.output;
      step.tokens = (step.tokens ?? 0) + exec2.tokens;
      step.costCents = (step.costCents ?? 0) + exec2.costCents;
      step.toolCalls = [...(step.toolCalls ?? []), ...exec2.toolCalls];
      await persistStep(run, step);
    } else if (critiqueResult.verdict === "replan" || critiqueResult.verdict === "escalate") {
      const recalled = await recallRelevantMemory(company.id, run.objective, { k: 5, tokenBudget: 1200 });
      const completedSteps = run.steps.filter((item) => item.status === "completed");
      const proposedReplan = run.plan
        ? await reviseOrchestrationPlanTail(company, run.objective, recalled.text, {
            plan: run.plan,
            completedSteps,
            failedStep: { ...step, output: step.output ?? exec.output },
            critique: critiqueResult,
          })
        : undefined;
      const completedIds = new Set(completedSteps.map((item) => item.id));
      const revisedTail = proposedReplan?.steps.filter((item) => !completedIds.has(item.id));
      const critiqueOutcome = await handleStepCritique({
        run,
        stepId: step.id,
        critique: critiqueResult,
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
      const pendingRecord = [...err.toolCalls].reverse().find((record) => record.status === "needs_approval");
      const approval = await createApprovalForSeatTool(company, run.id, step, {
        adapter: err.seatLoopState.pendingToolCall.name,
        action: err.seatLoopState.pendingToolCall.action,
        summary: pendingRecord?.summary ?? err.seatLoopState.pendingToolCall.action,
      });
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

export async function processConsolidatePhase(run: OrchestrationRun, company: Company): Promise<void> {
  if (!run.plan) return;
  await emitPersistedOrcEvent(run, { kind: "consolidate_start", runId: run.id, at: nowIso() });
  run.summary = await consolidateRun(run.plan, run.steps, { companyId: run.companyId, runId: run.id });
  const hasFatalFailure = run.steps.some(
    (step) => step.status === "failed" && step.critique?.verdict !== "replan",
  );
  run.status = hasFatalFailure ? "failed" : "completed";
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
