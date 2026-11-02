#!/usr/bin/env bash
# Fresh install on a new machine: PostHog (the exact version tested with this project), PostHog Lens
# (the triage service) and its status page. For a machine that already runs PostHog, use
# deploy/migrate/posthog-upgrade.sh to bring PostHog to this version first.
#
#   sudo deploy/install.sh                                  # asks every setting, shows the plan, installs
#   sudo deploy/install.sh --config my-install.env          # answers from a file (deploy/install.env.example)
#   sudo deploy/install.sh --config my-install.env --yes    # no questions at all
#   sudo deploy/install.sh --use-existing-posthog           # PostHog is already on this version: keep it
#   sudo deploy/install.sh status                           # which steps are done, and the summary
#
# Steps (each one checks its result; a finished step is skipped when you run the script again, a failed
# one is retried):
#   check     root, Ubuntu or Debian, x86_64, memory, disk, ports, where the project folder is
#   packages  base tools, the libraries and fonts Chrome needs to render replay clips
#   posthog   PostHog through deploy/posthog/install-posthog-hobby.sh, every image pinned by digest
#             (deploy/migrate/versions), started at boot by posthog.service. 30-60 minutes.
#   scale     deploy/posthog/scale.sh: about 200 events a second without losing any (SCALE=no skips it)
#   node      Node 24 (checked against nodejs.org's checksums) and pnpm 10
#   user      the unprivileged "triage" user the service runs as; it owns the project folder
#   app       pnpm install (with Chrome for rendering), the AppArmor rule Chrome's sandbox needs
#   account   the PostHog login, organization, project settings and a read-only API key
#             (scripts/setup-posthog.sh)
#   settings  your answers into .secrets.env (mode 600), keeping anything already there
#   service   ticket-triage.service: starts at boot, restarts on failure, logs to logs/service.log
#   status    the status page (deploy/status), only on this machine or behind a password
#   mcp       .mcp.json for Claude Code, from the two MCP switches
#   doctor    pnpm doctor: checks every setting against the running services
# check, settings, service, status, mcp and doctor run every time, so changed answers take effect.
# At the end it prints (and saves) everything you need: addresses, logins, where each secret is, the
# snippet for your app, how to connect Jira and Claude.
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
STATE_DIR="${INSTALL_STATE_DIR:-/var/lib/posthog-lens-install}"
ANSWERS="$STATE_DIR/install.env"
SECRETS="$APP_DIR/.secrets.env"
UNIT="${SERVICE_UNIT:-ticket-triage.service}"   # SERVICE_UNIT, POSTHOG_URL, INSTALL_STATE_DIR: for test runs next to a real install
POSTHOG_URL="${POSTHOG_URL:-http://localhost}"
APP_USER=triage
APP_HOME=/var/lib/triage
NODE_MAJOR=24
PNPM_VERSION=10.29.3
MIN_RAM_GB=15     # a "16 GB" machine reports a little less
MIN_DISK_GB=60

if [ -t 1 ]; then B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; D=$'\e[2m'; N=$'\e[0m'; else B=; R=; G=; Y=; D=; N=; fi
step() { echo; echo "${B}==> $*${N}"; }
say() { echo "    $*"; }
ok() { echo "    ${G}✔${N} $*"; }
warn() { echo "    ${Y}⚠ $*${N}"; }
die() { echo; echo "${R}✘ $*${N}" >&2; exit 1; }

# ------------------------------------------------------------------ arguments
ORIG_ARGS=("$@")
CONFIG=""; YES=0; USE_EXISTING=0; CMD=install
while [ $# -gt 0 ]; do
    case "$1" in
        --config) CONFIG="${2:?--config needs a file}"; shift ;;
        --config=*) CONFIG="${1#*=}" ;;
        --yes|-y) YES=1 ;;
        --use-existing-posthog) USE_EXISTING=1 ;;
        status) CMD=status ;;
        -h|--help) sed -n '2,/^set -Eeuo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) die "Unknown option $1 (see --help)" ;;
    esac
    shift
done
[ -z "$CONFIG" ] || [ -f "$CONFIG" ] || die "--config: $CONFIG not found"
[ -z "$CONFIG" ] || CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"

if [ "$(id -u)" -ne 0 ]; then
    exec sudo -E bash "$0" "${ORIG_ARGS[@]}"
fi
mkdir -p "$STATE_DIR/done"
chmod 700 "$STATE_DIR"

done_step() { [ -f "$STATE_DIR/done/$1" ]; }
finish() { date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE_DIR/done/$1"; ok "step $1 done"; }
STEPS=(check packages posthog scale node user app account settings service status mcp doctor)
# Cheap and safe to repeat, so they run every time and changed answers take effect.
ALWAYS=" check settings service status mcp doctor "

if [ "$CMD" = status ]; then
    for s in "${STEPS[@]}"; do
        if done_step "$s"; then echo "  ${G}✔${N} $s  ${D}$(cat "$STATE_DIR/done/$s")${N}"; else echo "  · $s"; fi
    done
    [ -f "$STATE_DIR/summary.txt" ] && { echo; cat "$STATE_DIR/summary.txt"; }
    exit 0
fi

exec 9>"$STATE_DIR/lock"
flock -n 9 || die "Another deploy/install.sh is running."
exec > >(tee -a "$STATE_DIR/install.log") 2>&1
CURRENT=""
trap 'rc=$?; [ $rc -ne 0 ] && [ -n "$CURRENT" ] && { echo; echo "${R}${B}STOPPED in step $CURRENT${N} (exit $rc). Nothing was removed. Fix the error above and run the same command again: finished steps are skipped. Full log: $STATE_DIR/install.log${N}"; }' EXIT
echo "${B}PostHog Lens installer${N}  ($(date -u '+%Y-%m-%d %H:%M UTC'), project folder $APP_DIR)"

# ------------------------------------------------------------------ answers
# Precedence: the environment, then --config, then the answers of a previous run, then .secrets.env,
# then the default.
read_env_file() { # file key -> value (unquoted, inline comment removed); empty when missing
    [ -f "$1" ] || return 0
    python3 - "$1" "$2" <<'PY'
import re, sys
path, key = sys.argv[1:]
val = None
for line in open(path, encoding="utf-8"):
    m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$", line.rstrip("\n"))
    if not m or m.group(1) != key:
        continue
    v = m.group(2).strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    else:
        v = re.sub(r"\s+#.*$", "", v).strip()
    val = v
if val is not None:
    print(val)
PY
}
known() { # key -> the first value found
    local k="$1" v="${!1:-}"
    [ -n "$v" ] || v="$(read_env_file "$CONFIG" "$k")"
    [ -n "$v" ] || v="$(read_env_file "$ANSWERS" "$k")"
    [ -n "$v" ] || v="$(read_env_file "$SECRETS" "$k")"
    printf '%s' "$v"
}
save_answer() {
    touch "$ANSWERS"; chmod 600 "$ANSWERS"
    python3 - "$ANSWERS" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1:]
lines = [l for l in open(path).read().splitlines() if not l.startswith(key + "=")]
lines.append(f"{key}={value}")
open(path, "w").write("\n".join(lines) + "\n")
PY
}
INTERACTIVE=0
[ $YES = 0 ] && [ -t 0 ] && INTERACTIVE=1
[ $YES = 1 ] || [ $INTERACTIVE = 1 ] || die "No terminal to ask questions on: pass --config FILE --yes."

# ask KEY "question" default required(1/0) secret(1/0) validator
ask() {
    local key="$1" q="$2" def="$3" req="$4" secret="${5:-0}" check="${6:-}" cur v shown typed
    cur="$(known "$key")"; [ -n "$cur" ] || cur="$def"
    while true; do
        v="$cur"; typed=0
        if [ $INTERACTIVE = 1 ] && { [ -z "$CONFIG" ] || [ -z "$(read_env_file "$CONFIG" "$key")" ]; } && [ -z "${!key:-}" ]; then
            shown="$cur"; [ "$secret" = 1 ] && [ -n "$cur" ] && shown="(kept: ••••${cur: -4})"
            echo
            echo "  ${B}$q${N}"
            if [ "$secret" = 1 ]; then read -r -s -p "  $key [${shown}]: " v </dev/tty; echo; else read -r -p "  $key [${shown}]: " v </dev/tty; fi
            [ -n "$v" ] || v="$cur"
            [ "$v" = "-" ] && v=""
            typed=1
        fi
        if [ "$req" = 1 ] && [ -z "$v" ]; then
            [ $typed = 1 ] || die "$key is required: set it in the --config file."
            warn "$key is required."; continue
        fi
        if [ -n "$v" ] && [ -n "$check" ] && ! "$check" "$v"; then
            [ $typed = 1 ] || die "$key: \"$v\" is not valid (from the environment or the --config file)."
            cur="$v"; continue
        fi
        break
    done
    printf -v "$key" '%s' "$v"
    save_answer "$key" "$v"
}
is_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { warn "not an email address"; return 1; }; }
is_url() { [[ "$1" =~ ^https?://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || { warn "must start with http:// or https://"; return 1; }; }
is_urls() { local u; for u in ${1//,/ }; do is_url "$u" || return 1; done; }
is_onoff() { [[ "$1" =~ ^(on|off)$ ]] || { warn "on or off"; return 1; }; }
is_yesno() { [[ "$1" =~ ^(yes|no)$ ]] || { warn "yes or no"; return 1; }; }
is_address() { [[ "$1" =~ ^(https?://)?[A-Za-z0-9.-]+$ ]] || { warn "a domain (posthog.example.com), an IP address, or http://name"; return 1; }; }
is_file() { local f="$1"; [[ "$f" = /* ]] || f="$APP_DIR/$f"; [ -f "$f" ] && python3 -c 'import json,sys; l=json.load(open(sys.argv[1])); assert isinstance(l,list) and all(x["path"].startswith("/") and x["name"] for x in l)' "$f" 2>/dev/null || { warn "not found, or not a JSON list like config/screens.example.json"; return 1; }; }
is_jql() { [ -n "$1" ]; }
hosts_of() { local u h out=""; for u in ${1//,/ }; do h="${u#*://}"; h="${h%%/*}"; h="${h%%:*}"; out="${out:+$out,}$h"; done; echo "$out"; }
public_ip() { curl -fs -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'; }

POSTHOG_DIR="$(known POSTHOG_DIR)"; POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
SCALE="$(known SCALE)"; SCALE="${SCALE:-yes}"

collect_answers() {
    step "Settings"
    [ $INTERACTIVE = 1 ] && say "Press Enter to keep the value in [brackets]. Type - to clear one."
    echo; echo "  ${B}PostHog${N}"
    ask POSTHOG_ADDRESS "Address people use to reach PostHog: a domain gets HTTPS (DNS must point here, ports 80 and 443 open); an IP or http://name is plain HTTP" "$(public_ip)" 1 0 is_address
    ask ADMIN_EMAIL "Email for the first PostHog login" "" 1 0 is_email
    ask ORG_NAME "Organization name in PostHog" "" 1
    ask APP_URLS "Your product's addresses, comma-separated (PostHog records sessions only there), e.g. https://app.example.com" "" 1 0 is_urls
    echo; echo "  ${B}Your events${N} (the names your app sends to PostHog)"
    ask PROP_CLIENT_ID "Event property with the client (customer account) id" client_id 1
    ask PROP_CLIENT_NAME "Event property with the client's display name" client_name 1
    ask PROP_APP_VERSION "Event property with your release, e.g. 26.10.0 (none: match releases by date only)" app_version 1
    ask PROP_PERSON_EMAIL "Person property with the user's email" email 1
    ask SCREENS_FILE "JSON file with your app's screens (like config/screens.example.json); empty: match pages by path only" "" 0 0 is_file
    echo; echo "  ${B}Jira${N} (optional: leave the address empty to connect it later)"
    ask JIRA_BASE_URL "Jira site, e.g. https://your-site.atlassian.net" "" 0 0 is_url
    if [ -n "$JIRA_BASE_URL" ]; then
        ask JIRA_EMAIL "Jira bot user's email" "" 1 0 is_email
        ask JIRA_API_TOKEN "Jira API token for that user (https://id.atlassian.com/manage-profile/security/api-tokens)" "" 1 1
        ask JIRA_RCI_ISSUE_TYPE "Issue type that gets triaged as an incident" RCI 1
        ask JIRA_RISK_ISSUE_TYPE "Issue type that gets triaged as a risk" "MMT Risk" 1
        ask RELEASES_JIRA_PROJECT "Jira project key whose fix versions are your releases, e.g. ACP" "" 1
        ask RELEASES_SUPPORT_JQL "JQL for the tickets that count as support tickets" 'project = SUP AND issuetype in ("RCI", "MMT Risk")' 1 0 is_jql
    else
        for k in JIRA_EMAIL JIRA_API_TOKEN JIRA_RCI_ISSUE_TYPE JIRA_RISK_ISSUE_TYPE RELEASES_JIRA_PROJECT RELEASES_SUPPORT_JQL; do printf -v "$k" '%s' "$(known "$k")"; done
    fi
    echo; echo "  ${B}Claude${N}"
    ask ANTHROPIC_API_KEY "Anthropic API key, so the Jira automation reads ticket text with Claude (optional)" "" 0 1
    echo; echo "  ${B}MCP servers for Claude${N}"
    ask FEATURE_LENS_MCP "This project's MCP tools (replay links, tickets, clients, screens, releases): on or off" on 1 0 is_onoff
    ask POSTHOG_MCP_URL "PostHog's own MCP server address (optional), e.g. https://mcp.posthog.com/mcp" "" 0 0 is_url
    if [ -n "$POSTHOG_MCP_URL" ]; then
        ask POSTHOG_MCP_API_KEY "Personal API key for PostHog's MCP server, WITHOUT any session_recording scope" "" 1 1
        ask FEATURE_POSTHOG_MCP "Give Claude PostHog's MCP server: on or off" on 1 0 is_onoff
    else
        POSTHOG_MCP_API_KEY=""; FEATURE_POSTHOG_MCP=off
    fi
    echo; echo "  ${B}This service${N}"
    local host; host="$(hosts_of "$POSTHOG_ADDRESS")"
    ask SERVICE_PUBLIC_URL "Where people open clip links and Claude reaches /mcp (put HTTPS in front before sharing it widely)" "http://$host:8080" 1 0 is_url
    ask CLIP_ALLOWED_HOSTS "Hosts a recording may load while it renders (your app's hosts and CDN), comma-separated" "$(hosts_of "$APP_URLS")" 1
    echo; echo "  ${B}Status page${N}"
    ask STATUS_PUBLIC "Status page for everyone on port 8090, behind a password (yes), or only on this machine (no)" no 1 0 is_yesno
    STATUS_PASSWORD=""
    [ "$STATUS_PUBLIC" = yes ] && ask STATUS_PASSWORD "Status page password (Enter: keep the one shown masked, made up for you)" "$(openssl rand -hex 12)" 1 1
    save_answer POSTHOG_DIR "$POSTHOG_DIR"; save_answer SCALE "$SCALE"
}

show_plan() {
    local scheme=http host; host="$(hosts_of "$POSTHOG_ADDRESS")"
    [[ "$POSTHOG_ADDRESS" == http://* ]] || [[ "$host" =~ ^[0-9.]+$ ]] || scheme=https
    POSTHOG_PUBLIC_URL="$scheme://$host"
    . "$HERE/migrate/versions/versions.env"
    step "Plan"
    say "PostHog         $POSTHOG_PUBLIC_URL  ($([ $scheme = https ] && echo "HTTPS, certificate from Let's Encrypt" || echo "plain HTTP: private network or VPN only"))"
    if [ $USE_EXISTING = 1 ]; then say "                keep the PostHog already in $POSTHOG_DIR"
    else say "                version ${TARGET_COMMIT:0:12}, installed in $POSTHOG_DIR$([ "$SCALE" = yes ] && echo ", tuned for ~200 events/s")"; fi
    say "login           $ADMIN_EMAIL (organization \"$ORG_NAME\"), recording on $APP_URLS"
    say "PostHog Lens    $SERVICE_PUBLIC_URL, from $APP_DIR, as user $APP_USER, starts at boot"
    say "Jira            $([ -n "$JIRA_BASE_URL" ] && echo "$JIRA_BASE_URL (releases from $RELEASES_JIRA_PROJECT)" || echo "not connected yet (connect it later in .secrets.env)")"
    say "Claude reading  $([ -n "$ANTHROPIC_API_KEY" ] && echo on || echo "off (keyword rules)")"
    say "MCP             Lens tools $FEATURE_LENS_MCP, PostHog's MCP $FEATURE_POSTHOG_MCP"
    say "Status page     $([ "$STATUS_PUBLIC" = yes ] && echo "http://$host:8090 with a password" || echo "http://127.0.0.1:8090 on this machine only")"
    if [ $INTERACTIVE = 1 ]; then
        local a; echo; read -r -p "  Install now? [y/N] " a </dev/tty
        [[ "$a" =~ ^[Yy] ]] || { CURRENT=""; echo "Nothing was installed. Your answers are kept for next time."; exit 0; }
    fi
}

run_as_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" PUPPETEER_CACHE_DIR="$APP_DIR/.cache/puppeteer" PATH="/usr/local/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }
posthog_healthy() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$POSTHOG_URL/_health" || true)" = 200 ]; }
# The command line of whatever listens on a TCP port (empty when the port is free).
port_user() {
    local pid; pid="$(ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
    [ -n "$pid" ] || { ss -Hltn "sport = :$1" 2>/dev/null | grep -q . && echo "(unknown process)"; return 0; }
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || echo "pid $pid"
}

# ------------------------------------------------------------------ steps
step_check() {
    CURRENT=check; step "Checking this machine"
    . /etc/os-release
    case "$ID" in ubuntu|debian) ok "OS: $PRETTY_NAME" ;; *) die "Ubuntu or Debian only (this is $PRETTY_NAME)." ;; esac
    [ "$(uname -m)" = x86_64 ] || die "x86_64 only: Chrome for rendering clips has no Linux arm64 build (this is $(uname -m))."
    local ram disk; ram=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
    [ "$ram" -ge "$MIN_RAM_GB" ] || die "Needs 16 GB of memory or more (this machine has ${ram} GB)."
    mkdir -p "$POSTHOG_DIR"
    disk=$(( $(df -Pk "$POSTHOG_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
    [ "$disk" -ge "$MIN_DISK_GB" ] || die "Needs ${MIN_DISK_GB} GB free at $POSTHOG_DIR (has ${disk} GB)."
    ok "memory ${ram} GB, free disk ${disk} GB, $(nproc) CPUs"
    # The service user must reach the project folder: no folder on the way may be private (like /root).
    local d="$APP_DIR"
    while [ "$d" != / ]; do
        d="$(dirname "$d")"
        [ "$(( 0$(stat -c %a "$d") & 1 ))" = 1 ] || die "$APP_DIR is inside $d, which other users cannot enter. Clone the project to /srv/ticket-triage and run it from there."
    done
    ok "project folder $APP_DIR"
    if [ $USE_EXISTING = 1 ]; then
        posthog_healthy || die "--use-existing-posthog: PostHog in $POSTHOG_DIR is not answering on $POSTHOG_URL/_health."
        ok "using the PostHog already running in $POSTHOG_DIR"
    elif [ -f "$POSTHOG_DIR/.env" ] && ! done_step posthog; then
        die "$POSTHOG_DIR already holds a PostHog. Bring it to the tested version with deploy/migrate/posthog-upgrade.sh, then run this with --use-existing-posthog."
    fi
    local p u sp; sp="$(known SERVICE_PORT)"; sp="${sp:-8080}"
    for p in 80 443 "$sp" 8090; do
        u="$(port_user "$p")"
        [ -z "$u" ] && continue
        case "$p:$u" in
            80:*docker-proxy*|443:*docker-proxy*|8090:*docker-proxy*) ;;  # PostHog's proxy, the status page
            "$sp":*src/service/server.ts*) ;;                           # the triage service from an earlier run
            *) die "Port $p is already in use by: $u" ;;
        esac
    done
    ok "ports 80, 443, $sp and 8090 are free (or ours)"
    finish check
}

step_packages() {
    CURRENT=packages; step "Installing base tools and what Chrome needs"
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates git openssl python3 xz-utils iproute2 util-linux apparmor >/dev/null
    # Chrome's libraries; Ubuntu 24.04+ renamed some to …t64.
    local pkgs=() p
    for p in libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdrm2 libgbm1 libasound2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 libxi6 libxrender1 libx11-6 libxcb1 \
        libdbus-1-3 libexpat1 libglib2.0-0 libpango-1.0-0 libcairo2 \
        fonts-liberation fonts-noto-core fonts-noto-mono fonts-noto-color-emoji; do
        if apt-cache show "${p}t64" >/dev/null 2>&1; then pkgs+=("${p}t64"); else pkgs+=("$p"); fi
    done
    apt-get install -y -qq "${pkgs[@]}" >/dev/null
    ok "installed ${#pkgs[@]} packages for Chrome and fonts"
    finish packages
}

step_posthog() {
    CURRENT=posthog; step "Installing PostHog (30-60 minutes the first time)"
    . "$HERE/migrate/versions/versions.env"
    POSTHOG_APP_TAG="$TARGET_COMMIT" POSTHOG_PINNED_COMPOSE="$HERE/migrate/versions/docker-compose.pinned.yml" \
        POSTHOG_INSTALL_DIR="$POSTHOG_DIR" bash "$HERE/posthog/install-posthog-hobby.sh" "$POSTHOG_ADDRESS" </dev/null
    local i
    for i in $(seq 1 60); do posthog_healthy && break; say "waiting for PostHog to answer ($i/60)"; sleep 30; done
    posthog_healthy || die "PostHog is not healthy (curl $POSTHOG_URL/_health). See: cd $POSTHOG_DIR && docker compose logs --tail 50 web"
    [ "$(git -C "$POSTHOG_DIR/posthog" rev-parse HEAD)" = "$TARGET_COMMIT" ] || die "PostHog's source is not at $TARGET_COMMIT."
    ok "PostHog is up at version ${TARGET_COMMIT:0:12}"
    finish posthog
}

step_scale() {
    CURRENT=scale; step "Tuning PostHog for load (deploy/posthog/scale.sh)"
    . "$HERE/migrate/versions/versions.env"
    NODE_BASE_IMAGE="$NODE_BASE_IMAGE" POSTHOG_DIR="$POSTHOG_DIR" bash "$HERE/posthog/scale.sh" </dev/null
    local i; for i in $(seq 1 40); do posthog_healthy && break; sleep 15; done
    posthog_healthy || die "PostHog is not healthy after scale.sh. Undo with: sudo deploy/posthog/scale.sh --undo"
    finish scale
}

step_node() {
    CURRENT=node; step "Node $NODE_MAJOR and pnpm"
    if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]; then
        ok "Node $(node -v) is already installed"
    else
        local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp file
        tmp="$(mktemp -d)"
        curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
        file="$(grep -oE "node-v${NODE_MAJOR}\.[0-9.]+-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
        [ -n "$file" ] || die "Could not find Node $NODE_MAJOR for linux-x64 on nodejs.org."
        curl -fsSL "$base/$file" -o "$tmp/$file"
        (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node download does not match its checksum."
        tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
        rm -rf "$tmp"
        ok "Node $(/usr/local/bin/node -v) installed in /usr/local"
    fi
    if command -v pnpm >/dev/null && [ "$(pnpm -v | cut -d. -f1)" = "${PNPM_VERSION%%.*}" ]; then
        ok "pnpm $(pnpm -v) is already installed"
    else
        npm install -g --silent "pnpm@$PNPM_VERSION" >/dev/null
        ok "pnpm $(pnpm -v) installed"
    fi
    finish node
}

step_user() {
    CURRENT=user; step "Service user"
    if id "$APP_USER" >/dev/null 2>&1; then ok "user $APP_USER exists"
    else useradd --system --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"; ok "created user $APP_USER"; fi
    mkdir -p "$APP_HOME"; chown "$APP_USER:$APP_USER" "$APP_HOME"; chmod 750 "$APP_HOME"
    mkdir -p "$APP_DIR"/{run,logs,clips,.cache}
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
    git config --system --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" || git config --system --add safe.directory "$APP_DIR"
    ok "$APP_DIR belongs to $APP_USER"
    finish user
}

step_app() {
    CURRENT=app; step "Installing the project (pnpm install, Chrome for rendering)"
    [ -f "$APP_DIR/vendor/rasterizer.cjs" ] && [ -f "$APP_DIR/vendor/player.html" ] || die "vendor/rasterizer.cjs or vendor/player.html is missing from the project folder."
    (cd "$APP_DIR" && run_as_app CI=true pnpm install --frozen-lockfile --reporter=append-only) | tail -5
    local chrome
    chrome="$(ls -d "$APP_DIR"/.cache/puppeteer/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | head -1)"
    [ -x "$chrome" ] || die "Chrome for rendering was not downloaded (pnpm install should have fetched it)."
    ok "Chrome: ${chrome#"$APP_DIR"/}"
    # Ubuntu 23.10+ blocks unprivileged user namespaces, which Chrome's sandbox needs: allow them for
    # this project's Chrome only.
    if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
        local profile=ticket-triage-chrome
        [ "$APP_DIR" = /srv/ticket-triage ] || profile="$profile$(echo "$APP_DIR" | tr -c 'a-zA-Z0-9\n' '-')"
        sed "s#/srv/ticket-triage#$APP_DIR#g; s#profile ticket-triage-chrome #profile $profile #" "$HERE/apparmor-ticket-triage-chrome" >"/etc/apparmor.d/$profile"
        apparmor_parser -r "/etc/apparmor.d/$profile"
        ok "AppArmor rule for Chrome's sandbox loaded"
    fi
    run_as_app "$chrome" --headless --disable-gpu --dump-dom about:blank >/dev/null 2>&1 \
        || die "Chrome does not start as $APP_USER: run  sudo -u $APP_USER $chrome --headless --dump-dom about:blank  to see why."
    ok "Chrome starts, sandboxed, as $APP_USER"
    finish app
}

step_account() {
    CURRENT=account; step "PostHog login, project and API key"
    posthog_healthy || die "PostHog is not answering on $POSTHOG_URL/_health."
    ADMIN_EMAIL="$ADMIN_EMAIL" POSTHOG_PUBLIC_URL="$POSTHOG_PUBLIC_URL" ORG_NAME="$ORG_NAME" APP_URLS="$APP_URLS" \
        SERVICE_PUBLIC_URL="$SERVICE_PUBLIC_URL" POSTHOG_DIR="$POSTHOG_DIR" POSTHOG_URL="$POSTHOG_URL" SECRETS="$SECRETS" bash "$APP_DIR/scripts/setup-posthog.sh"
    chown "$APP_USER:$APP_USER" "$SECRETS"; chmod 600 "$SECRETS"
    [ -n "$(read_env_file "$SECRETS" POSTHOG_PERSONAL_API_KEY)" ] || die "No API key was written to .secrets.env."
    finish account
}

set_secret() { # key value: writes it into .secrets.env, replacing the old line
    python3 - "$SECRETS" "$1" "$2" <<'PY'
import sys
path, key, value = sys.argv[1:]
lines = open(path).read().splitlines()
for i, line in enumerate(lines):
    if line.startswith(key + "="):
        lines[i] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")
open(path, "w").write("\n".join(lines) + "\n")
PY
}

APP_KEYS=(PROP_CLIENT_ID PROP_CLIENT_NAME PROP_APP_VERSION PROP_PERSON_EMAIL SCREENS_FILE JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN
    JIRA_RCI_ISSUE_TYPE JIRA_RISK_ISSUE_TYPE RELEASES_JIRA_PROJECT RELEASES_SUPPORT_JQL ANTHROPIC_API_KEY FEATURE_LENS_MCP
    FEATURE_POSTHOG_MCP POSTHOG_MCP_URL POSTHOG_MCP_API_KEY SERVICE_PUBLIC_URL CLIP_ALLOWED_HOSTS)
step_settings() {
    CURRENT=settings; step "Writing .secrets.env"
    local k v n=0
    for k in "${APP_KEYS[@]}"; do set_secret "$k" "${!k:-}"; n=$((n + 1)); done
    # Any other setting from .env.example that the --config file sets, copied as it is.
    if [ -n "$CONFIG" ]; then
        for k in $(grep -oE '^[A-Z_]+=' "$APP_DIR/.env.example" | tr -d =); do
            case " ${APP_KEYS[*]} POSTHOG_HOST POSTHOG_PUBLIC_HOST POSTHOG_PROJECT_ID POSTHOG_PROJECT_TOKEN POSTHOG_PERSONAL_API_KEY POSTHOG_ADMIN_EMAIL POSTHOG_ADMIN_PASSWORD " in *" $k "*) continue ;; esac
            v="$(read_env_file "$CONFIG" "$k")"
            [ -n "$v" ] && { set_secret "$k" "$v"; n=$((n + 1)); }
        done
    fi
    chown "$APP_USER:$APP_USER" "$SECRETS"; chmod 600 "$SECRETS"
    ok "$n settings written to $SECRETS (mode 600)"
    finish settings
}

step_service() {
    CURRENT=service; step "Starting the triage service (systemd)"
    cat >/etc/systemd/system/$UNIT <<EOF
# Written by deploy/install.sh. PostHog Lens: the triage service.
[Unit]
Description=PostHog Lens triage service
After=network-online.target docker.service posthog.service
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$APP_HOME
Environment=PUPPETEER_CACHE_DIR=$APP_DIR/.cache/puppeteer
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning --import tsx src/service/server.ts
Restart=on-failure
RestartSec=5
StandardOutput=append:$APP_DIR/logs/service.log
StandardError=append:$APP_DIR/logs/service.log

[Install]
WantedBy=multi-user.target
EOF
    # A service started earlier by scripts/stack.sh would hold the port.
    if [ -f "$APP_DIR/run/service.pid" ] && ! systemctl is-enabled -q "$UNIT" 2>/dev/null; then (cd "$APP_DIR" && scripts/stack.sh stop service); fi
    systemctl daemon-reload
    systemctl enable -q "$UNIT"
    systemctl restart "$UNIT"
    local port i; port="$(read_env_file "$SECRETS" SERVICE_PORT)"; port="${port:-8080}"
    for i in $(seq 1 60); do curl -fs -o /dev/null -m 2 "http://localhost:$port/healthz" && break; sleep 1; done
    curl -fs -o /dev/null -m 2 "http://localhost:$port/healthz" || { tail -20 "$APP_DIR/logs/service.log"; die "The service did not answer on port $port."; }
    ok "running on port $port, starts at boot ($UNIT)"
    finish service
}

step_status() {
    CURRENT=status; step "Status page"
    local f="$HERE/status/status.env" port project
    port="$(read_env_file "$SECRETS" SERVICE_PORT)"; port="${port:-8080}"
    project="$(basename "$POSTHOG_DIR")"
    touch "$f"; chmod 600 "$f"
    python3 - "$f" "$port" "$project" "${STATUS_PASSWORD:-}" "$([ "$STATUS_PUBLIC" = yes ] && echo 0.0.0.0 || echo 127.0.0.1)" <<'PY'
import sys
path, port, project, password, bind = sys.argv[1:]
want = {
    "STATUS_PROJECTS": project,
    "STATUS_PASSWORD": password,
    "STATUS_BIND": bind,
    # The default list without the demo app, which a real install does not have.
    "STATUS_HTTP": ",".join([
        "PostHog|App (through the proxy)|http://proxy:80/_health",
        "PostHog|Web|http://web:8000/_health",
        "PostHog|Event capture|http://capture:3000/_readiness",
        "PostHog|Replay capture|http://replay-capture:3000/_readiness",
        "PostHog|Feature flags|http://feature-flags:3001/_readiness",
        "PostHog|Replay reader|http://recording-api:6738/_health",
        "PostHog|ClickHouse|http://clickhouse:8123/ping",
        f"Lens|Triage service|http://host.docker.internal:{port}/health",
    ]),
}
lines = [l for l in open(path).read().splitlines() if l.split("=", 1)[0] not in want]
lines += [f"{k}={v}" for k, v in want.items()]
open(path, "w").write("\n".join(lines) + "\n")
PY
    POSTHOG_NETWORK="${project}_default" bash "$HERE/status/up.sh"
    finish status
}

step_mcp() {
    CURRENT=mcp; step "MCP config for Claude Code"
    (cd "$APP_DIR" && run_as_app node --disable-warning=ExperimentalWarning --import tsx scripts/mcp-config.ts)
    finish mcp
}

step_doctor() {
    CURRENT=doctor; step "Checking everything (pnpm doctor)"
    if (cd "$APP_DIR" && run_as_app node --disable-warning=ExperimentalWarning --import tsx scripts/doctor.ts); then
        finish doctor
    else
        die "pnpm doctor found a problem (✘ above). Fix the setting in $SECRETS, then run this script again."
    fi
}

write_summary() {
    CURRENT=""
    local host token mcp_on f="$STATE_DIR/summary.txt"
    host="$(hosts_of "$POSTHOG_ADDRESS")"
    token="$(read_env_file "$SECRETS" POSTHOG_PROJECT_TOKEN)"
    mcp_on="$(read_env_file "$SECRETS" FEATURE_LENS_MCP)"
    umask 077
    cat >"$f" <<EOF
PostHog Lens is installed ($(date -u '+%Y-%m-%d %H:%M UTC')).

PostHog
  Open            $POSTHOG_PUBLIC_URL
  Login           $ADMIN_EMAIL, password: sudo grep POSTHOG_ADMIN_PASSWORD $SECRETS
  Files           $POSTHOG_DIR (back up $POSTHOG_DIR/.env: its secrets encrypt data)
  Start / stop    sudo systemctl start posthog / sudo systemctl stop posthog
  Upgrade         sudo $HERE/migrate/posthog-upgrade.sh (backs up first, asks before deleting)

Your app: add PostHog to it (it records only on $APP_URLS)
  posthog.init('$token', { api_host: '$POSTHOG_PUBLIC_URL', person_profiles: 'identified_only' })
  posthog.identify(userId, { $PROP_PERSON_EMAIL: user.email })
  posthog.register({ $PROP_CLIENT_ID: account.id, $PROP_CLIENT_NAME: account.name$([ "$PROP_APP_VERSION" = none ] || echo ", $PROP_APP_VERSION: '<your release, e.g. 26.10.0>'") })
  PostHog Lens finds a ticket's session by those names. pnpm doctor checks that your events carry them.

PostHog Lens
  Clip links      $SERVICE_PUBLIC_URL
  Settings        $SECRETS (every setting is explained in $APP_DIR/.env.example)
  After a change  sudo systemctl restart ${UNIT%.service}      (and pnpm mcp:config after an MCP switch)
  Logs            $APP_DIR/logs/service.log
  Check           cd $APP_DIR && sudo -u $APP_USER pnpm doctor
EOF
    if [ "$mcp_on" != off ]; then cat >>"$f" <<EOF

Claude
  Claude Code     run claude in $APP_DIR: .mcp.json is ready (approve the server once)
  Other clients   $SERVICE_PUBLIC_URL/mcp with the header  Authorization: Bearer <MCP_TOKEN>
                  token: sudo grep MCP_TOKEN $SECRETS
EOF
    fi
    cat >>"$f" <<EOF

Jira
EOF
    if [ -n "$JIRA_BASE_URL" ]; then cat >>"$f" <<EOF
  In Jira: System > WebHooks > Create, event "Issue created", URL $SERVICE_PUBLIC_URL/webhooks/jira,
  secret: sudo grep JIRA_WEBHOOK_SECRET $SECRETS
EOF
    else cat >>"$f" <<EOF
  Not connected. To connect: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, RELEASES_JIRA_PROJECT (and
  JIRA_RCI_ISSUE_TYPE, JIRA_RISK_ISSUE_TYPE, RELEASES_SUPPORT_JQL if yours differ) in $SECRETS,
  run sudo systemctl restart ${UNIT%.service}, then add the webhook: event "Issue created",
  URL $SERVICE_PUBLIC_URL/webhooks/jira, secret: sudo grep JIRA_WEBHOOK_SECRET $SECRETS
EOF
    fi
    cat >>"$f" <<EOF

Status page
EOF
    if [ "$STATUS_PUBLIC" = yes ]; then echo "  http://$host:8090  (any user name, password: sudo grep STATUS_PASSWORD $HERE/status/status.env)" >>"$f"
    else echo "  http://127.0.0.1:8090 on this machine. From your computer: ssh -L 8090:127.0.0.1:8090 <this machine>, then http://localhost:8090" >>"$f"; fi
    echo "  For uptime monitors: http://127.0.0.1:8090/healthz (200 or 503, no password)" >>"$f"
    [ -n "$SCREENS_FILE" ] || printf '\nNot set yet: SCREENS_FILE (your screens, like config/screens.example.json). Pages are matched by path until then.\n' >>"$f"
    printf '\nThis summary: sudo %s status\n' "$0" >>"$f"
    echo; echo "${G}${B}Done.${N}"; echo; cat "$f"
}

# ------------------------------------------------------------------ run
collect_answers
show_plan
for s in "${STEPS[@]}"; do
    if done_step "$s" && [[ "$ALWAYS" != *" $s "* ]]; then echo; say "${D}step $s: already done ($(cat "$STATE_DIR/done/$s"))${N}"; continue; fi
    case "$s" in
        posthog|scale) if [ $USE_EXISTING = 1 ]; then say "${D}step $s: skipped (--use-existing-posthog)${N}"; continue; fi ;;
    esac
    [ "$s" = scale ] && [ "$SCALE" != yes ] && { say "${D}step scale: skipped (SCALE=$SCALE)${N}"; continue; }
    "step_$s"
done
write_summary
