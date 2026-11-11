#!/usr/bin/env bash
# Additive, reversible tuning for the MIT hobby stack. --dry-run needs no Docker.
# Usage: POSTHOG_DIR=/opt/posthog deploy/posthog/tune.sh [--status|--undo|--dry-run]
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
MODE="${1:-apply}"
case "$MODE" in apply|--status|--undo|--dry-run) ;; *) echo "Unknown option: $MODE" >&2; exit 1 ;; esac
if [ "$MODE" = --dry-run ]; then
    preview="$(mktemp -d)"
    trap 'rm -rf "$preview"' EXIT
    python3 "$HERE/tuning.py" "$preview" "$POSTHOG_DIR/.env"
    cat "$preview/settings.json" "$preview/docker-compose.lens-tuning.yml"
    exit 0
fi
cd "$POSTHOG_DIR"
OVERRIDE=docker-compose.lens-tuning.yml
if [ "$MODE" = --status ]; then
    if [ -f lens-tuning/settings.json ]; then cat lens-tuning/settings.json; else echo 'Lens tuning is not installed'; fi
    docker compose ps web clickhouse proxy
    docker compose exec -T clickhouse clickhouse-client --query "SELECT name, value FROM system.settings WHERE name IN ('max_memory_usage','max_threads','max_bytes_before_external_group_by','max_bytes_before_external_sort')" || true
    exit 0
fi
[ -f .env ] || { echo "No .env in $POSTHOG_DIR" >&2; exit 1; }
# Avoid concurrent tuning / undo invocations.
exec 9>.lens-tuning.lock
flock -n 9 || { echo 'Another tuning operation is running' >&2; exit 1; }
stage="$(mktemp -d "$POSTHOG_DIR/.lens-tuning.XXXXXX")"
cp .env "$stage/env.before"
[ ! -f "$OVERRIDE" ] || cp "$OVERRIDE" "$stage/override.before"
[ ! -d lens-tuning ] || cp -a lens-tuning "$stage/tuning.before"
changed=0
restarted=0
rollback() {
    cp "$stage/env.before" .env
    if [ -f "$stage/override.before" ]; then cp "$stage/override.before" "$OVERRIDE"; else rm -f "$OVERRIDE"; fi
    rm -rf lens-tuning
    [ ! -d "$stage/tuning.before" ] || cp -a "$stage/tuning.before" lens-tuning
    if [ "$restarted" = 1 ]; then docker compose up -d --no-deps --force-recreate clickhouse web proxy || true; fi
}
cleanup() {
    local result=$?
    trap - EXIT
    if [ "$result" != 0 ] && [ "$changed" = 1 ]; then echo 'Tuning failed; restoring the previous deployment' >&2; rollback; fi
    rm -rf "$stage"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$MODE" = --undo ]; then
    changed=1
    python3 "$HERE/tuning.py" remove .env
    docker compose config -q
    restarted=1
    docker compose up -d --no-deps --force-recreate clickhouse web proxy
else
    docker compose config --format json > "$stage/compose.json"
    python3 "$HERE/tuning.py" "$stage/new" .env "$stage/compose.json"
    cp "$HERE/tuning-proxy.sh" "$stage/new/proxy.sh"
    cp "$HERE/tuning-static.caddy" "$stage/new/static.caddy"
    # JSON contains secrets; never print it. Validate the actual effective Caddyfile with its image.
    python3 - "$stage/compose.json" "$stage/new" <<'PY'
import json, subprocess, sys
from pathlib import Path
cfg = json.loads(Path(sys.argv[1]).read_text())['services']
out = Path(sys.argv[2])
env = cfg['proxy']['environment']
raw = env['CADDYFILE']
p = subprocess.run(['sh', str(out/'proxy.sh'), '--render'], input=raw, text=True, capture_output=True,
    env={**__import__('os').environ, 'LENS_TUNE_CADDY_BLOCK': str(out/'static.caddy')}, check=True)
text = p.stdout + '\n' + (env.get('CADDY_EXTRA_CONFIG') or '')
# Preserve the lock byte-for-byte, and retain upstream encode/file_server rules.
for marker in ('@lens_surveys_api', '/project/*/surveys'):
    if marker in raw and marker not in text: raise SystemExit('lost survey lock')
subprocess.run(['docker', 'run', '--rm', '-i', '--entrypoint', 'sh', cfg['proxy']['image'], '-c',
    'cat > /tmp/Caddyfile && caddy validate --config /tmp/Caddyfile --adapter caddyfile'], input=text, text=True, check=True)
# Version check against the installed image, not an assumed current Granian release.
help_text = subprocess.check_output(['docker', 'run', '--rm', '--entrypoint', 'granian', cfg['web']['image'], '--help'], text=True)
if '--workers-lifetime' not in help_text: raise SystemExit('Installed Granian lacks worker lifetime recycling; no changes applied')
PY
    if [ -f "$OVERRIDE" ] && cmp -s "$stage/new/$OVERRIDE" "$OVERRIDE" && diff -qr "$stage/new" lens-tuning >/dev/null && grep -q "$OVERRIDE" .env; then
        echo 'Lens tuning is already current'; exit 0
    fi
    changed=1
    rm -rf lens-tuning
    mkdir -p lens-tuning
    cp "$stage/new/"* lens-tuning/
    chmod 755 lens-tuning
    chmod 644 lens-tuning/*
    cp "$stage/new/$OVERRIDE" "$OVERRIDE"
    python3 "$HERE/tuning.py" add .env
    docker compose config -q
    # Parse the complete merged server + users config using the installed ClickHouse binary.
    docker compose run --rm --no-deps --entrypoint clickhouse clickhouse extract-from-config --config-file /etc/clickhouse-server/config.xml --key max_server_memory_usage
    docker compose run --rm --no-deps --entrypoint clickhouse clickhouse extract-from-config --config-file /etc/clickhouse-server/users.xml --key profiles.default.max_memory_usage
    restarted=1
    docker compose up -d --no-deps --force-recreate clickhouse web proxy
fi
# Wait for container health AND a real web request; no external network is needed.
wait_seconds="${LENS_TUNE_HEALTH_SECONDS:-1500}"  # PostHog web can take 10+ minutes to start on a small box
[[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid LENS_TUNE_HEALTH_SECONDS' >&2; exit 1; }
deadline=$((SECONDS + wait_seconds))
healthy=0
while [ "$SECONDS" -lt "$deadline" ]; do
    if docker compose exec -T clickhouse clickhouse-client --query 'SELECT 1' >/dev/null 2>&1 \
        && docker compose exec -T web python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/_health", timeout=5)' >/dev/null 2>&1 \
        && docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
        healthy=1; break
    fi
    sleep 5
done
[ "$healthy" = 1 ] || { echo 'PostHog did not become healthy' >&2; exit 1; }
if [ "$MODE" = --undo ]; then rm -f "$OVERRIDE"; rm -rf lens-tuning; fi
echo "Lens tuning: $MODE complete; PostHog is healthy"
