# SOC 2 Type I Audit Readiness Assessment

**Date:** 2026-05-28  
**Prepared by:** Founding team  
**Next review:** Before engaging compliance platform

---

## Overall status: Pre-observation window

We are in the **preparation phase**. An observation window has not started. The recommended next step is to select a compliance platform (Vanta or Drata) and begin the observation window when the first paying customer activates.

> **Key decision:** Per the master task list (`T11.1`), start the compliance platform contract in week 1 of paid customer activation, not month 6. The observation window for Type II requires 6 months of continuous evidence — starting late is the #1 cause of audit delay.

---

## What is done ✅

| Item | Detail |
|---|---|
| RBAC enforcement | All API routes gated by `requireRole()` with owner/admin/member/viewer hierarchy |
| Encrypted secret storage | AES-256-GCM credential vault (`lib/crypto.ts`, `lib/credential-vault.ts`) |
| Audit log | Immutable append-only with SHA-256 tamper-evident chain |
| Rate limiting | Fixed-window per IP/user/company via Redis; fail-open on Redis errors |
| Health + readiness probes | `GET /api/health` with DB + backup freshness check |
| Backup scripts | `pg-backup.sh`, `pg-restore-drill.sh`, `pg-backup-health.sh` with RTO/RPO docs |
| 7 core policies | InfoSec, Access Control, Change Management, IR, Vendor Management, BCP/DR, Acceptable Use |
| Controls mapping | CC1–CC9 mapped to Trent controls with ✅/⚠️ status |
| Vendor list | 9 sub-processors documented with DPA status |
| CI branch protection | gitleaks, tsc, vitest run on all PRs |
| SECURITY.md | Vulnerability disclosure process published |

---

## What is partially done ⚠️ (remediation required before Type I)

| Gap | Required action | Owner | Priority |
|---|---|---|---|
| DPA with Supabase | Sign explicit DPA (not just ToS) | CEO | High |
| DPA with Vercel | Request DPA from legal@vercel.com | CEO | High |
| Policy acknowledgment records | Email all team members, collect written acknowledgment | CEO | High |
| Access review completion | Run first formal quarterly access review; document results | CEO | High |
| MFA screenshots | Screenshot Supabase, Vercel, GitHub MFA settings and save to evidence dir | Engineering | Medium |
| Branch protection screenshot | Save Vercel + GitHub branch protection config screenshots | Engineering | Medium |
| Sentry PII scrubbing | Configure Sentry to scrub user-identifying fields before they leave the client | Engineering | Medium |
| OpenAI zero data retention | Enable via OpenAI org settings (requires API tier upgrade) | CEO | Medium |
| Restore drill logs | Start saving weekly drill output to `docs/security/evidence/restore-drills/` | Engineering | Medium |
| Org chart | Document team structure once > 2 people | CEO | Low |
| Risk register | Write formal risk register with likelihood/impact matrix | CEO | Medium |
| Incident log | Start logging "no incidents" quarterly; document first real incident fully | Engineering | Low |

---

## What is not yet started ❌ (not blocking Type I)

| Item | When to start |
|---|---|
| Compliance platform (Vanta / Drata) | Week 1 of first paying customer |
| Background checks | When first non-founder hire is made |
| Employee training enrollment | When compliance platform selected |
| Annual pen test | Before SOC 2 Type II |
| Bug bounty program | Before SOC 2 Type II |
| SOC 2 Type II observation window | 6 months after Type I report |

---

## Recommended next steps (ordered)

1. **Sign DPAs** with Supabase and Vercel (CEO, < 1 week)
2. **Collect policy acknowledgments** from all team members (CEO, < 1 week)
3. **Run first access review** and document results (CEO + Engineering, < 2 weeks)
4. **Set up evidence collection** — start running weekly backup/drill logs and saving to `docs/security/evidence/` (Engineering, ongoing)
5. **Select compliance platform** — trial Vanta and Drata; sign contract when first paid customer activates (CEO, pre-launch)
6. **Start observation window** — activate compliance platform; evidence auto-collected from this point (CEO, week 1 of paid customer)

---

## Key references

- `controls-mapping.md` — CC1–CC9 mapped to Trent implementation
- `vendor-list.md` — sub-processors with DPA status
- `evidence-checklist.md` — what to collect and where to store it
- `scripts/backup/README.md` — backup + restore runbook
- `trent-master-tasklist.md` T11.1–T11.3 — full SOC 2 task tracking
