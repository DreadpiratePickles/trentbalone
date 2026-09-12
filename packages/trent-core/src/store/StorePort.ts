/**
 * The durable-state surface the standalone CLI needs, and nothing more.
 *
 * `--continue` must resume a REAL run, not replay a transcript, so orchestration state has
 * to outlive the process. This port covers exactly the five entities that carry that state
 * — company, run, step, event, approval — plus job runs for the drain loop. The database
 * behind it has 64 tables; deliberately, only these are exposed. Widen it when a surface
 * actually needs more, never speculatively.
 *
 * Money is integer cents everywhere. No float ever touches a cents field.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RunStatus = string;
export type StepStatus = string;
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type JobRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface CompanyRecord {
  id: string;
  name: string;
  slug: string;
  budgetCents: number;
}

export interface CreateCompanyInput {
  id?: string;
  name: string;
  slug: string;
  budgetCents?: number;
  brief?: JsonObject;
  metrics?: JsonObject;
}

export interface RunRecord {
  id: string;
  companyId: string;
  objective: string;
  trigger: string;
  status: RunStatus;
  budgetCents: number;
  costCents: number;
  replanCount: number;
  summary: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface CreateRunInput {
  id: string;
  companyId: string;
  objective: string;
  trigger: string;
  status: RunStatus;
  modelPolicy: JsonObject;
  budgetCents?: number;
}

export interface UpdateRunInput {
  status?: RunStatus;
  costCents?: number;
  replanCount?: number;
  summary?: string | null;
  completedAt?: Date | null;
}

export interface StepRecord {
  id: string;
  runId: string;
  companyId: string;
  seq: number;
  title: string;
  agentRole: string;
  status: StepStatus;
  needsApproval: boolean;
  output: string | null;
  costCents: number | null;
  approvalId: string | null;
}

export interface UpsertStepInput {
  id: string;
  runId: string;
  companyId: string;
  seq: number;
  title: string;
  rationale: string;
  agentRole: string;
  dependsOn: string[];
  expectedOutput: string;
  riskLevel: string;
  status: StepStatus;
  needsApproval?: boolean;
  output?: string | null;
  model?: string | null;
  tokens?: number | null;
  costCents?: number | null;
  approvalId?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface EventRecord {
  id: string;
  runId: string;
  companyId: string;
  seq: number;
  kind: string;
  stepId: string | null;
  payload: JsonObject;
  createdAt: Date;
}

export interface AppendEventInput {
  runId: string;
  companyId: string;
  seq: number;
  kind: string;
  stepId?: string | null;
  payload: JsonObject;
}

export interface ApprovalRecord {
  id: string;
  companyId: string;
  action: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  expiresAt: Date | null;
}

export interface CreateApprovalInput {
  id?: string;
  companyId: string;
  action: string;
  reason: string;
  toolName?: string | null;
  previewContent?: string | null;
  expiresAt?: Date | null;
}

export interface JobRunRecord {
  id: string;
  type: string;
  status: JobRunStatus;
  companyId: string | null;
  trigger: string;
  summary: string;
  resultCount: number;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface CreateJobRunInput {
  id?: string;
  type: string;
  trigger: string;
  companyId?: string | null;
  summary?: string;
  status?: JobRunStatus;
  metadata?: JsonObject;
}

export interface StorePort {
  createCompany(input: CreateCompanyInput): Promise<CompanyRecord>;
  getCompany(id: string): Promise<CompanyRecord | null>;
  /** Present for teardown and for `trent company remove`; children cascade in the schema. */
  deleteCompany(id: string): Promise<void>;

  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  updateRun(id: string, patch: UpdateRunInput): Promise<RunRecord>;

  upsertStep(input: UpsertStepInput): Promise<StepRecord>;
  listSteps(runId: string): Promise<StepRecord[]>;

  appendEvent(input: AppendEventInput): Promise<EventRecord>;
  listEvents(runId: string, afterSeq?: number): Promise<EventRecord[]>;

  createApproval(input: CreateApprovalInput): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  resolveApproval(id: string, status: "approved" | "rejected"): Promise<ApprovalRecord>;

  createJobRun(input: CreateJobRunInput): Promise<JobRunRecord>;
  listJobRuns(companyId: string | null, limit?: number): Promise<JobRunRecord[]>;

  /** Releases the underlying connection. After this the store must not be used again. */
  close(): Promise<void>;
}
