CREATE TABLE "AgentPlugAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileSource" TEXT NOT NULL DEFAULT 'agency-agents',
    "environment" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlugAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentPlugAssignment_companyId_role_key" ON "AgentPlugAssignment"("companyId", "role");
CREATE INDEX "AgentPlugAssignment_profileId_idx" ON "AgentPlugAssignment"("profileId");

ALTER TABLE "AgentPlugAssignment"
ADD CONSTRAINT "AgentPlugAssignment_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
