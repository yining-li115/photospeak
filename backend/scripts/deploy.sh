#!/usr/bin/env bash
#
# PhotoSpeak backend deploy script. Run on the production LAS via SSH, or
# stream this exact file over SSH from GitHub Actions:
#
#   cd /opt/photospeak/backend && ./scripts/deploy.sh
#   PHOTOSPEAK_REPO_DIR=/opt/photospeak bash -s -- --commit <sha> < scripts/deploy.sh
#
# What it does, in order:
#   1. Takes an exclusive deployment lock and records the rollback target.
#   2. Fetches origin and checks out the exact tested commit.
#   4. npm ci (lockfile-exact dependencies).
#   5. npm run build — TypeScript compile.
#   6. Stops the old process (short maintenance window; no mixed protocol).
#   7. Runs Drizzle only when migration files changed (or a previous migration
#      deploy was interrupted).
#   8. Restarts PM2 with only the new code, then runs smoke-test.sh.
#   9. Records a local successful-deploy tag.
#
# Code-only releases roll back automatically if build, restart, readiness, or
# smoke tests fail. Database migrations are forward-only. After a migration
# attempt starts, this script fails closed and requires a forward fix; it never
# starts auth-incompatible old code against new schema/semantics.
#
# Usage:
#   ./scripts/deploy.sh                      # deploy origin/main
#   ./scripts/deploy.sh --commit <sha>       # deploy an exact main ancestor
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
MIGRATIONS_REQUIRED=0
SERVICE_STOPPED=0
PM2_NAME="${PM2_NAME:-photospeak-api}"
TARGET_COMMIT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)
      [[ $# -ge 2 ]] || { echo "--commit requires a git SHA" >&2; exit 2; }
      TARGET_COMMIT="$2"
      shift 2
      ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --no-migrate) NO_MIGRATE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve repo root regardless of where the script was invoked from. CI streams
# this script over SSH, so it supplies an explicit production checkout path.
if [[ -n "${PHOTOSPEAK_REPO_DIR:-}" ]]; then
  REPO_DIR="$(cd "$PHOTOSPEAK_REPO_DIR" && pwd)"
  BACKEND_DIR="$REPO_DIR/backend"
  SCRIPT_DIR="$BACKEND_DIR/scripts"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  REPO_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
fi

[[ -d "$REPO_DIR/.git" && -f "$BACKEND_DIR/package.json" ]] || {
  echo "✗ PHOTOSPEAK_REPO_DIR is not a PhotoSpeak checkout: $REPO_DIR" >&2
  exit 2
}

DEPLOY_STATE_DIR="${PHOTOSPEAK_DEPLOY_STATE_DIR:-$REPO_DIR/.deploy-state}"
MIGRATION_SENTINEL="$DEPLOY_STATE_DIR/migration-in-progress"
DEPLOY_LOCK_FILE="${PHOTOSPEAK_DEPLOY_LOCK_FILE:-/tmp/photospeak-deploy.lock}"
mkdir -p "$DEPLOY_STATE_DIR"

# Never let two pushes mutate the same checkout/process concurrently.
exec 9>"$DEPLOY_LOCK_FILE"
if ! flock -n 9; then
  echo "✗ another PhotoSpeak deployment is already running" >&2
  exit 1
fi

cd "$REPO_DIR"

PREV_COMMIT=$(git rev-parse HEAD)
echo "▶ deploy starting"
echo "  · prev commit: $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"

# Refuse to destroy server-side edits. Generated/ignored files are allowed.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ production checkout has tracked local changes; refusing deployment" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

# ─── fetch exact tested revision ────────────────────────────────
fetch_origin() {
  local attempt
  for attempt in 1 2 3; do
    if GIT_TERMINAL_PROMPT=0 git fetch --prune origin main --tags; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "  ! origin fetch failed (attempt $attempt/3); retrying..." >&2
      sleep $((attempt * 2))
    fi
  done
  echo "✗ origin fetch failed after 3 attempts" >&2
  return 1
}

# The forced-command wrapper already fetched and proved that the requested SHA
# is the current origin/main. Avoid a second outbound GitHub fetch on that path;
# standalone/manual deploys still fetch and verify for themselves.
if [[ "${PHOTOSPEAK_FETCH_VERIFIED:-0}" != "1" ]]; then
  fetch_origin
fi
ORIGIN_MAIN=$(git rev-parse origin/main)
if [[ -n "$TARGET_COMMIT" ]]; then
  [[ "$TARGET_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || {
    echo "✗ --commit must be a 7-40 character hexadecimal git SHA" >&2
    exit 2
  }
  git cat-file -e "$TARGET_COMMIT^{commit}" 2>/dev/null || {
    echo "✗ requested commit is not available after fetching origin/main" >&2
    exit 1
  }
  NEW_COMMIT=$(git rev-parse "$TARGET_COMMIT^{commit}")
  git merge-base --is-ancestor "$NEW_COMMIT" "$ORIGIN_MAIN" || {
    echo "✗ refusing to deploy a commit that is not on origin/main" >&2
    exit 1
  }
else
  NEW_COMMIT="$ORIGIN_MAIN"
fi

if [[ -f "$MIGRATION_SENTINEL" ]]; then
  MIGRATIONS_REQUIRED=1
  echo "  ! interrupted migration deployment detected; migrations must be retried"
elif [[ "$PREV_COMMIT" != "$NEW_COMMIT" ]] && \
     ! git diff --quiet "$PREV_COMMIT" "$NEW_COMMIT" -- backend/drizzle; then
  MIGRATIONS_REQUIRED=1
fi

if [[ "$NO_MIGRATE" -eq 1 && -f "$MIGRATION_SENTINEL" ]]; then
  echo "✗ --no-migrate is forbidden while an interrupted migration marker exists" >&2
  exit 1
fi

git checkout --detach "$NEW_COMMIT"

if [[ "$PREV_COMMIT" == "$NEW_COMMIT" ]]; then
  # A prior attempt may have pulled successfully and then failed before build,
  # migration, restart, or smoke test. Re-running must finish those steps.
  echo "  · already at latest ($(git rev-parse --short HEAD)); redeploying idempotently"
else
  echo "  · new commit:  $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"
fi

# ─── build ──────────────────────────────────────────────────────
cd "$BACKEND_DIR"

rollback() {
  local reason="$1"
  if [[ "$MIGRATIONS_STARTED" -eq 1 || -f "$MIGRATION_SENTINEL" ]]; then
    echo "✗ $reason" >&2
    echo "  ! migration execution has started; automatic old-code rollback is disabled" >&2
    echo "  ! apply a forward fix, then restart and rerun smoke tests" >&2
    pm2 stop "$PM2_NAME" >/dev/null 2>&1 || true
    exit 1
  fi
  echo "✗ $reason — rolling application code back to $PREV_COMMIT" >&2
  cd "$REPO_DIR"
  git checkout --detach "$PREV_COMMIT"
  cd "$BACKEND_DIR"
  npm ci || { echo "✗ rollback npm ci failed" >&2; exit 1; }
  npm run build || { echo "✗ rollback build failed" >&2; exit 1; }
  if [[ "$SERVICE_STOPPED" -eq 1 ]]; then
    pm2 restart "$PM2_NAME" --update-env || {
      echo "✗ rollback restart failed" >&2
      exit 1
    }
    sleep 2
    if [[ "$SKIP_SMOKE" -eq 0 ]]; then
      "$SCRIPT_DIR/smoke-test.sh" || {
        echo "✗ rollback smoke test failed; service needs manual intervention" >&2
        exit 1
      }
    fi
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

if [[ "$NO_MIGRATE" -eq 0 && "$MIGRATIONS_REQUIRED" -eq 1 ]]; then
  echo "  · npm run db:migrate..."
  # Mark before execution because a failed runner may already have committed
  # one or more forward migrations.
  MIGRATIONS_STARTED=1
  printf '%s\n' "$NEW_COMMIT" > "$MIGRATION_SENTINEL"
  npm run db:migrate || rollback "db:migrate failed (database changes, if any, were not reversed)"
else
  echo "  · no migration changes; skipping db:migrate"
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

rm -f "$MIGRATION_SENTINEL"

# Lightweight tags need no server-side author identity and contain no agent
# attribution. They exist only in the production clone as rollback markers.
TAG="deploy-success-$(date -u +%Y%m%d-%H%M%S)"
git tag "$TAG" "$NEW_COMMIT"
echo "✓ deployed $(git rev-parse --short HEAD) ($TAG)"
