import { evaluatePlugLaunchRequirements, type PlugApprovalMatrixEntry } from "@/lib/plug/launch-requirements";
import { plugMemoryNamespace, type PlugDefinition } from "@/lib/plug/schema-v2";
import { store } from "@/lib/store";
import type { AgentRole, Report, ToolCallRecord, WorkbenchArtifact } from "@/lib/types";
import { makeId, nowIso } from "@/lib/utils";
import { getDefaultWorkbenchProvider } from "@/lib/workbench-providers";
import { resolveToolCredential } from "@/lib/tool-credentials";
import { adapters, executeToolWithPolicy, type ToolAdapter } from "@/lib/tools";

/**
 * Injectable seams for the executor -> ToolAdapter bridge. Production uses the
 * real registry + credential resolver + policy executor; tests pass fakes.
 */
export type PlugBridgeDeps = {
  adapters?: ToolAdapter[];
  resolveToolCredential?: typeof resolveToolCredential;
  executeToolWithPolicy?: typeof executeToolWithPolicy;
};

export type PlugToolExecutionStatus = "completed" | "needs_approval" | "blocked" | "failed";

export type PlugToolExecution = {
  id: string;
  toolId: string;
  action: string;
  status: PlugToolExecutionStatus;
  seat: AgentRole;
  summary: string;
  approvalGate?: string;
  approvalId?: string;
  artifactId?: string;
  reportId?: string;
  error?: string;
};

export type PlugExecutionResult = {
  status: "completed" | "blocked" | "failed";
  companyId: string;
  sessionId: string;
  plug: Pick<PlugDefinition, "id" | "slug" | "name" | "version">;
  objective: string;
  toolCalls: PlugToolExecution[];
  approvalMatrix: PlugApprovalMatrixEntry[];
  launch: ReturnType<typeof evaluatePlugLaunchRequirements> & {
    evidence: {
      runLogArtifactId: string;
      sampleOutputArtifactId: string;
    };
  };
  memoryNamespace: string;
  transcript: string;
};

type PlugExecutionInput = {
  companyId: string;
  plug: PlugDefinition;
  objective: string;
  variables?: Record<string, string>;
  approvalIds?: Record<string, string>;
  bridge?: PlugBridgeDeps;
};

export type ToolContext = {
  companyId: string;
  sessionId: string;
  plug: PlugDefinition;
  objective: string;
  seat: AgentRole;
  variables: Record<string, string>;
  bridge?: PlugBridgeDeps;
};

export async function runPlugExecution(input: PlugExecutionInput): Promise<PlugExecutionResult> {
  const startedAt = nowIso();
  const primarySeat = input.plug.seats[0]?.seat ?? "analyst";
  const session = await store.createWorkbenchSession({
    companyId: input.companyId,
    objective: `Plug ${input.plug.slug}: ${input.objective}`,
    agentRole: primarySeat,
    status: "running",
    provider: getDefaultWorkbenchProvider(),
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: Math.max(...input.plug.seats.map((seat) => Math.ceil(seat.timeoutMs / 1000)), 60),
      maxCostCents: input.plug.costPerRunCents,
      approvalRequiredFor: input.plug.declaredTools.flatMap((tool) => tool.approvalRequiredActions.map((action) => `${tool.toolId}.${action}`)),
      rollbackAvailable: true,
    },
  });

  await store.addWorkbenchEvent({
    companyId: input.companyId,
    sessionId: session.id,
    type: "plan",
    status: "completed",
    title: "Plug execution plan",
    content: buildPlanContent(input.plug, input.objective),
    agentRole: primarySeat,
    metadata: { plugId: input.plug.id, plugSlug: input.plug.slug },
  });

  const toolCalls: PlugToolExecution[] = [];
  for (const seat of input.plug.seats) {
    const context: ToolContext = {
      companyId: input.companyId,
      sessionId: session.id,
      plug: input.plug,
      objective: input.objective,
      seat: seat.seat,
      variables: input.variables ?? {},
      bridge: input.bridge,
    };
    for (const declared of input.plug.declaredTools) {
      for (const action of declared.allowedActions) {
        const approvalGate = `${declared.toolId}.${action}`;
        const approvalId = input.approvalIds?.[approvalGate];
        const requiresApproval = declared.approvalRequiredActions.includes(action);
        const result = requiresApproval && !approvalId
          ? await recordApprovalBlock(context, declared.toolId, action, approvalGate)
          : await executeDeclaredTool(context, declared.toolId, action, approvalId);
        toolCalls.push(result);
      }
    }
  }

  const transcript = buildTranscript(input.plug, input.objective, toolCalls, startedAt);
  const runLogArtifact = await addJsonArtifact({
    companyId: input.companyId,
    sessionId: session.id,
    kind: "terminal_log",
    title: `${input.plug.name} execution log`,
    storageKey: `plug-runs/${session.id}/execution-log.json`,
    createdByAgent: primarySeat,
    content: { startedAt, plugId: input.plug.id, objective: input.objective, toolCalls },
  });
  const sampleOutputArtifact = await addMarkdownArtifact({
    companyId: input.companyId,
    sessionId: session.id,
    title: `${input.plug.name} sample output`,
    storageKey: `plug-runs/${session.id}/sample-output.md`,
    createdByAgent: primarySeat,
    content: transcript,
  });

  await store.addWorkbenchEvent({
    companyId: input.companyId,
    sessionId: session.id,
    type: "artifact",
    status: "completed",
    title: "Plug execution evidence created",
    content: `Run log ${runLogArtifact.id} and sample output ${sampleOutputArtifact.id} are ready.`,
    artifactId: sampleOutputArtifact.id,
    agentRole: primarySeat,
    metadata: { runLogArtifactId: runLogArtifact.id, sampleOutputArtifactId: sampleOutputArtifact.id },
  });

  const hasHardFailure = toolCalls.some((call) => call.status === "failed");
  const hasApprovalBlock = toolCalls.some((call) => call.status === "needs_approval" || call.status === "blocked");
  const status: PlugExecutionResult["status"] = hasHardFailure ? "failed" : hasApprovalBlock ? "blocked" : "completed";
  await store.updateWorkbenchSession(session.id, {
    status: status === "completed" ? "completed" : status === "blocked" ? "paused" : "failed",
    stoppedAt: nowIso(),
  });

  const launch = evaluatePlugLaunchRequirements(input.plug, {
    runLogArtifactId: runLogArtifact.id,
    sampleOutputArtifactId: sampleOutputArtifact.id,
  });
  return {
    status,
    companyId: input.companyId,
    sessionId: session.id,
    plug: {
      id: input.plug.id,
      slug: input.plug.slug,
      name: input.plug.name,
      version: input.plug.version,
    },
    objective: input.objective,
    toolCalls,
    approvalMatrix: launch.approvalMatrix,
    launch: {
      ...launch,
      evidence: {
        runLogArtifactId: runLogArtifact.id,
        sampleOutputArtifactId: sampleOutputArtifact.id,
      },
    },
    memoryNamespace: plugMemoryNamespace(input.plug, input.companyId),
    transcript,
  };
}

async function executeDeclaredTool(
  context: ToolContext,
  toolId: string,
  action: string,
  approvalId?: string,
): Promise<PlugToolExecution> {
  try {
    // Built-in reports executor stays as the path for report actions — it
    // produces the real report artifacts the launch-evidence flow depends on.
    // It is a fallback, no longer the ONLY path.
    if (toolId === "reports" && action === "create") {
      return createReportOutput(context, approvalId);
    }
    if (toolId === "reports" && action === "read") {
      return readReports(context, approvalId);
    }
    // Everything else bridges to the real ToolAdapter registry.
    const declared = context.plug.declaredTools.find((tool) => tool.toolId === toolId);
    return await bridgePlugToolCall(
      context,
      toolId,
      action,
      declared ? [...declared.allowedActions] : [],
      approvalId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Plug tool failure";
    await store.addWorkbenchEvent({
      companyId: context.companyId,
      sessionId: context.sessionId,
      type: "shell",
      status: "failed",
      title: `${toolId}.${action} failed`,
      content: message,
      agentRole: context.seat,
      metadata: { toolId, action, plugId: context.plug.id },
    });
    return {
      id: makeId("plugtool"),
      toolId,
      action,
      status: "failed",
      seat: context.seat,
      summary: message,
      approvalId,
      error: message,
    };
  }
}

/**
 * Bridge a declared Plug action to the real ToolAdapter registry.
 *
 * - Enforces the Plug's allowedActions AT THE BRIDGE (an undeclared action is
 *   blocked here, never forwarded to an adapter).
 * - Resolves the per-tenant credential via the shared resolveToolCredential seam
 *   (encrypted ToolConnection first, env fallback). Only the credential SOURCE
 *   is used downstream — the secret value never enters the payload, the workbench
 *   event, PlugRunTelemetry, or logs.
 * - Delegates execution to executeToolWithPolicy with allowedActions as the
 *   permission constraint (belt-and-suspenders with the bridge guard above).
 */
export async function bridgePlugToolCall(
  context: ToolContext,
  toolId: string,
  action: string,
  allowedActions: string[],
  approvalId?: string,
): Promise<PlugToolExecution> {
  const registry = context.bridge?.adapters ?? adapters;
  const resolveCredential = context.bridge?.resolveToolCredential ?? resolveToolCredential;
  const runTool = context.bridge?.executeToolWithPolicy ?? executeToolWithPolicy;

  if (!allowedActions.includes(action)) {
    return recordBlockedTool(context, toolId, action, `Action "${action}" is not in the Plug's allowedActions.`, approvalId);
  }

  const adapter = registry.find(
    (candidate) => candidate.name === toolId || candidate.name.toLowerCase() === toolId.toLowerCase(),
  );
  if (!adapter) {
    return recordBlockedTool(context, toolId, action, `No tool adapter is registered for "${toolId}".`, approvalId);
  }

  // Per-tenant credential seam. Value is intentionally discarded — the adapter
  // resolves the concrete secret itself under companyId; we keep only `source`.
  const credential = await resolveCredential({
    companyId: context.companyId,
    provider: toolId,
    envFallback: () => undefined,
  });

  const payload: Record<string, unknown> = { companyId: context.companyId, ...context.variables };
  const record = await runTool(adapter, action, payload, { allowedActions });
  const status = mapToolStatus(record.status);

  await store.addWorkbenchEvent({
    companyId: context.companyId,
    sessionId: context.sessionId,
    type: status === "needs_approval" ? "approval" : "shell",
    status: status === "completed" ? "completed" : status === "needs_approval" ? "needs_approval" : "failed",
    title: `${toolId}.${action} via ${adapter.name}`,
    content: record.summary,
    agentRole: context.seat,
    metadata: { toolId, action, plugId: context.plug.id, adapter: adapter.name, credentialSource: credential.source },
  });

  return {
    id: makeId("plugtool"),
    toolId,
    action,
    status,
    seat: context.seat,
    summary: record.summary,
    approvalId,
    approvalGate: status === "needs_approval" ? `${toolId}.${action}` : undefined,
    error: status === "failed" ? record.summary : undefined,
  };
}

function mapToolStatus(status: ToolCallRecord["status"]): PlugToolExecutionStatus {
  if (status === "mocked" || status === "completed") return "completed";
  if (status === "needs_approval") return "needs_approval";
  if (status === "blocked") return "blocked";
  return "failed";
}

async function createReportOutput(context: ToolContext, approvalId?: string): Promise<PlugToolExecution> {
  const renderedCompany = context.variables.company ?? "the company";
  const findings = [
    `${context.plug.name} reviewed the objective: ${context.objective}`,
    `Execution stayed inside ${plugMemoryNamespace(context.plug, context.companyId)}.`,
    "External writes were not attempted during Plug proof execution.",
  ];
  const recommendations = [
    `Use this Plug for ${context.plug.category} work when the ${context.seat} seat owns the output.`,
    "Route any declared approval-required action through Trent approvals before execution.",
  ];
  const report = await store.createReport({
    companyId: context.companyId,
    type: reportTypeForSeat(context.seat),
    title: `${context.plug.name} report for ${renderedCompany}`,
    findings,
    recommendations,
  });
  const document = await store.createDocument({
    companyId: context.companyId,
    type: "agent_note",
    title: `${context.plug.name} execution memory`,
    content: formatReportMarkdown(report),
    source: `plug:${context.plug.slug}`,
    memoryTier: "episodic",
    validFrom: nowIso(),
  });
  const artifact = await addMarkdownArtifact({
    companyId: context.companyId,
    sessionId: context.sessionId,
    title: `${context.plug.name} report artifact`,
    storageKey: `plug-runs/${context.sessionId}/report-${report.id}.md`,
    createdByAgent: context.seat,
    content: formatReportMarkdown(report),
  });
  await store.addWorkbenchEvent({
    companyId: context.companyId,
    sessionId: context.sessionId,
    type: "shell",
    status: "completed",
    title: "reports.create",
    content: `Created report ${report.id}, document ${document.id}, and artifact ${artifact.id}.`,
    artifactId: artifact.id,
    agentRole: context.seat,
    metadata: { toolId: "reports", action: "create", reportId: report.id, documentId: document.id },
  });
  return {
    id: makeId("plugtool"),
    toolId: "reports",
    action: "create",
    status: "completed",
    seat: context.seat,
    summary: `Created report ${report.id}.`,
    artifactId: artifact.id,
    reportId: report.id,
    approvalId,
  };
}

async function readReports(context: ToolContext, approvalId?: string): Promise<PlugToolExecution> {
  const reports = await store.listReports(context.companyId);
  await store.addWorkbenchEvent({
    companyId: context.companyId,
    sessionId: context.sessionId,
    type: "shell",
    status: "completed",
    title: "reports.read",
    content: `Read ${reports.length} report${reports.length === 1 ? "" : "s"} for context.`,
    agentRole: context.seat,
    metadata: { toolId: "reports", action: "read", reportCount: reports.length },
  });
  return {
    id: makeId("plugtool"),
    toolId: "reports",
    action: "read",
    status: "completed",
    seat: context.seat,
    summary: `Read ${reports.length} report${reports.length === 1 ? "" : "s"}.`,
    approvalId,
  };
}

async function recordApprovalBlock(
  context: ToolContext,
  toolId: string,
  action: string,
  approvalGate: string,
): Promise<PlugToolExecution> {
  await store.addWorkbenchEvent({
    companyId: context.companyId,
    sessionId: context.sessionId,
    type: "approval",
    status: "needs_approval",
    title: `${toolId}.${action} needs approval`,
    content: `Plug action ${approvalGate} is declared approval-required and was not executed.`,
    agentRole: context.seat,
    metadata: { toolId, action, approvalGate, plugId: context.plug.id },
  });
  return {
    id: makeId("plugtool"),
    toolId,
    action,
    status: "needs_approval",
    seat: context.seat,
    summary: `Blocked until approval for ${approvalGate}.`,
    approvalGate,
  };
}

async function recordBlockedTool(
  context: ToolContext,
  toolId: string,
  action: string,
  reason: string,
  approvalId?: string,
): Promise<PlugToolExecution> {
  await store.addWorkbenchEvent({
    companyId: context.companyId,
    sessionId: context.sessionId,
    type: "shell",
    status: "failed",
    title: `${toolId}.${action} blocked`,
    content: reason,
    agentRole: context.seat,
    metadata: { toolId, action, plugId: context.plug.id, approvalId },
  });
  return {
    id: makeId("plugtool"),
    toolId,
    action,
    status: "blocked",
    seat: context.seat,
    summary: reason,
    approvalId,
  };
}

async function addMarkdownArtifact(input: {
  companyId: string;
  sessionId: string;
  title: string;
  storageKey: string;
  createdByAgent: AgentRole;
  content: string;
}): Promise<WorkbenchArtifact> {
  return store.addWorkbenchArtifact({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: "file",
    title: input.title,
    storageKey: input.storageKey,
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(input.content),
    createdByAgent: input.createdByAgent,
    path: input.storageKey,
    metadata: { contentPreview: input.content.slice(0, 4000) },
  });
}

async function addJsonArtifact(input: {
  companyId: string;
  sessionId: string;
  kind: "terminal_log" | "test_result";
  title: string;
  storageKey: string;
  createdByAgent: AgentRole;
  content: Record<string, unknown>;
}): Promise<WorkbenchArtifact> {
  const serialized = JSON.stringify(input.content, null, 2);
  return store.addWorkbenchArtifact({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: input.kind,
    title: input.title,
    storageKey: input.storageKey,
    mimeType: "application/json",
    sizeBytes: Buffer.byteLength(serialized),
    createdByAgent: input.createdByAgent,
    path: input.storageKey,
    metadata: { contentPreview: serialized.slice(0, 4000) },
  });
}

function buildPlanContent(plug: PlugDefinition, objective: string) {
  const seats = plug.seats.map((seat) => `${seat.seat}:${seat.outputContract}`).join(", ");
  const tools = plug.declaredTools.map((tool) => `${tool.toolId}:${tool.allowedActions.join("/")}`).join(", ");
  return [`Objective: ${objective}`, `Seats: ${seats}`, `Tools: ${tools}`].join("\n");
}

function buildTranscript(plug: PlugDefinition, objective: string, toolCalls: PlugToolExecution[], startedAt: string) {
  return [
    `# ${plug.name} Plug Execution`,
    "",
    `Started: ${startedAt}`,
    `Objective: ${objective}`,
    "",
    "## Tool Calls",
    ...toolCalls.map((call) => `- ${call.toolId}.${call.action}: ${call.status} — ${call.summary}`),
  ].join("\n");
}

function formatReportMarkdown(report: Report) {
  return [
    `# ${report.title}`,
    "",
    "## Findings",
    ...report.findings.map((finding) => `- ${finding}`),
    "",
    "## Recommendations",
    ...report.recommendations.map((recommendation) => `- ${recommendation}`),
  ].join("\n");
}

function reportTypeForSeat(seat: AgentRole): Report["type"] {
  if (seat === "growth") return "growth";
  if (seat === "support" || seat === "escalation") return "support";
  if (seat === "finance") return "finance";
  return "weekly";
}
