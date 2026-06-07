import type {
  JobRun,
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
} from "@/lib/types";
import { db } from "@/lib/db";
import { makeId, nowIso } from "@/lib/utils";
import { computeAuditHash } from "@/lib/audit-log";
import {
  mapWorkbenchSession,
  mapWorkbenchEvent,
  mapWorkbenchArtifact,
  mapWorkbenchChatMessage,
  mapWorkbenchAttempt,
  mapWorkbenchCheckpoint,
  mapOrchestratorRun,
  mapOrchestratorStep,
  mapOrchestratorEvent,
  mapContentMissionRun,
  mapContentMissionAction,
  mapAgentMissionRun,
  mapAgentMissionStep,
  mapAgentMissionEvent,
  mapJobRun,
} from "./prisma-store-mappers";
import { publishWorkbenchStreamEvent } from "@/lib/workbench-event-stream";

export function jobRunPatchToPrismaData(patch: Partial<JobRun>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (Object.prototype.hasOwnProperty.call(patch, "completedAt")) {
    data.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;
  }
  if (patch.summary !== undefined) data.summary = patch.summary;
  if (patch.resultCount !== undefined) data.resultCount = patch.resultCount;
  if (patch.error !== undefined) data.error = patch.error ?? null;
  if (patch.metadata !== undefined) data.metadata = patch.metadata as object;
  return data;
}

export const prismaStoreWorkbench = {
  async listWorkbenchSessions(companyId?: string): Promise<WorkbenchSession[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.workbenchSession.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapWorkbenchSession);
  },

  async getWorkbenchSession(id: string): Promise<WorkbenchSession | undefined> {
    const row = await db.workbenchSession.findUnique({ where: { id } });
    return row ? mapWorkbenchSession(row) : undefined;
  },

  async createWorkbenchSession(
    input: Omit<WorkbenchSession, "id" | "createdAt" | "updatedAt" | "costCents" | "messageCount" | "agentMode"> & {
      costCents?: number;
      agentMode?: WorkbenchAgentMode;
    }
  ): Promise<WorkbenchSession> {
    const id = makeId("workbench");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const session = await tx.workbenchSession.create({
        data: {
          id,
          companyId: input.companyId,
          taskId: input.taskId ?? null,
          agentRole: input.agentRole,
          agentMode: input.agentMode ?? "build",
          messageCount: 0,
          status: input.status,
          provider: input.provider,
          objective: input.objective,
          repoUrl: input.repoUrl ?? null,
          branchName: input.branchName ?? null,
          workdir: input.workdir ?? null,
          previewUrl: input.previewUrl ?? null,
          storageKey: input.storageKey ?? null,
          costCents: input.costCents ?? 0,
          startedAt: input.startedAt ? new Date(input.startedAt) : null,
          stoppedAt: input.stoppedAt ? new Date(input.stoppedAt) : null,
          createdAt: timestamp,
          updatedAt: timestamp,
          metadata: input.metadata as object
        }
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: input.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(prevHash, auditId, "agent", "workbench.create", id, input.objective, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "workbench.create",
          objectType: "workbench_session",
          objectId: id,
          summary: input.objective,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return session;
    });

    return mapWorkbenchSession(row);
  },

  async updateWorkbenchSession(id: string, patch: Partial<WorkbenchSession>): Promise<WorkbenchSession | undefined> {
    const existing = await db.workbenchSession.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.agentMode !== undefined) data.agentMode = patch.agentMode;
    if (patch.messageCount !== undefined) data.messageCount = patch.messageCount;
    if (patch.costCents !== undefined) data.costCents = patch.costCents;
    if (patch.startedAt !== undefined) data.startedAt = patch.startedAt ? new Date(patch.startedAt) : null;
    if (patch.stoppedAt !== undefined) data.stoppedAt = patch.stoppedAt ? new Date(patch.stoppedAt) : null;
    if (patch.objective !== undefined) data.objective = patch.objective;
    if (patch.repoUrl !== undefined) data.repoUrl = patch.repoUrl ?? null;
    if (patch.branchName !== undefined) data.branchName = patch.branchName ?? null;
    if (patch.workdir !== undefined) data.workdir = patch.workdir ?? null;
    if (patch.previewUrl !== undefined) data.previewUrl = patch.previewUrl ?? null;
    if (patch.storageKey !== undefined) data.storageKey = patch.storageKey ?? null;
    if (patch.metadata !== undefined) data.metadata = patch.metadata as object;

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.workbenchSession.update({
        where: { id },
        data: { ...data, updatedAt: new Date() }
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: existing.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const summary = patch.status ?? "updated settings";
      const auditHash = computeAuditHash(prevHash, auditId, "system", "workbench.update", id, summary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "system",
          action: "workbench.update",
          objectType: "workbench_session",
          objectId: id,
          summary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapWorkbenchSession(row);
  },

  async deleteWorkbenchSession(id: string): Promise<boolean> {
    const existing = await db.workbenchSession.findUnique({ where: { id } });
    if (!existing) return false;

    await db.$transaction(async (tx) => {
      await tx.workbenchSession.delete({ where: { id } });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: existing.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(prevHash, auditId, "user", "workbench.delete", id, existing.objective, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "user",
          action: "workbench.delete",
          objectType: "workbench_session",
          objectId: id,
          summary: existing.objective,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });
    });

    return true;
  },

  async listWorkbenchEvents(sessionId: string): Promise<WorkbenchEvent[]> {
    const rows = await db.workbenchEvent.findMany({
      where: { sessionId },
      orderBy: [{ seq: "asc" }, { createdAt: "asc" }]
    });
    return rows.map(mapWorkbenchEvent);
  },

  async addWorkbenchEvent(input: Omit<WorkbenchEvent, "id" | "createdAt">): Promise<WorkbenchEvent> {
    const row = await db.$transaction(async (tx) => {
      const last = await tx.workbenchEvent.findFirst({
        where: { sessionId: input.sessionId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      return tx.workbenchEvent.create({
        data: {
          id: makeId("wbevent"),
          companyId: input.companyId,
          sessionId: input.sessionId,
          seq: input.seq ?? ((last?.seq ?? 0) + 1),
          type: input.type,
          status: input.status,
          title: input.title,
          content: input.content,
          command: input.command ?? null,
          artifactId: input.artifactId ?? null,
          attemptNo: input.attemptNo ?? null,
          durationMs: input.durationMs ?? null,
          agentRole: input.agentRole ?? null,
          metadata: input.metadata as object | undefined
        }
      });
    });
    const event = mapWorkbenchEvent(row);
    publishWorkbenchStreamEvent(event);
    return event;
  },

  async listWorkbenchArtifacts(sessionId: string): Promise<WorkbenchArtifact[]> {
    const rows = await db.workbenchArtifact.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapWorkbenchArtifact);
  },

  async addWorkbenchArtifact(input: Omit<WorkbenchArtifact, "id" | "createdAt">): Promise<WorkbenchArtifact> {
    const id = makeId("wbartifact");

    const row = await db.$transaction(async (tx) => {
      const artifact = await tx.workbenchArtifact.create({
        data: {
          id,
          companyId: input.companyId,
          sessionId: input.sessionId,
          kind: input.kind,
          title: input.title,
          storageKey: input.storageKey,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          createdByAgent: input.createdByAgent ?? null,
          sourceEventId: input.sourceEventId ?? null,
          path: input.path ?? null,
          previewUrl: input.previewUrl ?? null,
          metadata: input.metadata as object | undefined
        }
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: input.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(prevHash, auditId, "agent", "workbench.artifact", id, input.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "workbench.artifact",
          objectType: "workbench_artifact",
          objectId: id,
          summary: input.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return artifact;
    });

    return mapWorkbenchArtifact(row);
  },

  async createWorkbenchAttempt(input: Omit<WorkbenchAttempt, "id" | "startedAt">): Promise<WorkbenchAttempt> {
    const row = await db.workbenchAttempt.create({
      data: {
        id: makeId("wbattempt"),
        companyId: input.companyId,
        sessionId: input.sessionId,
        attemptNo: input.attemptNo,
        status: input.status,
        model: input.model,
        feedback: input.feedback ?? null,
        rawArtifact: input.rawArtifact ?? null,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costCents: input.costCents,
        completedAt: input.completedAt ? new Date(input.completedAt) : null,
      }
    });
    return mapWorkbenchAttempt(row);
  },

  async updateWorkbenchAttempt(id: string, patch: Partial<WorkbenchAttempt>): Promise<WorkbenchAttempt | undefined> {
    const existing = await db.workbenchAttempt.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.model !== undefined) data.model = patch.model;
    if (patch.feedback !== undefined) data.feedback = patch.feedback ?? null;
    if (patch.rawArtifact !== undefined) data.rawArtifact = patch.rawArtifact ?? null;
    if (patch.inputTokens !== undefined) data.inputTokens = patch.inputTokens;
    if (patch.outputTokens !== undefined) data.outputTokens = patch.outputTokens;
    if (patch.costCents !== undefined) data.costCents = patch.costCents;
    if (patch.completedAt !== undefined) data.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;

    const row = await db.workbenchAttempt.update({ where: { id }, data });
    return mapWorkbenchAttempt(row);
  },

  async listWorkbenchAttempts(sessionId: string): Promise<WorkbenchAttempt[]> {
    const rows = await db.workbenchAttempt.findMany({
      where: { sessionId },
      orderBy: [{ attemptNo: "asc" }, { startedAt: "asc" }]
    });
    return rows.map(mapWorkbenchAttempt);
  },

  async upsertWorkbenchCheckpoint(input: Omit<WorkbenchCheckpoint, "id" | "updatedAt">): Promise<WorkbenchCheckpoint> {
    const data = {
      companyId: input.companyId,
      sessionId: input.sessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId ?? null,
      workdir: input.workdir ?? null,
      previewUrl: input.previewUrl ?? null,
      activePort: input.activePort ?? null,
      fileTreeHash: input.fileTreeHash ?? null,
      latestVerification: input.latestVerification as object | undefined,
      sandboxExpiresAt: input.sandboxExpiresAt ? new Date(input.sandboxExpiresAt) : null,
      updatedAt: new Date(),
    };
    const row = await db.workbenchCheckpoint.upsert({
      where: { sessionId: input.sessionId },
      create: { id: makeId("wbcheckpoint"), ...data },
      update: data
    });
    return mapWorkbenchCheckpoint(row);
  },

  async getWorkbenchCheckpoint(sessionId: string): Promise<WorkbenchCheckpoint | undefined> {
    const row = await db.workbenchCheckpoint.findUnique({ where: { sessionId } });
    return row ? mapWorkbenchCheckpoint(row) : undefined;
  },

  async listWorkbenchChatMessages(sessionId: string): Promise<WorkbenchChatMessage[]> {
    const rows = await db.workbenchChatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(mapWorkbenchChatMessage);
  },

  async addWorkbenchChatMessage(input: Omit<WorkbenchChatMessage, "id" | "createdAt">): Promise<WorkbenchChatMessage> {
    const id = makeId("wbmsg");
    const row = await db.$transaction(async (tx) => {
      const message = await tx.workbenchChatMessage.create({
        data: {
          id,
          companyId: input.companyId,
          sessionId: input.sessionId,
          role: input.role,
          content: input.content,
          agentMode: input.agentMode ?? null
        }
      });
      await tx.workbenchSession.update({
        where: { id: input.sessionId },
        data: { messageCount: { increment: 1 }, updatedAt: new Date() }
      }).catch(() => {});
      return message;
    });
    return mapWorkbenchChatMessage(row);
  },

  async getWorkbenchSessionStats(companyId: string): Promise<WorkbenchSessionStats> {
    const rows = await db.workbenchSession.findMany({
      where: { companyId },
      orderBy: { updatedAt: "desc" }
    });
    const sessions = rows.map(mapWorkbenchSession);
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
    const timestamp = new Date();
    const row = await db.$transaction(async (tx) => {
      const run = await tx.orchestratorRun.create({
        data: {
          id: input.id,
          companyId: input.companyId,
          objective: input.objective,
          trigger: input.trigger,
          status: input.status,
          modelPolicy: input.modelPolicy as object,
          budgetCents: input.budgetCents,
          costCents: input.costCents,
          replanCount: input.replanCount ?? 0,
          summary: input.summary ?? null,
          cycleId: input.cycleId ?? null,
          startedAt: input.startedAt ? new Date(input.startedAt) : timestamp,
          completedAt: input.completedAt ? new Date(input.completedAt) : null,
          updatedAt: input.updatedAt ? new Date(input.updatedAt) : timestamp,
        }
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: input.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(
        prevHash,
        auditId,
        "agent",
        "orchestration.run.create",
        input.id,
        input.objective,
        auditCreatedAt
      );
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "orchestration.run.create",
          objectType: "orchestrator_run",
          objectId: input.id,
          summary: input.objective,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return run;
    });
    return mapOrchestratorRun(row);
  },

  async getOrchestratorRun(id: string): Promise<OrchestratorRun | undefined> {
    const row = await db.orchestratorRun.findUnique({ where: { id } });
    return row ? mapOrchestratorRun(row) : undefined;
  },

  async listOrchestratorRuns(companyId: string): Promise<OrchestratorRun[]> {
    const rows = await db.orchestratorRun.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" }
    });
    return rows.map(mapOrchestratorRun);
  },

  async updateOrchestratorRun(id: string, patch: Partial<OrchestratorRun>): Promise<OrchestratorRun | undefined> {
    const existing = await db.orchestratorRun.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.objective !== undefined) data.objective = patch.objective;
    if (patch.trigger !== undefined) data.trigger = patch.trigger;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.modelPolicy !== undefined) data.modelPolicy = patch.modelPolicy as object;
    if (patch.budgetCents !== undefined) data.budgetCents = patch.budgetCents;
    if (patch.costCents !== undefined) data.costCents = patch.costCents;
    if (patch.replanCount !== undefined) data.replanCount = patch.replanCount;
    if (patch.summary !== undefined) data.summary = patch.summary ?? null;
    if (patch.cycleId !== undefined) data.cycleId = patch.cycleId ?? null;
    if (patch.completedAt !== undefined) data.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;

    const row = await db.orchestratorRun.update({
      where: { id },
      data: { ...data, updatedAt: new Date() }
    });
    return mapOrchestratorRun(row);
  },

  async upsertOrchestratorStep(input: OrchestratorStep): Promise<OrchestratorStep> {
    const data = {
      runId: input.runId,
      companyId: input.companyId,
      seq: input.seq,
      title: input.title,
      rationale: input.rationale,
      agentRole: input.agentRole,
      dependsOn: input.dependsOn as object,
      expectedOutput: input.expectedOutput,
      riskLevel: input.riskLevel,
      needsApproval: input.needsApproval,
      status: input.status,
      output: input.output ?? null,
      critique: input.critique as object | undefined,
      model: input.model ?? null,
      tokens: input.tokens ?? null,
      costCents: input.costCents ?? null,
      toolCalls: input.toolCalls as object | undefined,
      approvalId: input.approvalId ?? null,
      startedAt: input.startedAt ? new Date(input.startedAt) : null,
      completedAt: input.completedAt ? new Date(input.completedAt) : null,
    };
    const row = await db.orchestratorStep.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: data
    });
    return mapOrchestratorStep(row);
  },

  async listOrchestratorSteps(runId: string): Promise<OrchestratorStep[]> {
    const rows = await db.orchestratorStep.findMany({
      where: { runId },
      orderBy: { seq: "asc" }
    });
    return rows.map(mapOrchestratorStep);
  },

  async appendOrchestratorEvent(
    input: Omit<OrchestratorEvent, "id" | "seq" | "createdAt"> & { seq?: number }
  ): Promise<OrchestratorEvent> {
    const row = await db.$transaction(async (tx) => {
      const last = await tx.orchestratorEvent.findFirst({
        where: { runId: input.runId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      return tx.orchestratorEvent.create({
        data: {
          id: makeId("orcevent"),
          runId: input.runId,
          companyId: input.companyId,
          seq: input.seq ?? ((last?.seq ?? 0) + 1),
          kind: input.kind,
          stepId: input.stepId ?? null,
          payload: input.payload as object,
        }
      });
    });
    return mapOrchestratorEvent(row);
  },

  async listOrchestratorEvents(runId: string): Promise<OrchestratorEvent[]> {
    const rows = await db.orchestratorEvent.findMany({
      where: { runId },
      orderBy: [{ seq: "asc" }, { createdAt: "asc" }]
    });
    return rows.map(mapOrchestratorEvent);
  },

  async createContentMissionRun(
    input: Omit<ContentMissionRun, "startedAt" | "updatedAt"> & { startedAt?: string; updatedAt?: string }
  ): Promise<ContentMissionRun> {
    const timestamp = new Date();
    const row = await db.$transaction(async (tx) => {
      const run = await tx.contentMissionRun.create({
        data: {
          id: input.id,
          companyId: input.companyId,
          runId: input.runId,
          cycleId: input.cycleId ?? null,
          objective: input.objective,
          operatingMode: input.operatingMode,
          status: input.status,
          ownerSeat: input.ownerSeat,
          externalActionStatus: input.externalActionStatus,
          requiredSocialPlatforms: input.requiredSocialPlatforms as object,
          requiredMarketingPlatforms: input.requiredMarketingPlatforms as object,
          socialPublishingRequested: input.socialPublishingRequested,
          paidAdsRequested: input.paidAdsRequested,
          approvalGates: input.approvalGates as object,
          memoryLogFields: input.memoryLogFields as object,
          creativeApps: input.creativeApps as object,
          budgetCents: input.budgetCents,
          costCents: input.costCents,
          summary: input.summary ?? null,
          memoryLogArtifactId: input.memoryLogArtifactId ?? null,
          startedAt: input.startedAt ? new Date(input.startedAt) : timestamp,
          completedAt: input.completedAt ? new Date(input.completedAt) : null,
          updatedAt: input.updatedAt ? new Date(input.updatedAt) : timestamp,
        }
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: input.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(
        prevHash,
        auditId,
        "agent",
        "content_mission.run.create",
        input.id,
        input.objective,
        auditCreatedAt
      );
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "content_mission.run.create",
          objectType: "content_mission_run",
          objectId: input.id,
          summary: input.objective,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return run;
    });
    return mapContentMissionRun(row);
  },

  async getContentMissionRun(id: string): Promise<ContentMissionRun | undefined> {
    const row = await db.contentMissionRun.findUnique({ where: { id } });
    return row ? mapContentMissionRun(row) : undefined;
  },

  async listContentMissionRuns(companyId: string): Promise<ContentMissionRun[]> {
    const rows = await db.contentMissionRun.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" }
    });
    return rows.map(mapContentMissionRun);
  },

  async updateContentMissionRun(
    id: string,
    patch: Partial<ContentMissionRun>
  ): Promise<ContentMissionRun | undefined> {
    const existing = await db.contentMissionRun.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.objective !== undefined) data.objective = patch.objective;
    if (patch.operatingMode !== undefined) data.operatingMode = patch.operatingMode;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.ownerSeat !== undefined) data.ownerSeat = patch.ownerSeat;
    if (patch.externalActionStatus !== undefined) data.externalActionStatus = patch.externalActionStatus;
    if (patch.requiredSocialPlatforms !== undefined) data.requiredSocialPlatforms = patch.requiredSocialPlatforms as object;
    if (patch.requiredMarketingPlatforms !== undefined) data.requiredMarketingPlatforms = patch.requiredMarketingPlatforms as object;
    if (patch.socialPublishingRequested !== undefined) data.socialPublishingRequested = patch.socialPublishingRequested;
    if (patch.paidAdsRequested !== undefined) data.paidAdsRequested = patch.paidAdsRequested;
    if (patch.approvalGates !== undefined) data.approvalGates = patch.approvalGates as object;
    if (patch.memoryLogFields !== undefined) data.memoryLogFields = patch.memoryLogFields as object;
    if (patch.creativeApps !== undefined) data.creativeApps = patch.creativeApps as object;
    if (patch.budgetCents !== undefined) data.budgetCents = patch.budgetCents;
    if (patch.costCents !== undefined) data.costCents = patch.costCents;
    if (patch.summary !== undefined) data.summary = patch.summary ?? null;
    if (patch.memoryLogArtifactId !== undefined) data.memoryLogArtifactId = patch.memoryLogArtifactId ?? null;
    if (patch.cycleId !== undefined) data.cycleId = patch.cycleId ?? null;
    if (patch.completedAt !== undefined) data.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;

    const row = await db.contentMissionRun.update({
      where: { id },
      data: { ...data, updatedAt: new Date() }
    });
    return mapContentMissionRun(row);
  },

  async upsertContentMissionAction(input: ContentMissionAction): Promise<ContentMissionAction> {
    const data = {
      runId: input.runId,
      companyId: input.companyId,
      ledgerItemId: input.ledgerItemId,
      kind: input.kind,
      owner: input.owner,
      status: input.status,
      approvalGate: input.approvalGate,
      sourceStage: input.sourceStage,
      reason: input.reason,
      relatedPlatforms: input.relatedPlatforms as object,
      approvalId: input.approvalId ?? null,
    };
    const row = await db.contentMissionAction.upsert({
      where: { runId_ledgerItemId: { runId: input.runId, ledgerItemId: input.ledgerItemId } },
      create: { id: input.id, ...data },
      update: data
    });
    return mapContentMissionAction(row);
  },

  async listContentMissionActions(runId: string): Promise<ContentMissionAction[]> {
    const rows = await db.contentMissionAction.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(mapContentMissionAction);
  },

  async createAgentMissionRun(
    input: Omit<AgentMissionRun, "startedAt" | "updatedAt"> & { startedAt?: string; updatedAt?: string }
  ): Promise<AgentMissionRun> {
    const timestamp = new Date();
    const row = await db.$transaction(async (tx) => {
      const run = await tx.agentMissionRun.create({
        data: {
          id: input.id,
          companyId: input.companyId,
          objective: input.objective,
          missionType: input.missionType,
          status: input.status,
          trigger: input.trigger,
          ownerSeat: input.ownerSeat,
          budgetCents: input.budgetCents,
          costCents: input.costCents,
          approvalPolicy: input.approvalPolicy as object,
          modelPolicy: input.modelPolicy as object,
          finalSummary: input.finalSummary ?? null,
          startedAt: input.startedAt ? new Date(input.startedAt) : timestamp,
          completedAt: input.completedAt ? new Date(input.completedAt) : null,
          updatedAt: input.updatedAt ? new Date(input.updatedAt) : timestamp,
        }
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: input.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(
        prevHash,
        auditId,
        "agent",
        "agent_mission.run.create",
        input.id,
        input.objective,
        auditCreatedAt
      );
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "agent_mission.run.create",
          objectType: "agent_mission_run",
          objectId: input.id,
          summary: input.objective,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return run;
    });
    return mapAgentMissionRun(row);
  },

  async getAgentMissionRun(id: string): Promise<AgentMissionRun | undefined> {
    const row = await db.agentMissionRun.findUnique({ where: { id } });
    return row ? mapAgentMissionRun(row) : undefined;
  },

  async listAgentMissionRuns(companyId: string): Promise<AgentMissionRun[]> {
    const rows = await db.agentMissionRun.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" }
    });
    return rows.map(mapAgentMissionRun);
  },

  async updateAgentMissionRun(id: string, patch: Partial<AgentMissionRun>): Promise<AgentMissionRun | undefined> {
    const existing = await db.agentMissionRun.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.objective !== undefined) data.objective = patch.objective;
    if (patch.missionType !== undefined) data.missionType = patch.missionType;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.trigger !== undefined) data.trigger = patch.trigger;
    if (patch.ownerSeat !== undefined) data.ownerSeat = patch.ownerSeat;
    if (patch.budgetCents !== undefined) data.budgetCents = patch.budgetCents;
    if (patch.costCents !== undefined) data.costCents = patch.costCents;
    if (patch.approvalPolicy !== undefined) data.approvalPolicy = patch.approvalPolicy as object;
    if (patch.modelPolicy !== undefined) data.modelPolicy = patch.modelPolicy as object;
    if (patch.finalSummary !== undefined) data.finalSummary = patch.finalSummary ?? null;
    if (patch.completedAt !== undefined) data.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;

    const row = await db.agentMissionRun.update({
      where: { id },
      data: { ...data, updatedAt: new Date() }
    });
    return mapAgentMissionRun(row);
  },

  async upsertAgentMissionStep(input: AgentMissionStep): Promise<AgentMissionStep> {
    const data = {
      runId: input.runId,
      companyId: input.companyId,
      seq: input.seq,
      agentRole: input.agentRole,
      title: input.title,
      objective: input.objective,
      status: input.status,
      dependsOn: input.dependsOn as object,
      expectedOutput: input.expectedOutput,
      output: input.output ?? null,
      toolCalls: input.toolCalls as object | undefined,
      costCents: input.costCents,
      approvalId: input.approvalId ?? null,
      startedAt: input.startedAt ? new Date(input.startedAt) : null,
      completedAt: input.completedAt ? new Date(input.completedAt) : null,
    };
    const row = await db.agentMissionStep.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: data
    });
    return mapAgentMissionStep(row);
  },

  async listAgentMissionSteps(runId: string): Promise<AgentMissionStep[]> {
    const rows = await db.agentMissionStep.findMany({
      where: { runId },
      orderBy: { seq: "asc" }
    });
    return rows.map(mapAgentMissionStep);
  },

  async appendAgentMissionEvent(
    input: Omit<AgentMissionEvent, "id" | "seq" | "createdAt"> & { seq?: number }
  ): Promise<AgentMissionEvent> {
    const row = await db.$transaction(async (tx) => {
      const last = await tx.agentMissionEvent.findFirst({
        where: { runId: input.runId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      return tx.agentMissionEvent.create({
        data: {
          id: makeId("amevent"),
          runId: input.runId,
          companyId: input.companyId,
          seq: input.seq ?? ((last?.seq ?? 0) + 1),
          kind: input.kind,
          stepId: input.stepId ?? null,
          payload: input.payload as object,
        }
      });
    });
    return mapAgentMissionEvent(row);
  },

  async listAgentMissionEvents(runId: string): Promise<AgentMissionEvent[]> {
    const rows = await db.agentMissionEvent.findMany({
      where: { runId },
      orderBy: [{ seq: "asc" }, { createdAt: "asc" }]
    });
    return rows.map(mapAgentMissionEvent);
  },

  async createJobRun(input: Omit<JobRun, "id" | "startedAt">): Promise<JobRun> {
    const id = makeId("job");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const job = await tx.jobRun.create({
        data: {
          id,
          type: input.type,
          status: input.status,
          companyId: input.companyId ?? null,
          trigger: input.trigger,
          startedAt: timestamp,
          completedAt: input.completedAt ? new Date(input.completedAt) : null,
          summary: input.summary,
          resultCount: input.resultCount,
          error: input.error ?? null,
          metadata: input.metadata as object
        }
      });

      if (input.companyId) {
        const auditId = makeId("audit");
        const auditCreatedAt = nowIso();
        const lastAuditRow = await tx.auditLog.findFirst({
          where: { companyId: input.companyId },
          orderBy: { createdAt: "desc" },
          select: { hash: true },
        });
        const prevHash = lastAuditRow?.hash ?? "genesis";
        const actor = input.trigger === "user" ? "user" : "system";
        const auditHash = computeAuditHash(prevHash, auditId, actor, "job.started", id, input.summary, auditCreatedAt);
        await tx.auditLog.create({
          data: {
            id: auditId,
            companyId: input.companyId,
            actor,
            action: "job.started",
            objectType: "job_run",
            objectId: id,
            summary: input.summary,
            hash: auditHash,
            prevHash,
            createdAt: new Date(auditCreatedAt),
          }
        });
      }

      return job;
    });

    return mapJobRun(row);
  },

  async getJobRun(id: string): Promise<JobRun | undefined> {
    const row = await db.jobRun.findUnique({ where: { id } });
    return row ? mapJobRun(row) : undefined;
  },

  async updateJobRun(id: string, patch: Partial<JobRun>): Promise<JobRun | undefined> {
    const existing = await db.jobRun.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data = jobRunPatchToPrismaData(patch);

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.jobRun.update({
        where: { id },
        data
      });

      if (existing.companyId && patch.status) {
        const auditId = makeId("audit");
        const auditCreatedAt = nowIso();
        const lastAuditRow = await tx.auditLog.findFirst({
          where: { companyId: existing.companyId },
          orderBy: { createdAt: "desc" },
          select: { hash: true },
        });
        const prevHash = lastAuditRow?.hash ?? "genesis";
        const summary = patch.summary ?? existing.summary;
        const auditHash = computeAuditHash(prevHash, auditId, "system", `job.${patch.status}`, id, summary, auditCreatedAt);
        await tx.auditLog.create({
          data: {
            id: auditId,
            companyId: existing.companyId,
            actor: "system",
            action: `job.${patch.status}`,
            objectType: "job_run",
            objectId: id,
            summary,
            hash: auditHash,
            prevHash,
            createdAt: new Date(auditCreatedAt),
          }
        });
      }

      return updated;
    });

    return mapJobRun(row);
  },

  async listJobRuns(companyId?: string): Promise<JobRun[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.jobRun.findMany({
      where,
      orderBy: { startedAt: "desc" }
    });
    return rows.map(mapJobRun);
  }
};
