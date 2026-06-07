import type {
  Approval,
  ApprovalStatus,
  Artifact,
  Document,
  MemorySearchResult,
  Report,
} from "@/lib/types";
import { db } from "@/lib/db";
import { makeId, nowIso } from "@/lib/utils";
import { computeAuditHash } from "@/lib/audit-log";
import {
  mapApproval,
  mapDocument,
  mapArtifact,
  mapReport,
  toIsoReq,
} from "./prisma-store-mappers";

export const prismaStoreDocs = {
  async listApprovals(companyId?: string): Promise<Approval[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.approval.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapApproval);
  },

  async getApproval(id: string): Promise<Approval | undefined> {
    const row = await db.approval.findUnique({ where: { id } });
    return row ? mapApproval(row) : undefined;
  },

  async createApproval(input: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
    const id = makeId("approval");
    const timestamp = new Date();
    const timestampIso = timestamp.toISOString();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(timestamp.getTime() + 48 * 60 * 60 * 1000);

    const row = await db.$transaction(async (tx) => {
      const approval = await tx.approval.create({
        data: {
          id,
          companyId: input.companyId,
          taskId: input.taskId ?? null,
          action: input.action,
          reason: input.reason,
          status: "pending",
          createdAt: timestamp,
          resolvedAt: null,
          expiresAt,
          toolName: input.toolName ?? null,
          previewContent: input.previewContent ?? null,
          previewKind: input.previewKind ?? null
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
      const auditHash = computeAuditHash(prevHash, auditId, "agent", "approval.request", id, input.action, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "approval.request",
          objectType: "approval",
          objectId: id,
          summary: input.action,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return approval;
    });

    return mapApproval(row);
  },

  async resolveApproval(id: string, status: "approved" | "rejected"): Promise<Approval | undefined> {
    const existing = await db.approval.findUnique({ where: { id } });
    if (!existing) return undefined;

    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.approval.update({
        where: { id },
        data: { status, resolvedAt: timestamp }
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: existing.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(prevHash, auditId, "user", `approval.${status}`, id, existing.action, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "user",
          action: `approval.${status}`,
          objectType: "approval",
          objectId: id,
          summary: existing.action,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapApproval(row);
  },

  async listDocuments(companyId?: string): Promise<Document[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.document.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapDocument);
  },

  async createDocument(
    input: Omit<Document, "id" | "createdAt" | "version"> & { version?: number }
  ): Promise<Document> {
    const id = makeId("doc");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          id,
          companyId: input.companyId,
          type: input.type,
          title: input.title,
          content: input.content,
          source: input.source,
          version: input.version ?? 1,
          memoryTier: input.memoryTier ?? null,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          validTo: input.validTo ? new Date(input.validTo) : null,
          supersedesId: input.supersedesId ?? null,
          createdAt: timestamp
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
      const auditHash = computeAuditHash(prevHash, auditId, "agent", "document.create", id, input.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "document.create",
          objectType: "document",
          objectId: id,
          summary: input.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return doc;
    });

    return mapDocument(row);
  },

  async updateDocument(id: string, patch: { title?: string; content?: string }): Promise<Document | undefined> {
    const existing = await db.document.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = { version: existing.version + 1 };
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.content !== undefined) data.content = patch.content;

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.document.update({
        where: { id },
        data
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: existing.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const summary = `${updated.title} (human correction)`;
      const auditHash = computeAuditHash(prevHash, auditId, "user", "document.update", id, summary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "user",
          action: "document.update",
          objectType: "document",
          objectId: id,
          summary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapDocument(row);
  },

  async expireDocument(id: string, validToIso: string): Promise<void> {
    await db.document.update({
      where: { id },
      data: { validTo: new Date(validToIso) }
    });
  },

  async listArtifacts(companyId?: string): Promise<Artifact[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.artifact.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapArtifact);
  },

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const row = await db.artifact.findUnique({ where: { id } });
    return row ? mapArtifact(row) : undefined;
  },

  async createArtifact(
    input: Omit<Artifact, "id" | "createdAt" | "updatedAt">
  ): Promise<Artifact> {
    const id = makeId("artifact");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const artifact = await tx.artifact.create({
        data: {
          id,
          companyId: input.companyId,
          sourceTaskId: input.sourceTaskId ?? null,
          sourceCycleId: input.sourceCycleId ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
          type: input.type,
          status: input.status,
          title: input.title,
          summary: input.summary,
          content: input.content,
          exportFormat: input.exportFormat,
          storageKey: input.storageKey ?? null,
          previewUrl: input.previewUrl ?? null,
          createdByAgent: input.createdByAgent,
          provenance: input.provenance as object,
          approvalStatus: input.approvalStatus ?? null,
          createdAt: timestamp,
          updatedAt: timestamp
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
      const auditHash = computeAuditHash(prevHash, auditId, "agent", "artifact.create", id, input.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "artifact.create",
          objectType: "artifact",
          objectId: id,
          summary: input.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return artifact;
    });

    return mapArtifact(row);
  },

  async updateArtifact(id: string, patch: Partial<Artifact>): Promise<Artifact | undefined> {
    const existing = await db.artifact.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.summary !== undefined) data.summary = patch.summary;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.exportFormat !== undefined) data.exportFormat = patch.exportFormat;
    if (patch.storageKey !== undefined) data.storageKey = patch.storageKey ?? null;
    if (patch.previewUrl !== undefined) data.previewUrl = patch.previewUrl ?? null;
    if (patch.approvalStatus !== undefined) data.approvalStatus = patch.approvalStatus ?? null;

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.artifact.update({
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
      const auditHash = computeAuditHash(prevHash, auditId, "user", "artifact.update", id, updated.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "user",
          action: "artifact.update",
          objectType: "artifact",
          objectId: id,
          summary: updated.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapArtifact(row);
  },

  async createReport(input: Omit<Report, "id" | "createdAt">): Promise<Report> {
    const id = makeId("report");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const report = await tx.report.create({
        data: {
          id,
          companyId: input.companyId,
          type: input.type,
          title: input.title,
          findings: input.findings,
          recommendations: input.recommendations,
          createdAt: timestamp
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
      const auditHash = computeAuditHash(prevHash, auditId, "agent", "report.create", id, input.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "report.create",
          objectType: "report",
          objectId: id,
          summary: input.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return report;
    });

    return mapReport(row);
  },

  async listReports(companyId: string): Promise<Report[]> {
    const rows = await db.report.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapReport);
  },

  async searchMemory(companyId: string, query: string): Promise<MemorySearchResult[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const now = new Date();
    const docs = await db.document.findMany({
      where: {
        companyId,
        OR: [
          { validTo: null },
          { validTo: { gt: now } }
        ]
      },
      orderBy: { createdAt: "desc" }
    });

    const reports = await db.report.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });

    const executions = await db.agentExecution.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });

    const tasks = await db.task.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });

    const score = (text: string) =>
      terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term) ? 1 : 0), 0);
    const excerpt = (text: string) => text.replace(/\s+/g, " ").slice(0, 220);

    const documentResults = docs.map((doc) => ({
      id: doc.id,
      kind: "document" as const,
      title: doc.title,
      excerpt: excerpt(doc.content),
      createdAt: toIsoReq(doc.createdAt),
      score: score(`${doc.title} ${doc.content} ${doc.source}`)
    }));

    const reportResults = reports.map((report) => {
      const findingsStr = (report.findings as string[]).join(" ");
      const recommendationsStr = (report.recommendations as string[]).join(" ");
      const text = `${report.title} ${findingsStr} ${recommendationsStr}`;
      return {
        id: report.id,
        kind: "report" as const,
        title: report.title,
        excerpt: excerpt(text),
        createdAt: toIsoReq(report.createdAt),
        score: score(text)
      };
    });

    const executionResults = executions.map((exec) => ({
      id: exec.id,
      kind: "execution" as const,
      title: `${exec.agentRole} execution`,
      excerpt: excerpt(exec.output),
      createdAt: toIsoReq(exec.createdAt),
      score: score(`${exec.agentRole} ${exec.input} ${exec.output}`)
    }));

    const taskResults = tasks.map((task) => ({
      id: task.id,
      kind: "task" as const,
      title: task.title,
      excerpt: excerpt(task.prompt),
      createdAt: toIsoReq(task.createdAt),
      score: score(`${task.title} ${task.prompt} ${(task.tags as string[]).join(" ")}`)
    }));

    return [...documentResults, ...reportResults, ...executionResults, ...taskResults]
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 12);
  }
};
