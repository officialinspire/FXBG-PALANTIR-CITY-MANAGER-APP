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

pkg update -y
pkg install -y nodejs-lts git curl openssl bash coreutils findutils iproute2

node -v
npm -v
