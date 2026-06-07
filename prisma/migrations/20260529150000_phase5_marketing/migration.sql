-- Phase 5 marketing and Stripe funding foundation.

CREATE TABLE IF NOT EXISTS "StripeCustomer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "defaultPaymentMethodId" TEXT,
    "offSessionMandateAcceptedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeCustomer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StripeSubscription" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MarketingAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "externalAccountId" TEXT NOT NULL,
    "externalBusinessId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "dailyBudgetCents" INTEGER,
    "paymentStatus" TEXT NOT NULL DEFAULT 'ready',
    "consentForServerEvents" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdCampaign" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "marketingAccountId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalCampaignId" TEXT,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dailyBudgetCents" INTEGER NOT NULL,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdCreativeVariant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "primaryText" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "assetUrl" TEXT,
    "moderationStatus" TEXT NOT NULL DEFAULT 'pending',
    "brandSafetyStatus" TEXT NOT NULL DEFAULT 'pending',
    "externalCreativeId" TEXT,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCreativeVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConversionEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "sourceUrl" TEXT,
    "userAgentHash" TEXT,
    "fbp" TEXT,
    "fbc" TEXT,
    "hashedUserData" JSONB NOT NULL,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "diagnostics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversionEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AudienceSegment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "externalAudienceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceSegment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdSpendCharge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "billingDate" TIMESTAMP(3) NOT NULL,
    "stripePaymentIntentId" TEXT,
    "adSpendCents" INTEGER NOT NULL,
    "platformFeeCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpendCharge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OptimizationRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "marketingAccountId" TEXT NOT NULL,
    "runDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "inputMetrics" JSONB NOT NULL,
    "decisions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptimizationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CreativePerformanceMemory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "sourceCampaignIds" JSONB NOT NULL,
    "privacyScope" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativePerformanceMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StripeCustomer_companyId_key" ON "StripeCustomer"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "StripeCustomer_stripeCustomerId_key" ON "StripeCustomer"("stripeCustomerId");
CREATE INDEX IF NOT EXISTS "StripeCustomer_companyId_status_idx" ON "StripeCustomer"("companyId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "StripeSubscription_companyId_key" ON "StripeSubscription"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "StripeSubscription_stripeSubscriptionId_key" ON "StripeSubscription"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "StripeSubscription_companyId_status_idx" ON "StripeSubscription"("companyId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "StripeWebhookEvent_stripeEventId_key" ON "StripeWebhookEvent"("stripeEventId");
CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_eventType_idx" ON "StripeWebhookEvent"("eventType");
CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_status_updatedAt_idx" ON "StripeWebhookEvent"("status", "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "MarketingAccount_companyId_platform_key" ON "MarketingAccount"("companyId", "platform");
CREATE INDEX IF NOT EXISTS "MarketingAccount_companyId_idx" ON "MarketingAccount"("companyId");

CREATE INDEX IF NOT EXISTS "AdCampaign_companyId_status_idx" ON "AdCampaign"("companyId", "status");
CREATE INDEX IF NOT EXISTS "AdCampaign_marketingAccountId_idx" ON "AdCampaign"("marketingAccountId");

CREATE UNIQUE INDEX IF NOT EXISTS "AdCreativeVariant_campaignId_variantKey_key" ON "AdCreativeVariant"("campaignId", "variantKey");
CREATE INDEX IF NOT EXISTS "AdCreativeVariant_companyId_idx" ON "AdCreativeVariant"("companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "ConversionEvent_eventId_key" ON "ConversionEvent"("eventId");
CREATE INDEX IF NOT EXISTS "ConversionEvent_companyId_occurredAt_idx" ON "ConversionEvent"("companyId", "occurredAt");

CREATE INDEX IF NOT EXISTS "AudienceSegment_companyId_kind_idx" ON "AudienceSegment"("companyId", "kind");

CREATE UNIQUE INDEX IF NOT EXISTS "AdSpendCharge_companyId_billingDate_key" ON "AdSpendCharge"("companyId", "billingDate");
CREATE INDEX IF NOT EXISTS "AdSpendCharge_companyId_idx" ON "AdSpendCharge"("companyId");

CREATE UNIQUE INDEX IF NOT EXISTS "OptimizationRun_marketingAccountId_runDate_key" ON "OptimizationRun"("marketingAccountId", "runDate");
CREATE INDEX IF NOT EXISTS "OptimizationRun_companyId_idx" ON "OptimizationRun"("companyId");

CREATE INDEX IF NOT EXISTS "CreativePerformanceMemory_companyId_featureKey_idx" ON "CreativePerformanceMemory"("companyId", "featureKey");
CREATE INDEX IF NOT EXISTS "CreativePerformanceMemory_validTo_idx" ON "CreativePerformanceMemory"("validTo");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StripeCustomer_companyId_fkey') THEN
    ALTER TABLE "StripeCustomer" ADD CONSTRAINT "StripeCustomer_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StripeSubscription_companyId_fkey') THEN
    ALTER TABLE "StripeSubscription" ADD CONSTRAINT "StripeSubscription_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingAccount_companyId_fkey') THEN
    ALTER TABLE "MarketingAccount" ADD CONSTRAINT "MarketingAccount_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdCampaign_companyId_fkey') THEN
    ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdCampaign_marketingAccountId_fkey') THEN
    ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_marketingAccountId_fkey"
    FOREIGN KEY ("marketingAccountId") REFERENCES "MarketingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdCreativeVariant_companyId_fkey') THEN
    ALTER TABLE "AdCreativeVariant" ADD CONSTRAINT "AdCreativeVariant_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdCreativeVariant_campaignId_fkey') THEN
    ALTER TABLE "AdCreativeVariant" ADD CONSTRAINT "AdCreativeVariant_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ConversionEvent_companyId_fkey') THEN
    ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AudienceSegment_companyId_fkey') THEN
    ALTER TABLE "AudienceSegment" ADD CONSTRAINT "AudienceSegment_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdSpendCharge_companyId_fkey') THEN
    ALTER TABLE "AdSpendCharge" ADD CONSTRAINT "AdSpendCharge_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OptimizationRun_companyId_fkey') THEN
    ALTER TABLE "OptimizationRun" ADD CONSTRAINT "OptimizationRun_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OptimizationRun_marketingAccountId_fkey') THEN
    ALTER TABLE "OptimizationRun" ADD CONSTRAINT "OptimizationRun_marketingAccountId_fkey"
    FOREIGN KEY ("marketingAccountId") REFERENCES "MarketingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreativePerformanceMemory_companyId_fkey') THEN
    ALTER TABLE "CreativePerformanceMemory" ADD CONSTRAINT "CreativePerformanceMemory_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'StripeCustomer', 'StripeSubscription', 'MarketingAccount', 'AdCampaign',
    'AdCreativeVariant', 'ConversionEvent', 'AudienceSegment', 'AdSpendCharge',
    'OptimizationRun', 'CreativePerformanceMemory'
  ]
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
