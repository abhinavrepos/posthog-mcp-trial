#!/usr/bin/env bash
# One-time setup against a fresh self-hosted PostHog (the hobby install in /opt/posthog):
#   1. creates the first account and organization (skipped if the email already exists)
#   2. turns on session recording, exception capture, console logs and dead clicks for the project
#   3. creates a read-only personal API key for the triage service, scoped to that project
#   4. writes everything (and fresh secrets for Jira, MCP and clip links) to .secrets.env
#
#   PUBLIC_HOST=203.0.113.10 ADMIN_EMAIL=you@example.com scripts/setup-posthog.sh
set -euo pipefail
cd "$(dirname "$0")/.."

POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
PUBLIC_HOST="${PUBLIC_HOST:?set PUBLIC_HOST to the IP or name people use to reach this machine}"
ADMIN_EMAIL="${ADMIN_EMAIL:?set ADMIN_EMAIL}"
SECRETS=.secrets.env
umask 077

rand() { openssl rand -hex "${1:-24}"; }
get() { [ -f "$SECRETS" ] && grep -E "^$1=" "$SECRETS" | head -1 | cut -d= -f2- || true; }

ADMIN_PASSWORD="$(get POSTHOG_ADMIN_PASSWORD)"
[ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD="$(rand 12)"

curl -fs -m 10 http://localhost/_health >/dev/null || { echo "PostHog is not healthy yet (curl http://localhost/_health)"; exit 1; }

echo "==> Creating the PostHog account for $ADMIN_EMAIL"
code=$(curl -s -o /tmp/ph-signup.json -w '%{http_code}' -X POST http://localhost/api/signup/ \
    -H 'content-type: application/json' \
    -d "{\"first_name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"organization_name\":\"Acme\",\"role_at_organization\":\"engineering\"}")
case "$code" in
    200|201) echo "    created" ;;
    *) echo "    signup returned $code (an existing account is fine): $(head -c 200 /tmp/ph-signup.json)" ;;
esac
rm -f /tmp/ph-signup.json

echo "==> Configuring the project and creating the API key"
out=$(cd "$POSTHOG_DIR" && docker compose exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" -e PUBLIC_HOST="$PUBLIC_HOST" web python manage.py shell 2>/dev/null <<'PY'
import json, os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import generate_random_token_personal, hash_key_value, mask_key_value

user = User.objects.get(email=os.environ["ADMIN_EMAIL"])
team = user.team
host = os.environ["PUBLIC_HOST"]
team.session_recording_opt_in = True
team.capture_console_log_opt_in = True
team.autocapture_exceptions_opt_in = True
team.capture_dead_clicks = True
team.app_urls = [f"http://{host}:3000", "http://localhost:3000"]
team.recording_domains = [f"http://{host}:3000", "http://localhost:3000"]
team.save()

label = "ticket-triage"
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
json=$(echo "$out" | grep '^SETUP_JSON=' | cut -d= -f2-)
[ -n "$json" ] || { echo "Django shell did not return the key:"; echo "$out" | tail -20; exit 1; }
field() { python3 -c "import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]])" "$json" "$1"; }

val() { local v; v="$(get "$1")"; [ -n "$v" ] && echo "$v" || echo "$2"; }
cat >"$SECRETS" <<EOF
# Written by scripts/setup-posthog.sh. Git-ignored. Keep it private.
POSTHOG_HOST=http://localhost
POSTHOG_PUBLIC_HOST=http://$PUBLIC_HOST
POSTHOG_PROJECT_ID=$(field project_id)
POSTHOG_PROJECT_TOKEN=$(field token)
POSTHOG_PERSONAL_API_KEY=$(field key)
POSTHOG_ADMIN_EMAIL=$ADMIN_EMAIL
POSTHOG_ADMIN_PASSWORD=$ADMIN_PASSWORD

# Mock Jira (swap these three for a real Jira Cloud site and API token)
JIRA_BASE_URL=$(val JIRA_BASE_URL http://localhost:4000)
JIRA_EMAIL=$(val JIRA_EMAIL triage-bot@acme.example)
JIRA_API_TOKEN=$(val JIRA_API_TOKEN "$(rand)")
JIRA_WEBHOOK_SECRET=$(val JIRA_WEBHOOK_SECRET "$(rand 32)")

SERVICE_PUBLIC_URL=http://$PUBLIC_HOST:8080
MCP_TOKEN=$(val MCP_TOKEN "$(rand 32)")
CLIP_LINK_SECRET=$(val CLIP_LINK_SECRET "$(rand 32)")
DEMO_UI_PASSWORD=$(val DEMO_UI_PASSWORD "$(rand 8)")
DEMO_APP_URL=http://localhost:3000

# Optional: enables Claude reading tickets and suggesting causes
ANTHROPIC_API_KEY=$(get ANTHROPIC_API_KEY)
EOF
echo "==> Wrote $SECRETS"
echo "    PostHog login: http://$PUBLIC_HOST  ($ADMIN_EMAIL, password in $SECRETS)"
