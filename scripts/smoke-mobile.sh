#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8000}"
export BASE_URL="http://127.0.0.1:${PORT}"

print_lan_ips() {
  echo "----------------------------------------"
  echo "[smoke] LAN reachability info"
  echo "[smoke] If you need to access this server from another device,"
  echo "[smoke] use one of the IPs below with port ${PORT}."

  if command -v ip >/dev/null 2>&1; then
    ip -o -4 addr show | awk '{print "[smoke] IP: " $4}' || true
    return
  fi

  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig | awk '/inet / {print "[smoke] IP: " $2}' || true
    return
  fi

  if command -v hostname >/dev/null 2>&1; then
    hostname -I | tr ' ' '\n' | awk 'NF {print "[smoke] IP: " $1}' || true
    return
  fi

  echo "[smoke] Could not determine LAN IPs (missing ip/ifconfig/hostname)."
}

echo "========================================"
echo " FXBG smoke test (mobile)"
echo " BASE_URL: ${BASE_URL}"
echo "========================================"

bash scripts/smoke.sh
print_lan_ips
