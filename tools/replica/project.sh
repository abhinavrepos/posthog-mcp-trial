#!/usr/bin/env bash
set -euo pipefail
cd -- "${POSTHOG_DIR:-/opt/posthog}"
python3 - <<'PY'
import shutil
if shutil.disk_usage('.').free < 25 * 1024**3:
    raise SystemExit('STOP: less than 25 GiB free on the PostHog filesystem')
PY
extra=()
if [[ -n ${REPLICA_ORGANIZATION_ID:-} ]]; then
    extra=(-e "REPLICA_ORGANIZATION_ID=$REPLICA_ORGANIZATION_ID")
fi
echo 'Creating/reusing Reval replica in the existing organisation; enabling session recordings.' >&2
docker compose exec -T "${extra[@]}" web python manage.py shell <<'PY'
import json, os
from django.db import transaction, connection
from posthog.models import Team, User, Organization
with transaction.atomic():
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(782435902)")
    org_id = os.environ.get('REPLICA_ORGANIZATION_ID')
    orgs = Organization.objects.filter(id=org_id) if org_id else Organization.objects.all()
    if orgs.count() != 1:
        raise RuntimeError('Expected one organisation. Set REPLICA_ORGANIZATION_ID when running project.sh if ambiguous.')
    org = orgs.first()
    matches = Team.objects.filter(organization=org, name='Reval replica')
    if matches.count() > 1:
        raise RuntimeError('Multiple Reval replica projects in organisation; resolve ambiguity first')
    team = matches.first()
    if not team:
        user = User.objects.filter(organization_membership__organization=org).order_by('id').first()
        if not user:
            raise RuntimeError('No user belongs to the existing organisation')
        team = Team.objects.create_with_data(organization=org, name='Reval replica', initiating_user=user)
    team.session_recording_opt_in = True
    team.save(update_fields=['session_recording_opt_in'])
    print('REPLICA_PROJECT ' + json.dumps({'team_id':team.id, 'api_token':team.api_token}))
PY
