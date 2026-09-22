#!/usr/bin/env bash
# Download one private OSS backup and prove it can be read. When a dedicated,
# disposable PostgreSQL URL is supplied, also perform a real clean restore.
# Never point RESTORE_DRILL_DATABASE_URL at staging or production.

set -euo pipefail
umask 077

BACKUP_OBJECT_URI="${BACKUP_OBJECT_URI:-}"
RESTORE_DRILL_DATABASE_URL="${RESTORE_DRILL_DATABASE_URL:-}"
RESTORE_DRILL_CONFIRM_EMPTY_DATABASE="${RESTORE_DRILL_CONFIRM_EMPTY_DATABASE:-}"

if [[ "$BACKUP_OBJECT_URI" != oss://* ]]; then
  echo "BACKUP_OBJECT_URI must name one oss:// object" >&2
  exit 1
fi
if ! command -v ossutil >/dev/null 2>&1; then
  echo "ossutil is required" >&2
  exit 1
fi

DRILL_DIR=$(mktemp -d)
ARCHIVE="$DRILL_DIR/backup.dump.gz"
cleanup() {
  rm -rf "$DRILL_DIR"
}
trap cleanup EXIT

ossutil cp "$BACKUP_OBJECT_URI" "$ARCHIVE"
gzip --test "$ARCHIVE"
gzip --decompress --stdout "$ARCHIVE" | pg_restore --list >/dev/null
echo "✓ downloaded archive is structurally readable"

if [[ -n "$RESTORE_DRILL_DATABASE_URL" ]]; then
  if [[ "$RESTORE_DRILL_CONFIRM_EMPTY_DATABASE" != "YES" ]]; then
    echo "Set RESTORE_DRILL_CONFIRM_EMPTY_DATABASE=YES only for a disposable empty database" >&2
    exit 1
  fi
  gzip --decompress --stdout "$ARCHIVE" | pg_restore \
    --clean --if-exists --no-owner --no-privileges \
    --dbname "$RESTORE_DRILL_DATABASE_URL"
  psql "$RESTORE_DRILL_DATABASE_URL" \
    --no-psqlrc --set ON_ERROR_STOP=1 \
    --command 'SELECT current_database(), count(*) AS table_count FROM pg_catalog.pg_tables WHERE schemaname = '\''public'\'';'
  echo "✓ disposable database restore completed"
else
  echo "⚠ structural drill only; set a disposable RESTORE_DRILL_DATABASE_URL for a full restore"
fi
