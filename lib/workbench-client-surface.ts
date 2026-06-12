import { buildWorkbenchAgentObjective, summarizeWorkbenchAgentTools, type WorkbenchAgent } from "@/lib/workbench-agents";
import { buildWorkbenchCreateRequestBody } from "@/lib/workbench-session-request";
import type { WorkbenchAgentMode, WorkbenchSessionMetadata } from "@/lib/types";

export type WorkbenchSurfaceMode = "workbench" | "agents";

export type WorkbenchSurfaceSession = {
  id: string;
  agentMode: WorkbenchAgentMode;
  metadata?: {
    agentRun?: Partial<WorkbenchSessionMetadata["agentRun"]>;
    appSolo?: Partial<WorkbenchSessionMetadata["appSolo"]>;
  } | Record<string, unknown>;
};

export function surfaceModeFromQuery(mode: string | null | undefined): WorkbenchSurfaceMode {
  return mode === "agents" ? "agents" : "workbench";
}

export function filterWorkbenchSessionsForSurface<T extends WorkbenchSurfaceSession>(
  sessions: T[],
  surfaceMode: WorkbenchSurfaceMode,
  modeFilter: WorkbenchAgentMode,
): T[] {
  if (surfaceMode === "agents") {
    return sessions.filter((session) => isWorkbenchAgentSession(session));
  }
  return sessions.filter((session) => session.agentMode === modeFilter && !isWorkbenchAgentSession(session));
}

export function isWorkbenchAgentSession(session: WorkbenchSurfaceSession): boolean {
  return Boolean(
    session.metadata
    && typeof session.metadata === "object"
    && ("agentRun" in session.metadata || "appSolo" in session.metadata)
  );
}

export function buildWorkbenchAgentCreateRequest(input: {
  companyId: string;
  objective: string;
  agent: WorkbenchAgent;
}): Record<string, unknown> {
  return buildWorkbenchCreateRequestBody({
    companyId: input.companyId,
    objective: buildWorkbenchAgentObjective(input.agent, input.objective),
    agentRole: input.agent.role,
    agentMode: input.agent.mode,
    metadata: {
      agentRun: {
        agentRole: input.agent.role,
        agentLabel: input.agent.label,
        tools: summarizeWorkbenchAgentTools(input.agent),
        deliverables: input.agent.deliverables,
        approvalGates: input.agent.approvalGates,
        evidenceRequired: ["files", "commands", "tests", "screenshots", "source coverage", "approval records"],
        mode: input.agent.mode,
      },
    },
  });
}
