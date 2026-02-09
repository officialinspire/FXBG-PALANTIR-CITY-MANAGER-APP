#!/usr/bin/env bash
set -euo pipefail

TERMUX_ROOT="/data/data/com.termux/files/usr"
if [[ ! -d "$TERMUX_ROOT" ]]; then
  echo "This script is intended for Termux. '$TERMUX_ROOT' not found." >&2
  exit 1
fi

start_dir="$(pwd)"
current_dir="$start_dir"
repo_root=""

while true; do
  if [[ -f "$current_dir/package.json" ]]; then
    repo_root="$current_dir"
    break
  fi

  if [[ "$current_dir" == "/" ]]; then
    echo "Run this from inside the repo folder."
    exit 1
  fi

  current_dir="$(dirname "$current_dir")"
done

cd "$repo_root"

if [[ ! -d "node_modules" ]]; then
  echo "[termux-run] Installing dependencies..."
  npm install
fi

export BIND=0.0.0.0
export PORT="${PORT:-8000}"

get_phone_ip() {
  local ip_addr=""
  if command -v ip >/dev/null 2>&1; then
    ip_addr=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
  fi
  if [[ -z "$ip_addr" ]] && command -v hostname >/dev/null 2>&1; then
    ip_addr=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  echo "$ip_addr"
}

phone_ip="$(get_phone_ip)"
if [[ -z "$phone_ip" ]]; then
  phone_ip="<phone_ip>"
fi

echo "Local:  http://127.0.0.1:$PORT"
echo "LAN:    http://${phone_ip}:$PORT"

echo ""

echo "[termux-run] Starting server..."
exec npm start
