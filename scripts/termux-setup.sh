#!/usr/bin/env bash

set -euo pipefail

if [ ! -d "/data/data/com.termux" ]; then
  echo "Warning: This script is intended to run inside Termux (missing /data/data/com.termux)."
fi

repo_path="$(pwd)"
if [[ "${repo_path}" == *" "* ]]; then
  echo "Warning: Repo path contains spaces: ${repo_path}"
  echo "Recommendation: Move the repo into \"$HOME\" (Termux home) for reliability."
else
  echo "Recommendation: Keep the repo inside \"$HOME\" (Termux home) for reliability."
fi

apps_dir="$HOME/apps/fxbg-palantir"
mkdir -p "${apps_dir}"
echo "Apps directory ready: ${apps_dir}"

env_file="${repo_path}/.env"
if [ ! -f "${env_file}" ]; then
  if [ -f "${repo_path}/.env.example" ]; then
    cp "${repo_path}/.env.example" "${env_file}"
    echo "Created .env from .env.example."
  else
    echo "Warning: .env.example not found; please create ${env_file} manually."
  fi
fi

echo "Edit your environment keys here: ${env_file}"
echo "Set OPENUV_API_KEY / WAQI_TOKEN in .env then restart server."

pkg update -y
pkg install -y nodejs-lts git curl openssl bash coreutils findutils iproute2

node -v
npm -v

npm run env:where
