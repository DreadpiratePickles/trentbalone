# Access Control Policy

**Version:** 1.0  
**Effective:** 2026-05-28  
**Owner:** CEO / founding team  
**Review cadence:** Annually, or after any access-related incident

---

## 1. Purpose

Define how access to Trent systems and customer data is provisioned, reviewed, and revoked to enforce least privilege.

## 2. Roles (application RBAC)

| Role | Permissions |
|---|---|
| **owner** | Full access — all reads, writes, deletes, member management |
| **admin** | All owner permissions except delete company and remove owner |
| **member** | Read/write tasks, cycles, approvals; cannot manage members |
| **viewer** | Read-only across all company resources |

Roles are enforced at every API route via `lib/rbac.ts` → `requireRole()` in `lib/session.ts`.

## 3. Provisioning

- Users join a company via invite (email link). The inviting user must hold at minimum the `admin` role.
- New accounts default to `viewer` role unless explicitly elevated.
- Service accounts (agent execution) do not receive a `CompanyMember` row — they operate under the company's context with no additional user privileges.

## 4. Production infrastructure access

| System | Who has access | Auth method |
|---|---|---|
| Supabase (DB) | Founding team only | Email + MFA, project-scoped API keys |
| Vercel (hosting) | Founding team only | Email + MFA |
| GitHub (code) | All contributors | SSH key or Personal Access Token with limited scope |
| Redis | App server only via `REDIS_URL` env var | Network-level isolation |
| OpenAI / Anthropic | App server only via env var | API key, never exposed to browser |

## 5. MFA requirement

MFA is mandatory for:
- All Supabase project members
- All Vercel team members
- All GitHub organization members with push access

## 6. Access review

Access is reviewed at minimum quarterly. The review checklist:
- [ ] All Supabase members are current employees / contractors
- [ ] All Vercel team members are current
- [ ] GitHub organization members list is clean
- [ ] No stale API keys in use (rotate if > 90 days old)

## 7. Offboarding

Within 24 hours of any team member departure:
- Remove from Supabase project
- Remove from Vercel team
- Remove from GitHub organization
- Rotate any shared credentials they had access to
- Revoke any personal API keys issued to them

## 8. Privileged access

Any direct database access (psql, Supabase SQL editor) must be:
- Logged to the audit log if modifying production data
- Paired with a pull request or incident ticket explaining why
- Reviewed by a second team member if changing schema
