#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$APP_DIR"

echo "[up] cwd: $(pwd)"

# 1) Ensure deps
if [ ! -d node_modules ]; then
  echo "[up] Installing dependencies…"
  npm install
else
  echo "[up] node_modules present (skip npm install)"
fi

# 2) Ensure data directory exists
mkdir -p data

# 3) Ensure .env exists (portable)
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    echo "[up] Creating .env from .env.example"
    cp .env.example .env
  else
    echo "[up] ERROR: .env missing and .env.example not found"
    exit 1
  fi
else
  echo "[up] .env present"
fi

# 4) .env provenance proof (path, mtime, size, sha256)
echo ""
echo "== .env Provenance =="
ENV_ABS_PATH="$(cd "$(dirname .env)" && pwd)/$(basename .env)"
echo "[env] Path: $ENV_ABS_PATH"

# Get file stats (portable across Linux/macOS)
if command -v stat >/dev/null 2>&1; then
  if stat --version 2>/dev/null | grep -q GNU; then
    # GNU stat (Linux)
    ENV_MTIME=$(stat -c '%y' .env 2>/dev/null | cut -d. -f1)
    ENV_SIZE=$(stat -c '%s' .env 2>/dev/null)
  else
    # BSD stat (macOS)
    ENV_MTIME=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' .env 2>/dev/null)
    ENV_SIZE=$(stat -f '%z' .env 2>/dev/null)
  fi
  echo "[env] Modified: $ENV_MTIME"
  echo "[env] Size: ${ENV_SIZE} bytes"
fi

# SHA256 (first 8 chars only)
if command -v sha256sum >/dev/null 2>&1; then
  ENV_SHA=$(sha256sum .env 2>/dev/null | cut -c1-8)
  echo "[env] SHA256: ${ENV_SHA}..."
elif command -v shasum >/dev/null 2>&1; then
  ENV_SHA=$(shasum -a 256 .env 2>/dev/null | cut -c1-8)
  echo "[env] SHA256: ${ENV_SHA}..."
fi

# 5) Check API key presence (length only, no secrets)
echo ""
echo "== API Key Check (length only) =="

# Helper function to get env value from .env file
get_env_value() {
  grep -E "^${1}=" .env 2>/dev/null | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'
}

# Check OPENUV (with aliases)
OPENUV_VAL=$(get_env_value "OPENUV_API_KEY")
if [ -z "$OPENUV_VAL" ]; then
  OPENUV_VAL=$(get_env_value "OPENUV_KEY")
fi
if [ -n "$OPENUV_VAL" ] && [ ${#OPENUV_VAL} -gt 5 ]; then
  echo "[env] OPENUV_API_KEY: present (${#OPENUV_VAL} chars)"
else
  echo "[env] OPENUV_API_KEY: *** MISSING OR EMPTY ***"
  echo "      -> Get key at: https://www.openuv.io/"
fi

# Check WAQI (with aliases)
WAQI_VAL=$(get_env_value "WAQI_TOKEN")
if [ -z "$WAQI_VAL" ]; then
  WAQI_VAL=$(get_env_value "WAQI_API_KEY")
fi
if [ -z "$WAQI_VAL" ]; then
  WAQI_VAL=$(get_env_value "AQICN_TOKEN")
fi
if [ -n "$WAQI_VAL" ] && [ ${#WAQI_VAL} -gt 5 ]; then
  echo "[env] WAQI_TOKEN: present (${#WAQI_VAL} chars)"
else
  echo "[env] WAQI_TOKEN: *** MISSING OR EMPTY ***"
  echo "      -> Get token at: https://aqicn.org/data-platform/token/"
fi

# Warn if keys are missing
if { [ -z "$OPENUV_VAL" ] || [ ${#OPENUV_VAL} -le 5 ]; } || { [ -z "$WAQI_VAL" ] || [ ${#WAQI_VAL} -le 5 ]; }; then
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!! WARNING: Your .env exists but some keys appear empty.   !!"
  echo "!! UI may show missing-key errors for UV/Air Quality data. !!"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
fi
echo ""

# 6) Ensure LOG_DIR is configured (so npm start doesn't fail)
# If LOG_DIR not set in .env, export a safe default.
if ! grep -qE '^[[:space:]]*LOG_DIR=' .env; then
  echo "[up] LOG_DIR not found in .env — exporting LOG_DIR=logs for this run"
  export LOG_DIR="${LOG_DIR:-logs}"
fi

# 7) Build schools dataset (NCES) — unless SKIP_SCHOOLS_BUILD=1
echo ""
echo "== Build schools dataset (NCES) =="
if [ "${SKIP_SCHOOLS_BUILD:-0}" = "1" ]; then
  echo "[schools] SKIP_SCHOOLS_BUILD=1 set; skipping build:schools"
else
  if command -v npm >/dev/null 2>&1; then
    echo "[schools] Running npm run build:schools..."
    if ! npm run build:schools; then
      echo "[up] ERROR: npm run build:schools failed"
      exit 1
    fi
    # Report result
    if [ -f data/schools_fxbg.json ]; then
      if command -v stat >/dev/null 2>&1; then
        if stat --version 2>/dev/null | grep -q GNU; then
          SCHOOLS_MTIME=$(stat -c '%y' data/schools_fxbg.json 2>/dev/null | cut -d. -f1)
          SCHOOLS_SIZE=$(stat -c '%s' data/schools_fxbg.json 2>/dev/null)
        else
          SCHOOLS_MTIME=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' data/schools_fxbg.json 2>/dev/null)
          SCHOOLS_SIZE=$(stat -f '%z' data/schools_fxbg.json 2>/dev/null)
        fi
        echo "[schools] OK: data/schools_fxbg.json"
        echo "[schools] Modified: $SCHOOLS_MTIME"
        echo "[schools] Size: ${SCHOOLS_SIZE} bytes"
      fi
    else
      echo "[up] WARNING: data/schools_fxbg.json not found after build"
    fi
  else
    echo "[up] ERROR: npm not available"
    exit 1
  fi
fi
echo ""

# 8) Run doctor (non-interactive readiness)
echo "[up] Running doctor…"
npm run doctor

# 9) Start
echo "[up] Starting server…"
npm start
