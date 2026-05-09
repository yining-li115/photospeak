#!/usr/bin/env bash
#
# pg_dump the PhotoSpeak database to a local timestamped file, prune
# anything older than the retention window. Designed for a small LAS
# where adding a separate Aliyun RDS / 云数据库 isn't worth it yet —
# this is the cheapest "we won't lose everything if the disk dies"
# safety net.
#
# Setup:
#   1. Pick a backup directory (default: /var/backups/photospeak).
#      Owner must be writable by whichever user runs the cron.
#         sudo mkdir -p /var/backups/photospeak
#         sudo chown $USER /var/backups/photospeak
#
#   2. Make sure DATABASE_URL is in this script's env. The simplest
#      setup is to source the backend's .env from the cron line:
#         0 4 * * * cd /opt/photospeak/backend && \
#           set -a && source .env && set +a && \
#           ./scripts/backup.sh >> /var/log/photospeak-backup.log 2>&1
#
#   3. Verify a manual run before installing the cron:
#         set -a && source .env && set +a && ./scripts/backup.sh
#
# What it does:
#   - pg_dump -Fc → custom format (smaller, faster restore)
#   - gzip → ~5x compression on top
#   - Drops files older than RETENTION_DAYS (default 7)
#
# What it does NOT do (yet):
#   - Upload off-host. The dump file is on the same disk as the DB —
#     if the LAS itself is wiped, you're still toast. Once OSS access
#     is set up (P3 / P12), add an `ossutil cp` line after the dump
#     so a copy lands on Aliyun OSS too. Until then this only protects
#     against accidental DROP TABLE / migration mistakes, not full
#     hardware loss.
#
# Restore:
#   gunzip -c /var/backups/photospeak/photospeak-YYYYMMDD-HHMMSS.dump.gz \
#     | pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL"

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/photospeak}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Source backend/.env first." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/photospeak-$TIMESTAMP.dump.gz"

echo "→ dumping to $OUT"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | gzip > "$OUT"

# Verify the dump isn't empty (pg_dump returns 0 even on some failures
# if the schema is empty; guard explicitly).
if [[ ! -s "$OUT" ]]; then
  echo "✗ dump file is empty, removing" >&2
  rm -f "$OUT"
  exit 1
fi

# Prune old dumps. -mtime +N matches files modified more than N days ago.
deleted=$(find "$BACKUP_DIR" -name 'photospeak-*.dump.gz' -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
if [[ "$deleted" != "0" ]]; then
  echo "→ pruned $deleted dump(s) older than $RETENTION_DAYS days"
fi

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ backup ok ($SIZE)"
