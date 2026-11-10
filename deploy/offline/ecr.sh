# Images from your own registry (ECR) instead of Docker Hub and GitHub, for a machine without internet.
# Sourced (not run) by deploy/migrate/versions/versions.env, so every script that reads the pinned
# versions gets this too, and by the scripts that pull images.
#
# It is on when deploy/offline/ecr.env exists. deploy/offline/build-images.sh writes that file, with
# images.lock next to it, after copying every image to the registry; the kit image (posthog/kit) carries
# both to the machine. IMAGES_FROM=upstream turns it off for one run.
#
# What changes when it is on:
#   - TARGET_APP_IMAGE, STEPPING_STONE_IMAGE and NODE_BASE_IMAGE are the registry's copies (same digests'
#     content: build-images.sh copies them byte for byte)
#   - the Node image is not built here: POSTHOG_NODE_PREBUILT is the one build-images.sh built
#   - ecr_compose_override writes docker-compose.ecr.yml in the PostHog folder: every PostHog service's
#     image from the registry. It stops with a list when one has no copy there.
#   - HELPER_IMAGE (the small image the upgrade runs for copying files) is the registry's alpine
#   - PostHog's source, the GeoIP database and Docker Compose come from the kit's files (KIT_DIR)
# shellcheck shell=bash

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$OFFLINE_DIR/kit"
ECR_OVERRIDE=docker-compose.ecr.yml
HELPER_IMAGE="${HELPER_IMAGE:-alpine}"
if [ -f "$OFFLINE_DIR/ecr.env" ] && [ "${IMAGES_FROM:-}" != upstream ]; then
    # shellcheck disable=SC1091
    . "$OFFLINE_DIR/ecr.env"
    IMAGES_FROM=ecr
    TARGET_APP_IMAGE="$ECR_APP"
    STEPPING_STONE_IMAGE="$ECR_STONE"
    NODE_BASE_IMAGE="$ECR_NODE"
    POSTHOG_NODE_PREBUILT="$ECR_NODE"
    HELPER_IMAGE="$ECR_HELPER"
else
    IMAGES_FROM=upstream
    POSTHOG_NODE_PREBUILT=""
fi

# A file the kit brought (PostHog's source, the GeoIP database, docker-compose); empty when there is none.
kit_file() { [ -s "$KIT_DIR/$1" ] && echo "$KIT_DIR/$1" || true; }

# Docker logs in to the registry with this machine's IAM role (the instance profile needs
# AmazonEC2ContainerRegistryReadOnly). A login lasts 12 hours, so every script that pulls calls this.
images_login() {
    [ "$IMAGES_FROM" = ecr ] || return 0
    # A local registry (a rehearsal: build-images.sh with SKIP_AWS=1 REGISTRY=localhost:5000) needs no login.
    case "$IMAGE_REGISTRY" in localhost:* | 127.0.0.1:*) return 0 ;; esac
    command -v aws >/dev/null 2>&1 || { echo "The AWS CLI is missing (sudo dnf install -y awscli): it logs Docker in to $IMAGE_REGISTRY." >&2; return 1; }
    local pw
    pw="$(aws ecr get-login-password --region "$IMAGE_REGION" 2>&1)" || {
        echo "Could not log in to $IMAGE_REGISTRY: $pw" >&2
        echo "The instance's IAM role needs AmazonEC2ContainerRegistryReadOnly, and the VPC the ECR endpoints (ecr.api, ecr.dkr) and the S3 gateway endpoint." >&2
        return 1
    }
    docker login --username AWS --password-stdin "$IMAGE_REGISTRY" <<<"$pw" >/dev/null
}

# image local-name: pulls the registry's image unless it is here already, and gives it the local name
# the compose files and scripts use (posthog-node-lens:latest, posthog-lens:current...).
ecr_pull_tag() {
    docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
    docker tag "$1" "$2"
}

# posthog-dir: writes docker-compose.ecr.yml there (every service's image from the registry) and lists
# it last in COMPOSE_FILE, and in EXTRA_COMPOSE_FILES so scale.sh and posthog-upgrade.sh keep it.
# Services on PostHog's Node image get the Node image build-images.sh built. Stops, listing them, when an
# image has no copy in the registry.
ecr_compose_override() {
    [ "$IMAGES_FROM" = ecr ] || return 0
    local dir="$1" files extra
    files="$(grep -E '^COMPOSE_FILE=' "$dir/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
    files="$(tr ':' '\n' <<<"${files:-docker-compose.yml}" | grep -v '^$' | grep -vx "$ECR_OVERRIDE" | paste -sd:)"
    python3 - "$dir" "$files" "$IMAGE_REGISTRY" "$OFFLINE_DIR/images.lock" "$ECR_NODE" "$ECR_OVERRIDE" <<'PY' || return 1
import json, os, re, subprocess, sys
d, files, reg, lock, node, out_name = sys.argv[1:]
env = dict(os.environ, COMPOSE_FILE=files)
cfg = json.loads(subprocess.check_output(["docker", "compose", "config", "--format", "json"], cwd=d, env=env))
copies = {}
for line in open(lock):
    parts = line.split()
    if len(parts) == 2 and not line.startswith("#"):
        copies[parts[0]] = parts[1]
out, missing = {}, []
for name, svc in sorted(cfg.get("services", {}).items()):
    img = svc.get("image") or ""
    if not img or img.startswith(reg + "/"):
        continue
    if img in copies:
        out[name] = copies[img]
        continue
    repo = re.sub(r"@sha256:[0-9a-f]{64}$", "", img)
    repo = re.sub(r":[^/:]+$", "", repo)
    if repo.rsplit("/", 1)[-1] in ("posthog-node", "posthog-node-lens"):
        out[name] = node
        continue
    missing.append(f"    {name}: {img}")
if missing:
    print("These PostHog services use images that are not in " + reg + " (images.lock):", file=sys.stderr)
    print("\n".join(missing), file=sys.stderr)
    print("Run deploy/offline/build-images.sh again for this version, and use the new kit.", file=sys.stderr)
    sys.exit(1)
with open(os.path.join(d, out_name), "w") as f:
    f.write("# Written by deploy/offline/ecr.sh: every image from " + reg + " (see deploy/offline/images.lock).\nservices:\n")
    for name, img in out.items():
        f.write(f"    {name}:\n        image: {img}\n")
print(f"    {len(out)} services take their image from {reg}")
PY
    extra="$(grep -E '^EXTRA_COMPOSE_FILES=' "$dir/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
    extra="$(tr ':' '\n' <<<"$extra" | grep -v '^$' | grep -vx "$ECR_OVERRIDE" | paste -sd: || true)"
    _ecr_envset "$dir" COMPOSE_FILE "$files:$ECR_OVERRIDE"
    _ecr_envset "$dir" EXTRA_COMPOSE_FILES "${extra:+$extra:}$ECR_OVERRIDE"
}
_ecr_envset() {
    if grep -qE "^$2=" "$1/.env"; then sed -i "s|^$2=.*|$2=$3|" "$1/.env"; else echo "$2=$3" >>"$1/.env"; fi
}

# posthog-dir: every image the compose files name is from the registry, or here already under a local
# name (posthog-node-lens:latest). Prints the others and fails, before anything tries the internet.
ecr_check_images() {
    [ "$IMAGES_FROM" = ecr ] || return 0
    local img bad=""
    for img in $(cd "$1" && docker compose config --images 2>/dev/null | sort -u); do
        [[ "$img" == "$IMAGE_REGISTRY/"* ]] && continue
        docker image inspect "$img" >/dev/null 2>&1 && continue
        bad="$bad    $img"$'\n'
    done
    [ -z "$bad" ] && return 0
    printf 'These images are neither in %s nor on this machine:\n%s' "$IMAGE_REGISTRY" "$bad" >&2
    return 1
}
