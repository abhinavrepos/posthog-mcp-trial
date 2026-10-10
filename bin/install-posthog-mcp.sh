#!/usr/bin/env bash
#
# Adds the PostHog MCP server to a PostHog hobby install, so AI assistants
# (Claude, Cursor, VS Code and others) can query and manage this PostHog.
# Run it on the machine where install-posthog-hobby.sh installed PostHog.
#
#   sudo bash install-posthog-mcp.sh             # install or update, then optionally test with a key
#   sudo bash install-posthog-mcp.sh phx_...     # install or update, then test with this personal API key
#   sudo bash install-posthog-mcp.sh --remove    # stop and remove the MCP server
#
# The MCP server becomes the "mcp" service of PostHog's Docker Compose project
# (docker-compose.mcp.yml, listed in COMPOSE_FILE in the install's .env), so every
# "docker compose up -d" / "docker compose down" in the install directory includes it.
# It also writes /etc/systemd/system/posthog.service: "docker compose up -d" at boot and
# "docker compose down" at shutdown. Data lives in Docker volumes, which "down" keeps.
#
# The MCP server runs as the Docker container "posthog-mcp" and listens on port 8787.
# Allow inbound TCP 8787 in the security group, only from the people who use it.
# Every request needs a PostHog personal API key, the same as the PostHog API.
# On a plain HTTP install the key travels unencrypted, so keep the port on a private network or VPN.
#
# Optional environment overrides:
#   POSTHOG_INSTALL_DIR   where PostHog is installed (default: /opt/posthog)
#   POSTHOG_MCP_PORT      port for the MCP server (default: 8787)
#   POSTHOG_MCP_IMAGE     image to run (default: ghcr.io/posthog/posthog-mcp:latest)
#
# Re-running the script is safe: it pulls the newest image and keeps the existing settings.

set -euo pipefail

INSTALL_DIR="${POSTHOG_INSTALL_DIR:-/opt/posthog}"
MCP_DIR="/opt/posthog-mcp"
ENV_FILE="$MCP_DIR/mcp.env"
PORT="${POSTHOG_MCP_PORT:-8787}"
IMAGE="${POSTHOG_MCP_IMAGE:-ghcr.io/posthog/posthog-mcp:latest}"
CONTAINER="posthog-mcp"
COMPOSE_MCP_FILE="docker-compose.mcp.yml"
BOOT_UNIT="/etc/systemd/system/posthog.service"
# PostHog itself uses Redis databases 0, 1 and 15.
REDIS_DB=4
INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install-posthog-mcp","version":"1.0"}}}'

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    BOLD=$'\e[1m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
    BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi
step() { echo; echo "${BOLD}==> $*${RESET}"; }
info() { echo "    $*"; }
ok()   { echo "    ${GREEN}✔${RESET} $*"; }
warn() { echo "    ${YELLOW}⚠ $*${RESET}"; }
die()  { echo; echo "${RED}✘ $*${RESET}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
require_root() {
    [ "$(id -u)" -eq 0 ] || die "Run this script with sudo: sudo bash $0 $*"
}

require_tools() {
    command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install PostHog with install-posthog-hobby.sh first."
    command -v curl >/dev/null 2>&1 || die "curl is not installed."
    docker info >/dev/null 2>&1 || die "Docker is not running. Start it with: sudo systemctl start docker"
}

# ---------------------------------------------------------------------------
# Find the running PostHog install
# ---------------------------------------------------------------------------
find_posthog() {
    step "Finding PostHog"
    WEB="$(docker ps --filter "label=com.docker.compose.service=web" \
        --filter "label=com.docker.compose.project.working_dir=$INSTALL_DIR" --format '{{.Names}}' | head -1)"
    if [ -z "$WEB" ]; then
        WEB="$(docker ps --filter "label=com.docker.compose.service=web" --format '{{.Names}}' | head -1)"
    fi
    [ -n "$WEB" ] || die "PostHog's web container is not running. Start PostHog first: cd $INSTALL_DIR && sudo docker compose up -d"
    ok "Web container: $WEB"

    PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$WEB")"
    local workdir
    workdir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$WEB")"
    if [ -n "$workdir" ] && [ -f "$workdir/docker-compose.yml" ]; then
        INSTALL_DIR="$workdir"
    fi
    [ -f "$INSTALL_DIR/docker-compose.yml" ] || die "Could not find PostHog's docker-compose.yml. Set POSTHOG_INSTALL_DIR to the install directory."
    ok "Install directory: $INSTALL_DIR (compose project $PROJECT)"

    REDIS="$(docker ps --filter "label=com.docker.compose.service=redis7" \
        --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | head -1)"
    [ -n "$REDIS" ] || die "PostHog's Redis container (redis7) is not running. Start it: cd $INSTALL_DIR && sudo docker compose up -d redis7"
    ok "Redis: $REDIS (database $REDIS_DB)"

    SITE_URL="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WEB" | sed -n 's/^SITE_URL=//p' | head -1)"
    SITE_URL="${SITE_URL%/}"
    [ -n "$SITE_URL" ] || die "SITE_URL is not set on $WEB, so the public PostHog address is unknown."
    ok "PostHog address: $SITE_URL"

    case "$SITE_URL" in
        http://*)
            # Plain HTTP install: talk to Django directly on the Docker network.
            API_BASE="http://web:8000"
            ;;
        *)
            # HTTPS install: Django redirects plain HTTP, so go through Caddy on the public address.
            API_BASE="$SITE_URL"
            warn "Port $PORT serves plain HTTP. Personal API keys sent to it are not encrypted."
            ;;
    esac
    PUBLIC_HOST="$(printf '%s' "$SITE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[:/].*$##')"
    MCP_URL="http://$PUBLIC_HOST:$PORT/mcp"
}

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
random_hex() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

write_env() {
    step "Writing settings to $ENV_FILE"
    mkdir -p "$MCP_DIR"
    local signing_key=""
    if [ -f "$ENV_FILE" ]; then
        signing_key="$(sed -n 's/^MCP_SIGNED_STATE_KEY=//p' "$ENV_FILE" | head -1)"
    fi
    if [ "${#signing_key}" -lt 32 ]; then
        signing_key="$(random_hex)"
    fi
    umask 077
    cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3001
REDIS_URL=redis://redis7:6379/$REDIS_DB
POSTHOG_API_BASE_URL=$API_BASE
POSTHOG_PUBLIC_URL=$SITE_URL
MCP_APPS_BASE_URL=http://$PUBLIC_HOST:$PORT
MCP_SIGNED_STATE_KEY=$signing_key
EOF
    chmod 600 "$ENV_FILE"
    ok "PostHog API for the MCP server: $API_BASE"
}

# ---------------------------------------------------------------------------
# Run the container
# ---------------------------------------------------------------------------
check_port() {
    local owner
    owner="$(docker ps --filter "publish=$PORT" --format '{{.Names}}' | grep -vx "$CONTAINER" | head -1 || true)"
    [ -z "$owner" ] || die "Port $PORT is already used by the container $owner. Pick another port: sudo POSTHOG_MCP_PORT=8788 bash $0"
    if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER" && command -v ss >/dev/null 2>&1 \
        && ss -ltn "( sport = :$PORT )" | grep -q LISTEN; then
        die "Something on this machine already listens on port $PORT. Pick another port: sudo POSTHOG_MCP_PORT=8788 bash $0"
    fi
}

pull_image() {
    step "Pulling $IMAGE"
    local attempt
    for attempt in 1 2 3; do
        if docker pull --quiet "$IMAGE" >/dev/null; then
            ok "Image is up to date"
            return
        fi
        warn "Pull attempt $attempt failed, retrying in $((attempt * 10)) seconds"
        sleep $((attempt * 10))
    done
    die "Could not pull $IMAGE. Check that this machine can reach ghcr.io."
}

write_compose_service() {
    step "Adding the MCP server to PostHog's Docker Compose project"
    cat > "$INSTALL_DIR/$COMPOSE_MCP_FILE" <<EOF
# Written by install-posthog-mcp.sh. Remove it with: sudo bash install-posthog-mcp.sh --remove
services:
    mcp:
        image: $IMAGE
        container_name: $CONTAINER
        restart: unless-stopped
        env_file: $ENV_FILE
        ports:
            - '$PORT:3001'
        depends_on:
            - redis7
            - web
        logging:
            driver: json-file
            options:
                max-size: 10m
                max-file: '3'
EOF
    # Compose reads COMPOSE_FILE from .env, so plain "docker compose" commands include the MCP server.
    local files="docker-compose.yml"
    if [ -f "$INSTALL_DIR/docker-compose.override.yml" ]; then
        files="$files:docker-compose.override.yml"
    fi
    files="$files:$COMPOSE_MCP_FILE"
    touch "$INSTALL_DIR/.env"
    sed -i '/^COMPOSE_FILE=/d' "$INSTALL_DIR/.env"
    printf 'COMPOSE_FILE=%s\n' "$files" >> "$INSTALL_DIR/.env"
    if ! (cd "$INSTALL_DIR" && docker compose config --services | grep -qx mcp); then
        die "Docker Compose rejected $INSTALL_DIR/$COMPOSE_MCP_FILE. The error is above."
    fi
    ok "COMPOSE_FILE=$files"
}

start_container() {
    step "Starting the MCP server"
    # A container from an earlier version of this script ran outside Compose under the same name.
    if [ -z "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER" 2>/dev/null)" ]; then
        docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    fi
    if ! (cd "$INSTALL_DIR" && docker compose up -d --no-build --no-deps --force-recreate mcp); then
        die "Docker Compose could not start the MCP server. The error is above."
    fi
    local _
    for _ in $(seq 1 60); do
        if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then
            ok "MCP server is up on port $PORT"
            return
        fi
        if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
            docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/      /'
            die "The MCP server stopped right after starting. Its last log lines are above."
        fi
        sleep 2
    done
    docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/      /'
    die "The MCP server did not become ready within 2 minutes. Its last log lines are above."
}

check_posthog_reachable() {
    step "Checking that the MCP server can reach PostHog"
    # The image has Node but no curl, so use Node's fetch from inside the container.
    if docker exec "$CONTAINER" node -e '
        fetch(process.env.POSTHOG_API_BASE_URL + "/_health", { redirect: "manual", signal: AbortSignal.timeout(15000) })
            .then((r) => { console.log("HTTP " + r.status); process.exit(r.status === 200 ? 0 : 1) })
            .catch((e) => { console.log(e.cause?.code || e.message); process.exit(1) })' >/tmp/posthog-mcp-health.txt 2>&1; then
        ok "PostHog answers at $API_BASE"
    else
        warn "The MCP server cannot reach PostHog at $API_BASE ($(tr -d '\n' </tmp/posthog-mcp-health.txt))."
        warn "AI assistants will connect, but every PostHog request will fail until this works."
    fi
    rm -f /tmp/posthog-mcp-health.txt
}

# ---------------------------------------------------------------------------
# Start on boot
# ---------------------------------------------------------------------------
install_boot_service() {
    step "Setting up start on boot and stop on shutdown"
    if ! command -v systemctl >/dev/null 2>&1; then
        warn "systemd is not available, so PostHog will not start automatically after a reboot."
        return
    fi
    if [ -f "$BOOT_UNIT" ] && [ ! -f "$BOOT_UNIT.bak" ]; then
        cp "$BOOT_UNIT" "$BOOT_UNIT.bak"
    fi
    cat > "$BOOT_UNIT" <<EOF
[Unit]
Description=PostHog and the PostHog MCP server (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/env docker compose up -d --no-build
# "down" removes the containers and the network. The data stays in the Docker volumes.
ExecStop=/usr/bin/env docker compose down
TimeoutStartSec=600
TimeoutStopSec=300

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable posthog.service >/dev/null 2>&1
    ok "$BOOT_UNIT runs \"docker compose up -d\" at boot and \"docker compose down\" at shutdown"
}

# ---------------------------------------------------------------------------
# Optional end-to-end test with a personal API key
# ---------------------------------------------------------------------------
tool_text() {
    # Prints the text of an MCP tool reply (plain JSON or server-sent events), prefixed ERROR: on failure.
    if ! command -v python3 >/dev/null 2>&1; then
        head -c 400 "$1"
        return
    fi
    python3 -c '
import json, sys
text = open(sys.argv[1]).read()
lines = [l[5:].strip() for l in text.splitlines() if l.startswith("data:")] or [text]
for line in lines:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    result = msg.get("result") or {}
    parts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    prefix = "ERROR: " if result.get("isError") or "error" in msg else ""
    print(prefix + " ".join(" ".join(parts).split())[:400])
    break
' "$1"
}

test_with_key() {
    local key="$1" url="http://127.0.0.1:$PORT/mcp" headers body code session sql_request answer
    step "Testing the MCP server with your personal API key"
    headers="$(mktemp)"; body="$(mktemp)"
    code="$(curl -s -o "$body" -D "$headers" -w '%{http_code}' --max-time 60 -X POST "$url" \
        -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' -d "$INIT_REQUEST" || true)"
    case "$code" in
        200)
            if grep -q '"serverInfo":{"name":"PostHog"' "$body"; then
                ok "Connected: PostHog accepted the key and the MCP session started"
            else
                warn "Unexpected reply: $(head -c 300 "$body")"
            fi
            ;;
        401)
            answer="$(head -c 200 "$body")"
            rm -f "$headers" "$body"
            die "PostHog rejected this key ($answer). Use a personal API key (phx_...) created on this PostHog, not a project API key (phc_...)."
            ;;
        5*)
            docker logs --tail 15 "$CONTAINER" 2>&1 | sed 's/^/      /'
            rm -f "$headers" "$body"
            die "The MCP server failed to reach PostHog at $API_BASE (HTTP $code). Its last log lines are above."
            ;;
        000)
            rm -f "$headers" "$body"
            die "The MCP server did not answer on port $PORT. Check its logs: sudo docker logs $CONTAINER"
            ;;
        *)
            rm -f "$headers" "$body"
            die "Unexpected reply from the MCP server: HTTP $code"
            ;;
    esac

    session="$(sed -n 's/^[Mm]cp-[Ss]ession-[Ii]d: *//p' "$headers" | tr -d '\r' | head -1)"
    sql_request='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"exec","arguments":{"command":"call execute-sql {\"query\": \"select count() as mock_events from events where properties.synthetic = true\"}"}}}'
    code="$(curl -s -o "$body" -w '%{http_code}' --max-time 90 -X POST "$url" \
        -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18' \
        ${session:+-H "mcp-session-id: $session"} -d "$sql_request" || true)"
    answer="$(tool_text "$body" 2>/dev/null || true)"
    if [ "$code" = "200" ] && [ -n "$answer" ] && [ "${answer#ERROR: }" = "$answer" ]; then
        ok "Test query through MCP (count of events with synthetic = true): $answer"
    else
        warn "The connection works, but the test SQL query did not: ${answer:-HTTP $code}"
    fi
    rm -f "$headers" "$body"
}

ask_for_key() {
    local key=""
    if [ -t 0 ]; then
        {
            echo
            echo "${BOLD}Optional:${RESET} paste a personal API key to test the MCP server end to end, or press Enter to skip."
            echo "  Create one in PostHog: Settings > Personal API keys > Create personal API key > preset \"MCP Server\"."
        } >&2
        read -r -s -p "  Personal API key (phx_...): " key || true
        echo >&2
    fi
    printf '%s' "$key"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_client_setup() {
    step "Connect your AI assistant"
    cat <<EOF
    MCP server URL: ${BOLD}$MCP_URL${RESET}
    Every client sends a PostHog personal API key. Create one in PostHog:
    Settings > Personal API keys > Create personal API key > preset "MCP Server".
    Replace phx_YOUR_KEY below with it.

    ${BOLD}Claude Code${RESET} (run in a terminal):
      claude mcp add --transport http posthog $MCP_URL --header "Authorization: Bearer phx_YOUR_KEY"

    ${BOLD}Claude Desktop${RESET} (Settings > Developer > Edit config, needs Node.js):
      {
        "mcpServers": {
          "posthog": {
            "command": "npx",
            "args": ["-y", "mcp-remote@latest", "$MCP_URL", "--allow-http",
                     "--header", "Authorization:\${POSTHOG_AUTH_HEADER}"],
            "env": { "POSTHOG_AUTH_HEADER": "Bearer phx_YOUR_KEY" }
          }
        }
      }

    ${BOLD}Cursor${RESET} (~/.cursor/mcp.json):
      { "mcpServers": { "posthog": { "url": "$MCP_URL", "headers": { "Authorization": "Bearer phx_YOUR_KEY" } } } }

    Allow inbound TCP $PORT in this instance's security group, only from the people who use it.
    Logs: sudo docker logs -f $CONTAINER    Settings: $ENV_FILE    Update: re-run this script
    PostHog and the MCP server stop and start together: sudo systemctl stop posthog  /  sudo systemctl start posthog
EOF
}

remove() {
    step "Removing the PostHog MCP server"
    if [ -f "$INSTALL_DIR/.env" ]; then
        sed -i "/^COMPOSE_FILE=.*$COMPOSE_MCP_FILE/d" "$INSTALL_DIR/.env"
    fi
    rm -f "$INSTALL_DIR/$COMPOSE_MCP_FILE"
    if docker rm -f "$CONTAINER" >/dev/null 2>&1; then
        ok "Container removed"
    else
        info "No container to remove"
    fi
    rm -rf "$MCP_DIR"
    ok "Settings removed"
    info "The boot service still runs docker compose up -d / down, now without the MCP server."
}

main() {
    require_root "$@"
    require_tools
    if [ "${1:-}" = "--remove" ]; then
        remove
        exit 0
    fi
    echo "${BOLD}PostHog MCP server installer${RESET}  ($(date -u '+%Y-%m-%d %H:%M UTC'))"
    find_posthog
    check_port
    write_env
    pull_image
    write_compose_service
    start_container
    check_posthog_reachable
    install_boot_service
    print_client_setup

    local key="${1:-}"
    [ -n "$key" ] || key="$(ask_for_key)"
    if [ -n "$key" ]; then
        test_with_key "$key"
    else
        info "Skipped the key test. Run it later with: sudo bash $0 phx_YOUR_KEY"
    fi
    echo
    echo "${GREEN}${BOLD}Done.${RESET} MCP server: $MCP_URL"
}

# Sourcing the file (for tests) loads the functions without running the installer.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
