import type {
  Company as PrismaCompany,
  Agent as PrismaAgent,
  AgentPlugAssignment as PrismaSlot,
  AgentEntitlement as PrismaEntitlement,
  Task as PrismaTask,
  RecurringTaskTemplate as PrismaRecurring,
  Cycle as PrismaCycle,
  AgentExecution as PrismaExecution,
  Approval as PrismaApproval,
  Document as PrismaDoc,
  Artifact as PrismaArtifact,
  WorkbenchSession as PrismaSession,
  WorkbenchEvent as PrismaEvent,
  WorkbenchArtifact as PrismaArtifactWb,
  WorkbenchChatMessage as PrismaChatMessage,
  WorkbenchAttempt as PrismaWorkbenchAttempt,
  WorkbenchCheckpoint as PrismaWorkbenchCheckpoint,
  OrchestratorRun as PrismaOrchestratorRun,
  OrchestratorStep as PrismaOrchestratorStep,
  OrchestratorEvent as PrismaOrchestratorEvent,
  ContentMissionRun as PrismaContentMissionRun,
  ContentMissionAction as PrismaContentMissionAction,
  AgentMissionRun as PrismaAgentMissionRun,
  AgentMissionStep as PrismaAgentMissionStep,
  AgentMissionEvent as PrismaAgentMissionEvent,
  Report as PrismaReport,
  UsageLedgerEntry as PrismaUsage,
  ToolConnection as PrismaConnection,
  AuditLog as PrismaAudit,
  JobRun as PrismaJob,
  CeoMessage as PrismaCeoMsg,
  CeoSuggestion as PrismaCeoSug,
} from "@prisma/client";
import type {
  Company, CompanyStatus, AutonomyLevel, CycleFrequency, CompanyBrief, CompanyMetrics,
  Agent, AgentRole,
  AgentSlotAssignment,
  AgentEntitlement,
  Task, TaskStatus,
  RecurringTaskTemplate,
  Cycle,
  AgentExecution, ToolCallRecord,
  Approval, ApprovalStatus,
  Document,
  Artifact,
  WorkbenchSession,
  WorkbenchEvent,
  WorkbenchArtifact,
  WorkbenchChatMessage,
  WorkbenchAttempt,
  WorkbenchCheckpoint,
  OrchestratorRun,
  OrchestratorStep,
  OrchestratorEvent,
  ContentMissionRun,
  ContentMissionAction,
  AgentMissionRun,
  AgentMissionStep,
  AgentMissionEvent,
  Report,
  UsageLedgerEntry,
  ToolConnection,
  AuditLog,
  JobRun, JobRunStatus, JobRunType,
  CeoMessage,
  CeoSuggestion,
} from "@/lib/types";

export function toIso(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

export function toIsoReq(date: Date): string {
  return date.toISOString();
}

export function mapCompany(row: PrismaCompany): Company {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    website: row.website ?? undefined,
    status: row.status as CompanyStatus,
    autonomyLevel: row.autonomyLevel as AutonomyLevel,
    publicVisibility: row.publicVisibility,
    publicSubdomain: row.publicSubdomain ?? `${row.slug}.trent.local`,
    timezone: row.timezone,
    budgetCents: row.budgetCents,
    weeklyBudgetCents: row.weeklyBudgetCents ?? undefined,
    nightlyRunHour: row.nightlyRunHour ?? undefined,
    approvalExpiryOverrides: (row.approvalExpiryOverrides ?? {}) as Record<string, number>,
    cycleFrequency: row.cycleFrequency as CycleFrequency,
    lastCycleAt: toIso(row.lastCycleAt),
    nextCycleAt: toIso(row.nextCycleAt),
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
    brief: row.brief as CompanyBrief,
    metrics: row.metrics as CompanyMetrics
  };
}

export function mapAgent(row: PrismaAgent): Agent {
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role as AgentRole,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    modelPolicy: row.modelPolicy,
    permissions: row.permissions as string[]
  };
}

export function mapAgentPlugAssignment(row: PrismaSlot): AgentSlotAssignment {
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role as AgentRole,
    profileId: row.profileId,
    profileSource: row.profileSource as AgentSlotAssignment["profileSource"],
    environment: row.environment as AgentSlotAssignment["environment"],
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt)
  };
}

export function mapAgentEntitlement(row: PrismaEntitlement): AgentEntitlement {
  return {
    id: row.id,
    companyId: row.companyId,
    productId: row.productId,
    profileId: row.profileId ?? undefined,
    source: row.source as AgentEntitlement["source"],
    status: row.status as AgentEntitlement["status"],
    createdAt: toIsoReq(row.createdAt),
    expiresAt: toIso(row.expiresAt)
  };
}

export function mapTask(row: PrismaTask): Task {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    priority: row.priority as Task["priority"],
    agentRole: row.agentRole as AgentRole,
    tags: row.tags as string[],
    dueDate: toIso(row.dueDate),
    approvalId: row.approvalId ?? undefined,
    recurringTemplateId: row.recurringTemplateId ?? undefined,
    costCents: row.costCents,
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt)
  };
}

export function mapRecurringTask(row: PrismaRecurring): RecurringTaskTemplate {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    prompt: row.prompt,
    agentRole: row.agentRole as AgentRole,
    priority: row.priority as RecurringTaskTemplate["priority"],
    tags: row.tags as string[],
    cadence: row.cadence as RecurringTaskTemplate["cadence"],
    enabled: row.enabled,
    lastMaterializedAt: toIso(row.lastMaterializedAt),
    nextRunAt: toIsoReq(row.nextRunAt),
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapCycle(row: PrismaCycle): Cycle {
  return {
    id: row.id,
    companyId: row.companyId,
    trigger: row.trigger as Cycle["trigger"],
    kind: ((row as { kind?: string }).kind ?? "scheduled") as Cycle["kind"],
    status: row.status as Cycle["status"],
    phases: row.phases as string[],
    summary: row.summary,
    startedAt: toIsoReq(row.startedAt),
    completedAt: toIso(row.completedAt)
  };
}

export function mapExecution(row: PrismaExecution): AgentExecution {
  return {
    id: row.id,
    companyId: row.companyId,
    cycleId: row.cycleId ?? undefined,
    taskId: row.taskId ?? undefined,
    agentRole: row.agentRole as AgentRole,
    input: row.input,
    output: row.output,
    toolCalls: (row.toolCalls as ToolCallRecord[]) ?? [],
    status: row.status as AgentExecution["status"],
    model: row.model,
    tokens: row.tokens,
    costCents: row.costCents,
    durationMs: row.durationMs,
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapApproval(row: PrismaApproval): Approval {
  return {
    id: row.id,
    companyId: row.companyId,
    taskId: row.taskId ?? undefined,
    action: row.action,
    reason: row.reason,
    status: row.status as ApprovalStatus,
    createdAt: toIsoReq(row.createdAt),
    resolvedAt: toIso(row.resolvedAt),
    expiresAt: toIso(row.expiresAt),
    toolName: row.toolName ?? undefined,
    previewContent: row.previewContent ?? undefined,
    previewKind: (row.previewKind as Approval["previewKind"]) ?? undefined,
  };
}

export function mapDocument(row: PrismaDoc): Document {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as Document["type"],
    title: row.title,
    content: row.content,
    source: row.source,
    version: row.version,
    memoryTier: (row.memoryTier ?? undefined) as Document["memoryTier"],
    validFrom: row.validFrom ? toIsoReq(row.validFrom) : undefined,
    validTo: row.validTo ? toIsoReq(row.validTo) : undefined,
    supersedesId: row.supersedesId ?? undefined,
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapArtifact(row: PrismaArtifact): Artifact {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceTaskId: row.sourceTaskId ?? undefined,
    sourceCycleId: row.sourceCycleId ?? undefined,
    sourceDocumentId: row.sourceDocumentId ?? undefined,
    type: row.type as Artifact["type"],
    status: row.status as Artifact["status"],
    title: row.title,
    summary: row.summary,
    content: row.content,
    exportFormat: row.exportFormat as Artifact["exportFormat"],
    storageKey: row.storageKey ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    createdByAgent: row.createdByAgent as Artifact["createdByAgent"],
    provenance: row.provenance as Artifact["provenance"],
    approvalStatus: row.approvalStatus as Artifact["approvalStatus"],
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt)
  };
}

export function mapWorkbenchSession(row: PrismaSession): WorkbenchSession {
  return {
    id: row.id,
    companyId: row.companyId,
    taskId: row.taskId ?? undefined,
    agentRole: row.agentRole as WorkbenchSession["agentRole"],
    agentMode: (row.agentMode ?? "build") as WorkbenchSession["agentMode"],
    messageCount: row.messageCount ?? 0,
    status: row.status as WorkbenchSession["status"],
    provider: row.provider as WorkbenchSession["provider"],
    objective: row.objective,
    repoUrl: row.repoUrl ?? undefined,
    branchName: row.branchName ?? undefined,
    workdir: row.workdir ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    storageKey: row.storageKey ?? undefined,
    costCents: row.costCents,
    startedAt: toIso(row.startedAt),
    stoppedAt: toIso(row.stoppedAt),
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
    metadata: row.metadata as WorkbenchSession["metadata"]
  };
}

export function mapWorkbenchEvent(row: PrismaEvent): WorkbenchEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    sessionId: row.sessionId,
    seq: row.seq,
    type: row.type as WorkbenchEvent["type"],
    status: row.status as WorkbenchEvent["status"],
    title: row.title,
    content: row.content,
    command: row.command ?? undefined,
    artifactId: row.artifactId ?? undefined,
    attemptNo: row.attemptNo ?? undefined,
    durationMs: row.durationMs ?? undefined,
    agentRole: (row.agentRole ?? undefined) as WorkbenchEvent["agentRole"],
    metadata: (row.metadata ?? undefined) as WorkbenchEvent["metadata"],
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapWorkbenchArtifact(row: PrismaArtifactWb): WorkbenchArtifact {
  return {
    id: row.id,
    companyId: row.companyId,
    sessionId: row.sessionId,
    kind: row.kind as WorkbenchArtifact["kind"],
    title: row.title,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdByAgent: (row.createdByAgent ?? undefined) as WorkbenchArtifact["createdByAgent"],
    sourceEventId: row.sourceEventId ?? undefined,
    path: row.path ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    metadata: (row.metadata ?? undefined) as WorkbenchArtifact["metadata"],
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapWorkbenchAttempt(row: PrismaWorkbenchAttempt): WorkbenchAttempt {
  return {
    id: row.id,
    companyId: row.companyId,
    sessionId: row.sessionId,
    attemptNo: row.attemptNo,
    status: row.status as WorkbenchAttempt["status"],
    model: row.model,
    feedback: row.feedback ?? undefined,
    rawArtifact: row.rawArtifact ?? undefined,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costCents: row.costCents,
    startedAt: toIsoReq(row.startedAt),
    completedAt: toIso(row.completedAt),
  };
}

export function mapWorkbenchCheckpoint(row: PrismaWorkbenchCheckpoint): WorkbenchCheckpoint {
  return {
    id: row.id,
    companyId: row.companyId,
    sessionId: row.sessionId,
    provider: row.provider as WorkbenchCheckpoint["provider"],
    providerSessionId: row.providerSessionId ?? undefined,
    workdir: row.workdir ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    activePort: row.activePort ?? undefined,
    fileTreeHash: row.fileTreeHash ?? undefined,
    latestVerification: (row.latestVerification ?? undefined) as WorkbenchCheckpoint["latestVerification"],
    sandboxExpiresAt: toIso(row.sandboxExpiresAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export function mapOrchestratorRun(row: PrismaOrchestratorRun): OrchestratorRun {
  return {
    id: row.id,
    companyId: row.companyId,
    objective: row.objective,
    trigger: row.trigger as OrchestratorRun["trigger"],
    status: row.status as OrchestratorRun["status"],
    modelPolicy: row.modelPolicy as OrchestratorRun["modelPolicy"],
    budgetCents: row.budgetCents,
    costCents: row.costCents,
    replanCount: row.replanCount,
    summary: row.summary ?? undefined,
    cycleId: row.cycleId ?? undefined,
    startedAt: toIsoReq(row.startedAt),
    completedAt: toIso(row.completedAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export function mapOrchestratorStep(row: PrismaOrchestratorStep): OrchestratorStep {
  return {
    id: row.id,
    runId: row.runId,
    companyId: row.companyId,
    seq: row.seq,
    title: row.title,
    rationale: row.rationale,
    agentRole: row.agentRole as OrchestratorStep["agentRole"],
    dependsOn: row.dependsOn as string[],
    expectedOutput: row.expectedOutput,
    riskLevel: row.riskLevel,
    needsApproval: row.needsApproval,
    status: row.status as OrchestratorStep["status"],
    output: row.output ?? undefined,
    critique: (row.critique ?? undefined) as OrchestratorStep["critique"],
    model: row.model ?? undefined,
    tokens: row.tokens ?? undefined,
    costCents: row.costCents ?? undefined,
    toolCalls: (row.toolCalls ?? undefined) as OrchestratorStep["toolCalls"],
    approvalId: row.approvalId ?? undefined,
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
  };
}

export function mapOrchestratorEvent(row: PrismaOrchestratorEvent): OrchestratorEvent {
  return {
    id: row.id,
    runId: row.runId,
    companyId: row.companyId,
    seq: row.seq,
    kind: row.kind,
    stepId: row.stepId ?? undefined,
    payload: row.payload as OrchestratorEvent["payload"],
    createdAt: toIsoReq(row.createdAt),
  };
}

export function mapContentMissionRun(row: PrismaContentMissionRun): ContentMissionRun {
  return {
    id: row.id,
    companyId: row.companyId,
    runId: row.runId,
    cycleId: row.cycleId ?? undefined,
    objective: row.objective,
    operatingMode: row.operatingMode,
    status: row.status as ContentMissionRun["status"],
    ownerSeat: row.ownerSeat as ContentMissionRun["ownerSeat"],
    externalActionStatus: row.externalActionStatus as ContentMissionRun["externalActionStatus"],
    requiredSocialPlatforms: row.requiredSocialPlatforms as string[],
    requiredMarketingPlatforms: row.requiredMarketingPlatforms as string[],
    socialPublishingRequested: row.socialPublishingRequested,
    paidAdsRequested: row.paidAdsRequested,
    approvalGates: row.approvalGates as string[],
    memoryLogFields: row.memoryLogFields as string[],
    creativeApps: row.creativeApps as string[],
    budgetCents: row.budgetCents,
    costCents: row.costCents,
    summary: row.summary ?? undefined,
    memoryLogArtifactId: row.memoryLogArtifactId ?? undefined,
    startedAt: toIsoReq(row.startedAt),
    completedAt: toIso(row.completedAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export function mapContentMissionAction(row: PrismaContentMissionAction): ContentMissionAction {
  return {
    id: row.id,
    runId: row.runId,
    companyId: row.companyId,
    ledgerItemId: row.ledgerItemId,
    kind: row.kind,
    owner: row.owner as ContentMissionAction["owner"],
    status: row.status as ContentMissionAction["status"],
    approvalGate: row.approvalGate,
    sourceStage: row.sourceStage,
    reason: row.reason,
    relatedPlatforms: row.relatedPlatforms as string[],
    approvalId: row.approvalId ?? undefined,
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export function mapAgentMissionRun(row: PrismaAgentMissionRun): AgentMissionRun {
  return {
    id: row.id,
    companyId: row.companyId,
    objective: row.objective,
    missionType: row.missionType as AgentMissionRun["missionType"],
    status: row.status as AgentMissionRun["status"],
    trigger: row.trigger as AgentMissionRun["trigger"],
    ownerSeat: row.ownerSeat,
    budgetCents: row.budgetCents,
    costCents: row.costCents,
    approvalPolicy: row.approvalPolicy as AgentMissionRun["approvalPolicy"],
    modelPolicy: row.modelPolicy as AgentMissionRun["modelPolicy"],
    finalSummary: row.finalSummary ?? undefined,
    startedAt: toIsoReq(row.startedAt),
    completedAt: toIso(row.completedAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export function mapAgentMissionStep(row: PrismaAgentMissionStep): AgentMissionStep {
  return {
    id: row.id,
    runId: row.runId,
    companyId: row.companyId,
    seq: row.seq,
    agentRole: row.agentRole,
    title: row.title,
    objective: row.objective,
    status: row.status as AgentMissionStep["status"],
    dependsOn: row.dependsOn as string[],
    expectedOutput: row.expectedOutput,
    output: row.output ?? undefined,
    toolCalls: (row.toolCalls ?? undefined) as AgentMissionStep["toolCalls"],
    costCents: row.costCents,
    approvalId: row.approvalId ?? undefined,
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
  };
}

export function mapAgentMissionEvent(row: PrismaAgentMissionEvent): AgentMissionEvent {
  return {
    id: row.id,
    runId: row.runId,
    companyId: row.companyId,
    seq: row.seq,
    kind: row.kind,
    stepId: row.stepId ?? undefined,
    payload: row.payload as AgentMissionEvent["payload"],
    createdAt: toIsoReq(row.createdAt),
  };
}

export function mapWorkbenchChatMessage(row: PrismaChatMessage): WorkbenchChatMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    sessionId: row.sessionId,
    role: row.role as WorkbenchChatMessage["role"],
    content: row.content,
    agentMode: (row.agentMode ?? undefined) as WorkbenchChatMessage["agentMode"],
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapReport(row: PrismaReport): Report {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as Report["type"],
    title: row.title,
    findings: row.findings as string[],
    recommendations: row.recommendations as string[],
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapUsage(row: PrismaUsage & { invoiceId?: string | null }): UsageLedgerEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    category: row.category as UsageLedgerEntry["category"],
    description: row.description,
    amountCents: row.amountCents,
    metadata: (row.metadata as UsageLedgerEntry["metadata"]) ?? {},
    createdAt: toIsoReq(row.createdAt),
    invoiceId: row.invoiceId ?? undefined,
  };
}

export function mapToolConnection(row: PrismaConnection): ToolConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider,
    scopes: row.scopes as string[],
    status: row.status as ToolConnection["status"],
    encryptedData: row.encryptedData ?? undefined,
    lastCheckedAt: toIsoReq(row.lastCheckedAt)
  };
}

export function mapAuditLog(row: PrismaAudit): AuditLog {
  return {
    id: row.id,
    companyId: row.companyId,
    actor: row.actor as AuditLog["actor"],
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    summary: row.summary,
    hash: row.hash,
    prevHash: row.prevHash,
    createdAt: toIsoReq(row.createdAt),
  };
}

export function mapJobRun(row: PrismaJob): JobRun {
  return {
    id: row.id,
    type: row.type as JobRunType,
    status: row.status as JobRunStatus,
    companyId: row.companyId ?? undefined,
    trigger: row.trigger as JobRun["trigger"],
    startedAt: toIsoReq(row.startedAt),
    completedAt: toIso(row.completedAt),
    summary: row.summary,
    resultCount: row.resultCount,
    error: row.error ?? undefined,
    metadata: (row.metadata as JobRun["metadata"]) ?? {}
  };
}

export function mapCeoMessage(row: PrismaCeoMsg): CeoMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    direction: row.direction as CeoMessage["direction"],
    kind: row.kind as CeoMessage["kind"],
    content: row.content,
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapCeoSuggestion(row: PrismaCeoSug): CeoSuggestion {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    body: row.body,
    category: row.category as CeoSuggestion["category"],
    status: row.status as CeoSuggestion["status"],
    createdAt: toIsoReq(row.createdAt)
  };
}
