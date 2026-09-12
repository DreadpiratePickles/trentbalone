/**
 * StorePort backed by Prisma on SQLite.
 *
 * Deliberately dumb: it maps port shapes onto the generated client and nothing else. All
 * durability, cascade and transaction behaviour comes from the schema and the driver
 * adapter, not from logic here.
 */

import type { PrismaClient } from "./generated/client";
import type {
  AppendEventInput,
  ApprovalRecord,
  CompanyRecord,
  CreateApprovalInput,
  CreateCompanyInput,
  CreateJobRunInput,
  CreateRunInput,
  EventRecord,
  JobRunRecord,
  JobRunStatus,
  JsonObject,
  RunRecord,
  StepRecord,
  StorePort,
  UpdateRunInput,
  UpsertStepInput,
  ApprovalStatus,
} from "./StorePort.js";

const COMPANY_FIELDS = { id: true, name: true, slug: true, budgetCents: true } as const;

const RUN_FIELDS = {
  id: true,
  companyId: true,
  objective: true,
  trigger: true,
  status: true,
  budgetCents: true,
  costCents: true,
  replanCount: true,
  summary: true,
  startedAt: true,
  completedAt: true,
} as const;

const STEP_FIELDS = {
  id: true,
  runId: true,
  companyId: true,
  seq: true,
  title: true,
  agentRole: true,
  status: true,
  needsApproval: true,
  output: true,
  costCents: true,
  approvalId: true,
} as const;

const EVENT_FIELDS = {
  id: true,
  runId: true,
  companyId: true,
  seq: true,
  kind: true,
  stepId: true,
  payload: true,
  createdAt: true,
} as const;

const APPROVAL_FIELDS = {
  id: true,
  companyId: true,
  action: true,
  reason: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
  expiresAt: true,
} as const;

const JOB_RUN_FIELDS = {
  id: true,
  type: true,
  status: true,
  companyId: true,
  trigger: true,
  summary: true,
  resultCount: true,
  error: true,
  startedAt: true,
  completedAt: true,
} as const;

function asJsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export class PrismaStore implements StorePort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly onClose?: () => Promise<void>,
  ) {}

  async createCompany(input: CreateCompanyInput): Promise<CompanyRecord> {
    return this.prisma.company.create({
      data: {
        ...(input.id === undefined ? {} : { id: input.id }),
        name: input.name,
        slug: input.slug,
        budgetCents: input.budgetCents ?? 0,
        brief: input.brief ?? {},
        metrics: input.metrics ?? {},
      },
      select: COMPANY_FIELDS,
    });
  }

  async getCompany(id: string): Promise<CompanyRecord | null> {
    return this.prisma.company.findUnique({ where: { id }, select: COMPANY_FIELDS });
  }

  async deleteCompany(id: string): Promise<void> {
    await this.prisma.company.delete({ where: { id } });
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    return this.prisma.orchestratorRun.create({
      data: {
        id: input.id,
        companyId: input.companyId,
        objective: input.objective,
        trigger: input.trigger,
        status: input.status,
        modelPolicy: input.modelPolicy,
        budgetCents: input.budgetCents ?? 0,
      },
      select: RUN_FIELDS,
    });
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return this.prisma.orchestratorRun.findUnique({ where: { id }, select: RUN_FIELDS });
  }

  async updateRun(id: string, patch: UpdateRunInput): Promise<RunRecord> {
    return this.prisma.orchestratorRun.update({
      where: { id },
      data: patch,
      select: RUN_FIELDS,
    });
  }

  async upsertStep(input: UpsertStepInput): Promise<StepRecord> {
    const writable = {
      runId: input.runId,
      companyId: input.companyId,
      seq: input.seq,
      title: input.title,
      rationale: input.rationale,
      agentRole: input.agentRole,
      dependsOn: input.dependsOn,
      expectedOutput: input.expectedOutput,
      riskLevel: input.riskLevel,
      status: input.status,
      needsApproval: input.needsApproval ?? false,
      output: input.output ?? null,
      model: input.model ?? null,
      tokens: input.tokens ?? null,
      costCents: input.costCents ?? null,
      approvalId: input.approvalId ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
    };
    return this.prisma.orchestratorStep.upsert({
      where: { id: input.id },
      create: { id: input.id, ...writable },
      update: writable,
      select: STEP_FIELDS,
    });
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return this.prisma.orchestratorStep.findMany({
      where: { runId },
      orderBy: { seq: "asc" },
      select: STEP_FIELDS,
    });
  }

  async appendEvent(input: AppendEventInput): Promise<EventRecord> {
    const row = await this.prisma.orchestratorEvent.create({
      data: {
        runId: input.runId,
        companyId: input.companyId,
        seq: input.seq,
        kind: input.kind,
        stepId: input.stepId ?? null,
        payload: input.payload,
      },
      select: EVENT_FIELDS,
    });
    return { ...row, payload: asJsonObject(row.payload) };
  }

  async listEvents(runId: string, afterSeq?: number): Promise<EventRecord[]> {
    const rows = await this.prisma.orchestratorEvent.findMany({
      where: { runId, ...(afterSeq === undefined ? {} : { seq: { gt: afterSeq } }) },
      orderBy: { seq: "asc" },
      select: EVENT_FIELDS,
    });
    return rows.map((row) => ({ ...row, payload: asJsonObject(row.payload) }));
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const row = await this.prisma.approval.create({
      data: {
        ...(input.id === undefined ? {} : { id: input.id }),
        companyId: input.companyId,
        action: input.action,
        reason: input.reason,
        toolName: input.toolName ?? null,
        previewContent: input.previewContent ?? null,
        expiresAt: input.expiresAt ?? null,
      },
      select: APPROVAL_FIELDS,
    });
    return { ...row, status: row.status as ApprovalStatus };
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const row = await this.prisma.approval.findUnique({ where: { id }, select: APPROVAL_FIELDS });
    return row === null ? null : { ...row, status: row.status as ApprovalStatus };
  }

  async resolveApproval(id: string, status: "approved" | "rejected"): Promise<ApprovalRecord> {
    const row = await this.prisma.approval.update({
      where: { id },
      data: { status, resolvedAt: new Date() },
      select: APPROVAL_FIELDS,
    });
    return { ...row, status: row.status as ApprovalStatus };
  }

  async createJobRun(input: CreateJobRunInput): Promise<JobRunRecord> {
    const row = await this.prisma.jobRun.create({
      data: {
        ...(input.id === undefined ? {} : { id: input.id }),
        type: input.type,
        trigger: input.trigger,
        companyId: input.companyId ?? null,
        summary: input.summary ?? "",
        status: input.status ?? "running",
        metadata: input.metadata ?? {},
      },
      select: JOB_RUN_FIELDS,
    });
    return { ...row, status: row.status as JobRunStatus };
  }

  async listJobRuns(companyId: string | null, limit = 50): Promise<JobRunRecord[]> {
    const rows = await this.prisma.jobRun.findMany({
      where: { companyId },
      orderBy: { startedAt: "desc" },
      take: limit,
      select: JOB_RUN_FIELDS,
    });
    return rows.map((row) => ({ ...row, status: row.status as JobRunStatus }));
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
    if (this.onClose !== undefined) {
      await this.onClose();
    }
  }
}
