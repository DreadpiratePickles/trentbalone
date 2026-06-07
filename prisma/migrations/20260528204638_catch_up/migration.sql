/*
  Warnings:

  - Changed the type of `permissions` on the `Agent` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `permissions` on the `CompanyMember` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `phases` on the `Cycle` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `tags` on the `RecurringTaskTemplate` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `findings` on the `Report` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `recommendations` on the `Report` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `tags` on the `Task` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `scopes` on the `ToolConnection` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "Agent" ALTER COLUMN "permissions" TYPE JSONB USING to_jsonb("permissions"),
ALTER COLUMN "permissions" SET NOT NULL;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "approvalExpiryOverrides" JSONB,
ADD COLUMN     "nightlyRunHour" INTEGER,
ADD COLUMN     "weeklyBudgetCents" INTEGER;

-- AlterTable
ALTER TABLE "CompanyMember" ALTER COLUMN "permissions" TYPE JSONB USING to_jsonb("permissions"),
ALTER COLUMN "permissions" SET NOT NULL;

-- AlterTable
ALTER TABLE "Cycle" ALTER COLUMN "phases" TYPE JSONB USING to_jsonb("phases"),
ALTER COLUMN "phases" SET NOT NULL;

-- AlterTable
ALTER TABLE "RecurringTaskTemplate" ALTER COLUMN "tags" TYPE JSONB USING to_jsonb("tags"),
ALTER COLUMN "tags" SET NOT NULL;

-- AlterTable
ALTER TABLE "Report" ALTER COLUMN "findings" TYPE JSONB USING to_jsonb("findings"),
ALTER COLUMN "findings" SET NOT NULL,
ALTER COLUMN "recommendations" TYPE JSONB USING to_jsonb("recommendations"),
ALTER COLUMN "recommendations" SET NOT NULL;

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "tags" TYPE JSONB USING to_jsonb("tags"),
ALTER COLUMN "tags" SET NOT NULL;

-- AlterTable
ALTER TABLE "ToolConnection" ALTER COLUMN "scopes" TYPE JSONB USING to_jsonb("scopes"),
ALTER COLUMN "scopes" SET NOT NULL;

-- CreateTable
CREATE TABLE "CeoMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeoMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeoSuggestion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeoSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "agentRole" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Comment_companyId_entityType_entityId_idx" ON "Comment"("companyId", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "CeoMessage" ADD CONSTRAINT "CeoMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CeoSuggestion" ADD CONSTRAINT "CeoSuggestion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
