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

  /**
   * The self-improvement loop's six tables, on the same connection. See `ImproveStorePort`.
   * Optional so a narrow test double of this port is not forced to carry the loop.
   */
  improve?(): ImproveStorePort;

  /** Releases the underlying connection. After this the store must not be used again. */
  close(): Promise<void>;
}

// ─── Self-improvement loop tables ──────────────────────────────────────────────
// Six tables the improve loop (`../improve/`) reads and writes. Traces are keyed by
// (companyId, agentId, taskType); the GEPA frontier and the ledger are per AGENT, not per role,
// because a plugged specialist and the seat it sits in learn separately.

export type ImproveDraftStatus = "quarantine" | "live" | "rejected" | "stale" | "archived";
export type ImproveArtifactKind = "skill" | "prompt";
export type ImproveLedgerAction = "stage" | "promote" | "fix" | "reject" | "retire" | "archive" | "recover" | "rollback";

export interface AgentTraceRow {
  id: string;
  companyId: string;
  /** The seat role (one of the nine) the step ran under. */
  agentRole: string;
  /** The seat role, or the installed specialist plugged into it. The learning key. */
  agentId: string;
  runId: string;
  taskType: string;
  stepTitle: string;
  status: string;
  toolCalls: string[];
  toolCallCount: number;
  critiqueVerdict: string | null;
  improvement: string | null;
  evalScore: number | null;
  costCents: number;
  latencyMs: number | null;
  humanCorrected: boolean;
  skillApplied: boolean;
  createdAt: string;
}

export interface TraceFilter {
  agentId?: string;
  taskType?: string;
}

export interface SkillDraftRow {
  id: string;
  companyId: string;
  agentId: string;
  taskType: string;
  kind: ImproveArtifactKind;
  status: ImproveDraftStatus;
  content: string;
  contentHash: string;
  triggers: string[];
  createdAt: string;
  promotedAt: string | null;
  lastUsedAt: string | null;
  retiredAt: string | null;
}

export interface DraftFilter {
  agentId?: string;
  taskType?: string;
  kind?: ImproveArtifactKind;
  status?: ImproveDraftStatus;
}

export interface DraftPatch {
  status?: ImproveDraftStatus;
  content?: string;
  contentHash?: string;
  promotedAt?: string | null;
  lastUsedAt?: string | null;
  retiredAt?: string | null;
}

export interface IterationRow {
  id: string;
  companyId: string;
  agentId: string;
  taskType: string;
  candidateId: string | null;
  candidateKind: ImproveArtifactKind | null;
  score: number | null;
  delta: number | null;
  decision: string;
  triggers: string[];
  blockedBy: string | null;
  /** Hash of the trace ids this iteration consumed; a repeat sweep over the same set is a no-op. */
  inputHash: string | null;
  /** Every grader verdict the executing gate produced, for audit. */
  verdicts: JsonValue;
  createdAt: string;
}

export interface IterationFilter {
  agentId?: string;
  taskType?: string;
  limit?: number;
}

export interface GepaFrontierRow {
  companyId: string;
  agentId: string;
  frontier: JsonObject;
  updatedAt: string;
}

export interface SkillLedgerRow {
  id: string;
  companyId: string;
  agentId: string;
  taskType: string;
  action: ImproveLedgerAction;
  artifactKind: ImproveArtifactKind;
  artifactId: string;
  beforeHash: string | null;
  afterHash: string | null;
  /** Full prior bytes, so rollback is byte-for-byte and needs no other source. */
  before: string | null;
  after: string | null;
  iterationId: string | null;
  actor: string;
  /**
   * On a human promote/fix/reject: whether the gate's verdict agreed with the human. Null when
   * the artifact was never gated, or the action is not a human decision (improve/ledger.ts).
   */
  judgeAgreement?: boolean | null;
  createdAt: string;
}

export interface LedgerFilter {
  agentId?: string;
  iterationId?: string;
  artifactId?: string;
}

/**
 * Content-addressed gate results (`../improve/gate-cache.ts`): a measured baseline keyed by
 * (suite, version, sha256(prompt)) and a judge verdict keyed by (fixture, rubric, sha256(output)).
 * A key is only ever written with the value the model actually produced, so a hit is a call saved.
 */
export interface GateCacheRow {
  companyId: string;
  key: string;
  value: JsonValue;
  createdAt: string;
}

export interface ImproveStorePort {
  appendTrace(row: AgentTraceRow): Promise<void>;
  listTraces(companyId: string, filter?: TraceFilter): Promise<AgentTraceRow[]>;
  tracesByRun(runId: string): Promise<AgentTraceRow[]>;
  countTracesByAgent(companyId: string): Promise<Record<string, number>>;

  createDraft(row: SkillDraftRow): Promise<void>;
  getDraft(id: string): Promise<SkillDraftRow | null>;
  updateDraft(id: string, patch: DraftPatch): Promise<SkillDraftRow>;
  listDrafts(companyId: string, filter?: DraftFilter): Promise<SkillDraftRow[]>;

  appendIteration(row: IterationRow): Promise<void>;
  getIteration(id: string): Promise<IterationRow | null>;
  listIterations(companyId: string, filter?: IterationFilter): Promise<IterationRow[]>;

  getFrontier(companyId: string, agentId: string): Promise<GepaFrontierRow | null>;
  putFrontier(row: GepaFrontierRow): Promise<void>;

  appendLedger(row: SkillLedgerRow): Promise<void>;
  listLedger(companyId: string, filter?: LedgerFilter): Promise<SkillLedgerRow[]>;

  getGateCache(companyId: string, key: string): Promise<GateCacheRow | null>;
  /** Upsert: the same (companyId, key) written twice keeps the later value. */
  putGateCache(row: GateCacheRow): Promise<void>;
}
