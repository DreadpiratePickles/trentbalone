-- Approval previews and expiry fields used by approval gates.
ALTER TABLE "Approval" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "Approval" ADD COLUMN "toolName" TEXT;
ALTER TABLE "Approval" ADD COLUMN "previewContent" TEXT;
ALTER TABLE "Approval" ADD COLUMN "previewKind" TEXT;

-- Memory tier fields used by working/episodic/semantic memory.
ALTER TABLE "Document" ADD COLUMN "memoryTier" TEXT;
ALTER TABLE "Document" ADD COLUMN "validFrom" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN "validTo" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN "supersedesId" TEXT;

CREATE INDEX "Approval_companyId_status_expiresAt_idx" ON "Approval"("companyId", "status", "expiresAt");
CREATE INDEX "Document_companyId_memoryTier_idx" ON "Document"("companyId", "memoryTier");
CREATE INDEX "Document_supersedesId_idx" ON "Document"("supersedesId");
CREATE INDEX "Document_validTo_idx" ON "Document"("validTo");
