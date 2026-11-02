#!/usr/bin/env bash
# Start, stop and check this project's processes: the triage service and the Acme Portal demo app.
# PID files and logs live in run/ and logs/.
#
#   scripts/stack.sh start|stop|restart|status [service|demo-app]
#
# On a machine set up by deploy/install.sh the service runs under systemd (ticket-triage.service, so it
# starts at boot) and there is no demo app: this script then passes "service" on to systemctl.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p run logs

UNIT=ticket-triage.service
under_systemd() { [ "$1" = service ] && systemctl is-enabled -q "$UNIT" 2>/dev/null; }
SERVICES=(service)
[ -f demo-app/server.ts ] && ! under_systemd service && SERVICES=(demo-app service)
entry() {
    case "$1" in
        demo-app) echo demo-app/server.ts ;;
        service) echo src/service/server.ts ;;
        *) echo "unknown service $1" >&2; exit 2 ;;
    esac
}
port() {
    case "$1" in
        demo-app) echo "${DEMO_APP_PORT:-3000}" ;;
        service) echo "${SERVICE_PORT:-8080}" ;;
    esac
}

running() {
    local pidf="run/$1.pid"
    [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null
}

start_one() {
    if running "$1"; then echo "$1 already running (pid $(cat "run/$1.pid"))"; return; fi
    # Run as the unprivileged "triage" user when started by root: the renderer's Chrome opens
    # untrusted recordings and must not run as root.
    local as=()
    if [ "$(id -u)" = 0 ] && id triage >/dev/null 2>&1; then as=(runuser -u triage --); fi
    nohup "${as[@]}" env PUPPETEER_CACHE_DIR="$PWD/.cache/puppeteer" HOME=/var/lib/triage node --disable-warning=ExperimentalWarning --import tsx "$(entry "$1")" >>"logs/$1.log" 2>&1 &
    echo $! >"run/$1.pid"
    for _ in $(seq 1 40); do
        # Any HTTP answer means the process is up.
        if [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://localhost:$(port "$1")/healthz" || true)" != 000 ]; then
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
    if under_systemd "$s"; then
        case "$cmd" in
            start|stop|restart) systemctl "$cmd" "$UNIT" && echo "$s: $cmd done (systemd)" ;;
            status) echo "$s: $(systemctl is-active "$UNIT") (systemd, port $(port "$s"))" ;;
            *) echo "usage: $0 start|stop|restart|status [service...]"; exit 2 ;;
        esac
        continue
    fi
    case "$cmd" in
        start) start_one "$s" ;;
        stop) stop_one "$s" ;;
        restart) stop_one "$s"; start_one "$s" ;;
        status) status_one "$s" ;;
        *) echo "usage: $0 start|stop|restart|status [service...]"; exit 2 ;;
    esac
done
