import { store } from "@/lib/store";
import { getOrchestrationRunSnapshot } from "@/lib/orchestrator";
import type { OrchestratorRunStatus, Task, WorkbenchSessionStatus } from "@/lib/types";
import { buildWorkbenchIdeView } from "@/lib/workbench-ide-view";
import { getAppSoloAgents } from "@/lib/app-solo";
import { MCP_AGENT_ROLES } from "./constants";
import { releaseMcpRun } from "./run-tracking";
import type { McpAuthContext, McpToolDefinition } from "./types";
import { approvalRunLink } from "./approval-links";
import { buildMcpWorkbenchProductReview } from "./product-review";

const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const READ_TOOLS: McpToolDefinition[] = [
  {
    name: "trent_company_context",
    description: "Return the API key's Trent company context, operating settings, current metrics, and pending approval count.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    requiredScope: "mcp",
    handler: companyContextHandler,
  },
  {
    name: "trent_list_app_solo_options",
    description: "List App-Solo seats, valid appId values, scopes, deliverables, approval gates, and default modes for trent_run_agent.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    requiredScope: "mcp",
    handler: listAppSoloOptionsHandler,
  },
  {
    name: "trent_list_pending_approvals",
    description: "List pending approvals for the API key's company. This is read-only; resolution requires a separate mcp:approve key scope.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    requiredScope: "mcp",
    handler: listPendingApprovalsHandler,
  },
  {
    name: "trent_create_task",
    description: "Create a queued Trent task for the API key's company, tagged as mcp-originated.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
        prompt: { type: "string", description: "Detailed instruction for the assigned Trent agent." },
        role: { type: "string", enum: MCP_AGENT_ROLES, description: "Agent seat to assign. Defaults to engineer." },
        priority: { type: "string", enum: TASK_PRIORITIES, description: "Task priority. Defaults to medium." },
        tags: { type: "array", items: { type: "string" }, description: "Optional extra tags. The mcp tag is always added." },
        dueDate: { type: "string", description: "Optional ISO due date." },
      },
      required: ["title", "prompt"],
      additionalProperties: false,
    },
    requiredScope: "mcp",
    handler: createTaskHandler,
  },
  {
    name: "trent_get_run",
    description: "Poll an MCP-launched run by runId. Supports orchestrator run ids and workbench session ids, including App-Solo evidence summaries, product review, and artifact index.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id returned by trent_run_agent." },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    requiredScope: "mcp",
    handler: getRunHandler,
  },
];

export async function companyContextHandler(ctx: McpAuthContext): Promise<unknown> {
  const company = await store.getCompany(ctx.companyId);
  if (!company) throw new Error("company not found");
  const approvals = await store.listApprovals(ctx.companyId);
  const pending = approvals.filter((approval) => approval.status === "pending");
  return {
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      status: company.status,
      autonomyLevel: company.autonomyLevel,
      timezone: company.timezone,
      budgetCents: company.budgetCents,
      weeklyBudgetCents: company.weeklyBudgetCents,
      cycleFrequency: company.cycleFrequency,
      nextCycleAt: company.nextCycleAt,
      brief: company.brief,
      metrics: company.metrics,
    },
    pendingApprovals: pending.length,
  };
}

export async function listAppSoloOptionsHandler(): Promise<unknown> {
  return {
    defaultEngine: "solo",
    usage: "Call trent_run_agent with engine='solo', role, and optional appId from this list; then poll trent_get_run for evidenceSummary.",
    agents: getAppSoloAgents().map((agent) => ({
      role: agent.role,
      label: agent.label,
      defaultName: agent.defaultName,
      mission: agent.mission,
      mode: agent.mode,
      defaultAppId: agent.apps[0]?.id,
      skills: agent.skills,
      deliverables: agent.deliverables,
      approvalGates: agent.approvalGates,
      apps: agent.apps.map((app) => ({
        id: app.id,
        name: app.name,
        label: app.label,
        description: app.description,
        scopes: app.scopes,
      })),
    })),
  };
}

export async function listPendingApprovalsHandler(ctx: McpAuthContext): Promise<unknown> {
  const approvals = await store.listApprovals(ctx.companyId);
  return {
    approvals: approvals
      .filter((approval) => approval.status === "pending")
      .map((approval) => {
        const link = approvalRunLink(approval);
        return {
          id: approval.id,
          taskId: approval.taskId,
          action: approval.action,
          reason: approval.reason,
          toolName: approval.toolName,
          previewKind: approval.previewKind,
          previewSummary: summarizePreview(approval.previewContent),
          createdAt: approval.createdAt,
          expiresAt: approval.expiresAt,
          approvalUrl: `/companies/${ctx.companyId}/approvals?approvalId=${encodeURIComponent(approval.id)}`,
          relatedRun: link.relatedRun,
          nextCall: link.nextCall,
          decisionCalls: approvalDecisionCalls(approval.id),
        };
      }),
  };
}

export async function createTaskHandler(ctx: McpAuthContext, args: Record<string, unknown>): Promise<unknown> {
  const title = textArg(args.title, "title");
  const prompt = textArg(args.prompt, "prompt");
  const role = enumArg(args.role, MCP_AGENT_ROLES, "role") ?? "engineer";
  const priority = enumArg(args.priority, TASK_PRIORITIES, "priority") ?? "medium";
  const tags = arrayArg(args.tags).filter(Boolean);
  const dueDate = typeof args.dueDate === "string" && args.dueDate.trim() ? args.dueDate.trim() : undefined;

  const task = await store.createTask({
    companyId: ctx.companyId,
    title,
    prompt,
    status: "queued",
    priority,
    agentRole: role,
    tags: Array.from(new Set(["mcp", ...tags])),
    dueDate,
  });

  return { task: summarizeTask(task) };
}

export async function getRunHandler(ctx: McpAuthContext, args: Record<string, unknown>): Promise<unknown> {
  const runId = textArg(args.runId, "runId");
  const orc = await getOrchestrationRunSnapshot(runId).catch(() => undefined);
  if (orc) {
    if (orc.companyId !== ctx.companyId) throw new Error("run not found");
    if (isTerminalOrchestrationStatus(orc.status)) releaseMcpRun(ctx.keyId, runId);
    const awaiting = orc.steps.filter((step) => step.status === "awaiting_approval");
    const awaitingApproval = awaiting.length > 0;
    return {
      kind: "orchestration",
      run: {
        id: orc.id,
        objective: orc.objective,
        status: orc.status,
        trigger: orc.trigger,
        startedAt: orc.startedAt,
        completedAt: orc.completedAt,
        summary: orc.summary,
        stepCount: orc.steps.length,
        costCents: orc.steps.reduce((sum, step) => sum + (step.costCents ?? 0), 0),
      },
      awaitingApproval,
      approvals: awaiting.map((step) => ({
        stepId: step.id,
        stepTitle: step.title,
        approvalId: step.approvalId,
        approvalUrl: step.approvalId
          ? `/companies/${ctx.companyId}/approvals?approvalId=${encodeURIComponent(step.approvalId)}`
          : undefined,
      })),
      nextAction: nextActionForOrchestration(orc.id, orc.status, awaitingApproval),
      runUrl: `/companies/${ctx.companyId}/orchestrate?runId=${encodeURIComponent(orc.id)}`,
    };
  }

  const session = await store.getWorkbenchSession(runId);
  if (!session || session.companyId !== ctx.companyId) throw new Error("run not found");
  if (isTerminalWorkbenchStatus(session.status)) releaseMcpRun(ctx.keyId, runId);
  const [events, artifacts] = await Promise.all([
    store.listWorkbenchEvents(session.id),
    store.listWorkbenchArtifacts(session.id),
  ]);
  const needsApproval = events.filter((event) => event.status === "needs_approval" || event.type === "approval");
  const evidenceSummary = summarizeWorkbenchEvidence({ events, artifacts, previewUrl: session.previewUrl });
  const awaitingApproval = session.status === "paused" || needsApproval.length > 0;

  return {
    kind: "workbench",
    run: {
      id: session.id,
      objective: session.objective,
      status: session.status,
      agentRole: session.agentRole,
      agentMode: session.agentMode,
      previewUrl: session.previewUrl,
      costCents: session.costCents,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      appSolo: session.metadata.appSolo,
    },
    evidenceSummary,
    awaitingApproval,
    nextAction: nextActionForWorkbench(session.id, session.status, awaitingApproval, evidenceSummary),
    productReview: buildMcpWorkbenchProductReview({ metadata: session.metadata, evidenceSummary }),
    productArtifactIndex: buildProductArtifactIndex({ events, artifacts, previewUrl: session.previewUrl }),
    eventsTail: events.slice(-10).map((event) => ({
      id: event.id,
      type: event.type,
      status: event.status,
      title: event.title,
      content: event.content,
      createdAt: event.createdAt,
    })),
    artifacts: artifacts.slice(0, 10).map(summarizeWorkbenchArtifact),
    runUrl: `/companies/${ctx.companyId}/workbench/${encodeURIComponent(session.id)}`,
  };
}

function summarizeWorkbenchEvidence(input: {
  events: Awaited<ReturnType<typeof store.listWorkbenchEvents>>;
  artifacts: Awaited<ReturnType<typeof store.listWorkbenchArtifacts>>;
  previewUrl?: string;
}) {
  const view = buildWorkbenchIdeView({ events: input.events, artifacts: input.artifacts });
  const commands = input.events.filter((event) => event.type === "shell");
  const previewUrl = input.previewUrl ?? latestArtifactPreviewUrl(input.artifacts);
  return {
    ...view.evidenceSummary,
    commandCount: commands.length,
    failedCommandCount: commands.filter((event) => event.status === "failed").length,
    previewCaptured: Boolean(previewUrl),
    previewUrl,
  };
}

function buildProductArtifactIndex(input: {
  events: Awaited<ReturnType<typeof store.listWorkbenchEvents>>;
  artifacts: Awaited<ReturnType<typeof store.listWorkbenchArtifacts>>;
  previewUrl?: string;
}) {
  const view = buildWorkbenchIdeView({ events: input.events, artifacts: input.artifacts });
  const previewUrl = input.previewUrl ?? latestArtifactPreviewUrl(input.artifacts);
  return {
    preview: {
      captured: Boolean(previewUrl),
      url: previewUrl,
    },
    artifacts: input.artifacts.slice(0, 20).map(summarizeWorkbenchArtifact),
    verification: {
      checks: view.verifyChecks,
    },
    commands: view.terminalLines.slice(-20).map((line) => ({
      id: line.id,
      title: line.title,
      command: line.command,
      status: line.status,
      exitCode: line.exitCode,
      durationMs: line.durationMs,
    })),
  };
}

function summarizeWorkbenchArtifact(artifact: Awaited<ReturnType<typeof store.listWorkbenchArtifacts>>[number]) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    path: artifact.path,
    previewUrl: artifact.previewUrl,
    createdAt: artifact.createdAt,
  };
}

function latestArtifactPreviewUrl(artifacts: Awaited<ReturnType<typeof store.listWorkbenchArtifacts>>): string | undefined {
  for (const artifact of [...artifacts].reverse()) {
    if (artifact.kind === "preview" && artifact.previewUrl) return artifact.previewUrl;
  }
  return undefined;
}

function textArg(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`unsupported ${name} "${String(value)}"`);
  }
  return value as T;
}

function arrayArg(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function summarizePreview(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function summarizeTask(task: Task): Pick<Task, "id" | "title" | "status" | "priority" | "agentRole" | "tags" | "createdAt"> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    agentRole: task.agentRole,
    tags: task.tags,
    createdAt: task.createdAt,
  };
}

function isTerminalOrchestrationStatus(status: OrchestratorRunStatus | string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalWorkbenchStatus(status: WorkbenchSessionStatus | string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function nextActionForOrchestration(runId: string, status: OrchestratorRunStatus, awaitingApproval: boolean) {
  if (awaitingApproval) return approvalNextAction();
  if (isTerminalOrchestrationStatus(status)) {
    return {
      type: status === "completed" ? "review_summary" : "inspect_failure",
      terminal: true,
    };
  }
  return pollNextAction(runId);
}

function nextActionForWorkbench(
  runId: string,
  status: WorkbenchSessionStatus,
  awaitingApproval: boolean,
  evidenceSummary: ReturnType<typeof summarizeWorkbenchEvidence>
) {
  if (awaitingApproval) return approvalNextAction();
  if (isTerminalWorkbenchStatus(status)) {
    return {
      type: status === "completed" ? "review_evidence" : "inspect_failure",
      terminal: true,
      evidenceSummaryStatus: evidenceSummary.status,
    };
  }
  return pollNextAction(runId);
}

function pollNextAction(runId: string) {
  return {
    type: "poll",
    terminal: false,
    tool: "trent_get_run",
    arguments: { runId },
    suggestedDelaySeconds: 5,
  };
}

function approvalNextAction() {
  return {
    type: "approval_required",
    terminal: false,
    tool: "trent_list_pending_approvals",
    arguments: {},
  };
}

function approvalDecisionCalls(approvalId: string) {
  return {
    requiredScope: "mcp:approve",
    approve: {
      tool: "trent_resolve_approval",
      arguments: { approvalId, decision: "approved" },
    },
    reject: {
      tool: "trent_resolve_approval",
      arguments: { approvalId, decision: "rejected" },
    },
  };
}
