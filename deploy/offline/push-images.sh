#!/usr/bin/env bash
# Puts everything PostHog Lens needs into your ECR, for a machine without internet. Run it on a machine
# WITH internet (Ubuntu, x86_64, Docker and the AWS CLI), from a clone of the ticket-triage-amazon-linux
# branch. The machine without internet then takes every image from ECR and every other file from the kit.
#
#   deploy/offline/push-images.sh            # everything; later runs skip what ECR already has
#   deploy/offline/push-images.sh --plan     # list what goes where; nothing is pulled, built or pushed
#
# What it does:
#   1. PostHog's images (every service in deploy/migrate/versions/docker-compose.pinned.yml, the app image,
#      the stepping stone the upgrade needs, PostHog's MCP server, alpine for file copies): copied
#      registry to registry for linux/amd64, byte for byte (crane copy), and checked by digest. Nothing is
#      rebuilt. Images with an ECR repository of their own go there (posthog/capture...); the others go into
#      posthog/services, one tag each (services:cymbal-<digest>...).
#   2. Ours, built for linux/amd64 from this commit (git archive HEAD: uncommitted changes are left out):
#        posthog/node     PostHog's Node image plus PLUGINS_DISABLED_CAPABILITIES (deploy/posthog/node-image)
#        posthog/lens     PostHog Lens: the service, its MCP tools, Chrome, ffmpeg (deploy/lens/Dockerfile);
#                         its tests run in it before it is pushed
#        posthog/lens     the status page, tag status-... (deploy/status)
#        posthog/minio    MinIO for copying an old PostHog's files (deploy/migrate/minio-image)
#   3. deploy/offline/ecr.env and images.lock: which ECR image replaces which (written here too).
#   4. posthog/kit: this project (with those two files), PostHog's source at the pinned commit, the GeoIP
#      database and Docker Compose. On the machine without internet it unpacks into the project folder.
#
# Tags are made from the content (a digest or a git tree hash), so they never change meaning: your
# repositories have immutable tags, and a run that finds a tag in ECR skips it.
#
# Settings (environment):
#   REGISTRY   [555011114032.dkr.ecr.ca-central-1.amazonaws.com]
#   REGION     [ca-central-1]
#   AWS_PROFILE  as usual for the AWS CLI
#   SKIP_AWS=1   for a rehearsal against a local registry (REGISTRY=localhost:5000): no AWS calls or login
#
# Needs: docker (with buildx), aws CLI v2 signed in with push rights to the posthog/* repositories, git,
# python3, curl. About 25 GB goes up the first time; images are streamed registry to registry, so the
# local disk only holds the ones built here (about 6 GB).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REGISTRY="${REGISTRY:-555011114032.dkr.ecr.ca-central-1.amazonaws.com}"
REGION="${REGION:-ca-central-1}"
PLAN=0
case "${1:-}" in
    --plan) PLAN=1 ;;
    "") ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option $1 (see --help)"; exit 2 ;;
esac
CRANE_IMAGE=gcr.io/go-containerregistry/crane:v0.22.1@sha256:1f968817b95790bed063f71175aa6b8ff879fa17064020415f3e18bb6e6a36e1
ALPINE_IMAGE=alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
# The repositories this script pushes to. The admin creates them (immutable tags, AES-256).
REPOS="posthog/posthog posthog/node posthog/services posthog/lens posthog/kit posthog/mcp posthog/minio posthog/caddy
posthog/capture posthog/clickhouse-server posthog/elasticsearch posthog/feature-flags posthog/livestream posthog/postgres
posthog/property-defs-rs posthog/redis posthog/redpanda posthog/temporal-admin-tools posthog/temporal-auto-setup
posthog/temporal-ui posthog/zookeeper"

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B=; G=; R=; D=; N=; fi
step() { echo; echo "${B}==> $*${N}"; }
ok() { echo "    ${G}✔${N} $*"; }
say() { echo "    $*"; }
die() { echo; echo "${R}✘ $*${N}" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

# ------------------------------------------------------------------ what to push
# The pinned versions as published upstream (not the ECR copies an earlier run recorded).
IMAGES_FROM=upstream
# shellcheck disable=SC1091
. "$ROOT/deploy/migrate/versions/versions.env"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
MCP_UPSTREAM="$(grep -oE 'ghcr\.io/posthog/posthog-mcp@sha256:[0-9a-f]{64}' "$ROOT/deploy/posthog-mcp/docker-compose.yml" | head -1)"
COMPOSE_VERSION="$(grep -oE '^COMPOSE_STANDALONE_VERSION="v[0-9.]+"' "$ROOT/deploy/posthog/install-posthog-hobby.sh" | cut -d'"' -f2)"
[ -n "$MCP_UPSTREAM" ] && [ -n "$COMPOSE_VERSION" ] && [ -n "$TARGET_COMMIT" ] || die "Could not read the pinned versions."

# Upstream reference -> ECR repository:tag. One line each: "<upstream> <repo:tag>".
python3 - "$ROOT/deploy/migrate/versions/docker-compose.pinned.yml" "$TARGET_APP_IMAGE" "$TARGET_COMMIT" \
    "$STEPPING_STONE_IMAGE" "$STEPPING_STONE_COMMIT" "$MCP_UPSTREAM" "$ALPINE_IMAGE" >"$WORK/upstream.txt" <<'PY'
import re, sys
pinned, app, app_commit, stone, stone_commit, mcp, alpine = sys.argv[1:]
refs = re.findall(r"^\s+image:\s*(\S+@sha256:[0-9a-f]{64})\s*$", open(pinned).read(), re.M)
refs = list(dict.fromkeys([app, stone, mcp, alpine] + refs))
# Images with a repository of their own in ECR; everything else goes into posthog/services.
OWN = {
    "posthog/posthog": "posthog/posthog",
    "ghcr.io/posthog/posthog/capture": "posthog/capture",
    "ghcr.io/posthog/clickhouse-posthog": "posthog/clickhouse-server",
    "postgres": "posthog/postgres",
    "elasticsearch": "posthog/elasticsearch",
    "ghcr.io/posthog/posthog/feature-flags": "posthog/feature-flags",
    "redpandadata/redpanda": "posthog/redpanda",
    "ghcr.io/posthog/posthog/livestream": "posthog/livestream",
    "ghcr.io/posthog/posthog/property-defs-rs": "posthog/property-defs-rs",
    "caddy": "posthog/caddy",
    "redis": "posthog/redis",
    "temporalio/auto-setup": "posthog/temporal-auto-setup",
    "temporalio/admin-tools": "posthog/temporal-admin-tools",
    "temporalio/ui": "posthog/temporal-ui",
    "zookeeper": "posthog/zookeeper",
    "ghcr.io/posthog/posthog-mcp": "posthog/mcp",
}
for ref in refs:
    name, digest = ref.split("@sha256:")
    name = re.sub(r":[^/:]+$", "", name)                 # alpine:3.22@sha256:... -> alpine
    short = digest[:12]
    if ref == app:
        target = f"posthog/posthog:{app_commit[:12]}"
    elif ref == stone:
        target = f"posthog/posthog:stone-{stone_commit[:12]}"
    elif name in OWN:
        target = f"{OWN[name]}:{short}"
    else:
        target = f"posthog/services:{name.rsplit('/', 1)[-1]}-{short}"
    print(ref, target)
PY

# Our images: name, repository, tag (from the content), how to build.
tree() { git -C "$ROOT" ls-tree -r HEAD -- "$@" | sha256sum | cut -c1-12; }
NODE_TAG="${NODE_BASE_IMAGE##*sha256:}"; NODE_TAG="${NODE_TAG:0:12}-$(tree deploy/posthog/node-image)"
LENS_TAG="$(tree src scripts vendor test config package.json pnpm-lock.yaml tsconfig.json deploy/lens)"
STATUS_TAG="status-$(tree deploy/status)"
MINIO_TAG="$(tree deploy/migrate/minio-image)"

step "Plan: $(wc -l <"$WORK/upstream.txt") PostHog images copied, 4 built, then the kit (commit ${COMMIT:0:12})"
while read -r src dst; do say "${D}copy${N}  $src"; say "      -> $REGISTRY/$dst"; done <"$WORK/upstream.txt"
say "${D}build${N} posthog/node:$NODE_TAG  (from $NODE_BASE_IMAGE)"
say "${D}build${N} posthog/lens:$LENS_TAG"
say "${D}build${N} posthog/lens:$STATUS_TAG"
say "${D}build${N} posthog/minio:$MINIO_TAG"
say "${D}build${N} posthog/kit:${COMMIT:0:12}-<hash of the image list>"
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || say "${R}Uncommitted changes: they are NOT in the images (built from commit ${COMMIT:0:12}).${N}"
[ $PLAN = 1 ] && exit 0

# ------------------------------------------------------------------ checks and login
step "Checking this machine and AWS"
for c in docker git python3 curl; do command -v "$c" >/dev/null || die "$c is missing."; done
docker buildx version >/dev/null 2>&1 || die "docker buildx is missing (Ubuntu: sudo apt install docker-buildx-plugin)."
docker info >/dev/null 2>&1 || die "Docker is not running, or this user cannot use it (sudo usermod -aG docker \$USER, then log in again)."
[ "$(uname -m)" = x86_64 ] || say "This machine is $(uname -m): the images are built for x86_64 through emulation (slow; needs QEMU binfmt)."
if [ "${SKIP_AWS:-}" = 1 ]; then
    say "SKIP_AWS=1: no AWS checks or login (a rehearsal against $REGISTRY)"
    PW=unused
else
    command -v aws >/dev/null || die "The AWS CLI is missing (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)."
    who="$(aws sts get-caller-identity --query Arn --output text 2>&1)" || die "The AWS CLI is not signed in: $who"
    ok "AWS: $who"
    missing=""
    for r in $REPOS; do
        aws ecr describe-repositories --region "$REGION" --repository-names "$r" >/dev/null 2>&1 || missing="$missing $r"
    done
    [ -z "$missing" ] || die "These ECR repositories do not exist in $REGION (ask the admin; immutable tags, AES-256):$missing"
    ok "all $(wc -w <<<"$REPOS") ECR repositories exist in $REGION"
    PW="$(aws ecr get-login-password --region "$REGION")"
    docker login --username AWS --password-stdin "$REGISTRY" <<<"$PW" >/dev/null
fi
# crane runs as a container with its own login file, so it works whatever credential helper Docker uses.
mkdir -p "$WORK/crane"
python3 - "$WORK/crane/config.json" "$REGISTRY" "$PW" <<'PY'
import base64, json, sys
path, reg, pw = sys.argv[1:]
json.dump({"auths": {reg: {"auth": base64.b64encode(f"AWS:{pw}".encode()).decode()}}}, open(path, "w"))
PY
chmod 600 "$WORK/crane/config.json"
unset PW
# No -i: inside "while read" loops, crane must not swallow the rest of the list from stdin.
crane() { docker run --rm --network host --user "$(id -u):$(id -g)" -v "$WORK/crane:/cfg:ro" -e DOCKER_CONFIG=/cfg "$CRANE_IMAGE" "$@"; }
docker pull -q "$CRANE_IMAGE" >/dev/null
ok "Docker and crane logged in to $REGISTRY"
# The digest of repo:tag in ECR, or nothing when the tag is not there.
ecr_digest() { crane digest "$REGISTRY/$1" 2>/dev/null || true; }

# ------------------------------------------------------------------ 1. PostHog's images
step "1. PostHog's images, copied for linux/amd64"
: >"$WORK/images.lock"
n=0; total="$(wc -l <"$WORK/upstream.txt")"
while read -r src dst; do
    n=$((n + 1))
    want="$(crane digest --platform linux/amd64 "$src")" || die "Cannot read $src upstream."
    have="$(ecr_digest "$dst")"
    if [ -z "$have" ]; then
        crane copy --platform linux/amd64 "$src" "$REGISTRY/$dst" >/dev/null 2>"$WORK/copy.log" || { tail -5 "$WORK/copy.log"; die "Copying $src failed."; }
        have="$(ecr_digest "$dst")"
        verb=copied
    else
        verb="already there"
    fi
    [ "$have" = "$want" ] || die "$REGISTRY/$dst is $have, but $src for linux/amd64 is $want. Tags are immutable: delete that tag in ECR, then run this again."
    echo "$src ${REGISTRY}/${dst%%:*}@$have" >>"$WORK/images.lock"
    ok "[$n/$total] $verb  ${dst}  ${D}${have:7:12}${N}"
done <"$WORK/upstream.txt"
lock_of() { awk -v s="$1" '$1==s {print $2}' "$WORK/images.lock"; }

# ------------------------------------------------------------------ 2. ours
step "2. Our images, built for linux/amd64 from commit ${COMMIT:0:12}"
mkdir "$WORK/src" && git -C "$ROOT" archive HEAD | tar -x -C "$WORK/src"
# repo:tag dockerfile context [test]: builds and pushes unless ECR has the tag. Prints the ECR reference.
build_push() {
    local ref="$1" dockerfile="$2" context="$3"; shift 3
    local have; have="$(ecr_digest "$ref")"
    if [ -z "$have" ]; then
        say "building $ref ..." >&2
        docker buildx build -q --platform linux/amd64 --provenance=false --sbom=false "$@" \
            -f "$dockerfile" -t "$REGISTRY/$ref" --load "$context" >/dev/null || die "Building $ref failed (run without -q to see why: docker buildx build -f $dockerfile $context)."
        if [ "${ref%%:*}" = posthog/lens ] && [[ "$ref" != *:status-* ]]; then
            say "running the tests in it ..." >&2
            docker run --rm --user 1000:1000 --security-opt "seccomp=$ROOT/deploy/lens/seccomp-chrome.json" "$REGISTRY/$ref" \
                sh -c 'node --import tsx --test test/*.test.ts' >"$WORK/test.log" 2>&1 || { tail -30 "$WORK/test.log" >&2; die "The tests failed in $ref; nothing was pushed."; }
            say "$(grep -E '^ℹ (pass|fail) ' "$WORK/test.log" | tr '\n' ' ')" >&2
        fi
        docker push -q "$REGISTRY/$ref" >/dev/null || die "Pushing $ref failed."
        have="$(ecr_digest "$ref")"
        ok "built and pushed $ref  ${D}${have:7:12}${N}" >&2
    else
        ok "already there  $ref  ${D}${have:7:12}${N}" >&2
    fi
    echo "$REGISTRY/${ref%%:*}@$have"
}
ECR_NODE="$(build_push "posthog/node:$NODE_TAG" "$WORK/src/deploy/posthog/node-image/Dockerfile" "$WORK/src/deploy/posthog/node-image" --build-arg "BASE=$NODE_BASE_IMAGE")"
ECR_LENS="$(build_push "posthog/lens:$LENS_TAG" "$WORK/src/deploy/lens/Dockerfile" "$WORK/src")"
ECR_STATUS="$(build_push "posthog/lens:$STATUS_TAG" "$WORK/src/deploy/status/Dockerfile" "$WORK/src/deploy/status")"
ECR_MINIO="$(build_push "posthog/minio:$MINIO_TAG" "$WORK/src/deploy/migrate/minio-image/Dockerfile" "$WORK/src/deploy/migrate/minio-image")"

# ------------------------------------------------------------------ 3. the list
step "3. deploy/offline/ecr.env and images.lock"
PUSHED="$(date -u +%Y-%m-%dT%H:%MZ)"
cat >"$WORK/ecr.env" <<EOF
# Written by deploy/offline/push-images.sh at $PUSHED from commit $COMMIT.
# Every image comes from this registry (deploy/offline/ecr.sh); images.lock lists which replaces which.
IMAGE_REGISTRY=$REGISTRY
IMAGE_REGION=$REGION
IMAGES_PUSHED=$PUSHED
IMAGES_COMMIT=$COMMIT
ECR_APP=$(lock_of "$TARGET_APP_IMAGE")
ECR_STONE=$(lock_of "$STEPPING_STONE_IMAGE")
ECR_POSTHOG_MCP=$(lock_of "$MCP_UPSTREAM")
ECR_HELPER=$(lock_of "$ALPINE_IMAGE")
ECR_NODE=$ECR_NODE
ECR_LENS=$ECR_LENS
ECR_STATUS=$ECR_STATUS
ECR_MINIO=$ECR_MINIO
EOF
{ echo "# upstream image (as pinned)   its copy in $REGISTRY. Written by deploy/offline/push-images.sh at $PUSHED."; cat "$WORK/images.lock"; } >"$WORK/images.lock.out"
grep -qE '^ECR_[A-Z_]+=$' "$WORK/ecr.env" && die "An image is missing from the list (bug): $(grep -E '^ECR_[A-Z_]+=$' "$WORK/ecr.env")"
cp "$WORK/ecr.env" "$HERE/ecr.env"; cp "$WORK/images.lock.out" "$HERE/images.lock"
ok "$HERE/ecr.env and images.lock ($(grep -vc '^#' "$HERE/images.lock") images)"

# ------------------------------------------------------------------ 4. the kit
KIT_TAG="${COMMIT:0:12}-$(cat "$HERE/ecr.env" "$HERE/images.lock" | grep -v '^#' | sha256sum | cut -c1-8)"
step "4. The kit, posthog/kit:$KIT_TAG"
kit_have="$(ecr_digest "posthog/kit:$KIT_TAG")"
if [ -n "$kit_have" ]; then
    ok "already there  posthog/kit:$KIT_TAG"
else
    k="$WORK/kit"; mkdir -p "$k/files"
    mv "$WORK/src" "$k/repo"
    cp "$HERE/ecr.env" "$HERE/images.lock" "$k/repo/deploy/offline/"
    say "PostHog's source at $TARGET_COMMIT (about 500 MB) ..."
    git init -q "$WORK/posthog"
    git -C "$WORK/posthog" remote add origin https://github.com/PostHog/posthog.git
    git -C "$WORK/posthog" fetch -q --depth 1 origin "$TARGET_COMMIT"
    git -C "$WORK/posthog" checkout -q FETCH_HEAD
    [ "$(git -C "$WORK/posthog" rev-parse HEAD)" = "$TARGET_COMMIT" ] || die "Could not check out PostHog $TARGET_COMMIT."
    tar -czf "$k/files/posthog-src.tar.gz" -C "$WORK/posthog" .
    rm -rf "$WORK/posthog"
    ok "PostHog's source ($(du -h "$k/files/posthog-src.tar.gz" | cut -f1))"
    say "the GeoIP database ..."
    curl -fsSL --http1.1 --connect-timeout 10 --max-time 300 --retry 2 -o "$WORK/geo.br" 'https://mmdbcdn.posthog.net/' || die "Could not download the GeoIP database."
    if command -v brotli >/dev/null; then brotli -d -c "$WORK/geo.br" >"$k/files/GeoLite2-City.mmdb"
    else docker run --rm -i "$ALPINE_IMAGE" sh -c 'apk add -q brotli >/dev/null && brotli -d -c' <"$WORK/geo.br" >"$k/files/GeoLite2-City.mmdb"; fi
    [ -s "$k/files/GeoLite2-City.mmdb" ] || die "The GeoIP database came out empty."
    echo "{\"date\": \"$(date -u +%Y-%m-%d)\"}" >"$k/files/GeoLite2-City.json"
    ok "GeoIP database ($(du -h "$k/files/GeoLite2-City.mmdb" | cut -f1))"
    say "Docker Compose $COMPOSE_VERSION ..."
    base="https://github.com/docker/compose/releases/download/$COMPOSE_VERSION"
    curl -fsSL --connect-timeout 10 -o "$k/files/docker-compose" "$base/docker-compose-linux-x86_64"
    sum="$(curl -fsSL --connect-timeout 10 "$base/docker-compose-linux-x86_64.sha256" | awk '{print $1}')"
    echo "$sum  $k/files/docker-compose" | sha256sum -c --quiet - || die "Docker Compose does not match its checksum."
    chmod 755 "$k/files/docker-compose"
    ok "Docker Compose $COMPOSE_VERSION (checksum checked)"
    cp "$HERE/kit-image/Dockerfile" "$HERE/kit-image/unpack.sh" "$k/"
    build_push "posthog/kit:$KIT_TAG" "$k/Dockerfile" "$k" --build-arg "BASE=$ALPINE_IMAGE" >/dev/null
fi

step "Done"
KIT="$REGISTRY/posthog/kit:$KIT_TAG"
echo "$KIT" >"$HERE/last-kit.txt"
cat <<EOF
    Everything is in $REGISTRY. The kit: ${B}$KIT${N}

    On the machine without internet (its IAM role needs AmazonEC2ContainerRegistryReadOnly):
      aws ecr get-login-password --region $REGION | sudo docker login -u AWS --password-stdin $REGISTRY
      sudo docker run --rm -v ~/posthog-mcp-trial:/out $KIT
      cd ~/posthog-mcp-trial && sudo deploy/install.sh

    The kit's command unpacks this project and its files into the folder you mount at /out (your settings
    and data there are kept). deploy/install.sh then upgrades or installs PostHog and PostHog Lens from ECR.
EOF
