#!/usr/bin/env bash
# Script 2 of 3: a FRESH install of PostHog and PostHog Lens, from the images build-images.sh (script 1)
# put in your registry. For a machine with no PostHog yet; a machine that runs PostHog takes upgrade.sh
# (script 3). This file is all the machine needs: everything else comes from the registry. README.md has more.
#
#   sudo bash fresh-install.sh                  # the kit build-images.sh made it for (or the newest in ECR)
#   sudo bash fresh-install.sh <kit tag>        # another kit, e.g. 685049943753-92fb46e1
#
# It asks two things (or takes them from the environment):
#   POSTHOG_ADDRESS   the address(es) people open PostHog at: an IP, or a domain (HTTPS), comma-separated
#   ADMIN_EMAIL       the email of the first PostHog login (its password is made up and shown at the end)
# Optional (environment): LENS_DIR [/opt/posthog-lens], POSTHOG_DIR [/opt/posthog], SETTINGS (a file of more
# answers, see deploy/install.env.example in the kit), YES=1 (no questions: everything from the environment).
#
# Once the answers are in, it runs in the background (a dropped SSH session does not stop it) and this
# terminal follows it; Ctrl-C stops only the following. From any session: sudo posthog-lens progress -f.
# It takes 30-60 minutes. If it stops, fix what it says and run the same command again: it continues where
# it stopped. Everything it prints also goes to /var/log/posthog-lens/. Needs: root, Docker, and (for ECR)
# the AWS CLI with an instance role that can read the registry (AmazonEC2ContainerRegistryReadOnly).
set -euo pipefail

REGISTRY="${REGISTRY:-555011114032.dkr.ecr.ca-central-1.amazonaws.com}"   # filled in by build-images.sh
REGION="${REGION:-ca-central-1}"   # filled in by build-images.sh
KIT_TAG="${KIT_TAG:-}"   # filled in by build-images.sh
LENS_DIR="${LENS_DIR:-/opt/posthog-lens}"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
CONF=/etc/posthog-lens/posthog-lens.env
STATE_DIR=/var/lib/posthog-lens-install
SBIN=/usr/local/sbin/posthog-lens

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; R=; N=; fi
say() { echo "==> $*"; }
ok() { echo "    ${G}✔${N} $*"; }
die() { echo "${R}✘ $*${N}" >&2; exit 1; }
case "${1:-}" in -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;; esac
[ "$(id -u)" = 0 ] || die "Run it as root: sudo bash $0 $*"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[ -z "${1:-}" ] || KIT_TAG="$1"
local_registry() { case "$REGISTRY" in localhost:* | 127.0.0.1:*) return 0 ;; *) return 1 ;; esac; }
conf() { grep -E "^$1=" "$CONF" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# ------------------------------------------------------------------ is this a fresh install?
say "Checking this machine"
command -v docker >/dev/null || die "Docker is missing. Amazon Linux: sudo dnf install -y docker && sudo systemctl enable --now docker. Ubuntu: https://docs.docker.com/engine/install/ubuntu/"
docker info >/dev/null 2>&1 || die "Docker is not running: sudo systemctl enable --now docker"
local_registry || command -v aws >/dev/null || die "The AWS CLI is missing (Amazon Linux: sudo dnf install -y awscli)."
RESUME=0
if [ -f "$CONF" ]; then
    # This script, or posthog-lens setup, ran here before.
    [ -f "$STATE_DIR/done/doctor" ] && die "PostHog Lens is already installed here ($CONF). To move to new images: sudo bash upgrade.sh"
    RESUME=1
    LENS_DIR="$(conf LENS_DIR)"; POSTHOG_DIR="$(conf POSTHOG_DIR)"
    # Settings from an upgrade of a PostHog that was here before (upgrade.sh, posthog-lens setup): not ours.
    [ ! -d "$POSTHOG_DIR/upgrade-state" ] || die "This machine's PostHog was upgraded, not installed by this script: use upgrade.sh."
    [ ! -f "$POSTHOG_DIR/.env" ] || [ -f "$STATE_DIR/posthog-started" ] || [ -f "$STATE_DIR/done/posthog" ] \
        || die "$POSTHOG_DIR has a PostHog this script did not install: use upgrade.sh."
    ok "continuing the install that stopped (settings in $CONF)"
else
    # A PostHog this script did not start: never install over it. Any container on a PostHog image (running
    # or stopped, whatever its compose files are called) counts, and so does a PostHog folder that is not empty.
    found="$(docker ps -a --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -E 'posthog/posthog|clickhouse-posthog|posthog-node' | head -3 || true)"
    [ -z "$found" ] || die "A PostHog is already on this machine (containers: $(echo "$found" | awk '{print $2}' | paste -sd' ')). Use upgrade.sh, which keeps its data."
    [ -z "$(ls -A "$POSTHOG_DIR" 2>/dev/null)" ] || [ -f "$STATE_DIR/posthog-started" ] || die "$POSTHOG_DIR is not empty. Use upgrade.sh for the PostHog in it, or POSTHOG_DIR=<an empty folder>."
    ok "no PostHog here yet: a fresh install into $POSTHOG_DIR, PostHog Lens into $LENS_DIR"
fi

# ------------------------------------------------------------------ the two answers
ask() { # name question default check
    local v="${!1:-}"
    [ $RESUME = 1 ] && [ -z "$v" ] && v="$(conf "$1")"
    while [ -z "$v" ] || ! $4 "$v"; do
        [ -n "$v" ] && echo "    \"$v\" does not look right." >&2
        [ -t 0 ] && [ "${YES:-}" != 1 ] || die "$1 is needed: run it again with $1=... in front (sudo $1=... bash $0)."
        read -r -p "    $2${3:+ [$3]}: " v
        v="${v:-$3}"; v="${v// /}"
    done
    printf -v "$1" '%s' "$v"
}
is_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }
is_addresses() { [[ "$1" =~ ^[A-Za-z0-9.:/,_-]+$ ]]; }
ask POSTHOG_ADDRESS "Address(es) people use to open PostHog (IP, or a domain for HTTPS; comma-separated)" "$(hostname -I 2>/dev/null | awk '{print $1}')" is_addresses
ask ADMIN_EMAIL "Email for the first PostHog login" "" is_email

# ------------------------------------------------------------------ a run anyone can follow
# The run itself goes on in the background (setsid), so a dropped SSH session does not stop it; this
# terminal only follows it (Ctrl-C stops the following, not the run). FOREGROUND=1: no background run.
# What it is doing is in $RUNS (current.json while it runs, history.jsonl after), which
# "sudo posthog-lens progress [-f]", "sudo posthog-lens history", the status page and Lens's System page read.
RUNS=/var/lib/posthog-lens/runs
run_write() { # file key value ...: current.json is replaced, history.jsonl gets a line
    python3 - "$@" <<'PY'
import json, os, sys
path, *kv = sys.argv[1:]
d = dict(zip(kv[::2], kv[1::2]))
for k in ("seconds", "code"):
    if k in d: d[k] = int(d[k])
line = json.dumps(d) + "\n"
if path.endswith(".jsonl"):
    with open(path, "a") as f: f.write(line)
    os.chmod(path, 0o644)
else:
    with open(path + ".tmp", "w") as f: f.write(line)
    os.chmod(path + ".tmp", 0o644); os.replace(path + ".tmp", path)
PY
}
# The step or phase it is in, and the latest "... 12 min: 340 of 1020 migrations" line (never other output).
run_step() { sed 's/\x1b\[[0-9;]*m//g' "$LOG" 2>/dev/null | grep -aE '==> |== phase [0-9]+ of' | tail -1 | sed -E 's/^.*(==> |== )//' | cut -c1-160 || true; }
run_detail() { sed 's/\x1b\[[0-9;]*m//g' "$LOG" 2>/dev/null | tail -3 | grep -aE '^[0-9: ]*\.\.\. ' | tail -1 | sed -E 's/^[0-9: ]*\.\.\. //' | cut -c1-160 || true; }
run_follow() { # log id pid: shows the log until the run ends, then exits with the run's code
    local log="$1" id="$2" pid="$3" tp code
    trap 'echo; echo "Stopped following; it carries on in the background. Follow again: sudo posthog-lens progress -f"; exit 0' INT
    for _ in $(seq 60); do [ -f "$log" ] && break; kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    tail -n +1 -F "$log" 2>/dev/null & tp=$!
    while kill -0 "$pid" 2>/dev/null; do sleep 2; done
    sleep 2; kill "$tp" 2>/dev/null || true; wait "$tp" 2>/dev/null || true
    code="$(grep -F "\"id\": \"$id\"" "$RUNS/history.jsonl" 2>/dev/null | tail -1 | python3 -c 'import json,sys; print(json.loads(sys.stdin.read() or "{}").get("code", 1))' 2>/dev/null || echo 1)"
    exit "$code"
}
run_detach() { # kind: start this script again in the background and follow it here
    [ "${LENS_DETACHED:-}" != 1 ] && [ "${FOREGROUND:-}" != 1 ] && command -v setsid >/dev/null || return 0
    local stamp; stamp="$(date -u +%Y%m%d-%H%M%S)"
    export LENS_DETACHED=1 YES=1 LENS_RUN_ID="$1-$stamp-$$" LENS_RUN_LOG="/var/log/posthog-lens/$1-$stamp.log"
    mkdir -p /var/log/posthog-lens
    setsid bash "$0" </dev/null >/dev/null 2>&1 &
    say "Running in the background, so a dropped connection does not stop it. Following it here (Ctrl-C stops"
    echo "    only the following). From any session: sudo posthog-lens progress -f"
    run_follow "$LENS_RUN_LOG" "$LENS_RUN_ID" $!
}
run_start() { # kind
    RUN_KIND="$1"; RUN_ID="${LENS_RUN_ID:-$1-$(date -u +%Y%m%d-%H%M%S)-$$}"; RUN_T0=$(date +%s); RUN_STARTED="$(date -u +%FT%TZ)"; RUN_RESULT=failed
    mkdir -p "$RUNS"; chmod 755 "$(dirname "$RUNS")" "$RUNS"
    ( trap - EXIT; while kill -0 $$ 2>/dev/null; do
        run_write "$RUNS/current.json" id "$RUN_ID" kind "$RUN_KIND" kit "${KIT_TAG:-}" started "$RUN_STARTED" updated "$(date -u +%FT%TZ)" log "$LOG" step "$(run_step)" detail "$(run_detail)" >/dev/null 2>&1 || true
        sleep 10
    done ) &
    RUN_BEAT=$!
}
run_end() { # exit code
    kill "$RUN_BEAT" 2>/dev/null || true
    [ "$1" = 0 ] || [ "$RUN_RESULT" != ready ] || RUN_RESULT=failed
    run_write "$RUNS/history.jsonl" id "$RUN_ID" kind "$RUN_KIND" kit "${KIT_TAG:-}" started "$RUN_STARTED" ended "$(date -u +%FT%TZ)" seconds "$(( $(date +%s) - RUN_T0 ))" result "$RUN_RESULT" code "$1" log "$LOG" step "$(run_step)" || true
    rm -f "$RUNS/current.json"
}

# ------------------------------------------------------------------ settings, then the kit
export KIT_TAG POSTHOG_DIR LENS_DIR REGISTRY REGION POSTHOG_ADDRESS ADMIN_EMAIL
run_detach fresh-install
mkdir -p /var/log/posthog-lens "$(dirname "$CONF")"
LOG="${LENS_RUN_LOG:-/var/log/posthog-lens/fresh-install-$(date -u +%Y%m%d-%H%M%S).log}"
exec > >(tee -a "$LOG") 2>&1
say "Log: $LOG"
run_start fresh-install
trap 'run_end $?' EXIT
if [ $RESUME = 0 ]; then
    umask 022
    {
        echo "# PostHog Lens settings, written by fresh-install.sh. Also the installer's answers (deploy/install.env.example)."
        echo "LENS_DIR=$LENS_DIR"
        echo "POSTHOG_DIR=$POSTHOG_DIR"
        echo "REGISTRY=$REGISTRY"
        echo "REGION=$REGION"
        echo "POSTHOG_ADDRESS=$POSTHOG_ADDRESS"
        echo "ADMIN_EMAIL=$ADMIN_EMAIL"
        echo "MIGRATE_REPLAYS=no"
        if [ -n "${SETTINGS:-}" ]; then
            [ -f "$SETTINGS" ] || die "SETTINGS: $SETTINGS does not exist."
            grep -vE '^\s*(#|$)|^(LENS_DIR|POSTHOG_DIR|REGISTRY|REGION|POSTHOG_ADDRESS|ADMIN_EMAIL)=' "$SETTINGS" || true
        fi
    } >"$CONF.new"
    chown root:root "$CONF.new"; chmod 644 "$CONF.new"; mv "$CONF.new" "$CONF"
    ok "settings in $CONF"
fi

say "Logging in to $REGISTRY"
if ! local_registry; then
    pw="$(aws ecr get-login-password --region "$REGION" 2>&1)" || die "Cannot log in to $REGISTRY: $pw
    The instance's IAM role needs AmazonEC2ContainerRegistryReadOnly, and the VPC the ECR endpoints (ecr.api, ecr.dkr) and the S3 gateway endpoint."
    docker login --username AWS --password-stdin "$REGISTRY" <<<"$pw" >/dev/null 2>&1 || die "docker login to $REGISTRY failed."
    unset pw
fi
# The kit: the tag given (or filled in by build-images.sh), else the one a run that stopped used (so a
# retry never switches kits half-way), else the newest in ECR.
PIN=/var/lib/posthog-lens-install/kit-in-progress
if [ -z "$KIT_TAG" ] && [ -s "$PIN" ]; then
    KIT_TAG="$(cat "$PIN")"
    ok "the kit the run that stopped used: $KIT_TAG (give a tag to use another)"
fi
if [ -z "$KIT_TAG" ]; then
    local_registry && die "Give the kit tag: sudo bash $0 <kit tag> (build-images.sh printed it)."
    # Every tagged kit, all pages, newest last.
    KIT_TAG="$(aws ecr describe-images --region "$REGION" --registry-id "${REGISTRY%%.*}" --repository-name posthog/kit \
        --filter tagStatus=TAGGED --query 'imageDetails[].[imagePushedAt, join(`,`, imageTags)]' --output text 2>/dev/null \
        | awk '{n = split($2, t, ","); for (i = 1; i <= n; i++) print $1, t[i]}' \
        | grep -E ' [0-9a-f]{12}-[0-9a-f]{8}$' | sort | tail -1 | awk '{print $2}' || true)"
    [ -n "$KIT_TAG" ] || die "No kit found in $REGISTRY/posthog/kit (or this machine may not list it). Run build-images.sh first, or give the tag."
    ok "the newest kit: $KIT_TAG"
fi
KIT_TAG="${KIT_TAG##*:}"
[[ "$KIT_TAG" =~ ^[0-9a-f]{12}-[0-9a-f]{8}$ ]] || die "\"$KIT_TAG\" is not a kit tag. It looks like 685049943753-92fb46e1."
KIT="$REGISTRY/posthog/kit:$KIT_TAG"
docker pull -q "$KIT" >/dev/null || die "Cannot pull $KIT (is the tag right?)."
ok "kit $KIT_TAG"
mkdir -p "$(dirname "$PIN")"; echo "$KIT_TAG" >"$PIN"

# The posthog-lens command from the kit does the rest: it unpacks the kit into $LENS_DIR and runs the
# installer with the answers in $CONF. Later updates go through it (upgrade.sh), so it stays installed.
tmp="$(mktemp)"
docker run --rm --entrypoint cat "$KIT" /kit/repo/deploy/offline/posthog-lens >"$tmp" || die "This kit has no posthog-lens command (too old?)."
install -o root -g root -m 755 "$tmp" "$SBIN"; rm -f "$tmp"
ok "installed $SBIN"
say "Installing PostHog and PostHog Lens (30-60 minutes)"
POSTHOG_LENS_CONF="$CONF" "$SBIN" update "$KIT_TAG"

rm -f "$PIN"
echo
"$SBIN" status || true
echo
if "$SBIN" check "${CHECK_MINUTES:-10}"; then
    RUN_RESULT=ready
    echo "${B}${G}Done.${N} PostHog and PostHog Lens are installed and working."
else
    RUN_RESULT=not_ready
    echo "${B}${R}Installed, but not working yet${N} (see above). Look again in a few minutes: sudo posthog-lens check"
    CHECK_FAILED=1
fi
cat <<EOF

    The PostHog login, its password and the addresses: sudo cat $STATE_DIR/summary.txt
    From now on:   sudo posthog-lens status | check | doctor | restart
    Alerts:        STATUS_ALERT_WEBHOOK=<Teams or Slack webhook> in the status page's status.env, then: sudo posthog-lens alert-test
    New images:    build-images.sh on the build machine, then here: sudo bash upgrade.sh
EOF
exit "${CHECK_FAILED:-0}"
