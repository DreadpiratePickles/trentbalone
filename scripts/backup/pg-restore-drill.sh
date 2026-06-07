#!/usr/bin/env bash
# scripts/backup/pg-restore-drill.sh
#
# Decrypts the latest backup, restores into a throw-away DB,
# runs a smoke test (row count on public tables > 0 or schema present),
# then drops the drill DB.
#
# Usage:
#   BACKUP_DIR=/var/backups/trent \
#   BACKUP_PASSPHRASE=<same secret used at backup time> \
#   DIRECT_URL=postgresql://user:pass@host:5432/postgres \
#   ./scripts/backup/pg-restore-drill.sh
#
# Exit codes:
#   0 — restore drill passed
#   1 — any failure (decrypt, restore, smoke test)
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR must be set}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE must be set}"
DIRECT_URL="${DIRECT_URL:?DIRECT_URL must be set}"
DRILL_DB="trent_restore_drill_$$"

# Parse base URL (strip /dbname) to connect to postgres maintenance DB
BASE_URL=$(echo "${DIRECT_URL}" | sed 's|/[^/]*$|/postgres|')

ENC_FILE=$(cat "${BACKUP_DIR}/latest.path" 2>/dev/null || ls -t "${BACKUP_DIR}"/*.dump.enc 2>/dev/null | head -1)
if [[ -z "${ENC_FILE}" || ! -f "${ENC_FILE}" ]]; then
  echo "[restore-drill] ERROR: no encrypted dump found in ${BACKUP_DIR}" >&2
  exit 1
fi

echo "[restore-drill] Using backup: ${ENC_FILE}"

DUMP_FILE=$(mktemp /tmp/trent-drill-XXXXXX.dump)
trap "rm -f '${DUMP_FILE}'; psql '${BASE_URL}' -c \"DROP DATABASE IF EXISTS ${DRILL_DB};\" 2>/dev/null || true" EXIT INT TERM

echo "[restore-drill] Decrypting..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -in  "${ENC_FILE}" \
  -out "${DUMP_FILE}" \
  -pass env:BACKUP_PASSPHRASE

echo "[restore-drill] Creating drill database ${DRILL_DB}..."
psql "${BASE_URL}" -c "CREATE DATABASE ${DRILL_DB};"

DRILL_URL=$(echo "${DIRECT_URL}" | sed "s|/[^/]*$|/${DRILL_DB}|")

echo "[restore-drill] Restoring into ${DRILL_DB}..."
pg_restore --no-owner --no-acl -d "${DRILL_URL}" "${DUMP_FILE}"

echo "[restore-drill] Running smoke test (table count)..."
TABLE_COUNT=$(psql "${DRILL_URL}" -t -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" | tr -d ' ')

if [[ "${TABLE_COUNT}" -lt 1 ]]; then
  echo "[restore-drill] FAIL: no tables found in restored DB (got ${TABLE_COUNT})" >&2
  exit 1
fi

echo "[restore-drill] PASS: ${TABLE_COUNT} public tables present in restored DB."
echo "[restore-drill] Restore drill succeeded at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
