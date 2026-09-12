# SOC 2 Evidence Checklist

**Purpose:** Track what evidence needs to be collected, by whom, and on what cadence to support a SOC 2 Type I (and eventually Type II) audit.

> **Status:** Pre-observation window. Start collecting evidence now so it's ready when the compliance platform (Vanta/Drata) starts its observation window.

## How to use this checklist

- **Before audit:** Run through all items and mark status.
- **During observation window:** Collect samples on the cadences listed.
- **Before audit engagement:** All items should be ✅ Ready.

---

## Access Control Evidence

| Evidence item | Owner | Cadence | Current status |
|---|---|---|---|
| User access list (all production systems) | CEO | Quarterly | ⚠️ Not yet formally documented |
| MFA enforcement proof (screenshot of Supabase/Vercel/GitHub MFA settings) | CEO | Quarterly | ⚠️ Collect screenshot |
| Access review completion record | CEO | Quarterly | ⚠️ Not started |
| Offboarding checklist (completed example) | CEO | Per event | ⚠️ Template exists in access-control-policy.md — no completed example yet |
| CompanyMember RBAC enforcement — test results | Engineering | Each release | ✅ Vitest output from `npm test` |

## Change Management Evidence

| Evidence item | Owner | Cadence | Current status |
|---|---|---|---|
| PR review history (sample: last 10 PRs show ≥ 1 reviewer) | Engineering | Quarterly sample | ✅ GitHub PR history |
| CI pass logs (tsc + test + gitleaks on last 10 merges) | Engineering | Quarterly sample | ✅ GitHub Actions logs |
| Branch protection settings screenshot | Engineering | Quarterly | ⚠️ Collect screenshot |
| Deployment log (what was deployed, when, by whom) | Engineering | Quarterly | ⚠️ Vercel deployment history |

## Backup and Recovery Evidence

| Evidence item | Owner | Cadence | Current status |
|---|---|---|---|
| Backup creation logs (pg-backup.sh output) | Engineering | Weekly | ⚠️ Need to start saving logs to `docs/security/evidence/backup-logs/` |
| Restore drill results (pg-restore-drill.sh output) | Engineering | Weekly | ⚠️ Need to start saving results to `docs/security/evidence/restore-drills/` |
| Backup health endpoint response (`GET /api/health`) | Engineering | Weekly | ⚠️ Save snapshots |
| Supabase PITR enabled screenshot | Engineering | Once, then annually | ⚠️ Collect screenshot |
| RTO/RPO documented | Engineering | Once | ✅ `scripts/backup/README.md` |

## Incident Response Evidence

| Evidence item | Owner | Cadence | Current status |
|---|---|---|---|
| Incident response policy acknowledgment | CEO | Annually | ⚠️ Not yet collected |
| Post-mortem examples (or "no incidents" log) | Engineering | Per incident / quarterly | ⚠️ No incidents yet — log "no incidents" quarterly |
| On-call rotation documentation | CEO | Quarterly | ⚠️ Informal currently — document |

## Vendor Management Evidence

| Evidence item | Owner | Cadence | Current status |
|---|---|---|---|
| Vendor list reviewed and signed off | CEO | Annually | ⚠️ Vendor list written (this session) — needs CEO sign-off |
| DPA copies for each sub-processor | CEO | Per vendor / annually | ⚠️ Supabase and Vercel DPAs not yet explicitly signed |
| SOC 2 cert copies for each sub-processor | CEO | Annually | ⚠️ Not yet collected |

## Policy Evidence

| Evidence item | Owner | Cadence | Current status |
|---|---|---|---|
| All 7 policy docs published in repo | Engineering | Once, then annual review | ✅ Created this session |
| Policy acknowledgment from all team members | CEO | At onboarding + annually | ⚠️ Not yet collected |
| Policy review dates logged | CEO | Annually | ⚠️ Not started |

## Risk Assessment Evidence

| Evidence item | Owner | Cadence | Current status |
|---|---|---|---|
| Risk register with identified risks, likelihood, impact, owner | CEO | Annually | ⚠️ Not yet formal |
| Last risk assessment date | CEO | Annually | ⚠️ None yet |

---

## Evidence directory structure

Store collected evidence artifacts here:
```
docs/security/evidence/
  backup-logs/          — pg-backup.sh output files
  restore-drills/       — pg-restore-drill.sh output files
  screenshots/          — MFA settings, branch protection, Supabase PITR
  vendor-certs/         — SOC 2 cert PDFs from each sub-processor
  policy-acknowledgments/ — Email/signed records from team members
  access-reviews/       — Quarterly access review completion records
  incident-log.md       — Running log of all incidents (or "no incidents")
```
