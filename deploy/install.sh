#!/usr/bin/env bash
# Fresh install on a new machine: PostHog (the exact version tested with this project), PostHog Lens
# (the triage service) and its status page. For a machine that already runs PostHog, use
# deploy/migrate/posthog-upgrade.sh to bring PostHog to this version first.
#
#   sudo deploy/install.sh                                  # asks two things, shows the plan, installs
#   sudo deploy/install.sh --config my-install.env          # every other setting from a file (deploy/install.env.example)
#   sudo deploy/install.sh --config my-install.env --yes    # no questions at all
#   sudo deploy/install.sh --use-existing-posthog           # PostHog is already on this version: keep it
# On a machine that already runs a self-hosted PostHog, the same command upgrades that PostHog in place
# (deploy/migrate/posthog-upgrade.sh: backup first, every image pinned, its data kept) instead of
# installing one. It finds that PostHog by itself and also asks whether to copy the session replays.
#   sudo deploy/install.sh status                           # which steps are done, and the summary
#
# Steps (each one checks its result; a finished step is skipped when you run the script again, a failed
# one is retried):
#   check     root, Amazon Linux 2023, x86_64, memory, disk, ports, where the project folder is
#   packages  base tools, the libraries and fonts Chrome needs to render replay clips
#   posthog   PostHog through deploy/posthog/install-posthog-hobby.sh, every image pinned by digest
#             (deploy/migrate/versions), started at boot by posthog.service. 30-60 minutes.
#             With a PostHog already here: deploy/migrate/posthog-upgrade.sh instead. About 2 hours.
#   scale     deploy/posthog/scale.sh: about 200 events a second without losing any (SCALE=no skips it)
#   addresses PostHog answers on every address in POSTHOG_ADDRESS, each one trusted for logins (CSRF)
#   node      Node 24 (checked against nodejs.org's checksums) and pnpm 10
#   user      the unprivileged "triage" user the service runs as; it owns the project folder
#   app       pnpm install (with Chrome for rendering), the user-namespace setting Chrome's sandbox needs
#   account   the PostHog login, organization, project settings and a read-only API key
#             (scripts/setup-posthog.sh)
#   posthog_mcp  PostHog's own MCP server on this machine (deploy/posthog-mcp), with its own read-only
#             key that has no session replay scopes. FEATURE_POSTHOG_MCP=off skips it.
#   settings  your answers into .secrets.env (mode 600), keeping anything already there
#   service   ticket-triage.service: starts at boot, restarts on failure, logs to logs/service.log
#   status    the status page (deploy/status), only on this machine or behind a password
#   mcp       .mcp.json for Claude Code, from the two MCP switches
#   doctor    pnpm doctor: checks every setting against the running services
# check, addresses, posthog_mcp, settings, service, status, mcp and doctor run every time, so changed answers take effect.
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
# docker compose build (the status page) needs buildx 0.17 or later; Amazon Linux's docker package has an
# older one or none. This one is installed when it is missing, checked against its release checksum.
BUILDX_VERSION=v0.37.2
BUILDX_SHA256=982ca20490b45ed1ec8d99795974d3d874a358f75938c9c237305010e6b7e548
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
STEPS=(check packages posthog scale addresses node user app account posthog_mcp settings service status mcp doctor)
# Cheap and safe to repeat, so they run every time and changed answers take effect.
ALWAYS=" check addresses posthog_mcp settings service status mcp doctor "

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

# setting KEY default [validator]: a setting that is never asked. It comes from the environment, the
# --config file, an earlier answer or .secrets.env, else the default.
setting() {
    local key="$1" v; v="$(known "$key")"; [ -n "$v" ] || v="$2"
    [ "$v" = "-" ] && v=""
    if [ -n "$v" ] && [ -n "${3:-}" ] && ! "$3" "$v"; then die "$key: \"$v\" is not valid. Fix it in the --config file (or $ANSWERS)."; fi
    printf -v "$key" '%s' "$v"
    save_answer "$key" "$v"
}
need() { [ -n "${!1}" ] || die "$1 is required when $2 is set: add it to the --config file."; }

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
addr_kind() { local h="${1#*://}"; [[ "$1" == http://* ]] || [[ "$h" =~ ^[0-9.]+$ ]] && echo http || echo https; }
# One or more addresses, comma-separated, all of one kind: domains with HTTPS, or IPs and http:// names.
is_addresses() {
    local a first=""
    for a in ${1//,/ }; do
        is_address "$a" || return 1
        [ -n "$first" ] || first="$(addr_kind "$a")"
        [ "$(addr_kind "$a")" = "$first" ] || { warn "mix of kinds: use only domains (HTTPS), or only IPs and http:// names (plain HTTP)"; return 1; }
    done
    [ -n "$first" ]
}
is_file() { local f="$1"; [[ "$f" = /* ]] || f="$APP_DIR/$f"; [ -f "$f" ] && python3 -c 'import json,sys; l=json.load(open(sys.argv[1])); assert isinstance(l,list) and all(x["path"].startswith("/") and x["name"] for x in l)' "$f" 2>/dev/null || { warn "not found, or not a JSON list like config/screens.example.json"; return 1; }; }
is_jql() { [ -n "$1" ]; }
hosts_of() { local u h out=""; for u in ${1//,/ }; do h="${u#*://}"; h="${h%%/*}"; h="${h%%:*}"; out="${out:+$out,}$h"; done; echo "$out"; }
# On EC2 the instance metadata service (IMDSv2) knows the public IP; elsewhere ask ipify, then use the
# first local address.
public_ip() {
    local t ip
    t="$(curl -fs -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
    [ -n "$t" ] && ip="$(curl -fs -m 2 -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
    [[ "${ip:-}" =~ ^[0-9.]+$ ]] || ip="$(curl -fs -m 5 https://api.ipify.org 2>/dev/null || true)"
    [[ "${ip:-}" =~ ^[0-9.]+$ ]] || ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
    echo "$ip"
}

POSTHOG_DIR="$(known POSTHOG_DIR)"; POSTHOG_DIR_GIVEN="${POSTHOG_DIR:+1}"; POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
LOCAL_MCP_URL=http://127.0.0.1:8787/mcp
SCALE="$(known SCALE)"; SCALE="${SCALE:-yes}"

collect_answers() {
    step "Settings"
    local def_address def_admin n
    if [ "$MODE" = fresh ]; then
        def_address="$(public_ip)"
    else
        say "Found a PostHog in $POSTHOG_DIR: $([ "$MODE" = upgrade ] && echo "it is upgraded in place, keeping its data" || echo "already on the tested version, kept as it is")."
        def_address="$(existing_address)"; [ -n "$def_address" ] || def_address="$(public_ip)"
        [ -n "$(known ADMIN_EMAIL)" ] || def_admin="$(existing_admin)"
    fi
    [ $INTERACTIVE = 1 ] && say "Press Enter to keep the value in [brackets]."
    ask POSTHOG_ADDRESS "Address(es) people use to reach PostHog, comma-separated (the first is the main one). Domains get HTTPS (DNS must point here, ports 80 and 443 open in the security group); IPs and http://names are plain HTTP. Do not mix the two." "$def_address" 1 0 is_addresses
    POSTHOG_ADDRESS="${POSTHOG_ADDRESS// /}"; save_answer POSTHOG_ADDRESS "$POSTHOG_ADDRESS"
    if [ "$MODE" = fresh ]; then
        ask ADMIN_EMAIL "Email for the first PostHog login" "" 1 0 is_email
    else
        ask ADMIN_EMAIL "Email of a PostHog login that PostHog Lens works as (its current project is the one Lens uses)" "${def_admin:-}" 1 0 is_email
    fi
    if [ "$MODE" = upgrade ]; then
        # posthog-upgrade.sh keeps the choice once made; a run that continues does not ask again.
        if [ -n "$(cat "$POSTHOG_DIR/upgrade-state/replays" 2>/dev/null)" ]; then
            MIGRATE_REPLAYS="$([ "$(cat "$POSTHOG_DIR/upgrade-state/replays")" = copy ] && echo yes || echo no)"
        else
            n="$(existing_recordings)"
            ask MIGRATE_REPLAYS "Copy the ${n:+$n }session replays to the new version (yes), or leave them in the old storage for now (no: the new version lists them but cannot play them until you copy them with deploy/migrate/posthog-upgrade.sh replays)" yes 1 0 is_yesno
        fi
    fi

    # Everything below has a default and is never asked. Change one in a --config file
    # (deploy/install.env.example), or in .secrets.env afterwards.
    local host; host="$(hosts_of "${POSTHOG_ADDRESS%%,*}")"
    setting ORG_NAME ION
    # Only from the environment or --config: empty means PostHog records on every site that sends events.
    APP_URLS="${APP_URLS:-$(read_env_file "$CONFIG" APP_URLS)}"
    [ -z "$APP_URLS" ] || is_urls "$APP_URLS" || die "APP_URLS: \"$APP_URLS\" is not a list of http(s):// addresses."
    setting PROP_CLIENT_ID client_id
    setting PROP_CLIENT_NAME client_name
    setting PROP_APP_VERSION app_version
    setting PROP_PERSON_EMAIL email
    setting SCREENS_FILE "" is_file
    setting JIRA_BASE_URL "" is_url
    setting JIRA_EMAIL "" is_email
    setting JIRA_API_TOKEN ""
    setting JIRA_RCI_ISSUE_TYPE RCI
    setting JIRA_RISK_ISSUE_TYPE "MMT Risk"
    setting RELEASES_JIRA_PROJECT ""
    setting RELEASES_SUPPORT_JQL 'project = SUP AND issuetype in ("RCI", "MMT Risk")'
    if [ -n "$JIRA_BASE_URL" ]; then
        need JIRA_EMAIL JIRA_BASE_URL; need JIRA_API_TOKEN JIRA_BASE_URL; need RELEASES_JIRA_PROJECT JIRA_BASE_URL
    fi
    setting ANTHROPIC_API_KEY ""
    setting FEATURE_LENS_MCP on is_onoff
    setting FEATURE_POSTHOG_MCP on is_onoff
    # Empty, or the address of the one this installer runs: PostHog's MCP server on this machine.
    setting POSTHOG_MCP_URL "" is_url
    setting POSTHOG_MCP_API_KEY ""
    LOCAL_MCP=0
    if [ "$FEATURE_POSTHOG_MCP" = on ]; then
        if [ -z "$POSTHOG_MCP_URL" ] || [ "$POSTHOG_MCP_URL" = "$LOCAL_MCP_URL" ]; then LOCAL_MCP=1
        else need POSTHOG_MCP_API_KEY POSTHOG_MCP_URL; fi
    fi
    setting SERVICE_PUBLIC_URL "http://$host:8080" is_url
    setting CLIP_ALLOWED_HOSTS "$([ -n "$APP_URLS" ] && hosts_of "$APP_URLS" || echo localhost)"
    setting STATUS_PUBLIC no is_yesno
    STATUS_PASSWORD=""
    [ "$STATUS_PUBLIC" = yes ] && setting STATUS_PASSWORD "$(openssl rand -hex 12)"
    save_answer POSTHOG_DIR "$POSTHOG_DIR"; save_answer SCALE "$SCALE"
}

show_plan() {
    local scheme host a others=""; host="$(hosts_of "${POSTHOG_ADDRESS%%,*}")"
    scheme="$(addr_kind "${POSTHOG_ADDRESS%%,*}")"
    POSTHOG_PUBLIC_URL="$scheme://$host"
    for a in $(hosts_of "$POSTHOG_ADDRESS" | tr , ' '); do [ "$a" = "$host" ] || others="${others:+$others, }$scheme://$a"; done
    . "$HERE/migrate/versions/versions.env"
    step "Plan"
    say "PostHog         $POSTHOG_PUBLIC_URL  ($([ $scheme = https ] && echo "HTTPS, certificate from Let's Encrypt" || echo "plain HTTP: private network or VPN only"))"
    [ -z "$others" ] || say "                also at $others"
    case "$MODE" in
        existing) say "                keep the PostHog already in $POSTHOG_DIR" ;;
        upgrade)
            say "                ${B}upgrade the PostHog in $POSTHOG_DIR${N} to version ${TARGET_COMMIT:0:12}, keeping its data"
            say "                (deploy/migrate/posthog-upgrade.sh: full backup first; PostHog is down about 2 hours;"
            say "                stop the apps that send events first, or it stops at its first check)"
            say "                session replays: $([ "$MIGRATE_REPLAYS" = yes ] && echo "copied, then every one played to check it" || echo "NOT copied now (they stay in the old storage)")" ;;
        *) say "                version ${TARGET_COMMIT:0:12}, installed in $POSTHOG_DIR$([ "$SCALE" = yes ] && echo ", tuned for ~200 events/s")" ;;
    esac
    if [ "$MODE" = fresh ]; then say "login           $ADMIN_EMAIL (organization \"$ORG_NAME\"), recording on ${APP_URLS:-every site that sends events}"
    else say "login           $ADMIN_EMAIL (its current project), recording on ${APP_URLS:-every site that sends events}"; fi
    say "PostHog Lens    $SERVICE_PUBLIC_URL, from $APP_DIR, as user $APP_USER, starts at boot"
    say "Jira            $([ -n "$JIRA_BASE_URL" ] && echo "$JIRA_BASE_URL (releases from $RELEASES_JIRA_PROJECT)" || echo "not connected yet (connect it later in .secrets.env)")"
    say "Claude reading  $([ -n "$ANTHROPIC_API_KEY" ] && echo on || echo "off (keyword rules)")"
    say "MCP             Lens tools $FEATURE_LENS_MCP, PostHog's MCP $FEATURE_POSTHOG_MCP$([ "$LOCAL_MCP" = 1 ] && echo " (on this machine, read-only key without replay access)")"
    say "Status page     $([ "$STATUS_PUBLIC" = yes ] && echo "http://$host:8090 with a password" || echo "http://127.0.0.1:8090 on this machine only")"
    say "${D}Other settings (event names, Jira, Claude, MCP, status page): defaults above. Change them with${N}"
    say "${D}--config FILE (deploy/install.env.example), or later in $SECRETS.${N}"
    if [ $INTERACTIVE = 1 ]; then
        local a; echo; read -r -p "  Install now? [y/N] " a </dev/tty
        [[ "$a" =~ ^[Yy] ]] || { CURRENT=""; echo "Nothing was installed. Your answers are kept for next time."; exit 0; }
    fi
}

run_as_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" PUPPETEER_CACHE_DIR="$APP_DIR/.cache/puppeteer" PATH="/usr/local/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"; }
# This installer began the posthog step before (and it did not finish): the PostHog in POSTHOG_DIR is
# ours, and running the step again continues it. The log covers runs from before the marker existed.
posthog_started_here() { [ -f "$STATE_DIR/posthog-started" ] || grep -q '==> Installing PostHog (30-60 minutes' "$STATE_DIR/install.log" 2>/dev/null; }
# The PostHog this run works with, in MODE: fresh (install one), upgrade (one that is already here, on an
# older version), existing (one that is already on the tested version). Sets POSTHOG_DIR when it finds one.
find_posthog() {
    . "$HERE/migrate/versions/versions.env"
    local d="$POSTHOG_DIR" found
    if [ $USE_EXISTING = 1 ]; then MODE=existing; return; fi
    if [ ! -f "$d/.env" ] && [ -z "$POSTHOG_DIR_GIVEN" ] && command -v docker >/dev/null 2>&1; then
        # Not in /opt/posthog, and no folder given: a running PostHog (compose services web and db) somewhere else.
        found="$(docker ps --filter label=com.docker.compose.service=db --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null \
            | sort -u | while read -r w; do [ -f "$w/.env" ] && [ -f "$w/docker-compose.yml" ] && grep -q 'posthog' "$w/docker-compose.yml" && echo "$w"; done)"
        if [ "$(echo "$found" | grep -c .)" -gt 1 ]; then
            die "Several PostHogs run on this machine: $(echo "$found" | paste -sd' '). Say which one: sudo POSTHOG_DIR=<folder> $0"
        fi
        [ -n "$found" ] && d="$found"
    fi
    if [ ! -f "$d/.env" ] || done_step posthog || posthog_started_here; then MODE=fresh; return; fi
    POSTHOG_DIR="$d"
    if [ "$(git -C "$d/posthog" rev-parse HEAD 2>/dev/null)" = "$TARGET_COMMIT" ] && { [ ! -d "$d/upgrade-state" ] || [ -f "$d/upgrade-state/done/verify" ]; }; then
        MODE=existing
    else
        MODE=upgrade
    fi
}
# What the PostHog found by find_posthog already knows: its address(es) and its first admin.
existing_address() {
    local a; a="$(read_env_file "$POSTHOG_DIR/.env" ADDRESSES)"
    [ -n "$a" ] && { echo "$a"; return; }
    a="$(read_env_file "$POSTHOG_DIR/.env" DOMAIN)"; a="${a%%:*}"
    [ -n "$a" ] || return 0
    if [ "$(read_env_file "$POSTHOG_DIR/.env" HTTP_ONLY)" = 1 ] || [[ ! "$a" =~ ^[0-9.]+$ && "$(cd "$POSTHOG_DIR" && docker compose config 2>/dev/null | grep -m1 -E '^ +SITE_URL:' | awk '{print $2}')" == http://* ]]; then
        [[ "$a" =~ ^[0-9.]+$ ]] || a="http://$a"
    fi
    echo "$a"
}
existing_admin() {
    (cd "$POSTHOG_DIR" && timeout 120 docker compose exec -T web python manage.py shell -c \
        "from posthog.models import User; u = User.objects.filter(is_active=True).order_by('-is_staff', 'id').first(); print('ADMIN=' + (u.email if u else ''))" 2>/dev/null \
        </dev/null | grep '^ADMIN=' | cut -d= -f2- | tail -1) || true
}
existing_recordings() {
    (cd "$POSTHOG_DIR" && docker compose exec -T clickhouse clickhouse-client -q "SELECT uniqExact(session_id) FROM posthog.session_replay_events" 2>/dev/null </dev/null) || true
}
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
    [ "$ID" = amzn ] && [[ "$VERSION_ID" == 2023* ]] || die "Amazon Linux 2023 only (this is $PRETTY_NAME). For Ubuntu or Debian use the ticket-triage branch."
    ok "OS: $PRETTY_NAME"
    [ "$(uname -m)" = x86_64 ] || die "x86_64 only: Chrome for rendering clips has no Linux arm64 build (this is $(uname -m)). Pick an Intel or AMD instance type (m7i, m6i, m6a, t3...), not Graviton."
    local ram disk; ram=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
    [ "$ram" -ge "$MIN_RAM_GB" ] || die "Needs 16 GB of memory or more (this machine has ${ram} GB). On EC2: m7i.xlarge or larger."
    mkdir -p "$POSTHOG_DIR"
    disk=$(( $(df -Pk "$POSTHOG_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
    # The 60 GB are for installing PostHog: once it is installed it uses them, so later runs only warn when
    # the disk is nearly full. An upgrade checks its own disk needs (twice the data plus 30 GB), in its first phase.
    [ "$MODE" != fresh ] || done_step posthog || [ "$disk" -ge "$MIN_DISK_GB" ] || die "Needs ${MIN_DISK_GB} GB free at $POSTHOG_DIR (has ${disk} GB). On EC2: grow the instance's EBS volume (EC2 > Volumes > Modify volume) and reboot; Amazon Linux grows the disk at boot."
    ok "memory ${ram} GB, free disk ${disk} GB, $(nproc) CPUs"
    [ "$disk" -ge 10 ] || warn "Only ${disk} GB free at $POSTHOG_DIR. PostHog stops taking events when the disk is full."
    [ "$(getenforce 2>/dev/null || echo Permissive)" != Enforcing ] || warn "SELinux is enforcing. Amazon Linux 2023 ships it permissive, and this setup is tested that way: sudo setenforce 0, and SELINUX=permissive in /etc/selinux/config"
    # The service user must reach the project folder: no folder on the way may be private (like /root).
    local d="$APP_DIR"
    while [ "$d" != / ]; do
        d="$(dirname "$d")"
        [ "$(( 0$(stat -c %a "$d") & 1 ))" = 1 ] || die "$APP_DIR is inside $d, which other users cannot enter. Clone the project to /srv/ticket-triage and run it from there."
    done
    ok "project folder $APP_DIR"
    case "$MODE" in
        existing)
            posthog_healthy || die "PostHog in $POSTHOG_DIR is not answering on $POSTHOG_URL/_health. Start it: cd $POSTHOG_DIR && sudo docker compose up -d"
            ok "using the PostHog already running in $POSTHOG_DIR" ;;
        upgrade) ok "the PostHog in $POSTHOG_DIR is upgraded in step posthog" ;;
    esac
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
    # curl comes as curl-minimal on Amazon Linux: installing "curl" would conflict with it, and it is enough.
    dnf install -y -q ca-certificates git openssl python3 tar xz iproute util-linux shadow-utils procps-ng >/dev/null
    # Chrome's libraries and fonts.
    local pkgs=(nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm mesa-libgbm alsa-lib libxkbcommon
        libXcomposite libXdamage libXrandr libXfixes libXext libXi libXrender libX11 libxcb dbus-libs expat glib2
        pango cairo liberation-fonts google-noto-sans-fonts google-noto-serif-fonts google-noto-sans-mono-fonts
        google-noto-sans-symbols-fonts google-noto-sans-symbols2-fonts dejavu-sans-fonts google-noto-emoji-color-fonts)
    dnf install -y -q "${pkgs[@]}" >/dev/null
    ok "installed ${#pkgs[@]} packages for Chrome and fonts"
    finish packages
}

step_posthog() {
    . "$HERE/migrate/versions/versions.env"
    if [ "$MODE" = upgrade ]; then
        CURRENT=posthog; step "Upgrading the PostHog in $POSTHOG_DIR (about 2 hours; it continues where it stopped)"
        REPLAYS="$([ "$MIGRATE_REPLAYS" = yes ] && echo copy || echo skip)" POSTHOG_DIR="$POSTHOG_DIR" \
            bash "$HERE/migrate/posthog-upgrade.sh" --yes </dev/null
        posthog_healthy || die "PostHog is not healthy after the upgrade (curl $POSTHOG_URL/_health)."
        [ "$(git -C "$POSTHOG_DIR/posthog" rev-parse HEAD)" = "$TARGET_COMMIT" ] || die "PostHog's source is not at $TARGET_COMMIT."
        ok "PostHog upgraded to ${TARGET_COMMIT:0:12}, its data checked (RESULT: PASS)"
        finish posthog
        return
    fi
    CURRENT=posthog; step "Installing PostHog (30-60 minutes the first time)"
    touch "$STATE_DIR/posthog-started"
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

step_addresses() {
    CURRENT=addresses; step "PostHog addresses"
    if [ "$(read_env_file "$POSTHOG_DIR/.env" ADDRESSES)" = "$POSTHOG_ADDRESS" ]; then
        ok "PostHog answers on $POSTHOG_ADDRESS"
    else
        POSTHOG_INSTALL_DIR="$POSTHOG_DIR" bash "$HERE/posthog/install-posthog-hobby.sh" --addresses-only "$POSTHOG_ADDRESS" </dev/null
        local i; for i in $(seq 1 40); do posthog_healthy && break; sleep 15; done
        posthog_healthy || die "PostHog is not healthy after the address change. See: cd $POSTHOG_DIR && docker compose logs --tail 50 web"
    fi
    finish addresses
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
    # Chrome's sandbox needs unprivileged user namespaces. Amazon Linux 2023 allows them; a hardened
    # image may have turned them off with user.max_user_namespaces=0.
    if [ "$(sysctl -n user.max_user_namespaces 2>/dev/null || echo 1)" = 0 ]; then
        echo 'user.max_user_namespaces = 15000' >/etc/sysctl.d/90-ticket-triage-chrome.conf
        sysctl -q -p /etc/sysctl.d/90-ticket-triage-chrome.conf
        ok "user namespaces turned on for Chrome's sandbox (/etc/sysctl.d/90-ticket-triage-chrome.conf)"
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

step_posthog_mcp() {
    CURRENT=posthog_mcp; step "PostHog's MCP server"
    if [ "$LOCAL_MCP" = 1 ]; then
        SECRETS="$SECRETS" POSTHOG_DIR="$POSTHOG_DIR" bash "$HERE/posthog-mcp/up.sh"
        POSTHOG_MCP_URL="$(read_env_file "$SECRETS" POSTHOG_MCP_URL)"
        POSTHOG_MCP_API_KEY="$(read_env_file "$SECRETS" POSTHOG_MCP_API_KEY)"
        [ -n "$POSTHOG_MCP_API_KEY" ] || die "No key for PostHog's MCP server was written to .secrets.env."
        save_answer POSTHOG_MCP_URL "$POSTHOG_MCP_URL"
        ok "on $POSTHOG_MCP_URL, for this machine only"
    else
        # A server this installer started earlier is not needed any more.
        bash "$HERE/posthog-mcp/up.sh" down >/dev/null 2>&1 || true
        say "$([ "$FEATURE_POSTHOG_MCP" = on ] && echo "using $POSTHOG_MCP_URL" || echo "off (FEATURE_POSTHOG_MCP=off)")"
    fi
    finish posthog_mcp
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

ensure_buildx() {
    local v; v="$(docker buildx version 2>/dev/null | awk '{print $2; exit}' | sed 's/^v//' || true)"
    if [ -n "$v" ] && [ "$(printf '%s\n' 0.17 "$v" | sort -V | head -1)" = 0.17 ]; then return 0; fi
    local dir=/usr/local/lib/docker/cli-plugins tmp; tmp="$(mktemp)"
    mkdir -p "$dir"
    curl -fsSL -o "$tmp" "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-amd64"
    echo "$BUILDX_SHA256  $tmp" | sha256sum -c --quiet - || { rm -f "$tmp"; die "The buildx download does not match its checksum."; }
    install -m 755 "$tmp" "$dir/docker-buildx"; rm -f "$tmp"
    ok "docker buildx $BUILDX_VERSION installed (the status page is built with it; it had ${v:-none})"
}

step_status() {
    CURRENT=status; step "Status page"
    ensure_buildx
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
    local sport; sport="$(read_env_file "$SECRETS" SERVICE_PORT)"; sport="${sport:-8080}"
    host="$(hosts_of "${POSTHOG_ADDRESS%%,*}")"
    token="$(read_env_file "$SECRETS" POSTHOG_PROJECT_TOKEN)"
    mcp_on="$(read_env_file "$SECRETS" FEATURE_LENS_MCP)"
    umask 077
    cat >"$f" <<EOF
PostHog Lens is installed ($(date -u '+%Y-%m-%d %H:%M UTC')).

EC2 security group (inbound): 22 from your address; 80$([ "$(addr_kind "${POSTHOG_ADDRESS%%,*}")" = http ] || echo " and 443") from where
your users and app reach PostHog; $sport (this service) from where people open clip links$([ "$STATUS_PUBLIC" = yes ] && echo "; 8090 for the status page").

PostHog
  Open            $POSTHOG_PUBLIC_URL$([ "$POSTHOG_ADDRESS" = "${POSTHOG_ADDRESS%%,*}" ] || echo " (also: ${POSTHOG_ADDRESS#*,})")
  Login           $ADMIN_EMAIL, password: $([ "$MODE" = fresh ] && echo "sudo grep POSTHOG_ADMIN_PASSWORD $SECRETS" || echo "the one it already had")
  Files           $POSTHOG_DIR (back up $POSTHOG_DIR/.env: its secrets encrypt data)
  Start / stop    sudo systemctl start posthog / sudo systemctl stop posthog
  Upgrade         sudo $HERE/migrate/posthog-upgrade.sh (backs up first, asks before deleting)
$([ "$MODE" = upgrade ] && cat <<EOT
  Upgrade backup  $POSTHOG_DIR/upgrade-backup (rollback: sudo POSTHOG_DIR=$POSTHOG_DIR $HERE/migrate/posthog-upgrade.sh rollback)
                  Once you have checked PostHog, delete it, asking about each item:
                  sudo POSTHOG_DIR=$POSTHOG_DIR $HERE/migrate/posthog-upgrade.sh cleanup
$([ "$MIGRATE_REPLAYS" = yes ] || echo "  Old replays     not copied yet. Copy them: sudo POSTHOG_DIR=$POSTHOG_DIR $HERE/migrate/posthog-upgrade.sh replays, then ... verify")
EOT
)

Your app: add PostHog to it ($([ -n "$APP_URLS" ] && echo "it records only on $APP_URLS" || echo "any site with this snippet records"))
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
    if [ "$LOCAL_MCP" = 1 ]; then cat >>"$f" <<EOF

PostHog's MCP server (SQL, insights, flags, dashboards...)
  Address         $POSTHOG_MCP_URL, this machine only (Claude Code here gets it through .mcp.json)
  Key             read-only, project $(read_env_file "$SECRETS" POSTHOG_PROJECT_ID) only, no session replay scopes
                  (label posthog-mcp in PostHog). New key: sudo $HERE/posthog-mcp/up.sh --new-key
  Logs            cd $HERE/posthog-mcp && sudo docker compose logs -f
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
MODE=fresh; MIGRATE_REPLAYS=""
find_posthog
save_answer POSTHOG_DIR "$POSTHOG_DIR"
collect_answers
show_plan
for s in "${STEPS[@]}"; do
    if done_step "$s" && [[ "$ALWAYS" != *" $s "* ]]; then echo; say "${D}step $s: already done ($(cat "$STATE_DIR/done/$s"))${N}"; continue; fi
    case "$MODE:$s" in
        existing:posthog|existing:scale) say "${D}step $s: skipped (PostHog is already on the tested version)${N}"; continue ;;
        upgrade:scale) say "${D}step scale: skipped (the upgrade starts PostHog through scale.sh)${N}"; continue ;;
    esac
    [ "$s" = scale ] && [ "$SCALE" != yes ] && { say "${D}step scale: skipped (SCALE=$SCALE)${N}"; continue; }
    "step_$s"
done
write_summary
