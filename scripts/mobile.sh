#!/usr/bin/env bash
set -euo pipefail

export BIND=0.0.0.0
export PORT="${PORT:-8000}"
export LOG_DIR=logs

bash scripts/up.sh
