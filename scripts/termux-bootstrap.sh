#!/usr/bin/env bash
set -euo pipefail

TERMUX_ROOT="/data/data/com.termux"
if [[ ! -d "$TERMUX_ROOT" ]]; then
  echo "This script must be run inside Termux. '$TERMUX_ROOT' not found." >&2
  exit 1
fi

echo "Updating Termux packages..."
pkg update -y
pkg upgrade -y

pkg install -y nodejs-lts git curl openssl-tools bash coreutils findutils

# Optional but recommended build tools
pkg install -y make python clang

termux-setup-storage

CONFIG_DIR="$HOME/.config/fxbg-palantir"
mkdir -p "$CONFIG_DIR"

ENV_FILE="$CONFIG_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f ".env.example" ]]; then
    cp ".env.example" "$ENV_FILE"
    echo "Created $ENV_FILE from .env.example."
  else
    echo "Warning: .env.example not found in current directory." >&2
  fi
  echo "Review $ENV_FILE and add any required API keys before running the app."
fi

REPO_PATH="$(pwd)"

echo ""
echo "Standard run command:"
echo "cd $REPO_PATH && bash scripts/up.sh"
