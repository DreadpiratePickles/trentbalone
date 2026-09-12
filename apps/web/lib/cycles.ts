import { generateOperatingPlan, ceoChatResponse } from "@/lib/ai";
import { getApprovalExpiryHours } from "@/lib/tools";
import type { AgentRole, Cycle, CycleFrequency, ToolCallRecord } from "@/lib/types";
import { executeStepWithRuntime, SeatLoopAwaitingApprovalError, type RuntimeStep } from "@/lib/orchestrator-runtime";
import { store } from "@/lib/store";
import { assertSpendAvailable, assertAgentTokenBudget } from "@/lib/spend";
import { makeId, nowIso } from "@/lib/utils";
import { emitJobEvent } from "@/lib/job-events";
import { writeEpisodicMemory } from "@/lib/memory-tiers";
import { contextLogger } from "@/lib/logger";

const cyclePhases = [
  "inspect_state",
  "identify_opportunities",
  "create_tasks",
  "assign_agents",
  "execute_safe_work",
  "summarize_results",
  "update_memory"
];

export async function runCompanyCycle(companyId: string, trigger: "manual" | "scheduled" = "manual") {
  const traceId = makeId("trace");
  const log = contextLogger({ traceId, companyId });

  const company = await store.getCompany(companyId);
  if (!company) {
    log.warn("cycle.company_not_found");
    throw new Error("Company not found");
  }
  if (company.status === "paused") {
    log.info("cycle.skipped_paused");
    throw new Error("Company is paused");
  }
  const startedAt = nowIso();
  const cycle: Cycle = {
    id: makeId("cycle"),
    companyId: company.id,
    trigger,
    kind: "scheduled",
    status: "running",
    phases: cyclePhases,
    summary: "Cycle is running.",
    startedAt
  };
  await store.saveCycle(cycle);
  const cycleLog = log.child({ cycleId: cycle.id });
  cycleLog.info({ trigger }, "cycle.start");

  try {
    await assertSpendAvailable(company.id, 1, "Starting an operating cycle");

    // Emit plan start event
    emitJobEvent({
      jobRunId: cycle.id,
      companyId: company.id,
      status: "step",
      summary: `Planning operating cycle for ${company.name}`,
      at: nowIso(),
      step: { phase: "plan_start", label: "generating operating plan" }
    });

    const { plan, model, tokens, costCents, degraded } = await generateOperatingPlan(company);
    await assertSpendAvailable(company.id, costCents, "Operating cycle model usage");
    cycleLog.info({ model, tokens, costCents, taskCount: plan.tasks.length, degraded }, "cycle.plan_ready");
    if (degraded) {
      await store.updateCycle(cycle.id, { degraded: true } as Partial<Cycle>).catch(() => {});
    }

    emitJobEvent({
      jobRunId: cycle.id,
      companyId: company.id,
      status: "step",
      summary: `Plan ready — ${plan.tasks.length} tasks queued`,
      at: nowIso(),
      step: { phase: "plan_end", label: "plan ready", tokens, costCents }
    });

    for (const task of plan.tasks) {
      await store.createTask({
        companyId: company.id,
        title: task.title,
        prompt: task.prompt,
        status: task.agentRole === "engineer" ? "waiting_approval" : "queued",
        priority: task.priority,
        agentRole: task.agentRole,
        tags: task.tags
      });
    }

    for (const approval of plan.approvals) {
      const expiryHours = getApprovalExpiryHours(
        approval.toolName ?? "",
        company.approvalExpiryOverrides
      );
      const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
      await store.createApproval({
        companyId: company.id,
        action: approval.action,
        reason: approval.reason,
        toolName: approval.toolName,
        previewContent: approval.previewContent,
        previewKind: approval.previewKind,
        expiresAt
      });
    }

    const agentResults: Array<{ role: AgentRole; success: boolean; summary?: string }> = [];
    const previousOutputs: Record<string, string> = {};
    let execCostCents = 0;
    let execTokens = 0;

    for (const [idx, task] of plan.tasks.entries()) {
      const freshCompany = await store.getCompany(company.id);
      if (freshCompany?.status === "paused") {
        throw new Error("Cycle aborted — company was paused during execution.");
      }

      const stepId = `cycle-step-${idx + 1}`;
      await assertAgentTokenBudget(company.id, task.agentRole, 1500);

      const step: RuntimeStep = {
        id: stepId,
        title: task.title,
        agentRole: task.agentRole,
        rationale: task.prompt,
        expectedOutput: task.prompt,
        riskLevel: task.priority === "urgent" || task.priority === "high" ? "medium" : "low",
        dependsOn: [],
        needsApproval: false,
      };

      const agentLog = cycleLog.child({ agentRole: task.agentRole, stepId });
      agentLog.info("agent.start");
      emitJobEvent({
        jobRunId: cycle.id,
        companyId: company.id,
        status: "step",
        summary: `${task.agentRole} agent: ${task.title}`,
        at: nowIso(),
        step: { phase: "agent_start", role: task.agentRole, label: task.title }
      });

      let executionResult: Awaited<ReturnType<typeof executeStepWithRuntime>> | undefined;
      try {
        executionResult = await executeStepWithRuntime({
          step,
          company,
          previousOutputs,
          cycleId: cycle.id,
        });
      } catch (err) {
        if (!(err instanceof SeatLoopAwaitingApprovalError)) throw err;

        const pending = seatApprovalRequest(err.toolCalls);
        const output = pending
          ? `${task.agentRole} queued approval for ${pending.adapter}: ${pending.action}. ${pending.summary}`
          : `${task.agentRole} paused for tool approval.`;
        previousOutputs[stepId] = output;
        execCostCents += err.costCents;
        execTokens += err.tokens;

        if (pending) {
          const expiryHours = getApprovalExpiryHours(pending.adapter, company.approvalExpiryOverrides);
          const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
          await store.createApproval({
            companyId: company.id,
            action: pending.action,
            reason: pending.summary,
            toolName: `cycle:${cycle.id}:${stepId}:${pending.adapter}`,
            previewContent: pending.summary,
            previewKind: "generic",
            expiresAt,
          });
        }

        await store.saveExecution({
          id: makeId("exec"),
          companyId: company.id,
          cycleId: cycle.id,
          agentRole: task.agentRole,
          input: [`Step ${step.id}: ${step.title}`, `Mission: ${task.prompt}`].join("\n"),
          output,
          toolCalls: err.toolCalls,
          status: "completed",
          model: err.model,
          tokens: err.tokens,
          costCents: err.costCents,
          durationMs: 0,
          createdAt: nowIso(),
        });

        agentResults.push({
          role: task.agentRole,
          success: true,
          summary: output.slice(0, 160),
        });

        emitJobEvent({
          jobRunId: cycle.id,
          companyId: company.id,
          status: "step",
          summary: `${task.agentRole} agent queued approval: ${task.title}`,
          at: nowIso(),
          step: { phase: "approval_required", role: task.agentRole, label: task.title, tokens: err.tokens, costCents: err.costCents }
        });

        continue;
      }

      previousOutputs[stepId] = executionResult.output;
      execCostCents += executionResult.costCents;
      execTokens += executionResult.tokens;
      agentLog.info({ tokens: executionResult.tokens, costCents: executionResult.costCents }, "agent.end");

      emitJobEvent({
        jobRunId: cycle.id,
        companyId: company.id,
        status: "step",
        summary: `${task.agentRole} agent completed: ${task.title}`,
        at: nowIso(),
        step: { phase: "agent_end", role: task.agentRole, label: task.title, tokens: executionResult.tokens, costCents: executionResult.costCents }
      });

      agentResults.push({
        role: task.agentRole,
        success: executionResult.execution.status !== "failed",
        summary: executionResult.output.slice(0, 160),
      });

      await store.saveExecution(executionResult.execution);
    }

    await store.createReport({
      companyId: company.id,
      type: "cycle",
      title: "Operating Cycle Report",
      findings: plan.reportFindings,
      recommendations: plan.reportRecommendations
    });

    await store.createDocument({
      companyId: company.id,
      type: "weekly_report",
      title: "Latest Operating Summary",
      content: `${plan.summary}\n\nFindings:\n${plan.reportFindings.map((item) => `- ${item}`).join("\n")}\n\nRecommendations:\n${plan.reportRecommendations.map((item) => `- ${item}`).join("\n")}`,
      source: "cycle",
      version: 1
    });

    await store.addUsage({
      companyId: company.id,
      category: "llm",
      description: `Operating cycle ${cycle.id}`,
      amountCents: costCents + execCostCents,
      metadata: { model, tokens: tokens + execTokens }
    });

    const completedAt = nowIso();
    await store.updateCycle(cycle.id, {
      status: "completed",
      summary: plan.summary,
      completedAt
    });
    cycle.status = "completed";
    cycle.summary = plan.summary;
    cycle.completedAt = completedAt;

    await store.updateCompany(company.id, {
      lastCycleAt: completedAt,
      nextCycleAt: nextCycleAt(company.cycleFrequency, completedAt)
    });
    cycleLog.info({ summary: plan.summary }, "cycle.complete");
    await store.addAudit(company.id, "agent", "cycle.completed", "cycle", cycle.id, plan.summary);

    // Write episodic memory — records what happened in this cycle for future retrieval
    await writeEpisodicMemory({
      companyId: company.id,
      cycleId: cycle.id,
      trigger,
      summary: plan.summary,
      agentResults,
    }).catch(() => {}); // Non-blocking: memory write failure must not break cycle

    // CEO autopilot briefing — sent after every completed cycle
    const briefingMsg = [
      `Cycle complete. ${plan.summary}`,
      plan.reportFindings.length > 0
        ? `Key findings: ${plan.reportFindings.slice(0, 2).join(" · ")}`
        : "",
      plan.reportRecommendations.length > 0
        ? `Next: ${plan.reportRecommendations[0]}`
        : ""
    ].filter(Boolean).join(" ");

    await store.addCeoMessage({
      companyId: company.id,
      direction: "from_ceo",
      kind: "autopilot_update",
      content: briefingMsg
    });

    // Surface out-of-scope suggestions from the CEO evaluation
    const allTasks = await store.listTasks(company.id);
    const briefingResponse = await ceoChatResponse(
      company,
      [],
      `You just completed a cycle. Evaluate the results and identify anything the human founder needs to do personally that Trent cannot handle autonomously.`,
      { tasks: allTasks, lastCycle: cycle }
    );

    await Promise.all(
      (briefingResponse.suggestions ?? []).map((s) =>
        store.addCeoSuggestion({ companyId: company.id, ...s })
      )
    );

    return {
      cycle,
      tasks: await store.listTasks(company.id),
      recurringTasks: await store.listRecurringTasks(company.id),
      approvals: await store.listApprovals(company.id),
      reports: await store.listReports(company.id),
      usage: await store.listUsage(company.id),
      executions: await store.listExecutions(company.id)
    };
  } catch (error) {
    const completedAt = nowIso();
    const summary = error instanceof Error ? error.message : "Operating cycle failed.";
    cycleLog.error({ err: error }, "cycle.failed");
    await store.updateCycle(cycle.id, {
      status: "failed",
      summary,
      completedAt
    });
    await store.addAudit(company.id, "system", "cycle.failed", "cycle", cycle.id, summary);
    throw error;
  }
}

function nextCycleAt(frequency: CycleFrequency, fromIso: string) {
  if (frequency === "manual") return undefined;
  const date = new Date(fromIso);
  date.setDate(date.getDate() + (frequency === "daily" ? 1 : 7));
  return date.toISOString();
}

function seatApprovalRequest(toolCalls: ToolCallRecord[]) {
  const pending = [...toolCalls].reverse().find((record) => record.status === "needs_approval");
  if (!pending) return undefined;
  return {
    adapter: pending.adapter,
    action: pending.action,
    summary: pending.summary,
  };
}
