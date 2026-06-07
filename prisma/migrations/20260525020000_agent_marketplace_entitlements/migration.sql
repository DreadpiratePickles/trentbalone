CREATE TABLE "AgentEntitlement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "profileId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AgentEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentEntitlement_companyId_status_idx" ON "AgentEntitlement"("companyId", "status");
CREATE INDEX "AgentEntitlement_productId_idx" ON "AgentEntitlement"("productId");
CREATE INDEX "AgentEntitlement_profileId_idx" ON "AgentEntitlement"("profileId");

ALTER TABLE "AgentEntitlement"
ADD CONSTRAINT "AgentEntitlement_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
