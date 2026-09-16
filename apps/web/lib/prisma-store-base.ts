import type {
  Agent,
  AgentEntitlement,
  AgentExecution,
  AgentRole,
  AgentSlotAssignment,
  Company,
  CompanyInput,
  Cycle,
  RecurringTaskTemplate,
  Task,
} from "@/lib/types";
import { db } from "@/lib/db";
import { createDefaultAgents } from "@/lib/agents";
import { buildSlotEnvironment, getCatalogAgent } from "@/lib/agent-catalog";
import {
  buildCompanyInput,
  buildDefaultRecurringTasks,
  nextCycleAtForFrequency
} from "@/lib/store-helpers";
import { makeId, nowIso, slugify } from "@/lib/utils";
import { seedDatabase } from "@/lib/seed";
import { computeAuditHash } from "@/lib/audit-log";
import {
  mapCompany,
  mapAgent,
  mapAgentPlugAssignment,
  mapAgentEntitlement,
  mapTask,
  mapRecurringTask,
  mapCycle,
  mapExecution,
} from "./prisma-store-mappers";

export const prismaStoreBase = {
  async listCompanies(): Promise<Company[]> {
    await seedDatabase();
    const rows = await db.company.findMany({
      where: { status: { not: "archived" } },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapCompany);
  },

  async getCompany(id: string): Promise<Company | undefined> {
    await seedDatabase();
    const row = await db.company.findFirst({ where: { OR: [{ id }, { slug: id }] } });
    return row ? mapCompany(row) : undefined;
  },

  async getMemberRole(userId: string, companyId: string): Promise<string | null> {
    const member = await db.companyMember.findUnique({
      where: { companyId_userId: { companyId, userId } },
      select: { role: true },
    });
    return member?.role ?? null;
  },

  async createCompany(input: CompanyInput): Promise<Company> {
    const id = makeId("company");
    const timestamp = new Date();
    const timestampIso = timestamp.toISOString();
    const baseSlug = slugify(input.name) || id;
    const existingSlug = await db.company.findUnique({ where: { slug: baseSlug }, select: { id: true } });
    const slug = existingSlug ? `${baseSlug}-${id.slice(-8)}` : baseSlug;
    const { brief, metrics } = buildCompanyInput(input);
    const cycleFrequency = (input.cycleFrequency ?? "daily") as Company["cycleFrequency"];
    const nextCycleAt = nextCycleAtForFrequency(cycleFrequency, timestampIso);

    const agents = createDefaultAgents(id);
    const recurringTemplates = buildDefaultRecurringTasks(id, timestampIso);

    const briefContent = Object.entries(brief)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n\n");

    const row = await db.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          id,
          name: input.name,
          slug,
          website: input.website ?? null,
          status: "active",
          autonomyLevel: input.autonomyLevel ?? "autonomous_with_approvals",
          publicVisibility: input.publicVisibility ?? true,
          publicSubdomain: `${slug}.trent.local`,
          timezone: input.timezone ?? "America/Toronto",
          budgetCents: input.budgetCents ?? 10000,
          cycleFrequency,
          nextCycleAt: nextCycleAt ? new Date(nextCycleAt) : null,
          brief: brief as object,
          metrics: metrics as object
        }
      });

      await tx.agent.createMany({
        data: agents.map((a) => ({
          id: a.id,
          companyId: id,
          role: a.role,
          name: a.name,
          description: a.description,
          enabled: a.enabled,
          modelPolicy: a.modelPolicy,
          permissions: a.permissions
        }))
      });

      await tx.document.create({
        data: {
          id: makeId("doc"),
          companyId: id,
          type: "brief",
          title: "Company Operating Brief",
          content: briefContent,
          source: "onboarding",
          version: 1
        }
      });

      await tx.recurringTaskTemplate.createMany({
        data: recurringTemplates.map((rt) => ({
          id: rt.id,
          companyId: id,
          title: rt.title,
          prompt: rt.prompt,
          agentRole: rt.agentRole,
          priority: rt.priority,
          tags: rt.tags,
          cadence: rt.cadence,
          enabled: rt.enabled,
          nextRunAt: new Date(rt.nextRunAt)
        }))
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: id },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditSummary = `Created ${input.name}`;
      const auditHash = computeAuditHash(prevHash, auditId, "user", "company.create", id, auditSummary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: id,
          actor: "user",
          action: "company.create",
          objectType: "company",
          objectId: id,
          summary: auditSummary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return company;
    });

    return mapCompany(row);
  },

  async updateCompany(id: string, patch: Partial<Company>): Promise<Company | undefined> {
    const existing = await db.company.findFirst({ where: { OR: [{ id }, { slug: id }] } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.slug !== undefined) data.slug = patch.slug;
    if (patch.website !== undefined) data.website = patch.website ?? null;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.autonomyLevel !== undefined) data.autonomyLevel = patch.autonomyLevel;
    if (patch.publicVisibility !== undefined) data.publicVisibility = patch.publicVisibility;
    if (patch.publicSubdomain !== undefined) data.publicSubdomain = patch.publicSubdomain;
    if (patch.timezone !== undefined) data.timezone = patch.timezone;
    if (patch.budgetCents !== undefined) data.budgetCents = patch.budgetCents;
    if (patch.cycleFrequency !== undefined) data.cycleFrequency = patch.cycleFrequency;
    if (patch.lastCycleAt !== undefined) data.lastCycleAt = patch.lastCycleAt ? new Date(patch.lastCycleAt) : null;
    if (patch.nextCycleAt !== undefined) data.nextCycleAt = patch.nextCycleAt ? new Date(patch.nextCycleAt) : null;
    if (patch.brief !== undefined) data.brief = patch.brief as object;
    if (patch.metrics !== undefined) data.metrics = patch.metrics as object;
    if (patch.weeklyBudgetCents !== undefined) data.weeklyBudgetCents = patch.weeklyBudgetCents ?? null;
    if (patch.nightlyRunHour !== undefined) data.nightlyRunHour = patch.nightlyRunHour ?? null;
    if (patch.approvalExpiryOverrides !== undefined) data.approvalExpiryOverrides = patch.approvalExpiryOverrides as object;

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.company.update({
        where: { id: existing.id },
        data
      });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: existing.id },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditSummary = "Updated company settings";
      const auditHash = computeAuditHash(prevHash, auditId, "user", "company.update", existing.id, auditSummary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.id,
          actor: "user",
          action: "company.update",
          objectType: "company",
          objectId: existing.id,
          summary: auditSummary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapCompany(row);
  },

  async listAgents(companyId: string): Promise<Agent[]> {
    const rows = await db.agent.findMany({ where: { companyId } });
    return rows.map(mapAgent);
  },

  async getAgent(agentId: string): Promise<Agent | undefined> {
    const row = await db.agent.findUnique({ where: { id: agentId } });
    return row ? mapAgent(row) : undefined;
  },

  async updateAgent(agentId: string, patch: Partial<Agent>): Promise<Agent | undefined> {
    const existing = await db.agent.findUnique({ where: { id: agentId } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.modelPolicy !== undefined) data.modelPolicy = patch.modelPolicy;
    if (patch.permissions !== undefined) data.permissions = patch.permissions;

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.agent.update({
        where: { id: agentId },
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
      const auditSummary = `Updated ${updated.name}`;
      const auditHash = computeAuditHash(prevHash, auditId, "user", "agent.update", agentId, auditSummary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "user",
          action: "agent.update",
          objectType: "agent",
          objectId: agentId,
          summary: auditSummary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapAgent(row);
  },

  async listAgentPlugAssignments(companyId: string): Promise<AgentSlotAssignment[]> {
    const rows = await db.agentPlugAssignment.findMany({ where: { companyId } });
    return rows.map(mapAgentPlugAssignment);
  },

  async getAgentPlugAssignment(
    companyId: string,
    role: AgentRole
  ): Promise<AgentSlotAssignment | undefined> {
    const row = await db.agentPlugAssignment.findFirst({
      where: { companyId, role }
    });
    return row ? mapAgentPlugAssignment(row) : undefined;
  },

  async upsertAgentPlugAssignment(input: {
    companyId: string;
    role: AgentRole;
    profileId: string;
    environment?: Partial<AgentSlotAssignment["environment"]>;
  }): Promise<AgentSlotAssignment> {
    const existing = await db.agentPlugAssignment.findFirst({
      where: { companyId: input.companyId, role: input.role }
    });
    const timestamp = new Date();
    const catalogAgent = getCatalogAgent(input.profileId);
    const environment = {
      ...buildSlotEnvironment(input.companyId, input.role),
      ...(catalogAgent?.skills ? { skills: [...catalogAgent.skills] } : {}),
      ...(input.environment ?? {})
    };

    const row = await db.$transaction(async (tx) => {
      let assignment;
      let action = "agent_plug.create";
      let summary = `Assigned ${input.profileId} to ${input.role} slot`;

      if (existing) {
        action = "agent_plug.update";
        summary = `Updated ${input.role} slot to ${input.profileId}`;
        assignment = await tx.agentPlugAssignment.update({
          where: { id: existing.id },
          data: {
            profileId: input.profileId,
            environment: environment as object,
            updatedAt: timestamp
          }
        });
      } else {
        assignment = await tx.agentPlugAssignment.create({
          data: {
            id: makeId("plug"),
            companyId: input.companyId,
            role: input.role,
            profileId: input.profileId,
            profileSource: "agency-agents",
            environment: environment as object,
            createdAt: timestamp,
            updatedAt: timestamp
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
      const auditHash = computeAuditHash(prevHash, auditId, "user", action, assignment.id, summary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "user",
          action,
          objectType: "agent_slot_assignment",
          objectId: assignment.id,
          summary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return assignment;
    });

    return mapAgentPlugAssignment(row);
  },

  async clearAgentPlugAssignment(companyId: string, role: AgentRole): Promise<void> {
    const existing = await db.agentPlugAssignment.findFirst({
      where: { companyId, role }
    });
    if (!existing) return;

    await db.$transaction(async (tx) => {
      await tx.agentPlugAssignment.delete({ where: { id: existing.id } });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const summary = `Cleared ${role} slot plug assignment`;
      const auditHash = computeAuditHash(prevHash, auditId, "user", "agent_plug.clear", `${companyId}:${role}`, summary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId,
          actor: "user",
          action: "agent_plug.clear",
          objectType: "agent_slot_assignment",
          objectId: `${companyId}:${role}`,
          summary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });
    });
  },

  async listAgentEntitlements(companyId: string): Promise<AgentEntitlement[]> {
    const rows = await db.agentEntitlement.findMany({ where: { companyId } });
    return rows.map(mapAgentEntitlement);
  },

  async grantAgentEntitlement(
    input: Omit<AgentEntitlement, "id" | "createdAt">
  ): Promise<AgentEntitlement> {
    const existing = await db.agentEntitlement.findFirst({
      where: {
        companyId: input.companyId,
        productId: input.productId,
        profileId: input.profileId ?? null,
        status: "active"
      }
    });
    if (existing) return mapAgentEntitlement(existing);

    const id = makeId("entitlement");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const entitlement = await tx.agentEntitlement.create({
        data: {
          id,
          companyId: input.companyId,
          productId: input.productId,
          profileId: input.profileId ?? null,
          source: input.source,
          status: "active",
          createdAt: timestamp,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
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
      const summary = `Granted ${input.productId}`;
      const auditHash = computeAuditHash(prevHash, auditId, "user", "agent_marketplace.entitlement_grant", id, summary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "user",
          action: "agent_marketplace.entitlement_grant",
          objectType: "agent_entitlement",
          objectId: id,
          summary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return entitlement;
    });

    return mapAgentEntitlement(row);
  },

  async revokeAgentEntitlement(
    companyId: string,
    productId: string
  ): Promise<AgentEntitlement[]> {
    const revokedAt = new Date();

    const activeRows = await db.agentEntitlement.findMany({
      where: { companyId, productId, status: "active" }
    });
    if (activeRows.length === 0) return [];

    const updatedRows = await db.$transaction(async (tx) => {
      const updated = [];
      for (const row of activeRows) {
        const u = await tx.agentEntitlement.update({
          where: { id: row.id },
          data: { status: "revoked", expiresAt: revokedAt }
        });
        updated.push(u);

        const auditId = makeId("audit");
        const auditCreatedAt = nowIso();
        const lastAuditRow = await tx.auditLog.findFirst({
          where: { companyId },
          orderBy: { createdAt: "desc" },
          select: { hash: true },
        });
        const prevHash = lastAuditRow?.hash ?? "genesis";
        const summary = `Revoked ${productId}`;
        const auditHash = computeAuditHash(prevHash, auditId, "user", "agent_marketplace.entitlement_revoke", row.id, summary, auditCreatedAt);
        await tx.auditLog.create({
          data: {
            id: auditId,
            companyId,
            actor: "user",
            action: "agent_marketplace.entitlement_revoke",
            objectType: "agent_entitlement",
            objectId: row.id,
            summary,
            hash: auditHash,
            prevHash,
            createdAt: new Date(auditCreatedAt),
          }
        });
      }
      return updated;
    });

    return updatedRows.map(mapAgentEntitlement);
  },

  async listTasks(companyId?: string): Promise<Task[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.task.findMany({ where });
    return rows.map(mapTask);
  },

  async getTask(id: string): Promise<Task | undefined> {
    const row = await db.task.findUnique({ where: { id } });
    return row ? mapTask(row) : undefined;
  },

  async createTask(
    input: Omit<Task, "id" | "createdAt" | "updatedAt" | "costCents"> & { costCents?: number }
  ): Promise<Task> {
    const id = makeId("task");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          id,
          companyId: input.companyId,
          title: input.title,
          prompt: input.prompt,
          status: input.status,
          priority: input.priority,
          agentRole: input.agentRole,
          tags: input.tags,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          approvalId: input.approvalId ?? null,
          recurringTemplateId: input.recurringTemplateId ?? null,
          goalId: input.goalId ?? null,
          cycleId: input.cycleId ?? null,
          costCents: input.costCents ?? 25,
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
      const auditHash = computeAuditHash(prevHash, auditId, "agent", "task.create", id, input.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "agent",
          action: "task.create",
          objectType: "task",
          objectId: id,
          summary: input.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return task;
    });

    return mapTask(row);
  },

  async listRecurringTasks(companyId?: string): Promise<RecurringTaskTemplate[]> {
    const where = companyId ? { companyId } : {};
    const rows = await db.recurringTaskTemplate.findMany({ where });
    return rows.map(mapRecurringTask);
  },

  async getRecurringTask(id: string): Promise<RecurringTaskTemplate | undefined> {
    const row = await db.recurringTaskTemplate.findUnique({ where: { id } });
    return row ? mapRecurringTask(row) : undefined;
  },

  async createRecurringTask(
    input: Omit<RecurringTaskTemplate, "id" | "createdAt">
  ): Promise<RecurringTaskTemplate> {
    const id = makeId("recurring");
    const timestamp = new Date();

    const row = await db.$transaction(async (tx) => {
      const template = await tx.recurringTaskTemplate.create({
        data: {
          id,
          companyId: input.companyId,
          title: input.title,
          prompt: input.prompt,
          agentRole: input.agentRole,
          priority: input.priority,
          tags: input.tags,
          cadence: input.cadence,
          enabled: input.enabled,
          nextRunAt: new Date(input.nextRunAt),
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
      const auditHash = computeAuditHash(prevHash, auditId, "user", "recurring.create", id, input.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: input.companyId,
          actor: "user",
          action: "recurring.create",
          objectType: "recurring_task",
          objectId: id,
          summary: input.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return template;
    });

    return mapRecurringTask(row);
  },

  async updateRecurringTask(
    id: string,
    patch: Partial<RecurringTaskTemplate>
  ): Promise<RecurringTaskTemplate | undefined> {
    const existing = await db.recurringTaskTemplate.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.prompt !== undefined) data.prompt = patch.prompt;
    if (patch.agentRole !== undefined) data.agentRole = patch.agentRole;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.cadence !== undefined) data.cadence = patch.cadence;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.lastMaterializedAt !== undefined) data.lastMaterializedAt = patch.lastMaterializedAt ? new Date(patch.lastMaterializedAt) : null;
    if (patch.nextRunAt !== undefined) data.nextRunAt = new Date(patch.nextRunAt);

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.recurringTaskTemplate.update({
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
      const auditHash = computeAuditHash(prevHash, auditId, "system", "recurring.update", id, updated.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "system",
          action: "recurring.update",
          objectType: "recurring_task",
          objectId: id,
          summary: updated.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapRecurringTask(row);
  },

  async deleteRecurringTask(id: string): Promise<void> {
    const existing = await db.recurringTaskTemplate.findUnique({ where: { id } });
    if (!existing) return;

    await db.$transaction(async (tx) => {
      await tx.recurringTaskTemplate.delete({ where: { id } });

      const auditId = makeId("audit");
      const auditCreatedAt = nowIso();
      const lastAuditRow = await tx.auditLog.findFirst({
        where: { companyId: existing.companyId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = lastAuditRow?.hash ?? "genesis";
      const auditHash = computeAuditHash(prevHash, auditId, "user", "recurring.delete", id, existing.title, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "user",
          action: "recurring.delete",
          objectType: "recurring_task",
          objectId: id,
          summary: existing.title,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });
    });
  },

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | undefined> {
    const existing = await db.task.findUnique({ where: { id } });
    if (!existing) return undefined;

    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.prompt !== undefined) data.prompt = patch.prompt;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.agentRole !== undefined) data.agentRole = patch.agentRole;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.dueDate !== undefined) data.dueDate = patch.dueDate ? new Date(patch.dueDate) : null;
    if (patch.approvalId !== undefined) data.approvalId = patch.approvalId ?? null;
    if (patch.recurringTemplateId !== undefined) data.recurringTemplateId = patch.recurringTemplateId ?? null;
    if (patch.goalId !== undefined) data.goalId = patch.goalId ?? null;
    if (patch.cycleId !== undefined) data.cycleId = patch.cycleId ?? null;
    if (patch.costCents !== undefined) data.costCents = patch.costCents;

    const row = await db.$transaction(async (tx) => {
      const updated = await tx.task.update({
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
      const summary = `Task is now ${updated.status}`;
      const auditHash = computeAuditHash(prevHash, auditId, "user", "task.update", id, summary, auditCreatedAt);
      await tx.auditLog.create({
        data: {
          id: auditId,
          companyId: existing.companyId,
          actor: "user",
          action: "task.update",
          objectType: "task",
          objectId: id,
          summary,
          hash: auditHash,
          prevHash,
          createdAt: new Date(auditCreatedAt),
        }
      });

      return updated;
    });

    return mapTask(row);
  },

  async listCycles(companyId: string): Promise<Cycle[]> {
    const rows = await db.cycle.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" }
    });
    return rows.map(mapCycle);
  },

  async saveCycle(cycle: Cycle): Promise<Cycle> {
    const row = await db.cycle.create({
      data: {
        id: cycle.id,
        companyId: cycle.companyId,
        trigger: cycle.trigger,
        kind: cycle.kind ?? "scheduled",
        status: cycle.status,
        phases: cycle.phases,
        summary: cycle.summary,
        goalId: cycle.goalId ?? null,
        startedAt: new Date(cycle.startedAt),
        completedAt: cycle.completedAt ? new Date(cycle.completedAt) : null
      }
    });
    return mapCycle(row);
  },

  async updateCycle(id: string, patch: Partial<Cycle>): Promise<void> {
    const data: Record<string, unknown> = {};
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.phases !== undefined) data.phases = patch.phases;
    if (patch.summary !== undefined) data.summary = patch.summary;
    if (patch.degraded !== undefined) data.degraded = patch.degraded;
    if (patch.goalId !== undefined) data.goalId = patch.goalId ?? null;
    if (patch.completedAt !== undefined) data.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;

    await db.cycle.update({
      where: { id },
      data
    });
  },

  async saveExecution(execution: AgentExecution): Promise<AgentExecution> {
    const row = await db.agentExecution.create({
      data: {
        id: execution.id,
        companyId: execution.companyId,
        cycleId: execution.cycleId ?? null,
        taskId: execution.taskId ?? null,
        agentRole: execution.agentRole,
        input: execution.input,
        output: execution.output,
        toolCalls: execution.toolCalls,
        status: execution.status,
        model: execution.model,
        tokens: execution.tokens,
        costCents: execution.costCents,
        durationMs: execution.durationMs,
        createdAt: new Date(execution.createdAt)
      }
    });
    return mapExecution(row);
  },

  async listExecutions(companyId: string): Promise<AgentExecution[]> {
    const rows = await db.agentExecution.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapExecution);
  },
};
