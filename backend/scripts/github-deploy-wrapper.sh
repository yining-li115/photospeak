#!/usr/bin/env bash
# Forced-command entry point for the dedicated GitHub Actions SSH key.
#
# authorized_keys restriction:
# command="/usr/local/sbin/photospeak-github-deploy",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 ...

set -euo pipefail

readonly REPO_DIR="/root/photospeak"
readonly EXPECTED_PREFIX="photospeak-deploy "
original_command="${SSH_ORIGINAL_COMMAND:-}"

if [[ "$original_command" != "$EXPECTED_PREFIX"* ]]; then
  echo "deployment command rejected" >&2
  exit 2
fi

target_commit="${original_command#"$EXPECTED_PREFIX"}"
if [[ ! "$target_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deployment commit must be a full lowercase SHA-1" >&2
  exit 2
fi

[[ -d "$REPO_DIR/.git" ]] || {
  echo "production checkout is missing: $REPO_DIR" >&2
  exit 1
}

fetch_origin() {
  local attempt
  for attempt in 1 2 3; do
    if GIT_TERMINAL_PROMPT=0 git -C "$REPO_DIR" fetch --prune origin main --tags; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "origin fetch failed (attempt $attempt/3); retrying..." >&2
      sleep $((attempt * 2))
    fi
  done
  echo "origin fetch failed after 3 attempts" >&2
  return 1
}

fetch_origin
origin_main="$(git -C "$REPO_DIR" rev-parse origin/main)"
if [[ "$target_commit" != "$origin_main" ]]; then
  echo "deployment commit is not the current origin/main" >&2
  exit 1
fi

# Trust the deployment program stored in the verified GitHub revision. The SSH
# client supplies only the SHA; arbitrary stdin is never executed.
git -C "$REPO_DIR" show "$target_commit:backend/scripts/deploy.sh" |
  PHOTOSPEAK_REPO_DIR="$REPO_DIR" PHOTOSPEAK_FETCH_VERIFIED=1 \
    bash -s -- --commit "$target_commit"
