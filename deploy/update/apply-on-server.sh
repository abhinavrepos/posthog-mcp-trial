#!/usr/bin/env bash
# Apply a Signal update copied from a laptop (signal-code.tar.gz + signal-image.tar.gz in $HOME).
# Keeps a rollback copy, swaps code and image, removes the former Signal survey engine from PostHog,
# gives the survey key the feature-flag scope native targeting needs, and restarts Signal.
#   sudo -E bash ~/signal-apply.sh        (or from the extracted code: sudo -E bash ~/posthog-lens/deploy/update/apply-on-server.sh)
# Settings: LENS_DIR [~/posthog-lens], POSTHOG_DIR [~/posthog-sept], FILES [~]
set -euo pipefail
U="${SUDO_USER:-$USER}"; H="$(getent passwd "$U" | cut -d: -f6)"
LENS_DIR="${LENS_DIR:-$H/posthog-lens}"; POSTHOG_DIR="${POSTHOG_DIR:-$H/posthog-sept}"; FILES="${FILES:-$H}"
CODE="$FILES/signal-code.tar.gz"; IMAGE="$FILES/signal-image.tar.gz"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
for f in "$CODE" "$IMAGE"; do [ -s "$f" ] || { echo "missing $f"; exit 1; }; gzip -t "$f" || { echo "$f is damaged: copy it again"; exit 1; }; done
echo "== checksums (compare with the laptop)"; sha256sum "$CODE" "$IMAGE"

stamp=$(date +%Y%m%d-%H%M)
echo "== rollback copy: image posthog-lens:before-$stamp, folder $LENS_DIR.before-$stamp"
docker tag posthog-lens:current "posthog-lens:before-$stamp"
cp -a "$LENS_DIR" "$LENS_DIR.before-$stamp"

echo "== new code"
tar -xzf "$CODE" -C "$LENS_DIR"
# Files the new version no longer has (the survey engine): remove only those, nothing of yours.
rm -f "$LENS_DIR"/deploy/posthog/survey-engine/{engine.js,bootstrap.js,build.mjs}
rm -rf "$LENS_DIR"/deploy/posthog/survey-engine/{fixtures,stress}

echo "== new image"
gunzip -c "$IMAGE" | docker load

echo "== PostHog: remove Signal's former survey renderer and survey-screen lock (PostHog's own files come back)"
bash "$LENS_DIR/deploy/posthog/survey-engine/apply.sh" --remove "$POSTHOG_DIR"
SECRETS="$LENS_DIR/.secrets.env"
if [ -f "$SECRETS" ]; then
    sed -i -e '/^POSTHOG_SURVEY_GATE=/d' -e '/^SURVEY_BRAND=/d' -e '/^SURVEY_ENGINE=/d' -e '/^SURVEY_EARLY_CAPTURE=/d' -e '/^SURVEY_UI_LOCK=/d' "$SECRETS"
    echo "== survey key: add the feature-flag scope native targeting needs"
    (cd "$LENS_DIR/deploy/posthog/survey-engine" && SECRETS="$SECRETS" POSTHOG_DIR="$POSTHOG_DIR" bash key.sh --ensure-scope) \
        || echo "! could not update the survey key; surveys that target clients may fail to save. Re-run this script."
fi

echo "== restart Signal (it migrates former Signal surveys to native PostHog conditions on start)"
posthog-lens restart
sleep 20
posthog-lens status | head -6
echo
echo "Rollback: sudo docker tag posthog-lens:before-$stamp posthog-lens:current && sudo rm -rf $LENS_DIR && sudo mv $LENS_DIR.before-$stamp $LENS_DIR && sudo posthog-lens restart"
