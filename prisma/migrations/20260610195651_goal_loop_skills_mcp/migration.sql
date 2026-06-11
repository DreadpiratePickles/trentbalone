-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('intake', 'active', 'round_running', 'awaiting_review', 'completed', 'stopped');

-- DropIndex
DROP INDEX "UsageLedgerEntry_invoiceId_idx";

-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "degraded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrchestratorRun" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorkbenchCheckpoint" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'intake',
    "successCriteria" JSONB NOT NULL DEFAULT '[]',
    "constraints" JSONB NOT NULL DEFAULT '{}',
    "rounds" JSONB NOT NULL DEFAULT '[]',
    "progressLog" JSONB NOT NULL DEFAULT '[]',
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyCustomSkill" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyCustomSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentMissionRun" (
    "id" TEXT NOT NULL,
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
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentMissionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentMissionAction" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentMissionAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMissionRun" (
    "id" TEXT NOT NULL,
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
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMissionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMissionStep" (
    "id" TEXT NOT NULL,
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
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentMissionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMissionEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "stepId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMissionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "externalAccountId" TEXT NOT NULL,
    "externalHandle" TEXT,
    "displayName" TEXT,
    "scopes" JSONB NOT NULL,
    "credentialsRef" TEXT,
    "autoPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "content" TEXT NOT NULL,
    "mediaUrls" JSONB NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalPostId" TEXT,
    "approvalId" TEXT,
    "adaptedFromPostId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialConversation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalThreadId" TEXT NOT NULL,
    "contactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "lastMessageAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalContactId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "profileUrl" TEXT,
    "engagementState" TEXT NOT NULL DEFAULT 'unknown',
    "optOutStatus" TEXT NOT NULL DEFAULT 'not_opted_out',
    "lastOutboundAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "memory" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "externalMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialVoicePolicy" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "hashtagPolicy" TEXT NOT NULL,
    "emojiPolicy" TEXT NOT NULL,
    "restrictedTerms" JSONB NOT NULL,
    "platformGuidance" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialVoicePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialOutreachDraft" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvalId" TEXT,
    "riskFlags" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialOutreachDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTrace" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "agentRole" "AgentRole" NOT NULL,
    "stepTitle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "toolCalls" JSONB NOT NULL,
    "toolCallCount" INTEGER NOT NULL,
    "critiqueVerdict" TEXT,
    "improvement" TEXT,
    "evalScore" DOUBLE PRECISION,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "humanCorrected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillDraft" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'quarantine',
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),

    CONSTRAINT "SkillDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfImprovementIteration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "candidateId" TEXT,
    "candidateKind" TEXT,
    "score" DOUBLE PRECISION,
    "delta" DOUBLE PRECISION,
    "decision" TEXT NOT NULL,
    "triggers" JSONB NOT NULL,
    "approvalId" TEXT,
    "blockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelfImprovementIteration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Goal_companyId_createdAt_idx" ON "Goal"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Goal_companyId_status_idx" ON "Goal"("companyId", "status");

-- CreateIndex
CREATE INDEX "CompanyCustomSkill_companyId_idx" ON "CompanyCustomSkill"("companyId");

-- CreateIndex
CREATE INDEX "McpServer_companyId_idx" ON "McpServer"("companyId");

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
CREATE UNIQUE INDEX "SocialAnalyticsSnapshot_socialAccountId_periodStart_periodE_key" ON "SocialAnalyticsSnapshot"("socialAccountId", "periodStart", "periodEnd");

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
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyCustomSkill" ADD CONSTRAINT "CompanyCustomSkill_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentMissionRun" ADD CONSTRAINT "ContentMissionRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentMissionAction" ADD CONSTRAINT "ContentMissionAction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentMissionAction" ADD CONSTRAINT "ContentMissionAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ContentMissionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMissionRun" ADD CONSTRAINT "AgentMissionRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMissionStep" ADD CONSTRAINT "AgentMissionStep_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMissionStep" ADD CONSTRAINT "AgentMissionStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentMissionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMissionEvent" ADD CONSTRAINT "AgentMissionEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMissionEvent" ADD CONSTRAINT "AgentMissionEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentMissionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialConversation" ADD CONSTRAINT "SocialConversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialConversation" ADD CONSTRAINT "SocialConversation_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialConversation" ADD CONSTRAINT "SocialConversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SocialContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialContact" ADD CONSTRAINT "SocialContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialMessage" ADD CONSTRAINT "SocialMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialMessage" ADD CONSTRAINT "SocialMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SocialConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialMessage" ADD CONSTRAINT "SocialMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SocialContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialVoicePolicy" ADD CONSTRAINT "SocialVoicePolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAnalyticsSnapshot" ADD CONSTRAINT "SocialAnalyticsSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAnalyticsSnapshot" ADD CONSTRAINT "SocialAnalyticsSnapshot_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialOutreachDraft" ADD CONSTRAINT "SocialOutreachDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialOutreachDraft" ADD CONSTRAINT "SocialOutreachDraft_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "SocialContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTrace" ADD CONSTRAINT "AgentTrace_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillDraft" ADD CONSTRAINT "SkillDraft_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfImprovementIteration" ADD CONSTRAINT "SelfImprovementIteration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
