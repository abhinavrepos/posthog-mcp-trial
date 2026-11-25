#!/usr/bin/env bash
# Turns surveys on in the Lens project (PostHog's surveys_opt_in) through PostHog's API, and checks it.
# A new PostHog project has surveys off, and posthog-js then never loads any survey, so a survey Lens
# launches would never show.
#
#   deploy/posthog/survey-engine/opt-in.sh          # turn it on (no change when it is already on)
#   deploy/posthog/survey-engine/opt-in.sh --check  # only report it; exits 1 when it is off
#
# Lens keeps no key that can change project settings. This makes a personal key with project read and write
# for the Lens project only, makes the one API call, and deletes the key again, also when the call fails.
# Environment: SECRETS (../../../.secrets.env), POSTHOG_DIR (/opt/posthog), POSTHOG_API (http://web:8000,
# called from inside PostHog's web container so it works behind HTTPS sites and without host networking).
set -euo pipefail
cd "$(dirname "$0")"
SECRETS="${SECRETS:-$(cd ../../.. && pwd)/.secrets.env}"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
POSTHOG_API="${POSTHOG_API:-http://web:8000}"
LABEL=lens-survey-opt-in
get() { grep -E "^$1=" "$SECRETS" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
[ -f "$SECRETS" ] || { echo "$SECRETS is missing: run scripts/setup-posthog.sh first."; exit 1; }
email="$(get POSTHOG_ADMIN_EMAIL)"; project="$(get POSTHOG_PROJECT_ID)"
[ -n "$email" ] && [ -n "$project" ] || { echo "POSTHOG_ADMIN_EMAIL or POSTHOG_PROJECT_ID is missing in $SECRETS."; exit 1; }
shell() { (cd "$POSTHOG_DIR" && docker compose exec -T -e ADMIN_EMAIL="$email" -e PROJECT_ID="$project" -e LABEL="$LABEL" web python manage.py shell 2>/dev/null); }
drop_key() {
    shell <<'PY' >/dev/null || true
import os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
PersonalAPIKey.objects.filter(user__email=os.environ["ADMIN_EMAIL"], label=os.environ["LABEL"]).delete()
PY
}
trap drop_key EXIT
out=$(shell <<'PY'
import os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import generate_random_token_personal, hash_key_value, mask_key_value

user = User.objects.get(email=os.environ["ADMIN_EMAIL"])
PersonalAPIKey.objects.filter(user=user, label=os.environ["LABEL"]).delete()
token = generate_random_token_personal()
PersonalAPIKey.objects.create(
    user=user,
    label=os.environ["LABEL"],
    secure_value=hash_key_value(token),
    mask_value=mask_key_value(token),
    scopes=["project:read", "project:write"],
    scoped_teams=[int(os.environ["PROJECT_ID"])],
)
print("OPT_IN_KEY=" + token)
PY
)
key="$(echo "$out" | grep '^OPT_IN_KEY=' | cut -d= -f2-)"
[ -n "$key" ] || { echo "PostHog did not return a key for the survey setting:"; echo "$out" | tail -5; exit 1; }
# The key goes to curl on stdin (a header file), never on a command line other accounts can read.
api() { (cd "$POSTHOG_DIR" && printf 'Authorization: Bearer %s\n' "$key" | docker compose exec -T web curl --noproxy '*' -sS --max-time 20 -H @- -H 'content-type: application/json' "$@"); }
state() { api "$POSTHOG_API/api/projects/$project/" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("surveys_opt_in")).lower())' 2>/dev/null || echo unknown; }
now="$(state)"
if [ "${1:-}" = --check ]; then
    echo "surveys_opt_in=$now (project $project)"
    [ "$now" = true ]; exit
fi
if [ "$now" = true ]; then echo "Surveys are on in PostHog project $project (surveys_opt_in=true)."; exit 0; fi
api -X PATCH -d '{"surveys_opt_in": true}' "$POSTHOG_API/api/projects/$project/" >/dev/null
now="$(state)"
[ "$now" = true ] || { echo "Could not turn surveys on in PostHog project $project (surveys_opt_in=$now)."; exit 1; }
echo "Turned surveys on in PostHog project $project (surveys_opt_in was off, PostHog's default)."
