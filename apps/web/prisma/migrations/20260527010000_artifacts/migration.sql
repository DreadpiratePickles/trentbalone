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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Artifact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Artifact_companyId_createdAt_idx" ON "Artifact"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Artifact_sourceTaskId_idx" ON "Artifact"("sourceTaskId");

-- CreateIndex
CREATE INDEX "Artifact_sourceCycleId_idx" ON "Artifact"("sourceCycleId");
