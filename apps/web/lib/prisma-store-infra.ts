import type {
  AuditLog,
  CeoMessage,
  CeoSuggestion,
  Comment,
  CommentEntityType,
  Company,
  RecurringTaskTemplate,
  ToolConnection,
  UsageLedgerEntry,
} from "@/lib/types";
import { db } from "@/lib/db";
import { makeId, nowIso } from "@/lib/utils";
import { buildDefaultRecurringTasks, nextCycleAtForFrequency } from "@/lib/store-helpers";
import { computeAuditHash } from "@/lib/audit-log";
import {
  mapUsage,
  mapToolConnection,
  mapAuditLog,
  mapCeoMessage,
  mapCeoSuggestion,
  toIsoReq,
} from "./prisma-store-mappers";

export const prismaStoreInfra = {
  async listUsage(companyId?: string): Promise<UsageLedgerEntry[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.usageLedgerEntry.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapUsage);
  },

  async addUsage(input: Omit<UsageLedgerEntry, "id" | "createdAt">): Promise<UsageLedgerEntry> {
    const row = await db.usageLedgerEntry.create({
      data: {
        id: makeId("usage"),
        companyId: input.companyId,
        category: input.category,
        description: input.description,
        amountCents: input.amountCents,
        metadata: input.metadata as object,
        invoiceId: input.invoiceId ?? null
      }
    });
    return mapUsage(row);
  },

  async listIntegrations(companyId?: string): Promise<ToolConnection[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.toolConnection.findMany({ where });
    return rows.map(mapToolConnection);
  },

  async getIntegration(companyId: string, provider: string): Promise<ToolConnection | undefined> {
    const row = await db.toolConnection.findFirst({
      where: {
        companyId,
        provider: { equals: provider, mode: "insensitive" }
      }
    });
    return row ? mapToolConnection(row) : undefined;
  },

  async upsertIntegration(
    input: Omit<ToolConnection, "id" | "lastCheckedAt">
  ): Promise<ToolConnection> {
    const existing = await db.toolConnection.findFirst({
      where: {
        companyId: input.companyId,
        provider: { equals: input.provider, mode: "insensitive" }
      }
    });
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      let connection;
      let action = "integration.create";
      let summary = `Connected ${input.provider}`;

      if (existing) {
        action = "integration.update";
        summary = `Updated ${input.provider}`;
        connection = await tx.toolConnection.update({
          where: { id: existing.id },
          data: {
            scopes: input.scopes,
            status: input.status,
            encryptedData: input.encryptedData ?? null,
            lastCheckedAt: timestamp
          }
        });
      } else {
        connection = await tx.toolConnection.create({
          data: {
            id: makeId("connection"),
            companyId: input.companyId,
            provider: input.provider,
            scopes: input.scopes,
            status: input.status,
            encryptedData: input.encryptedData ?? null,
            lastCheckedAt: timestamp
          }
        });
      }

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: input.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(prevHash, auditId, "user", action, connection.id, summary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "user",
          action,
          objectType: "tool_connection",
          objectId: connection.id,
          summary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return connection;
    });

    return mapToolConnection(row);
  },

  async revokeIntegration(id: string): Promise<void> {
    const existing = await db.toolConnection.findUnique({ where: { id } });
    if (existing) {
      await db.toolConnection.delete({ where: { id } });
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
    const id = makeId("audit");
    const createdAt = nowIso();

    await db.$transaction(async (tx) => {
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const hash = computeAuditHash(prevHash, id, actor, action, objectId, summary, createdAt);

      await tx.auditLog.create({
        data: {
          id,
          companyId,
          actor,
          action,
          objectType,
          objectId,
          summary,
          hash,
          prevHash,
          createdAt: new Date(createdAt),
        }
      });
    });
  },

  async listAuditLogs(companyId?: string): Promise<AuditLog[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapAuditLog);
  },

  async getLastAuditHash(companyId: string): Promise<string | undefined> {
    const lastAuditRow = await db.auditLog.findFirst({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      select: { hash: true },
    });
    return lastAuditRow?.hash ?? undefined;
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
    await db.auditLog.create({
      data: {
        id: input.id,
        companyId: input.companyId,
        actor: input.actor,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        summary: input.summary,
        hash: input.hash,
        prevHash: input.prevHash,
        createdAt: new Date(input.createdAt),
      }
    });
  },

  nextCycleAt(frequency: Company["cycleFrequency"], fromIso = nowIso()): string | undefined {
    return nextCycleAtForFrequency(frequency, fromIso);
  },

  defaultRecurringTasks(companyId: string, createdAt: string): RecurringTaskTemplate[] {
    return buildDefaultRecurringTasks(companyId, createdAt);
  },

  async addCeoMessage(
    input: Omit<CeoMessage, "id" | "createdAt">
  ): Promise<CeoMessage> {
    const row = await db.ceoMessage.create({
      data: {
        id: makeId("ceomsg"),
        companyId: input.companyId,
        direction: input.direction,
        kind: input.kind,
        content: input.content
      }
    });
    return mapCeoMessage(row);
  },

  async listCeoMessages(companyId: string, limit = 60): Promise<CeoMessage[]> {
    const rows = await db.ceoMessage.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.reverse().map(mapCeoMessage);
  },

  async addCeoSuggestion(
    input: Omit<CeoSuggestion, "id" | "createdAt" | "status">
  ): Promise<CeoSuggestion> {
    const row = await db.ceoSuggestion.create({
      data: {
        id: makeId("suggestion"),
        companyId: input.companyId,
        title: input.title,
        body: input.body,
        category: input.category,
        status: "pending"
      }
    });
    return mapCeoSuggestion(row);
  },

  async listCeoSuggestions(companyId: string): Promise<CeoSuggestion[]> {
    const rows = await db.ceoSuggestion.findMany({
      where: { companyId, status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapCeoSuggestion);
  },

  async getCeoSuggestion(id: string): Promise<CeoSuggestion | undefined> {
    const row = await db.ceoSuggestion.findUnique({ where: { id } });
    return row ? mapCeoSuggestion(row) : undefined;
  },

  async updateCeoSuggestion(
    id: string,
    status: CeoSuggestions["status"]
  ): Promise<CeoSuggestion | undefined> {
    const row = await db.ceoSuggestion.update({
      where: { id },
      data: { status }
    });
    return mapCeoSuggestion(row);
  },

  async listComments(companyId: string, entityType: CommentEntityType, entityId: string): Promise<Comment[]> {
    const rows = await db.comment.findMany({
      where: { companyId, entityType, entityId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      entityType: r.entityType as CommentEntityType,
      entityId: r.entityId,
      authorName: r.authorName,
      agentRole: r.agentRole ?? undefined,
      content: r.content,
      createdAt: toIsoReq(r.createdAt),
    }));
  },

  async addComment(input: Omit<Comment, "id" | "createdAt">): Promise<Comment> {
    const row = await db.comment.create({
      data: {
        id: makeId("comment"),
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        authorName: input.authorName,
        agentRole: input.agentRole ?? null,
        content: input.content,
      }
    });
    return {
      id: row.id,
      companyId: row.companyId,
      entityType: row.entityType as CommentEntityType,
      entityId: row.entityId,
      authorName: row.authorName,
      agentRole: row.agentRole ?? undefined,
      content: row.content,
      createdAt: toIsoReq(row.createdAt),
    };
  }
};
type CeoSuggestions = { status: CeoSuggestion["status"] };
