#!/bin/sh
# Unpacks the kit into the project folder mounted at /out:
#   sudo docker run --rm -v ~/posthog-mcp-trial:/out <registry>/posthog/kit:<tag>
# The project's files are written over what is there; everything else in the folder (.secrets.env, the
# data in run/ and clips/, logs) is kept. PostHog's source, the GeoIP database and Docker Compose go to
# deploy/offline/kit/, where deploy/install.sh and the upgrade look for them. Files keep the folder's owner.
set -eu
out=/out
if [ ! -d "$out" ]; then
    echo "Mount the project folder at /out, e.g.: sudo docker run --rm -v ~/posthog-mcp-trial:/out <this image>" >&2
    exit 1
fi
owner="$(stat -c %u:%g "$out")"
mode="$(stat -c %a "$out")"
cd /kit/repo
find . -mindepth 1 -type d | while read -r d; do mkdir -p "$out/$d"; done
cp -a . "$out/"
# cp -a also copies the kit folder's own owner and mode onto the mounted folder: put them back.
chown "$owner" "$out"; chmod "$mode" "$out"
mkdir -p "$out/deploy/offline/kit"
cp /kit/files/* "$out/deploy/offline/kit/"
# Only what was unpacked changes owner, so the service user's data folders stay as they are.
{ find . -mindepth 1; (cd /kit/files && find . -mindepth 1 -type f | sed 's#^\./#./deploy/offline/kit/#'); echo ./deploy/offline/kit; } \
    | while read -r f; do chown -h "$owner" "$out/$f"; done
. "$out/deploy/offline/ecr.env"
echo "Unpacked PostHog Lens (commit $(echo "$IMAGES_COMMIT" | cut -c1-12), images pushed $IMAGES_PUSHED) into the mounted folder."
echo "Images: from $IMAGE_REGISTRY, or (IMAGE_SOURCE=local) the lens-offline/... copies loaded on the machine. Next, in that folder: sudo deploy/install.sh"
