#!/usr/bin/env bash
#
# Smoke-test the running backend. Hits a small set of critical
# endpoints and exits non-zero if any of them misbehave. Intended
# to run right after `pm2 reload` to catch deploys that look
# successful (PM2 says "online") but actually broke something.
#
# Usage:
#   ./scripts/smoke-test.sh [--base http://localhost:3000]
#
# Exits 0 if all checks pass, 1 if anything fails.

set -euo pipefail

BASE="${BASE:-http://localhost:3000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "→ smoke-testing $BASE"

# Each check is: name, curl args (without -fs), expected substring in response.
# We keep this list short — one for each public surface category.
fail() {
  echo "  ✗ $1" >&2
  exit 1
}

# 1. Liveness probe — proves the process is up + responding.
echo -n "  · /health ... "
out=$(curl -fs --max-time 5 "$BASE/health") || fail "/health unreachable"
[[ "$out" == *'"status":"ok"'* ]] || fail "/health unexpected body: $out"
echo "ok"

# 2. Public legal page — proves Hono routing + HTML rendering work.
echo -n "  · /privacy ... "
status=$(curl -fs --max-time 5 -o /dev/null -w '%{http_code}' "$BASE/privacy") || fail "/privacy unreachable"
[[ "$status" == "200" ]] || fail "/privacy got HTTP $status"
echo "ok"

# 3. Auth gate proves middleware chain works — unauth'd /api/* must 401.
#    (We don't need a valid JWT — we just need to confirm the gate fires.)
echo -n "  · /api/transcribe (no auth) ... "
status=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  "$BASE/api/transcribe")
[[ "$status" == "401" ]] || fail "/api/transcribe should 401 without auth, got $status"
echo "ok"

# 4. Body validation — auth'd request with empty body must fail 400.
#    Skip if SMOKE_TEST_TOKEN unset (fine for local dev; required in prod
#    deploy script so we exercise the full validator path).
if [[ -n "${SMOKE_TEST_TOKEN:-}" ]]; then
  echo -n "  · /api/analyze (auth, empty body) ... "
  status=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $SMOKE_TEST_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{}' \
    "$BASE/api/analyze")
  [[ "$status" == "400" ]] || fail "/api/analyze should 400 on empty body (zod validator), got $status"
  echo "ok"
fi

echo "✓ smoke-test passed"
