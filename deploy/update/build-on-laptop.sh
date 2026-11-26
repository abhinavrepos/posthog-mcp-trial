#!/usr/bin/env bash
# Build Signal on a laptop (WSL) and write the two files to copy to the server with WinSCP.
#   bash deploy/update/build-on-laptop.sh [OUT_DIR]     (default: Windows Downloads)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-/mnt/c/Users/$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')/Downloads}"
mkdir -p "$OUT"
echo "== build image from $(git rev-parse --short HEAD) ($(git branch --show-current))"
docker buildx build --load -f deploy/lens/Dockerfile -t posthog-lens:current .
echo "== write files to $OUT"
git archive --format=tar.gz -o "$OUT/signal-code.tar.gz" HEAD
docker save posthog-lens:current | gzip > "$OUT/signal-image.tar.gz"
sync
gzip -t "$OUT/signal-code.tar.gz" && gzip -t "$OUT/signal-image.tar.gz" && echo "FILES OK"
ls -lh "$OUT"/signal-*.tar.gz
sha256sum "$OUT"/signal-*.tar.gz
echo "Copy both files (WinSCP, Binary mode) to the server's home folder, then run deploy/update/apply-on-server.sh there."
