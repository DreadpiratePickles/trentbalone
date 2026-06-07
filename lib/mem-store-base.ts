import type {
  Agent,
  AgentEntitlement,
  AgentExecution,
  AgentRole,
  AgentSlotAssignment,
  Approval,
  Company,
  CompanyInput,
  Cycle,
  RecurringTaskTemplate,
  Task,
} from "@/lib/types";
import { createDefaultAgents } from "@/lib/agents";
import { buildSlotEnvironment, getCatalogAgent } from "@/lib/agent-catalog";
import {
  buildCompanyInput,
  buildDefaultRecurringTasks,
  nextCycleAtForFrequency
} from "@/lib/store-helpers";
import { makeId, nowIso, slugify } from "@/lib/utils";
import { state, addAuditLog } from "./mem-store-state";

export const memStoreBase = {
  async listCompanies(): Promise<Company[]> {
    return state().companies.filter((company) => company.status !== "archived");
  },

  async getCompany(id: string): Promise<Company | undefined> {
    return state().companies.find((company) => company.id === id || company.slug === id);
  },

  async getMemberRole(userId: string, companyId: string): Promise<string | null> {
    const company = state().companies.find((c) => c.id === companyId || c.slug === companyId);
    if (!company) return null;
    return "owner";
  },

  async createCompany(input: CompanyInput): Promise<Company> {
    const id = makeId("company");
    const timestamp = nowIso();
    const baseSlug = slugify(input.name) || id;
    const slug = state().companies.some((company) => company.slug === baseSlug) ? `${baseSlug}-${id.slice(-8)}` : baseSlug;
    const { brief, metrics } = buildCompanyInput(input);
    const company: Company = {
      id,
      name: input.name,
      slug,
      website: input.website,
      status: "active",
      autonomyLevel: input.autonomyLevel ?? "autonomous_with_approvals",
      publicVisibility: input.publicVisibility ?? true,
      publicSubdomain: `${slug}.trent.local`,
      timezone: input.timezone ?? "America/Toronto",
      budgetCents: input.budgetCents ?? 10000,
      cycleFrequency: input.cycleFrequency ?? "daily",
      nextCycleAt: nextCycleAtForFrequency(input.cycleFrequency ?? "daily", timestamp),
      createdAt: timestamp,
      updatedAt: timestamp,
      brief,
      metrics
    };
    state().companies.push(company);
    state().agents.push(...createDefaultAgents(id));
    state().documents.push({
      id: makeId("doc"),
      companyId: id,
      type: "brief",
      title: "Company Operating Brief",
      content: Object.entries(brief)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n\n"),
      source: "onboarding",
      version: 1,
      createdAt: timestamp
    });
    state().recurringTasks.push(...buildDefaultRecurringTasks(id, timestamp));
    addAuditLog(id, "user", "company.create", "company", id, `Created ${input.name}`);
    return company;
  },

  async updateCompany(id: string, patch: Partial<Company>): Promise<Company | undefined> {
    const company = state().companies.find((item) => item.id === id || item.slug === id);
    if (!company) return undefined;
    Object.assign(company, patch, { updatedAt: nowIso() });
    addAuditLog(company.id, "user", "company.update", "company", company.id, "Updated company settings");
    return company;
  },

  async listAgents(companyId: string): Promise<Agent[]> {
    return state().agents.filter((agent) => agent.companyId === companyId);
  },

  async getAgent(agentId: string): Promise<Agent | undefined> {
    return state().agents.find((agent) => agent.id === agentId);
  },

  async updateAgent(agentId: string, patch: Partial<Agent>): Promise<Agent | undefined> {
    const agent = state().agents.find((item) => item.id === agentId);
    if (!agent) return undefined;
    Object.assign(agent, patch);
    addAuditLog(agent.companyId, "user", "agent.update", "agent", agent.id, `Updated ${agent.name}`);
    return agent;
  },

  async listAgentPlugAssignments(companyId: string): Promise<AgentSlotAssignment[]> {
    return state().agentPlugAssignments.filter((assignment) => assignment.companyId === companyId);
  },

  async getAgentPlugAssignment(
    companyId: string,
    role: AgentRole
  ): Promise<AgentSlotAssignment | undefined> {
    return state().agentPlugAssignments.find(
      (assignment) => assignment.companyId === companyId && assignment.role === role
    );
  },

  async upsertAgentPlugAssignment(input: {
    companyId: string;
    role: AgentRole;
    profileId: string;
    environment?: Partial<AgentSlotAssignment["environment"]>;
  }): Promise<AgentSlotAssignment> {
    const existing = state().agentPlugAssignments.find(
      (assignment) => assignment.companyId === input.companyId && assignment.role === input.role
    );
    const timestamp = nowIso();
    const catalogAgent = getCatalogAgent(input.profileId);
    const environment = {
      ...buildSlotEnvironment(input.companyId, input.role),
      ...(catalogAgent?.skills ? { skills: [...catalogAgent.skills] } : {}),
      ...(input.environment ?? {})
    };

    if (existing) {
      Object.assign(existing, {
        profileId: input.profileId,
        environment,
        updatedAt: timestamp
      });
      addAuditLog(
        input.companyId,
        "user",
        "agent_plug.update",
        "agent_slot_assignment",
        existing.id,
        `Updated ${input.role} slot to ${input.profileId}`
      );
      return existing;
    }

    const assignment: AgentSlotAssignment = {
      id: makeId("plug"),
      companyId: input.companyId,
      role: input.role,
      profileId: input.profileId,
      profileSource: "agency-agents",
      environment,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state().agentPlugAssignments.push(assignment);
    addAuditLog(
      input.companyId,
      "user",
      "agent_plug.create",
      "agent_slot_assignment",
      assignment.id,
      `Assigned ${input.profileId} to ${input.role} slot`
    );
    return assignment;
  },

  async clearAgentPlugAssignment(companyId: string, role: AgentRole): Promise<void> {
    const before = state().agentPlugAssignments.length;
    state().agentPlugAssignments = state().agentPlugAssignments.filter(
      (assignment) => !(assignment.companyId === companyId && assignment.role === role)
    );
    if (state().agentPlugAssignments.length !== before) {
      addAuditLog(
        companyId,
        "user",
        "agent_plug.clear",
        "agent_slot_assignment",
        `${companyId}:${role}`,
        `Cleared ${role} slot plug assignment`
      );
    }
  },

  async listAgentEntitlements(companyId: string): Promise<AgentEntitlement[]> {
    return state().agentEntitlements.filter((entitlement) => entitlement.companyId === companyId);
  },

  async grantAgentEntitlement(
    input: Omit<AgentEntitlement, "id" | "createdAt">
  ): Promise<AgentEntitlement> {
    const existing = state().agentEntitlements.find(
      (entitlement) =>
        entitlement.companyId === input.companyId &&
        entitlement.productId === input.productId &&
        entitlement.profileId === input.profileId &&
        entitlement.status === "active"
    );
    if (existing) return existing;

    const entitlement: AgentEntitlement = {
      ...input,
      id: makeId("entitlement"),
      createdAt: nowIso()
    };
    state().agentEntitlements.push(entitlement);
    addAuditLog(
      entitlement.companyId,
      "user",
      "agent_marketplace.entitlement_grant",
      "agent_entitlement",
      entitlement.id,
      `Granted ${entitlement.productId}`
    );
    return entitlement;
  },

  async revokeAgentEntitlement(
    companyId: string,
    productId: string
  ): Promise<AgentEntitlement[]> {
    const revokedAt = nowIso();
    const revoked: AgentEntitlement[] = [];

    for (const entitlement of state().agentEntitlements) {
      if (
        entitlement.companyId === companyId &&
        entitlement.productId === productId &&
        entitlement.status === "active"
      ) {
        entitlement.status = "revoked";
        entitlement.expiresAt = revokedAt;
        revoked.push(entitlement);
      }
    }

    for (const entitlement of revoked) {
      addAuditLog(
        companyId,
        "user",
        "agent_marketplace.entitlement_revoke",
        "agent_entitlement",
        entitlement.id,
        `Revoked ${entitlement.productId}`
      );
    }

    return revoked;
  },

  async listTasks(companyId?: string): Promise<Task[]> {
    return state().tasks.filter((task) => !companyId || task.companyId === companyId);
  },

  async getTask(id: string): Promise<Task | undefined> {
    return state().tasks.find((task) => task.id === id);
  },

  async createTask(
    input: Omit<Task, "id" | "createdAt" | "updatedAt" | "costCents"> & { costCents?: number }
  ): Promise<Task> {
    const timestamp = nowIso();
    const task: Task = {
      ...input,
      id: makeId("task"),
      costCents: input.costCents ?? 25,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state().tasks.push(task);
    addAuditLog(task.companyId, "agent", "task.create", "task", task.id, task.title);
    return task;
  },

  async listRecurringTasks(companyId?: string): Promise<RecurringTaskTemplate[]> {
    return state().recurringTasks.filter((template) => !companyId || template.companyId === companyId);
  },

  async getRecurringTask(id: string): Promise<RecurringTaskTemplate | undefined> {
    return state().recurringTasks.find((t) => t.id === id);
  },

  async createRecurringTask(
    input: Omit<RecurringTaskTemplate, "id" | "createdAt">
  ): Promise<RecurringTaskTemplate> {
    const template = { ...input, id: makeId("recurring"), createdAt: nowIso() };
    state().recurringTasks.push(template);
    addAuditLog(template.companyId, "user", "recurring.create", "recurring_task", template.id, template.title);
    return template;
  },

  async updateRecurringTask(
    id: string,
    patch: Partial<RecurringTaskTemplate>
  ): Promise<RecurringTaskTemplate | undefined> {
    const template = state().recurringTasks.find((item) => item.id === id);
    if (!template) return undefined;
    Object.assign(template, patch);
    addAuditLog(
      template.companyId,
      "system",
      "recurring.update",
      "recurring_task",
      template.id,
      template.title
    );
    return template;
  },

  async deleteRecurringTask(id: string): Promise<void> {
    const idx = state().recurringTasks.findIndex((item) => item.id === id);
    if (idx === -1) return;
    const [removed] = state().recurringTasks.splice(idx, 1);
    addAuditLog(removed.companyId, "user", "recurring.delete", "recurring_task", id, removed.title);
  },

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | undefined> {
    const task = state().tasks.find((item) => item.id === id);
    if (!task) return undefined;
    Object.assign(task, patch, { updatedAt: nowIso() });
    addAuditLog(task.companyId, "user", "task.update", "task", task.id, `Task is now ${task.status}`);
    return task;
  },

  async listCycles(companyId: string): Promise<Cycle[]> {
    return state()
      .cycles.filter((cycle) => cycle.companyId === companyId)
      .slice()
      .reverse();
  },

  async saveCycle(cycle: Cycle): Promise<Cycle> {
    const saved = { ...cycle, kind: cycle.kind ?? "scheduled" };
    state().cycles.push(saved);
    return saved;
  },

  async updateCycle(id: string, patch: Partial<Cycle>): Promise<void> {
    const cycle = state().cycles.find((item) => item.id === id);
    if (cycle) Object.assign(cycle, patch);
  },

  async saveExecution(execution: AgentExecution): Promise<AgentExecution> {
    state().executions.push(execution);
    return execution;
  },

  async listExecutions(companyId: string): Promise<AgentExecution[]> {
    return state()
      .executions.filter((execution) => execution.companyId === companyId)
      .slice()
      .reverse();
  },

  async listApprovals(companyId?: string): Promise<Approval[]> {
    return state()
      .approvals.filter((approval) => !companyId || approval.companyId === companyId)
      .slice()
      .reverse();
  },

  async getApproval(id: string): Promise<Approval | undefined> {
    return state().approvals.find((approval) => approval.id === id);
  },

  async createApproval(input: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval> {
    const createdAt = nowIso();
    const expiresAt = input.expiresAt ?? new Date(new Date(createdAt).getTime() + 48 * 60 * 60 * 1000).toISOString();
    const approval: Approval = {
      ...input,
      id: makeId("approval"),
      status: "pending",
      createdAt,
      expiresAt,
    };
    state().approvals.push(approval);
    addAuditLog(approval.companyId, "agent", "approval.request", "approval", approval.id, approval.action);
    return approval;
  },

  async resolveApproval(id: string, status: "approved" | "rejected"): Promise<Approval | undefined> {
    const approval = state().approvals.find((item) => item.id === id);
    if (!approval) return undefined;
    approval.status = status;
    approval.resolvedAt = nowIso();
    addAuditLog(
      approval.companyId,
      "user",
      `approval.${status}`,
      "approval",
      approval.id,
      approval.action
    );
    return approval;
  },
};
