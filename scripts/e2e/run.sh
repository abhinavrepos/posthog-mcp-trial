#!/usr/bin/env bash
# Runs every end-to-end check against a deployed Lens and prints one line per script.
#   LENS_URL=http://lens:8080 POSTHOG_URL=http://posthog E2E_PASSWORD_FILE=pw.txt scripts/e2e/run.sh
# Optional: E2E_TOKEN_FILE (admin chat key) to also run the speed benchmark; E2E_EXPECT_PLANTED=1 for demo data.
set -uo pipefail
cd "$(dirname "$0")/../.."
out="${E2E_OUT:-e2e-out}"; mkdir -p "$out"; export E2E_OUT="$out"
status=0
run() { local name="$1"; shift; echo "== $name"; if npx tsx "$@" > "$out/$name.txt" 2>&1; then :; else status=1; fi
    tail -n 1 "$out/$name.txt"; grep -E '^FAIL' "$out/$name.txt" | head -20; }
run check-all scripts/e2e/check-all.ts
run check-rescue scripts/e2e/check-rescue.ts
run check-signals scripts/e2e/check-signals.ts
if [ -n "${E2E_TOKEN_FILE:-${E2E_TOKEN:-}}" ]; then run bench scripts/e2e/bench.ts e2e; fi
grep -h -E '^FAIL' "$out"/check-*.txt >/dev/null 2>&1 && status=1
echo; [ "$status" = 0 ] && echo "All end-to-end checks passed (details in $out/)." || echo "Some checks failed (details in $out/)."
exit $status
