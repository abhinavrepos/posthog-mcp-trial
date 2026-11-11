#!/bin/sh
# Transform the EFFECTIVE CADDYFILE, including the survey lock. Never duplicate its secret.
set -eu
block=${LENS_TUNE_CADDY_BLOCK:-/etc/lens-tuning/static.caddy}
render() {
    awk -v block="$block" '
        { print }
        !inserted && /^[^[:space:]{}#][^{]*\{[[:space:]]*$/ {
            while ((getline line < block) > 0) print line
            close(block)
            inserted=1
        }
        END { if (!inserted) exit 1 }
    '
}
if [ "${1:-}" = --render ]; then render; exit; fi
{ printf '%s\n' "$CADDYFILE" | render; printf '%s\n' "${CADDY_EXTRA_CONFIG:-}"; } > /etc/caddy/Caddyfile
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
