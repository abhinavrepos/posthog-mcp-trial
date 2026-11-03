#!/usr/bin/env bash
# Starts PostHog's own MCP server next to this machine's PostHog, and gives it its own API key.
#
#   deploy/posthog-mcp/up.sh             # start it (or restart it with new settings)
#   deploy/posthog-mcp/up.sh --new-key   # also replace its API key
#   deploy/posthog-mcp/up.sh down        # stop and remove it
#   MCP_BIND=0.0.0.0 MCP_NETWORK_URL=http://10.0.1.25:8787/mcp deploy/posthog-mcp/up.sh
#                                        # reachable from the network too, not only this machine
#
# The key is read-only and can never reach session replays: it has every read scope except the ones
# for recordings, things made from recordings (replay AI analysis, signals), exports (they can hold
# recording videos) and sharing links (they can open recordings). It is limited to the Lens project.
# It writes POSTHOG_MCP_URL and POSTHOG_MCP_API_KEY into .secrets.env; Claude gets them through .mcp.json.
#
# Environment: SECRETS (../../.secrets.env), POSTHOG_DIR (/opt/posthog), MCP_PORT (8787),
# MCP_POSTHOG_API_URL (how the container reaches PostHog's API: http://web:8000 for plain HTTP,
# the public HTTPS address otherwise).
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = down ]; then MCP_POSTHOG_API_URL=- MCP_POSTHOG_PUBLIC_URL=- docker compose down; exit 0; fi
SECRETS="${SECRETS:-$(cd ../.. && pwd)/.secrets.env}"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
export MCP_PORT="${MCP_PORT:-8787}" MCP_BIND="${MCP_BIND:-127.0.0.1}"
export MCP_APPS_URL="${MCP_NETWORK_URL:-http://127.0.0.1:$MCP_PORT/mcp}"; MCP_APPS_URL="${MCP_APPS_URL%/mcp}"
export POSTHOG_NETWORK="${POSTHOG_NETWORK:-$(basename "$POSTHOG_DIR")_default}"
get() { grep -E "^$1=" "$SECRETS" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
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
# With HTTPS PostHog sends plain-HTTP requests to https://, so the container takes the public address.
if [ -z "${MCP_POSTHOG_API_URL:-}" ]; then
    case "$public" in https://*) MCP_POSTHOG_API_URL="$public" ;; *) MCP_POSTHOG_API_URL=http://web:8000 ;; esac
fi
export MCP_POSTHOG_API_URL

if [ -z "$(get POSTHOG_MCP_API_KEY)" ] || [ "${1:-}" = --new-key ]; then
    email="$(get POSTHOG_ADMIN_EMAIL)"; project="$(get POSTHOG_PROJECT_ID)"
    [ -n "$email" ] && [ -n "$project" ] || { echo "POSTHOG_ADMIN_EMAIL or POSTHOG_PROJECT_ID is missing in $SECRETS."; exit 1; }
    out=$(cd "$POSTHOG_DIR" && docker compose exec -T -e ADMIN_EMAIL="$email" -e PROJECT_ID="$project" web python manage.py shell 2>/dev/null <<'PY'
import os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import generate_random_token_personal, hash_key_value, mask_key_value
from posthog.scopes import GRANTABLE_API_SCOPE_OBJECTS

# Anything that holds or opens a recording, or is made from one.
NEVER = {"session_recording", "session_recording_playlist", "replay_scanner", "vision_action", "vision_alert",
         "signal_scout", "export", "sharing_configuration"}
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
    echo "Made a read-only API key for the MCP server (no session replay scopes), label posthog-mcp."
fi
# The address this machine reaches it on: 127.0.0.1 unless it listens on one other address only.
local_host="$MCP_BIND"; [ "$local_host" = 0.0.0.0 ] && local_host=127.0.0.1
put POSTHOG_MCP_URL "http://$local_host:$MCP_PORT/mcp"

# A machine without internet takes the image from ECR (deploy/offline/ecr.env).
. ../offline/ecr.sh
if [ "$IMAGES_FROM" = ecr ]; then export POSTHOG_MCP_IMAGE="$ECR_POSTHOG_MCP"; images_login; fi
docker compose up -d --quiet-pull --remove-orphans 2>&1 | grep -v -E "^ *(Container|Network) " || true
for _ in $(seq 1 60); do curl -fs -o /dev/null -m 2 "http://$local_host:$MCP_PORT/healthz" && break; sleep 1; done
curl -fs -o /dev/null -m 2 "http://$local_host:$MCP_PORT/healthz" || { docker compose logs --tail 20; echo "The MCP server did not start."; exit 1; }
if [ "$MCP_BIND" = 127.0.0.1 ]; then where="this machine only"; else where="also ${MCP_NETWORK_URL:-port $MCP_PORT on the network}"; fi
echo "PostHog's MCP server: http://$local_host:$MCP_PORT/mcp ($where), calling PostHog at $MCP_POSTHOG_API_URL"
