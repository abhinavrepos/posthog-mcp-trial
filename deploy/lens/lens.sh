#!/usr/bin/env bash
# Runs PostHog Lens from its image (posthog-lens:current, which deploy/install.sh pulls from ECR or builds).
#
#   sudo deploy/lens/lens.sh serve          # the service in the foreground (ticket-triage.service runs this)
#   sudo deploy/lens/lens.sh doctor         # checks every setting against the running services
#   sudo deploy/lens/lens.sh mcp-config     # writes .mcp.json for Claude Code
#   sudo deploy/lens/lens.sh chrome-check   # Chrome for rendering clips starts, with its sandbox
#   sudo deploy/lens/lens.sh test           # the test suite, inside the image
#   sudo deploy/lens/lens.sh run CMD...     # anything else inside the image, e.g. run sh
#
# Every run is the same container setup:
#   - this machine's network (--network host): localhost is PostHog and the port is SERVICE_PORT, as
#     before; deploy/offline/no-internet.sh's rule for the "triage" user applies, because it runs as
#     that user's uid and gid
#   - the settings (.secrets.env, read-only) and the data folders run/ (database), clips/, .cache/,
#     config/ (read-only) and .mcp.json come from the project folder; nothing else is kept
#   - seccomp-chrome.json: Docker's default system-call rules, plus the namespaces Chrome's sandbox needs
#
# Environment: LENS_IMAGE (posthog-lens:current), APP_USER (triage).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
IMAGE="${LENS_IMAGE:-posthog-lens:current}"
APP_USER="${APP_USER:-triage}"
NAME=posthog-lens
die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run as root (sudo): it starts a container."
id "$APP_USER" >/dev/null 2>&1 || die "No user $APP_USER: run deploy/install.sh first."
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "No image $IMAGE: run deploy/install.sh (step app) first."
uid="$(id -u "$APP_USER")"; gid="$(id -g "$APP_USER")"

# The folders and files the container writes, owned by the service user.
mkdir -p "$APP_DIR"/{run,clips,.cache,config,logs}
[ -f "$APP_DIR/.mcp.json" ] || install -m 600 /dev/null "$APP_DIR/.mcp.json"
chown "$uid:$gid" "$APP_DIR"/{run,clips,.cache,logs} "$APP_DIR/.mcp.json"

setting() { [ -f "$APP_DIR/.secrets.env" ] && grep -E "^$1=" "$APP_DIR/.secrets.env" | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true; }

args=(--network host --user "$uid:$gid" --init
    --security-opt "seccomp=$HERE/seccomp-chrome.json"
    -v "$APP_DIR/run:/app/run" -v "$APP_DIR/clips:/app/clips" -v "$APP_DIR/.cache:/app/.cache"
    -v "$APP_DIR/config:/app/config:ro" -v "$APP_DIR/.mcp.json:/app/.mcp.json")
[ -f "$APP_DIR/.secrets.env" ] && args+=(-v "$APP_DIR/.secrets.env:/app/.secrets.env:ro")
# A screens file given by its full path outside config/ is mounted where the setting says.
screens="$(setting SCREENS_FILE)"
if [[ "$screens" = /* ]] && [ -f "$screens" ] && [[ "$screens" != "$APP_DIR/config/"* ]]; then args+=(-v "$screens:$screens:ro"); fi

case "${1:-}" in
    serve)
        docker rm -f "$NAME" >/dev/null 2>&1 || true
        exec docker run --rm --name "$NAME" "${args[@]}" "$IMAGE"
        ;;
    doctor) exec docker run --rm "${args[@]}" "$IMAGE" node --import tsx scripts/doctor.ts ;;
    mcp-config) exec docker run --rm "${args[@]}" "$IMAGE" node --import tsx scripts/mcp-config.ts ;;
    chrome-check)
        out="$(docker run --rm "${args[@]}" "$IMAGE" chrome-headless-shell --headless --disable-gpu --dump-dom about:blank 2>&1)" \
            && grep -q '<body>' <<<"$out" && { echo "Chrome starts, sandboxed, as $APP_USER"; exit 0; }
        echo "$out" | tail -3 >&2
        die "Chrome does not start in the container (above)."
        ;;
    test) exec docker run --rm --user "$uid:$gid" --security-opt "seccomp=$HERE/seccomp-chrome.json" "$IMAGE" sh -c 'node --import tsx --test test/*.test.ts' ;;
    run)
        shift; [ $# -gt 0 ] || die "run what? e.g. $0 run sh"
        tty=(-i); [ -t 0 ] && [ -t 1 ] && tty=(-it)
        exec docker run --rm "${tty[@]}" "${args[@]}" "$IMAGE" "$@"
        ;;
    *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
