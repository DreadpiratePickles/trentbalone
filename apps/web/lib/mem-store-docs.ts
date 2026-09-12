import type {
  Artifact,
  AuditLog,
  CeoMessage,
  CeoSuggestion,
  Comment,
  CommentEntityType,
  Document,
  JobRun,
  MemorySearchResult,
  Report,
  ToolConnection,
  UsageLedgerEntry,
  WorkbenchArtifact,
  WorkbenchEvent,
  WorkbenchSession,
  WorkbenchChatMessage,
  WorkbenchAgentMode,
  WorkbenchAttempt,
  WorkbenchCheckpoint,
  WorkbenchSessionStats,
  OrchestratorRun,
  OrchestratorStep,
  OrchestratorEvent,
  ContentMissionRun,
  ContentMissionAction,
  AgentMissionRun,
  AgentMissionStep,
  AgentMissionEvent,
  AppState,
  Company,
  RecurringTaskTemplate,
} from "@/lib/types";
import { makeId, nowIso } from "@/lib/utils";
import { buildDefaultRecurringTasks, nextCycleAtForFrequency } from "@/lib/store-helpers";
import { state, addAuditLog } from "./mem-store-state";
import { publishWorkbenchStreamEvent } from "@/lib/workbench-event-stream";

export const memStoreDocs = {
  async listDocuments(companyId?: string): Promise<Document[]> {
    return state()
      .documents.filter((doc) => !companyId || doc.companyId === companyId)
      .slice()
      .reverse();
  },

  async createDocument(
    input: Omit<Document, "id" | "createdAt" | "version"> & { version?: number }
  ): Promise<Document> {
    const doc: Document = { ...input, id: makeId("doc"), version: input.version ?? 1, createdAt: nowIso() };
    state().documents.push(doc);
    addAuditLog(doc.companyId, "agent", "document.create", "document", doc.id, doc.title);
    return doc;
  },

  async updateDocument(id: string, patch: { title?: string; content?: string }): Promise<Document | undefined> {
    const doc = state().documents.find((d) => d.id === id);
    if (!doc) return undefined;
    if (patch.title !== undefined) doc.title = patch.title;
    if (patch.content !== undefined) doc.content = patch.content;
    doc.version = (doc.version ?? 1) + 1;
    addAuditLog(doc.companyId, "user", "document.update", "document", id, doc.title + " (human correction)");
    return doc;
  },

  async expireDocument(id: string, validToIso: string): Promise<void> {
    const doc = state().documents.find((d) => d.id === id);
    if (doc) doc.validTo = validToIso;
  },

  async listArtifacts(companyId?: string): Promise<Artifact[]> {
    return state()
      .artifacts.filter((artifact) => !companyId || artifact.companyId === companyId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async getArtifact(id: string): Promise<Artifact | undefined> {
    return state().artifacts.find((artifact) => artifact.id === id);
  },

  async createArtifact(
    input: Omit<Artifact, "id" | "createdAt" | "updatedAt">
  ): Promise<Artifact> {
    const timestamp = nowIso();
    const artifact: Artifact = {
      ...input,
      id: makeId("artifact"),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state().artifacts.push(artifact);
    addAuditLog(artifact.companyId, "agent", "artifact.create", "artifact", artifact.id, artifact.title);
    return artifact;
  },

  async updateArtifact(id: string, patch: Partial<Artifact>): Promise<Artifact | undefined> {
    const artifact = state().artifacts.find((item) => item.id === id);
    if (!artifact) return undefined;
    Object.assign(artifact, patch, { updatedAt: nowIso() });
    addAuditLog(artifact.companyId, "user", "artifact.update", "artifact", artifact.id, artifact.title);
    return artifact;
  },

  async listWorkbenchSessions(companyId?: string): Promise<WorkbenchSession[]> {
    return state()
      .workbenchSessions.filter((session) => !companyId || session.companyId === companyId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async getWorkbenchSession(id: string): Promise<WorkbenchSession | undefined> {
    return state().workbenchSessions.find((session) => session.id === id);
  },

  async createWorkbenchSession(
    input: Omit<WorkbenchSession, "id" | "createdAt" | "updatedAt" | "costCents" | "messageCount" | "agentMode"> & {
      costCents?: number;
      agentMode?: WorkbenchAgentMode;
    }
  ): Promise<WorkbenchSession> {
    const timestamp = nowIso();
    const session: WorkbenchSession = {
      ...input,
      id: makeId("workbench"),
      agentMode: input.agentMode ?? "build",
      messageCount: 0,
      costCents: input.costCents ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state().workbenchSessions.push(session);
    addAuditLog(session.companyId, "agent", "workbench.create", "workbench_session", session.id, session.objective);
    return session;
  },

  async updateWorkbenchSession(id: string, patch: Partial<WorkbenchSession>): Promise<WorkbenchSession | undefined> {
    const session = state().workbenchSessions.find((item) => item.id === id);
    if (!session) return undefined;
    Object.assign(session, patch, { updatedAt: nowIso() });
    addAuditLog(session.companyId, "system", "workbench.update", "workbench_session", session.id, session.status);
    return session;
  },

  async deleteWorkbenchSession(id: string): Promise<boolean> {
    const session = state().workbenchSessions.find((item) => item.id === id);
    if (!session) return false;
    state().workbenchSessions = state().workbenchSessions.filter((item) => item.id !== id);
    state().workbenchEvents = state().workbenchEvents.filter((event) => event.sessionId !== id);
    state().workbenchArtifacts = state().workbenchArtifacts.filter((artifact) => artifact.sessionId !== id);
    state().workbenchChatMessages = state().workbenchChatMessages.filter((message) => message.sessionId !== id);
    addAuditLog(session.companyId, "user", "workbench.delete", "workbench_session", session.id, session.objective);
    return true;
  },

  async listWorkbenchEvents(sessionId: string): Promise<WorkbenchEvent[]> {
    return state()
      .workbenchEvents.filter((event) => event.sessionId === sessionId)
      .slice()
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.createdAt.localeCompare(b.createdAt));
  },

  async addWorkbenchEvent(input: Omit<WorkbenchEvent, "id" | "createdAt">): Promise<WorkbenchEvent> {
    const existing = state().workbenchEvents.filter((event) => event.sessionId === input.sessionId);
    const seq = input.seq ?? existing.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
    const event: WorkbenchEvent = { ...input, seq, id: makeId("wbevent"), createdAt: nowIso() };
    state().workbenchEvents.push(event);
    publishWorkbenchStreamEvent(event);
    return event;
  },

  async listWorkbenchArtifacts(sessionId: string): Promise<WorkbenchArtifact[]> {
    return state()
      .workbenchArtifacts.filter((artifact) => artifact.sessionId === sessionId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async addWorkbenchArtifact(input: Omit<WorkbenchArtifact, "id" | "createdAt">): Promise<WorkbenchArtifact> {
    const artifact: WorkbenchArtifact = { ...input, id: makeId("wbartifact"), createdAt: nowIso() };
    state().workbenchArtifacts.push(artifact);
    addAuditLog(artifact.companyId, "agent", "workbench.artifact", "workbench_artifact", artifact.id, artifact.title);
    return artifact;
  },

  async createWorkbenchAttempt(input: Omit<WorkbenchAttempt, "id" | "startedAt">): Promise<WorkbenchAttempt> {
    const attempt: WorkbenchAttempt = { ...input, id: makeId("wbattempt"), startedAt: nowIso() };
    state().workbenchAttempts.push(attempt);
    return attempt;
  },

  async updateWorkbenchAttempt(id: string, patch: Partial<WorkbenchAttempt>): Promise<WorkbenchAttempt | undefined> {
    const attempt = state().workbenchAttempts.find((item) => item.id === id);
    if (!attempt) return undefined;
    Object.assign(attempt, patch);
    return attempt;
  },

  async listWorkbenchAttempts(sessionId: string): Promise<WorkbenchAttempt[]> {
    return state()
      .workbenchAttempts.filter((attempt) => attempt.sessionId === sessionId)
      .slice()
      .sort((a, b) => a.attemptNo - b.attemptNo || a.startedAt.localeCompare(b.startedAt));
  },

  async upsertWorkbenchCheckpoint(input: Omit<WorkbenchCheckpoint, "id" | "updatedAt">): Promise<WorkbenchCheckpoint> {
    const existing = state().workbenchCheckpoints.find((checkpoint) => checkpoint.sessionId === input.sessionId);
    if (existing) {
      Object.assign(existing, input, { updatedAt: nowIso() });
      return existing;
    }
    const checkpoint: WorkbenchCheckpoint = { ...input, id: makeId("wbcheckpoint"), updatedAt: nowIso() };
    state().workbenchCheckpoints.push(checkpoint);
    return checkpoint;
  },

  async getWorkbenchCheckpoint(sessionId: string): Promise<WorkbenchCheckpoint | undefined> {
    return state().workbenchCheckpoints.find((checkpoint) => checkpoint.sessionId === sessionId);
  },

  async listWorkbenchChatMessages(sessionId: string): Promise<WorkbenchChatMessage[]> {
    return state()
      .workbenchChatMessages.filter((message) => message.sessionId === sessionId)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async addWorkbenchChatMessage(input: Omit<WorkbenchChatMessage, "id" | "createdAt">): Promise<WorkbenchChatMessage> {
    const message: WorkbenchChatMessage = { ...input, id: makeId("wbmsg"), createdAt: nowIso() };
    state().workbenchChatMessages.push(message);
    const session = state().workbenchSessions.find((item) => item.id === input.sessionId);
    if (session) {
      session.messageCount = (session.messageCount ?? 0) + 1;
      session.updatedAt = nowIso();
    }
    return message;
  },

  async getWorkbenchSessionStats(companyId: string): Promise<WorkbenchSessionStats> {
    const sessions = state()
      .workbenchSessions.filter((session) => session.companyId === companyId)
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const byMode: WorkbenchSessionStats["byMode"] = { build: 0, research: 0, design: 0 };
    for (const session of sessions) byMode[session.agentMode ?? "build"] += 1;
    return { total: sessions.length, byMode, recentActivity: sessions.slice(0, 5) };
  },

  async createOrchestratorRun(
    input: Omit<OrchestratorRun, "startedAt" | "updatedAt" | "replanCount"> & {
      startedAt?: string;
      updatedAt?: string;
      replanCount?: number;
    },
  ): Promise<OrchestratorRun> {
    const timestamp = nowIso();
    const run: OrchestratorRun = {
      ...input,
      replanCount: input.replanCount ?? 0,
      startedAt: input.startedAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
    };
    state().orchestratorRuns.push(run);
    addAuditLog(run.companyId, "agent", "orchestration.run.create", "orchestrator_run", run.id, run.objective);
    return run;
  },

  async getOrchestratorRun(id: string): Promise<OrchestratorRun | undefined> {
    return state().orchestratorRuns.find((run) => run.id === id);
  },

  async listOrchestratorRuns(companyId: string): Promise<OrchestratorRun[]> {
    return state()
      .orchestratorRuns.filter((run) => run.companyId === companyId)
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },

  async updateOrchestratorRun(id: string, patch: Partial<OrchestratorRun>): Promise<OrchestratorRun | undefined> {
    const run = state().orchestratorRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, patch, { updatedAt: nowIso() });
    return run;
  },

  async upsertOrchestratorStep(input: OrchestratorStep): Promise<OrchestratorStep> {
    const existing = state().orchestratorSteps.find((step) => step.id === input.id && step.runId === input.runId);
    if (existing) {
      Object.assign(existing, input);
      return existing;
    }
    state().orchestratorSteps.push(input);
    return input;
  },

  async listOrchestratorSteps(runId: string): Promise<OrchestratorStep[]> {
    return state()
      .orchestratorSteps.filter((step) => step.runId === runId)
      .slice()
      .sort((a, b) => a.seq - b.seq);
  },

  async appendOrchestratorEvent(input: Omit<OrchestratorEvent, "id" | "seq" | "createdAt"> & { seq?: number }): Promise<OrchestratorEvent> {
    const existing = state().orchestratorEvents.filter((event) => event.runId === input.runId);
    const event: OrchestratorEvent = {
      ...input,
      id: makeId("orcevent"),
      seq: input.seq ?? existing.reduce((max, item) => Math.max(max, item.seq), 0) + 1,
      createdAt: nowIso(),
    };
    state().orchestratorEvents.push(event);
    return event;
  },

  async listOrchestratorEvents(runId: string): Promise<OrchestratorEvent[]> {
    return state()
      .orchestratorEvents.filter((event) => event.runId === runId)
      .slice()
      .sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
  },

  async createContentMissionRun(
    input: Omit<ContentMissionRun, "startedAt" | "updatedAt"> & { startedAt?: string; updatedAt?: string },
  ): Promise<ContentMissionRun> {
    const timestamp = nowIso();
    const run: ContentMissionRun = {
      ...input,
      startedAt: input.startedAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
    };
    state().contentMissionRuns.push(run);
    addAuditLog(run.companyId, "agent", "content_mission.run.create", "content_mission_run", run.id, run.objective);
    return run;
  },

  async getContentMissionRun(id: string): Promise<ContentMissionRun | undefined> {
    return state().contentMissionRuns.find((run) => run.id === id);
  },

  async listContentMissionRuns(companyId: string): Promise<ContentMissionRun[]> {
    return state()
      .contentMissionRuns.filter((run) => run.companyId === companyId)
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },

  async updateContentMissionRun(id: string, patch: Partial<ContentMissionRun>): Promise<ContentMissionRun | undefined> {
    const run = state().contentMissionRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, patch, { updatedAt: nowIso() });
    return run;
  },

  async upsertContentMissionAction(input: ContentMissionAction): Promise<ContentMissionAction> {
    const existing = state().contentMissionActions.find(
      (action) => action.runId === input.runId && action.ledgerItemId === input.ledgerItemId,
    );
    if (existing) {
      Object.assign(existing, input, { id: existing.id, updatedAt: nowIso() });
      return existing;
    }
    const action: ContentMissionAction = { ...input, updatedAt: nowIso() };
    state().contentMissionActions.push(action);
    return action;
  },

  async listContentMissionActions(runId: string): Promise<ContentMissionAction[]> {
    return state()
      .contentMissionActions.filter((action) => action.runId === runId)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async createAgentMissionRun(
    input: Omit<AgentMissionRun, "startedAt" | "updatedAt"> & { startedAt?: string; updatedAt?: string },
  ): Promise<AgentMissionRun> {
    const timestamp = nowIso();
    const run: AgentMissionRun = {
      ...input,
      startedAt: input.startedAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
    };
    state().agentMissionRuns.push(run);
    addAuditLog(run.companyId, "agent", "agent_mission.run.create", "agent_mission_run", run.id, run.objective);
    return run;
  },

  async getAgentMissionRun(id: string): Promise<AgentMissionRun | undefined> {
    return state().agentMissionRuns.find((run) => run.id === id);
  },

  async listAgentMissionRuns(companyId: string): Promise<AgentMissionRun[]> {
    return state()
      .agentMissionRuns.filter((run) => run.companyId === companyId)
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },

  async updateAgentMissionRun(id: string, patch: Partial<AgentMissionRun>): Promise<AgentMissionRun | undefined> {
    const run = state().agentMissionRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, patch, { updatedAt: nowIso() });
    return run;
  },

  async upsertAgentMissionStep(input: AgentMissionStep): Promise<AgentMissionStep> {
    const existing = state().agentMissionSteps.find((step) => step.id === input.id && step.runId === input.runId);
    if (existing) {
      Object.assign(existing, input);
      return existing;
    }
    state().agentMissionSteps.push(input);
    return input;
  },

  async listAgentMissionSteps(runId: string): Promise<AgentMissionStep[]> {
    return state()
      .agentMissionSteps.filter((step) => step.runId === runId)
      .slice()
      .sort((a, b) => a.seq - b.seq);
  },

  async appendAgentMissionEvent(
    input: Omit<AgentMissionEvent, "id" | "seq" | "createdAt"> & { seq?: number },
  ): Promise<AgentMissionEvent> {
    const existing = state().agentMissionEvents.filter((event) => event.runId === input.runId);
    const event: AgentMissionEvent = {
      ...input,
      id: makeId("amevent"),
      seq: input.seq ?? existing.reduce((max, item) => Math.max(max, item.seq), 0) + 1,
      createdAt: nowIso(),
    };
    state().agentMissionEvents.push(event);
    return event;
  },

  async listAgentMissionEvents(runId: string): Promise<AgentMissionEvent[]> {
    return state()
      .agentMissionEvents.filter((event) => event.runId === runId)
      .slice()
      .sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
  },

  async createReport(input: Omit<Report, "id" | "createdAt">): Promise<Report> {
    const report: Report = { ...input, id: makeId("report"), createdAt: nowIso() };
    state().reports.push(report);
    addAuditLog(report.companyId, "agent", "report.create", "report", report.id, report.title);
    return report;
  },

  async listReports(companyId: string): Promise<Report[]> {
    return state()
      .reports.filter((report) => report.companyId === companyId)
      .slice()
      .reverse();
  },

  async searchMemory(companyId: string, query: string): Promise<MemorySearchResult[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) return [];

    const score = (text: string) =>
      terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term) ? 1 : 0), 0);
    const excerpt = (text: string) => text.replace(/\s+/g, " ").slice(0, 220);
    const nowMs = Date.now();

    const documentResults = state()
      .documents.filter((doc) => {
        if (doc.companyId !== companyId) return false;
        if (!doc.validTo) return true;
        return new Date(doc.validTo).getTime() > nowMs;
      })
      .slice()
      .reverse()
      .map((doc) => ({
        id: doc.id,
        kind: "document" as const,
        title: doc.title,
        excerpt: excerpt(doc.content),
        createdAt: doc.createdAt,
        score: score(`${doc.title} ${doc.content} ${doc.source}`)
      }));

    const reportResults = state()
      .reports.filter((report) => report.companyId === companyId)
      .slice()
      .reverse()
      .map((report) => {
        const text = `${report.title} ${report.findings.join(" ")} ${report.recommendations.join(" ")}`;
        return {
          id: report.id,
          kind: "report" as const,
          title: report.title,
          excerpt: excerpt(text),
          createdAt: report.createdAt,
          score: score(text)
        };
      });

    const executionResults = state()
      .executions.filter((execution) => execution.companyId === companyId)
      .slice()
      .reverse()
      .map((execution) => ({
        id: execution.id,
        kind: "execution" as const,
        title: `${execution.agentRole} execution`,
        excerpt: excerpt(execution.output),
        createdAt: execution.createdAt,
        score: score(`${execution.agentRole} ${execution.input} ${execution.output}`)
      }));

    const taskResults = state()
      .tasks.filter((task) => task.companyId === companyId)
      .map((task) => ({
        id: task.id,
        kind: "task" as const,
        title: task.title,
        excerpt: excerpt(task.prompt),
        createdAt: task.createdAt,
        score: score(`${task.title} ${task.prompt} ${task.tags.join(" ")}`)
      }));

    return [...documentResults, ...reportResults, ...executionResults, ...taskResults]
      .filter((result) => result.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .slice(0, 12);
  },

  async listUsage(companyId?: string): Promise<UsageLedgerEntry[]> {
    return state()
      .usage.filter((entry) => !companyId || entry.companyId === companyId)
      .slice()
      .reverse();
  },

  async addUsage(input: Omit<UsageLedgerEntry, "id" | "createdAt">): Promise<UsageLedgerEntry> {
    const entry = { ...input, id: makeId("usage"), createdAt: nowIso() };
    state().usage.push(entry);
    return entry;
  },

  async listIntegrations(companyId?: string): Promise<ToolConnection[]> {
    return state()
      .integrations.filter((item) => !companyId || item.companyId === companyId)
      .map(({ encryptedData: _encryptedData, ...connection }) => connection);
  },

  async getIntegration(companyId: string, provider: string): Promise<ToolConnection | undefined> {
    return state().integrations.find(
      (item) => item.companyId === companyId && item.provider.toLowerCase() === provider.toLowerCase()
    );
  },

  async upsertIntegration(
    input: Omit<ToolConnection, "id" | "lastCheckedAt">
  ): Promise<ToolConnection> {
    const existing = state().integrations.find(
      (item) => item.companyId === input.companyId && item.provider.toLowerCase() === input.provider.toLowerCase()
    );
    if (existing) {
      Object.assign(existing, input, { lastCheckedAt: nowIso() });
      addAuditLog(existing.companyId, "user", "integration.update", "tool_connection", existing.id, `Updated ${existing.provider}`);
      return existing;
    }

    const connection: ToolConnection = {
      ...input,
      id: makeId("connection"),
      lastCheckedAt: nowIso()
    };
    state().integrations.push(connection);
    addAuditLog(connection.companyId, "user", "integration.create", "tool_connection", connection.id, `Connected ${connection.provider}`);
    return connection;
  },

  async revokeIntegration(id: string): Promise<void> {
    const idx = state().integrations.findIndex((item) => item.id === id);
    if (idx !== -1) {
      state().integrations.splice(idx, 1);
    }
  },

  async addAudit(
    companyId: string,
    actor: "system" | "user" | "agent",
    action: string,
    objectType: string,
    objectId: string,
    summary: string
  ): Promise<void> {
    addAuditLog(companyId, actor, action, objectType, objectId, summary);
  },

  async listAuditLogs(companyId?: string): Promise<AuditLog[]> {
    return state()
      .auditLogs.filter((entry) => !companyId || entry.companyId === companyId)
      .slice()
      .reverse();
  },

  async getLastAuditHash(companyId: string): Promise<string | undefined> {
    const companyLogs = state().auditLogs.filter((l) => l.companyId === companyId);
    return companyLogs.length > 0 ? companyLogs[companyLogs.length - 1].hash : undefined;
  },

  async createAuditLog(input: {
    id: string;
    companyId: string;
    actor: "system" | "user" | "agent";
    action: string;
    objectType: string;
    objectId: string;
    summary: string;
    hash: string;
    prevHash: string;
    createdAt: string;
  }): Promise<void> {
    state().auditLogs.push({
      id: input.id,
      companyId: input.companyId,
      actor: input.actor,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      summary: input.summary,
      hash: input.hash,
      prevHash: input.prevHash,
      createdAt: input.createdAt,
    });
  },

  async createJobRun(input: Omit<JobRun, "id" | "startedAt">): Promise<JobRun> {
    const jobRun: JobRun = {
      ...input,
      id: makeId("job"),
      startedAt: nowIso()
    };
    state().jobRuns.push(jobRun);
    if (jobRun.companyId) {
      addAuditLog(
        jobRun.companyId,
        jobRun.trigger === "user" ? "user" : "system",
        "job.started",
        "job_run",
        jobRun.id,
        jobRun.summary
      );
    }
    return jobRun;
  },

  async getJobRun(id: string): Promise<JobRun | undefined> {
    return state().jobRuns.find((item) => item.id === id);
  },

  async updateJobRun(id: string, patch: Partial<JobRun>): Promise<JobRun | undefined> {
    const jobRun = state().jobRuns.find((item) => item.id === id);
    if (!jobRun) return undefined;
    Object.assign(jobRun, patch);
    if (jobRun.companyId && patch.status) {
      addAuditLog(
        jobRun.companyId,
        "system",
        `job.${patch.status}`,
        "job_run",
        jobRun.id,
        patch.summary ?? jobRun.summary
      );
    }
    return jobRun;
  },

  async listJobRuns(companyId?: string): Promise<JobRun[]> {
    return state()
      .jobRuns.filter((jobRun) => !companyId || jobRun.companyId === companyId)
      .slice()
      .reverse();
  },

  nextCycleAt(frequency: Company["cycleFrequency"], fromIso = nowIso()): string | undefined {
    return nextCycleAtForFrequency(frequency, fromIso);
  },

  defaultRecurringTasks(companyId: string, createdAt: string): RecurringTaskTemplate[] {
    return buildDefaultRecurringTasks(companyId, createdAt);
  },

  // ── CEO Messages ──────────────────────────────────────────────────────

  async addCeoMessage(
    input: Omit<CeoMessage, "id" | "createdAt">
  ): Promise<CeoMessage> {
    if (!state().ceoMessages) state().ceoMessages = [];
    const msg: CeoMessage = { ...input, id: makeId("ceomsg"), createdAt: nowIso() };
    state().ceoMessages.push(msg);
    return msg;
  },

  async listCeoMessages(companyId: string, limit = 60): Promise<CeoMessage[]> {
    if (!state().ceoMessages) state().ceoMessages = [];
    return state()
      .ceoMessages.filter((m) => m.companyId === companyId)
      .slice(-limit);
  },

  // ── CEO Suggestions ────────────────────────────────────────────────────

  async addCeoSuggestion(
    input: Omit<CeoSuggestion, "id" | "createdAt" | "status">
  ): Promise<CeoSuggestion> {
    if (!state().ceoSuggestions) state().ceoSuggestions = [];
    const s: CeoSuggestion = {
      ...input,
      id: makeId("suggestion"),
      status: "pending",
      createdAt: nowIso()
    };
    state().ceoSuggestions.push(s);
    return s;
  },

  async listCeoSuggestions(companyId: string): Promise<CeoSuggestion[]> {
    if (!state().ceoSuggestions) state().ceoSuggestions = [];
    return state()
      .ceoSuggestions.filter((s) => s.companyId === companyId && s.status === "pending")
      .slice()
      .reverse();
  },

  async getCeoSuggestion(id: string): Promise<CeoSuggestion | undefined> {
    return state().ceoSuggestions.find((suggestion) => suggestion.id === id);
  },

  async updateCeoSuggestion(
    id: string,
    status: CeoSuggestion["status"]
  ): Promise<CeoSuggestion | undefined> {
    if (!state().ceoSuggestions) state().ceoSuggestions = [];
    const s = state().ceoSuggestions.find((item) => item.id === id);
    if (s) s.status = status;
    return s;
  },

  // ── Comments ─────────────────────────────────────────────────────────────

  async listComments(companyId: string, entityType: CommentEntityType, entityId: string): Promise<Comment[]> {
    if (!state().comments) state().comments = [];
    return state().comments.filter(
      (c) => c.companyId === companyId && c.entityType === entityType && c.entityId === entityId
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  async addComment(input: Omit<Comment, "id" | "createdAt">): Promise<Comment> {
    if (!state().comments) state().comments = [];
    const comment: Comment = {
      ...input,
      id: makeId("comment"),
      createdAt: nowIso(),
    };
    state().comments.push(comment);
    return comment;
  },

  snapshot(): AppState {
    return state();
  }
};
