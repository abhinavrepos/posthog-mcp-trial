#!/usr/bin/env bash
# Gives Lens its own PostHog API key for surveys: survey read and write, limited to the Lens project,
# nothing else (no events, persons, flags or replays). Lens reads events and answers with its normal
# read-only key. Writes POSTHOG_SURVEY_API_KEY into .secrets.env.
#
#   deploy/posthog/survey-engine/key.sh             # make it if .secrets.env has none
#   deploy/posthog/survey-engine/key.sh --new-key   # replace it
#
# Environment: SECRETS (../../../.secrets.env), POSTHOG_DIR (/opt/posthog).
set -euo pipefail
cd "$(dirname "$0")"
SECRETS="${SECRETS:-$(cd ../../.. && pwd)/.secrets.env}"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
get() { grep -E "^$1=" "$SECRETS" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
[ -f "$SECRETS" ] || { echo "$SECRETS is missing: run scripts/setup-posthog.sh first."; exit 1; }
if [ -n "$(get POSTHOG_SURVEY_API_KEY)" ] && [ "${1:-}" != --new-key ]; then exit 0; fi
email="$(get POSTHOG_ADMIN_EMAIL)"; project="$(get POSTHOG_PROJECT_ID)"
[ -n "$email" ] && [ -n "$project" ] || { echo "POSTHOG_ADMIN_EMAIL or POSTHOG_PROJECT_ID is missing in $SECRETS."; exit 1; }
out=$(cd "$POSTHOG_DIR" && docker compose exec -T -e ADMIN_EMAIL="$email" -e PROJECT_ID="$project" web python manage.py shell 2>/dev/null <<'PY'
import os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import generate_random_token_personal, hash_key_value, mask_key_value

user = User.objects.get(email=os.environ["ADMIN_EMAIL"])
PersonalAPIKey.objects.filter(user=user, label="lens-surveys").delete()
token = generate_random_token_personal()
PersonalAPIKey.objects.create(
    user=user,
    label="lens-surveys",
    secure_value=hash_key_value(token),
    mask_value=mask_key_value(token),
    scopes=["survey:read", "survey:write"],
    scoped_teams=[int(os.environ["PROJECT_ID"])],
)
print("SURVEY_KEY=" + token)
PY
)
key="$(echo "$out" | grep '^SURVEY_KEY=' | cut -d= -f2-)"
[ -n "$key" ] || { echo "PostHog did not return the survey key:"; echo "$out" | tail -5; exit 1; }
python3 - "$SECRETS" POSTHOG_SURVEY_API_KEY "$key" <<'PY'
import sys
path, k, v = sys.argv[1:]
lines = open(path).read().splitlines()
for i, line in enumerate(lines):
    if line.startswith(k + "="):
        lines[i] = f"{k}={v}"
        break
else:
    lines.append(f"{k}={v}")
open(path, "w").write("\n".join(lines) + "\n")
PY
echo "Made Lens's survey key (survey read and write, project $project only), label lens-surveys."
