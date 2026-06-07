-- CreateTable
CREATE TABLE "WorkbenchSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "taskId" TEXT,
    "agentRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL DEFAULT 'mock_local',
    "objective" TEXT NOT NULL,
    "repoUrl" TEXT,
    "branchName" TEXT,
    "workdir" TEXT,
    "previewUrl" TEXT,
    "storageKey" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL,
    CONSTRAINT "WorkbenchSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkbenchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "command" TEXT,
    "artifactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchArtifact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkbenchSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
CREATE INDEX "WorkbenchArtifact_companyId_createdAt_idx" ON "WorkbenchArtifact"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkbenchArtifact_sessionId_idx" ON "WorkbenchArtifact"("sessionId");
