import { AgentRole } from "./types";

export type WorkbenchSessionStatus = "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type WorkbenchProvider = "mock_local" | "e2b" | "daytona" | "railway" | "fly_machines" | "modal" | "self_hosted";
export type WorkbenchEventType = "plan" | "shell" | "browser" | "file" | "test" | "screenshot" | "artifact" | "deploy" | "approval" | "system";
export type WorkbenchEventStatus = "pending" | "running" | "completed" | "failed" | "needs_approval";
export type WorkbenchArtifactKind = "file" | "screenshot" | "terminal_log" | "test_result" | "preview" | "export" | "har" | "perf_trace";
export type WorkbenchAttemptStatus = "running" | "completed" | "failed" | "cancelled" | "needs_approval";
export type WorkbenchRollbackMode = "text_files_only" | "git_commit" | "provider_native";

/**
 * a competing platform-style agent modes. `build` drives the autonomous plan→write→run→heal→preview
 * loop; `research` and `design` stream a single synthesis pass with a mode-specific persona.
 */
export type WorkbenchAgentMode = "build" | "research" | "design";
export type WorkbenchChatRole = "user" | "assistant" | "system";

export type WorkbenchChatMessage = {
  id: string;
  companyId: string;
  sessionId: string;
  role: WorkbenchChatRole;
  content: string;
  agentMode?: WorkbenchAgentMode;
  createdAt: string;
};

export type WorkbenchSessionStats = {
  total: number;
  byMode: Record<WorkbenchAgentMode, number>;
  recentActivity: WorkbenchSession[];
};

export type WorkbenchSessionMetadata = {
  networkPolicy: "deny_all" | "allowlist" | "open_with_approval";
  allowedHosts: string[];
  maxRuntimeSeconds: number;
  maxCostCents: number;
  approvalRequiredFor: string[];
  rollbackAvailable: boolean;
  rollbackMode?: WorkbenchRollbackMode;
  rollbackDescription?: string;
  appSolo?: {
    agentRole: AgentRole;
    agentLabel: string;
    appId: string;
    appName: string;
    appScopes?: string[];
    deliverables?: string[];
    approvalGates?: string[];
    mode?: WorkbenchAgentMode;
    lastHeartbeatAt?: string;
    heartbeatStaleAfterSeconds?: number;
    lastLifecycleEvent?: "heartbeat" | "paused" | "resume";
    pausedAt?: string;
    resumeCount?: number;
  };
  agentRun?: {
    agentRole: AgentRole;
    agentLabel: string;
    tools?: string[];
    deliverables?: string[];
    approvalGates?: string[];
    evidenceRequired?: string[];
    mode?: WorkbenchAgentMode;
    lastHeartbeatAt?: string;
    heartbeatStaleAfterSeconds?: number;
    lastLifecycleEvent?: "heartbeat" | "paused" | "resume";
    pausedAt?: string;
    resumeCount?: number;
  };
};

export type WorkbenchSession = {
  id: string;
  companyId: string;
  taskId?: string;
  agentRole: AgentRole;
  agentMode?: WorkbenchAgentMode;
  messageCount?: number;
  status: WorkbenchSessionStatus;
  provider: WorkbenchProvider;
  objective: string;
  repoUrl?: string;
  branchName?: string;
  workdir?: string;
  previewUrl?: string;
  storageKey?: string;
  costCents: number;
  startedAt?: string;
  stoppedAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata: WorkbenchSessionMetadata;
};

export type WorkbenchEvent = {
  id: string;
  companyId: string;
  sessionId: string;
  seq?: number;
  type: WorkbenchEventType;
  status: WorkbenchEventStatus;
  title: string;
  content: string;
  command?: string;
  artifactId?: string;
  attemptNo?: number;
  durationMs?: number;
  agentRole?: AgentRole;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type WorkbenchArtifact = {
  id: string;
  companyId: string;
  sessionId: string;
  kind: WorkbenchArtifactKind;
  title: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  createdByAgent?: AgentRole;
  sourceEventId?: string;
  path?: string;
  previewUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type WorkbenchAttempt = {
  id: string;
  companyId: string;
  sessionId: string;
  attemptNo: number;
  status: WorkbenchAttemptStatus;
  model: string;
  feedback?: string;
  rawArtifact?: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  startedAt: string;
  completedAt?: string;
};

export type WorkbenchCheckpoint = {
  id: string;
  companyId: string;
  sessionId: string;
  provider: WorkbenchProvider;
  providerSessionId?: string;
  workdir?: string;
  previewUrl?: string;
  activePort?: number;
  fileTreeHash?: string;
  latestVerification?: Record<string, unknown>;
  sandboxExpiresAt?: string;
  updatedAt: string;
};

export type WorkbenchFileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string;
};
