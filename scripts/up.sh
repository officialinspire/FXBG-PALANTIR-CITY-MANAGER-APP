#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/Downloads/FXBG-PALANTIR-CITY-MANAGER-APP-main}"
cd "$APP_DIR"

echo "[up] cwd: $(pwd)"

# 1) Ensure deps
if [ ! -d node_modules ]; then
  echo "[up] Installing dependencies…"
  npm install
else
  echo "[up] node_modules present (skip npm install)"
fi

# 2) Ensure .env exists (portable)
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

# 3) Ensure LOG_DIR is configured (so npm start doesn't fail)
# If LOG_DIR not set in .env, export a safe default.
if ! grep -qE '^[[:space:]]*LOG_DIR=' .env; then
  echo "[up] LOG_DIR not found in .env — exporting LOG_DIR=logs for this run"
  export LOG_DIR="${LOG_DIR:-logs}"
fi

# 4) Run doctor (non-interactive readiness)
echo "[up] Running doctor…"
npm run doctor

# 5) Start
echo "[up] Starting server…"
npm start

