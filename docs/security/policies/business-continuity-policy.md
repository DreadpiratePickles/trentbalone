# Business Continuity and Disaster Recovery Policy

**Version:** 1.0  
**Effective:** 2026-05-28  
**Owner:** CEO / founding team  
**Review cadence:** Annually, or after any restore event

---

## 1. Purpose

Ensure Trent can recover from infrastructure failures, data loss, or service disruptions within defined RTO/RPO targets.

## 2. RTO / RPO targets

| Target | Value | Justification |
|---|---|---|
| **RPO** (max acceptable data loss) | 24 hours | Daily encrypted pg_dump + Supabase PITR (5-min granularity) |
| **RTO** (time to restore service) | < 2 hours | Restore drill script pre-validates the path; runbook documented |

## 3. Backup strategy

### Logical backups
- Tool: `scripts/backup/pg-backup.sh`
- Frequency: Daily at 02:00 UTC (cron)
- Encryption: AES-256-CBC with `BACKUP_PASSPHRASE` from secret manager
- Storage: Local `BACKUP_DIR` (Phase 0); off-site to Cloudflare R2 deferred to Phase 1
- Retention: 7 daily backups (older deleted automatically)
- Verification: SHA-256 checksum written alongside each backup

### Point-in-time recovery (PITR)
- Provided by Supabase — enabled in Supabase Dashboard → Project Settings → Database → PITR
- Granularity: 5-minute intervals
- Retention: 7 days (Supabase default on Pro plan)
- Recovery: Via Supabase support or dashboard restore flow

## 4. Restore drill

A restore drill verifies that backups are actually restorable:

- **Tool:** `scripts/backup/pg-restore-drill.sh`
- **Frequency:** Weekly (Sunday 03:00 UTC cron)
- **Process:** Decrypts latest backup → restores to throw-away DB → counts tables → drops DB → exits 0
- **Alerting:** Drill failures page the on-call engineer immediately

## 5. Failure scenarios and responses

| Scenario | Response | Recovery tool |
|---|---|---|
| Supabase DB outage | Wait for Supabase recovery; failover to read replica if available | Supabase status + PITR |
| Accidental data deletion | Restore from PITR (preferred) or latest encrypted backup | pg-restore-drill.sh + Supabase dashboard |
| Corrupt backup | Use previous backup; investigate pg_dump process | `ls -lt $BACKUP_DIR/*.dump.enc` |
| Vercel outage | Traffic temporarily fails; no data loss | Vercel status + re-deploy from git |
| Redis outage | Rate limiting fails-open; job queue pauses | Redis restart; jobs re-enqueue on restart |

## 6. Communication during outage

- Status page updated within 15 minutes of S1/S2 incident declaration
- Customer email notification per `incident-response-policy.md`
- Post-mortem published within 48 hours of resolution

## 7. Runbook location

Full operator runbook for backup and restore: `scripts/backup/README.md`
