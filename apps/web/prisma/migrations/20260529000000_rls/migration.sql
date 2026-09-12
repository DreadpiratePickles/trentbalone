-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security: tenant isolation for all company-scoped tables
--
-- Policy: every DML statement on a tenant table is filtered to rows where
--   "companyId" = current_setting('app.current_company_id', TRUE)
--
-- Application layer (lib/rls.ts) must SET LOCAL app.current_company_id = ?
-- inside a transaction before any tenant query.
--
-- Service role bypasses RLS so migrations and admin ops still work when the
-- provider exposes a known service role. Some managed Postgres providers (Neon)
-- do not create a "postgres" role, so bypass policies are guarded by role
-- existence checks.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: returns current_setting or '' to avoid errors when var is unset
-- (used in policy expressions for clarity)
CREATE OR REPLACE FUNCTION app_current_company_id()
  RETURNS TEXT LANGUAGE sql STABLE AS
  $$ SELECT current_setting('app.current_company_id', TRUE) $$;

-- ── Per-table RLS ─────────────────────────────────────────────────────────────

DO $$ DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Agent', 'AgentEntitlement', 'AgentExecution', 'AgentPlugAssignment',
    'Approval', 'Artifact', 'AuditLog', 'CeoMessage', 'CeoSuggestion',
    'Comment', 'CompanyMember', 'Cycle', 'Document', 'RecurringTaskTemplate',
    'Report', 'Task', 'ToolConnection', 'UsageLedgerEntry',
    'WorkbenchArtifact', 'WorkbenchEvent', 'WorkbenchSession'
  ]
  LOOP
    -- Enable RLS (safe to re-run; FORCE makes it apply to table owners too)
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Drop old policies if they exist so this migration is idempotent
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS service_bypass ON %I', t);

    -- Tenant isolation policy: both read and write filter by companyId
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("companyId" = app_current_company_id())
         WITH CHECK ("companyId" = app_current_company_id())',
      t
    );

    -- Service bypass: only create when the provider exposes the role.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
      EXECUTE format(
        'CREATE POLICY service_bypass ON %I TO postgres USING (TRUE) WITH CHECK (TRUE)',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ── JobRun: optional companyId ────────────────────────────────────────────────

ALTER TABLE "JobRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JobRun" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "JobRun";
DROP POLICY IF EXISTS service_bypass ON "JobRun";

-- Allow rows with no companyId (system jobs) or matching company
CREATE POLICY tenant_isolation ON "JobRun"
  USING (
    "companyId" IS NULL OR
    "companyId" = app_current_company_id()
  )
  WITH CHECK (
    "companyId" IS NULL OR
    "companyId" = app_current_company_id()
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE POLICY service_bypass ON "JobRun"
      TO postgres USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

-- ── Company table: no RLS (accessed at system level) ─────────────────────────
-- Company itself is a root entity; tenant context is set after company lookup.
-- User is global — no RLS.
