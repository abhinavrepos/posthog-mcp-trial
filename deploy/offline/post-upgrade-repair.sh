#!/usr/bin/env bash
# Re-runnable repair for an already upgraded server. No package/image installation.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LENS_DIR="${LENS_DIR:-$(cd "$HERE/../.." && pwd)}"
CONF="${POSTHOG_LENS_CONF:-/etc/posthog-lens/posthog-lens.env}"
YES=0
case "${1:-}" in --yes) YES=1 ;; '') ;; *) echo "Usage: sudo POSTHOG_DIR=/path/to/posthog bash $0 [--yes]"; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo 'Run with sudo.'; exit 1; }
get() { python3 - "$HERE" "$1" "$2" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from site_config_loader import env
print(env(sys.argv[2]).get(sys.argv[3], ''))
PY
}
POSTHOG_DIR="${POSTHOG_DIR:-$(get "$CONF" POSTHOG_DIR)}"
[ -f "$POSTHOG_DIR/docker-compose.yml" ] || { echo 'Set POSTHOG_DIR to the upgraded PostHog folder.'; exit 1; }
export POSTHOG_DIR
# Diagnostics still run if a repair action fails, and preserve that failure's exit status.
backup=""
finish_checks() {
    local rc=$? check_rc=0
    trap - EXIT
    [ -z "$backup" ] || rm -rf "$backup"
    python3 "$HERE/server-check.py" "$LENS_DIR" || check_rc=$?
    [ "$rc" = 0 ] || exit "$rc"
    exit "$check_rc"
}
trap finish_checks EXIT
ask() { local reply; [ "$YES" = 0 ] || return 0; read -r -p "$* [y/N] " reply; [[ "$reply" = [yY] || "$reply" = [yY][eE][sS] ]]; }
if ask 'Preserve site settings, trust all site addresses and enable mixed HTTP/HTTPS?'; then
    # Recover addresses from the old backup too (old kit already replaced the live Compose file).
    backup="$(mktemp -d)"
    if [ -f "$POSTHOG_DIR/upgrade-backup/install-files.tgz" ]; then
        tar -xzf "$POSTHOG_DIR/upgrade-backup/install-files.tgz" -C "$backup" --no-same-owner --no-same-permissions
        old="$(find "$backup" -name docker-compose.yml -print -quit)"
        if [ -n "$old" ]; then
            python3 "$HERE/site-config.py" "$(dirname "$old")" --stock-dir "$POSTHOG_DIR/posthog" --before-upgrade
            # Keep recovered values as an earlier layer, without overriding current persistent settings.
            recovered="$POSTHOG_DIR/docker-compose.recovered-site.yml"
            cp "$(dirname "$old")/docker-compose.site.yml" "$recovered"; chmod 600 "$recovered"
            python3 - "$HERE" "$POSTHOG_DIR/.env" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from site_config_loader import env, put
p = sys.argv[2]
v = env(p)
updates = {}
for k, default in [('EXTRA_COMPOSE_FILES', ''), ('COMPOSE_FILE', 'docker-compose.yml')]:
    files = [f for f in v.get(k, default).split(':') if f and f not in ('docker-compose.recovered-site.yml', 'docker-compose.site.yml')]
    files.append('docker-compose.recovered-site.yml')
    if 'docker-compose.site.yml' in v.get(k, '').split(':'):
        files.append('docker-compose.site.yml')
    updates[k] = ':'.join(dict.fromkeys(files))
put(p, updates)
PY
        fi
    fi
    addresses="$(get "$CONF" POSTHOG_ADDRESS)"
    site="$HERE/sites/$(hostname -s)/site.env"
    [ -n "$addresses" ] || addresses="$(get "$site" POSTHOG_ADDRESS)"
    python3 "$HERE/site-config.py" "$POSTHOG_DIR" --addresses "$addresses"
    python3 "$HERE/public-mount-permissions.py" "$POSTHOG_DIR"
    (cd "$POSTHOG_DIR" && docker compose up -d --no-build --pull never web proxy)
fi
# Wait after recreation before rebuilding config or probing MCP.
echo 'Waiting for PostHog health (up to 20 minutes)...'
ready=0
for _ in $(seq 1 240); do
    if (cd "$POSTHOG_DIR" && docker compose exec -T web curl --noproxy '*' -fsS --max-time 5 http://web:8000/_health >/dev/null); then ready=1; break; fi
    sleep 5
done
[ "$ready" = 1 ] || { echo 'FAIL PostHog health; inspect docker compose logs web and rerun repair.'; exit 1; }
if ask 'Rebuild RemoteConfig for every team (fix config.js)?'; then
    (cd "$POSTHOG_DIR" && docker compose exec -T web python manage.py shell < "$LENS_DIR/deploy/migrate/remote-config.py")
fi
if ask 'Apply site/event settings to persistent CONF and Lens .secrets.env, then restart Lens?'; then
    detected="$(mktemp)"
    python3 "$HERE/detect-settings.py" "$LENS_DIR/.secrets.env" > "$detected"
    python3 - "$HERE" "$CONF" "$LENS_DIR/.secrets.env" "$detected" "$HERE/sites/$(hostname -s)/site.env" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from site_config_loader import env, put
conf, secrets, detected, site = sys.argv[2:]
values = env(detected)
# Detection only fills empty settings. Site defaults override old installer answers; CONF wins.
current = env(secrets)
values = {k: v for k, v in values.items() if not current.get(k) or (k == 'CLIENT_FROM_DISTINCT_ID' and current[k] == '0')}
values.update(env(site))
values.update(env(conf))
Path(conf).parent.mkdir(parents=True, exist_ok=True)
put(conf, values)
Path(conf).chmod(0o600)
keys = ('CLIENT_FROM_DISTINCT_ID', 'DISTINCT_ID_SEPARATOR', 'APP_EVENTS_FILE')
put(secrets, {k: values[k] for k in keys if k in values})
for k in keys:
    print(k + '=' + values.get(k, current.get(k, '')))
PY
    rm -f "$detected"
    systemctl restart ticket-triage || echo 'FAIL Lens not running; run sudo posthog-lens update <kit>'
fi
if ask 'Restart PostHog MCP using the internal HTTP network (no image pulls)?'; then
    IMAGE_SOURCE=local MCP_NO_PULL=1 bash "$LENS_DIR/deploy/posthog-mcp/up.sh"
fi
if [ -f "$POSTHOG_DIR/upgrade-state/done/replays" ] && [ ! -f "$POSTHOG_DIR/upgrade-state/done/verify" ] && ask 'Verify the previous replay copy now?'; then
    IMAGE_SOURCE=local bash "$LENS_DIR/deploy/migrate/posthog-upgrade.sh" verify --yes
fi
if [ ! -f "$POSTHOG_DIR/upgrade-state/done/replays" ] && ask 'Copy old replays now, then verify (requires old MinIO and upgrade backup)?'; then
    IMAGE_SOURCE=local bash "$LENS_DIR/deploy/migrate/posthog-upgrade.sh" replays --yes
    IMAGE_SOURCE=local bash "$LENS_DIR/deploy/migrate/posthog-upgrade.sh" verify --yes
fi
echo 'Waiting for Lens health (up to 2 minutes)...'
for _ in $(seq 1 24); do
    curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null && break
    sleep 5
done
# The EXIT handler runs all server checks.
