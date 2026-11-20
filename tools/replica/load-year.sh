#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec python3 runner.py load "${1:?Usage: load-year.sh TEAM_ID}"
