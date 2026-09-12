# Information Security Policy

**Version:** 1.0  
**Effective:** 2026-05-28  
**Owner:** CEO / founding team  
**Review cadence:** Annually, or after any material security event

---

## 1. Purpose and scope

This policy establishes Trent's commitment to protecting the confidentiality, integrity, and availability of all information assets — including customer data, AI model inputs/outputs, and internal systems — and applies to all employees, contractors, and service accounts with access to Trent systems.

## 2. Information classification

| Class | Definition | Examples | Required controls |
|---|---|---|---|
| **Confidential** | Customer data, credentials, PII, API keys | Prompt inputs, outputs, company records, user email | Encrypted at rest (AES-256) and in transit (TLS 1.2+); access logged; no export without approval |
| **Internal** | Operational data not intended for public | Logs, metrics, internal docs | Access restricted to team members; not posted publicly |
| **Public** | Marketing copy, open-source code | Landing page, GitHub public repo | No special controls required |

## 3. Data handling rules

- All customer data is stored encrypted at rest using AES-256-GCM (see credential vault implementation in `lib/crypto.ts`).
- All data in transit is protected with TLS 1.2 or higher enforced at the Vercel/Cloudflare edge.
- Credentials and secrets are stored via the credential vault (`lib/credential-vault.ts`) — never in plaintext in the database or logs.
- Agent context windows never contain raw credential values — only handle references (e.g. `[github:cred]`).
- Backups are encrypted with AES-256-CBC (`scripts/backup/pg-backup.sh`).

## 4. Access control

- Access to production systems follows least-privilege principles. See `access-control-policy.md` for full detail.
- RBAC is enforced at every API route (owner / admin / member / viewer roles).
- Admin access to Supabase, Vercel, and other production services requires MFA.
- Access is reviewed quarterly. Former employees' access is revoked within 24 hours of offboarding.

## 5. Acceptable use

All personnel must read and agree to the `acceptable-use-policy.md` before accessing Trent production systems.

## 6. Incident response

Security incidents are handled per `incident-response-policy.md`. Any suspected breach must be reported to the security owner within 1 hour of discovery.

## 7. Risk management

- Risk assessments are conducted at least annually and after major architectural changes.
- Identified risks are tracked in this repository under `docs/security/` with owner and target resolution date.

## 8. Enforcement

Violations of this policy may result in disciplinary action up to and including termination or contract cancellation.

## 9. Exceptions

Exceptions to this policy require written approval from the CEO and must be documented with a compensating control and expiry date.
