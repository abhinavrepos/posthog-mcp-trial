#!/usr/bin/env bash
# Load a bundle made by posthog-export.sh (an older PostHog) into this, newer, PostHog.
#
#   sudo ./posthog-import.sh /path/to/bundle             # all phases, continuing where it stopped
#   sudo ./posthog-import.sh /path/to/bundle verify      # one phase again
#   DRY_RUN=1 ./posthog-import.sh /path/to/bundle postgres   # check the database move, write nothing
#
# Phases (each records when it finished; re-running skips finished ones):
#   1 check       the bundle's checksums, that this PostHog is up, and that the old project tokens
#                 are not here already
#   2 upgrade     restore the old database into a temporary database (migration_source) and upgrade
#                 it with THIS PostHog's own migrations, exactly as a normal PostHog upgrade would
#   3 postgres    move organizations, users, projects (same project tokens) and everything in them into
#                 the live database, in one transaction (import_postgres.py)
#   4 clickhouse  events, persons, groups, replay metadata and the rest, with the new project ids.
#                 Tables PostHog fills from events itself (sessions, for example) are rebuilt, not copied
#   5 storage     replay files and other stored files into this PostHog's storage
#   6 verify      events per day and event name, persons, replays (every block present), database rows
#   7 finish      remove the temporary database and files (run it on its own, after checking)
#
# Settings: POSTHOG_DIR (default /opt/posthog).
set -euo pipefail

BUNDLE="$(cd "${1:?usage: $0 /path/to/bundle [phase]}" && pwd)"
ONLY="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
cd "$POSTHOG_DIR"
STATE="$BUNDLE/import"
mkdir -p "$STATE/done"
exec > >(tee -a "$STATE/import.log") 2>&1

say() { echo "$(date -u +%H:%M:%S) $*"; }
dc() { docker compose "$@"; }
ch() { dc exec -T clickhouse clickhouse-client -d posthog "$@"; }
psql_q() { dc exec -T db psql -U posthog -d "${2:-posthog}" -At -v ON_ERROR_STOP=1 -c "$1"; }
SRC_DB=migration_source
run_phase() { # name
    if [ -n "$ONLY" ] && [ "$ONLY" != "$1" ]; then return 1; fi
    if [ -z "$ONLY" ] && [ -f "$STATE/done/$1" ]; then say "phase $1 already finished"; return 1; fi
    say "== $1"
}
finish() { [ "${DRY_RUN:-0}" = 1 ] || touch "$STATE/done/$1"; say "phase $1 finished"; }
# A one-off container of this PostHog's app, with the bundle and these scripts mounted.
app() { dc run --rm --no-deps -T -v "$BUNDLE:/migration/bundle:ro" -v "$STATE:/migration/state" -v "$HERE:/migration/scripts:ro" "$@"; }

# ---------------------------------------------------------------- 1 check
if run_phase check; then
    for p in check postgres clickhouse storage; do
        [ -f "$BUNDLE/done/$p" ] || { echo "The export did not finish phase $p. Run posthog-export.sh again on the old PostHog."; exit 1; }
    done
    ( cd "$BUNDLE" && sha256sum --quiet -c SHA256SUMS ) || { echo "Checksums do not match: the bundle was damaged in transit. Copy it again."; exit 1; }
    say "checksums match ($(wc -l < "$BUNDLE/SHA256SUMS") files)"
    sed 's/^/    old: /' "$BUNDLE/source.env"
    for s in db clickhouse web; do dc ps --status running --services | grep -qx "$s" || { echo "$s is not running here."; exit 1; }; done
    say "this PostHog: ClickHouse $(ch -q 'SELECT version()'), Postgres $(psql_q 'SHOW server_version')"
    if [ ! -f "$STATE/done/postgres" ]; then
        clash=$(grep -oE 'phc_[A-Za-z0-9]+' <(dc exec -T db pg_restore -f - --data-only -t posthog_team "/dev/stdin" < "$BUNDLE/postgres.dump" 2>/dev/null) | sort -u | while read -r t; do
            [ -n "$(psql_q "SELECT id FROM posthog_team WHERE api_token = '$t'")" ] && echo "$t"; done || true)
        [ -z "$clash" ] || { echo "These project tokens already exist here: $clash. Was this bundle imported before?"; exit 1; }
    fi
    finish check
fi

# ---------------------------------------------------------------- 2 upgrade
if run_phase upgrade; then
    psql_q "DROP DATABASE IF EXISTS $SRC_DB WITH (FORCE)" >/dev/null
    psql_q "CREATE DATABASE $SRC_DB" >/dev/null
    say "restoring the old database ($(du -h "$BUNDLE/postgres.dump" | cut -f1))"
    dc exec -T db pg_restore -U posthog -d $SRC_DB --no-owner --no-acl --jobs=1 < "$BUNDLE/postgres.dump" 2> "$STATE/pg_restore.err" || true
    grep -vE "^pg_restore: (warning|while PROCESSING)|already exists|^$" "$STATE/pg_restore.err" | head -20 || true
    [ "$(psql_q 'SELECT count(*) FROM posthog_team' $SRC_DB)" -ge 1 ] || { echo "The restore has no projects; see $STATE/pg_restore.err"; exit 1; }
    say "upgrading it with this PostHog's migrations (this is the slow part)"
    url="postgres://posthog:posthog@db:5432/$SRC_DB"
    app -e DATABASE_URL="$url" -e PERSONS_DATABASE_URL="$url" -e PERSONS_DB_WRITER_URL="$url" -e PERSONS_DB_READER_URL="$url" \
        -e SKIP_ASYNC_MIGRATIONS_SETUP=1 -e DEPLOYMENT=hobby web sh -c "python manage.py migrate --noinput && python manage.py apply_persons_migrations --hobby" > "$STATE/migrate.log" 2>&1 \
        || { tail -30 "$STATE/migrate.log"; echo "Upgrading the old database failed; see $STATE/migrate.log"; exit 1; }
    say "applied $(grep -c '  Applying ' "$STATE/migrate.log" || true) migrations"
    finish upgrade
fi

# ---------------------------------------------------------------- 3 postgres
if run_phase postgres; then
    app -e SOURCE_DB_NAME=$SRC_DB -e STATE_DIR=/migration/state -e DRY_RUN="${DRY_RUN:-0}" web python manage.py shell < "$HERE/import_postgres.py" 2>&1 \
        | grep -vE "UserWarning|pkg_resources|from pkg_resources|^\s*$|\[(info|debug) " | tee "$STATE/postgres.log"
    grep -q "^\[.*done\. projects" "$STATE/postgres.log" || { [ "${DRY_RUN:-0}" = 1 ] && grep -q "DRY_RUN=1" "$STATE/postgres.log" && say "dry run passed"; [ "${DRY_RUN:-0}" = 1 ] && exit 0; echo "Moving the database failed; nothing was written. See $STATE/postgres.log"; exit 1; }
    finish postgres
fi

[ -f "$STATE/idmap.json" ] || { [ -n "$ONLY" ] && [ "$ONLY" != check ] && [ "$ONLY" != upgrade ] && { echo "Run phase postgres first."; exit 1; }; exit 0; }
map() { python3 -c "import json,sys; m=json.load(open('$STATE/idmap.json'))['$1']; print('[' + ','.join(m.keys()) + ']', '[' + ','.join(str(v) for v in m.values()) + ']')"; }
read -r TEAM_OLD TEAM_NEW <<< "$(map team)"
read -r COHORT_OLD COHORT_NEW <<< "$(map cohort)"
[ "$COHORT_OLD" = "[]" ] && COHORT_OLD="[0]" && COHORT_NEW="[0]"

# ---------------------------------------------------------------- 4 clickhouse
if run_phase clickhouse; then
    say "projects old -> new: $TEAM_OLD -> $TEAM_NEW"
    dc exec -T clickhouse mkdir -p /var/lib/clickhouse/user_files/migration
    dc cp "$BUNDLE/clickhouse/." clickhouse:/var/lib/clickhouse/user_files/migration/ >/dev/null
    # Tables PostHog fills from events through materialized views: rebuilt by inserting the events.
    derived=$(ch -q "SELECT DISTINCT extract(create_table_query, ' TO (?:posthog\\.)?\`?([A-Za-z0-9_]+)') FROM system.tables WHERE database = 'posthog' AND engine = 'MaterializedView' AND (create_table_query LIKE '%FROM posthog.sharded_events%' OR create_table_query LIKE '%FROM posthog.events %' OR create_table_query LIKE '%FROM posthog.writable_events%')" | grep -v '^$' | sort -u | tr '\n' ' ')
    say "rebuilt from events, not copied: ${derived:-none}"
    : > "$STATE/clickhouse.tsv"
    while read -r t; do
        if [[ " $derived " == *" $t "* ]]; then echo -e "$t\tderived" >> "$STATE/clickhouse.tsv"; continue; fi
        if [ "$(ch -q "EXISTS TABLE posthog.\`$t\`")" != 1 ]; then echo -e "$t\tno such table here" >> "$STATE/clickhouse.tsv"; say "    $t: no such table in this version, skipped"; continue; fi
        cols_here=$(ch -q "SELECT name FROM system.columns WHERE database = 'posthog' AND table = '$t' AND default_kind NOT IN ('MATERIALIZED', 'ALIAS', 'EPHEMERAL') FORMAT TSV")
        if ! grep -qx team_id <<< "$cols_here"; then echo -e "$t\tno team_id here" >> "$STATE/clickhouse.tsv"; say "    $t: has no project column, skipped"; continue; fi
        for f in $(cd "$BUNDLE/clickhouse" && ls "$t".native.gz "$t".[0-9]*.native.gz 2>/dev/null); do
            [ -f "$STATE/done/ch-$f" ] && continue
            cols_file=$(ch -q "SELECT name FROM file('migration/$f', 'Native') LIMIT 0 FORMAT TSVWithNames" | head -1 | tr '\t' '\n')
            common=$(comm -12 <(sort <<< "$cols_here") <(sort <<< "$cols_file"))
            sel=""; ins=""
            for c in $common; do
                q="\`$c\`"
                case "$c" in
                    team_id) e="transform(team_id, $TEAM_OLD, $TEAM_NEW, team_id)" ;;
                    cohort_id) e="transform(cohort_id, $COHORT_OLD, $COHORT_NEW, cohort_id)" ;;
                    *) e="$q" ;;
                esac
                sel+="${sel:+, }$e AS $q"; ins+="${ins:+, }$q"
            done
            n=$(ch -q "SELECT count() FROM file('migration/$f', 'Native')")
            ch -q "INSERT INTO posthog.\`$t\` ($ins) SELECT $sel FROM file('migration/$f', 'Native') SETTINGS max_insert_threads = 4, max_partitions_per_insert_block = 1000"
            touch "$STATE/done/ch-$f"
            echo -e "$t\t$f\t$n" >> "$STATE/clickhouse.tsv"
            say "    $t <- $f: $n rows"
        done
    done < "$BUNDLE/clickhouse/tables.txt"
    finish clickhouse
fi

# ---------------------------------------------------------------- 5 storage
if run_phase storage; then
    app -e TEAM_MAP="$(python3 -c "import json; print(json.dumps(json.load(open('$STATE/idmap.json'))['team']))")" web python /migration/scripts/import_storage.py
    finish storage
fi

# ---------------------------------------------------------------- 6 verify
if run_phase verify; then
    app -e TEAM_MAP="$(python3 -c "import json; print(json.dumps(json.load(open('$STATE/idmap.json'))['team']))")" -e SOURCE_DB_NAME=$SRC_DB web python manage.py shell < "$HERE/verify.py" 2>&1 \
        | grep -vE "UserWarning|pkg_resources|^\s*$|\[(info|debug) " | tee "$STATE/verify.log"
    grep -q "^RESULT: PASS" "$STATE/verify.log" || { echo "Verification found differences: see $STATE/verify.log"; exit 1; }
    finish verify
fi

# ---------------------------------------------------------------- 7 finish (only when asked)
if [ "$ONLY" = finish ]; then
    psql_q "DROP DATABASE IF EXISTS $SRC_DB WITH (FORCE)" >/dev/null
    dc exec -T clickhouse rm -rf /var/lib/clickhouse/user_files/migration
    say "temporary database and files removed. The bundle itself is still in $BUNDLE."
fi
