#!/usr/bin/env bash
# Makes a self-hosted (hobby) PostHog take about 200 events a second (bursts of 500+) without losing any.
# Safe to run again: every step checks before it changes anything. Keeps all data.
#
#   sudo deploy/posthog/scale.sh                 # apply
#   sudo deploy/posthog/scale.sh --status        # show partitions, retention, replicas and health
#   sudo deploy/posthog/scale.sh --undo          # back to the plain hobby compose files (keeps partitions)
#
# Settings (environment, or the install's .env):
#   POSTHOG_DIR                    the install, default /opt/posthog
#   KAFKA_RETENTION_HOURS          how long Kafka keeps events, default 24 (the hobby default was 7 days
#                                  with no size cap: about 100 GB a day at 200 events a second)
#   KAFKA_RETENTION_GB_PER_PARTITION  hard cap per partition, default 2
#   EVENT_PARTITIONS               partitions for the busy topics, default 8 (the most ingestion replicas)
#   INGESTION_REPLICAS, CDP_WORKER_REPLICAS, KAFKA_CORES, KAFKA_MEMORY,
#   PG_MAX_CONNECTIONS, PG_SHARED_BUFFERS, REDIS_MAXMEMORY, CELERY_CONCURRENCY, POSTHOG_NODE_IMAGE,
#   NODE_BASE_IMAGE, EXTRA_COMPOSE_FILES   see docker-compose.scale.yml
#                                  see docker-compose.scale.yml
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
cd "$POSTHOG_DIR"
[ -f docker-compose.yml ] || { echo "No docker-compose.yml in $POSTHOG_DIR. Set POSTHOG_DIR."; exit 1; }

envget() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
setting() { local v="${!1:-}"; [ -n "$v" ] || v="$(envget "$1")"; echo "${v:-$2}"; }
RETENTION_HOURS="$(setting KAFKA_RETENTION_HOURS 24)"
RETENTION_GB="$(setting KAFKA_RETENTION_GB_PER_PARTITION 2)"
PARTITIONS="$(setting EVENT_PARTITIONS 8)"
SMALL=$(( PARTITIONS / 2 ))
[ "$SMALL" -ge 1 ] || SMALL=1
FILES="docker-compose.yml"
[ -f docker-compose.override.yml ] && FILES="$FILES:docker-compose.override.yml"
# Exact image versions, when the install was upgraded with deploy/migrate/posthog-upgrade.sh.
[ -f docker-compose.pinned.yml ] && FILES="$FILES:docker-compose.pinned.yml"
# Site-specific compose files to keep (colon-separated), as posthog-upgrade.sh records them.
EXTRA="$(setting EXTRA_COMPOSE_FILES '')"
[ -n "$EXTRA" ] && FILES="$FILES:$EXTRA"
NODE_BASE_IMAGE="$(setting NODE_BASE_IMAGE ghcr.io/posthog/posthog-node:master)"
# Images from ECR on a machine without internet (deploy/offline/ecr.env): the Node image comes ready-built.
. "$HERE/../offline/ecr.sh"
rpk() { docker compose exec -T kafka rpk "$@"; }

# Busy topics get more partitions so several consumers can share them. Ordering is per key (person,
# session), and a key always lands on one partition, so this keeps per-person order.
declare -A TOPICS=(
    [events_plugin_ingestion]=$PARTITIONS
    [events_plugin_ingestion_historical]=$SMALL
    [events_plugin_ingestion_overflow]=$SMALL
    [clickhouse_events_json]=$SMALL
    [cdp_cyclotron_hog]=$SMALL
    [log_entries]=4
    [clickhouse_app_metrics2]=4
    [clickhouse_person]=4
    [clickhouse_person_distinct_id]=4
    [session_recording_snapshot_item_events]=4
    [ingestion-errortracking-main]=4
    [clickhouse_heatmap_events]=2
)

status() {
    echo "== Compose files: $(envget COMPOSE_FILE)"
    echo "== Kafka retention: $(rpk cluster config get log_retention_ms) ms, $(rpk cluster config get retention_bytes) bytes per partition"
    echo "== Partitions"
    rpk topic list | awk -v keep="$(printf '%s|' "${!TOPICS[@]}")" 'NR==1 || $1 ~ "^(" keep "x)$"'
    echo "== Node services"
    docker compose ps --format '{{.Service}}\t{{.Image}}\t{{.Status}}' | grep -E "ingestion|plugins|recording" | sort
}

if [ "${1:-}" = "--status" ]; then status; exit 0; fi
if [ "${1:-}" = "--undo" ]; then
    sed -i '/^COMPOSE_FILE=/d' .env
    docker compose up -d --remove-orphans
    echo "Back on $FILES. Partitions stay as they are (Kafka cannot remove them)."
    exit 0
fi
[ "$(id -u)" = 0 ] || { echo "Run as root (it sets kernel limits and restarts containers)."; exit 1; }

echo "==> Kernel limits"
# Redpanda needs many async I/O slots per core; swapping hurts ClickHouse and Kafka badly.
cat > /etc/sysctl.d/90-posthog-scale.conf <<'EOF'
fs.aio-max-nr = 1048576
vm.swappiness = 10
vm.max_map_count = 1048576
net.core.somaxconn = 4096
EOF
sysctl -q -p /etc/sysctl.d/90-posthog-scale.conf

echo "==> Compose overlay"
cp "$HERE/docker-compose.scale.yml" docker-compose.scale.yml
if grep -q '^COMPOSE_FILE=' .env; then sed -i "s|^COMPOSE_FILE=.*|COMPOSE_FILE=$FILES:docker-compose.scale.yml|" .env
else echo "COMPOSE_FILE=$FILES:docker-compose.scale.yml" >> .env; fi
docker compose config -q

if [ -n "$POSTHOG_NODE_PREBUILT" ]; then
    echo "==> The Node image from $IMAGE_REGISTRY (PostHog's, plus PLUGINS_DISABLED_CAPABILITIES; built by build-images.sh)"
    images_login
    ecr_pull_tag "$POSTHOG_NODE_PREBUILT" posthog-node-lens:latest
    ecr_check_images "$POSTHOG_DIR"
else
    echo "==> Building the Node image (PostHog's current one plus PLUGINS_DISABLED_CAPABILITIES)"
    docker pull -q "$NODE_BASE_IMAGE" >/dev/null
    docker build -q --build-arg BASE="$NODE_BASE_IMAGE" -t posthog-node-lens:latest "$HERE/node-image" >/dev/null
fi

echo "==> Restarting with the new settings (data is kept)"
docker compose up -d
for i in $(seq 1 60); do
    rpk cluster health 2>/dev/null | grep -q 'Healthy:.*true' && break
    sleep 5
done

echo "==> Databases: the plugin job queue and a person key (the current Node image needs both)"
if ! docker compose exec -T db psql -U posthog -Atc "select 1 from pg_database where datname='cyclotron_node'" | grep -q 1; then
    docker compose exec -T db psql -U posthog -qc "create database cyclotron_node"
fi
docker compose exec -T db psql -U posthog -d cyclotron_node -qc "create table if not exists _lens_migrations (name text primary key)"
for f in $(ls posthog/rust/cyclotron-node-migrations/*.sql | sort); do
    n=$(basename "$f")
    if ! docker compose exec -T db psql -U posthog -d cyclotron_node -Atc "select 1 from _lens_migrations where name='$n'" | grep -q 1; then
        docker compose exec -T db psql -U posthog -d cyclotron_node -v ON_ERROR_STOP=1 -q < "$f"
        docker compose exec -T db psql -U posthog -d cyclotron_node -qc "insert into _lens_migrations values ('$n')"
        echo "    applied $n"
    fi
done
# The current Node image upserts persons ON CONFLICT (team_id, uuid). Hobby installs skip the persons
# migrations that add that key (they belong to the partitioned tables), so every person merge failed
# and crashed ingestion. Add it without locking the table.
docker compose exec -T db psql -U posthog -d posthog -qc "create unique index concurrently if not exists posthog_person_team_id_uuid_uniq on posthog_person (team_id, uuid)"
docker compose up -d plugins plugins-cdp-worker >/dev/null

echo "==> Kafka retention: ${RETENTION_HOURS} h, at most ${RETENTION_GB} GB per partition"
rpk cluster config set log_retention_ms $(( RETENTION_HOURS * 3600 * 1000 )) >/dev/null
rpk cluster config set retention_bytes $(( RETENTION_GB * 1024 * 1024 * 1024 )) >/dev/null

echo "==> Partitions"
current="$(rpk topic list)"
for t in "${!TOPICS[@]}"; do
    want=${TOPICS[$t]}
    have=$(awk -v t="$t" '$1==t {print $2}' <<<"$current")
    if [ -z "$have" ]; then
        rpk topic create "$t" -p "$want" >/dev/null && echo "    $t: created with $want"
    elif [ "$have" -lt "$want" ]; then
        rpk topic add-partitions "$t" --num $(( want - have )) >/dev/null && echo "    $t: $have → $want"
    fi
done

echo "==> Waiting for the Node services to report healthy"
for i in $(seq 1 60); do
    starting=$(docker compose ps --format '{{.Service}} {{.Status}}' | grep -E "ingestion|plugins|recording" | grep -c "starting" || true)
    [ "$starting" = 0 ] && break
    sleep 10
done
status
echo "Done. Load test: tsx deploy/posthog/loadtest.ts --rate 200 --minutes 10"
