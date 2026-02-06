#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${1:-${BASE_URL:-http://localhost:${PORT:-8000}}}

fail=0

parse_json_ok() {
  local body="$1"
  local mode="$2"
  node -e '
    const body = process.argv[1];
    const mode = process.argv[2];

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      process.exit(2);
    }

    const isObject = data && typeof data === "object";

    if (mode === "health") {
      process.exit((isObject && (data.status === "ok" || data.ok === true)) ? 0 : 1);
    }

    if (mode === "upstreams") {
      process.exit(isObject && Array.isArray(data.upstreams) ? 0 : 1);
    }

    if (mode === "incidents") {
      process.exit(isObject && Array.isArray(data.incidents) ? 0 : 1);
    }

    if (mode === "cache") {
      process.exit(isObject && data.cache && typeof data.cache === "object" ? 0 : 1);
    }

    process.exit(isObject ? 0 : 1);
  ' "$body" "$mode"
}

check_json() {
  local path="$1"
  local label="$2"
  local mode="${3:-json}"
  local url="${BASE_URL}${path}"

  local response
  if ! response=$(curl -fsS "$url"); then
    echo "[smoke] FAIL ${label} (${url})"
    fail=1
    return
  fi

  if parse_json_ok "$response" "$mode"; then
    echo "[smoke] PASS ${label} (${url})"
  else
    local status=$?
    if [ "$status" -eq 2 ]; then
      echo "[smoke] FAIL ${label} returned non-JSON (${url})"
    else
      echo "[smoke] FAIL ${label} JSON assertion (${url})"
    fi
    fail=1
  fi
}

echo "========================================"
echo " FXBG smoke test"
echo " BASE_URL: ${BASE_URL}"
echo "========================================"

check_json "/health" "legacy health" "health"
check_json "/api/health" "api health" "health"
check_json "/api/health/upstreams" "health upstreams" "upstreams"
check_json "/api/health/test-upstreams?quick=1" "test upstreams" "upstreams"
check_json "/api/fxbg/crime-reports/status" "crime reports status"
check_json "/api/fxbg/crime-reports/incidents?days=7" "crime reports incidents" "incidents"
check_json "/cache/stats" "cache stats" "cache"

echo "----------------------------------------"
if [ "$fail" -eq 0 ]; then
  echo "[smoke] RESULT: PASS"
else
  echo "[smoke] RESULT: FAIL"
fi

exit "$fail"
