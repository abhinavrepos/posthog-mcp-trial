#!/usr/bin/env bash
# Serves the Lens survey renderer from this machine's PostHog: PostHog's own surveys.js with
# "Survey by ION" instead of the PostHog footer, plus Lens condition chains (build.mjs, engine.js).
# Reval keeps loading the same /static/surveys.js from PostHog; no script is added to Reval.
#
#   sudo deploy/posthog/survey-engine/apply.sh [POSTHOG_DIR]            # build and serve (idempotent)
#   sudo deploy/posthog/survey-engine/apply.sh --remove [POSTHOG_DIR]   # back to PostHog's original file
#
# Settings (environment): SURVEY_ENGINE on|off (off = --remove), SURVEY_BRAND ["Survey by ION"],
# LENS_IMAGE [posthog-lens:current] (runs the build with its node when this machine has none).
# It takes the ORIGINAL file from PostHog's web image every time, so after a PostHog upgrade it rebuilds
# from the new version. If the new version's footer has changed shape, the build refuses, this script
# removes the override and warns: surveys keep working with PostHog's original file. It never fails
# the install for that.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REMOVE=0
[ "${1:-}" = --remove ] && { REMOVE=1; shift; }
POSTHOG_DIR="${1:-${POSTHOG_DIR:-/opt/posthog}}"
[ "${SURVEY_ENGINE:-on}" = off ] && REMOVE=1
BRAND="${SURVEY_BRAND:-Survey by ION}"
LENS_IMAGE="${LENS_IMAGE:-posthog-lens:current}"
OUT="$POSTHOG_DIR/lens-survey-engine"
OVERRIDE=docker-compose.lens-survey.yml
say() { echo "    $*"; }
warn() { echo "    ! $*"; }
cd "$POSTHOG_DIR" || { warn "no PostHog folder at $POSTHOG_DIR"; exit 0; }

# COMPOSE_FILE and EXTRA_COMPOSE_FILES in .env: add or remove our file, checked before it is kept.
# EXTRA_COMPOSE_FILES makes scale.sh and posthog-upgrade.sh keep it when they rewrite COMPOSE_FILE.
compose_list() { # add|remove
    cp .env .env.lens-survey.bak
    python3 - "$1" "$OVERRIDE" <<'PY' || return 1
import re, sys
mode, f = sys.argv[1:]
lines = open('.env').read().splitlines()
def edit(key, default):
    global lines
    for i, line in enumerate(lines):
        if line.startswith(key + '='):
            items = [x for x in line.split('=', 1)[1].strip().strip('"').split(':') if x]
            break
    else:
        i, items = None, default[:]
    if not items and key == 'COMPOSE_FILE':
        raise SystemExit('COMPOSE_FILE is empty; refusing to edit it')
    items = [x for x in items if x != f] + ([f] if mode == 'add' else [])
    new = f'{key}="{":".join(items)}"' if key == 'COMPOSE_FILE' else f'{key}={":".join(items)}'
    if i is None: lines.append(new)
    else: lines[i] = new
edit('COMPOSE_FILE', ['docker-compose.yml'] + (['docker-compose.override.yml'] if __import__('os').path.exists('docker-compose.override.yml') else []))
edit('EXTRA_COMPOSE_FILES', [])
open('.env', 'w').write('\n'.join(lines) + '\n')
PY
    if ! docker compose config --services >/dev/null 2>&1; then
        mv .env.lens-survey.bak .env
        return 1
    fi
    rm -f .env.lens-survey.bak
}
# Recreated, not just restarted: the files are bind-mounted one by one, a mount keeps the file it
# started with, and PostHog's static file server reads sizes at start.
restart_web() {
    docker compose up -d --force-recreate --no-deps web >/dev/null 2>&1 || { warn "docker compose up -d web failed"; return 1; }
    say "PostHog's web service restarted; it answers again in a few minutes"
}
remove() {
    if grep -q "$OVERRIDE" .env 2>/dev/null || [ -f "$OVERRIDE" ]; then
        compose_list remove || warn "could not take $OVERRIDE out of .env (left as it was)"
        rm -f "$OVERRIDE"
        restart_web
        say "survey renderer: PostHog's original"
    fi
}
if [ "$REMOVE" = 1 ]; then remove; exit 0; fi

# 1. The original file, from PostHog's web image (the running container shows ours once it is mounted).
cid="$(docker compose ps -q web 2>/dev/null | head -1)"
image="$( [ -n "$cid" ] && docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null)"
[ -n "$image" ] || { warn "PostHog's web service is not running; survey engine not applied"; exit 0; }
mkdir -p "$OUT/new"
if ! docker run --rm --entrypoint cat "$image" /code/staticfiles/surveys.js > "$OUT/surveys.original.js" 2>/dev/null || [ ! -s "$OUT/surveys.original.js" ]; then
    warn "could not read surveys.js from $image; survey engine not applied"; remove; exit 0
fi

# 2. Build (node on this machine, or the Lens image's node).
if command -v node >/dev/null 2>&1; then
    node "$HERE/build.mjs" "$OUT/surveys.original.js" "$OUT/new" "$BRAND" >"$OUT/build.log" 2>&1
else
    docker run --rm --user 0 -v "$HERE:/engine:ro" -v "$OUT:/out" --entrypoint node "$LENS_IMAGE" /engine/build.mjs /out/surveys.original.js /out/new "$BRAND" >"$OUT/build.log" 2>&1
fi
if [ $? -ne 0 ] || [ ! -s "$OUT/new/surveys.js" ]; then
    warn "survey engine build refused ($(tail -1 "$OUT/build.log")): serving PostHog's original survey renderer"
    remove; exit 0
fi

# 3. Swap the files in only when they changed, then make sure web mounts them.
changed=0
for f in surveys.js surveys.js.br surveys.js.gz; do
    if ! cmp -s "$OUT/new/$f" "$OUT/$f" 2>/dev/null; then cp "$OUT/new/$f" "$OUT/$f.tmp" && mv "$OUT/$f.tmp" "$OUT/$f"; changed=1; fi
done
# The manifest records when it was built; it only follows the files above.
[ "$changed" = 1 ] || [ ! -f "$OUT/manifest.json" ] && cp "$OUT/new/manifest.json" "$OUT/manifest.json"
rm -rf "$OUT/new"
cat > "$OVERRIDE.tmp" <<EOF
# Lens survey engine (deploy/posthog/survey-engine): PostHog's survey renderer with "$BRAND" and
# Lens condition chains. Written by apply.sh; remove with apply.sh --remove.
services:
    web:
        volumes:
            - ./lens-survey-engine/surveys.js:/code/staticfiles/surveys.js:ro
            - ./lens-survey-engine/surveys.js.br:/code/staticfiles/surveys.js.br:ro
            - ./lens-survey-engine/surveys.js.gz:/code/staticfiles/surveys.js.gz:ro
EOF
cmp -s "$OVERRIDE.tmp" "$OVERRIDE" 2>/dev/null || { mv "$OVERRIDE.tmp" "$OVERRIDE"; changed=1; }
rm -f "$OVERRIDE.tmp"
in_compose=0; grep -qE "^COMPOSE_FILE=.*$OVERRIDE" .env && in_compose=1
if [ "$in_compose" = 0 ] || ! grep -qE "^EXTRA_COMPOSE_FILES=.*$OVERRIDE" .env; then
    compose_list add || { warn "could not add $OVERRIDE to COMPOSE_FILE; serving PostHog's original survey renderer"; rm -f "$OVERRIDE"; exit 0; }
    [ "$in_compose" = 0 ] && changed=1
fi
# Mounted already? A running web container started before the override has no such mount.
docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$cid" 2>/dev/null | grep -q /code/staticfiles/surveys.js || changed=1
if [ "$changed" = 1 ]; then restart_web; fi
say "survey renderer: \"$BRAND\" footer and Lens chains ($(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['output_sha256'][:12])" 2>/dev/null))"
exit 0
