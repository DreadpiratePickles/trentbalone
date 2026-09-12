ALTER TABLE "WorkbenchEvent"
  ADD COLUMN IF NOT EXISTS "attemptNo" INTEGER,
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "agentRole" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

ALTER TABLE "WorkbenchArtifact"
  ADD COLUMN IF NOT EXISTS "createdByAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceEventId" TEXT,
  ADD COLUMN IF NOT EXISTS "path" TEXT,
  ADD COLUMN IF NOT EXISTS "previewUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

CREATE TABLE IF NOT EXISTS "WorkbenchAttempt" (
  "id" TEXT NOT NULL,
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
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "WorkbenchAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkbenchAttempt_sessionId_attemptNo_key"
  ON "WorkbenchAttempt"("sessionId", "attemptNo");
CREATE INDEX IF NOT EXISTS "WorkbenchAttempt_companyId_startedAt_idx"
  ON "WorkbenchAttempt"("companyId", "startedAt");

CREATE TABLE IF NOT EXISTS "WorkbenchCheckpoint" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerSessionId" TEXT,
  "workdir" TEXT,
  "previewUrl" TEXT,
  "activePort" INTEGER,
  "fileTreeHash" TEXT,
  "latestVerification" JSONB,
  "sandboxExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkbenchCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkbenchCheckpoint_sessionId_key"
  ON "WorkbenchCheckpoint"("sessionId");
CREATE INDEX IF NOT EXISTS "WorkbenchCheckpoint_companyId_updatedAt_idx"
  ON "WorkbenchCheckpoint"("companyId", "updatedAt");

CREATE TABLE IF NOT EXISTS "OrchestratorRun" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "modelPolicy" JSONB NOT NULL,
  "budgetCents" INTEGER NOT NULL DEFAULT 0,
  "costCents" INTEGER NOT NULL DEFAULT 0,
  "summary" TEXT,
  "cycleId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrchestratorRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrchestratorRun_companyId_startedAt_idx"
  ON "OrchestratorRun"("companyId", "startedAt");
CREATE INDEX IF NOT EXISTS "OrchestratorRun_status_idx"
  ON "OrchestratorRun"("status");

CREATE TABLE IF NOT EXISTS "OrchestratorStep" (
  "id" TEXT NOT NULL,
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
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "OrchestratorStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrchestratorStep_companyId_idx"
  ON "OrchestratorStep"("companyId");
CREATE INDEX IF NOT EXISTS "OrchestratorStep_runId_seq_idx"
  ON "OrchestratorStep"("runId", "seq");

CREATE TABLE IF NOT EXISTS "OrchestratorEvent" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "stepId" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrchestratorEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrchestratorEvent_runId_seq_key"
  ON "OrchestratorEvent"("runId", "seq");
CREATE INDEX IF NOT EXISTS "OrchestratorEvent_companyId_createdAt_idx"
  ON "OrchestratorEvent"("companyId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkbenchAttempt_companyId_fkey') THEN
    ALTER TABLE "WorkbenchAttempt"
      ADD CONSTRAINT "WorkbenchAttempt_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkbenchAttempt_sessionId_fkey') THEN
    ALTER TABLE "WorkbenchAttempt"
      ADD CONSTRAINT "WorkbenchAttempt_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkbenchCheckpoint_companyId_fkey') THEN
    ALTER TABLE "WorkbenchCheckpoint"
      ADD CONSTRAINT "WorkbenchCheckpoint_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkbenchCheckpoint_sessionId_fkey') THEN
    ALTER TABLE "WorkbenchCheckpoint"
      ADD CONSTRAINT "WorkbenchCheckpoint_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrchestratorRun_companyId_fkey') THEN
    ALTER TABLE "OrchestratorRun"
      ADD CONSTRAINT "OrchestratorRun_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrchestratorStep_companyId_fkey') THEN
    ALTER TABLE "OrchestratorStep"
      ADD CONSTRAINT "OrchestratorStep_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrchestratorStep_runId_fkey') THEN
    ALTER TABLE "OrchestratorStep"
      ADD CONSTRAINT "OrchestratorStep_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "OrchestratorRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrchestratorEvent_companyId_fkey') THEN
    ALTER TABLE "OrchestratorEvent"
      ADD CONSTRAINT "OrchestratorEvent_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrchestratorEvent_runId_fkey') THEN
    ALTER TABLE "OrchestratorEvent"
      ADD CONSTRAINT "OrchestratorEvent_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "OrchestratorRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
