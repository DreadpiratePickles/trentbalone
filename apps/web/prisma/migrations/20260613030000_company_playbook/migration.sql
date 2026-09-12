-- CreateTable
CREATE TABLE "CompanyPlaybookEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyPlaybookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyPlaybookEntry_companyId_createdAt_idx" ON "CompanyPlaybookEntry"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "CompanyPlaybookEntry" ADD CONSTRAINT "CompanyPlaybookEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
