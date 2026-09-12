#!/usr/bin/env bash
# scripts/backup/pg-backup-health.sh
#
# Checks that the latest encrypted backup exists and is < MAX_AGE_HOURS old.
# Designed for cron, Uptime Robot, or the Next.js health endpoint.
#
# Usage:
#   BACKUP_DIR=/var/backups/trent \
#   MAX_AGE_HOURS=25 \
#   ./scripts/backup/pg-backup-health.sh
#
# Output (JSON to stdout):
#   {"ok":true,"ageHours":3.2,"path":"/var/backups/trent/trent-20260528T000000Z.dump.enc"}
#   {"ok":false,"error":"no backup found","ageHours":null,"path":null}
#   {"ok":false,"error":"backup is stale","ageHours":27.1,"path":"..."}
#
# Exit codes:
#   0 — backup is healthy
#   1 — no backup or stale backup
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR must be set}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-25}"

ENC_FILE=$(cat "${BACKUP_DIR}/latest.path" 2>/dev/null || ls -t "${BACKUP_DIR}"/*.dump.enc 2>/dev/null | head -1 || true)

if [[ -z "${ENC_FILE}" || ! -f "${ENC_FILE}" ]]; then
  echo '{"ok":false,"error":"no backup found","ageHours":null,"path":null}'
  exit 1
fi

# File modification time in epoch seconds
if stat -c %Y "${ENC_FILE}" >/dev/null 2>&1; then
  # GNU stat (Linux)
  FILE_MTIME=$(stat -c %Y "${ENC_FILE}")
else
  # BSD stat (macOS)
  FILE_MTIME=$(stat -f %m "${ENC_FILE}")
fi

NOW=$(date +%s)
AGE_SECS=$(( NOW - FILE_MTIME ))
AGE_HOURS=$(echo "scale=2; ${AGE_SECS} / 3600" | bc)
MAX_SECS=$(echo "${MAX_AGE_HOURS} * 3600" | bc | cut -d'.' -f1)

if [[ "${AGE_SECS}" -gt "${MAX_SECS}" ]]; then
  echo "{\"ok\":false,\"error\":\"backup is stale\",\"ageHours\":${AGE_HOURS},\"path\":\"${ENC_FILE}\"}"
  exit 1
fi

echo "{\"ok\":true,\"ageHours\":${AGE_HOURS},\"path\":\"${ENC_FILE}\"}"
exit 0
