-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "autonomyLevel" TEXT NOT NULL DEFAULT 'autonomous_with_approvals',
    "publicVisibility" BOOLEAN NOT NULL DEFAULT true,
    "publicSubdomain" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "budgetCents" INTEGER NOT NULL DEFAULT 10000,
    "cycleFrequency" TEXT NOT NULL DEFAULT 'daily',
    "lastCycleAt" DATETIME,
    "nextCycleAt" DATETIME,
    "brief" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "weeklyBudgetCents" INTEGER,
    "nightlyRunHour" INTEGER,
    "approvalExpiryOverrides" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CompanyMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "permissions" JSONB NOT NULL,
    CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CompanyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "modelPolicy" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    CONSTRAINT "Agent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentPlugAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileSource" TEXT NOT NULL DEFAULT 'agency-agents',
    "environment" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentPlugAssignment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentEntitlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "profileId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    CONSTRAINT "AgentEntitlement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "agentRole" TEXT NOT NULL,
    "tags" JSONB NOT NULL,
    "dueDate" DATETIME,
    "approvalId" TEXT,
    "recurringTemplateId" TEXT,
    "goalId" TEXT,
    "cycleId" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecurringTaskTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "tags" JSONB NOT NULL,
    "cadence" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastMaterializedAt" DATETIME,
    "nextRunAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringTaskTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Cycle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'scheduled',
    "status" TEXT NOT NULL DEFAULT 'running',
    "phases" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "goalId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "Cycle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Cycle_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'intake',
    "successCriteria" JSONB NOT NULL DEFAULT '[]',
    "constraints" JSONB NOT NULL DEFAULT '{}',
    "rounds" JSONB NOT NULL DEFAULT '[]',
    "progressLog" JSONB NOT NULL DEFAULT '[]',
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Goal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompanyCustomSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CompanyCustomSkill_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'http',
    "credentialRef" TEXT,
    "toolAllowlist" JSONB NOT NULL DEFAULT '[]',
    "reversibleTools" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "discoveredTools" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "McpServer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "action" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Webhook_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "webhookId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "event" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME,
    CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WebhookDelivery_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "cycleId" TEXT,
    "taskId" TEXT,
    "agentRole" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "toolCalls" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentExecution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentExecution_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ToolConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "encryptedData" TEXT,
    "lastCheckedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "taskId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "expiresAt" DATETIME,
    "toolName" TEXT,
    "previewContent" TEXT,
    "previewKind" TEXT,
    CONSTRAINT "Approval_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "memoryTier" TEXT,
    "validFrom" DATETIME,
    "validTo" DATETIME,
    "supersedesId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sourceTaskId" TEXT,
    "sourceCycleId" TEXT,
    "sourceDocumentId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "exportFormat" TEXT NOT NULL,
    "storageKey" TEXT,
    "previewUrl" TEXT,
    "createdByAgent" TEXT NOT NULL,
    "provenance" JSONB NOT NULL,
    "approvalStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Artifact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkbenchSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "taskId" TEXT,
    "agentRole" TEXT NOT NULL,
    "agentMode" TEXT NOT NULL DEFAULT 'build',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL DEFAULT 'mock_local',
    "objective" TEXT NOT NULL,
    "repoUrl" TEXT,
    "branchName" TEXT,
    "workdir" TEXT,
    "previewUrl" TEXT,
    "storageKey" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "metadata" JSONB NOT NULL,
    CONSTRAINT "WorkbenchSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkbenchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "command" TEXT,
    "artifactId" TEXT,
    "attemptNo" INTEGER,
    "durationMs" INTEGER,
    "agentRole" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkbenchArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdByAgent" TEXT,
    "sourceEventId" TEXT,
    "path" TEXT,
    "previewUrl" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchArtifact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkbenchAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "feedback" TEXT,
    "rawArtifact" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "WorkbenchAttempt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkbenchCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "workdir" TEXT,
    "previewUrl" TEXT,
    "activePort" INTEGER,
    "fileTreeHash" TEXT,
    "latestVerification" JSONB,
    "sandboxExpiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkbenchCheckpoint_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchCheckpoint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrchestratorRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "modelPolicy" JSONB NOT NULL,
    "budgetCents" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "replanCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "cycleId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrchestratorRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrchestratorStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "dependsOn" JSONB NOT NULL,
    "expectedOutput" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "needsApproval" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "output" TEXT,
    "critique" JSONB,
    "model" TEXT,
    "tokens" INTEGER,
    "costCents" INTEGER,
    "toolCalls" JSONB,
    "approvalId" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "OrchestratorStep_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrchestratorStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OrchestratorRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrchestratorEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "stepId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrchestratorEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrchestratorEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OrchestratorRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentMissionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "cycleId" TEXT,
    "objective" TEXT NOT NULL,
    "operatingMode" TEXT NOT NULL DEFAULT 'draft_only_until_approval',
    "status" TEXT NOT NULL DEFAULT 'planning',
    "ownerSeat" TEXT NOT NULL DEFAULT 'ceo',
    "externalActionStatus" TEXT NOT NULL DEFAULT 'DRAFT_ONLY',
    "requiredSocialPlatforms" JSONB NOT NULL,
    "requiredMarketingPlatforms" JSONB NOT NULL,
    "socialPublishingRequested" BOOLEAN NOT NULL DEFAULT false,
    "paidAdsRequested" BOOLEAN NOT NULL DEFAULT false,
    "approvalGates" JSONB NOT NULL,
    "memoryLogFields" JSONB NOT NULL,
    "creativeApps" JSONB NOT NULL,
    "budgetCents" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "memoryLogArtifactId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ContentMissionRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentMissionAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ledgerItemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvalGate" TEXT NOT NULL,
    "sourceStage" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "relatedPlatforms" JSONB NOT NULL,
    "approvalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ContentMissionAction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContentMissionAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ContentMissionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMissionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "missionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "trigger" TEXT NOT NULL,
    "ownerSeat" TEXT NOT NULL DEFAULT 'ceo',
    "budgetCents" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "approvalPolicy" JSONB NOT NULL,
    "modelPolicy" JSONB NOT NULL,
    "finalSummary" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentMissionRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMissionStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "agentRole" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dependsOn" JSONB NOT NULL,
    "expectedOutput" TEXT NOT NULL,
    "output" TEXT,
    "toolCalls" JSONB,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "approvalId" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "AgentMissionStep_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentMissionStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentMissionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMissionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "stepId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentMissionEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentMissionEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentMissionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkbenchChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "agentMode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "recommendations" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageLedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT,
    CONSTRAINT "UsageLedgerEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "UsageLedgerEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "companyId" TEXT,
    "trigger" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "summary" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metadata" JSONB NOT NULL,
    CONSTRAINT "JobRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CeoMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CeoMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CeoSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CeoSuggestion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "agentRole" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Comment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "billingPeriod" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "txHash" TEXT,
    "lineItems" JSONB NOT NULL,
    CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PayoutHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "releaseAt" DATETIME NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    CONSTRAINT "PayoutHold_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StripeCustomer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "defaultPaymentMethodId" TEXT,
    "offSessionMandateAcceptedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StripeCustomer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StripeSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trialEndsAt" DATETIME,
    "currentPeriodStart" DATETIME,
    "currentPeriodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StripeSubscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "processedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MarketingAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "externalAccountId" TEXT NOT NULL,
    "externalBusinessId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "dailyBudgetCents" INTEGER,
    "paymentStatus" TEXT NOT NULL DEFAULT 'ready',
    "consentForServerEvents" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MarketingAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "marketingAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalCampaignId" TEXT,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dailyBudgetCents" INTEGER NOT NULL,
    "approvalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AdCampaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AdCampaign_marketingAccountId_fkey" FOREIGN KEY ("marketingAccountId") REFERENCES "MarketingAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdCreativeVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "primaryText" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "assetUrl" TEXT,
    "moderationStatus" TEXT NOT NULL DEFAULT 'pending',
    "brandSafetyStatus" TEXT NOT NULL DEFAULT 'pending',
    "externalCreativeId" TEXT,
    "metrics" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AdCreativeVariant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AdCreativeVariant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConversionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "sourceUrl" TEXT,
    "userAgentHash" TEXT,
    "fbp" TEXT,
    "fbc" TEXT,
    "hashedUserData" JSONB NOT NULL,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "diagnostics" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConversionEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AudienceSegment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "externalAudienceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AudienceSegment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdSpendCharge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "billingDate" DATETIME NOT NULL,
    "stripePaymentIntentId" TEXT,
    "adSpendCents" INTEGER NOT NULL,
    "platformFeeCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AdSpendCharge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OptimizationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "marketingAccountId" TEXT NOT NULL,
    "runDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "inputMetrics" JSONB NOT NULL,
    "decisions" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptimizationRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OptimizationRun_marketingAccountId_fkey" FOREIGN KEY ("marketingAccountId") REFERENCES "MarketingAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreativePerformanceMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "sourceCampaignIds" JSONB NOT NULL,
    "privacyScope" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validTo" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CreativePerformanceMemory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "externalAccountId" TEXT NOT NULL,
    "externalHandle" TEXT,
    "displayName" TEXT,
    "scopes" JSONB NOT NULL,
    "credentialsRef" TEXT,
    "autoPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "content" TEXT NOT NULL,
    "mediaUrls" JSONB NOT NULL,
    "scheduledFor" DATETIME,
    "publishedAt" DATETIME,
    "externalPostId" TEXT,
    "approvalId" TEXT,
    "adaptedFromPostId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialPost_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialPost_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalThreadId" TEXT NOT NULL,
    "contactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "lastMessageAt" DATETIME,
    "metadata" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialConversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialConversation_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialConversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SocialContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalContactId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "profileUrl" TEXT,
    "engagementState" TEXT NOT NULL DEFAULT 'unknown',
    "optOutStatus" TEXT NOT NULL DEFAULT 'not_opted_out',
    "lastOutboundAt" DATETIME,
    "lastInboundAt" DATETIME,
    "memory" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "externalMessageId" TEXT,
    "sentAt" DATETIME,
    "metadata" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SocialConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SocialContact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialVoicePolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "hashtagPolicy" TEXT NOT NULL,
    "emojiPolicy" TEXT NOT NULL,
    "restrictedTerms" JSONB NOT NULL,
    "platformGuidance" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialVoicePolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialAnalyticsSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "metrics" JSONB NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialAnalyticsSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialAnalyticsSnapshot_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SocialOutreachDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvalId" TEXT,
    "riskFlags" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SocialOutreachDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SocialOutreachDraft_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SocialContact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentTrace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "stepTitle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "toolCalls" JSONB NOT NULL,
    "toolCallCount" INTEGER NOT NULL,
    "critiqueVerdict" TEXT,
    "improvement" TEXT,
    "evalScore" REAL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "humanCorrected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentTrace_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SkillDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'quarantine',
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" DATETIME,
    CONSTRAINT "SkillDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SelfImprovementIteration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "candidateId" TEXT,
    "candidateKind" TEXT,
    "score" REAL,
    "delta" REAL,
    "decision" TEXT NOT NULL,
    "triggers" JSONB NOT NULL,
    "approvalId" TEXT,
    "blockedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SelfImprovementIteration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompanyPlaybookEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompanyPlaybookEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_TaskBlocks" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_TaskBlocks_A_fkey" FOREIGN KEY ("A") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_TaskBlocks_B_fkey" FOREIGN KEY ("B") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMember_companyId_userId_key" ON "CompanyMember"("companyId", "userId");

-- CreateIndex
CREATE INDEX "AgentPlugAssignment_profileId_idx" ON "AgentPlugAssignment"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPlugAssignment_companyId_role_key" ON "AgentPlugAssignment"("companyId", "role");

-- CreateIndex
CREATE INDEX "AgentEntitlement_companyId_status_idx" ON "AgentEntitlement"("companyId", "status");

-- CreateIndex
CREATE INDEX "AgentEntitlement_productId_idx" ON "AgentEntitlement"("productId");

-- CreateIndex
CREATE INDEX "AgentEntitlement_profileId_idx" ON "AgentEntitlement"("profileId");

-- CreateIndex
CREATE INDEX "Task_goalId_idx" ON "Task"("goalId");

-- CreateIndex
CREATE INDEX "Task_cycleId_idx" ON "Task"("cycleId");

-- CreateIndex
CREATE INDEX "Cycle_goalId_idx" ON "Cycle"("goalId");

-- CreateIndex
CREATE INDEX "Goal_companyId_createdAt_idx" ON "Goal"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Goal_companyId_status_idx" ON "Goal"("companyId", "status");

-- CreateIndex
CREATE INDEX "CompanyCustomSkill_companyId_idx" ON "CompanyCustomSkill"("companyId");

-- CreateIndex
CREATE INDEX "McpServer_companyId_idx" ON "McpServer"("companyId");

-- CreateIndex
CREATE INDEX "Webhook_companyId_idx" ON "Webhook"("companyId");

-- CreateIndex
CREATE INDEX "Webhook_companyId_enabled_idx" ON "Webhook"("companyId", "enabled");

-- CreateIndex
CREATE INDEX "WebhookDelivery_companyId_createdAt_idx" ON "WebhookDelivery"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_status_idx" ON "WebhookDelivery"("webhookId", "status");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_webhookId_idempotencyKey_key" ON "WebhookDelivery"("webhookId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Approval_companyId_status_expiresAt_idx" ON "Approval"("companyId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "Document_companyId_memoryTier_idx" ON "Document"("companyId", "memoryTier");

-- CreateIndex
CREATE INDEX "Document_supersedesId_idx" ON "Document"("supersedesId");

-- CreateIndex
CREATE INDEX "Document_validTo_idx" ON "Document"("validTo");

-- CreateIndex
CREATE INDEX "Artifact_companyId_createdAt_idx" ON "Artifact"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Artifact_sourceTaskId_idx" ON "Artifact"("sourceTaskId");

-- CreateIndex
CREATE INDEX "Artifact_sourceCycleId_idx" ON "Artifact"("sourceCycleId");

-- CreateIndex
CREATE INDEX "WorkbenchSession_companyId_createdAt_idx" ON "WorkbenchSession"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkbenchSession_taskId_idx" ON "WorkbenchSession"("taskId");

-- CreateIndex
CREATE INDEX "WorkbenchSession_status_idx" ON "WorkbenchSession"("status");

-- CreateIndex
CREATE INDEX "WorkbenchEvent_companyId_createdAt_idx" ON "WorkbenchEvent"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkbenchEvent_sessionId_createdAt_idx" ON "WorkbenchEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkbenchEvent_sessionId_seq_key" ON "WorkbenchEvent"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "WorkbenchArtifact_companyId_createdAt_idx" ON "WorkbenchArtifact"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkbenchArtifact_sessionId_idx" ON "WorkbenchArtifact"("sessionId");

-- CreateIndex
CREATE INDEX "WorkbenchAttempt_companyId_startedAt_idx" ON "WorkbenchAttempt"("companyId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkbenchAttempt_sessionId_attemptNo_key" ON "WorkbenchAttempt"("sessionId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "WorkbenchCheckpoint_sessionId_key" ON "WorkbenchCheckpoint"("sessionId");

-- CreateIndex
CREATE INDEX "WorkbenchCheckpoint_companyId_updatedAt_idx" ON "WorkbenchCheckpoint"("companyId", "updatedAt");

-- CreateIndex
CREATE INDEX "OrchestratorRun_companyId_startedAt_idx" ON "OrchestratorRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "OrchestratorRun_status_idx" ON "OrchestratorRun"("status");

-- CreateIndex
CREATE INDEX "OrchestratorStep_companyId_idx" ON "OrchestratorStep"("companyId");

-- CreateIndex
CREATE INDEX "OrchestratorStep_runId_seq_idx" ON "OrchestratorStep"("runId", "seq");

-- CreateIndex
CREATE INDEX "OrchestratorEvent_companyId_createdAt_idx" ON "OrchestratorEvent"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestratorEvent_runId_seq_key" ON "OrchestratorEvent"("runId", "seq");

-- CreateIndex
CREATE INDEX "ContentMissionRun_companyId_startedAt_idx" ON "ContentMissionRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "ContentMissionRun_status_idx" ON "ContentMissionRun"("status");

-- CreateIndex
CREATE INDEX "ContentMissionAction_companyId_createdAt_idx" ON "ContentMissionAction"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentMissionAction_runId_idx" ON "ContentMissionAction"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentMissionAction_runId_ledgerItemId_key" ON "ContentMissionAction"("runId", "ledgerItemId");

-- CreateIndex
CREATE INDEX "AgentMissionRun_companyId_startedAt_idx" ON "AgentMissionRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentMissionRun_status_idx" ON "AgentMissionRun"("status");

-- CreateIndex
CREATE INDEX "AgentMissionStep_companyId_idx" ON "AgentMissionStep"("companyId");

-- CreateIndex
CREATE INDEX "AgentMissionStep_runId_seq_idx" ON "AgentMissionStep"("runId", "seq");

-- CreateIndex
CREATE INDEX "AgentMissionEvent_companyId_createdAt_idx" ON "AgentMissionEvent"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMissionEvent_runId_seq_key" ON "AgentMissionEvent"("runId", "seq");

-- CreateIndex
CREATE INDEX "WorkbenchChatMessage_sessionId_createdAt_idx" ON "WorkbenchChatMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkbenchChatMessage_companyId_createdAt_idx" ON "WorkbenchChatMessage"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_companyId_startedAt_idx" ON "JobRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "JobRun_status_startedAt_idx" ON "JobRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "Comment_companyId_entityType_entityId_idx" ON "Comment"("companyId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_idx" ON "Invoice"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_companyId_billingPeriod_key" ON "Invoice"("companyId", "billingPeriod");

-- CreateIndex
CREATE INDEX "LedgerEntry_companyId_idx" ON "LedgerEntry"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_companyId_txHash_type_account_key" ON "LedgerEntry"("companyId", "txHash", "type", "account");

-- CreateIndex
CREATE INDEX "PayoutHold_companyId_idx" ON "PayoutHold"("companyId");

-- CreateIndex
CREATE INDEX "StripeCustomer_companyId_status_idx" ON "StripeCustomer"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StripeCustomer_companyId_key" ON "StripeCustomer"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeCustomer_stripeCustomerId_key" ON "StripeCustomer"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "StripeSubscription_companyId_status_idx" ON "StripeSubscription"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StripeSubscription_companyId_key" ON "StripeSubscription"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeSubscription_stripeSubscriptionId_key" ON "StripeSubscription"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeWebhookEvent_stripeEventId_key" ON "StripeWebhookEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_eventType_idx" ON "StripeWebhookEvent"("eventType");

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_status_updatedAt_idx" ON "StripeWebhookEvent"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "MarketingAccount_companyId_idx" ON "MarketingAccount"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAccount_companyId_platform_key" ON "MarketingAccount"("companyId", "platform");

-- CreateIndex
CREATE INDEX "AdCampaign_companyId_status_idx" ON "AdCampaign"("companyId", "status");

-- CreateIndex
CREATE INDEX "AdCampaign_marketingAccountId_idx" ON "AdCampaign"("marketingAccountId");

-- CreateIndex
CREATE INDEX "AdCreativeVariant_companyId_idx" ON "AdCreativeVariant"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AdCreativeVariant_campaignId_variantKey_key" ON "AdCreativeVariant"("campaignId", "variantKey");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionEvent_eventId_key" ON "ConversionEvent"("eventId");

-- CreateIndex
CREATE INDEX "ConversionEvent_companyId_occurredAt_idx" ON "ConversionEvent"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "AudienceSegment_companyId_kind_idx" ON "AudienceSegment"("companyId", "kind");

-- CreateIndex
CREATE INDEX "AdSpendCharge_companyId_idx" ON "AdSpendCharge"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpendCharge_companyId_billingDate_key" ON "AdSpendCharge"("companyId", "billingDate");

-- CreateIndex
CREATE INDEX "OptimizationRun_companyId_idx" ON "OptimizationRun"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "OptimizationRun_marketingAccountId_runDate_key" ON "OptimizationRun"("marketingAccountId", "runDate");

-- CreateIndex
CREATE INDEX "CreativePerformanceMemory_companyId_featureKey_idx" ON "CreativePerformanceMemory"("companyId", "featureKey");

-- CreateIndex
CREATE INDEX "CreativePerformanceMemory_validTo_idx" ON "CreativePerformanceMemory"("validTo");

-- CreateIndex
CREATE INDEX "SocialAccount_companyId_platform_idx" ON "SocialAccount"("companyId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_companyId_platform_externalAccountId_key" ON "SocialAccount"("companyId", "platform", "externalAccountId");

-- CreateIndex
CREATE INDEX "SocialPost_companyId_status_createdAt_idx" ON "SocialPost"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SocialPost_socialAccountId_createdAt_idx" ON "SocialPost"("socialAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "SocialConversation_companyId_status_idx" ON "SocialConversation"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SocialConversation_companyId_platform_externalThreadId_key" ON "SocialConversation"("companyId", "platform", "externalThreadId");

-- CreateIndex
CREATE INDEX "SocialContact_companyId_platform_idx" ON "SocialContact"("companyId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialContact_companyId_platform_externalContactId_key" ON "SocialContact"("companyId", "platform", "externalContactId");

-- CreateIndex
CREATE INDEX "SocialMessage_companyId_conversationId_createdAt_idx" ON "SocialMessage"("companyId", "conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialVoicePolicy_companyId_key" ON "SocialVoicePolicy"("companyId");

-- CreateIndex
CREATE INDEX "SocialAnalyticsSnapshot_companyId_platform_periodStart_idx" ON "SocialAnalyticsSnapshot"("companyId", "platform", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAnalyticsSnapshot_socialAccountId_periodStart_periodEnd_key" ON "SocialAnalyticsSnapshot"("socialAccountId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "SocialOutreachDraft_companyId_status_idx" ON "SocialOutreachDraft"("companyId", "status");

-- CreateIndex
CREATE INDEX "AgentTrace_companyId_taskType_createdAt_idx" ON "AgentTrace"("companyId", "taskType", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTrace_runId_idx" ON "AgentTrace"("runId");

-- CreateIndex
CREATE INDEX "SkillDraft_companyId_taskType_status_idx" ON "SkillDraft"("companyId", "taskType", "status");

-- CreateIndex
CREATE INDEX "SelfImprovementIteration_companyId_createdAt_idx" ON "SelfImprovementIteration"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "CompanyPlaybookEntry_companyId_createdAt_idx" ON "CompanyPlaybookEntry"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "_TaskBlocks_AB_unique" ON "_TaskBlocks"("A", "B");

-- CreateIndex
CREATE INDEX "_TaskBlocks_B_index" ON "_TaskBlocks"("B");

