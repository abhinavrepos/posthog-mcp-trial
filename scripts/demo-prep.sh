#!/usr/bin/env bash
# One command before any demo: make sure everything runs, history reaches today, and there are
# fresh recorded sessions from today.
#
#   scripts/demo-prep.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> PostHog"
curl -fs -m 10 http://localhost/_health >/dev/null && echo "    healthy" || { echo "    PostHog is not answering: sudo systemctl start posthog"; exit 1; }
[ -f .secrets.env ] || { echo "    .secrets.env is missing: run scripts/setup-posthog.sh first"; exit 1; }
[ -f vendor/rasterizer.cjs ] || pnpm build:rasterizer

echo "==> Processes"
scripts/stack.sh start

echo "==> Recording today's sessions (a few minutes)"
pnpm -s sessions

echo "==> Filling history up to now"
pnpm -s seed
pnpm -s seed:feedback

echo "==> Waiting for the recordings to be stored"
sleep 30

echo "==> Recomputing release insights"
pnpm -s releases:sync || echo "    release sync failed (is Jira connected? pnpm doctor)"

echo
echo "Ready."
scripts/stack.sh status
