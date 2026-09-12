-- Align persisted Postgres schema with billing and tamper-evident audit models
-- already present in prisma/schema.prisma.

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "hash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "prevHash" TEXT;

WITH ordered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "companyId" ORDER BY "createdAt", "id") AS rn
  FROM "AuditLog"
)
UPDATE "AuditLog" AS audit
SET
  "prevHash" = COALESCE(audit."prevHash", CASE WHEN ordered.rn = 1 THEN 'genesis' ELSE 'legacy' END),
  "hash" = COALESCE(audit."hash", 'legacy:' || audit."id")
FROM ordered
WHERE audit."id" = ordered."id";

ALTER TABLE "AuditLog" ALTER COLUMN "hash" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "prevHash" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "Invoice" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "billingPeriod" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "txHash" TEXT,
  "lineItems" JSONB NOT NULL,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_companyId_fkey'
  ) THEN
    ALTER TABLE "Invoice"
      ADD CONSTRAINT "Invoice_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_companyId_billingPeriod_key"
  ON "Invoice"("companyId", "billingPeriod");
CREATE INDEX IF NOT EXISTS "Invoice_companyId_idx" ON "Invoice"("companyId");

ALTER TABLE "UsageLedgerEntry" ADD COLUMN IF NOT EXISTS "invoiceId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UsageLedgerEntry_invoiceId_fkey'
  ) THEN
    ALTER TABLE "UsageLedgerEntry"
      ADD CONSTRAINT "UsageLedgerEntry_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "UsageLedgerEntry_invoiceId_idx" ON "UsageLedgerEntry"("invoiceId");

CREATE TABLE IF NOT EXISTS "LedgerEntry" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "txHash" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LedgerEntry_companyId_fkey'
  ) THEN
    ALTER TABLE "LedgerEntry"
      ADD CONSTRAINT "LedgerEntry_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_companyId_txHash_type_account_key"
  ON "LedgerEntry"("companyId", "txHash", "type", "account");
CREATE INDEX IF NOT EXISTS "LedgerEntry_companyId_idx" ON "LedgerEntry"("companyId");

CREATE TABLE IF NOT EXISTS "PayoutHold" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "creatorWallet" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "releaseAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "PayoutHold_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayoutHold_companyId_fkey'
  ) THEN
    ALTER TABLE "PayoutHold"
      ADD CONSTRAINT "PayoutHold_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PayoutHold_companyId_idx" ON "PayoutHold"("companyId");

DO $$ DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['Invoice', 'LedgerEntry', 'PayoutHold']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS service_bypass ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("companyId" = app_current_company_id())
         WITH CHECK ("companyId" = app_current_company_id())',
      t
    );

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
      EXECUTE format(
        'CREATE POLICY service_bypass ON %I TO postgres USING (TRUE) WITH CHECK (TRUE)',
        t
      );
    END IF;
  END LOOP;
END $$;
