#!/usr/bin/env bash
# For a machine with no AWS and no internet (Ubuntu): puts every image of one kit into ONE file, to carry
# to that machine. Run it on the build machine after build-images.sh (script 1), which pushed the images.
#
#   deploy/offline/save-images.sh                 # the kit build-images.sh made last (deploy/offline/last-kit.txt)
#   deploy/offline/save-images.sh <kit tag>       # another kit, e.g. 685049943753-92fb46e1
#   OUT=/some/folder deploy/offline/save-images.sh
#   SINCE=<kit tag on the machine> deploy/offline/save-images.sh
#                         only the images that kit did not have: a much smaller file for an update (often
#                         just PostHog Lens and the kit). The machine must have that kit's images loaded.
#
# It writes, in OUT [deploy/offline/out]:
#   posthog-lens-images-<kit>.tar          every image (PostHog's, PostHog Lens, the kit itself), about 15 GB
#   posthog-lens-images-<kit>.tar.sha256   its checksum
#
# On the machine (Docker installed, nothing else), with fresh-install.sh or upgrade.sh from deploy/offline/out:
#   sha256sum -c posthog-lens-images-<kit>.tar.sha256
#   sudo docker load -i posthog-lens-images-<kit>.tar
#   sudo bash fresh-install.sh        (or: sudo bash upgrade.sh)
# Those scripts find the images under the names lens-offline/<repository>:<tag> and download nothing
# (IMAGE_SOURCE=local, the default on Ubuntu). docker load keeps tags but not digests, so each image's
# digest becomes its tag: <registry>/posthog/lens@sha256:<hex> is lens-offline/posthog/lens:sha256-<hex>.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$HERE/out}"
if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; N=$'\e[0m'; else G=; R=; N=; fi
say() { echo "==> $*"; }
ok() { echo "    ${G}✔${N} $*"; }
die() { echo "${R}✘ $*${N}" >&2; exit 1; }
case "${1:-}" in -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;; esac
command -v docker >/dev/null || die "Docker is missing."

# The kit: the tag given, else the one build-images.sh made last.
last="$(cat "$HERE/last-kit.txt" 2>/dev/null || true)"
[ -n "$last" ] || die "No deploy/offline/last-kit.txt: run build-images.sh first."
REGISTRY="${last%%/posthog/kit:*}"
TAG="${1:-${last##*:}}"; TAG="${TAG##*:}"
[[ "$TAG" =~ ^[0-9a-f]{12}-[0-9a-f]{8}$ ]] || die "\"$TAG\" is not a kit tag. It looks like 685049943753-92fb46e1."
KIT="$REGISTRY/posthog/kit:$TAG"

case "$REGISTRY" in
    localhost:* | 127.0.0.1:*) ;;
    *.dkr.ecr.*.amazonaws.com)
        region="$(echo "$REGISTRY" | cut -d. -f4)"
        aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null \
            || die "Cannot log in to $REGISTRY." ;;
esac

# Same as local_ref in ecr.sh: the registry's name -> the name on the machine.
local_ref() {
    local r="$1" host="${1%%/*}"
    case "$host" in *.* | *:* | localhost) r="${r#*/}" ;; esac
    echo "lens-offline/${r/@sha256:/:sha256-}"
}

say "Kit $TAG from $REGISTRY"
docker pull -q "$KIT" >/dev/null || die "Cannot pull $KIT (is the tag right?)."
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
docker run --rm --entrypoint tar "$KIT" -C /kit/repo/deploy/offline -cf - ecr.env images.lock | tar -xf - -C "$WORK" \
    || die "$KIT has no deploy/offline/ecr.env or images.lock."
# Every image the kit uses: the copies in images.lock, and the ones ecr.env names.
mapfile -t REFS < <( { awk '!/^#/ && NF == 2 {print $2}' "$WORK/images.lock"
    grep -E '^ECR_[A-Z_]+=' "$WORK/ecr.env" | cut -d= -f2-; } | grep -v '^$' | sort -u)
ok "${#REFS[@]} images"
if [ -n "${SINCE:-}" ]; then
    SINCE="${SINCE##*:}"
    [[ "$SINCE" =~ ^[0-9a-f]{12}-[0-9a-f]{8}$ ]] || die "SINCE: \"$SINCE\" is not a kit tag."
    docker pull -q "$REGISTRY/posthog/kit:$SINCE" >/dev/null || die "Cannot pull the kit $SINCE."
    mkdir "$WORK/since"
    docker run --rm --entrypoint tar "$REGISTRY/posthog/kit:$SINCE" -C /kit/repo/deploy/offline -cf - ecr.env images.lock | tar -xf - -C "$WORK/since"
    have="$( { awk '!/^#/ && NF == 2 {print $2}' "$WORK/since/images.lock"; grep -E '^ECR_[A-Z_]+=' "$WORK/since/ecr.env" | cut -d= -f2-; } | sort -u)"
    mapfile -t REFS < <(printf '%s\n' "${REFS[@]}" | grep -vxF -f <(echo "$have") || true)
    ok "${#REFS[@]} of them are new since kit $SINCE (the machine has the others)"
fi

say "Pulling and naming them for the machine (lens-offline/...)"
NAMES=("lens-offline/posthog/kit:$TAG")
docker tag "$KIT" "lens-offline/posthog/kit:$TAG"
i=0
for r in ${REFS[@]+"${REFS[@]}"}; do
    i=$((i + 1))
    docker image inspect "$r" >/dev/null 2>&1 || docker pull -q "$r" >/dev/null || die "Cannot pull $r."
    n="$(local_ref "$r")"
    docker tag "$r" "$n"
    NAMES+=("$n")
    printf '    %2d/%d %s\n' "$i" "${#REFS[@]}" "$n"
done

mkdir -p "$OUT"
FILE="$OUT/posthog-lens-images-$TAG${SINCE:+-since-$SINCE}.tar"
say "Writing $FILE (several minutes)"
docker save -o "$FILE.part" "${NAMES[@]}"
mv "$FILE.part" "$FILE"
(cd "$OUT" && sha256sum "$(basename "$FILE")" >"$(basename "$FILE").sha256")
ok "$(du -h "$FILE" | cut -f1), checksum in $(basename "$FILE").sha256"

cat <<EOF

    Carry these to the machine (Ubuntu with Docker; no internet or AWS needed there):
      $FILE
      $FILE.sha256
      $OUT/fresh-install.sh   (no PostHog there yet)   or   $OUT/upgrade.sh   (PostHog runs there)

    On the machine:
      sha256sum -c $(basename "$FILE").sha256
      sudo docker load -i $(basename "$FILE")
      sudo bash fresh-install.sh $TAG       (or: sudo bash upgrade.sh $TAG)
EOF
