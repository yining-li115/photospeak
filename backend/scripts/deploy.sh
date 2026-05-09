#!/usr/bin/env bash
#
# PhotoSpeak backend deploy script. Run on the production LAS via SSH:
#
#   cd /opt/photospeak/backend && ./scripts/deploy.sh
#
# What it does, in order, with auto-rollback if any step fails:
#   1. Records the current commit (rollback target).
#   2. Tags the new commit before deploying (so you can always
#      `git checkout deploy-<timestamp>` later).
#   3. git pull (fast-forward only, never merges).
#   4. npm install (production deps only).
#   5. npm run build — TypeScript compile.
#   6. npm run db:migrate — Drizzle migrations.
#   7. pm2 reload — replaces processes with new code.
#   8. smoke-test.sh — curls critical endpoints; if any fail, rolls
#      back to the prior commit, rebuilds, and reloads.
#
# Anything other than a clean exit means PM2 is running the prior
# version. You can't end up half-deployed.
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
  echo "✗ $reason — rolling back to $PREV_COMMIT" >&2
  cd "$REPO_DIR"
  git reset --hard "$PREV_COMMIT"
  cd "$BACKEND_DIR"
  npm install --omit=dev
  npm run build
  pm2 reload "$PM2_NAME" --update-env
  echo "✗ rolled back to $(git rev-parse --short HEAD); deploy aborted" >&2
  exit 1
}

echo "  · npm install..."
npm install --omit=dev || rollback "npm install failed"

echo "  · npm run build..."
npm run build || rollback "build failed"

if [[ "$NO_MIGRATE" -eq 0 ]]; then
  echo "  · npm run db:migrate..."
  npm run db:migrate || rollback "db:migrate failed"
fi

# ─── reload ─────────────────────────────────────────────────────
echo "  · pm2 reload $PM2_NAME..."
pm2 reload "$PM2_NAME" --update-env || rollback "pm2 reload failed"

# Give Node a moment to bind the new HTTP listener.
sleep 2

# ─── smoke test ─────────────────────────────────────────────────
if [[ "$SKIP_SMOKE" -eq 0 ]]; then
  if ! "$SCRIPT_DIR/smoke-test.sh"; then
    rollback "smoke-test failed"
  fi
fi

echo "✓ deployed $(git rev-parse --short HEAD) ($TAG)"
