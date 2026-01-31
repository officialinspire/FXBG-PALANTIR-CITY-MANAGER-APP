#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$APP_DIR"

GLOBAL_ENV_DIR="$HOME/.config/fxbg-palantir"
GLOBAL_ENV="$GLOBAL_ENV_DIR/.env"

mkdir -p "$GLOBAL_ENV_DIR"

if [ -f "$GLOBAL_ENV" ]; then
  echo "[install-env] Global env already exists: $GLOBAL_ENV"
else
  if [ -f .env.example ]; then
    cp .env.example "$GLOBAL_ENV"
    echo "[install-env] Created global env at: $GLOBAL_ENV"
  else
    echo "[install-env] ERROR: .env.example not found in repo"
    exit 1
  fi
fi

echo "[install-env] Next steps:"
echo "  1) Edit $GLOBAL_ENV and add your real API keys."
echo "  2) Run ./scripts/up.sh (it will copy the global env into the repo if needed)."
