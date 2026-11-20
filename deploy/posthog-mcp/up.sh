#!/usr/bin/env bash
# Starts PostHog's own MCP server next to this machine's PostHog, and gives it its own API key.
#
#   deploy/posthog-mcp/up.sh             # start it (or restart it with new settings)
#   deploy/posthog-mcp/up.sh --new-key   # also replace its API key
#   deploy/posthog-mcp/up.sh down        # stop and remove it
#   MCP_BIND=0.0.0.0 MCP_NETWORK_URL=http://10.0.1.25:8787/mcp deploy/posthog-mcp/up.sh
#                                        # reachable from the network too, not only this machine
#
# The key is read-only and can never reach session replays or surveys (Lens manages surveys): it has
# every read scope except surveys and the ones for recordings, things made from recordings (replay AI analysis, signals), exports (they can hold
# recording videos) and sharing links (they can open recordings). It is limited to the Lens project.
# It writes POSTHOG_MCP_URL and POSTHOG_MCP_API_KEY into .secrets.env; Claude gets them through .mcp.json.
#
# Environment: SECRETS (../../.secrets.env), POSTHOG_DIR (/opt/posthog), MCP_PORT (8787),
# MCP_POSTHOG_API_URL (how the container reaches PostHog's API: http://web:8000 for plain HTTP,
# default, including public HTTPS sites).
set -euo pipefail
cd "$(dirname "$0")"
# Persistent, optional site layer survives kit unpacking. Never put local overrides in the kit checkout.
MCP_SITE_COMPOSE="${MCP_SITE_COMPOSE:-/etc/posthog-lens/posthog-mcp.override.yml}"
export COMPOSE_FILE="$PWD/docker-compose.yml"
if [ -f "$MCP_SITE_COMPOSE" ]; then
    export COMPOSE_FILE="$COMPOSE_FILE:$MCP_SITE_COMPOSE"
fi
# Apply the selected upstream last, including over an old public-HTTPS site override.
export COMPOSE_FILE="$COMPOSE_FILE:$PWD/docker-compose.api.yml"
if [ "${1:-}" = down ]; then MCP_POSTHOG_API_URL=- MCP_POSTHOG_PUBLIC_URL=- docker compose down; exit 0; fi
SECRETS="${SECRETS:-$(cd ../.. && pwd)/.secrets.env}"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
export MCP_PORT="${MCP_PORT:-8787}" MCP_BIND="${MCP_BIND:-127.0.0.1}"
export MCP_APPS_URL="${MCP_NETWORK_URL:-http://127.0.0.1:$MCP_PORT/mcp}"; MCP_APPS_URL="${MCP_APPS_URL%/mcp}"
if [ -z "${POSTHOG_NETWORK:-}" ]; then
    web_container="$(cd "$POSTHOG_DIR" && env -u COMPOSE_FILE docker compose ps -q web | head -1)"
    [ -z "$web_container" ] || POSTHOG_NETWORK="$(docker inspect -f '{{range $name, $network := .NetworkSettings.Networks}}{{$name}} {{end}}' "$web_container" | awk '{print $1}')"
fi
export POSTHOG_NETWORK="${POSTHOG_NETWORK:-$(basename "$POSTHOG_DIR")_default}"
get() { python3 - "$SECRETS" "$1" <<'PYENV'
import sys
sys.path.insert(0, '../offline')
from site_config_loader import env
print(env(sys.argv[1]).get(sys.argv[2], ''))
PYENV
}
put() {
    python3 - "$SECRETS" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1:]
lines = open(path).read().splitlines()
for i, line in enumerate(lines):
    if line.startswith(key + "="):
        lines[i] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")
open(path, "w").write("\n".join(lines) + "\n")
PY
}
[ -f "$SECRETS" ] || { echo "$SECRETS is missing: run scripts/setup-posthog.sh first."; exit 1; }
docker network inspect "$POSTHOG_NETWORK" >/dev/null 2>&1 || { echo "Docker network $POSTHOG_NETWORK not found. Set POSTHOG_NETWORK (docker network ls | grep default)."; exit 1; }

public="$(get POSTHOG_PUBLIC_HOST)"
[ -n "$public" ] || { echo "POSTHOG_PUBLIC_HOST is not set in $SECRETS."; exit 1; }
export MCP_POSTHOG_PUBLIC_URL="$public"
# Internal HTTP avoids load balancer certificates and hairpin routing.
export MCP_POSTHOG_API_URL="${MCP_POSTHOG_API_URL:-http://web:8000}"
probe_internal() {
    local path headers
    for path in /_health /api/; do
        headers="$(cd "$POSTHOG_DIR" && env -u COMPOSE_FILE docker compose exec -T web curl --noproxy '*' -sS -D - -o /dev/null --max-time 10 "http://web:8000$path")" || return 1
        if grep -qiE '^location: *https://' <<<"$headers"; then return 2; fi
        grep -qE '^HTTP/[^ ]+ (200|401|403)' <<<"$headers" || return 1
    done
}
if [ "$MCP_POSTHOG_API_URL" = http://web:8000 ]; then
    ready=0; repaired=0
    for _ in $(seq 1 120); do
        result=0; probe_internal || result=$?
        if [ "$result" = 0 ]; then ready=1; break; fi
        if [ "$result" = 2 ] && [ "$repaired" = 0 ]; then
            echo "PostHog redirects internal HTTP to HTTPS; setting DISABLE_SECURE_SSL_REDIRECT=true in the persistent site file."
            python3 ../offline/site-config.py "$POSTHOG_DIR"
            (cd "$POSTHOG_DIR" && env -u COMPOSE_FILE docker compose up -d --no-build --pull never web)
            repaired=1
        fi
        sleep 5
    done
    [ "$ready" = 1 ] || { echo "Internal PostHog /_health or /api/ unavailable or redirects to HTTPS. Fix web health and DISABLE_SECURE_SSL_REDIRECT in $POSTHOG_DIR/docker-compose.site.yml, then rerun $0."; exit 1; }
    echo "Internal network preflight passed: MCP calls $MCP_POSTHOG_API_URL (/_health and /api/)."
fi
echo "PostHog MCP upstream API: $MCP_POSTHOG_API_URL; public links: $MCP_POSTHOG_PUBLIC_URL"
# The machine's CA bundle, so the container trusts the same certificates (see docker-compose.yml).
for b in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do [ -f "$b" ] && { export HOST_CA_BUNDLE="$b"; break; }; done
[ -n "${HOST_CA_BUNDLE:-}" ] || { echo "No CA bundle found on this machine (/etc/ssl/certs/ca-certificates.crt or /etc/pki/tls/certs/ca-bundle.crt)."; exit 1; }

if [ -z "$(get POSTHOG_MCP_API_KEY)" ] || [ "${1:-}" = --new-key ]; then
    email="$(get POSTHOG_ADMIN_EMAIL)"; project="$(get POSTHOG_PROJECT_ID)"
    [ -n "$email" ] && [ -n "$project" ] || { echo "POSTHOG_ADMIN_EMAIL or POSTHOG_PROJECT_ID is missing in $SECRETS."; exit 1; }
    out=$(cd "$POSTHOG_DIR" && env -u COMPOSE_FILE docker compose exec -T -e ADMIN_EMAIL="$email" -e PROJECT_ID="$project" web python manage.py shell 2>/dev/null <<'PY'
import os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import generate_random_token_personal, hash_key_value, mask_key_value
from posthog.scopes import GRANTABLE_API_SCOPE_OBJECTS

# Lens is a display layer over PostHog: the agent may find and open session replays through PostHog's own
# tools, so recording scopes are granted (read only). Still never: AI scanners, exports, sharing links, and
# surveys (managed in Lens).
NEVER = {"replay_scanner", "vision_action", "vision_alert", "signal_scout", "export", "sharing_configuration", "survey"}
user = User.objects.get(email=os.environ["ADMIN_EMAIL"])
PersonalAPIKey.objects.filter(user=user, label="posthog-mcp").delete()
token = generate_random_token_personal()
PersonalAPIKey.objects.create(
    user=user,
    label="posthog-mcp",
    secure_value=hash_key_value(token),
    mask_value=mask_key_value(token),
    scopes=sorted(f"{o}:read" for o in GRANTABLE_API_SCOPE_OBJECTS if o not in NEVER),
    scoped_teams=[int(os.environ["PROJECT_ID"])],
)
print("MCP_KEY=" + token)
PY
)
    key="$(echo "$out" | grep '^MCP_KEY=' | cut -d= -f2-)"
    [ -n "$key" ] || { echo "PostHog did not return the MCP key:"; echo "$out" | tail -5; exit 1; }
    put POSTHOG_MCP_API_KEY "$key"
    echo "Made a read-only API key for the MCP server (session replays readable), label posthog-mcp."
fi
# In-app surveys are managed only in Lens: a key made before that rule loses its survey scopes.
(cd "$POSTHOG_DIR" && env -u COMPOSE_FILE docker compose exec -T web python manage.py shell 2>/dev/null <<'PY'
from posthog.models.personal_api_key import PersonalAPIKey
for k in PersonalAPIKey.objects.filter(label="posthog-mcp"):
    kept = [s for s in (k.scopes or []) if not s.startswith("survey:")]
    # Keys made when replays were hidden from the agent get read access to recordings and playlists.
    for s in ("session_recording:read", "session_recording_playlist:read"):
        if s not in kept: kept.append(s)
    if sorted(kept) != sorted(k.scopes or []):
        k.scopes = sorted(kept)
        k.save(update_fields=["scopes"])
        print("Updated PostHog's MCP key: session replays readable, surveys managed in Lens.")
PY
) || true
# The address this machine reaches it on: 127.0.0.1 unless it listens on one other address only.
local_host="$MCP_BIND"; [ "$local_host" = 0.0.0.0 ] && local_host=127.0.0.1
put POSTHOG_MCP_URL "http://$local_host:$MCP_PORT/mcp"

# A machine without internet takes the image from ECR (deploy/offline/ecr.env).
. ../offline/ecr.sh
if [ "$IMAGES_FROM" = ecr ]; then export POSTHOG_MCP_IMAGE="$ECR_POSTHOG_MCP"; images_login; ecr_fetch "$ECR_POSTHOG_MCP" || exit 1; fi
pull_args=()
[ "${MCP_NO_PULL:-0}" != 1 ] || pull_args=(--pull never)
docker compose up -d --quiet-pull --remove-orphans "${pull_args[@]}"
# Up to 3 minutes: at start the server fetches its skills catalog from github.com and waits up to 60 s
# for it. Without internet it then starts without those skills (its tools all work) and keeps trying.
echo "Starting PostHog's MCP server (up to 3 minutes without internet: it waits 60 s for GitHub first)"
for _ in $(seq 1 180); do curl -fs -o /dev/null -m 2 "http://$local_host:$MCP_PORT/healthz" && break; sleep 1; done
curl -fs -o /dev/null -m 2 "http://$local_host:$MCP_PORT/healthz" || { docker compose logs --tail 20; echo "The MCP server did not start."; exit 1; }
if [ "$MCP_BIND" = 127.0.0.1 ]; then where="this machine only"; else where="also ${MCP_NETWORK_URL:-port $MCP_PORT on the network}"; fi
echo "PostHog's MCP server: http://$local_host:$MCP_PORT/mcp ($where), calling PostHog at $MCP_POSTHOG_API_URL"
