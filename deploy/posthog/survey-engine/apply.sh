#!/usr/bin/env bash
# Remove only the survey renderer and proxy overrides installed by Signal.
set -euo pipefail
[ "${1:-}" = --remove ] || { echo 'Usage: apply.sh --remove [POSTHOG_DIR]' >&2; exit 2; }
shift
posthog_dir="${1:-${POSTHOG_DIR:-/opt/posthog}}"
cd "$posthog_dir" || { echo "PostHog directory not found: $posthog_dir" >&2; exit 1; }
remove_compose_file() {
    local file="$1"
    [ -f .env ] || return 0
    python3 - "$file" <<'PY'
import sys
path = sys.argv[1]
lines = open('.env').read().splitlines()
for i, line in enumerate(lines):
    for key in ('COMPOSE_FILE', 'EXTRA_COMPOSE_FILES'):
        if line.startswith(key + '='):
            raw = line.split('=', 1)[1].strip().strip('"')
            parts = [part for part in raw.split(':') if part and part != path]
            lines[i] = key + '=' + ('"' + ':'.join(parts) + '"' if key == 'COMPOSE_FILE' else ':'.join(parts))
open('.env', 'w').write('\n'.join(lines) + '\n')
PY
}
renderer=docker-compose.lens-survey.yml
lock=docker-compose.lens-survey-lock.yml
web_changed=0
proxy_changed=0
ours_or_missing() {
    local path="$1" marker="$2"
    if [ -f "$path" ]; then grep -q "$marker" "$path"
    else grep -Fq "$path" .env 2>/dev/null
    fi
}
if ours_or_missing "$renderer" 'lens-survey-engine'; then
    remove_compose_file "$renderer"
    rm -f "$renderer"
    web_changed=1
fi
if ours_or_missing "$lock" 'Lens survey lock'; then
    remove_compose_file "$lock"
    rm -f "$lock"
    proxy_changed=1
fi
# Built renderer files and leftovers from the former installer (ours only: fixed names in this folder).
[ -d lens-survey-engine ] && rm -rf lens-survey-engine
rm -f .env.lens-survey.bak "$lock.caddy" "$lock.tmp" "$lock.bak" "$renderer.tmp" "$renderer.bak"
failed=0
if [ "$web_changed" = 1 ]; then docker compose up -d --force-recreate --no-deps web >/dev/null || failed=1; fi
if [ "$proxy_changed" = 1 ]; then docker compose up -d --force-recreate --no-deps proxy >/dev/null || failed=1; fi
[ "$failed" = 0 ] || { echo 'Could not restart PostHog after removing survey overrides; retry --remove.' >&2; exit 1; }
echo 'PostHog native surveys and survey screens are available.'
