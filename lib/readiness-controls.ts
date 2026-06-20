export type ReadinessControlStatus =
  | "enforced"
  | "partial"
  | "external_required"
  | "proof_required";

export type ReadinessControlCategory =
  | "security"
  | "privacy"
  | "testing"
  | "reliability"
  | "governance"
  | "architecture";

export type ReadinessControl = {
  slug: string;
  label: string;
  category: ReadinessControlCategory;
  status: ReadinessControlStatus;
  why: string;
  evidence: string[];
  nextAction: string;
};

export const REQUIRED_READINESS_CONTROL_SLUGS = [
  "input-sanitization-injection-prevention",
  "authentication",
  "authorization-roles-permissions",
  "session-management-token-expiry",
  "https-tls-certification-rotation",
  "rate-limiting-abuse-prevention",
  "secret-management",
  "dependency-scanning-vulnerability-patching",
  "multi-tenancy-data-isolation",
  "pii-handling",
  "data-retention-deletion-policies",
  "regulatory-compliance",
  "audit-trails-tamper-evidence-lagging",
  "integration-testing",
  "end-to-end-testing",
  "regression-testing",
  "load-testing",
  "stress-testing",
  "chaos-engineering-resilience-testing",
  "test-coverage",
  "ci-thresholds",
  "code-review-process-standards",
  "error-handling",
  "graceful-degradation",
  "retry-backoff-idempotency",
  "circuit-breakers-fallback-behaviour",
  "concurrency-race-condition-prevention",
  "caching-strategy-invalidation-plan",
  "accessibility",
  "rto",
  "rpo",
  "disaster-recovery",
  "adr",
  "architecture-diagrams",
  "api-contracts",
] as const;

export const READINESS_CONTROLS: ReadinessControl[] = [
  {
    slug: "input-sanitization-injection-prevention",
    label: "Input sanitization and injection prevention",
    category: "security",
    status: "partial",
    why: "Trent accepts prompts, uploads, tokens, URLs, and provider payloads; unsafe boundary handling can become SQL/HogQL/header/path injection or XSS.",
    evidence: [
      "Zod schemas and header-safety checks in app/api/integrations/github/route.ts.",
      "Upload size/path protections in app/api/companies/[id]/wiki-notes/upload/route.ts and app/api/workbench/[id]/uploads/route.ts.",
      "HogQL literal escaping in lib/hogql.ts.",
      "CSP and no-frame headers in next.config.ts.",
    ],
    nextAction: "Add a route inventory test that requires a Zod/body schema or documented no-body exemption for every POST/PATCH/PUT route.",
  },
  {
    slug: "authentication",
    label: "Authentication",
    category: "security",
    status: "enforced",
    why: "Protected pages and APIs must reject forged cookies and unauthenticated requests.",
    evidence: [
      "Auth.js JWT validation in middleware.ts.",
      "Provider setup and secure session cookie config in lib/auth.ts.",
      "Auth regression tests in middleware.test.ts and lib/auth-dev-login.test.ts.",
    ],
    nextAction: "Set real production AUTH_URL/AUTH_SECRET/provider credentials in Railway and keep dev login disabled except approved break-glass windows.",
  },
  {
    slug: "authorization-roles-permissions",
    label: "Authorization, roles, and permissions",
    category: "security",
    status: "enforced",
    why: "Company workspaces are multi-user, and every company-scoped action needs least-privilege checks.",
    evidence: [
      "requireRoleForRequest() checks in lib/session.ts.",
      "Page access guard in lib/page-auth.ts.",
      "Action permission helpers in lib/supervision/permissions.ts.",
      "Route-level role tests across app/api/** route.test.ts files.",
    ],
    nextAction: "Add a route inventory guard that fails when a company-scoped route does not call requireRoleForRequest() or requireCompanyPageAccess().",
  },
  {
    slug: "session-management-token-expiry",
    label: "Session management and token expiry",
    category: "security",
    status: "partial",
    why: "Sessions identify the operator and must expire, be cookie-bound, and avoid localStorage token exposure.",
    evidence: [
      "JWT session strategy and httpOnly/sameSite/secure cookie options in lib/auth.ts.",
      "Middleware validates token.sub rather than cookie presence in middleware.ts.",
    ],
    nextAction: "Set explicit Auth.js maxAge/updateAge policy, document re-auth expectations, and add tests for expired-token rejection.",
  },
  {
    slug: "https-tls-certification-rotation",
    label: "HTTPS, TLS certification, and rotation",
    category: "security",
    status: "external_required",
    why: "TLS is terminated by Railway/custom domains, not by this Next.js app process.",
    evidence: [
      "HSTS header configured in next.config.ts.",
      "Production health and auth URL depend on Railway/domain configuration.",
    ],
    nextAction: "Configure Railway/custom domain TLS, verify certificate renewal, and add a production smoke check that asserts HTTPS redirect plus Strict-Transport-Security.",
  },
  {
    slug: "rate-limiting-abuse-prevention",
    label: "Rate limiting and abuse prevention",
    category: "security",
    status: "partial",
    why: "Public endpoints, auth, and expensive AI/workbench flows can be abused without per-IP/user/company throttles.",
    evidence: [
      "Redis-backed buckets in lib/rate-limit.ts.",
      "Public endpoint rate limit coverage documented in docs/verification/security-audit-2026-06-19.md.",
      "Rate limit tests in lib/rate-limit.test.ts.",
    ],
    nextAction: "Fail closed for high-cost AI/sandbox endpoints when Redis is unavailable and add per-route abuse budgets for model calls and sandbox starts.",
  },
  {
    slug: "secret-management",
    label: "Secret management",
    category: "security",
    status: "enforced",
    why: "Provider credentials and user secrets must never be committed or exposed to agents as raw values.",
    evidence: [
      "Encrypted credential handling in lib/credential-vault.ts and lib/crypto.ts.",
      "Gitleaks CI job in .github/workflows/ci.yml.",
      "Expanded env-file rule documented in docs/verification/security-audit-2026-06-19.md.",
    ],
    nextAction: "Run a production secret rotation after any env file exposure and keep credential proofs handle-based, never value-based.",
  },
  {
    slug: "dependency-scanning-vulnerability-patching",
    label: "Dependency scanning and vulnerability patching",
    category: "security",
    status: "enforced",
    why: "Known vulnerable transitive dependencies can compromise CI, dev servers, or runtime provider paths.",
    evidence: [
      "Dependabot config in .github/dependabot.yml.",
      "CodeQL/gitleaks workflow in .github/workflows/ci.yml.",
      "security:deps script in package.json enforces npm audit --audit-level=high.",
      "Patched package versions and overrides in package.json/package-lock.json.",
    ],
    nextAction: "Track remaining moderate Next/PostCSS advisory until Next publishes a non-breaking patched line or a vetted framework upgrade is scheduled.",
  },
  {
    slug: "multi-tenancy-data-isolation",
    label: "Multi-tenancy and data isolation",
    category: "security",
    status: "enforced",
    why: "A cross-company leak would break the core trust model.",
    evidence: [
      "RLS helpers in lib/rls.ts and lib/with-rls.ts.",
      "Company access guards in lib/page-auth.ts and lib/session.ts.",
      "Company-scoped route tests for 401/403/no-cross-company access.",
    ],
    nextAction: "Run a live Postgres RLS proof after every migration and ensure the production DB user is not a superuser/table owner.",
  },
  {
    slug: "pii-handling",
    label: "PII handling",
    category: "privacy",
    status: "partial",
    why: "Trent stores user email, company context, external account data, prompts, and agent outputs that may include personal information.",
    evidence: [
      "Information classification in docs/security/policies/information-security-policy.md.",
      "Credential redaction and handle-based provider readiness in lib/provider-readiness.ts.",
      "Generic unauthorized/forbidden errors in lib/session.ts.",
    ],
    nextAction: "Add a PII data map, redact PII in structured logs by default, and add export/delete workflows for user/company records.",
  },
  {
    slug: "data-retention-deletion-policies",
    label: "Data retention and deletion policies",
    category: "privacy",
    status: "external_required",
    why: "Retention periods and deletion SLAs are product/legal decisions that must align with customer contracts and backup windows.",
    evidence: [
      "Company archive/delete paths exist in app/api/companies/[id]/route.ts.",
      "Backup health endpoint is surfaced by app/api/health/route.ts.",
    ],
    nextAction: "Define retention windows for audit logs, memories, uploads, workbench artifacts, backups, and provider caches; then implement deletion jobs and legal hold exceptions.",
  },
  {
    slug: "regulatory-compliance",
    label: "Regulatory compliance",
    category: "governance",
    status: "external_required",
    why: "SOC 2, GDPR, privacy notices, subprocessors, and DPIAs require legal/operational decisions beyond code.",
    evidence: [
      "Security policy baseline in docs/security/policies/information-security-policy.md.",
      "Audit and readiness controls in this register.",
    ],
    nextAction: "Choose target framework (SOC 2 readiness first, GDPR baseline for EU/UK users), assign owners, and create evidence folders mapped to controls.",
  },
  {
    slug: "audit-trails-tamper-evidence-lagging",
    label: "Audit trails and tamper-evidence lagging/loss detection",
    category: "security",
    status: "partial",
    why: "Run, approval, provider, and admin actions need trustworthy forensic records, and missing/late logs must be visible.",
    evidence: [
      "Hash-chained audit log implementation in lib/audit-log.ts.",
      "Audit chain verification helper verifyAuditChain().",
      "Ops/proof dashboards surface evidence and audit history.",
    ],
    nextAction: "Add a scheduled audit-chain verifier and alert on broken chains, write lag, missing sequence IDs, and failed audit-log appends.",
  },
  {
    slug: "integration-testing",
    label: "Integration testing",
    category: "testing",
    status: "enforced",
    why: "Routes, stores, workbench providers, orchestration, and connectors need cross-module verification.",
    evidence: [
      "Vitest route/store/provider tests across app/api/** and lib/**.",
      "workbench:eval:suite, orc:eval, providers:proof scripts in package.json.",
      "CI eval-gate job in .github/workflows/ci.yml.",
    ],
    nextAction: "Keep live-provider integration proofs separate from deterministic CI and publish their latest artifact status in the proof dashboard.",
  },
  {
    slug: "end-to-end-testing",
    label: "End-to-end testing",
    category: "testing",
    status: "partial",
    why: "Browser/user journeys catch auth, routing, hydration, approval, and Workbench proof failures that unit tests miss.",
    evidence: [
      "Playwright-based proof scripts: ops:ui-proof, trust-panel:proof, workbench:eval:live-cloud.",
      "Browser proof artifacts documented under docs/verification/.",
    ],
    nextAction: "Add a stable CI e2e smoke suite for sign-in, company dashboard, run cycle, workbench approval, MCP, and trust panel.",
  },
  {
    slug: "regression-testing",
    label: "Regression testing",
    category: "testing",
    status: "enforced",
    why: "Past false-green claims show that test count drift and skipped paths must be caught.",
    evidence: [
      "test:ci and ci:truth scripts in package.json.",
      "CI uploads vitest results and ci-truth artifacts in .github/workflows/ci.yml.",
      "Pinned baseline in docs/verification/ci-truth-baseline.json.",
    ],
    nextAction: "Require any baseline changes to include a why-this-count-changed note in review.",
  },
  {
    slug: "load-testing",
    label: "Load testing",
    category: "testing",
    status: "external_required",
    why: "Throughput, queue depth, and provider quota behavior need environment-sized infrastructure and realistic traffic.",
    evidence: [
      "Worker health endpoint and queue tooling exist, but no load-test harness is committed.",
    ],
    nextAction: "Add k6 or Artillery scenarios for auth, run-cycle launch, SSE/poll fallback, workbench file ops, and provider proof endpoints; run against staging.",
  },
  {
    slug: "stress-testing",
    label: "Stress testing",
    category: "testing",
    status: "external_required",
    why: "Stress tests intentionally push beyond limits and should not run against production or developer laptops casually.",
    evidence: [
      "Rate limits and worker health provide guardrails, but no stress harness is committed.",
    ],
    nextAction: "Define safe staging limits, then test worker saturation, Redis outage, DB connection pressure, and sandbox-provider quota exhaustion.",
  },
  {
    slug: "chaos-engineering-resilience-testing",
    label: "Chaos engineering and resilience testing",
    category: "testing",
    status: "external_required",
    why: "Chaos testing requires controlled fault injection and rollback-ready staging infrastructure.",
    evidence: [
      "Graceful degradation patterns exist in provider readiness and health checks.",
      "No automated chaos harness is currently present.",
    ],
    nextAction: "Create staging-only fault drills for Redis down, provider 5xx, worker crash, DB failover, and SSE disconnect; record expected degraded states.",
  },
  {
    slug: "test-coverage",
    label: "Test coverage",
    category: "testing",
    status: "partial",
    why: "Pass counts are strong, but coverage percentage thresholds are not yet enforced.",
    evidence: [
      "Large Vitest suite and ci:truth count enforcement exist.",
      "No Vitest coverage provider/threshold is configured in package.json.",
    ],
    nextAction: "Add @vitest/coverage-v8 with thresholds for core security/orchestration/workbench modules, then ratchet upward by area.",
  },
  {
    slug: "ci-thresholds",
    label: "Thresholds enforced in CI",
    category: "testing",
    status: "enforced",
    why: "Security and quality gates must fail builds before bad claims reach deployment.",
    evidence: [
      "typecheck, test:ci, ci:truth, eval gates, CodeQL, gitleaks in .github/workflows/ci.yml.",
      "preflight:security and security:deps scripts in package.json.",
    ],
    nextAction: "Add security:readiness to CI and add coverage thresholds once coverage instrumentation lands.",
  },
  {
    slug: "code-review-process-standards",
    label: "Code review process and standards",
    category: "governance",
    status: "partial",
    why: "Sensitive changes need consistent owner review and verification evidence.",
    evidence: [
      "CODEOWNERS exists at .github/CODEOWNERS.",
      "Security-sensitive paths are assigned to @DreadpiratePickles.",
    ],
    nextAction: "Enable branch protection requiring CODEOWNERS review, CI pass, and no direct pushes to main.",
  },
  {
    slug: "error-handling",
    label: "Error handling",
    category: "reliability",
    status: "partial",
    why: "Users need actionable failures while logs retain enough detail for operators.",
    evidence: [
      "Generic unauthorized/forbidden helpers in lib/session.ts.",
      "Provider readiness recovery messages in lib/provider-readiness.ts.",
      "Workbench/live proof scripts classify degraded and failed outcomes.",
    ],
    nextAction: "Standardize error envelopes across API routes with code/message/retryable/evidenceId fields.",
  },
  {
    slug: "graceful-degradation",
    label: "Graceful degradation",
    category: "reliability",
    status: "partial",
    why: "Provider outages should produce honest degraded states, not fake success or silent spinners.",
    evidence: [
      "Provider readiness statuses in lib/provider-readiness.ts.",
      "Health readiness in lib/health-readiness.ts and app/api/health/route.ts.",
      "Trust/proof UI labels degraded, failed, unavailable, and credential-blocked states.",
    ],
    nextAction: "Define product-wide degraded-state copy and require evidence links for every degraded pass.",
  },
  {
    slug: "retry-backoff-idempotency",
    label: "Retry logic with backoff and idempotency",
    category: "reliability",
    status: "partial",
    why: "Durable workers and provider calls need retries that do not duplicate side effects.",
    evidence: [
      "BullMQ worker/queue retry patterns exist in lib/worker.ts and queue modules.",
      "Workbench and orchestration approvals use durable IDs.",
    ],
    nextAction: "Add idempotency keys for email, social, CRM, deploy, and approval resume actions; document retry budgets per adapter.",
  },
  {
    slug: "circuit-breakers-fallback-behaviour",
    label: "Circuit breakers and fallback behaviour",
    category: "reliability",
    status: "partial",
    why: "Repeated provider failures should temporarily stop calls and route agents to safe alternatives.",
    evidence: [
      "Provider readiness and toolUnavailableResult() block unavailable/test-only tools in lib/provider-readiness.ts.",
      "Health endpoint reports degraded dependencies.",
    ],
    nextAction: "Add per-provider circuit breaker state with half-open probing, cooldowns, and UI visibility in connector/proof dashboards.",
  },
  {
    slug: "concurrency-race-condition-prevention",
    label: "Concurrency handling and race condition prevention",
    category: "reliability",
    status: "partial",
    why: "Concurrent audit appends, approvals, workbench writes, and cycle launches can duplicate or corrupt state.",
    evidence: [
      "Serializable audit-log transaction in lib/audit-log.ts.",
      "Durable queues and run IDs in orchestration/worker paths.",
    ],
    nextAction: "Add unique idempotency constraints for cycle launches and approval resume actions; add concurrent request tests for run/cancel/approve flows.",
  },
  {
    slug: "caching-strategy-invalidation-plan",
    label: "Caching strategy and invalidation plan",
    category: "architecture",
    status: "external_required",
    why: "Caching affects freshness, privacy, and multi-tenant isolation; ad hoc caching would be dangerous.",
    evidence: [
      "Current app primarily uses direct DB/provider reads and React Query client-side state.",
    ],
    nextAction: "Write a cache ADR covering cacheable resources, tenant-keying, TTLs, invalidation events, and no-store requirements for sensitive pages.",
  },
  {
    slug: "accessibility",
    label: "Accessibility",
    category: "testing",
    status: "partial",
    why: "Trent is an operator console; keyboard, screen reader, contrast, and visible focus support are part of production quality.",
    evidence: [
      "Many controls include aria-label/role usage across components.",
      "No automated WCAG/a11y gate is currently in CI.",
    ],
    nextAction: "Add axe-based Playwright checks for sign-in, dashboard, Workbench, MCP, proof dashboard, and approvals; target WCAG 2.2 AA.",
  },
  {
    slug: "rto",
    label: "RTO",
    category: "reliability",
    status: "external_required",
    why: "Recovery Time Objective is a business commitment for maximum acceptable downtime.",
    evidence: [
      "Health endpoint and backup health are present, but no formal RTO is committed.",
    ],
    nextAction: "Set service-tier RTO targets for web, worker, DB, Redis, and provider-dependent features; test restore drills against those targets.",
  },
  {
    slug: "rpo",
    label: "RPO",
    category: "reliability",
    status: "external_required",
    why: "Recovery Point Objective is a business commitment for maximum acceptable data loss.",
    evidence: [
      "Backup health checks exist, but no formal RPO/backup frequency target is committed.",
    ],
    nextAction: "Set RPO by data class: audit logs, companies, memories, workbench artifacts, provider credentials, and proof artifacts.",
  },
  {
    slug: "disaster-recovery",
    label: "Disaster recovery",
    category: "reliability",
    status: "external_required",
    why: "A DR plan requires backup storage, restore permissions, runbooks, owners, and tested recovery drills.",
    evidence: [
      "Backup health surfaces in app/api/health/route.ts.",
      "Security policy references encrypted backups.",
    ],
    nextAction: "Write and rehearse a DR runbook: backup verification, restore into staging, DNS/Railway failover, credential rotation, and customer comms.",
  },
  {
    slug: "adr",
    label: "ADR",
    category: "architecture",
    status: "enforced",
    why: "Major architectural decisions must stay reviewable as Trent's agent platform gets more complex.",
    evidence: [
      "ADR directory exists at docs/adr/.",
      "Durable execution ADR exists at docs/adr/ADR-001-durable-execution-engine.md.",
      "This pass adds docs/adr/ADR-002-security-reliability-control-register.md.",
    ],
    nextAction: "Require an ADR for changes to auth, tenancy, orchestration engine, provider execution, or data retention.",
  },
  {
    slug: "architecture-diagrams",
    label: "Architecture diagrams",
    category: "architecture",
    status: "partial",
    why: "Operators and reviewers need a shared model of app, worker, providers, queues, DB, proof/evidence, and tenant boundaries.",
    evidence: [
      "This pass adds docs/architecture/security-reliability-overview.md with Mermaid diagrams.",
    ],
    nextAction: "Keep diagrams beside ADRs and update them when provider, queue, auth, or data-flow boundaries change.",
  },
  {
    slug: "api-contracts",
    label: "API contracts",
    category: "architecture",
    status: "partial",
    why: "API contracts make routes testable and consumable without reading source code.",
    evidence: [
      "This pass adds docs/api/contracts/security-readiness-api-contracts.md.",
      "Zod schemas exist in multiple routes, but no generated OpenAPI spec is enforced.",
    ],
    nextAction: "Generate OpenAPI 3.1 from route schemas or maintain a hand-authored spec with contract tests for public/operator APIs.",
  },
];

export function readinessControlBySlug(slug: string): ReadinessControl | undefined {
  return READINESS_CONTROLS.find((control) => control.slug === slug);
}
