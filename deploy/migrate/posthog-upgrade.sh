#!/usr/bin/env bash
# Upgrade a self-hosted (hobby) PostHog in place, on top of its own data, to the exact version pinned
# in versions/ (the one tested), tuned with ../posthog/scale.sh.
#
#   sudo ./posthog-upgrade.sh                # in the PostHog folder (or set POSTHOG_DIR); all phases
#   sudo ./posthog-upgrade.sh --no-replays   # the same, but leave the session replays in the old MinIO
#   sudo ./posthog-upgrade.sh --yes          # no questions: take the defaults (replays are copied)
#   sudo ./posthog-upgrade.sh status         # which phases are done
#   sudo ./posthog-upgrade.sh replays        # copy the session replays later (after --no-replays), then: verify
#   sudo ./posthog-upgrade.sh verify         # run one phase again (any phase name works)
#   sudo ./posthog-upgrade.sh rollback       # put back the backup taken in phase 3
#   sudo ./posthog-upgrade.sh cleanup        # after you have checked the new version: delete the backups,
#                                            # asking about each one
#
# Safety: the upgrade itself deletes nothing that is not backed up and checked first. It stops at the
# first problem, says where and what is still there, and continues from that phase when run again.
# Backups (the Postgres dump, every data volume, the old Postgres 12 data, the old MinIO volume, the
# replay metadata it changes) stay until `cleanup`, which shows each one and deletes it only when you
# type "delete".
#
# It follows PostHog's own bin/upgrade-hobby step for step, but pinned, with a backup and a before/after
# check, and with fixes for problems the rehearsal found in PostHog's upgrade path:
#   - it removes the old Postgres volume by its real name (compose names it <project>_postgres-data;
#     upgrade-hobby runs `docker volume rm postgres-data`, which finds nothing, and Postgres 15 then
#     refuses to start on the Postgres 12 files), after copying it aside;
#   - it restores Postgres before starting PostHog (upgrade-hobby starts the whole stack first, so the
#     web container builds an empty database that the restore then has to drop while it is in use);
#   - it migrates a database from before September 2026 through the last version before PostHog's
#     migration squash first (phase 8); without that, the new version's migrations stop part way
#     (InvalidBasesError at posthog.1019, then a missing table at posthog.1032) and PostHog never starts;
#   - it runs PostHog's ClickHouse migrations with columns added early where an old migration needs them
#     (phase 9); otherwise migration 0140 stops on columns that only 2026 migrations add;
#   - it runs migrate-storage-hobby one service at a time, skipping buckets 2025 never had (run whole, it
#     stops at the missing ai-blobs bucket and copies nothing after it);
#   - replays of 2025 projects with "legacy" retention (stored under session_recording_batches/) are copied
#     into the replay store and renamed to session_recordings/<period>/..., the only names the new replay
#     reader accepts, with a retention period that keeps every one of them; otherwise they are listed but
#     none of them play, and those older than 30 days disappear.
#
# Phases (each records when it finished; running again continues where it stopped):
#   1 check      versions, volumes, free disk, MinIO image, that events have stopped; asks about replays
#   2 before     counts of everything that must survive (events per day, persons, replays, files, rows)
#   3 backup     pg_dumpall, the install's files, and (unless SKIP_VOLUME_BACKUP=1) every data volume,
#                each checked against its volume, then checksummed
#   4 source     the pinned PostHog source in ./posthog
#   5 configure  .env and compose files, exactly as upgrade-hobby writes them, plus the pinned images
#   6 pull       the pinned images
#   7 postgres   Postgres 12 -> 15: old data copied aside, new volume, restore the dump, every table checked
#   8 stone      databases from before Sep 2026: migrate with the last version before PostHog's migration
#                squash first (see phase 8); without it the new version's migrations stop part way
#   9 clickhouse PostHog's database and ClickHouse migrations; adds columns some old ClickHouse migrations
#                need early (see phase 9)
#  10 start      start PostHog through ../posthog/scale.sh (current Node image, partitions, health checks,
#                sizing)
#  11 storage    MinIO -> SeaweedFS with PostHog's migrate-storage-hobby: every stored file but the replays
#  12 replays    the session replays, legacy ones included (skipped with --no-replays; run it later)
#  13 verify     counts again, compared with phase 2, and every replay played. Prints RESULT: PASS or FAIL
#
# Settings (environment): POSTHOG_DIR, BACKUP_DIR (default ./upgrade-backup), SKIP_VOLUME_BACKUP=1 (only with
# a VM snapshot), REPLAYS=copy|skip (same as --replays / --no-replays), EXTRA_COMPOSE_FILES, ALLOW_LIVE=1,
# PROGRESS_SECONDS (default 30).
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ONLY=""
ASSUME_YES="${ASSUME_YES:-0}"
REPLAYS_FLAG="${REPLAYS:-}"
while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes) ASSUME_YES=1 ;;
        --no-replays|--skip-replays) REPLAYS_FLAG=skip ;;
        --replays) REPLAYS_FLAG=copy ;;
        -h|--help) sed -n '2,/^set -Eeuo/p' "$0" | sed '$d' | sed -E 's/^# ?//'; exit 0 ;;
        -*) echo "Unknown option $1 (see --help)."; exit 2 ;;
        *) [ -z "$ONLY" ] || { echo "Give one phase at a time."; exit 2; }; ONLY="$1" ;;
    esac
    shift
done
PHASES=(check before backup source configure pull postgres stone clickhouse start storage replays verify)
case " ${PHASES[*]} rollback cleanup status " in
    *" ${ONLY:-check} "*) ;;
    *) echo "Unknown phase '$ONLY'. Phases: ${PHASES[*]}; also: status, rollback, cleanup."; exit 2 ;;
esac
case "$REPLAYS_FLAG" in ""|copy|skip) ;; *) echo "REPLAYS must be copy or skip."; exit 2 ;; esac

POSTHOG_DIR="${POSTHOG_DIR:-$PWD}"
# Site compose files recorded by earlier runs (the address override, no-internet.sh) are kept unless given.
EXTRA_COMPOSE_FILES="${EXTRA_COMPOSE_FILES:-$(grep -E '^EXTRA_COMPOSE_FILES=' "$POSTHOG_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)}"
cd "$POSTHOG_DIR"
[ -f .env ] && [ -f docker-compose.yml ] || { echo "Run this in the PostHog folder (with .env and docker-compose.yml), or set POSTHOG_DIR."; exit 1; }
. "$HERE/versions/versions.env"
STATE="$POSTHOG_DIR/upgrade-state"
BACKUP_DIR="${BACKUP_DIR:-$POSTHOG_DIR/upgrade-backup}"
mkdir -p "$STATE/done" "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
exec > >(tee -a "$STATE/upgrade.log") 2>&1
MINIO_IMAGE="quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z"
EVERY="${PROGRESS_SECONDS:-30}"
RUN_T0=$(date +%s)
PHASE_T0=$RUN_T0
CURRENT=""

if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
say() { echo "$(date -u +%H:%M:%S) $*"; }
dc() { "${DC[@]}" "$@"; }
remember() { echo "$2" > "$STATE/$1"; }
recall() { cat "$STATE/$1" 2>/dev/null || true; }
elapsed() { local s=$(( $(date +%s) - $1 )); if [ "$s" -ge 3600 ]; then printf '%dh%02dm' $((s / 3600)) $((s % 3600 / 60)); else printf '%dm%02ds' $((s / 60)) $((s % 60)); fi; }
if [ -n "$REPLAYS_FLAG" ] && [ "$ONLY" != status ]; then remember replays "$REPLAYS_FLAG"; fi

# ---------------------------------------------------------------- questions
# ask QUESTION DEFAULT(y|n): 0 for yes. With --yes it takes the default without asking.
ask() {
    local a
    if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
    [ -t 0 ] || { echo "This needs an answer: $1"; echo "Run the script in a terminal, or pass --yes to take the defaults."; exit 1; }
    read -r -p "$1 $( [ "$2" = y ] && echo '[Y/n]' || echo '[y/N]') " a || true
    [[ ${a:-$2} =~ ^[yY]([eE][sS])?$ ]]
}
# confirm QUESTION: yes with --yes, otherwise asks (default no).
confirm() { [ "$ASSUME_YES" = 1 ] && return 0; ask "$1" n; }

# ---------------------------------------------------------------- failures
# Any failed command stops the run (set -e). Before exiting it says which phase stopped, that nothing was
# deleted, and how to continue or go back.
trap 'echo "  x failed (line $LINENO): $BASH_COMMAND"' ERR
backup_state() {
    if [ -f "$BACKUP_DIR/SHA256SUMS" ]; then echo "the before-upgrade backup in $BACKUP_DIR is complete and checksummed."
    elif [ -f "$STATE/done/backup" ] && [ -f "$BACKUP_DIR/volumes/list.txt" ]; then echo "the before-upgrade backup is in $BACKUP_DIR (taken without checksums)."
    elif [ -f "$STATE/done/backup" ]; then echo "the before-upgrade Postgres dump is in $BACKUP_DIR (volumes were not backed up: SKIP_VOLUME_BACKUP=1, use your VM snapshot)."
    else echo "nothing had been changed yet."; fi
}
on_exit() {
    local rc=$?
    if [ "$rc" = 0 ] || [ -z "$CURRENT" ]; then return; fi
    echo
    say "STOPPED in phase $CURRENT (exit code $rc), after $(elapsed "$PHASE_T0") in this phase."
    say "Nothing has been deleted; $(backup_state)"
    [ "$CURRENT" = backup ] && say "PostHog may be stopped for the backup: run the script again to finish it, or start the old version as it was: ${DC[*]} up -d"
    say "Fix the cause shown above (everything is in $STATE/upgrade.log), then run the script again:"
    say "it continues with phase $CURRENT. To go back to the version you had instead: $0 rollback"
}
trap on_exit EXIT

# ---------------------------------------------------------------- progress
# watch_run LOG STATUS COMMAND...: runs COMMAND with its output in LOG, and every $EVERY seconds prints the
# line the function STATUS makes from it. Returns COMMAND's exit code.
watch_run() {
    local log="$1" fn="$2" pid t rc=0
    shift 2
    t=$(date +%s)
    "$@" > "$log" 2>&1 < /dev/null &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        for _ in $(seq "$EVERY"); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
        if kill -0 "$pid" 2>/dev/null; then say "    ... $(elapsed "$t"): $("$fn" "$log" 2>/dev/null || true)"; fi
    done
    wait "$pid" || rc=$?
    return "$rc"
}
TOTAL="?"
p_django() { # Django's "  Applying app.name... OK" lines
    local n now
    n=$(grep -c '  Applying ' "$1" || true)
    now=$(grep -o 'Applying [^ ]*' "$1" | tail -1 | cut -d' ' -f2 | sed 's/\.\.\.$//')
    echo "$n of $TOTAL database migrations applied${now:+ (now: $now)}"
}
p_clickhouse() {
    local at now
    at=$(dc exec -T clickhouse clickhouse-client -q "SELECT max(module_name) FROM posthog.infi_clickhouse_orm_migrations" < /dev/null | cut -c1-4)
    now=$(grep -ho 'Applying migration [^ .]*' "$(ls -t "$STATE"/clickhouse-migrate-*.log | head -1)" | tail -1 | cut -d' ' -f3)
    echo "ClickHouse migration ${at:-?} done of $CH_LAST${now:+ (now: $now)}"
}
p_size() { [ -f "$PROGRESS_FILE" ] && echo "$PROGRESS_WHAT: $(( $(stat -c%s "$PROGRESS_FILE") / 1048576 )) MB${PROGRESS_OF:+ of about $PROGRESS_OF MB}"; }
p_restore() { # how far gunzip has read the dump
    local pid fd pos="" size
    size=$(stat -c%s "$BACKUP_DIR/pg_dumpall.sql.gz")
    pid=$(pgrep -f "gunzip -c $BACKUP_DIR/pg_dumpall.sql.gz" | head -1)
    for fd in /proc/"$pid"/fd/*; do
        [ "$(readlink "$fd")" = "$BACKUP_DIR/pg_dumpall.sql.gz" ] && pos=$(awk '/^pos:/ {print $2}' "/proc/$pid/fdinfo/${fd##*/}")
    done
    [ -n "$pos" ] && echo "restored $(( pos * 100 / size ))% of the dump"
}
p_lines() { echo "$(wc -l < "$PROGRESS_FILE" 2>/dev/null || echo 0) of $PROGRESS_OF $PROGRESS_WHAT"; }
p_images() {
    local have=0 n=0 i
    for i in $IMAGES; do n=$((n + 1)); docker image inspect "$i" >/dev/null 2>&1 && have=$((have + 1)); done
    echo "$have of $n images here"
}
p_storage() { tr '\r' '\n' < "$1" | grep -E '\] [0-9]+% \|' | tail -1 | sed -E 's/^\[[^]]*\] //; s/ \| ⏱.*remaining//' || true; }

# ---------------------------------------------------------------- phases
phase_about() {
    case "$1" in
        check) echo "versions, volumes, disk, MinIO image, events stopped" ;;
        before) echo "counting everything that must survive" ;;
        backup) echo "backing up; PostHog is stopped from here until phase start" ;;
        source) echo "PostHog source at the pinned commit" ;;
        configure) echo ".env and compose files" ;;
        pull) echo "downloading the pinned images (5-10 min)" ;;
        postgres) echo "Postgres 12 -> 15 (about 1 min per GB of dump)" ;;
        stone) echo "database migrations up to PostHog's migration squash (45 min in the rehearsal)" ;;
        clickhouse) echo "the new version's database and ClickHouse migrations (37 min in the rehearsal)" ;;
        start) echo "starting the new version (7 min in the rehearsal)" ;;
        storage) echo "copying stored files from MinIO to SeaweedFS" ;;
        replays) echo "copying the session replays" ;;
        verify) echo "comparing everything with phase before, playing every replay" ;;
    esac
}
phase() {
    local i
    if [ -n "$ONLY" ] && [ "$ONLY" != "$1" ]; then return 1; fi
    if [ -z "$ONLY" ] && [ -f "$STATE/done/$1" ]; then say "phase $1 already finished"; return 1; fi
    for i in "${!PHASES[@]}"; do [ "${PHASES[$i]}" = "$1" ] && break; done
    CURRENT="$1"
    PHASE_T0=$(date +%s)
    echo
    say "== phase $((i + 1)) of ${#PHASES[@]}: $1 - $(phase_about "$1")   [$(elapsed "$RUN_T0") since this run started]"
}
finish() { touch "$STATE/done/$1"; say "phase $1 finished in $(elapsed "$PHASE_T0")"; CURRENT=""; }
# Phases that change data refuse to run without the finished, checked backup.
require_backup() {
    [ -f "$STATE/done/backup" ] || { echo "Phase backup has not finished; nothing is changed without it."; exit 1; }
    if [ "$(recall volume_backup)" = yes ] && [ ! -f "$BACKUP_DIR/SHA256SUMS" ]; then echo "The volume backup in $BACKUP_DIR is not complete (no SHA256SUMS); run phase backup again."; exit 1; fi
}
envset() { # KEY VALUE: set or add a line in .env
    if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
web_python() { # run a python file from this folder inside the running web container
    local f="$1" web
    shift
    web=$(dc ps -q --status running web | head -1)
    [ -n "$web" ] || { echo "PostHog's web service is not running (${DC[*]} ps web; ${DC[*]} logs web). Start it, then run the script again."; return 1; }
    docker cp "$HERE/$f" "$web:/tmp/$f" >/dev/null
    dc exec -T "$@" web python -u "/tmp/$f" < /dev/null
}
wait_web() {
    local t i
    t=$(date +%s)
    say "waiting for PostHog to answer (its migrations run first)"
    for i in $(seq 1 720); do
        if dc exec -T web python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/_health', timeout=5).status == 200 else 1)" >/dev/null 2>&1 < /dev/null; then say "PostHog is up"; return 0; fi
        if [ $((i % 12)) = 0 ]; then say "    ... $(elapsed "$t"): not answering yet; $(dc ps --status running --services 2>/dev/null | wc -l) services running"; fi
        sleep 5
    done
    echo "PostHog did not come up in an hour. See: ${DC[*]} logs web"
    exit 1
}
vsize() { docker run --rm -v "$1:/v:ro" alpine du -sh /v 2>/dev/null | cut -f1; }
# The Django migrations a web image would apply now, without applying them; empty when it cannot tell.
PLAN_PY='import os,django;os.environ.setdefault("DJANGO_SETTINGS_MODULE","posthog.settings");django.setup();from django.db import connection;from django.db.migrations.executor import MigrationExecutor as E;e=E(connection);print("PENDING",len(e.migration_plan(e.loader.graph.leaf_nodes())))'
pending() { "$@" python -c "$PLAN_PY" 2>/dev/null < /dev/null | grep -oE '^PENDING [0-9]+' | cut -d' ' -f2 | tail -1 || true; }

# ---------------------------------------------------------------- status (only when asked)
if [ "$ONLY" = status ]; then
    for p in "${PHASES[@]}"; do
        if [ -f "$STATE/done/$p" ]; then echo "  done     $p   ($(date -u -r "$STATE/done/$p" '+%Y-%m-%d %H:%M UTC'))"
        elif [ "$p" = replays ] && [ "$(recall replays)" = skip ]; then echo "  skipped  $p   (--no-replays; run '$0 replays' to copy them)"
        else echo "  to do    $p"; fi
    done
    r=$(recall replays)
    echo "session replays: ${r:-not decided yet}"
    echo "backup: $(backup_state)"
    exit 0
fi

# ---------------------------------------------------------------- rollback (only when asked)
if [ "$ONLY" = rollback ]; then
    PROJECT=$(recall project)
    [ -n "$PROJECT" ] || { echo "No upgrade state in $STATE; nothing to roll back."; exit 1; }
    [ -f "$BACKUP_DIR/install-files.tgz" ] || { echo "No backup in $BACKUP_DIR."; exit 1; }
    if [ ! -f "$BACKUP_DIR/volumes/list.txt" ]; then
        echo "There are no volume backups (SKIP_VOLUME_BACKUP was set): restore your VM snapshot instead."
        exit 1
    fi
    if [ -f "$BACKUP_DIR/SHA256SUMS" ]; then
        say "checking the backup against its checksums before touching anything"
        (cd "$BACKUP_DIR" && sha256sum --quiet -c SHA256SUMS) || { echo "The backup does not match its checksums; nothing was changed."; exit 1; }
        say "    backup intact"
    else
        say "the backup has no checksums (taken by an older version of this script); it is restored unchecked"
    fi
    say "This puts back PostHog as it was before the upgrade (backup from $(date -u -r "$BACKUP_DIR/install-files.tgz" '+%Y-%m-%d %H:%M UTC')),"
    say "replacing everything the new version has recorded since."
    confirm "Roll back now?" || { say "nothing changed"; exit 0; }
    CURRENT=rollback
    say "stopping PostHog and putting back the backup from $BACKUP_DIR"
    dc down --remove-orphans || true
    tar -xzf "$BACKUP_DIR/install-files.tgz"
    # Every volume of the install comes back as it was, ZooKeeper included: ClickHouse keeps part of its
    # bookkeeping there, and restoring ClickHouse without it sets its data parts aside as broken.
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
    git -C posthog checkout -q "$(recall old_commit)" 2>/dev/null || true
    rm -rf "$STATE/done" "$STATE/replays" "$STATE/volume_backup"
    CURRENT=""
    say "rolled back. Start the old version with: ${DC[*]} up -d"
    exit 0
fi

# ---------------------------------------------------------------- cleanup (only when asked)
if [ "$ONLY" = cleanup ]; then
    PROJECT=$(recall project)
    [ -t 0 ] || { echo "cleanup asks before deleting each item; run it in a terminal."; exit 1; }
    [ -f "$STATE/done/verify" ] || { echo "Phase verify has not passed; cleanup deletes nothing before that."; exit 1; }
    if [ -f "$STATE/done/replays" ] && [ "$STATE/done/replays" -nt "$STATE/done/verify" ]; then echo "The replays were copied after the last verify; run '$0 verify' first."; exit 1; fi
    say "Each item below is shown with what deleting it means. Nothing is deleted unless you type delete."
    offer() { # WHAT SIZE MEANING: 0 when the answer is "delete"
        local a
        echo
        echo "  $1  ($2)"
        echo "    $3"
        read -r -p "    Type delete to delete it, or press Enter to keep it: " a || true
        if [ "$a" = delete ]; then return 0; fi
        echo "    kept"
        return 1
    }
    minio=$(recall minio_volume)
    keep="${PROJECT}_postgres12-before-upgrade"
    t=_upgrade_backup_session_replay_events
    if [ "$(dc exec -T clickhouse clickhouse-client -q "EXISTS TABLE posthog.$t" < /dev/null)" = 1 ]; then
        rows=$(dc exec -T clickhouse clickhouse-client -q "SELECT count() FROM posthog.$t" < /dev/null)
        if offer "ClickHouse table posthog.$t" "$rows rows" "The replay metadata of the legacy replays as it was before they were renamed. The renamed replays play (phase verify)."; then
            dc exec -T clickhouse clickhouse-client -q "DROP TABLE posthog.$t" < /dev/null && say "    deleted"
        fi
    fi
    used=" $(dc config --volumes 2>/dev/null | sed "s/^/${PROJECT}_/" | tr '\n' ' ') "
    for v in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
        [ "$v" = "$minio" ] && continue
        [[ $used == *" $v "* ]] && continue
        [ -n "$(docker ps -aq --filter "volume=$v")" ] && continue
        if offer "volume $v" "$(vsize "$v")" "A volume of the old version that no service of the new version uses (the backup has a copy of it)."; then
            docker volume rm "$v" >/dev/null && say "    deleted"
        fi
    done
    if [ -n "$minio" ] && docker volume inspect "$minio" >/dev/null 2>&1; then
        if [ ! -f "$STATE/done/replays" ]; then
            echo
            echo "  volume $minio  ($(vsize "$minio")): kept. The session replays were not copied (--no-replays), so they"
            echo "    exist only there. Copy them first ('$0 replays', then '$0 verify')."
        elif [ -n "$(docker ps -aq --filter "volume=$minio")" ]; then
            echo; echo "  volume $minio: kept, a container still uses it."
        elif offer "volume $minio (the old MinIO)" "$(vsize "$minio")" "Every file and replay of the old version. All were copied to SeaweedFS and checked (phase verify)."; then
            docker volume rm "$minio" >/dev/null && say "    deleted"
        fi
    fi
    if docker volume inspect "$keep" >/dev/null 2>&1; then
        if offer "volume $keep" "$(vsize "$keep")" "The Postgres 12 data files as they were before phase postgres (the backup also has them)."; then
            docker volume rm "$keep" >/dev/null && say "    deleted"
        fi
    fi
    if [ -d "$BACKUP_DIR" ] && [ -n "$(ls -A "$BACKUP_DIR")" ]; then
        if offer "backup folder $BACKUP_DIR" "$(du -sh "$BACKUP_DIR" | cut -f1)" "The before-upgrade backup. After deleting it, '$0 rollback' is no longer possible."; then
            rm -rf "${BACKUP_DIR:?}"/* && say "    deleted"
        fi
    fi
    echo
    say "cleanup done"
    exit 0
fi

# ---------------------------------------------------------------- 1 check
if phase check; then
    dc ps --status running --services | grep -qx db || { echo "PostHog is not running. Start it first (${DC[*]} up -d)."; exit 1; }
    PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$(dc ps -q db | head -1)")
    remember project "$PROJECT"
    remember old_commit "$(git -C posthog rev-parse HEAD 2>/dev/null || echo unknown)"
    remember old_pg "$(docker inspect -f '{{.Config.Image}}' "$(dc ps -q db | head -1)")"
    [ -f posthog/posthog/version.py ] && remember async_check TRUE || remember async_check FALSE
    old_tag=$(grep -E '^POSTHOG_APP_TAG=' .env | cut -d= -f2- || true)
    say "PostHog now: ${old_tag:-latest} (source $(recall old_commit | cut -c1-10)), Postgres $(recall old_pg), compose project '$PROJECT'"
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
            echo "Build it with: docker build -t $MINIO_IMAGE $HERE/minio-image"
            exit 1
        fi
    fi
    pg_mb=$(docker run --rm -v "${PROJECT}_postgres-data:/a:ro" alpine du -sm /a | cut -f1)
    used_mb=$(docker run --rm -v "${PROJECT}_postgres-data:/a:ro" -v "${PROJECT}_clickhouse-data:/b:ro" ${minio_vol:+-v "$minio_vol:/c:ro"} alpine du -sm /a /b ${minio_vol:+/c} | awk '{s+=$1} END {print s}')
    free_mb=$(( $(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}') / 1024 ))
    # backup of every volume, the Postgres 12 copy, the copied files and the new images
    need_mb=$(( ${SKIP_VOLUME_BACKUP:-0} == 1 ? used_mb / 4 + pg_mb + 30000 : used_mb * 2 + pg_mb + 30000 ))
    say "data volumes: ${used_mb} MB; free: ${free_mb} MB; needed (backup, new images, copied files): about ${need_mb} MB"
    [ "$free_mb" -ge "$need_mb" ] || { echo "Not enough disk. Free space, or set SKIP_VOLUME_BACKUP=1 if you have a VM snapshot."; exit 1; }
    a=$(dc exec -T clickhouse clickhouse-client -q "SELECT count() FROM posthog.events WHERE _timestamp > now() - INTERVAL 10 MINUTE" < /dev/null)
    sleep 30
    b=$(dc exec -T clickhouse clickhouse-client -q "SELECT count() FROM posthog.events WHERE _timestamp > now() - INTERVAL 10 MINUTE" < /dev/null)
    if [ "$b" -gt "$a" ]; then say "events are still arriving: stop the apps sending them first"; [ "${ALLOW_LIVE:-0}" = 1 ] || exit 1; fi
    recordings=$(dc exec -T clickhouse clickhouse-client -q "SELECT uniqExact(session_id) FROM posthog.session_replay_events" < /dev/null)
    if [ -z "$minio_vol" ]; then remember replays copy
    elif [ -z "$(recall replays)" ]; then
        echo
        echo "Session replays: $recordings recordings, stored in the old MinIO volume $minio_vol."
        echo "  Yes: they are copied to the new version and every one is played to check it (phase replays)."
        echo "  No:  they stay, untouched, in the old MinIO volume. The new version lists them but cannot play"
        echo "       them until you copy them: '$0 replays', then '$0 verify'."
        if ask "Copy the session replays to the new version?" y; then remember replays copy; else remember replays skip; fi
    fi
    if [ "${SKIP_VOLUME_BACKUP:-0}" = 1 ]; then
        echo
        echo "SKIP_VOLUME_BACKUP=1: only Postgres is backed up. ClickHouse (events, replay metadata), ZooKeeper and"
        echo "the other volumes are not, so only a VM snapshot can undo the upgrade."
        confirm "Is there a snapshot of this machine, taken with events stopped?" || { echo "Take one, or run without SKIP_VOLUME_BACKUP."; exit 1; }
    fi
    echo
    say "Plan:"
    say "  from ${old_tag:-latest} to $TARGET_COMMIT (every image pinned)"
    if [ "${SKIP_VOLUME_BACKUP:-0}" = 1 ]; then say "  backup: the Postgres dump and the install's files in $BACKUP_DIR; the rest is your VM snapshot"
    else say "  backup: the Postgres dump, the install's files and every data volume in $BACKUP_DIR, each checked, then checksummed"; fi
    if [ "$(recall replays)" = copy ]; then say "  session replays: copied ($recordings recordings), then every one played"
    else say "  session replays: NOT copied now; they stay in $minio_vol"; fi
    say "  PostHog is down from phase backup to phase start: about 1.5 to 2 hours in all"
    say "  nothing is deleted without a backup; afterwards '$0 cleanup' asks before deleting each backup"
    confirm "Start the upgrade?" || { CURRENT=""; say "nothing changed"; exit 0; }
    finish check
fi
PROJECT=$(recall project)

# ---------------------------------------------------------------- 2 before
if phase before; then
    web_python counts.py -e STORES=general > "$STATE/before.json.partial"
    mv "$STATE/before.json.partial" "$STATE/before.json"
    python3 -c "
import json; d = json.load(open('$STATE/before.json'))
print('    events:', sum(d['events'].values()), '| persons:', sum(d['persons'].values()), '| replays:', {t: r['recordings'] for t, r in d['replays'].items()}, '| files:', len(d['storage']['general']), '| Postgres tables:', len(d['postgres']))"
    finish before
fi

# ---------------------------------------------------------------- 3 backup
dump_pg() { dc exec -T db pg_dumpall --clean -U posthog | gzip > "$BACKUP_DIR/pg_dumpall.sql.gz.partial"; }
# tar_volume VOLUME: tar the volume, then check the archive reads back whole with as many entries as the
# volume has (sockets aside, which tar skips); only then is it renamed to VOLUME.tar.
tar_volume() {
    docker run --rm -v "$1:/v:ro" -v "$BACKUP_DIR/volumes:/b" alpine sh -c "cd /v && tar -cf '/b/$1.tar.partial' . \
        && f=\$(find . ! -type s | wc -l) && t=\$(tar -tf '/b/$1.tar.partial' | wc -l) && echo \"\$f files and folders, \$t in the backup\" && [ \"\$f\" = \"\$t\" ]"
}
make_sums() { (cd "$BACKUP_DIR" && sha256sum pg_dumpall.sql.gz install-files.tgz volumes/*.tar > SHA256SUMS.partial); }
if phase backup; then
    rm -f "$BACKUP_DIR/SHA256SUMS"
    tar -czf "$BACKUP_DIR/install-files.tgz" .env docker-compose*.yml compose $( [ -f .env.services ] && echo .env.services )
    say "Postgres dump (as upgrade-hobby takes it)"
    PROGRESS_FILE="$BACKUP_DIR/pg_dumpall.sql.gz.partial" PROGRESS_WHAT="dump written (compressed)" PROGRESS_OF=""
    watch_run "$STATE/pg_dump.log" p_size dump_pg || { cat "$STATE/pg_dump.log"; echo "The Postgres dump failed."; exit 1; }
    gunzip -t "$BACKUP_DIR/pg_dumpall.sql.gz.partial"
    gunzip -c "$BACKUP_DIR/pg_dumpall.sql.gz.partial" | tail -5 | grep -q 'PostgreSQL database cluster dump complete' || { echo "The Postgres dump is incomplete (no end marker)."; exit 1; }
    mv "$BACKUP_DIR/pg_dumpall.sql.gz.partial" "$BACKUP_DIR/pg_dumpall.sql.gz"
    say "    $(du -h "$BACKUP_DIR/pg_dumpall.sql.gz" | cut -f1), complete"
    if [ "${SKIP_VOLUME_BACKUP:-0}" != 1 ]; then
        remember volume_backup yes
        say "stopping PostHog to copy its data volumes unchanged"
        dc stop
        mkdir -p "$BACKUP_DIR/volumes"
        # All of the install's volumes: ClickHouse's replicated tables also keep state in ZooKeeper, so a
        # backup of ClickHouse alone cannot be restored cleanly.
        docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | sort > "$BACKUP_DIR/volumes/list.txt"
        n=$(wc -l < "$BACKUP_DIR/volumes/list.txt")
        i=0
        while read -r v; do
            i=$((i + 1))
            if [ -f "$BACKUP_DIR/volumes/$v.tar" ]; then say "    volume $i of $n, $v: backed up already"; continue; fi
            PROGRESS_FILE="$BACKUP_DIR/volumes/$v.tar.partial" PROGRESS_WHAT="$v" PROGRESS_OF=$(docker run --rm -v "$v:/v:ro" alpine du -sm /v | cut -f1)
            watch_run "$STATE/backup-$v.log" p_size tar_volume "$v" || { cat "$STATE/backup-$v.log"; echo "The backup of volume $v is incomplete."; exit 1; }
            mv "$BACKUP_DIR/volumes/$v.tar.partial" "$BACKUP_DIR/volumes/$v.tar"
            say "    volume $i of $n, $v: $(du -h "$BACKUP_DIR/volumes/$v.tar" | cut -f1) ($(tail -1 "$STATE/backup-$v.log"))"
        done < "$BACKUP_DIR/volumes/list.txt"
        say "checksums of the backup (rollback checks them before restoring anything)"
        PROGRESS_FILE="$BACKUP_DIR/SHA256SUMS.partial" PROGRESS_WHAT="files checksummed" PROGRESS_OF=$((n + 2))
        watch_run "$STATE/sha.log" p_lines make_sums || { cat "$STATE/sha.log"; exit 1; }
        mv "$BACKUP_DIR/SHA256SUMS.partial" "$BACKUP_DIR/SHA256SUMS"
        say "    backup complete: $(du -sh "$BACKUP_DIR" | cut -f1) in $BACKUP_DIR"
    else
        remember volume_backup no
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
        # Fails within seconds where there is no internet; GeoIP then stays off.
        curl -fsSL --connect-timeout 5 --max-time 120 'https://mmdbcdn.posthog.net/' --http1.1 | brotli --decompress --output=share/GeoLite2-City.mmdb && echo "{\"date\": \"$(date +%Y-%m-%d)\"}" > share/GeoLite2-City.json || say "GeoIP download failed; GeoIP stays off until share/GeoLite2-City.mmdb exists"
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
pull_all() { dc pull -q && docker pull -q "$NODE_BASE_IMAGE"; }
if phase pull; then
    IMAGES="$(dc config --images | sort -u | tr '\n' ' ') $NODE_BASE_IMAGE"
    watch_run "$STATE/pull.log" p_images pull_all || { tail -20 "$STATE/pull.log"; echo "Downloading the images failed (network?); run the script again to retry."; exit 1; }
    say "    $(p_images)"
    finish pull
fi

# ---------------------------------------------------------------- 7 postgres
restore_pg() { gunzip -c "$BACKUP_DIR/pg_dumpall.sql.gz" | dc exec -T db psql -U posthog -d postgres -q; }
if phase postgres; then
    require_backup
    if grep -q 'postgres:12' <<< "$(recall old_pg)"; then
        [ -s "$BACKUP_DIR/pg_dumpall.sql.gz" ] && gunzip -t "$BACKUP_DIR/pg_dumpall.sql.gz" || { echo "No good Postgres dump; run phase backup."; exit 1; }
        say "Postgres 12 -> 15: old data copied aside, new volume, then restore (before anything else starts)"
        dc down
        keep="${PROJECT}_postgres12-before-upgrade"
        if docker run --rm -v "${PROJECT}_postgres-data:/v:ro" alpine grep -qx 12 /v/PG_VERSION; then
            # The Postgres 12 files are kept in a volume of their own; only `cleanup` deletes it.
            docker volume rm -f "$keep" >/dev/null 2>&1 || true
            docker volume create "$keep" >/dev/null
            docker run --rm -v "${PROJECT}_postgres-data:/from:ro" -v "$keep:/to" alpine sh -c 'cp -a /from/. /to/ && [ "$(cd /from && find . | wc -l)" = "$(cd /to && find . | wc -l)" ]' \
                || { echo "Could not copy the Postgres 12 data aside; nothing was deleted."; exit 1; }
            say "    Postgres 12 data copied to volume $keep ($(vsize "$keep")); it stays until '$0 cleanup'"
        else
            say "    the volume holds an unfinished restore from an earlier run (the Postgres 12 data is in $keep and the backup); starting it again"
        fi
        docker volume rm "${PROJECT}_postgres-data" >/dev/null
        dc up -d db
        for _ in $(seq 1 60); do dc exec -T db pg_isready -U posthog >/dev/null 2>&1 < /dev/null && break; sleep 2; done
        watch_run "$STATE/pg_restore.log" p_restore restore_pg || true
        grep -E "ERROR" "$STATE/pg_restore.log" | grep -vE 'role "posthog" already exists|current user cannot be dropped|database "postgres" .*|cannot drop the currently open database|database "[a-z_]+" does not exist' | head -10 || true
        dc exec -T db psql -U posthog -d postgres -qc "ALTER USER posthog WITH PASSWORD 'posthog';" >/dev/null < /dev/null
        # Every table counted in phase before must have every row back.
        sql=$(python3 -c 'import json,sys; print(" UNION ALL ".join(f"SELECT %s, count(*) FROM \"%s\"" % (chr(39) + t + chr(39), t) for t in json.load(open(sys.argv[1]))["postgres"]))' "$STATE/before.json")
        dc exec -T db psql -U posthog -d posthog -At -F ' ' -c "$sql" < /dev/null > "$STATE/pg_restored_counts.txt"
        python3 - "$STATE/before.json" "$STATE/pg_restored_counts.txt" <<'PYEOF' || { echo "The Postgres restore is incomplete; see $STATE/pg_restore.log. The old data is untouched in the backup and in volume ${PROJECT}_postgres12-before-upgrade."; exit 1; }
import json, sys
want = json.load(open(sys.argv[1]))["postgres"]
got = dict(line.split() for line in open(sys.argv[2]) if line.strip())
bad = [f"{t}: {n} before, {got.get(t, 'none')} restored" for t, n in want.items() if str(n) != got.get(t)]
print(f"    restored: {len(want) - len(bad)} of {len(want)} checked tables have every row")
for b in bad:
    print("    MISSING ROWS", b)
sys.exit(1 if bad else 0)
PYEOF
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
    require_backup
    q() { dc exec -T db psql -U posthog -d posthog -Atc "$1" < /dev/null; }
    dc up -d db redis7 clickhouse kafka >/dev/null 2>&1
    for _ in $(seq 1 60); do dc exec -T db pg_isready -U posthog >/dev/null 2>&1 < /dev/null && break; sleep 2; done
    if [ "$(q "SELECT count(*) FROM django_migrations WHERE app='posthog' AND name='$STEPPING_STONE_LAST_MIGRATION'")" = 1 ]; then
        say "the database is past the stepping stone already"
    else
        say "migrating the database with PostHog $STEPPING_STONE_COMMIT (the last version before the squash) first"
        docker pull -q "$STEPPING_STONE_IMAGE" >/dev/null
        printf 'services:\n    web:\n        image: %s\n' "$STEPPING_STONE_IMAGE" > "$STATE/stone.yml"
        stone_files=(); IFS=: read -ra cf <<< "$(grep -E '^COMPOSE_FILE=' .env | cut -d= -f2-)"
        for f in "${cf[@]}"; do stone_files+=(-f "$f"); done
        stone() { dc "${stone_files[@]}" -f "$STATE/stone.yml" run --rm -T --no-deps -e SKIP_ASYNC_MIGRATIONS_SETUP=1 -e PYTHONUNBUFFERED=1 web "$@"; }
        TOTAL=$(pending stone); TOTAL=${TOTAL:-?}
        say "    $TOTAL migrations to apply"
        if ! watch_run "$STATE/stone-migrate.log" p_django stone python manage.py migrate --noinput; then
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
                stone python manage.py migrate ee 0038_alter_enterpriseeventdefinition_eventdefinition_ptr_and_more > "$STATE/stone-migrate-2.log" 2>&1 < /dev/null \
                    || { tail -25 "$STATE/stone-migrate-2.log"; echo "The stepping-stone migrations failed; see $STATE/stone-migrate-2.log"; exit 1; }
                q "DELETE FROM auth_permission WHERE content_type_id IN (SELECT e.id FROM django_content_type e JOIN django_content_type p ON p.model = e.model AND p.app_label = 'posthog' WHERE e.app_label = 'event_definitions'); DELETE FROM django_content_type e USING django_content_type p WHERE e.app_label = 'event_definitions' AND p.app_label = 'posthog' AND p.model = e.model;" >/dev/null
                TOTAL=$(pending stone); TOTAL=${TOTAL:-?}
                say "    continuing: $TOTAL migrations to apply"
                watch_run "$STATE/stone-migrate-3.log" p_django stone python manage.py migrate --noinput \
                    || { tail -25 "$STATE/stone-migrate-3.log"; echo "The stepping-stone migrations failed; see $STATE/stone-migrate-3.log"; exit 1; }
            else
                tail -25 "$STATE/stone-migrate.log"; echo "The stepping-stone migrations failed; see $STATE/stone-migrate.log"; exit 1
            fi
        fi
        say "applied $(cat "$STATE"/stone-migrate*.log | grep -c '  Applying ' || true) migrations with the stepping stone"
        [ "$(q "SELECT count(*) FROM django_migrations WHERE app='posthog' AND name='$STEPPING_STONE_LAST_MIGRATION'")" = 1 ] || { echo "The stepping stone did not finish; see $STATE/stone-migrate.log"; exit 1; }
    fi
    finish stone
fi

# ---------------------------------------------------------------- 9 clickhouse
# PostHog's own migrations for this version, then its ClickHouse migrations through clickhouse_catchup.py:
# from ClickHouse migration 0139 (September 2025) several of them recreate views with columns that only
# later migrations add, and stop; the catch-up adds each such column early, with PostHog's own definition.
target_web() { dc run --rm -T --no-deps -e SKIP_ASYNC_MIGRATIONS_SETUP=1 -e PYTHONUNBUFFERED=1 web "$@"; }
catchup() { STATE_DIR="$STATE" POSTHOG_SRC=posthog python3 "$HERE/clickhouse_catchup.py"; }
if phase clickhouse; then
    require_backup
    dc up -d db redis7 clickhouse kafka zookeeper >/dev/null 2>&1
    for _ in $(seq 1 60); do dc exec -T db pg_isready -U posthog >/dev/null 2>&1 < /dev/null && break; sleep 2; done
    say "PostHog's database migrations"
    TOTAL=$(pending target_web); TOTAL=${TOTAL:-?}
    say "    $TOTAL migrations to apply"
    watch_run "$STATE/django-migrate.log" p_django target_web python manage.py migrate --noinput \
        || { tail -25 "$STATE/django-migrate.log"; echo "PostHog's database migrations failed; see $STATE/django-migrate.log"; exit 1; }
    say "    applied $(grep -c '  Applying ' "$STATE/django-migrate.log" || true)"
    say "PostHog's ClickHouse migrations"
    CH_LAST=$(ls posthog/posthog/clickhouse/migrations | grep -E '^[0-9]{4}_.*\.py$' | sort | tail -1 | cut -c1-4)
    ok=0
    watch_run "$STATE/clickhouse-catchup.log" p_clickhouse catchup || ok=$?
    sed 's/^/    /' "$STATE/clickhouse-catchup.log"
    [ "$ok" = 0 ] || { echo "The ClickHouse migrations failed; see above and $STATE/clickhouse-migrate-*.log"; exit 1; }
    finish clickhouse
fi

# ---------------------------------------------------------------- 10 start
# Started through ../posthog/scale.sh, so every service comes up once, on the right images and settings:
# PostHog's Docker Hub Node image is months old and would crash-loop until replaced.
if phase start; then
    require_backup
    # A machine without internet: the new version's services get the same fail-fast names and settings.
    if [ -f docker-compose.no-internet.yml ]; then POSTHOG_DIR="$POSTHOG_DIR" bash "$HERE/../offline/no-internet.sh" apply --no-restart; fi
    if [ "$(recall async_check)" = TRUE ]; then dc up -d db redis7 clickhouse && dc run --rm -T asyncmigrationscheck < /dev/null; fi
    dc up -d --remove-orphans db redis7 clickhouse kafka >/dev/null 2>&1   # the old redis 6.2 and cyclotron-janitor are gone
    NODE_BASE_IMAGE="$NODE_BASE_IMAGE" POSTHOG_DIR="$POSTHOG_DIR" bash "$HERE/../posthog/scale.sh" < /dev/null
    wait_web
    finish start
fi

# ---------------------------------------------------------------- 11 storage, 12 replays
# PostHog's migrate-storage-hobby, one service at a time: run whole, it stops at the first bucket the old
# MinIO does not have (ai-blobs, which 2025 versions never created) and copies nothing after it. Its
# general-storage service copies the whole bucket but session_recordings/; here it also leaves out
# session_recording_batches/ (replays of legacy-retention projects), which belong to phase replays: its
# copier is run with that one prefix added to its exclusions.
copier_override() {
    local js="$STATE/migrate-minio-to-seaweedfs.js"
    dc run --rm -T --no-deps --entrypoint cat plugins nodejs/bin/migrate-minio-to-seaweedfs.js > "$js" < /dev/null
    python3 - "$js" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
old = "excludePrefixes: ['session_recordings/', 'session_recordings_lts/', 'query_cache/'],"
if s.count(old) != 1:
    sys.exit("PostHog's migrate-minio-to-seaweedfs.js is not the one this script was tested with; stopping before copying.")
open(p, "w").write(s.replace(old, "excludePrefixes: ['session_recordings/', 'session_recordings_lts/', 'session_recording_batches/', 'query_cache/'],"))
PYEOF
    printf 'services:\n    plugins:\n        volumes:\n            - %s:/code/nodejs/bin/migrate-minio-to-seaweedfs.js:ro\n' "$js" > "$STATE/storage-copier.yml"
}
hobby_storage() { echo y | COMPOSE_FILE="$(grep -E '^COMPOSE_FILE=' .env | cut -d= -f2-):$STATE/storage-copier.yml" bash posthog/bin/migrate-storage-hobby --volume "$(recall minio_volume)" "$1"; }
storage_copy() { # SERVICE
    local svc="$1" bucket=posthog log="$STATE/storage-$1.log"
    [ "$svc" = ai-blobs ] && bucket=ai-blobs
    if ! docker run --rm -v "$(recall minio_volume):/data:ro" alpine test -d "/data/$bucket"; then say "    $svc: the old MinIO has no $bucket bucket; nothing to copy"; return 0; fi
    say "copying $svc with PostHog's migrate-storage-hobby"
    watch_run "$log" p_storage hobby_storage "$svc" || { tr '\r' '\n' < "$log" | tail -20; echo "migrate-storage-hobby $svc failed; see $log"; exit 1; }
    tr '\r' '\n' < "$log" | grep -E "Found [0-9]+ objects|Completed:|Skipped:|Failed:|Data transferred" | sed 's/^/        /' || true
    if tr '\r' '\n' < "$log" | grep -qE 'Failed: +[1-9]'; then echo "migrate-storage-hobby $svc could not copy some files; see $log"; exit 1; fi
}
# with_old_minio COMMAND...: runs COMMAND while a temporary MinIO serves the old volume, as
# migrate-storage-hobby does, at http://posthog-upgrade-minio:19000 on PostHog's network.
with_old_minio() {
    local net rc=0
    net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(dc ps -q web | head -1)" | awk '{print $1}')
    docker rm -f posthog-upgrade-minio >/dev/null 2>&1 || true
    docker run -d --name posthog-upgrade-minio --network "$net" -v "$(recall minio_volume):/data" \
        -e MINIO_ROOT_USER=object_storage_root_user -e MINIO_ROOT_PASSWORD=object_storage_root_password \
        "$MINIO_IMAGE" server --address :19000 /data >/dev/null
    for _ in $(seq 1 30); do docker logs posthog-upgrade-minio 2>&1 | grep -q "API:" && break; sleep 1; done
    "$@" || rc=$?
    docker rm -f posthog-upgrade-minio >/dev/null 2>&1 || true
    return "$rc"
}
if phase storage; then
    require_backup
    if [ -n "$(recall minio_volume)" ]; then
        copier_override
        storage_copy general-storage
        storage_copy ai-blobs
        # cymbal (error tracking) reads source maps from the replay store; migrate-storage-hobby copies them
        # there only when run whole.
        say "copying symbolsets/ (error tracking source maps) into the replay store, where cymbal reads them"
        web_python copy_legacy_replays.py -e PREFIXES=symbolsets/
    else
        say "no MinIO volume; nothing to copy"
    fi
    finish storage
fi

if phase replays; then
    if [ "$(recall replays)" = skip ] && [ "$ONLY" != replays ]; then
        say "session replays: not copied, as chosen. They stay, untouched, in the old MinIO volume $(recall minio_volume)."
        say "    To copy them later: $0 replays   (then: $0 verify)"
        CURRENT=""
    else
        require_backup
        remember replays copy
        if [ -n "$(recall minio_volume)" ]; then
            [ -f "$STATE/storage-copier.yml" ] || copier_override
            storage_copy session-recordings
            storage_copy session-recordings-lts
            # migrate-storage-hobby has no service for session_recording_batches/; read straight from the old MinIO.
            say "copying session_recording_batches/ (replays of legacy-retention projects) from the old MinIO into the replay store"
            with_old_minio web_python copy_legacy_replays.py -e PREFIXES=session_recording_batches/ -e SOURCE_ENDPOINT=http://posthog-upgrade-minio:19000 \
                -e SOURCE_KEY=object_storage_root_user -e SOURCE_SECRET=object_storage_root_password
            # The new replay reader refuses session_recording_batches/ names, so those replays would not play.
            say "renaming legacy replays so the new replay reader accepts them (their metadata is backed up first)"
            web_python fix_legacy_replays.py
        else
            say "no MinIO volume; nothing to copy"
        fi
        finish replays
    fi
fi

# ---------------------------------------------------------------- 13 verify
if phase verify; then
    replays_copied=1
    if [ "$(recall replays)" = skip ] && [ ! -f "$STATE/done/replays" ]; then replays_copied=0; fi
    say "counting everything again"
    web_python counts.py -e STORES=both > "$STATE/after.json"
    args=("$STATE/before.json" "$STATE/after.json"); [ "$replays_copied" = 1 ] || args+=(--no-replays)
    python3 "$HERE/compare.py" "${args[@]}" > "$STATE/verify.txt" || true
    cat "$STATE/verify.txt"
    if [ "$replays_copied" = 1 ]; then
        # Counts are not enough: fetch every block of every replay through the new replay reader, as the app does.
        say "fetching every replay through the new replay reader"
        dc exec -T web python manage.py shell < "$HERE/replays_playable.py" 2>/dev/null | grep --line-buffered -E "^(PLAYABLE|  failed|  progress)" | tee -a "$STATE/verify.txt" || true
        if ! python3 -c 'import re,sys; m = re.search(r"^PLAYABLE: (\d+) of (\d+) recordings, (\d+) of (\d+) blocks", open(sys.argv[1]).read(), re.M); sys.exit(0 if m and m[1] == m[2] and m[3] == m[4] else 1)' "$STATE/verify.txt"; then
            echo "RESULT: FAIL (not every replay plays)" | tee -a "$STATE/verify.txt"
        fi
    else
        echo "PLAYABLE: not checked; the session replays were not copied (--no-replays)" | tee -a "$STATE/verify.txt"
    fi
    grep -q '^RESULT: PASS' "$STATE/verify.txt" && ! grep -q '^RESULT: FAIL' "$STATE/verify.txt" || { echo "Differences found: see $STATE/verify.txt. Nothing has been deleted. To go back: $0 rollback"; exit 1; }
    finish verify
    echo
    say "Upgrade complete and verified."
    say "Now check it yourself: log in, open a few dashboards$( [ "$replays_copied" = 1 ] && echo ', watch a few replays')."
    say "Nothing has been deleted. Kept until you decide: the backup in $BACKUP_DIR, the old Postgres 12 data,"
    say "the old MinIO volume$( [ "$replays_copied" = 1 ] || echo ' (it still holds the only copy of the session replays)')."
    [ "$replays_copied" = 1 ] || say "To copy the session replays later: $0 replays, then $0 verify."
    say "When you are sure everything is fine: $0 cleanup   (it shows each item and asks before deleting it)"
fi
