import { WorkbenchSession, WorkbenchEvent, WorkbenchArtifact, WorkbenchChatMessage, WorkbenchAttempt, WorkbenchCheckpoint } from "./types-workbench";
import type { StripeCustomer, StripeSubscription, StripeWebhookEvent } from "./types-marketing";
import type {
  AdCampaign,
  AdCreativeVariant,
  AdSpendCharge,
  AudienceSegment,
  ConversionEvent,
  CreativePerformanceMemory,
  MarketingAccount,
  OptimizationRun,
} from "./marketing/types";
import type { AgentMissionRun, AgentMissionStep, AgentMissionEvent } from "./agent-mission-types";
export type {
  AgentMissionRun,
  AgentMissionStep,
  AgentMissionEvent,
  AgentMissionType,
  AgentMissionStatus,
  AgentMissionTrigger,
  AgentMissionStepStatus,
  AgentMissionEventKind,
} from "./agent-mission-types";
export type AutonomyLevel = "review_only" | "assisted" | "autonomous_with_approvals" | "autonomous_within_limits";
export type CompanyStatus = "active" | "paused" | "archived";
export type CycleFrequency = "manual" | "daily" | "weekly";
export type AgentRole =
  | "ceo"
  | "engineer"
  | "growth"
  | "content"
  | "support"
  | "analyst"
  | "finance"
  | "escalation"
  | "sales";
export type OrchestratorRunStatus = "planning" | "running" | "completed" | "failed" | "cancelled";
export type OrchestratorRunTrigger = "manual" | "scheduled" | "delegated" | "heartbeat";
export type OrchestratorEventKind =
  | "snapshot"
  | "run_start"
  | "plan_start"
  | "plan_end"
  | "step_pending"
  | "step_start"
  | "step_output"
  | "step_critic"
  | "step_note"
  | "step_end"
  | "step_blocked"
  | "step_awaiting_approval"
  | "step_approved"
  | "delegation_skipped"
  | "consolidate_start"
  | "consolidate_end"
  | "run_done"
  | "run_failed"
  | "run_cancelled"
  | "heartbeat";
export type OrchestratorRun = {
  id: string;
  companyId: string;
  objective: string;
  trigger: OrchestratorRunTrigger;
  status: OrchestratorRunStatus;
  modelPolicy: Record<string, unknown>;
  budgetCents: number;
  costCents: number;
  replanCount: number;
  summary?: string;
  cycleId?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
};
export type OrchestratorStep = {
  id: string;
  runId: string;
  companyId: string;
  seq: number;
  title: string;
  rationale: string;
  agentRole: AgentRole;
  dependsOn: string[];
  expectedOutput: string;
  riskLevel: "low" | "medium" | "high" | string;
  needsApproval: boolean;
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "awaiting_approval";
  output?: string;
  critique?: Record<string, unknown>;
  model?: string;
  tokens?: number;
  costCents?: number;
  toolCalls?: ToolCallRecord[];
  approvalId?: string;
  startedAt?: string;
  completedAt?: string;
};
export type OrchestratorEvent = {
  id: string;
  runId: string;
  companyId: string;
  seq: number;
  kind: OrchestratorEventKind | string;
  stepId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
export type ContentMissionRunStatus =
  | "planning"
  | "running"
  | "blocked"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type ContentMissionExternalActionStatus =
  | "DRAFT_ONLY"
  | "DRAFT_READY"
  | "BLOCKED"
  | "PARTIALLY_EXECUTED"
  | "EXECUTED";
export type ContentMissionActionStatus =
  | "draft_only"
  | "needs_approval"
  | "blocked"
  | "approved"
  | "executed"
  | "rejected";
export type ContentMissionRun = {
  id: string;
  companyId: string;
  runId: string;
  cycleId?: string;
  objective: string;
  operatingMode: string;
  status: ContentMissionRunStatus;
  ownerSeat: AgentRole;
  externalActionStatus: ContentMissionExternalActionStatus;
  requiredSocialPlatforms: string[];
  requiredMarketingPlatforms: string[];
  socialPublishingRequested: boolean;
  paidAdsRequested: boolean;
  approvalGates: string[];
  memoryLogFields: string[];
  creativeApps: string[];
  budgetCents: number;
  costCents: number;
  summary?: string;
  memoryLogArtifactId?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
};
export type ContentMissionAction = {
  id: string;
  runId: string;
  companyId: string;
  ledgerItemId: string;
  kind: string;
  owner: AgentRole;
  status: ContentMissionActionStatus;
  approvalGate: string;
  sourceStage: string;
  reason: string;
  relatedPlatforms: string[];
  approvalId?: string;
  createdAt: string;
  updatedAt: string;
};
export type TaskStatus = "draft" | "queued" | "running" | "waiting_approval" | "blocked" | "completed" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type IntegrationStatus = "mocked" | "connected" | "needs_credentials";
export type JobRunStatus = "running" | "completed" | "failed" | "cancelled";
export type JobRunType = "scheduled_cycle_sweep" | "company_scheduled_cycle" | "recurring_task_materialization" | "weekly_report" | "morning_briefing" | "workbench_session_sweep" | "run_subtask" | "orchestration_step" | "wiki_index_refresh" | "supervision_action" | "plug_install" | "platform_action" | "content_performance_ingest";
export type ArtifactType =
  | "board_pdf"
  | "xlsx_report"
  | "dashboard"
  | "investor_update"
  | "campaign_report"
  | "competitive_research"
  | "operating_memo"
  | "support_summary";
export type ArtifactStatus = "draft" | "ready" | "needs_approval" | "approved" | "sent" | "failed";
export type ArtifactExportFormat = "markdown" | "html" | "pdf" | "csv" | "xlsx" | "dashboard_json";
export * from "./types-workbench";
export * from "./types-marketing";
export type * from "./marketing/types";
export type * from "./social/types";
export type AgentSlotAssignment = {
  id: string;
  companyId: string;
  role: AgentRole;
  profileId: string;
  profileSource: "agency-agents";
  environment: AgentEnvironmentConfig;
  createdAt: string;
  updatedAt: string;
};
export type AgentEntitlement = {
  id: string;
  companyId: string;
  productId: string;
  profileId?: string;
  source: "free" | "mock_purchase" | "stripe" | "admin";
  status: "active" | "revoked" | "expired";
  createdAt: string;
  expiresAt?: string;
};

export type AgentEnvironmentConfig = {
  memoryNamespace: string;
  tools: string[];
  approvalRequiredFor: string[];
  budgetCentsPerRun: number;
  maxRuntimeSeconds: number;
  outputContract: string[];
  /** v3: skills granted to this installed instance. */
  skills?: string[];
};

export type Company = {
  id: string;
  name: string;
  slug: string;
  website?: string;
  status: CompanyStatus;
  autonomyLevel: AutonomyLevel;
  publicVisibility: boolean;
  publicSubdomain: string;
  timezone: string;
  budgetCents: number;
  /** Optional weekly $ spend cap covering LLM, infra, ads, and send credits (cents) */
  weeklyBudgetCents?: number;
  cycleFrequency: CycleFrequency;
  lastCycleAt?: string;
  nextCycleAt?: string;
  /** Hour (0-23 UTC) for nightly autonomous run; undefined = disabled */
  nightlyRunHour?: number;
  /**
   * Per-tool approval expiry overrides (hours).
   * Keys are tool adapter names (e.g. "Meta Ads", "Stripe").
   * Default (when absent): 48 h for most tools; adapter-specific default otherwise.
   */
  approvalExpiryOverrides?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  brief: CompanyBrief;
  metrics: CompanyMetrics;
};

export type CompanyBrief = {
  vision: string;
  icp: string;
  offer: string;
  pricing: string;
  competitors: string;
  brandVoice: string;
  goals: string;
  constraints: string;
  successMetrics: string;
  /** Control plane model-tier overrides keyed by Trent agent role. */
  modelTierByRole?: Partial<Record<AgentRole, string>>;
  /** Public page — editable narrative sections */
  publicShipped?: string;
  publicLearning?: string;
  publicFocus?: string;
};

export type CompanyMetrics = {
  users: number;
  signups: number;
  revenueCents: number;
  conversionRate: number;
  retentionRate: number;
};

/** How confident we are in autonomous execution for this agent */
export type AgentQualityLabel = "experimental" | "supervised" | "autonomous";
export type PlugReversibilityClass = "reversible" | "costly_to_reverse" | "irreversible";

export type Agent = {
  id: string;
  companyId: string;
  role: AgentRole;
  name: string;
  description: string;
  enabled: boolean;
  modelPolicy: string;
  permissions: string[];
  /** Quality label surfaces in console next to agent name */
  qualityLabel?: AgentQualityLabel;
  /** Daily token budget (0 = unlimited) */
  dailyTokenBudget?: number;
};

export type Task = {
  id: string;
  companyId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: "low" | "medium" | "high" | "urgent";
  agentRole: AgentRole;
  tags: string[];
  dueDate?: string;
  approvalId?: string;
  recurringTemplateId?: string;
  costCents: number;
  createdAt: string;
  updatedAt: string;
};

export type Cycle = {
  id: string;
  companyId: string;
  trigger: "manual" | "scheduled";
  kind: "scheduled" | "ad_hoc_dag";
  status: "running" | "completed" | "failed";
  phases: string[];
  summary: string;
  startedAt: string;
  completedAt?: string;
};

export type RecurringTaskTemplate = {
  id: string;
  companyId: string;
  title: string;
  prompt: string;
  agentRole: AgentRole;
  priority: "low" | "medium" | "high" | "urgent";
  tags: string[];
  cadence: "daily" | "weekly";
  enabled: boolean;
  lastMaterializedAt?: string;
  nextRunAt: string;
  createdAt: string;
};

export type AgentExecution = {
  id: string;
  companyId: string;
  cycleId?: string;
  taskId?: string;
  agentRole: AgentRole;
  input: string;
  output: string;
  toolCalls: ToolCallRecord[];
  status: "completed" | "failed";
  model: string;
  tokens: number;
  costCents: number;
  durationMs: number;
  createdAt: string;
};

export type ToolCallRecord = {
  adapter: string;
  action: string;
  status: "mocked" | "completed" | "needs_approval" | "failed" | "blocked";
  summary: string;
};

export type ApprovalPreviewKind = "email" | "post" | "diff" | "contract" | "generic";

export type Approval = {
  id: string;
  companyId: string;
  taskId?: string;
  action: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  /** ISO timestamp — defaults to createdAt + 48 h */
  expiresAt?: string;
  /** Tool that requested this approval — used for configurable expiry lookup */
  toolName?: string;
  /** If the approval expired unactioned, this references the re-planned task */
  replannedTaskId?: string;
  /** Draft content to preview inline — email body, social post, diff, contract clause */
  previewContent?: string;
  /** Hints the UI on which preview renderer to use */
  previewKind?: ApprovalPreviewKind;
};

export type CommentEntityType = "approval" | "task" | "artifact" | "cycle" | "report";

export type Comment = {
  id: string;
  companyId: string;
  entityType: CommentEntityType;
  entityId: string;
  authorName: string;
  agentRole?: string;
  content: string;
  createdAt: string;
};

export type DocumentMemoryTier = "working" | "episodic" | "semantic";

export type Document = {
  id: string;
  companyId: string;
  type:
    | "brief"
    | "roadmap"
    | "marketing_plan"
    | "research"
    | "support_summary"
    | "weekly_report"
    | "agent_note"
    | "feature_gap"
    | "email_draft";
  title: string;
  content: string;
  source: string;
  version: number;
  /** Memory tier this document was written into */
  memoryTier?: DocumentMemoryTier;
  /** ISO timestamp from which this fact is valid */
  validFrom?: string;
  /** ISO timestamp until which this fact is valid (null = current) */
  validTo?: string;
  /** ID of the older document this supersedes */
  supersedesId?: string;
  createdAt: string;
};

export type Report = {
  id: string;
  companyId: string;
  type: "cycle" | "weekly" | "growth" | "support" | "finance" | "morning_briefing";
  title: string;
  findings: string[];
  recommendations: string[];
  createdAt: string;
};

export type Artifact = {
  id: string;
  companyId: string;
  sourceTaskId?: string;
  sourceCycleId?: string;
  sourceDocumentId?: string;
  type: ArtifactType;
  status: ArtifactStatus;
  title: string;
  summary: string;
  content: string;
  exportFormat: ArtifactExportFormat;
  storageKey?: string;
  previewUrl?: string;
  createdByAgent: AgentRole;
  provenance: {
    prompt: string;
    sources: string[];
    model: string;
    tokens: number;
    costCents: number;
    generatedAt: string;
  };
  approvalStatus?: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
};

export type Invoice = {
  id: string;
  companyId: string;
  billingPeriod: string;
  amountCents: number;
  status: "unpaid" | "paid" | "void";
  createdAt: string;
  paidAt?: string;
  txHash?: string;
  lineItems: any;
};

export type LedgerEntry = {
  id: string;
  companyId: string;
  type: "debit" | "credit";
  account: "billing" | "payout" | "spend";
  amountCents: number;
  txHash: string;
  description: string;
  createdAt: string;
};

export type PayoutHold = {
  id: string;
  companyId: string;
  creatorWallet: string;
  amountCents: number;
  status: "held" | "released" | "extended" | "cancelled";
  releaseAt: string;
  reason: string;
  createdAt: string;
  releasedAt?: string;
};

export type UsageLedgerEntry = {
  id: string;
  companyId: string;
  category: "llm" | "browser" | "infra" | "ads" | "credits" | "media";
  description: string;
  amountCents: number;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
  invoiceId?: string;
};

export type ToolConnection = {
  id: string;
  companyId: string;
  provider: string;
  scopes: string[];
  status: IntegrationStatus;
  encryptedData?: string;
  lastCheckedAt: string;
};

export type AuditLog = {
  id: string;
  companyId: string;
  actor: "system" | "user" | "agent";
  action: string;
  objectType: string;
  objectId: string;
  summary: string;
  createdAt: string;
  /** SHA-256 of (prevHash + id + actor + action + objectId + summary + createdAt) */
  hash: string;
  /** "genesis" for first entry, prior entry's hash thereafter */
  prevHash: string;
};

export type MemorySearchResult = {
  id: string;
  kind: "document" | "report" | "execution" | "task";
  title: string;
  excerpt: string;
  createdAt: string;
  score: number;
};

export type JobRun = {
  id: string;
  type: JobRunType;
  status: JobRunStatus;
  companyId?: string;
  trigger: "user" | "cron" | "system";
  startedAt: string;
  completedAt?: string;
  summary: string;
  resultCount: number;
  error?: string;
  metadata: Record<string, unknown>;
};

export type CeoMessageDirection = "from_owner" | "from_ceo";
export type CeoMessageKind = "chat" | "briefing" | "autopilot_update";
export type CeoSuggestionStatus = "pending" | "done" | "dismissed";

export type CeoMessage = {
  id: string;
  companyId: string;
  direction: CeoMessageDirection;
  kind: CeoMessageKind;
  content: string;
  createdAt: string;
};

export type CeoSuggestion = {
  id: string;
  companyId: string;
  title: string;
  body: string;
  category: "outreach" | "content" | "product" | "operations" | "finance" | "other";
  status: CeoSuggestionStatus;
  createdAt: string;
};

export type CeoArtifactRequest = {
  title: string;
  prompt: string;
  type: ArtifactType;
  createdByAgent: AgentRole;
  exportFormat?: ArtifactExportFormat;
};

export type AppState = {
  companies: Company[];
  agents: Agent[];
  tasks: Task[];
  recurringTasks: RecurringTaskTemplate[];
  cycles: Cycle[];
  executions: AgentExecution[];
  approvals: Approval[];
  documents: Document[];
  artifacts: Artifact[];
  workbenchSessions: WorkbenchSession[];
  workbenchEvents: WorkbenchEvent[];
  workbenchArtifacts: WorkbenchArtifact[];
  workbenchChatMessages: WorkbenchChatMessage[];
  workbenchAttempts: WorkbenchAttempt[];
  workbenchCheckpoints: WorkbenchCheckpoint[];
  orchestratorRuns: OrchestratorRun[];
  orchestratorSteps: OrchestratorStep[];
  orchestratorEvents: OrchestratorEvent[];
  contentMissionRuns: ContentMissionRun[];
  contentMissionActions: ContentMissionAction[];
  agentMissionRuns: AgentMissionRun[];
  agentMissionSteps: AgentMissionStep[];
  agentMissionEvents: AgentMissionEvent[];
  reports: Report[];
  usage: UsageLedgerEntry[];
  invoices: Invoice[];
  ledgerEntries: LedgerEntry[];
  payoutHolds: PayoutHold[];
  stripeCustomers: StripeCustomer[];
  stripeSubscriptions: StripeSubscription[];
  stripeWebhookEvents: StripeWebhookEvent[];
  integrations: ToolConnection[];
  auditLogs: AuditLog[];
  jobRuns: JobRun[];
  agentPlugAssignments: AgentSlotAssignment[];
  agentEntitlements: AgentEntitlement[];
  ceoMessages: CeoMessage[];
  ceoSuggestions: CeoSuggestion[];
  comments: Comment[];
  marketingAccounts: MarketingAccount[];
  conversionEvents: ConversionEvent[];
  adCampaigns: AdCampaign[];
  adCreativeVariants: AdCreativeVariant[];
  audienceSegments: AudienceSegment[];
  adSpendCharges: AdSpendCharge[];
  optimizationRuns: OptimizationRun[];
  creativePerformanceMemories: CreativePerformanceMemory[];
};

export type CompanyInput = {
  name: string;
  website?: string;
  autonomyLevel?: AutonomyLevel;
  publicVisibility?: boolean;
  cycleFrequency?: CycleFrequency;
  timezone?: string;
  budgetCents?: number;
  brief: Partial<CompanyBrief>;
};
