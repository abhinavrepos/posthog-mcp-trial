#!/usr/bin/env bash
# Upgrade a self-hosted (hobby) PostHog in place, on top of its own data, to the exact version pinned
# in versions/ (the one tested), tuned with ../posthog/scale.sh.
#
#   sudo ./posthog-upgrade.sh                # in the PostHog folder (or set POSTHOG_DIR); all phases
#   sudo ./posthog-upgrade.sh verify         # run one phase again
#   sudo ./posthog-upgrade.sh rollback       # put back the backup taken in phase 3
#
# It follows PostHog's own bin/upgrade-hobby step for step, but pinned, without questions, with a backup
# and a before/after check, and with fixes for problems the rehearsal found in PostHog's upgrade path:
#   - it removes the old Postgres volume by its real name (compose names it <project>_postgres-data;
#     upgrade-hobby runs `docker volume rm postgres-data`, which finds nothing, and Postgres 15 then
#     refuses to start on the Postgres 12 files);
#   - it restores Postgres before starting PostHog (upgrade-hobby starts the whole stack first, so the
#     web container builds an empty database that the restore then has to drop while it is in use);
#   - it migrates a database from before September 2026 through the last version before PostHog's
#     migration squash first (phase 8); without that, the new version's migrations stop part way
#     (InvalidBasesError at posthog.1019, then a missing table at posthog.1032) and PostHog never starts;
#   - it runs PostHog's ClickHouse migrations with columns added early where an old migration needs them
#     (phase 9); otherwise migration 0140 stops on columns that only 2026 migrations add;
#   - it runs migrate-storage-hobby one service at a time, skipping buckets 2025 never had (run whole, it
#     stops at the missing ai-blobs bucket and copies nothing after it);
#   - it also copies replays stored under session_recording_batches/ (what a 2025 project with "legacy"
#     replay retention used) into the replay store; PostHog's migrate-storage-hobby copies only
#     session_recordings/ there, so those replays would no longer play.
#
# Phases (each records when it finished; running again continues where it stopped):
#   1 check      versions, volumes, free disk, MinIO image, and that events have stopped
#   2 before     counts of everything that must survive (events per day, persons, replays, files, rows)
#   3 backup     pg_dumpall, the install's files, and (unless SKIP_VOLUME_BACKUP=1) every data volume
#   4 source     the pinned PostHog source in ./posthog
#   5 configure  .env and compose files, exactly as upgrade-hobby writes them, plus the pinned images
#   6 pull       the pinned images
#   7 postgres   Postgres 12 -> 15: new volume, restore the dump (skipped when already on 15)
#   8 stone      databases from before Sep 2026: migrate with the last version before PostHog's migration
#                squash first (see phase 8); without it the new version's migrations stop part way
#   9 clickhouse PostHog's database and ClickHouse migrations; adds columns some old ClickHouse migrations
#                need early (see phase 9)
#  10 start      start PostHog through ../posthog/scale.sh (current Node image, partitions, health checks,
#                sizing)
#  11 storage    MinIO -> SeaweedFS with PostHog's migrate-storage-hobby, plus the legacy replay folder
#  12 verify     counts again, compared with phase 2. Prints RESULT: PASS or FAIL
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ONLY="${1:-}"
POSTHOG_DIR="${POSTHOG_DIR:-$PWD}"
cd "$POSTHOG_DIR"
[ -f .env ] && [ -f docker-compose.yml ] || { echo "Run this in the PostHog folder (with .env and docker-compose.yml), or set POSTHOG_DIR."; exit 1; }
. "$HERE/versions/versions.env"
STATE="$POSTHOG_DIR/upgrade-state"
BACKUP_DIR="${BACKUP_DIR:-$POSTHOG_DIR/upgrade-backup}"
mkdir -p "$STATE/done" "$BACKUP_DIR"
exec > >(tee -a "$STATE/upgrade.log") 2>&1
MINIO_IMAGE="quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z"

if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
say() { echo "$(date -u +%H:%M:%S) $*"; }
dc() { "${DC[@]}" "$@"; }
remember() { echo "$2" > "$STATE/$1"; }
recall() { cat "$STATE/$1" 2>/dev/null || true; }
phase() {
    if [ -n "$ONLY" ] && [ "$ONLY" != "$1" ]; then return 1; fi
    if [ -z "$ONLY" ] && [ -f "$STATE/done/$1" ]; then say "phase $1 already finished"; return 1; fi
    say "== $1"
}
finish() { touch "$STATE/done/$1"; say "phase $1 finished"; }
envset() { # KEY VALUE: set or add a line in .env
    if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
web_python() { # run a python file from this folder inside the running web container
    local f="$1"; shift
    docker cp "$HERE/$f" "$(dc ps -q web | head -1):/tmp/$f" >/dev/null
    dc exec -T "$@" web python "/tmp/$f"
}
wait_web() {
    say "waiting for PostHog to answer (its migrations run first)"
    for _ in $(seq 1 720); do
        if dc exec -T web python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/_health', timeout=5).status == 200 else 1)" >/dev/null 2>&1; then say "PostHog is up"; return 0; fi
        sleep 5
    done
    echo "PostHog did not come up in an hour. See: docker compose logs web"; exit 1
}

# ---------------------------------------------------------------- rollback (only when asked)
if [ "$ONLY" = rollback ]; then
    PROJECT=$(recall project)
    [ -f "$BACKUP_DIR/install-files.tgz" ] || { echo "No backup in $BACKUP_DIR."; exit 1; }
    say "stopping PostHog and putting back the backup from $BACKUP_DIR"
    dc down --remove-orphans || true
    tar -xzf "$BACKUP_DIR/install-files.tgz"
    if [ -f "$BACKUP_DIR/volumes/list.txt" ]; then
        # Every volume of the install comes back as it was, ZooKeeper included: ClickHouse keeps part of
        # its bookkeeping there, and restoring ClickHouse without it sets its data parts aside as broken.
        while read -r v; do
            docker volume rm -f "$v" >/dev/null 2>&1 || true
            docker volume create --label com.docker.compose.project="$PROJECT" --label com.docker.compose.volume="${v#"${PROJECT}"_}" "$v" >/dev/null
            docker run --rm -v "$v:/v" -v "$BACKUP_DIR/volumes:/b:ro" alpine sh -c "cd /v && tar -xf /b/$v.tar"
            say "    restored volume $v"
        done < "$BACKUP_DIR/volumes/list.txt"
        # Volumes the new version created (SeaweedFS, for example) go, so a new attempt starts clean.
        for v in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
            grep -qx "$v" "$BACKUP_DIR/volumes/list.txt" || { docker volume rm "$v" >/dev/null && say "    removed $v (created by the upgrade)"; }
        done
    else
        say "no volume backups (SKIP_VOLUME_BACKUP was set): restore your VM snapshot instead"
    fi
    git -C posthog checkout -q "$(recall old_commit)" 2>/dev/null || true
    rm -rf "$STATE/done"
    say "rolled back. Start the old version with: docker compose up -d"
    exit 0
fi

# ---------------------------------------------------------------- 1 check
if phase check; then
    dc ps --status running --services | grep -qx db || { echo "PostHog is not running. Start it first (docker compose up -d)."; exit 1; }
    PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$(dc ps -q db | head -1)")
    remember project "$PROJECT"
    remember old_commit "$(git -C posthog rev-parse HEAD 2>/dev/null || echo unknown)"
    remember old_pg "$(docker inspect -f '{{.Config.Image}}' "$(dc ps -q db | head -1)")"
    [ -f posthog/posthog/version.py ] && remember async_check TRUE || remember async_check FALSE
    say "PostHog now: $(grep -E '^POSTHOG_APP_TAG=' .env | cut -d= -f2-) (source $(recall old_commit | cut -c1-10)), Postgres $(recall old_pg), compose project '$PROJECT'"
    say "upgrading to: $TARGET_COMMIT"
    for v in postgres-data clickhouse-data; do
        docker volume inspect "${PROJECT}_$v" >/dev/null 2>&1 || { echo "Volume ${PROJECT}_$v not found. Stop: the data may live in anonymous volumes (see upgrade-hobby's warning)."; exit 1; }
    done
    minio_vol=""
    for v in $(docker volume ls -q | grep -E "^${PROJECT}_"); do
        docker run --rm -v "$v:/data:ro" alpine test -d /data/.minio.sys 2>/dev/null && minio_vol="$v"
    done
    remember minio_volume "$minio_vol"
    say "MinIO volume: ${minio_vol:-none (nothing to copy)}"
    if [ -n "$minio_vol" ] && ! docker image inspect "$MINIO_IMAGE" >/dev/null 2>&1; then
        if docker image inspect minio/minio:RELEASE.2025-04-22T22-12-26Z >/dev/null 2>&1; then
            docker tag minio/minio:RELEASE.2025-04-22T22-12-26Z "$MINIO_IMAGE"
            say "tagged the local MinIO image as $MINIO_IMAGE (MinIO no longer publishes it)"
        else
            echo "MinIO image $MINIO_IMAGE is needed to copy the old files, and MinIO no longer publishes it."
            echo "Build it with: docker build -t $MINIO_IMAGE $HERE/minio-image"; exit 1
        fi
    fi
    used_mb=$(docker run --rm -v "${PROJECT}_postgres-data:/a:ro" -v "${PROJECT}_clickhouse-data:/b:ro" ${minio_vol:+-v "$minio_vol:/c:ro"} alpine du -sm /a /b ${minio_vol:+/c} | awk '{s+=$1} END {print s}')
    free_mb=$(( $(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}') / 1024 ))
    need_mb=$(( ${SKIP_VOLUME_BACKUP:-0} == 1 ? used_mb / 4 + 30000 : used_mb * 2 + 30000 ))
    say "data volumes: ${used_mb} MB; free: ${free_mb} MB; needed (backup, new images, copied files): about ${need_mb} MB"
    [ "$free_mb" -ge "$need_mb" ] || { echo "Not enough disk. Free space, or set SKIP_VOLUME_BACKUP=1 if you have a VM snapshot."; exit 1; }
    a=$(dc exec -T clickhouse clickhouse-client -q "SELECT count() FROM posthog.events WHERE _timestamp > now() - INTERVAL 10 MINUTE")
    sleep 30
    b=$(dc exec -T clickhouse clickhouse-client -q "SELECT count() FROM posthog.events WHERE _timestamp > now() - INTERVAL 10 MINUTE")
    if [ "$b" -gt "$a" ]; then say "events are still arriving: stop the apps sending them first"; [ "${ALLOW_LIVE:-0}" = 1 ] || exit 1; fi
    finish check
fi
PROJECT=$(recall project)

# ---------------------------------------------------------------- 2 before
if phase before; then
    web_python counts.py -e STORES=general > "$STATE/before.json"
    python3 -c "
import json; d = json.load(open('$STATE/before.json'))
print('    events:', sum(d['events'].values()), '| persons:', sum(d['persons'].values()), '| replays:', {t: r['recordings'] for t, r in d['replays'].items()}, '| files:', len(d['storage']['general']))"
    finish before
fi

# ---------------------------------------------------------------- 3 backup
if phase backup; then
    tar -czf "$BACKUP_DIR/install-files.tgz" .env docker-compose*.yml compose $( [ -f .env.services ] && echo .env.services )
    say "Postgres dump (as upgrade-hobby takes it)"
    dc exec -T db pg_dumpall --clean -U posthog | gzip > "$BACKUP_DIR/pg_dumpall.sql.gz.partial"
    gunzip -t "$BACKUP_DIR/pg_dumpall.sql.gz.partial"
    [ "$(stat -c%s "$BACKUP_DIR/pg_dumpall.sql.gz.partial")" -gt 1000 ] || { echo "The Postgres dump is empty."; exit 1; }
    mv "$BACKUP_DIR/pg_dumpall.sql.gz.partial" "$BACKUP_DIR/pg_dumpall.sql.gz"
    say "    $(du -h "$BACKUP_DIR/pg_dumpall.sql.gz" | cut -f1)"
    if [ "${SKIP_VOLUME_BACKUP:-0}" != 1 ]; then
        say "stopping PostHog to copy its data volumes unchanged"
        dc stop
        mkdir -p "$BACKUP_DIR/volumes"
        # All of the install's volumes: ClickHouse's replicated tables also keep state in ZooKeeper, so a
        # backup of ClickHouse alone cannot be restored cleanly.
        docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | sort > "$BACKUP_DIR/volumes/list.txt"
        while read -r v; do
            [ -f "$BACKUP_DIR/volumes/$v.tar" ] && continue
            docker run --rm -v "$v:/v:ro" -v "$BACKUP_DIR/volumes:/b" alpine sh -c "cd /v && tar -cf /b/$v.tar.partial . && mv /b/$v.tar.partial /b/$v.tar"
            say "    $v: $(du -h "$BACKUP_DIR/volumes/$v.tar" | cut -f1)"
        done < "$BACKUP_DIR/volumes/list.txt"
    fi
    finish backup
fi

# ---------------------------------------------------------------- 4 source
if phase source; then
    if [ -d posthog/.git ]; then
        git -C posthog fetch -q --depth 1 origin "$TARGET_COMMIT"
        git -C posthog checkout -q -f FETCH_HEAD
    else
        mv posthog "posthog.before-upgrade.$(date +%s)" 2>/dev/null || true
        git init -q posthog && git -C posthog remote add origin https://github.com/PostHog/posthog.git
        git -C posthog fetch -q --depth 1 origin "$TARGET_COMMIT" && git -C posthog checkout -q FETCH_HEAD
    fi
    [ "$(git -C posthog rev-parse HEAD)" = "$TARGET_COMMIT" ] || { echo "Could not check out $TARGET_COMMIT."; exit 1; }
    say "source now at $TARGET_COMMIT"
    finish source
fi

# ---------------------------------------------------------------- 5 configure
if phase configure; then
    # .env changes, in the order upgrade-hobby makes them.
    tmp="$(mktemp)"
    awk '
      /^[[:space:]]*($|#)/ { print; next }
      { p = index($0, "="); if (!p) { print; next }
        key = substr($0,1,p-1); val = substr($0,p+1)
        sub(/^[[:space:]]+/,"",key); sub(/[[:space:]]+$/,"",key); sub(/^[[:space:]]+/,"",val); sub(/[[:space:]]+$/,"",val)
        if (val ~ /^".*"$/ || val ~ /^'\''.*'\''$/) { print key "=" val; next }
        if (val ~ /[[:space:],]|:\/\//) { gsub(/"/, "\\\"", val); print key "=\"" val "\"" } else { print key "=" val } }
    ' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
    domain=$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d '"')
    grep -qE '^CADDY_HOST=' .env || echo "CADDY_HOST=\"$domain, http://, https://\"" >> .env
    grep -qE '^CADDY_TLS_BLOCK=' .env || echo "CADDY_TLS_BLOCK=\"$(grep -E '^TLS_BLOCK=' .env | cut -d= -f2- | tr -d '"')\"" >> .env
    key=$(grep -E '^ENCRYPTION_SALT_KEYS=' .env | cut -d= -f2- | tr -d '"' || true)
    if [ -z "$key" ]; then echo "ENCRYPTION_SALT_KEYS=$(openssl rand -hex 16)" >> .env
    elif ! [[ $key =~ ^[A-Za-z0-9_-]{32}$ ]]; then echo "ENCRYPTION_SALT_KEYS is not in the format the new version needs; stop and fix it (see upgrade-hobby)."; exit 1; fi
    for k in $(grep -oE '^for key in [A-Z_ ]+; do' posthog/bin/upgrade-hobby | sed -E 's/^for key in (.*); do/\1/'); do
        grep -qE "^$k=.+" .env || echo "$k=$(openssl rand -hex 32)" >> .env
    done
    envset OBJECT_STORAGE_MINIO_REMOVED acknowledged
    envset REGISTRY_URL posthog/posthog
    envset POSTHOG_APP_TAG "$TARGET_COMMIT"
    mkdir -p share
    if [ ! -f share/GeoLite2-City.mmdb ]; then
        curl -sL 'https://mmdbcdn.posthog.net/' --http1.1 | brotli --decompress --output=share/GeoLite2-City.mmdb && echo "{\"date\": \"$(date +%Y-%m-%d)\"}" > share/GeoLite2-City.json || say "GeoIP download failed; GeoIP stays off until share/GeoLite2-City.mmdb exists"
    fi
    # Compose files, rendered from the new source the way upgrade-hobby renders them.
    cp posthog/docker-compose.base.yml docker-compose.base.yml
    [ -f posthog/.env.services ] && cp posthog/.env.services .env.services
    ( set -a; . ./.env; set +a; bash posthog/bin/helpers/render-hobby-compose.sh < posthog/docker-compose.hobby.yml > docker-compose.yml.new )
    mv docker-compose.yml.new docker-compose.yml
    mkdir -p compose
    printf '#!/bin/bash\n./compose/wait\n./bin/migrate\n./bin/docker-server\n' > compose/start
    [ -f compose/temporal-django-worker ] || printf '#!/bin/bash\n./bin/temporal-django-worker\n' > compose/temporal-django-worker
    chmod +x compose/start compose/temporal-django-worker
    cp "$HERE/versions/docker-compose.pinned.yml" docker-compose.pinned.yml
    files="docker-compose.yml"; [ -f docker-compose.override.yml ] && files="$files:docker-compose.override.yml"
    # EXTRA_COMPOSE_FILES: site-specific compose files to keep (colon-separated), applied last.
    files="$files:docker-compose.pinned.yml${EXTRA_COMPOSE_FILES:+:$EXTRA_COMPOSE_FILES}"
    envset COMPOSE_FILE "$files"
    [ -n "${EXTRA_COMPOSE_FILES:-}" ] && envset EXTRA_COMPOSE_FILES "$EXTRA_COMPOSE_FILES"
    dc config -q
    say "compose files: $files"
    finish configure
fi

# ---------------------------------------------------------------- 6 pull
if phase pull; then
    dc pull -q
    docker pull -q "$NODE_BASE_IMAGE" >/dev/null
    finish pull
fi

# ---------------------------------------------------------------- 7 postgres
if phase postgres; then
    if grep -q 'postgres:12' <<< "$(recall old_pg)"; then
        [ -s "$BACKUP_DIR/pg_dumpall.sql.gz" ] && gunzip -t "$BACKUP_DIR/pg_dumpall.sql.gz" || { echo "No good Postgres dump; run phase backup."; exit 1; }
        say "Postgres 12 -> 15: new volume, then restore (before anything else starts)"
        dc down
        docker volume rm "${PROJECT}_postgres-data" >/dev/null
        dc up -d db
        for _ in $(seq 1 60); do dc exec -T db pg_isready -U posthog >/dev/null 2>&1 && break; sleep 2; done
        gunzip -c "$BACKUP_DIR/pg_dumpall.sql.gz" | dc exec -T db psql -U posthog -d postgres -q > "$STATE/pg_restore.log" 2>&1 || true
        grep -E "ERROR" "$STATE/pg_restore.log" | grep -vE 'role "posthog" already exists|current user cannot be dropped|database "postgres" .*|cannot drop the currently open database|database "[a-z_]+" does not exist' | head -10 || true
        dc exec -T db psql -U posthog -d postgres -qc "ALTER USER posthog WITH PASSWORD 'posthog';" >/dev/null
        teams=$(dc exec -T db psql -U posthog -d posthog -Atc "SELECT count(*) FROM posthog_team")
        want=$(python3 -c "import json; print(json.load(open('$STATE/before.json'))['postgres']['posthog_team'])")
        [ "$teams" = "$want" ] || { echo "Restore incomplete: $teams projects, expected $want. See $STATE/pg_restore.log"; exit 1; }
        say "restored: $teams project(s)"
    else
        say "already on $(recall old_pg); nothing to do"
    fi
    finish postgres
fi

# ---------------------------------------------------------------- 8 stone (database from before Sep 2026)
# PostHog squashed its Django migrations on 8 Sep 2026 (68 products included). A database from before that
# has none of the newer products' migrations, so Django installs those products from their squashed
# migration, which needs every posthog migration up to September 2026 first; but posthog migrations from
# that span need those products' tables. The new version's migrations then stop part way, for example
# InvalidBasesError for ee.EnterpriseEventDefinition at posthog.1019, or a missing posthog_conversations_ticket
# table at posthog.1032. So the database is first migrated by the last version before the squash, whose
# migrations still interleave every product's original migrations, the way continuously upgraded installs
# went. Only its Django migrations run (in a one-off container); nothing else of that version is started.
if phase stone; then
    q() { dc exec -T db psql -U posthog -d posthog -Atc "$1"; }
    dc up -d db redis7 clickhouse kafka >/dev/null 2>&1
    for _ in $(seq 1 60); do dc exec -T db pg_isready -U posthog >/dev/null 2>&1 && break; sleep 2; done
    if [ "$(q "SELECT count(*) FROM django_migrations WHERE app='posthog' AND name='$STEPPING_STONE_LAST_MIGRATION'")" = 1 ]; then
        say "the database is past the stepping stone already"
    else
        say "migrating the database with PostHog $STEPPING_STONE_COMMIT (the last version before the squash) first"
        docker pull -q "$STEPPING_STONE_IMAGE" >/dev/null
        printf 'services:\n    web:\n        image: %s\n' "$STEPPING_STONE_IMAGE" > "$STATE/stone.yml"
        stone_files=(); IFS=: read -ra cf <<< "$(grep -E '^COMPOSE_FILE=' .env | cut -d= -f2-)"
        for f in "${cf[@]}"; do stone_files+=(-f "$f"); done
        stone() { dc "${stone_files[@]}" -f "$STATE/stone.yml" run --rm --no-deps -e SKIP_ASYNC_MIGRATIONS_SETUP=1 web "$@"; }
        if ! stone python manage.py migrate --noinput > "$STATE/stone-migrate.log" 2>&1; then
            if grep -q "InvalidBasesError" "$STATE/stone-migrate.log"; then
                # ee.0038 has to follow posthog.1018 before later posthog migrations. event_definitions.0001
                # changes no tables (it declares where the moved models live), so it is recorded as applied,
                # ee is taken to 0038, and the content types Django adds for event_definitions on the way are
                # removed again so posthog.1018 can rename the originals.
                say "putting ee.0038 before the remaining posthog migrations"
                if [ "$(q "SELECT count(*) FROM django_migrations WHERE app='posthog' AND name='1018_migrate_event_definition_models'")" = 1 ] && [ "$(q "SELECT count(*) FROM django_migrations WHERE app='event_definitions'")" = 0 ]; then
                    q "UPDATE django_content_type SET app_label='posthog' WHERE app_label='event_definitions' AND model IN ('eventdefinition','propertydefinition','eventproperty','eventschema','schemapropertygroup','schemapropertygroupproperty'); DELETE FROM django_migrations WHERE app='posthog' AND name='1018_migrate_event_definition_models';" >/dev/null
                fi
                [ "$(q "SELECT count(*) FROM django_migrations WHERE app='event_definitions'")" = 0 ] && q "INSERT INTO django_migrations (app, name, applied) VALUES ('event_definitions', '0001_initial', now())" >/dev/null
                stone python manage.py migrate ee 0038_alter_enterpriseeventdefinition_eventdefinition_ptr_and_more >> "$STATE/stone-migrate.log" 2>&1
                q "DELETE FROM auth_permission WHERE content_type_id IN (SELECT e.id FROM django_content_type e JOIN django_content_type p ON p.model = e.model AND p.app_label = 'posthog' WHERE e.app_label = 'event_definitions'); DELETE FROM django_content_type e USING django_content_type p WHERE e.app_label = 'event_definitions' AND p.app_label = 'posthog' AND p.model = e.model;" >/dev/null
                stone python manage.py migrate --noinput >> "$STATE/stone-migrate.log" 2>&1 || { tail -25 "$STATE/stone-migrate.log"; echo "The stepping-stone migrations failed; see $STATE/stone-migrate.log"; exit 1; }
            else
                tail -25 "$STATE/stone-migrate.log"; echo "The stepping-stone migrations failed; see $STATE/stone-migrate.log"; exit 1
            fi
        fi
        say "applied $(grep -c '  Applying ' "$STATE/stone-migrate.log" || true) migrations with the stepping stone"
        [ "$(q "SELECT count(*) FROM django_migrations WHERE app='posthog' AND name='$STEPPING_STONE_LAST_MIGRATION'")" = 1 ] || { echo "The stepping stone did not finish; see $STATE/stone-migrate.log"; exit 1; }
    fi
    finish stone
fi

# ---------------------------------------------------------------- 9 clickhouse
# PostHog's own migrations for this version, then its ClickHouse migrations through clickhouse_catchup.py:
# from ClickHouse migration 0139 (September 2025) several of them recreate views with columns that only
# later migrations add, and stop; the catch-up adds each such column early, with PostHog's own definition.
if phase clickhouse; then
    dc up -d db redis7 clickhouse kafka zookeeper >/dev/null 2>&1
    for _ in $(seq 1 60); do dc exec -T db pg_isready -U posthog >/dev/null 2>&1 && break; sleep 2; done
    say "PostHog's database migrations"
    dc run --rm --no-deps -e SKIP_ASYNC_MIGRATIONS_SETUP=1 web python manage.py migrate --noinput > "$STATE/django-migrate.log" 2>&1 \
        || { tail -25 "$STATE/django-migrate.log"; echo "PostHog's database migrations failed; see $STATE/django-migrate.log"; exit 1; }
    say "    applied $(grep -c '  Applying ' "$STATE/django-migrate.log" || true)"
    say "PostHog's ClickHouse migrations"
    STATE_DIR="$STATE" POSTHOG_SRC=posthog python3 "$HERE/clickhouse_catchup.py"
    finish clickhouse
fi

# ---------------------------------------------------------------- 10 start
# Started through ../posthog/scale.sh, so every service comes up once, on the right images and settings:
# PostHog's Docker Hub Node image is months old and would crash-loop until replaced.
if phase start; then
    if [ "$(recall async_check)" = TRUE ]; then dc up -d db redis7 clickhouse && dc run --rm asyncmigrationscheck; fi
    dc up -d --remove-orphans db redis7 clickhouse kafka >/dev/null 2>&1   # the old redis 6.2 and cyclotron-janitor are gone
    NODE_BASE_IMAGE="$NODE_BASE_IMAGE" POSTHOG_DIR="$POSTHOG_DIR" bash "$HERE/../posthog/scale.sh"
    wait_web
    finish start
fi

# ---------------------------------------------------------------- 11 storage
if phase storage; then
    if [ -n "$(recall minio_volume)" ]; then
        # PostHog's migrate-storage-hobby, one service at a time: run whole, it stops at the first bucket the
        # old MinIO does not have (ai-blobs, which 2025 versions never created) and copies nothing after it.
        vol=$(recall minio_volume)
        for svc in general-storage ai-blobs session-recordings session-recordings-lts; do
            bucket=posthog; [ "$svc" = ai-blobs ] && bucket=ai-blobs
            if ! docker run --rm -v "$vol:/data:ro" alpine test -d "/data/$bucket"; then say "    $svc: the old MinIO has no $bucket bucket; nothing to copy"; continue; fi
            say "copying $svc with PostHog's migrate-storage-hobby"
            if ! echo y | bash posthog/bin/migrate-storage-hobby --volume "$vol" "$svc" > "$STATE/storage-$svc.log" 2>&1; then
                tail -20 "$STATE/storage-$svc.log"; echo "migrate-storage-hobby $svc failed; see $STATE/storage-$svc.log"; exit 1
            fi
            grep -E "Found [0-9]+ objects|Completed:|Skipped:|Failed:|transferred" "$STATE/storage-$svc.log" | sed 's/^/        /' || true
        done
        # Run whole, it would also copy symbol sets to the replay store, where error tracking reads them, and
        # it never copies session_recording_batches/ there. This adds both.
        say "copying session_recording_batches/ and symbolsets/ into the replay store"
        web_python copy_legacy_replays.py
    else
        say "no MinIO volume; nothing to copy"
    fi
    finish storage
fi

# ---------------------------------------------------------------- 12 verify
if phase verify; then
    web_python counts.py -e STORES=both > "$STATE/after.json"
    python3 "$HERE/compare.py" "$STATE/before.json" "$STATE/after.json" | tee "$STATE/verify.txt"
    grep -q '^RESULT: PASS' "$STATE/verify.txt" || { echo "Differences found: see $STATE/verify.txt. To go back: $0 rollback"; exit 1; }
    finish verify
    say "Upgrade complete and verified. The backup in $BACKUP_DIR can be deleted once you are happy."
fi
