import type { AgentRole, WorkbenchAgentMode, WorkbenchSession } from "@/lib/types";
import type { AppSoloAgent, AppSoloApp } from "@/lib/app-solo";
import { APP_SOLO_REVIEW_EVIDENCE } from "@/lib/app-solo-product-review";
import type { WorkbenchCreateInput } from "@/lib/workbench";
import type { WorkbenchAgentChunk } from "@/lib/workbench-agent-types";
import { MCP_AGENT_MODES, MCP_AGENT_ROLES } from "./constants";
import {
  activeRunCountForKey,
  MAX_CONCURRENT_RUNS_PER_KEY,
  releaseMcpRun,
  resetMcpRunTrackingForTest,
  trackMcpRun,
} from "./run-tracking";
import type { McpAuthContext, McpToolDefinition } from "./types";

export { activeRunCountForKey, MAX_CONCURRENT_RUNS_PER_KEY, resetMcpRunTrackingForTest };

export type RunAgentDeps = {
  createSession: (input: WorkbenchCreateInput) => Promise<WorkbenchSession>;
  runAgent: (input: { session: WorkbenchSession; userMessage: string; history: [] }) => AsyncGenerator<WorkbenchAgentChunk>;
  ensureSandbox: (session: WorkbenchSession) => Promise<unknown>;
  launchTeam: (input: { companyId: string; objective: string; trigger: "delegated" }) => Promise<{ id: string; status: string }>;
  audit: (
    companyId: string,
    actor: "system" | "user" | "agent",
    action: string,
    objectType: string,
    objectId: string,
    summary: string
  ) => Promise<void>;
  getAgents?: () => AppSoloAgent[];
  buildObjective?: (agent: AppSoloAgent, app: AppSoloApp, objective: string) => string;
};

export async function runAgentHandler(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
  deps?: RunAgentDeps
): Promise<unknown> {
  const resolvedDeps = await resolveRunAgentDeps(deps);
  const objective = typeof args.objective === "string" ? args.objective.trim() : "";
  if (!objective) throw new Error("objective is required");
  if (objective.length > 4000) throw new Error("objective exceeds 4000 characters");

  const role = typeof args.role === "string" ? args.role as AgentRole : undefined;
  if (role && !MCP_AGENT_ROLES.includes(role)) {
    throw new Error(`unsupported role "${String(args.role)}"`);
  }

  const engine = args.engine === "team" ? "team" : "solo";
  const requestedMode = MCP_AGENT_MODES.includes(args.mode as WorkbenchAgentMode)
    ? args.mode as WorkbenchAgentMode
    : undefined;
  const requestedAppId = typeof args.appId === "string" && args.appId.trim()
    ? args.appId.trim()
    : undefined;

  if (activeRunCountForKey(ctx.keyId) >= MAX_CONCURRENT_RUNS_PER_KEY) {
    throw new Error(`concurrent run limit reached (${MAX_CONCURRENT_RUNS_PER_KEY} per key)`);
  }

  if (engine === "team") {
    const run = await resolvedDeps.launchTeam({
      companyId: ctx.companyId,
      objective,
      trigger: "delegated",
    });
    trackMcpRun(ctx.keyId, run.id);
    await resolvedDeps.audit(
      ctx.companyId,
      "agent",
      "mcp_run_agent",
      "orchestrator_run",
      run.id,
      `MCP key ${ctx.maskedKey} launched team run: ${objective.slice(0, 120)}`
    ).catch(() => undefined);
    return {
      engine: "team",
      runId: run.id,
      status: run.status,
      poll: "trent_get_run",
      nextCall: nextRunPollCall(run.id),
      note: "Run executes asynchronously. Approval gates pause it in Trent when required.",
    };
  }

  const agent = resolveAppSoloAgent(role ?? "engineer", resolvedDeps);
  const app = resolveApp(agent, requestedAppId);
  const mode = requestedMode ?? agent.mode;
  const appObjective = resolvedDeps.buildObjective?.(agent, app, objective) ?? objective;
  const session = await resolvedDeps.createSession({
    companyId: ctx.companyId,
    objective: appObjective,
    agentRole: agent.role,
    agentMode: mode,
    enqueue: false,
    metadata: {
      appSolo: {
        agentRole: agent.role,
        agentLabel: agent.label,
        appId: app.id,
        appName: app.name,
        appScopes: app.scopes,
        deliverables: agent.deliverables,
        approvalGates: agent.approvalGates,
        mode,
      },
    },
  });
  trackMcpRun(ctx.keyId, session.id);
  await resolvedDeps.audit(
    ctx.companyId,
    "agent",
    "mcp_run_agent",
    "workbench_session",
    session.id,
    `MCP key ${ctx.maskedKey} launched solo ${agent.role}/${mode} run: ${objective.slice(0, 120)}`
  ).catch(() => undefined);

  void consumeSoloRun(ctx.keyId, session, appObjective, resolvedDeps);

  return {
    engine: "solo",
    runId: session.id,
    status: session.status,
    agentRole: agent.role,
    mode,
    appId: app.id,
    app: app.name,
    poll: "trent_get_run",
    nextCall: nextRunPollCall(session.id),
    productReviewPlan: buildProductReviewPlan(agent, app),
    note: "Run executes asynchronously. Approval gates pause it in Trent when required.",
  };
}

export const RUN_AGENT_TOOL: McpToolDefinition = {
  name: "trent_run_agent",
  description:
    "Launch a governed Trent run. engine 'solo' runs one App-Solo seat in Workbench; engine 'team' runs the orchestrated multi-seat DAG. Returns runId immediately plus productReviewPlan for solo evidence expectations; poll with trent_get_run.",
  inputSchema: {
    type: "object",
    properties: {
      objective: { type: "string", description: "What the agent should accomplish." },
      role: { type: "string", enum: MCP_AGENT_ROLES, description: "Solo seat. Defaults to engineer." },
      appId: { type: "string", description: "Optional App-Solo app id for the selected solo seat, such as steel-browser, hyperframes, open-generative-ai, fincept-terminal, or ghostfolio." },
      mode: { type: "string", enum: MCP_AGENT_MODES, description: "Solo Workbench mode. Defaults to the role's App Solo mode." },
      engine: { type: "string", enum: ["solo", "team"], description: "solo or team. Defaults to solo." },
    },
    required: ["objective"],
    additionalProperties: false,
  },
  requiredScope: "mcp",
  handler: runAgentHandler,
};

async function consumeSoloRun(
  keyId: string,
  session: WorkbenchSession,
  userMessage: string,
  deps: RunAgentDeps
): Promise<void> {
  try {
    await deps.ensureSandbox(session);
    for await (const chunk of deps.runAgent({ session, userMessage, history: [] })) {
      if (chunk.type === "done" || chunk.type === "error") break;
    }
  } catch {
    // runWorkbenchAgent records failures as Workbench events when it can.
  } finally {
    releaseMcpRun(keyId, session.id);
  }
}

async function loadRunAgentDeps(): Promise<RunAgentDeps> {
  const [
    workbench,
    agent,
    orchestrator,
    workbenchOrchestrator,
    appSolo,
    storeModule,
  ] = await Promise.all([
    import("@/lib/workbench"),
    import("@/lib/workbench-agent"),
    import("@/lib/orchestrator"),
    import("@/lib/workbench-orchestrator"),
    import("@/lib/app-solo"),
    import("@/lib/store"),
  ]);

  return {
    createSession: workbench.createWorkbenchSession,
    runAgent: agent.runWorkbenchAgent,
    ensureSandbox: workbenchOrchestrator.ensureWorkbenchSandboxReady,
    launchTeam: orchestrator.launchOrchestration,
    audit: storeModule.store.addAudit,
    getAgents: appSolo.getAppSoloAgents,
    buildObjective: appSolo.buildAppSoloObjective,
  };
}

async function resolveRunAgentDeps(deps?: RunAgentDeps): Promise<RunAgentDeps> {
  if (!deps) return loadRunAgentDeps();
  if (deps.getAgents && deps.buildObjective) return deps;
  const appSolo = await import("@/lib/app-solo");
  return {
    ...deps,
    getAgents: deps.getAgents ?? appSolo.getAppSoloAgents,
    buildObjective: deps.buildObjective ?? appSolo.buildAppSoloObjective,
  };
}

function resolveAppSoloAgent(role: AgentRole, deps: RunAgentDeps): AppSoloAgent {
  const agent = deps.getAgents?.().find((candidate) => candidate.role === role);
  if (!agent) throw new Error(`unsupported role "${role}"`);
  return agent;
}

function resolveApp(agent: AppSoloAgent, appId?: string): AppSoloApp {
  if (appId) {
    const requested = agent.apps.find((app) => app.id === appId);
    if (!requested) {
      throw new Error(
        `unsupported appId "${appId}" for role "${agent.role}". Available apps: ${agent.apps.map((app) => app.id).join(", ") || "none"}`
      );
    }
    return requested;
  }
  return agent.apps[0] ?? {
    id: "trent-mcp",
    name: "Trent MCP",
    label: "MCP",
    description: "Governed Trent command-center session.",
    scopes: ["mcp"],
    accent: "pulse",
  };
}

function nextRunPollCall(runId: string) {
  return {
    tool: "trent_get_run",
    arguments: { runId },
  };
}

function buildProductReviewPlan(agent: AppSoloAgent, app: AppSoloApp) {
  return {
    status: "pending_evidence",
    deliverables: agent.deliverables,
    approvalGates: agent.approvalGates,
    appScopes: app.scopes,
    requiredEvidence: APP_SOLO_REVIEW_EVIDENCE,
    reviewTool: "trent_get_run",
    reviewField: "productReview",
  };
}
