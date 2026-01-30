#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:${PORT:-8000}}

fail=0

check_ok() {
  local url="$1"
  local label="$2"
  local response
  response=$(curl -s "$url" | head -c 2000)
  if ! echo "$response" | rg -q '"ok"\s*:\s*true'; then
    echo "[smoke] Missing ok:true for $label ($url)"
    fail=1
  else
    echo "[smoke] ok:true confirmed for $label"
  fi
}

echo "[smoke] Running against $BASE_URL"

check_ok "$BASE_URL/api/health" "health"
check_ok "$BASE_URL/api/fxbg/crime-reports/status" "crime-reports status"

curl -s "$BASE_URL/api/fxbg/crime-reports/incidents" | head -c 800 >/dev/null
curl -s "$BASE_URL/api/health/test-upstreams?quick=1" | head -c 800 >/dev/null

echo "[smoke] Completed"

exit $fail
