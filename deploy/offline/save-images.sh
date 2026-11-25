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
#
# On the machine (Docker installed, nothing else), with fresh-install.sh or upgrade.sh from deploy/offline/out:
#   sudo docker load -i posthog-lens-images-<kit>.tar   (docker load rejects a damaged file)
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
    # The machine's kit: from the registry, or loaded here from the machine (docker save
    # lens-offline/posthog/kit:<tag> there, docker load here), which needs no AWS.
    SINCE_KIT="lens-offline/posthog/kit:$SINCE"
    docker image inspect "$SINCE_KIT" >/dev/null 2>&1 || { SINCE_KIT="$REGISTRY/posthog/kit:$SINCE"; docker pull -q "$SINCE_KIT" >/dev/null || die "Cannot find the kit $SINCE: load it from the machine (there: sudo docker save lens-offline/posthog/kit:$SINCE -o kit-$SINCE.tar; here: docker load -i kit-$SINCE.tar)."; }
    mkdir "$WORK/since"
    docker run --rm --entrypoint tar "$SINCE_KIT" -C /kit/repo/deploy/offline -cf - ecr.env images.lock | tar -xf - -C "$WORK/since"
    # Compared by the name on the machine (lens-offline/...), so a kit built against another registry
    # (ECR then, a local one now) still matches: tags come from the content.
    have="$( { awk '!/^#/ && NF == 2 {print $2}' "$WORK/since/images.lock"; grep -E '^ECR_[A-Z_]+=' "$WORK/since/ecr.env" | cut -d= -f2-; } | sort -u | while read -r r; do local_ref "$r"; done)"
    mapfile -t REFS < <(for r in "${REFS[@]}"; do grep -qxF "$(local_ref "$r")" <<<"$have" || echo "$r"; done)
    ok "${#REFS[@]} of them are new since kit $SINCE (the machine has the others)"
fi

say "Pulling and naming them for the machine (lens-offline/...)"
NAMES=("lens-offline/posthog/kit:$TAG")
same_posthog() {  # the new kit pins the same PostHog (app image, pinned services) as kit $SINCE
    local a b
    a="$(grep -E '^ECR_(APP|STONE)=' "$WORK/ecr.env" | while IFS== read -r k v; do echo "$k=$(local_ref "$v")"; done; docker run --rm --entrypoint cat "$KIT" /kit/repo/deploy/migrate/versions/docker-compose.pinned.yml | sha256sum)"
    b="$(grep -E '^ECR_(APP|STONE)=' "$WORK/since/ecr.env" | while IFS== read -r k v; do echo "$k=$(local_ref "$v")"; done; docker run --rm --entrypoint cat "$SINCE_KIT" /kit/repo/deploy/migrate/versions/docker-compose.pinned.yml | sha256sum)"
    [ "$a" = "$b" ]
}
if [ -n "${SINCE:-}" ] && same_posthog; then
    # Same PostHog as the machine's kit: its PostHog source, GeoIP database and Compose (about 550 MB) are
    # already there and unused by a Lens update. The patch kit carries only the project; unpack keeps the rest.
    say "Same PostHog as kit $SINCE: the patch kit carries only the project (the machine keeps its PostHog files)"
    pk="$WORK/patch-kit"; mkdir -p "$pk/files"
    cid="$(docker create "$KIT")"
    docker cp -q "$cid:/kit/repo" "$pk/repo"; docker rm -f "$cid" >/dev/null
    cp "$pk/repo/deploy/offline/kit-image/unpack.sh" "$pk/unpack.sh"   # this version keeps the machine's PostHog files
    base="$(docker image inspect "$KIT" --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}' 2>/dev/null)"
    base="$(grep -E '^ECR_HELPER=' "$WORK/ecr.env" | cut -d= -f2-)"
    printf 'FROM %s\nCOPY unpack.sh /kit/unpack.sh\nCOPY repo /kit/repo\nRUN mkdir -p /kit/files\nENTRYPOINT ["/bin/sh", "/kit/unpack.sh"]\n' "$base" >"$pk/Dockerfile"
    docker pull -q "$base" >/dev/null 2>&1 || true
    docker build -q -t "lens-offline/posthog/kit:$TAG" "$pk" >/dev/null || die "Could not build the patch kit."
    REFS+=("$base")   # its base layer is almost always on the machine already; it is dropped below if so
else
    docker tag "$KIT" "lens-offline/posthog/kit:$TAG"
fi
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
if [ -n "${SINCE:-}" ]; then
    # A patch: leave out every layer the machine already has from kit $SINCE (a new Lens version usually
    # changes only its few-MB code layer; its 1 GB of dependencies stays). docker load reuses the machine's
    # copies, with the classic and the containerd image store alike (tested). Layer lists come from the registry.
    say "Leaving out the layers the machine already has (kit $SINCE)"
    layers_of() {  # compressed layer digests of one image (the amd64 manifest of a list)
        docker buildx imagetools inspect --raw "$1" 2>/dev/null | python3 -c '
import json, subprocess, sys
m = json.load(sys.stdin); ref = sys.argv[1]
if "manifests" in m:
    pick = next((x for x in m["manifests"] if x.get("platform", {}).get("architecture") == "amd64"), m["manifests"][0])
    repo = ref.split("@")[0].rsplit(":", 1)[0] if "@" in ref else ref.rsplit(":", 1)[0]
    m = json.loads(subprocess.check_output(["docker", "buildx", "imagetools", "inspect", "--raw", repo + "@" + pick["digest"]]))
print("\n".join(l["digest"].split(":", 1)[1] for l in m.get("layers", [])))' "$1"
    }
    : >"$WORK/have-layers"
    while read -r r; do [ -n "$r" ] && { layers_of "$r" >>"$WORK/have-layers" || die "Cannot read the layers of $r."; }; done \
        < <(printf '%s\n' "$REGISTRY/posthog/kit:$SINCE" "$have")
    sort -u -o "$WORK/have-layers" "$WORK/have-layers"
    [ -s "$WORK/have-layers" ] || die "Found no layers for kit $SINCE; refusing to guess."
    mkdir "$WORK/slim"; tar -xf "$FILE.part" -C "$WORK/slim"
    dropped=0
    while read -r d; do [ -f "$WORK/slim/blobs/sha256/$d" ] && rm -f "$WORK/slim/blobs/sha256/$d" && dropped=$((dropped + 1)); done <"$WORK/have-layers"
    tar -cf "$FILE.part" -C "$WORK/slim" .
    rm -rf "$WORK/slim"
    ok "left out $dropped layers the machine already has"
fi
mv "$FILE.part" "$FILE"
ok "$(du -h "$FILE" | cut -f1)"

PATCH_NOTE=""
[ -n "${SINCE:-}" ] && PATCH_NOTE="
        (a patch: it needs kit $SINCE's images on the machine; if docker load reports missing content,
         carry the full file instead: deploy/offline/save-images.sh $TAG)"
cat <<EOF

    Carry these to the machine (Ubuntu with Docker; no internet or AWS needed there):
      $FILE
      $OUT/fresh-install.sh   (no PostHog there yet)   or   $OUT/upgrade.sh   (PostHog runs there)

    On the machine:
      sudo docker load -i $(basename "$FILE")$PATCH_NOTE
      sudo bash fresh-install.sh $TAG       (or: sudo bash upgrade.sh $TAG)
EOF
