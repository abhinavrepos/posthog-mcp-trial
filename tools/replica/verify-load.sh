#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec python3 runner.py verify "${1:?Usage: verify-load.sh TEAM_ID}"
