#!/usr/bin/env bash
# Script 3 of 3: UPGRADES a machine that already runs PostHog to the images build-images.sh (script 1) put
# in your registry, keeping all its data. A machine with no PostHog yet takes fresh-install.sh (script 2).
# This file is all the machine needs: everything else comes from the registry. README.md has more.
#
#   sudo bash upgrade.sh                  # the kit build-images.sh made it for (or the newest in ECR)
#   sudo bash upgrade.sh <kit tag>        # another kit, e.g. 685049943753-92fb46e1
#
# It shows what will change and asks before it starts (YES=1: no question). What it does depends on the kit:
#   - a new PostHog version: PostHog is backed up in full, then upgraded (PostHog is down for 2-3 hours,
#     longer with many session replays); then PostHog Lens. "sudo posthog-lens rollback" goes back.
#   - the same PostHog version: only PostHog Lens and its settings are updated (minutes; PostHog keeps
#     running, apart from containers whose image or settings changed).
#
# The first time on a machine whose PostHog was set up another way (by hand, by fresh-install.sh from an
# older kit, or with an earlier PostHog Lens), it also sets up the posthog-lens command and its settings
# (/etc/posthog-lens/posthog-lens.env). It finds the running PostHog, or takes POSTHOG_DIR=<its folder>;
# PostHog Lens goes into LENS_DIR [the folder next to PostHog's: <parent>/posthog-lens], and the settings
# and data of an earlier PostHog Lens come over from OLD_DIR [/data04/ph_ops/posthog-mcp-trial].
#
# A long upgrade should survive a dropped session:
#   sudo YES=1 nohup bash upgrade.sh <kit tag> > upgrade.log 2>&1 < /dev/null &
# If it stops, fix what it says and run the same command again: it continues where it stopped. Everything
# it prints also goes to /var/log/posthog-lens/. Needs: root, Docker, and (for ECR) the AWS CLI with an
# instance role that can read the registry (AmazonEC2ContainerRegistryReadOnly).
set -euo pipefail

REGISTRY="${REGISTRY:-555011114032.dkr.ecr.ca-central-1.amazonaws.com}"   # filled in by build-images.sh
REGION="${REGION:-ca-central-1}"   # filled in by build-images.sh
KIT_TAG="${KIT_TAG:-}"   # filled in by build-images.sh
CONF=/etc/posthog-lens/posthog-lens.env
SBIN=/usr/local/sbin/posthog-lens

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
say() { echo "==> $*"; }
ok() { echo "    ${G}✔${N} $*"; }
die() { echo "${R}✘ $*${N}" >&2; exit 1; }
case "${1:-}" in -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;; esac
[ "$(id -u)" = 0 ] || die "Run it as root: sudo bash $0 $*"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[ -z "${1:-}" ] || KIT_TAG="$1"
local_registry() { case "$REGISTRY" in localhost:* | 127.0.0.1:*) return 0 ;; *) return 1 ;; esac; }
conf() { grep -E "^$1=" "$CONF" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' || true; }
env_of() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }

# ------------------------------------------------------------------ which PostHog
say "Checking this machine"
command -v docker >/dev/null || die "Docker is missing."
docker info >/dev/null 2>&1 || die "Docker is not running: sudo systemctl enable --now docker"
local_registry || command -v aws >/dev/null || die "The AWS CLI is missing (Amazon Linux: sudo dnf install -y awscli)."
if [ -f "$CONF" ]; then
    FIRST=0
    POSTHOG_DIR="$(conf POSTHOG_DIR)"; LENS_DIR="$(conf LENS_DIR)"
    [ -f "$POSTHOG_DIR/.env" ] || die "$CONF is here, but there is no PostHog in $POSTHOG_DIR yet: a fresh install did not finish. Run fresh-install.sh again; it continues."
    [ "$(conf REGISTRY)" = "$REGISTRY" ] || die "$CONF uses the registry $(conf REGISTRY), this script $REGISTRY. Run it with REGISTRY=$(conf REGISTRY) in front, or change $CONF."
    ok "set up before: PostHog in $POSTHOG_DIR, PostHog Lens in $LENS_DIR ($CONF)"
else
    FIRST=1
    if [ -z "${POSTHOG_DIR:-}" ]; then
        POSTHOG_DIR="$(docker ps --filter label=com.docker.compose.service=db --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null \
            | while read -r w; do if [ -f "$w/.env" ] && grep -qs posthog "$w/docker-compose.yml"; then echo "$w"; fi; done | sort -u || true)"
        [ "$(echo "$POSTHOG_DIR" | grep -c .)" -le 1 ] || die "Several PostHogs run here: $(echo "$POSTHOG_DIR" | paste -sd' '). Say which: sudo POSTHOG_DIR=<folder> bash $0"
        [ -n "$POSTHOG_DIR" ] || { [ -f /opt/posthog/.env ] && POSTHOG_DIR=/opt/posthog; } || true
    fi
    [ -n "$POSTHOG_DIR" ] && [ -f "$POSTHOG_DIR/.env" ] \
        || die "No PostHog found here${POSTHOG_DIR:+ (nothing in $POSTHOG_DIR)}. A machine without PostHog takes fresh-install.sh; or say where it is: sudo POSTHOG_DIR=<folder> bash $0"
    LENS_DIR="${LENS_DIR:-$(dirname "$POSTHOG_DIR")/posthog-lens}"
    ok "PostHog in $POSTHOG_DIR; PostHog Lens goes into $LENS_DIR (first time: the posthog-lens command and $CONF are set up)"
fi

# ------------------------------------------------------------------ the kit
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
# The kit's deploy/offline folder: its posthog-lens command, and the per-machine settings (sites/).
KITDIR="$(mktemp -d)"; trap 'rm -rf "$KITDIR"' EXIT
docker run --rm --entrypoint tar "$KIT" -C /kit/repo -cf - deploy/offline deploy/migrate/versions/versions.env | tar -xf - -C "$KITDIR" \
    || die "Cannot read $KIT."
[ -f "$KITDIR/deploy/offline/posthog-lens" ] || die "This kit has no posthog-lens command (too old?)."
ok "kit $KIT_TAG"

# ------------------------------------------------------------------ the plan
want="$(bash -c 'IMAGES_FROM=upstream; . "$1" >/dev/null 2>&1; echo "$TARGET_COMMIT"' _ "$KITDIR/deploy/migrate/versions/versions.env")"
# As the installer decides: PostHog's source checkout (an unknown version counts as older).
have="$(git -C "$POSTHOG_DIR/posthog" rev-parse HEAD 2>/dev/null || true)"
shown="${have:-$(env_of "$POSTHOG_DIR/.env" POSTHOG_APP_TAG)}"; shown="${shown:-unknown version}"
lens_now="$(env_of "$LENS_DIR/deploy/offline/ecr.env" IMAGES_COMMIT)"
lens_new="${KIT_TAG%%-*}"
echo
echo "${B}What happens${N}"
if [ -d "$POSTHOG_DIR/upgrade-state" ] && [ ! -f "$POSTHOG_DIR/upgrade-state/done/verify" ]; then
    UPGRADE=1
    echo "    PostHog       ${Y}the upgrade that stopped continues${N} (to ${want:0:12}); PostHog stays down until it finishes."
elif [ -n "$want" ] && [ "$have" != "$want" ]; then
    UPGRADE=1
    echo "    PostHog       ${Y}upgraded${N} ${shown:0:12} -> ${want:0:12}: a full backup first, then the migrations."
    echo "                  ${Y}PostHog is down for about 2-3 hours${N} (longer with many session replays)."
    if [ -f "$POSTHOG_DIR/upgrade-state/done/verify" ] && [ -n "$(ls -A "$POSTHOG_DIR/upgrade-backup" 2>/dev/null)" ]; then
        die "The last upgrade's backup is still in $POSTHOG_DIR/upgrade-backup. Once you no longer need it: sudo posthog-lens cleanup, then run this again."
    fi
    df_gb="$(df -BG --output=avail "$POSTHOG_DIR" | tail -1 | tr -dc 0-9)"
    echo "                  Free disk at $POSTHOG_DIR: ${df_gb} GB (the backup needs about as much as PostHog's data)."
else
    UPGRADE=0
    echo "    PostHog       stays on ${want:0:12} (no upgrade, no backup)."
fi
echo "    PostHog Lens  ${lens_now:+${lens_now:0:12} -> }${lens_new} (its settings and data in $LENS_DIR are kept)"
[ $FIRST = 1 ] && echo "    Set up once   the posthog-lens command ($SBIN) and $CONF"
echo
if [ "${YES:-}" != 1 ]; then
    [ -t 0 ] || die "Not asking without a terminal: run it with YES=1 in front."
    read -r -p "Go ahead? [y/N] " a
    [[ "$a" =~ ^[Yy] ]] || die "Stopped; nothing was changed."
fi

# ------------------------------------------------------------------ go
mkdir -p /var/log/posthog-lens "$(dirname "$PIN")"
echo "$KIT_TAG" >"$PIN"
LOG="/var/log/posthog-lens/upgrade-$(date -u +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
say "Log: $LOG"
if [ $FIRST = 1 ]; then
    # setup writes the settings, installs the command, brings an earlier PostHog Lens's data over, then updates.
    say "Setting up posthog-lens and $([ $UPGRADE = 1 ] && echo "upgrading PostHog" || echo "updating PostHog Lens")"
    POSTHOG_DIR="$POSTHOG_DIR" LENS_DIR="$LENS_DIR" REGISTRY="$REGISTRY" REGION="$REGION" \
        bash "$KITDIR/deploy/offline/posthog-lens" setup "$KIT_TAG"
else
    # The kit's own command, so fixes in it apply to this run.
    install -o root -g root -m 755 "$KITDIR/deploy/offline/posthog-lens" "$SBIN"
    say "$([ $UPGRADE = 1 ] && echo "Upgrading PostHog, then PostHog Lens" || echo "Updating PostHog Lens")"
    "$SBIN" update "$KIT_TAG"
fi

rm -f "$PIN"
echo
"$SBIN" status || true
echo
# Not done until it works: wait for everything to be up, then one verdict.
if "$SBIN" check "${CHECK_MINUTES:-10}"; then
    echo "${B}${G}Done.${N}"
else
    echo "${B}${R}Installed, but not working yet${N} (see above). Look again in a few minutes: sudo posthog-lens check"
    if [ $UPGRADE = 1 ]; then echo "    If it stays broken: sudo posthog-lens rollback   (PostHog from before the upgrade)"; fi
    CHECK_FAILED=1
fi
cat <<EOF

    Full check:    sudo posthog-lens doctor
$([ $UPGRADE = 1 ] && echo "    Go back:       sudo posthog-lens rollback   (PostHog from before the upgrade)
    Once happy:    sudo posthog-lens cleanup    (deletes the upgrade's backup)")
EOF
exit "${CHECK_FAILED:-0}"
