#!/usr/bin/env bash
# Builds and starts the status page (or restarts it with new settings).
#
#   deploy/status/up.sh                                # on 127.0.0.1:8090
#   STATUS_BIND=0.0.0.0 deploy/status/up.sh            # reachable from outside: needs STATUS_PASSWORD
#   deploy/status/up.sh down                           # stop and remove it
#
# Environment: STATUS_BIND (127.0.0.1), STATUS_PORT (8090), POSTHOG_NETWORK (posthog_default),
# STATUS_DISK_FOLDER (/var/lib/lens-status). Page settings go in status.env.
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = down ]; then docker compose down; exit 0; fi
# STATUS_BIND can also be set in status.env (deploy/install.sh writes it there).
[ -n "${STATUS_BIND:-}" ] || STATUS_BIND=$( [ -f status.env ] && grep -E '^STATUS_BIND=' status.env | tail -1 | cut -d= -f2- || true)
export STATUS_BIND="${STATUS_BIND:-127.0.0.1}"
export DOCKER_GID STATUS_DISK_FOLDER="${STATUS_DISK_FOLDER:-/var/lib/lens-status}"
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
mkdir -p "$STATUS_DISK_FOLDER"
net="${POSTHOG_NETWORK:-posthog_default}"
docker network inspect "$net" >/dev/null 2>&1 || { echo "Docker network $net not found. Set POSTHOG_NETWORK (docker network ls | grep default)."; exit 1; }
pw=$( [ -f status.env ] && grep -E '^STATUS_PASSWORD=.+' status.env || true )
if [ "${STATUS_BIND:-127.0.0.1}" != 127.0.0.1 ] && [ -z "$pw" ]; then
    echo "STATUS_BIND=${STATUS_BIND} makes the page reachable from outside: set STATUS_PASSWORD in $(pwd)/status.env first."
    echo "(Once published, only the EC2 security group decides who reaches port ${STATUS_PORT:-8090}.)"
    exit 1
fi
docker compose up -d --build
for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${STATUS_PORT:-8090}/healthz" 2>/dev/null || [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${STATUS_PORT:-8090}/healthz")" = 503 ]; then break; fi
    sleep 1
done
echo "Status page: http://${STATUS_BIND:-127.0.0.1}:${STATUS_PORT:-8090}/  (now: $(curl -s "http://127.0.0.1:${STATUS_PORT:-8090}/healthz" | head -1))"
