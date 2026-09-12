# SOC 2 Controls Mapping — Trent AI Cofounder OS

**Type:** Trust Services Criteria (TSC) — Security (CC1–CC9)  
**Date:** 2026-05-28  
**Status:** Type I preparation. Observation window not yet started.

---

## How to read this document

Each row maps a SOC 2 control to:
- **Trent control** — what we have implemented
- **Evidence** — what artifact proves the control is active
- **Status** — ✅ Implemented / ⚠️ Partial / ❌ Not yet

---

## CC1 — Control Environment

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC1.1 | Management demonstrates commitment to integrity and ethical values | CEO-approved policies (InfoSec, Acceptable Use) | Policy docs in `docs/security/policies/` | ✅ |
| CC1.2 | Board / management exercises oversight | Founder/CEO reviews all commits via PR process | GitHub PR history | ✅ |
| CC1.3 | Org structure, reporting lines, and authorities defined | Founding team documented; roles in CODEOWNERS | `CODEOWNERS`, org chart (TBD when team > 2) | ⚠️ |
| CC1.4 | Commitment to attract, develop, and retain competent people | Hiring documentation; background checks (when applicable) | Offer letters; HR docs (TBD) | ⚠️ |
| CC1.5 | Accountability for control responsibilities enforced | Policy acknowledgment required before production access | Email acknowledgment records | ⚠️ |

---

## CC2 — Communication and Information

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC2.1 | Uses relevant quality information to support controls | Audit logs, Sentry errors, health endpoint | `app/api/health`, `app/api/audit`, Sentry project | ✅ |
| CC2.2 | Communicates internally about objectives and responsibilities | Policies distributed to all team members | Policy docs + acknowledgment records | ⚠️ |
| CC2.3 | Communicates externally about commitments and privacy | Privacy policy, SECURITY.md, trust page | `SECURITY.md`, `/trust` page | ⚠️ |

---

## CC3 — Risk Assessment

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC3.1 | Specifies objectives clearly enough to identify risks | Architecture documented; risk areas identified in InfoSec policy | `docs/security/policies/information-security-policy.md` | ✅ |
| CC3.2 | Identifies and analyzes risks to achieving objectives | Risk areas: data breach, model prompt injection, vendor failure, outage | `audit-readiness.md` risk log | ⚠️ |
| CC3.3 | Considers potential for fraud | Access controls, audit log, tamper-evident chain | `lib/rbac.ts`, audit log SHA-256 chain | ✅ |
| CC3.4 | Identifies and assesses changes that could impact ICFR | Change management policy; PR review gates | `change-management-policy.md`, GitHub branch protection | ✅ |

---

## CC4 — Monitoring Activities

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC4.1 | Selects, develops, and performs ongoing evaluations | Health endpoint, Sentry, backup health check | `GET /api/health`, Sentry dashboard | ✅ |
| CC4.2 | Evaluates and communicates deficiencies | Post-mortem process; incident Slack channel | `incident-response-policy.md`, post-mortem docs | ⚠️ |

---

## CC5 — Control Activities

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC5.1 | Selects and develops controls to mitigate risks | RBAC, encryption, rate limiting, audit log | Implementation in `lib/` | ✅ |
| CC5.2 | Selects and develops general controls over technology | CI gates (tsc, test, gitleaks), branch protection | `.github/` CI config, gitleaks config | ✅ |
| CC5.3 | Deploys controls through policies and procedures | Policies written and distributed | `docs/security/policies/` | ✅ |

---

## CC6 — Logical and Physical Access

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC6.1 | Implements logical access security measures | RBAC enforced at every API route; MFA on infra | `lib/rbac.ts`, `requireRole()`, MFA policy | ✅ |
| CC6.2 | Authenticates prior to access | NextAuth session required for all authenticated routes; middleware enforced | `middleware.ts`, `app/api/auth/` | ✅ |
| CC6.3 | Considers network segmentation | Postgres accessible only via Supabase pooler (app) or direct URL (migrations); Redis not exposed | Supabase network rules; `.env.example` | ✅ |
| CC6.4 | Manages points of access | Vercel edge handles TLS termination; no direct infra exposed | Vercel config | ✅ |
| CC6.5 | Identifies and authenticates with infrastructure services | API keys stored in env vars, never in code | Secret scanning + `.gitignore` | ✅ |
| CC6.6 | Restricts access to confidential information | Credential vault (AES-256-GCM); agent handles only, no plaintext to LLM | `lib/crypto.ts`, `lib/credential-vault.ts` | ✅ |
| CC6.7 | Restricts access by unauthorized users externally | Rate limiting per IP/user/company; abuse protection | `lib/rate-limit.ts` | ✅ |
| CC6.8 | Prevents unauthorized access to physical assets | Hosted on Supabase/Vercel; no owned physical hardware | Vendor SOC 2 certs (Supabase, Vercel) | ✅ |

---

## CC7 — System Operations

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC7.1 | Uses detection and monitoring procedures | Sentry, structured logs, health endpoint | Sentry project, `GET /api/health` | ✅ |
| CC7.2 | Monitors system capacity and performance | Health endpoint includes DB connectivity; metrics tracked | `GET /api/health` | ⚠️ |
| CC7.3 | Evaluates security events | Audit log with tamper-evident chain; Sentry error grouping | `store.addAudit()`, SHA-256 chain | ✅ |
| CC7.4 | Responds to security incidents | Incident response policy with severity matrix and response playbooks | `incident-response-policy.md` | ✅ |
| CC7.5 | Identifies and develops recovery from security incidents | Backup + restore drill; BCP policy | `scripts/backup/`, `business-continuity-policy.md` | ✅ |

---

## CC8 — Change Management

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC8.1 | Authorizes, designs, tests, and approves changes prior to implementation | PR-based code review; CI gates; deploy via Vercel (auto from main) | GitHub PR history, CI config | ✅ |

---

## CC9 — Risk Mitigation

| Criteria | Requirement summary | Trent control | Evidence | Status |
|---|---|---|---|---|
| CC9.1 | Identifies and assesses risk of vendor/business partner misuse | Vendor management policy; DPA required before data sharing | `vendor-management-policy.md`, `vendor-list.md` | ✅ |
| CC9.2 | Monitors vendor compliance | Annual vendor review; SOC 2 cert validation | `vendor-list.md` review cadence | ⚠️ |

---

## Summary

| Status | Count |
|---|---|
| ✅ Implemented | 22 |
| ⚠️ Partial | 9 |
| ❌ Not yet | 0 |

See `audit-readiness.md` for the remediation plan for all ⚠️ items.
