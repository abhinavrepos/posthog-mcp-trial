#!/usr/bin/env bash
# Safe recording reader preflight. Output is deliberately a fixed vocabulary.
set -euo pipefail

checkRecordingApi() {
    local dir="${1:-${POSTHOG_DIR:-/opt/posthog}}" host="${POSTHOG_HOST:-http://127.0.0.1}"
    local env_file="$dir/.env" secret='' service value name
    if [ ! -r "$env_file" ]; then echo missing; return 1; fi
    secret="$(sed -n 's/^RECORDING_API_JWT_SECRET=//p' "$env_file" | tail -n 1 | tr -d '\r')"
    secret="${secret#\"}"; secret="${secret%\"}"
    if [ -z "$secret" ]; then echo missing; return 1; fi
    for service in web recording-api; do
        name="$(cd "$dir" && docker compose ps -q "$service" 2>/dev/null | head -n 1)"
        if [ -z "$name" ]; then echo unhealthy; return 1; fi
        if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != true ]; then echo unhealthy; return 1; fi
        value="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" 2>/dev/null | sed -n 's/^RECORDING_API_JWT_SECRET=//p' | tail -n 1)"
        if [ -z "$value" ]; then echo missing; return 1; fi
        if [ "$value" != "$secret" ]; then echo mismatch; return 1; fi
    done
    if ! curl -fsS --max-time 8 "$host/_health" >/dev/null 2>&1; then echo unhealthy; return 1; fi
    if [ -n "${POSTHOG_PERSONAL_API_KEY:-}" ] && [ -n "${POSTHOG_PROJECT_ID:-}" ] && [ -n "${REPLAY_VISION_PROBE_SESSION:-}" ]; then
        local status
        status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 -H "Authorization: Bearer $POSTHOG_PERSONAL_API_KEY" "$host/api/projects/$POSTHOG_PROJECT_ID/session_recordings/$REPLAY_VISION_PROBE_SESSION/snapshots?blob_v2=true" 2>/dev/null || true)"
        if [ "$status" != 200 ]; then echo api_failure; return 1; fi
    else
        # A complete doctor requires an authenticated recording request.
        echo api_failure; return 1
    fi
    echo configured
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then checkRecordingApi "$@"; fi
