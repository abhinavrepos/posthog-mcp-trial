#!/usr/bin/env bash
# Export everything from a self-hosted (hobby) PostHog into one folder, for posthog-import.sh to load
# into a newer PostHog. Only reads: nothing in the PostHog being exported is changed.
#
#   sudo ./posthog-export.sh /path/to/bundle            # run in the PostHog folder, or set POSTHOG_DIR
#
# What it writes (and what each phase does):
#   1 check      versions, projects, sizes, free disk, and whether events are still arriving
#   2 postgres   one pg_dump of the whole PostHog database: projects, users, dashboards, insights,
#                cohorts, flags, persons, everything
#   3 clickhouse every non-empty ClickHouse table that holds data (events month by month), with its
#                schema and row count
#   4 storage    every file in the object storage bucket (MinIO): session replays, exports, uploads
#   5 manifest   counts and SHA-256 checksums of every file, so the import can prove nothing was lost
#
# Each phase records when it finished, so running the script again continues where it stopped.
# Needs: docker with compose, and room for the bundle (the script estimates it before starting).
# Stop sending events to PostHog before running it; the check phase warns if events still arrive.
set -euo pipefail

OUT="${1:?usage: $0 /path/to/bundle}"
POSTHOG_DIR="${POSTHOG_DIR:-$PWD}"
cd "$POSTHOG_DIR"
[ -f docker-compose.yml ] || { echo "No docker-compose.yml here. Run it in the PostHog folder or set POSTHOG_DIR."; exit 1; }
mkdir -p "$OUT"/{clickhouse,storage,done}
OUT="$(cd "$OUT" && pwd)"
LOG="$OUT/export.log"
exec > >(tee -a "$LOG") 2>&1

say() { echo "$(date -u +%H:%M:%S) $*"; }
done_phase() { touch "$OUT/done/$1"; say "phase $1 finished"; }
is_done() { [ -f "$OUT/done/$1" ]; }
dc() { docker compose "$@"; }
ch() { dc exec -T clickhouse clickhouse-client -d posthog "$@"; }
psql_q() { dc exec -T db psql -U posthog -d posthog -At -c "$1"; }

# Which container can talk to object storage with Python and boto3 (the app image has both).
APP=web
dc ps --status running --services | grep -qx web || APP=worker

# ---------------------------------------------------------------- 1 check
if ! is_done check; then
    say "== 1 check"
    for s in db clickhouse $APP; do
        dc ps --status running --services | grep -qx "$s" || { echo "Service $s is not running. Start PostHog first (docker compose up -d)."; exit 1; }
    done
    {
        echo "exported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "posthog_app_tag=$(grep -E '^POSTHOG_APP_TAG=' .env 2>/dev/null | cut -d= -f2-)"
        echo "clickhouse_version=$(ch -q 'SELECT version()')"
        echo "postgres_version=$(psql_q 'SHOW server_version')"
        echo "hostname=$(hostname)"
    } > "$OUT/source.env"
    cat "$OUT/source.env"
    say "Projects:"
    psql_q "SELECT id, name, api_token FROM posthog_team ORDER BY id" | sed 's/^/    /'
    ch -q "SELECT team_id, count() FROM events GROUP BY team_id ORDER BY team_id FORMAT TSV" | sed 's/^/    events in project /'
    need_mb=$(ch -q "SELECT intDiv(sum(bytes_on_disk), 1048576) FROM system.parts WHERE active AND database = 'posthog'")
    free_mb=$(df -Pm "$OUT" | awk 'NR==2 {print $4}')
    say "ClickHouse data: ${need_mb} MB. Free space for the bundle: ${free_mb} MB."
    if [ "$free_mb" -lt $(( need_mb * 2 + 2048 )) ]; then
        echo "Not enough free space in $OUT: need about $(( need_mb * 2 + 2048 )) MB (plus the replay files)."; exit 1
    fi
    a=$(ch -q "SELECT count() FROM events WHERE _timestamp > now() - INTERVAL 10 MINUTE")
    sleep 30
    b=$(ch -q "SELECT count() FROM events WHERE _timestamp > now() - INTERVAL 10 MINUTE")
    if [ "$b" -gt "$a" ]; then
        say "WARNING: events are still arriving ($((b - a)) in the last 30 seconds). Stop the apps sending them, then run this again."
        [ "${ALLOW_LIVE:-0}" = 1 ] || exit 1
    fi
    done_phase check
fi

# ---------------------------------------------------------------- 2 postgres
if ! is_done postgres; then
    say "== 2 postgres"
    dc exec -T db pg_dump -U posthog -d posthog -Fc -Z 6 > "$OUT/postgres.dump.partial"
    mv "$OUT/postgres.dump.partial" "$OUT/postgres.dump"
    psql_q "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY relname" > "$OUT/postgres.rows.tsv"
    say "postgres.dump: $(du -h "$OUT/postgres.dump" | cut -f1), $(wc -l < "$OUT/postgres.rows.tsv") non-empty tables"
    done_phase postgres
fi

# ---------------------------------------------------------------- 3 clickhouse
if ! is_done clickhouse; then
    say "== 3 clickhouse"
    # Every table that stores rows (MergeTree family), not Kafka readers, views or distributed tables.
    ch -q "SELECT name FROM system.tables WHERE database = 'posthog' AND engine LIKE '%MergeTree%' AND total_rows > 0 ORDER BY name" > "$OUT/clickhouse/tables.txt"
    : > "$OUT/clickhouse/counts.tsv.partial"
    while read -r t; do
        ch -q "SHOW CREATE TABLE posthog.\`$t\`" --format TSVRaw > "$OUT/clickhouse/$t.sql"
        has_ts=$(ch -q "SELECT count() FROM system.columns WHERE database = 'posthog' AND table = '$t' AND name = 'timestamp' AND type LIKE 'DateTime%'")
        if [ "$has_ts" = 1 ] && [ "$(ch -q "SELECT count() > 1000000 FROM posthog.\`$t\`")" = 1 ]; then
            # Big tables go month by month, so a failed run only redoes one month.
            for m in $(ch -q "SELECT DISTINCT toYYYYMM(timestamp) FROM posthog.\`$t\` ORDER BY 1"); do
                f="$OUT/clickhouse/$t.$m.native.gz"
                [ -f "$f" ] && continue
                n=$(ch -q "SELECT count() FROM posthog.\`$t\` WHERE toYYYYMM(timestamp) = $m")
                ch -q "SELECT * FROM posthog.\`$t\` WHERE toYYYYMM(timestamp) = $m FORMAT Native" | gzip -1 > "$f.partial"
                mv "$f.partial" "$f"
                say "    $t $m: $n rows"
            done
        else
            f="$OUT/clickhouse/$t.native.gz"
            if [ ! -f "$f" ]; then
                ch -q "SELECT * FROM posthog.\`$t\` FORMAT Native" | gzip -1 > "$f.partial"
                mv "$f.partial" "$f"
            fi
        fi
        printf '%s\t%s\n' "$t" "$(ch -q "SELECT count() FROM posthog.\`$t\`")" >> "$OUT/clickhouse/counts.tsv.partial"
        say "    $t: $(tail -1 "$OUT/clickhouse/counts.tsv.partial" | cut -f2) rows"
    done < "$OUT/clickhouse/tables.txt"
    mv "$OUT/clickhouse/counts.tsv.partial" "$OUT/clickhouse/counts.tsv"
    # What the import must reproduce, for its verify phase.
    ch -q "SELECT team_id, toDate(timestamp) AS day, event, count(), uniqExact(uuid) FROM events GROUP BY team_id, day, event ORDER BY team_id, day, event FORMAT TSV" > "$OUT/clickhouse/summary.events.tsv"
    ch -q "SELECT team_id, uniqExact(session_id), sum(event_count), sum(length(block_urls)) FROM (SELECT team_id, session_id, sum(event_count) AS event_count, groupArrayArray(block_urls) AS block_urls FROM session_replay_events GROUP BY team_id, session_id) GROUP BY team_id ORDER BY team_id FORMAT TSV" > "$OUT/clickhouse/summary.replays.tsv" 2>/dev/null || : > "$OUT/clickhouse/summary.replays.tsv"
    ch -q "SELECT team_id, uniqExact(id) FROM person GROUP BY team_id ORDER BY team_id FORMAT TSV" > "$OUT/clickhouse/summary.persons.tsv"
    say "    summary: $(awk -F'\t' '{s+=$5} END {print s}' "$OUT/clickhouse/summary.events.tsv") events, $(awk -F'\t' '{s+=$2} END {print s+0}' "$OUT/clickhouse/summary.replays.tsv") replays"
    done_phase clickhouse
fi

# ---------------------------------------------------------------- 4 storage
if ! is_done storage; then
    say "== 4 storage"
    # Replays and other files live in the object storage bucket. The app container already knows
    # where it is and how to sign in; it streams each top-level folder out as a tar file.
    dc exec -T "$APP" python - <<'PY' > "$OUT/storage/folders.txt"
import boto3, os
from botocore.config import Config
s3 = boto3.client("s3", endpoint_url=os.environ.get("OBJECT_STORAGE_ENDPOINT", "http://objectstorage:19000"),
    aws_access_key_id=os.environ.get("OBJECT_STORAGE_ACCESS_KEY_ID", "object_storage_root_user"),
    aws_secret_access_key=os.environ.get("OBJECT_STORAGE_SECRET_ACCESS_KEY", "object_storage_root_password"),
    config=Config(signature_version="s3v4"), region_name="us-east-1")
bucket = os.environ.get("OBJECT_STORAGE_BUCKET", "posthog")
seen = set()
for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Delimiter="/"):
    for p in page.get("CommonPrefixes", []):
        seen.add(p["Prefix"].rstrip("/"))
    for o in page.get("Contents", []):
        seen.add("")
print("\n".join(sorted(seen)))
PY
    while read -r folder; do
        name="${folder:-_root}"
        f="$OUT/storage/$name.tar"
        [ -f "$f" ] && continue
        dc exec -T -e FOLDER="$folder" "$APP" python - <<'PY' > "$f.partial"
import boto3, io, os, sys, tarfile, time
from botocore.config import Config
s3 = boto3.client("s3", endpoint_url=os.environ.get("OBJECT_STORAGE_ENDPOINT", "http://objectstorage:19000"),
    aws_access_key_id=os.environ.get("OBJECT_STORAGE_ACCESS_KEY_ID", "object_storage_root_user"),
    aws_secret_access_key=os.environ.get("OBJECT_STORAGE_SECRET_ACCESS_KEY", "object_storage_root_password"),
    config=Config(signature_version="s3v4", retries={"max_attempts": 10}), region_name="us-east-1")
bucket = os.environ.get("OBJECT_STORAGE_BUCKET", "posthog")
folder = os.environ["FOLDER"]
prefix = folder + "/" if folder else ""
n = 0
with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as tar:
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix, **({} if folder else {"Delimiter": "/"})):
        for o in page.get("Contents", []):
            body = s3.get_object(Bucket=bucket, Key=o["Key"])["Body"].read()
            info = tarfile.TarInfo(o["Key"])
            info.size = len(body)
            info.mtime = int(o["LastModified"].timestamp())
            tar.addfile(info, io.BytesIO(body))
            n += 1
print(f"{n} files", file=sys.stderr)
PY
        mv "$f.partial" "$f"
        say "    ${folder:-(bucket root)}: $(tar -tf "$f" | wc -l) files, $(du -h "$f" | cut -f1)"
    done < "$OUT/storage/folders.txt"
    done_phase storage
fi

# ---------------------------------------------------------------- 5 manifest
say "== 5 manifest"
( cd "$OUT" && find . -type f ! -path './done/*' ! -name 'export.log' ! -name 'SHA256SUMS' ! -name '*.partial' -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
say "Bundle ready: $OUT ($(du -sh "$OUT" | cut -f1), $(wc -l < "$OUT/SHA256SUMS") files)."
say "Copy the whole folder to the new PostHog machine and run posthog-import.sh there."
