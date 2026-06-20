# Trent Security, Reliability, Testing, and Governance Readiness Report

Date: 2026-06-20  
Branch: `codex/security-reliability-readiness`

## Scope

This report covers the requested checklist:

- input sanitization and injection prevention
- authentication, authorization, roles, permissions, session management, token expiry
- HTTPS/TLS/certification/rotation
- rate limiting, abuse prevention, secret management, dependency scanning, vulnerability patching
- multi-tenancy, data isolation, PII, retention, deletion, regulatory compliance
- audit trails, tamper evidence, lag/loss detection
- integration, end-to-end, regression, load, stress, chaos/resilience testing
- coverage, CI thresholds, code review standards
- error handling, graceful degradation, retries, backoff, idempotency, circuit breakers, fallback behavior
- concurrency, caching, accessibility, RTO, RPO, disaster recovery
- ADRs, architecture diagrams, API contracts

## Reference Standards

These are the external standards/guidance used as the baseline:

- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) for application security verification requirements.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) for tamper detection and audit log handling.
- [OWASP API Security 2023 API4](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) and [OWASP DoS Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html) for rate limiting/resource controls.
- [Next.js headers docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/headers) and [Next.js CSP guide](https://nextjs.org/docs/app/guides/content-security-policy) for framework-level security headers.
- [GitHub Dependabot security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates) for dependency remediation workflow.
- [NIST disaster recovery plan glossary](https://csrc.nist.gov/glossary/term/disaster_recovery_plan) and NIST SP 800-34 for contingency planning language.
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) for accessibility conformance.
- [OpenAPI Specification](https://swagger.io/specification/) for API contract structure.

## What Was Completed In This Pass

1. Added production and dev dependency scanning gates:
   - `security:deps` runs `npm audit --audit-level=high --omit=dev`.
   - `preflight:security` runs dependency audit plus a readiness check.
   - CI now runs `npm run preflight:security` in `.github/workflows/ci.yml`.

2. Patched dependency risk:
   - Updated direct dependencies: `@daytona/sdk`, `e2b`, `ethers`, `next`.
   - Updated dev tools: `vitest`, `tsx`.
   - Added overrides for vulnerable transitive paths: OpenTelemetry, `protobufjs`, `form-data`, `vite`, `esbuild`.
   - Result: `npm audit --audit-level=high` returns no high/critical advisories. Two moderate Next/PostCSS advisories remain and are tracked.

3. Hardened global browser headers:
   - Added `Strict-Transport-Security`.
   - Added `Cross-Origin-Opener-Policy`.
   - Added `X-DNS-Prefetch-Control`.
   - Kept CSP, frame, nosniff, referrer, and permissions policy headers.

4. Added machine-readable control register:
   - `lib/readiness-controls.ts` covers every requested checklist item.
   - `lib/readiness-controls.test.ts` fails if any requested control is missing, duplicated, or lacks evidence/next action.
   - `scripts/ci/security-readiness-check.ts` fails if controls, headers, or CI hooks drift.

5. Added supporting docs:
   - `docs/adr/ADR-002-security-reliability-control-register.md`
   - `docs/architecture/security-reliability-overview.md`
   - `docs/api/contracts/security-readiness-api-contracts.md`

## Control Status Summary

| Status | Meaning |
|---|---|
| `enforced` | Code, tests, CI, or existing platform wiring enforces the control today. |
| `partial` | Meaningful controls exist, but coverage is not complete enough to claim full readiness. |
| `external_required` | Requires Railway/provider/legal/org decisions outside the repo. |
| `proof_required` | Code exists, but needs a live or staging proof before being called complete. |

## Checklist Results

| Control | Status | Current evidence | Remaining work |
|---|---:|---|---|
| Input sanitization and injection prevention | partial | Zod route schemas, upload guards, HogQL escaping, CSP | Add route inventory test requiring schema/no-body exemption for all mutating routes. |
| Authentication | enforced | Auth.js JWT validation in middleware, secure cookies, auth tests | Fix Railway auth env before prod testing. |
| Authorization, roles, permissions | enforced | `requireRoleForRequest`, `requireCompanyPageAccess`, route tests | Add route inventory guard for missing authz. |
| Session management and token expiry | partial | HTTP-only secure cookies, JWT session strategy | Add explicit maxAge/updateAge and expired-token tests. |
| HTTPS/TLS certification/rotation | external_required | HSTS header now configured | Configure Railway/custom-domain TLS and test renewal/HTTPS redirect. |
| Rate limiting and abuse prevention | partial | Redis buckets for user/company/public/auth endpoints | Fail closed for high-cost routes when Redis is missing. |
| Secret management | enforced | credential vault, gitleaks, env-file scan rules | Rotate any exposed local credentials outside repo. |
| Dependency scanning and vulnerability patching | enforced | Dependabot, CodeQL, gitleaks, `security:deps`, patched lockfile | Track moderate Next/PostCSS advisory. |
| Multi-tenancy and data isolation | enforced | RLS helpers, page access, company route tests | Run live Postgres RLS proof after migrations. |
| PII handling | partial | security policy classification, redaction patterns | Create PII data map and export/delete workflows. |
| Data retention and deletion policies | external_required | company archive/delete paths exist | Define retention windows and implement deletion jobs/legal hold. |
| Regulatory compliance | external_required | baseline information security policy | Choose SOC 2/GDPR scope, owners, evidence folders. |
| Audit trails and tamper evidence lag/loss detection | partial | hash-chained audit log and verifier | Add scheduled chain verifier and alerts for lag/missing entries. |
| Integration testing | enforced | route/store/provider tests, eval scripts, CI eval gate | Keep live proofs separate from deterministic CI. |
| End-to-end testing | partial | Playwright proof scripts exist | Add stable sign-in/dashboard/workbench/MCP/proof e2e suite. |
| Regression testing | enforced | `test:ci`, `ci:truth`, pinned baseline | Require reason note for baseline changes. |
| Load testing | external_required | no committed load harness | Add k6/Artillery scenarios and run against staging. |
| Stress testing | external_required | no committed stress harness | Define staging stress limits and run worker/DB/provider saturation tests. |
| Chaos engineering and resilience testing | external_required | graceful degradation patterns exist | Add staging-only Redis/provider/worker/DB fault drills. |
| Test coverage | partial | broad test suite and count truth | Add coverage provider and thresholds for critical modules. |
| Thresholds enforced in CI | enforced | typecheck, tests, ci truth, eval gate, security preflight | Add coverage thresholds once coverage lands. |
| Code review process and standards | partial | CODEOWNERS exists | Enable branch protection requiring CODEOWNERS and CI. |
| Error handling | partial | generic auth errors, provider recovery copy | Standardize API error envelopes. |
| Graceful degradation | partial | provider readiness, health readiness, trust/proof labels | Define product-wide degraded-state copy and evidence requirements. |
| Retry logic with backoff and idempotency | partial | durable queues and stable IDs exist | Add idempotency keys for email/social/CRM/deploy/approvals. |
| Circuit breakers and fallback behavior | partial | unavailable/test-only tool blocking | Add provider circuit breaker state and half-open probes. |
| Concurrency and race condition prevention | partial | serializable audit append, durable queues | Add unique idempotency constraints and concurrent approve/cancel tests. |
| Caching strategy and invalidation plan | external_required | primarily direct reads today | Write cache ADR with tenant keys, TTLs, invalidation, no-store rules. |
| Accessibility | partial | aria roles/labels appear in components | Add axe/WCAG 2.2 AA Playwright gates. |
| RTO | external_required | health and backup signals exist | Set service-tier RTOs and test restore drills. |
| RPO | external_required | backup health exists | Set data-class RPOs and backup frequency requirements. |
| Disaster recovery | external_required | backup health and policy references | Write and rehearse DR runbook. |
| ADR | enforced | ADR directory and durable execution ADR | Require ADRs for auth/tenancy/orchestration/provider/data-retention changes. |
| Architecture diagrams | partial | architecture doc added in this pass | Keep diagrams updated with ADRs. |
| API contracts | partial | API contract doc added in this pass | Generate/maintain OpenAPI 3.1 with contract tests. |

## Items That Cannot Honestly Be Completed Purely In Code Today

### HTTPS/TLS Certification And Rotation

What it is: Certificate issuance, HTTPS redirect, HSTS behavior, and renewal for the production domain.

Why we need it: Auth cookies and API traffic depend on transport security. HSTS only helps after a browser receives it over HTTPS.

How to do it:

1. Configure Railway/custom domain TLS for the real Trent domain.
2. Verify HTTPS redirect and HSTS with a production smoke script.
3. Add certificate expiry monitoring.
4. Document emergency certificate reissue steps.

### Data Retention, Deletion, And Regulatory Compliance

What it is: Product/legal policy for how long Trent keeps company data, audit logs, memories, uploads, artifacts, backups, and provider payloads.

Why we need it: PII/customer data handling cannot be improvised after customers arrive.

How to do it:

1. Define retention periods by data class.
2. Define deletion and export SLAs.
3. Define legal hold exceptions.
4. Implement scheduled deletion jobs and backup purge behavior.
5. Map evidence to SOC 2/GDPR if those are the first target frameworks.

### Load, Stress, And Chaos Testing

What it is: Controlled staging tests that push traffic, worker queues, DB connections, Redis, and provider failure modes.

Why we need it: These tests can create provider spend, data churn, and staging outages. They need a dedicated environment and limits.

How to do it:

1. Add k6 or Artillery scripts.
2. Run against staging, not production.
3. Test common journeys: sign-in, run cycle, SSE fallback, approvals, Workbench file ops, provider proofs.
4. Add chaos drills: Redis down, DB unavailable, worker crash, provider 5xx, sandbox quota exhausted.
5. Store results in the proof dashboard.

### RTO, RPO, And Disaster Recovery

What it is: Business commitments and runbooks for downtime, acceptable data loss, and restore procedures.

Why we need it: Without tested recovery targets, the app can be "healthy" until the first real outage.

How to do it:

1. Set RTO/RPO targets by service and data class.
2. Confirm backup schedule and encryption.
3. Rehearse restore into staging.
4. Test worker/Redis/DB recovery.
5. Record drill results and update the DR runbook.

### Branch Protection And Code Review Standards

What it is: GitHub repository settings that require review and passing checks before merging.

Why we need it: `CODEOWNERS` is not enough unless branch protection enforces it.

How to do it:

1. Require pull requests for `main`.
2. Require CODEOWNERS approval.
3. Require typecheck, test, ci truth, security preflight, and build checks.
4. Block force pushes.
5. Require signed commits later if needed.

## Recommended Next Engineering Slices

1. Add route inventory tests for authz and Zod validation coverage.
2. Add explicit Auth.js session maxAge/updateAge and expired-token tests.
3. Add API error envelope helper and migrate high-value routes first.
4. Add idempotency keys for email, CRM, social, deploy, and approval resume.
5. Add provider circuit breaker state and surface it in connectors/proof dashboards.
6. Add axe/WCAG Playwright smoke tests.
7. Add OpenAPI 3.1 generation or hand-authored spec plus contract tests.

## Verification Commands

Run these before merging:

```bash
npm run security:deps
npm run security:readiness
npx vitest run lib/readiness-controls.test.ts next-config-security.test.ts --pool=forks --poolOptions.forks.singleFork=true
npm run typecheck
npm run build
```
