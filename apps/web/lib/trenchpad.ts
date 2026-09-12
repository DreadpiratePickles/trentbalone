import type { AgentRole, UsageLedgerEntry, WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";

export type TrenchpadFilters = {
  status?: WorkbenchSession["status"];
  agentRole?: AgentRole;
  q?: string;
};

export function filterTrenchpadSessions(sessions: WorkbenchSession[], filters: TrenchpadFilters): WorkbenchSession[] {
  const q = filters.q?.trim().toLowerCase();
  return sessions.filter((session) => {
    if (filters.status && session.status !== filters.status) return false;
    if (filters.agentRole && session.agentRole !== filters.agentRole) return false;
    if (q && !`${session.objective} ${session.agentRole} ${session.status}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function normalizeWorkbenchTimeline(events: WorkbenchEvent[], artifacts: WorkbenchArtifact[]) {
  return events
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.createdAt.localeCompare(b.createdAt))
    .map((event) => ({
      id: event.id,
      sessionId: event.sessionId,
      seq: event.seq,
      type: event.type,
      status: event.status,
      title: event.title,
      content: event.content,
      command: event.command,
      createdAt: event.createdAt,
      artifact: event.artifactId ? artifacts.find((artifact) => artifact.id === event.artifactId) : artifacts.find((artifact) => artifact.sessionId === event.sessionId),
    }));
}

export function buildEditablePlanner(events: WorkbenchEvent[]) {
  return {
    actions: ["edit_step", "reorder_step", "approve_step", "skip_step"],
    auditRequired: true,
    steps: events
      .filter((event) => event.type === "plan" || event.type === "shell")
      .map((event, index) => ({
        id: event.id,
        index,
        title: event.title,
        status: event.status,
        editable: true,
        approvalRequired: event.status === "needs_approval",
      })),
  };
}

export function buildPlaybookDescriptor() {
  return {
    primitive: "playbook",
    actions: ["save_prompt_as_playbook", "rerun_as_session", "promote_to_plug"],
    storage: "workbench_session.metadata.playbooks",
  };
}

export function buildSecretsPanelDescriptor() {
  return {
    scope: "company_session",
    providers: ["GitHub", "Stripe", "Postmark", "OpenAI", "Anthropic", "Google"],
    rendersSecretValues: false,
    actions: ["add_secret", "rotate_secret", "delete_secret", "attach_env_to_session"],
    auditRequired: true,
  };
}

export function buildTrenchpadAggregate(input: {
  companyId: string;
  sessions: WorkbenchSession[];
  events: WorkbenchEvent[];
  artifacts: WorkbenchArtifact[];
  usage: Array<Pick<UsageLedgerEntry, "amountCents">>;
  budgetCents: number;
}) {
  const spentCents = input.usage.reduce((sum, item) => sum + item.amountCents, 0);
  const activeSession = input.sessions[0];
  return {
    companyId: input.companyId,
    headerUsage: {
      spentCents,
      budgetCents: input.budgetCents,
      remainingCents: Math.max(0, input.budgetCents - spentCents),
    },
    sessionRail: {
      sessions: input.sessions,
      filters: ["status", "agentRole", "userEmail"],
      inlineRename: true,
    },
    workStream: normalizeWorkbenchTimeline(input.events, input.artifacts),
    commandCenter: {
      reuse: "CeoCommandClient",
      affordances: ["stop", "steer", "attach_context", "jump_to_event"],
    },
    rightPanel: {
      activeSessionId: activeSession?.id,
      planner: buildEditablePlanner(input.events),
      artifacts: input.artifacts,
      files: { source: "workbench files API", entries: [] },
      previewUrl: activeSession?.previewUrl,
    },
    playbooks: buildPlaybookDescriptor(),
    secrets: buildSecretsPanelDescriptor(),
  };
}
