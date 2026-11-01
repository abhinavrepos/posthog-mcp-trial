#!/usr/bin/env bash
# Records the exact PostHog this machine runs, so an upgrade elsewhere gets byte-identical images:
#   versions/versions.env               the PostHog commit, app image and Node base image (by digest)
#   versions/docker-compose.pinned.yml  every other service's image, by digest
# PostHog's hobby files use moving tags (latest, master), which would otherwise pull whatever is newest
# on upgrade day instead of what was tested here.
#
#   sudo deploy/migrate/pin-versions.sh            # on the machine whose versions should be copied
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
OUT="$HERE/versions"
mkdir -p "$OUT"
cd "$POSTHOG_DIR"

commit=$(git -C posthog rev-parse HEAD)
app_id=$(docker compose images -q web | head -1)
app_digest=$(docker image inspect -f '{{index .RepoDigests 0}}' "$app_id")
node_digest=$(docker image inspect -f '{{index .RepoDigests 0}}' "${NODE_BASE_IMAGE:-ghcr.io/posthog/posthog-node:master}")
cat > "$OUT/versions.env" <<EOF
# PostHog as running on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ). Written by pin-versions.sh.
TARGET_COMMIT=$commit
TARGET_APP_IMAGE=$app_digest
NODE_BASE_IMAGE=$node_digest
EOF

{
    echo "# Exact images as running on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ). Written by pin-versions.sh."
    echo "# The Node services are not here: scale.sh builds them from NODE_BASE_IMAGE in versions.env."
    echo "services:"
    docker compose config --format json | python3 -c '
import json, subprocess, sys
cfg = json.load(sys.stdin)
skip_images = ("posthog-node-lens",)
for name, svc in sorted(cfg["services"].items()):
    img = svc.get("image")
    if not img or img.startswith(skip_images):
        continue
    out = subprocess.run(["docker", "image", "inspect", "-f", "{{index .RepoDigests 0}}", img], capture_output=True, text=True)
    digest = out.stdout.strip()
    if out.returncode or not digest:
        print(f"    # {name}: {img} has no registry digest here (built locally?)")
        continue
    print(f"    {name}:\n        image: {digest}")
'
} > "$OUT/docker-compose.pinned.yml"
echo "Pinned PostHog $commit:"
cat "$OUT/versions.env" | grep -v '^#'
echo "$(grep -c 'image:' "$OUT/docker-compose.pinned.yml") service images in versions/docker-compose.pinned.yml"
