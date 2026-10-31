#!/usr/bin/env bash
# Sets up the rehearsal copy of the old PostHog (in /opt/posthog-old): an admin account, its one
# project, and a personal API key for generate.ts. Writes them to /opt/posthog-old/rehearsal.env.
set -euo pipefail
cd "${OLD_DIR:-/opt/posthog-old}"
ENVF=rehearsal.env
umask 077
[ -f "$ENVF" ] && . "./$ENVF"
OLD_ADMIN_EMAIL="${OLD_ADMIN_EMAIL:-admin@old-posthog.example}"
OLD_ADMIN_PASSWORD="${OLD_ADMIN_PASSWORD:-$(openssl rand -hex 12)}"

code=$(curl -s -o /tmp/old-signup.json -w '%{http_code}' -X POST http://127.0.0.1:8010/api/signup/ -H 'content-type: application/json' \
    -d "{\"first_name\":\"Admin\",\"email\":\"$OLD_ADMIN_EMAIL\",\"password\":\"$OLD_ADMIN_PASSWORD\",\"organization_name\":\"Production (rehearsal)\",\"role_at_organization\":\"engineering\"}")
echo "signup: $code"
rm -f /tmp/old-signup.json

out=$(docker compose exec -T -e EMAIL="$OLD_ADMIN_EMAIL" web python manage.py shell 2>/dev/null <<'PY'
import json, os
from posthog.models import User
from posthog.models.personal_api_key import PersonalAPIKey
from posthog.models.utils import generate_random_token_personal, hash_key_value, mask_key_value
user = User.objects.get(email=os.environ["EMAIL"])
team = user.team
team.session_recording_opt_in = True
team.autocapture_exceptions_opt_in = True
team.name = "Production"
team.save()
PersonalAPIKey.objects.filter(user=user, label="rehearsal").delete()
token = generate_random_token_personal()
PersonalAPIKey.objects.create(user=user, label="rehearsal", secure_value=hash_key_value(token), mask_value=mask_key_value(token), scopes=["*"])
print("OUT" + json.dumps({"id": team.id, "token": team.api_token, "key": token}))
PY
)
line=$(grep '^OUT' <<< "$out" | sed 's/^OUT//')
[ -n "$line" ] || { echo "$out" | tail -20; exit 1; }
cat > "$ENVF" <<EOF
OLD_ADMIN_EMAIL=$OLD_ADMIN_EMAIL
OLD_ADMIN_PASSWORD=$OLD_ADMIN_PASSWORD
OLD_PROJECT_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$line")
OLD_PROJECT_TOKEN=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$line")
OLD_PERSONAL_API_KEY=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['key'])" "$line")
EOF
grep -E '^OLD_PROJECT_(ID|TOKEN)' "$ENVF"
