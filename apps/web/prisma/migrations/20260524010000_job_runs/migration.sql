-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL DEFAULT 'running',
    "companyId" TEXT,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "summary" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobRun_companyId_startedAt_idx" ON "JobRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "JobRun_status_startedAt_idx" ON "JobRun"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
