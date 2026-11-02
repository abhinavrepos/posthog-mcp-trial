#!/usr/bin/env bash
# One-time setup of the PostHog side, on the machine that runs PostHog (the hobby install):
#   1. creates the first account and organization (skipped if the email already exists)
#   2. turns on session recording, exception capture, console logs and dead clicks for its project.
#      Recording works on every site that sends events, unless APP_URLS limits it
#   3. creates a read-only personal API key for the triage service, scoped to that project
#   4. writes the PostHog settings into .secrets.env, and fresh secrets for MCP, clip links and the Jira
#      webhook where they are missing. Every other line in the file is kept.
#
#   PUBLIC_HOST=203.0.113.10 ADMIN_EMAIL=you@example.com scripts/setup-posthog.sh
#
# Settings (environment):
#   ADMIN_EMAIL         required: the PostHog login to create or use
#   PUBLIC_HOST         the IP or name people use to reach this machine, or POSTHOG_PUBLIC_URL
#   POSTHOG_PUBLIC_URL  where browsers reach PostHog                         [http://PUBLIC_HOST]
#   ORG_NAME            the organization created with the account                         [Acme]
#   APP_URLS            optional: your app's addresses, comma-separated. Set, recording is allowed
#                       there only. Empty, every site that sends events records             [empty]
#   SERVICE_PUBLIC_URL  where people open clip links, kept if already set   [http://PUBLIC_HOST:8080]
#   POSTHOG_URL         where this script reaches PostHog's API                   [http://localhost]
#   POSTHOG_DIR         the PostHog install, for its Django shell                   [/opt/posthog]
#   KEY_LABEL           name of the API key in PostHog; replaced on every run     [ticket-triage]
#   SECRETS             the settings file to write                                  [.secrets.env]
set -euo pipefail
cd "$(dirname "$0")/.."

POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
POSTHOG_URL="${POSTHOG_URL:-http://localhost}"
ADMIN_EMAIL="${ADMIN_EMAIL:?set ADMIN_EMAIL}"
if [ -z "${POSTHOG_PUBLIC_URL:-}" ]; then
    PUBLIC_HOST="${PUBLIC_HOST:?set PUBLIC_HOST (the IP or name people use to reach this machine) or POSTHOG_PUBLIC_URL}"
    POSTHOG_PUBLIC_URL="http://$PUBLIC_HOST"
fi
POSTHOG_PUBLIC_URL="${POSTHOG_PUBLIC_URL%/}"
host_only="${POSTHOG_PUBLIC_URL#*://}"; host_only="${host_only%%/*}"; host_only="${host_only%%:*}"
ORG_NAME="${ORG_NAME:-Acme}"
APP_URLS="${APP_URLS:-}"
KEY_LABEL="${KEY_LABEL:-ticket-triage}"
SECRETS="${SECRETS:-.secrets.env}"
umask 077

rand() { openssl rand -hex "${1:-24}"; }
get() { [ -f "$SECRETS" ] && grep -E "^$1=" "$SECRETS" | head -1 | cut -d= -f2- || true; }
# Sets KEY=value in the settings file: replaces the line if there is one, else appends it.
put() {
    touch "$SECRETS"
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
# Sets KEY only when the file has no value for it yet.
default() { [ -n "$(get "$1")" ] || put "$1" "$2"; }

ADMIN_PASSWORD="$(get POSTHOG_ADMIN_PASSWORD)"
[ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD="$(rand 12)"

curl -fs -m 10 "$POSTHOG_URL/_health" >/dev/null || { echo "PostHog is not healthy yet (curl $POSTHOG_URL/_health)"; exit 1; }

echo "==> Creating the PostHog account for $ADMIN_EMAIL"
body=$(python3 -c 'import json,sys; print(json.dumps({"first_name": "Admin", "email": sys.argv[1], "password": sys.argv[2], "organization_name": sys.argv[3], "role_at_organization": "engineering"}))' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$ORG_NAME")
resp=$(mktemp)
code=$(curl -s -o "$resp" -w '%{http_code}' -X POST "$POSTHOG_URL/api/signup/" -H 'content-type: application/json' -d "$body")
case "$code" in
    200|201) echo "    created (organization \"$ORG_NAME\")" ;;
    *) echo "    signup returned $code (an existing account is fine): $(head -c 200 "$resp")" ;;
esac
rm -f "$resp"

echo "==> Configuring the project and creating the API key"
out=$(cd "$POSTHOG_DIR" && docker compose exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" -e APP_URLS="$APP_URLS" -e KEY_LABEL="$KEY_LABEL" web python manage.py shell 2>/dev/null <<'PY'
import json, os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import generate_random_token_personal, hash_key_value, mask_key_value

user = User.objects.filter(email=os.environ["ADMIN_EMAIL"]).first()
if user is None:
    print("SETUP_ERROR=no PostHog login " + os.environ["ADMIN_EMAIL"] + ". PostHog lets only the very first account sign up on its own: use the email of an existing login, or invite this one in PostHog first.")
    raise SystemExit
team = user.team
urls = [u.strip().rstrip("/") for u in os.environ["APP_URLS"].split(",") if u.strip()]
team.session_recording_opt_in = True
team.capture_console_log_opt_in = True
team.autocapture_exceptions_opt_in = True
team.capture_dead_clicks = True
if urls:
    team.app_urls = urls
# Empty: PostHog records on every domain.
team.recording_domains = urls
team.save()

label = os.environ["KEY_LABEL"]
PersonalAPIKey.objects.filter(user=user, label=label).delete()
token = generate_random_token_personal()
PersonalAPIKey.objects.create(
    user=user,
    label=label,
    secure_value=hash_key_value(token),
    mask_value=mask_key_value(token),
    scopes=["query:read", "session_recording:read", "error_tracking:read", "person:read", "group:read", "project:read"],
    scoped_teams=[team.id],
)
print("SETUP_JSON=" + json.dumps({"project_id": team.id, "token": team.api_token, "key": token}))
PY
)
err=$(echo "$out" | grep '^SETUP_ERROR=' | cut -d= -f2- || true)
[ -z "$err" ] || { echo "    $err"; exit 1; }
json=$(echo "$out" | grep '^SETUP_JSON=' | cut -d= -f2-)
[ -n "$json" ] || { echo "Django shell did not return the key:"; echo "$out" | tail -20; exit 1; }
field() { python3 -c "import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]])" "$json" "$1"; }

[ -f "$SECRETS" ] || printf '# PostHog Lens settings. Git-ignored. Keep it private. Every setting: .env.example\n' >"$SECRETS"
put POSTHOG_HOST "$POSTHOG_URL"
put POSTHOG_PUBLIC_HOST "$POSTHOG_PUBLIC_URL"
put POSTHOG_PROJECT_ID "$(field project_id)"
put POSTHOG_PROJECT_TOKEN "$(field token)"
put POSTHOG_PERSONAL_API_KEY "$(field key)"
put POSTHOG_ADMIN_EMAIL "$ADMIN_EMAIL"
put POSTHOG_ADMIN_PASSWORD "$ADMIN_PASSWORD"
default SERVICE_PUBLIC_URL "${SERVICE_PUBLIC_URL:-http://$host_only:8080}"
default MCP_TOKEN "$(rand 32)"
default CLIP_LINK_SECRET "$(rand 32)"
default JIRA_WEBHOOK_SECRET "$(rand 32)"
echo "==> Wrote the PostHog settings to $SECRETS"
echo "    PostHog login: $POSTHOG_PUBLIC_URL  ($ADMIN_EMAIL, password in $SECRETS)"
echo "    Recording allowed on: ${APP_URLS:-every site that sends events}"
