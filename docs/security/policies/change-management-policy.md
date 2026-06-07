# Change Management Policy

**Version:** 1.0  
**Effective:** 2026-05-28  
**Owner:** CEO / founding team  
**Review cadence:** Annually

---

## 1. Purpose

Ensure all code and configuration changes to Trent are reviewed, tested, and deployed in a controlled manner to minimize risk of service disruption or security regression.

## 2. Code change process

All changes to the codebase follow this process:

1. **Feature branch** — work happens in a feature or fix branch, never directly on `main`.
2. **Pull request (PR)** — PR opened against `main` with description of what changed and why.
3. **Automated checks** — CI must pass:
   - `npx tsc --noEmit` (TypeScript strict mode)
   - `npm test` (all Vitest tests)
   - Secret scanning (gitleaks pre-commit hook + CI scan)
4. **Code review** — at least one other team member approves before merge.
5. **Merge** — squash-merge to keep history clean.
6. **Deploy** — Vercel auto-deploys `main` to production. Preview deploys are created for every PR.

## 3. Emergency changes (hotfixes)

In the event of a critical production outage:
- The on-call engineer may merge a hotfix with a single reviewer (async review acceptable).
- A post-mortem must be filed within 48 hours explaining the change and the review that was skipped.
- The PR is tagged `emergency-hotfix` for audit log purposes.

## 4. Database schema changes

- Schema changes require `npx prisma migrate dev` (dev) and `npx prisma migrate deploy` (production).
- Schema changes must be reviewed in the PR by someone familiar with the data model.
- Destructive migrations (DROP COLUMN, DROP TABLE) require a separate backfill PR first.
- After any schema change: push to BOTH `trent.db` AND `trent-test.db` in development.

## 5. Infrastructure changes

- Changes to Supabase, Vercel, or DNS configuration must be documented in a PR or GitHub issue before being made.
- Changes are made by at most two people (one executes, one reviews).

## 6. Secrets rotation

- Secrets (API keys, encryption keys) are rotated:
  - At least every 90 days for all production API keys
  - Immediately upon suspected compromise
  - When a team member with access departs
- Rotation is logged in the audit log.

## 7. Prohibited practices

- No direct commits to `main` (protected branch).
- No hardcoded secrets in code (enforced by gitleaks).
- No production DB changes without an associated issue or PR.
