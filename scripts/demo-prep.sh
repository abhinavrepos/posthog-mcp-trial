#!/usr/bin/env bash
# One command before any demo: make sure everything runs, history reaches today, and there are
# fresh recorded sessions from today.
#
#   scripts/demo-prep.sh                 # keep the Jira board
#   scripts/demo-prep.sh --reset-board   # also clear the mock Jira board
set -euo pipefail
cd "$(dirname "$0")/.."

reset=0
[ "${1:-}" = --reset-board ] && reset=1

echo "==> PostHog"
curl -fs -m 10 http://localhost/_health >/dev/null && echo "    healthy" || { echo "    PostHog is not answering: sudo systemctl start posthog"; exit 1; }
[ -f .secrets.env ] || { echo "    .secrets.env is missing: run scripts/setup-posthog.sh first"; exit 1; }
[ -f vendor/rasterizer.cjs ] || pnpm build:rasterizer

echo "==> Processes"
scripts/stack.sh start

if [ "$reset" = 1 ]; then
    echo "==> Clearing the Jira board"
    pw=$(grep -E '^DEMO_UI_PASSWORD=' .secrets.env | cut -d= -f2-)
    curl -fs -o /dev/null -X POST -u "demo:$pw" http://localhost:4000/ui/reset && echo "    cleared"
fi

echo "==> Recording today's sessions (a few minutes)"
pnpm -s sessions

echo "==> Filling history up to now"
pnpm -s seed

echo "==> Waiting for the recordings to be stored"
sleep 30

echo "==> Recomputing release insights"
pnpm -s releases:sync || echo "    release sync failed; use \"Sync now\" on /releases"

echo
echo "Ready. Open the mock Jira board and file the example tickets."
scripts/stack.sh status
