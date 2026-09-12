# Trent Backup & Disaster Recovery — Operator Runbook

## Overview

Three scripts manage Postgres backup and restore verification. Point-in-time recovery (PITR) is configured in the Supabase dashboard — these scripts complement it with encrypted logical backups and automated restore drills.

## Required environment variables

| Variable | Purpose | Example |
|---|---|---|
| `BACKUP_DIR` | Where encrypted dumps are written | `/var/backups/trent` |
| `BACKUP_PASSPHRASE` | AES-256-CBC passphrase for encryption | 64-char random hex |
| `DIRECT_URL` | Direct Postgres URL (port 5432, not pooler) | `postgresql://...` |
| `BACKUP_MAX_AGE_HOURS` | Staleness threshold for health check | `25` (default) |

Generate a passphrase:
```bash
openssl rand -hex 32
```

Store `BACKUP_PASSPHRASE` as a secret in your secret manager (Supabase Vault, GitHub Actions secret, etc.). **Never commit it.**

## Scripts

### `pg-backup.sh` — Create an encrypted backup

```bash
BACKUP_DIR=/var/backups/trent \
BACKUP_PASSPHRASE=<secret> \
DIRECT_URL=postgresql://user:pass@host:5432/postgres \
./scripts/backup/pg-backup.sh
```

Output:
- `$BACKUP_DIR/trent-<timestamp>.dump.enc` — encrypted pg_dump (custom format)
- `$BACKUP_DIR/latest.sha256` — SHA-256 checksum
- `$BACKUP_DIR/latest.path` — path to latest dump (used by other scripts)

### `pg-restore-drill.sh` — Test that a backup is actually restorable

```bash
BACKUP_DIR=/var/backups/trent \
BACKUP_PASSPHRASE=<secret> \
DIRECT_URL=postgresql://user:pass@host:5432/postgres \
./scripts/backup/pg-restore-drill.sh
```

What it does:
1. Decrypts `latest.path` dump to a temp file
2. Creates a throw-away DB `trent_restore_drill_<pid>`
3. Restores with `pg_restore --no-owner --no-acl`
4. Counts public tables (fails if 0)
5. Drops the drill DB and temp file on exit (even if it crashes)

Exit 0 = drill passed. Exit 1 = investigate immediately.

### `pg-backup-health.sh` — Check backup freshness (cron-safe)

```bash
BACKUP_DIR=/var/backups/trent \
MAX_AGE_HOURS=25 \
./scripts/backup/pg-backup-health.sh
```

JSON output:
```json
{"ok":true,"ageHours":3.2,"path":"/var/backups/trent/trent-20260528T000000Z.dump.enc"}
```

Exit 0 = healthy. Exit 1 = stale or missing.

## Recommended cron schedule

```cron
# Daily backup at 02:00 UTC
0 2 * * * BACKUP_DIR=/var/backups/trent BACKUP_PASSPHRASE=$BACKUP_PASSPHRASE DIRECT_URL=$DIRECT_URL /app/scripts/backup/pg-backup.sh >> /var/log/trent-backup.log 2>&1

# Weekly restore drill on Sundays at 03:00 UTC
0 3 * * 0 BACKUP_DIR=/var/backups/trent BACKUP_PASSPHRASE=$BACKUP_PASSPHRASE DIRECT_URL=$DIRECT_URL /app/scripts/backup/pg-restore-drill.sh >> /var/log/trent-restore-drill.log 2>&1
```

For Supabase: also enable Point-in-Time Recovery (PITR) in the Supabase dashboard (Project Settings → Database → Point-in-Time Recovery). These logical backups supplement PITR; they do not replace it.

## RTO / RPO targets (Phase 0)

| Target | Value | How achieved |
|---|---|---|
| RPO (max data loss) | 24 hours | Daily encrypted logical backup + Supabase PITR (5-min granularity) |
| RTO (time to restore) | < 2 hours | Restore drill script pre-validates path; runbook documented here |

## Retention policy

Keep the last **7 daily backups** locally. For production, sync `$BACKUP_DIR` to an off-site location (S3, GCS, Cloudflare R2 — deferred to Phase 1 when R2 is provisioned).

Manual cleanup (keep last 7):
```bash
ls -t /var/backups/trent/*.dump.enc | tail -n +8 | xargs -r rm
```

## Evidence for SOC 2

- Weekly restore drill logs → `docs/security/evidence/` (copy drill output there)
- `latest.sha256` checksums prove backup integrity
- Health endpoint (`GET /api/health`) reports `backup.ok` — link to monitoring dashboard
