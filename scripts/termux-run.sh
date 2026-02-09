#!/usr/bin/env bash

set -euo pipefail

start_dir="$(pwd)"
repo_root=""
current_dir="${start_dir}"

while [ "${current_dir}" != "/" ]; do
  if [ -f "${current_dir}/package.json" ]; then
    repo_root="${current_dir}"
    break
  fi
  current_dir="$(dirname "${current_dir}")"
done

if [ -z "${repo_root}" ]; then
  echo "Error: Could not find package.json from ${start_dir}. Run this from within the repo."
  exit 1
fi

cd "${repo_root}"

export PORT="${PORT:-8000}"
export BIND="${BIND:-0.0.0.0}"

mkdir -p logs

if [ ! -d "node_modules" ]; then
  npm install
fi

lan_ip="$(ip -4 addr show up scope global | awk '/inet /{print $2}' | cut -d/ -f1 | head -n 1)"
if [ -z "${lan_ip}" ]; then
  lan_ip="<phone-lan-ip>"
fi

echo "Local: http://127.0.0.1:${PORT}"
echo "LAN: http://${lan_ip}:${PORT}"

if [ -f "proxy-server.js" ]; then
  node proxy-server.js
elif [ -f "server/proxy-server.js" ]; then
  node server/proxy-server.js
else
  npm start
fi
