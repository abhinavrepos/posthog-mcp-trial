#!/usr/bin/env bash
# Start, stop and check the three demo processes: the Acme Portal demo app, the mock Jira and the
# triage service. PID files and logs live in run/.
#
#   scripts/stack.sh start|stop|restart|status [demo-app|mock-jira|service]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p run logs

SERVICES=(demo-app mock-jira service)
entry() {
    case "$1" in
        demo-app) echo demo-app/server.ts ;;
        mock-jira) echo src/mock-jira/server.ts ;;
        service) echo src/service/server.ts ;;
        *) echo "unknown service $1" >&2; exit 2 ;;
    esac
}
port() {
    case "$1" in
        demo-app) echo "${DEMO_APP_PORT:-3000}" ;;
        mock-jira) echo "${MOCK_JIRA_PORT:-4000}" ;;
        service) echo "${SERVICE_PORT:-8080}" ;;
    esac
}
health_path() { [ "$1" = mock-jira ] && echo / || echo /healthz; }

running() {
    local pidf="run/$1.pid"
    [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null
}

start_one() {
    if running "$1"; then echo "$1 already running (pid $(cat "run/$1.pid"))"; return; fi
    nohup node --import tsx "$(entry "$1")" >>"logs/$1.log" 2>&1 &
    echo $! >"run/$1.pid"
    for _ in $(seq 1 40); do
        # Any HTTP answer (the mock Jira UI may answer 401) means the process is up.
        if [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://localhost:$(port "$1")$(health_path "$1")" || true)" != 000 ]; then
            echo "$1 started (pid $(cat "run/$1.pid"), port $(port "$1"))"
            return
        fi
        running "$1" || { echo "$1 exited; see logs/$1.log"; tail -5 "logs/$1.log"; return 1; }
        sleep 0.5
    done
    echo "$1 did not answer on port $(port "$1"); see logs/$1.log"
}

stop_one() {
    if ! running "$1"; then rm -f "run/$1.pid"; echo "$1 not running"; return; fi
    local pid; pid=$(cat "run/$1.pid")
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
    rm -f "run/$1.pid"
    echo "$1 stopped"
}

status_one() {
    if running "$1"; then echo "$1: running (pid $(cat "run/$1.pid"), port $(port "$1"))"; else echo "$1: stopped"; fi
}

cmd="${1:-status}"
targets=("${@:2}")
[ ${#targets[@]} -eq 0 ] && targets=("${SERVICES[@]}")
for s in "${targets[@]}"; do
    case "$cmd" in
        start) start_one "$s" ;;
        stop) stop_one "$s" ;;
        restart) stop_one "$s"; start_one "$s" ;;
        status) status_one "$s" ;;
        *) echo "usage: $0 start|stop|restart|status [service...]"; exit 2 ;;
    esac
done
