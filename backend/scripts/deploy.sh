#!/usr/bin/env bash
#
# PhotoSpeak backend deploy script. Run on the production LAS via SSH:
#
#   cd /opt/photospeak/backend && ./scripts/deploy.sh
#
# What it does, in order:
#   1. Records the current commit (rollback target).
#   2. Tags the new commit before deploying (so you can always
#      `git checkout deploy-<timestamp>` later).
#   3. git pull (fast-forward only, never merges).
#   4. npm ci (lockfile-exact dependencies).
#   5. npm run build — TypeScript compile.
#   6. Stops the old process (short maintenance window; no mixed protocol).
#   7. npm run db:migrate — Drizzle migrations.
#   8. Restarts PM2 with only the new code, then runs smoke-test.sh.
#
# Database migrations are forward-only. Before migration starts, build failures
# can roll code back automatically. After it starts, this script fails closed
# and requires a forward fix; it never starts an auth-incompatible old process
# against the new schema/semantics.
#
# Usage:
#   ./scripts/deploy.sh                      # deploy origin/main
#   ./scripts/deploy.sh --skip-smoke         # skip post-deploy smoke
#   ./scripts/deploy.sh --no-migrate         # skip migrations
#
# Env vars (optional):
#   SMOKE_TEST_TOKEN   passed through to smoke-test.sh
#   PM2_NAME           pm2 process name (default: photospeak-api)

set -euo pipefail

SKIP_SMOKE=0
NO_MIGRATE=0
MIGRATIONS_STARTED=0
SERVICE_STOPPED=0
PM2_NAME="${PM2_NAME:-photospeak-api}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --no-migrate) NO_MIGRATE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve repo root regardless of where the script was invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

cd "$REPO_DIR"

PREV_COMMIT=$(git rev-parse HEAD)
echo "▶ deploy starting"
echo "  · prev commit: $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"

# ─── pull ───────────────────────────────────────────────────────
git fetch origin --tags
git pull --ff-only origin main
NEW_COMMIT=$(git rev-parse HEAD)

if [[ "$PREV_COMMIT" == "$NEW_COMMIT" ]]; then
  echo "  · already at latest ($(git rev-parse --short HEAD)) — nothing to deploy"
  exit 0
fi

echo "  · new commit:  $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"

# Tag this deploy so future rollbacks are explicit.
TAG="deploy-$(date -u +%Y%m%d-%H%M%S)"
git tag -a "$TAG" -m "deploy from $(git log -1 --format='%s')"
echo "  · tagged $TAG"

# ─── build ──────────────────────────────────────────────────────
cd "$BACKEND_DIR"

rollback() {
  local reason="$1"
  if [[ "$MIGRATIONS_STARTED" -eq 1 ]]; then
    echo "✗ $reason" >&2
    echo "  ! migration execution has started; automatic old-code rollback is disabled" >&2
    echo "  ! apply a forward fix, then restart and rerun smoke tests" >&2
    pm2 stop "$PM2_NAME" >/dev/null 2>&1 || true
    exit 1
  fi
  echo "✗ $reason — rolling application code back to $PREV_COMMIT" >&2
  cd "$REPO_DIR"
  git reset --hard "$PREV_COMMIT"
  cd "$BACKEND_DIR"
  npm ci
  npm run build
  if [[ "$SERVICE_STOPPED" -eq 1 ]]; then
    pm2 restart "$PM2_NAME" --update-env
  fi
  echo "✗ rolled back to $(git rev-parse --short HEAD); deploy aborted" >&2
  exit 1
}

# Install all deps (incl. devDependencies). `npm run build` needs tsc,
# which is in devDependencies — so `--omit=dev` here would break the
# build. devDeps are disk-only, no runtime cost.
echo "  · npm ci..."
npm ci || rollback "npm ci failed"

echo "  · npm run build..."
npm run build || rollback "build failed"

# Stop instead of rolling reload: old and new auth/session protocols must never
# serve traffic at the same time during this cutover.
echo "  · pm2 stop $PM2_NAME (maintenance window)..."
pm2 stop "$PM2_NAME" || rollback "pm2 stop failed"
SERVICE_STOPPED=1

if [[ "$NO_MIGRATE" -eq 0 ]]; then
  echo "  · npm run db:migrate..."
  # Mark before execution because a failed runner may already have committed
  # one or more forward migrations.
  MIGRATIONS_STARTED=1
  npm run db:migrate || rollback "db:migrate failed (database changes, if any, were not reversed)"
fi

# ─── start ──────────────────────────────────────────────────────
echo "  · pm2 restart $PM2_NAME..."
pm2 restart "$PM2_NAME" --update-env || rollback "pm2 restart failed"

# Give Node a moment to bind the new HTTP listener.
sleep 2

# ─── smoke test ─────────────────────────────────────────────────
if [[ "$SKIP_SMOKE" -eq 0 ]]; then
  if ! "$SCRIPT_DIR/smoke-test.sh"; then
    rollback "smoke-test failed"
  fi
fi

echo "✓ deployed $(git rev-parse --short HEAD) ($TAG)"
