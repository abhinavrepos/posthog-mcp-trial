#!/usr/bin/env bash
# Serves the Lens survey renderer from this machine's PostHog: PostHog's own surveys.js with
# "Survey by ION" instead of the PostHog footer, plus Lens condition chains (build.mjs, engine.js).
# Reval keeps loading the same /static/surveys.js from PostHog; no script is added to Reval.
#
#   sudo deploy/posthog/survey-engine/apply.sh [POSTHOG_DIR]            # build and serve (idempotent)
#   sudo deploy/posthog/survey-engine/apply.sh --remove [POSTHOG_DIR]   # back to PostHog's original file
#
# Settings (environment): SURVEY_ENGINE on|off (off = --remove), SURVEY_BRAND ["Survey by ION"],
# LENS_IMAGE [posthog-lens:current] (runs the build with its node when this machine has none),
# SURVEY_UI_LOCK on|off [on], SURVEY_GATE (POSTHOG_SURVEY_GATE from Lens's .secrets.env), LENS_URL
# (where people reach Lens). The lock closes PostHog's own survey screens and API: PostHog's proxy
# answers survey API calls only when they carry the gate (Lens's calls do) and sends the Surveys
# screen to Lens. The new proxy config is checked with Caddy first and undone if the proxy then fails.
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
compose_list() { # add|remove [file]
    cp .env .env.lens-survey.bak
    python3 - "$1" "${2:-$OVERRIDE}" <<'PY' || { mv .env.lens-survey.bak .env; return 1; }
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
LOCK=docker-compose.lens-survey-lock.yml
lock_off() {
    if grep -q "$LOCK" .env 2>/dev/null || [ -f "$LOCK" ]; then
        compose_list remove "$LOCK" || warn "could not take $LOCK out of .env"
        rm -f "$LOCK"
        docker compose up -d --no-deps proxy >/dev/null 2>&1 || warn "docker compose up -d proxy failed"
        say "PostHog's own survey screens: open again"
    fi
}
lock_apply() {
    # 4. The lock: PostHog's own survey screens and API answer only Lens.
    if [ "${SURVEY_UI_LOCK:-on}" = off ]; then lock_off; return 0; fi
    if [ -z "${SURVEY_GATE:-}" ]; then warn "no POSTHOG_SURVEY_GATE yet (run key.sh): PostHog's survey screens stay open"; lock_off; return 0; fi
    pcid="$(docker compose ps -q proxy 2>/dev/null | head -1)"
    pimage="$( [ -n "$pcid" ] && docker inspect -f '{{.Config.Image}}' "$pcid" 2>/dev/null)"
    [ -n "$pimage" ] || { warn "PostHog's proxy is not running; survey lock not applied"; return 0; }
    # PostHog's own Caddyfile (every compose file but the lock), with Lens's rules first in the site block.
    if ! SURVEY_GATE="$SURVEY_GATE" LENS_URL="${LENS_URL:-}" LOCK="$LOCK" python3 - > "$LOCK.caddy" 2>"$OUT/lock.log" <<'PY'; then
import json, os, re, subprocess
env = dict(line.split('=', 1) for line in open('.env').read().splitlines() if '=' in line and not line.startswith('#'))
files = [f for f in env.get('COMPOSE_FILE', '').strip().strip('"').split(':') if f and f != os.environ['LOCK']] or ['docker-compose.yml']
cmd = ['docker', 'compose'] + sum([['-f', f] for f in files], []) + ['config', '--format', 'json']
caddy = json.loads(subprocess.check_output(cmd, stderr=subprocess.DEVNULL))['services']['proxy']['environment']['CADDYFILE']
gate, lens = os.environ['SURVEY_GATE'], os.environ['LENS_URL'].rstrip('/')
if not re.fullmatch(r'[0-9a-f]{32,64}', gate): raise SystemExit('the gate must be hex')
if lens and not re.fullmatch(r'https?://[^\s`"{}]+', lens): raise SystemExit('LENS_URL is not a plain address')
lines = caddy.split('\n')
site = next(i for i, l in enumerate(lines) if re.match(r'^\S.*\{\s*$', l) and l.strip() != '{')
where = f'{lens}/replays/surveys' if lens else 'Lens'
block = f'''    # Lens: in-app surveys are managed only in Lens. Survey API calls need Lens's gate header.
    @lens_surveys_api {{
        path /api/projects/*/surveys /api/projects/*/surveys/* /api/environments/*/surveys /api/environments/*/surveys/*
        not header X-Lens-Survey-Gate {gate}
    }}
    handle @lens_surveys_api {{
        header Content-Type application/json
        respond `{{"type":"authentication_error","code":"lens_only","detail":"Surveys are managed in Lens: {where}"}}` 403
    }}'''
if lens:
    block += f'''
    @lens_surveys_screen path /project/*/surveys /project/*/surveys/*
    handle @lens_surveys_screen {{
        redir {lens}/replays/surveys 302
    }}'''
lines[site + 1:site + 1] = block.split('\n')
print('\n'.join(lines))
PY
        warn "could not build the survey lock ($(tail -1 "$OUT/lock.log")): PostHog's survey screens stay as they are"; rm -f "$LOCK.caddy"; return 0
    fi
    # Caddy checks it before PostHog's proxy ever sees it.
    if ! docker run --rm -i --entrypoint sh "$pimage" -c 'cat > /tmp/Caddyfile && caddy validate --config /tmp/Caddyfile --adapter caddyfile' < "$LOCK.caddy" >"$OUT/lock.log" 2>&1; then
        warn "Caddy refused the survey lock ($(grep -i error "$OUT/lock.log" | tail -1)): PostHog's survey screens stay as they are"; rm -f "$LOCK.caddy"; return 0
    fi
    python3 - "$LOCK.caddy" > "$LOCK.tmp" <<'PY'
import sys
text = open(sys.argv[1]).read().replace('$', '$$')  # compose interpolates $
print('# Lens survey lock (deploy/posthog/survey-engine/apply.sh): PostHog\'s own Caddyfile with Lens\'s rules.')
print('# Survey API calls need Lens\'s gate header; the Surveys screen goes to Lens. Remove: SURVEY_UI_LOCK=off apply.sh')
print('services:\n    proxy:\n        environment:\n            CADDYFILE: |')
for line in text.split('\n'): print('                ' + line if line else '')
PY
    rm -f "$LOCK.caddy"
    chmod 600 "$LOCK.tmp"
    if cmp -s "$LOCK.tmp" "$LOCK" 2>/dev/null && grep -qE "^COMPOSE_FILE=.*$LOCK" .env; then rm -f "$LOCK.tmp"; say "PostHog's own survey screens: closed (Lens only)"; return 0; fi
    had=0; [ -f "$LOCK" ] && cp "$LOCK" "$LOCK.bak" && had=1
    mv "$LOCK.tmp" "$LOCK"
    grep -qE "^COMPOSE_FILE=.*$LOCK" .env && grep -qE "^EXTRA_COMPOSE_FILES=.*$LOCK" .env || compose_list add "$LOCK" || { warn "could not add $LOCK to COMPOSE_FILE"; rm -f "$LOCK"; return 0; }
    docker compose up -d --no-deps proxy >/dev/null 2>&1
    # The proxy answers the lock itself (no PostHog web needed): a survey call without the gate gets 403.
    ok=0
    for _ in $(seq 1 30); do
        body="$(curl -s -m 3 http://127.0.0.1/api/projects/@current/surveys/ 2>/dev/null; curl -sk -m 3 https://127.0.0.1/api/projects/@current/surveys/ 2>/dev/null)"
        case "$body" in *lens_only*) ok=1; break ;; esac
        sleep 2
    done
    if [ "$ok" = 1 ]; then rm -f "$LOCK.bak"; say "PostHog's own survey screens: closed (Lens only)"; return 0; fi
    warn "PostHog's proxy did not answer with the survey lock: undoing it"
    if [ "$had" = 1 ]; then mv "$LOCK.bak" "$LOCK"; else compose_list remove "$LOCK"; rm -f "$LOCK"; fi
    docker compose up -d --no-deps proxy >/dev/null 2>&1
    return 0
}

if [ "$REMOVE" = 1 ]; then remove; lock_off; exit 0; fi

# 1. The original file, from PostHog's web image (the running container shows ours once it is mounted).
cid="$(docker compose ps -q web 2>/dev/null | head -1)"
image="$( [ -n "$cid" ] && docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null)"
[ -n "$image" ] || { warn "PostHog's web service is not running; survey engine not applied"; lock_apply; exit 0; }
mkdir -p "$OUT/new"
if ! docker run --rm --entrypoint cat "$image" /code/staticfiles/surveys.js > "$OUT/surveys.original.js" 2>/dev/null || [ ! -s "$OUT/surveys.original.js" ]; then
    warn "could not read surveys.js from $image; survey engine not applied"; remove; lock_apply; exit 0
fi

# 2. Build (node on this machine, or the Lens image's node).
if command -v node >/dev/null 2>&1; then
    node "$HERE/build.mjs" "$OUT/surveys.original.js" "$OUT/new" "$BRAND" >"$OUT/build.log" 2>&1
else
    docker run --rm --user 0 -v "$HERE:/engine:ro" -v "$OUT:/out" --entrypoint node "$LENS_IMAGE" /engine/build.mjs /out/surveys.original.js /out/new "$BRAND" >"$OUT/build.log" 2>&1
fi
if [ $? -ne 0 ] || [ ! -s "$OUT/new/surveys.js" ]; then
    warn "survey engine build refused ($(tail -1 "$OUT/build.log")): serving PostHog's original survey renderer"
    remove; lock_apply; exit 0
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
    compose_list add || { warn "could not add $OVERRIDE to COMPOSE_FILE; serving PostHog's original survey renderer"; rm -f "$OVERRIDE"; lock_apply; exit 0; }
    [ "$in_compose" = 0 ] && changed=1
fi
# Mounted already? A running web container started before the override has no such mount.
docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "$cid" 2>/dev/null | grep -q /code/staticfiles/surveys.js || changed=1
if [ "$changed" = 1 ]; then restart_web; fi
say "survey renderer: \"$BRAND\" footer and Lens chains ($(python3 -c "import json;print(json.load(open('$OUT/manifest.json'))['output_sha256'][:12])" 2>/dev/null))"
lock_apply
exit 0
