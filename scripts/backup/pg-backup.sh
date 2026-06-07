#!/usr/bin/env bash
# scripts/backup/pg-backup.sh
#
# Usage:
#   BACKUP_DIR=/var/backups/trent \
#   BACKUP_PASSPHRASE=<secret> \
#   DATABASE_URL=postgresql://... \
#   ./scripts/backup/pg-backup.sh
#
# Output:
#   $BACKUP_DIR/trent-<timestamp>.dump.enc  — AES-256-CBC encrypted pg_dump (custom format)
#   $BACKUP_DIR/latest.sha256              — SHA-256 of the encrypted file
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR must be set}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE must be set}"
DATABASE_URL="${DIRECT_URL:-${DATABASE_URL:?DATABASE_URL or DIRECT_URL must be set}}"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
DUMP_FILE="${BACKUP_DIR}/trent-${TIMESTAMP}.dump"
ENC_FILE="${DUMP_FILE}.enc"
trap "rm -f '${DUMP_FILE}'" EXIT

umask 077
mkdir -p "${BACKUP_DIR}"

echo "[backup] Starting pg_dump at ${TIMESTAMP}..."
pg_dump --format=custom --no-password "${DATABASE_URL}" > "${DUMP_FILE}"

echo "[backup] Encrypting dump..."
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
  -in  "${DUMP_FILE}" \
  -out "${ENC_FILE}" \
  -pass env:BACKUP_PASSPHRASE

rm -f "${DUMP_FILE}"

# Cross-platform SHA-256
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${ENC_FILE}" | awk '{print $1}'
else
  shasum -a 256 "${ENC_FILE}" | awk '{print $1}'
fi > "${BACKUP_DIR}/latest.sha256"

# Also record the filename so restore script can find it
echo "${ENC_FILE}" > "${BACKUP_DIR}/latest.path"

SIZE=$(du -sh "${ENC_FILE}" | awk '{print $1}')
echo "[backup] Done. ${ENC_FILE} (${SIZE})"
echo "[backup] SHA-256: $(cat "${BACKUP_DIR}/latest.sha256")"
