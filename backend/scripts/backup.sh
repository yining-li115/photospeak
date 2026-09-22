#!/usr/bin/env bash
#
# Create an atomic PostgreSQL backup, validate that pg_restore can read it,
# upload a private SSE-KMS encrypted copy to an off-host OSS bucket, verify the
# remote object, then prune old local copies. Production fails closed when the
# off-host destination is missing or upload verification fails.
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
# Required production configuration:
#   BACKUP_OFFSITE_URI=oss://private-bucket/photospeak/postgres
#   ossutil configured with a least-privilege RAM role/profile
# Optional:
#   BACKUP_FAILURE_WEBHOOK_URL=https://...  (alert receiver)
#   BACKUP_REQUIRE_OFFSITE=0               (local development only)
#
# What it does:
#   - pg_dump -Fc → custom format (smaller, faster restore)
#   - gzip → ~5x compression on top
#   - verifies gzip and pg_restore archive structure
#   - uploads with private ACL + OSS SSE-KMS and verifies with `ossutil stat`
#   - drops local files older than RETENTION_DAYS (default 7)
# Remote retention/versioning must be enforced with an OSS lifecycle policy.
#
# Restore:
#   gunzip -c /var/backups/photospeak/photospeak-YYYYMMDD-HHMMSS.dump.gz \
#     | pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL"

set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/var/backups/photospeak}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
BACKUP_REQUIRE_OFFSITE="${BACKUP_REQUIRE_OFFSITE:-1}"
BACKUP_OFFSITE_URI="${BACKUP_OFFSITE_URI:-}"
BACKUP_FAILURE_WEBHOOK_URL="${BACKUP_FAILURE_WEBHOOK_URL:-}"

PARTIAL=""

if [[ ! "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "RETENTION_DAYS must be a positive integer" >&2
  exit 1
fi
if [[ "$BACKUP_REQUIRE_OFFSITE" != "0" && "$BACKUP_REQUIRE_OFFSITE" != "1" ]]; then
  echo "BACKUP_REQUIRE_OFFSITE must be 0 or 1" >&2
  exit 1
fi
if [[ -n "$BACKUP_FAILURE_WEBHOOK_URL" && "$BACKUP_FAILURE_WEBHOOK_URL" != https://* ]]; then
  echo "BACKUP_FAILURE_WEBHOOK_URL must use https://" >&2
  exit 1
fi
case "$BACKUP_DIR" in
  /|/var|/var/backups|/home|/Users|"${HOME:-/nonexistent}")
    echo "BACKUP_DIR is too broad; use a dedicated PhotoSpeak directory" >&2
    exit 1
    ;;
esac

notify_failure() {
  if [[ -n "$BACKUP_FAILURE_WEBHOOK_URL" ]]; then
    curl --fail --silent --show-error --max-time 10 \
      -H 'Content-Type: application/json' \
      --data '{"text":"PhotoSpeak PostgreSQL backup failed; inspect the backup job logs."}' \
      "$BACKUP_FAILURE_WEBHOOK_URL" >/dev/null || true
  fi
}

cleanup() {
  status=$?
  if [[ -n "$PARTIAL" ]]; then
    rm -f "$PARTIAL"
  fi
  if [[ "$status" -ne 0 ]]; then
    notify_failure
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Source backend/.env first." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/photospeak-$TIMESTAMP.dump.gz"
PARTIAL="$OUT.partial.$$"

echo "→ dumping to $OUT"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | gzip > "$PARTIAL"
chmod 600 "$PARTIAL"

# Verify the dump isn't empty (pg_dump returns 0 even on some failures
# if the schema is empty; guard explicitly).
if [[ ! -s "$PARTIAL" ]]; then
  echo "✗ dump file is empty, removing" >&2
  exit 1
fi

mv "$PARTIAL" "$OUT"
PARTIAL=""

echo "→ validating local archive"
gzip --test "$OUT"
gzip --decompress --stdout "$OUT" | pg_restore --list >/dev/null

if [[ -n "$BACKUP_OFFSITE_URI" ]]; then
  if [[ "$BACKUP_OFFSITE_URI" != oss://* ]]; then
    echo "BACKUP_OFFSITE_URI must start with oss://" >&2
    exit 1
  fi
  if ! command -v ossutil >/dev/null 2>&1; then
    echo "ossutil is required for off-host backups" >&2
    exit 1
  fi
  REMOTE_OBJECT="${BACKUP_OFFSITE_URI%/}/$(basename "$OUT")"
  echo "→ uploading encrypted off-host backup"
  ossutil cp "$OUT" "$REMOTE_OBJECT" \
    --acl private \
    --meta=x-oss-server-side-encryption:KMS
  ossutil stat "$REMOTE_OBJECT" >/dev/null
  echo "✓ off-host backup verified"
elif [[ "$BACKUP_REQUIRE_OFFSITE" == "1" ]]; then
  echo "BACKUP_OFFSITE_URI is required when BACKUP_REQUIRE_OFFSITE=1" >&2
  exit 1
else
  echo "⚠ off-host backup explicitly disabled; this run protects logical errors only" >&2
fi

# Prune old dumps. -mtime +N matches files modified more than N days ago.
deleted=$(find "$BACKUP_DIR" -name 'photospeak-*.dump.gz' -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
if [[ "$deleted" != "0" ]]; then
  echo "→ pruned $deleted dump(s) older than $RETENTION_DAYS days"
fi

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ backup ok ($SIZE)"
