#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:${PORT:-8000}}

fail=0
grep_bin="rg"
if ! command -v rg >/dev/null 2>&1; then
  grep_bin="grep"
  echo "[smoke] rg not found; falling back to grep for optional diagnostics."
fi
if command -v jq >/dev/null 2>&1; then
  echo "[smoke] jq detected (not required)."
fi

parse_json_ok() {
  local body="$1"
  local mode="$2"
  node -e '
    const mode = process.argv[2];
    const body = process.argv[1];
    try {
      const data = JSON.parse(body);
      if (mode === "health") {
        process.exit(data && data.ok === true ? 0 : 1);
      }
      if (mode === "crime") {
        const ok = data && (data.ok === true || String(data.status || "").toLowerCase() === "ok");
        process.exit(ok ? 0 : 1);
      }
      if (mode === "reports") {
        process.exit(data && data.ok === true ? 0 : 1);
      }
      if (mode === "geojson") {
        process.exit(data && data.type === "FeatureCollection" ? 0 : 1);
      }
      process.exit(1);
    } catch (err) {
      process.exit(2);
    }
  ' "$body" "$mode"
}

check_ok() {
  local url="$1"
  local label="$2"
  local mode="$3"
  local response
  response=$(curl -sS "$url" | head -c 8000)
  if parse_json_ok "$response" "$mode"; then
    echo "[smoke] ${label} OK ($url)"
  else
    local status=$?
    if [ "$status" -eq 2 ]; then
      echo "[smoke] ${label} returned non-JSON output ($url)"
      echo "$response" | "$grep_bin" -m 1 -n . >/dev/null 2>&1 || true
    else
      echo "[smoke] ${label} failed JSON check ($url)"
    fi
    fail=1
  fi
}

echo "[smoke] Running against $BASE_URL"

check_ok "$BASE_URL/api/health" "health" "health"
check_ok "$BASE_URL/api/fxbg/crime-reports/status" "crime-reports status" "crime"
check_ok "$BASE_URL/api/reports" "reports" "reports"
check_ok "$BASE_URL/api/reports/export.geojson" "reports geojson" "geojson"

curl -s "$BASE_URL/api/fxbg/crime-reports/incidents" | head -c 800 >/dev/null
curl -s "$BASE_URL/api/health/test-upstreams?quick=1" | head -c 800 >/dev/null

echo "[smoke] Completed"

exit $fail
