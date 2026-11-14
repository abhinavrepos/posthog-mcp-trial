#!/usr/bin/env bash
# For a machine with no internet: makes every call PostHog, its MCP server or this service would make
# to the internet fail at once, instead of hanging on DNS or a connection that never answers.
#
#   sudo deploy/offline/no-internet.sh apply     # set it up (again): safe to run any number of times
#   sudo deploy/offline/no-internet.sh check     # prove it: outside calls fail fast, inside ones work
#   sudo deploy/offline/no-internet.sh status
#   sudo deploy/offline/no-internet.sh remove    # undo all of it
#
# deploy/install.sh runs "apply" by itself when the machine cannot reach the internet (NO_INTERNET=auto),
# on a fresh install and on an upgrade; deploy/migrate/posthog-upgrade.sh runs it again after an upgrade
# when it was set up before.
#
# Three layers, so known and unknown calls both fail fast:
#   1. Known names. The hosts PostHog and these tools call by themselves (its usage reporting, billing,
#      GeoIP downloads, GitHub, npm...) point to 0.0.0.0 in /etc/hosts and inside every PostHog
#      container (docker-compose.no-internet.yml). A connection to 0.0.0.0 is refused at once, and no
#      DNS lookup happens.
#   2. PostHog's own switches: usage reporting off (OPT_OUT_CAPTURE), billing pointed at a closed port.
#   3. A firewall for everything else. Containers (DOCKER-USER chain) and this service's user (OUTPUT,
#      owner match) get an immediate "connection refused" for any public address. Private networks
#      (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16) and ALLOW_CIDRS stay open. The machine's own
#      traffic (docker pulling images from ECR, dnf through the S3 endpoint, SSM) is not touched.
#      A systemd unit puts the rules back after a reboot or a docker restart.
#
# Settings (environment):
#   POSTHOG_DIR     the PostHog install                                             [/opt/posthog]
#   ALLOW_CIDRS     public addresses that must stay reachable, comma-separated, e.g. an in-house
#                   Jira or mail server on a public IP: 203.0.113.10/32,198.51.100.0/24       [none]
#   EXTRA_HOSTS     more names to point at 0.0.0.0, comma-separated                          [none]
#   SERVICE_USER    the user this service runs as                                         [triage]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
POSTHOG_DIR="${POSTHOG_DIR:-/opt/posthog}"
SERVICE_USER="${SERVICE_USER:-triage}"
OVERRIDE=docker-compose.no-internet.yml
CHAIN=LENS-NO-INTERNET
UNIT=/etc/systemd/system/posthog-no-internet.service
MARK_BEGIN='# >>> posthog-lens no-internet (deploy/offline/no-internet.sh) >>>'
MARK_END='# <<< posthog-lens no-internet <<<'
PRIVATE=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4)

# The names PostHog, its MCP server and these tools reach for on their own. Seen on a running install
# (us.i.posthog.com every few minutes) or in the code and the install scripts.
HOSTS=(
    us.i.posthog.com eu.i.posthog.com app.posthog.com us.posthog.com eu.posthog.com posthog.com www.posthog.com
    us-assets.i.posthog.com eu-assets.i.posthog.com internal-t.posthog.com t.posthog.com webhooks.us.posthog.com
    billing.posthog.com license.posthog.com update.posthog.com mmdbcdn.posthog.net
    sentry.io o1.ingest.sentry.io o4504440325554176.ingest.sentry.io
    github.com api.github.com raw.githubusercontent.com objects.githubusercontent.com codeload.github.com
    registry.npmjs.org registry.yarnpkg.com pypi.org files.pythonhosted.org
    api.anthropic.com api.openai.com
    api.ipify.org checkip.amazonaws.com
    www.gravatar.com gravatar.com fonts.googleapis.com fonts.gstatic.com cdn.jsdelivr.net unpkg.com
    acme-v02.api.letsencrypt.org acme-staging-v02.api.letsencrypt.org
)

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }
need_root() { [ "$(id -u)" = 0 ] || die "Run as root (sudo)."; }
csv() { tr ',' '\n' <<<"${1:-}" | sed 's/^ *//;s/ *$//' | grep -v '^$' || true; }
all_hosts() { printf '%s\n' "${HOSTS[@]}"; csv "${EXTRA_HOSTS:-}"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ 1. names
hosts_file() {
    local tmp; tmp="$(mktemp)"
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' /etc/hosts >"$tmp"
    if [ "${1:-}" = add ]; then
        { echo "$MARK_BEGIN"; all_hosts | sort -u | while read -r h; do printf '0.0.0.0 %s\n:: %s\n' "$h" "$h"; done; echo "$MARK_END"; } >>"$tmp"
    fi
    cat "$tmp" >/etc/hosts # keeps the file's owner, mode and any bind mount
    rm -f "$tmp"
}

envget() { grep -E "^$1=" "$POSTHOG_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
envset() {
    if grep -qE "^$1=" "$POSTHOG_DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$POSTHOG_DIR/.env"; else echo "$1=$2" >>"$POSTHOG_DIR/.env"; fi
}
# Adds or removes our file in COMPOSE_FILE, and in EXTRA_COMPOSE_FILES so scale.sh and
# posthog-upgrade.sh keep it when they rewrite the list.
compose_list() {
    local op="$1" files extra
    files="$(envget COMPOSE_FILE)"; extra="$(envget EXTRA_COMPOSE_FILES)"
    [ -n "$files" ] || files="docker-compose.yml$([ -f "$POSTHOG_DIR/docker-compose.override.yml" ] && echo ':docker-compose.override.yml')"
    files="$(tr ':' '\n' <<<"$files" | grep -vx "$OVERRIDE" | paste -sd:)"
    extra="$(tr ':' '\n' <<<"$extra" | grep -v '^$' | grep -vx "$OVERRIDE" | paste -sd: || true)"
    if [ "$op" = add ]; then files="$files:$OVERRIDE"; extra="${extra:+$extra:}$OVERRIDE"; fi
    envset COMPOSE_FILE "$files"
    if [ -n "$extra" ]; then envset EXTRA_COMPOSE_FILES "$extra"; else sed -i '/^EXTRA_COMPOSE_FILES=/d' "$POSTHOG_DIR/.env"; fi
}

compose_override() {
    [ -f "$POSTHOG_DIR/docker-compose.yml" ] || { echo "    no PostHog in $POSTHOG_DIR: skipped the containers"; return; }
    cd "$POSTHOG_DIR"
    compose_list remove # list the services without our file, so a stale one cannot break this
    local services; services="$(docker compose config --services 2>/dev/null)" || die "docker compose config failed in $POSTHOG_DIR"
    {
        echo "# Written by deploy/offline/no-internet.sh: outside names point at 0.0.0.0 in every container, and"
        echo "# PostHog's own usage reporting and billing calls are switched off. Run it again after PostHog changes."
        echo "x-no-internet-hosts: &hosts"
        all_hosts | sort -u | while read -r h; do echo "    - \"$h:0.0.0.0\""; done
        echo "services:"
        for s in $services; do
            echo "    $s:"
            echo "        extra_hosts: *hosts"
            case "$s" in
                web | worker | temporal-django-worker | asyncmigrationscheck | migrate | plugins | plugins-cdp-worker)
                    echo "        environment:"
                    echo "            OPT_OUT_CAPTURE: '1'"
                    echo "            BILLING_SERVICE_URL: http://0.0.0.0:9"
                    ;;
            esac
        done
    } >"$OVERRIDE.new"
    mv "$OVERRIDE.new" "$OVERRIDE"
    compose_list add
    docker compose config -q || die "the compose files do not merge; see $POSTHOG_DIR/$OVERRIDE"
    echo "    $OVERRIDE: $(wc -w <<<"$services") services"
}

# The PostHog MCP server is its own compose project on PostHog's network. The firewall covers it; the
# names go in its folder's docker-compose.override.yml, which compose reads by itself.
MCP_OVERRIDE="$HERE/../posthog-mcp/docker-compose.override.yml"
mcp_override() {
    [ -f "$HERE/../posthog-mcp/docker-compose.yml" ] || return 0
    { echo "# Written by deploy/offline/no-internet.sh (remove undoes it)."; echo "services:"; echo "    posthog-mcp:"; echo "        extra_hosts:"; all_hosts | sort -u | while read -r h; do echo "            - \"$h:0.0.0.0\""; done; } >"$MCP_OVERRIDE"
}

# ------------------------------------------------------------------ 3. firewall
ipt() { iptables -w "$@"; }
firewall() {
    have iptables || { echo "    iptables is missing: only the names are blocked"; return; }
    ipt -N "$CHAIN" 2>/dev/null || ipt -F "$CHAIN"
    ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    for c in "${PRIVATE[@]}"; do ipt -A "$CHAIN" -d "$c" -j RETURN; done
    while read -r c; do [ -n "$c" ] && ipt -A "$CHAIN" -d "$c" -j RETURN; done < <(csv "${ALLOW_CIDRS:-}")
    # The machine's own addresses, so the service still reaches PostHog when its address is public.
    for c in $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' || true); do ipt -A "$CHAIN" -d "$c/32" -j RETURN; done
    ipt -A "$CHAIN" -p tcp -j REJECT --reject-with tcp-reset
    ipt -A "$CHAIN" -j REJECT --reject-with icmp-port-unreachable
    # Containers: only traffic leaving a docker network (bridge interfaces), so published ports and
    # replies to the machine's own connections are not touched.
    ipt -N DOCKER-USER 2>/dev/null || true
    for i in docker0 'br-+'; do
        ipt -C DOCKER-USER -i "$i" -j "$CHAIN" 2>/dev/null || ipt -I DOCKER-USER 1 -i "$i" -j "$CHAIN"
    done
    # This service (and the Chrome it starts for clips) runs as SERVICE_USER.
    if id "$SERVICE_USER" >/dev/null 2>&1; then
        ipt -C OUTPUT -m owner --uid-owner "$SERVICE_USER" -j "$CHAIN" 2>/dev/null || ipt -I OUTPUT 1 -m owner --uid-owner "$SERVICE_USER" -j "$CHAIN"
    fi
    if have ip6tables && ip6tables -w -L >/dev/null 2>&1; then
        ip6tables -w -N "$CHAIN" 2>/dev/null || ip6tables -w -F "$CHAIN"
        ip6tables -w -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
        for c in ::1/128 fc00::/7 fe80::/10 ff00::/8; do ip6tables -w -A "$CHAIN" -d "$c" -j RETURN; done
        ip6tables -w -A "$CHAIN" -p tcp -j REJECT --reject-with tcp-reset
        ip6tables -w -A "$CHAIN" -j REJECT
        if id "$SERVICE_USER" >/dev/null 2>&1; then
            ip6tables -w -C OUTPUT -m owner --uid-owner "$SERVICE_USER" -j "$CHAIN" 2>/dev/null || ip6tables -w -I OUTPUT 1 -m owner --uid-owner "$SERVICE_USER" -j "$CHAIN"
        fi
        if ip6tables -w -L DOCKER-USER >/dev/null 2>&1; then
            for i in docker0 'br-+'; do ip6tables -w -C DOCKER-USER -i "$i" -j "$CHAIN" 2>/dev/null || ip6tables -w -I DOCKER-USER 1 -i "$i" -j "$CHAIN"; done
        fi
    fi
    echo "    firewall: public addresses refused for containers and for $SERVICE_USER${ALLOW_CIDRS:+ (allowed: $ALLOW_CIDRS)}"
}

firewall_off() {
    have iptables || return 0
    for t in iptables ip6tables; do
        have "$t" || continue
        for i in docker0 'br-+'; do while $t -w -C DOCKER-USER -i "$i" -j "$CHAIN" 2>/dev/null; do $t -w -D DOCKER-USER -i "$i" -j "$CHAIN"; done; done
        while $t -w -C OUTPUT -m owner --uid-owner "$SERVICE_USER" -j "$CHAIN" 2>/dev/null; do $t -w -D OUTPUT -m owner --uid-owner "$SERVICE_USER" -j "$CHAIN"; done
        $t -w -F "$CHAIN" 2>/dev/null || true
        $t -w -X "$CHAIN" 2>/dev/null || true
    done
}

# The rules live in memory: this unit puts them back at boot and whenever docker restarts (docker
# rebuilds its own chains then).
# Quote one systemd argument, including specifiers and environment expansion.
systemd_arg() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//%/%%}"
    value="${value//\$/\$\$}"
    value="${value//$'\n'/\\n}"
    value="${value//$'\t'/\\t}"
    printf '"%s"' "$value"
}

unit() {
    have systemctl || return 0
    local env=""
    [ -n "${ALLOW_CIDRS:-}" ] && env+="Environment=ALLOW_CIDRS=${ALLOW_CIDRS}"$'\n'
    env+="Environment=SERVICE_USER=${SERVICE_USER}"$'\n'
    cat >"$UNIT" <<EOF
[Unit]
Description=Refuse internet connections from PostHog's containers and PostHog Lens (no-internet machine)
After=docker.service network-online.target
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
${env}ExecStart=$(systemd_arg "$HERE/no-internet.sh") firewall

[Install]
WantedBy=multi-user.target docker.service
EOF
    systemctl daemon-reload
    systemctl enable -q posthog-no-internet.service
}

# ------------------------------------------------------------------ check
# Each outside call must fail within a second or two; each inside call must still work.
check() {
    local bad=0 t0 t1 ms out
    timed() { t0=$(date +%s%N); out="$("$@" 2>&1)"; local rc=$?; t1=$(date +%s%N); ms=$(((t1 - t0) / 1000000)); return $rc; }
    expect_fast_fail() {
        local what="$1"; shift
        if timed "$@"; then echo "  FAIL  $what: it connected"; bad=1
        elif [ "$ms" -gt 3000 ]; then echo "  FAIL  $what: failed, but only after ${ms} ms"; bad=1
        else echo "  ok    $what: refused in ${ms} ms"; fi
    }
    expect_ok() {
        local what="$1"; shift
        if timed "$@"; then echo "  ok    $what (${ms} ms)"; else echo "  FAIL  $what: $out"; bad=1; fi
    }
    say "From this machine, as $SERVICE_USER (the service's own calls)"
    if id "$SERVICE_USER" >/dev/null 2>&1; then
        expect_fast_fail "known name: https://us.i.posthog.com" runuser -u "$SERVICE_USER" -- curl -sS -o /dev/null -m 20 https://us.i.posthog.com/
        expect_fast_fail "any public address: https://1.1.1.1" runuser -u "$SERVICE_USER" -- curl -sS -o /dev/null -m 20 https://1.1.1.1/
        expect_ok "PostHog on this machine" runuser -u "$SERVICE_USER" -- curl -fsS -o /dev/null -m 10 http://localhost/_health
    else
        echo "  (no user $SERVICE_USER)"
    fi
    if [ -f "$POSTHOG_DIR/docker-compose.yml" ]; then
        say "From inside PostHog (the web container)"
        # Any HTTP answer, even an error page, means the connection was made.
        local py='import sys,urllib.request,urllib.error
try:
    urllib.request.urlopen(sys.argv[1], timeout=20)
except urllib.error.HTTPError:
    pass
except Exception as e:
    print(type(e).__name__, e); sys.exit(1)'
        cd "$POSTHOG_DIR"
        expect_fast_fail "PostHog's usage reporting: https://us.i.posthog.com" docker compose exec -T web python -c "$py" https://us.i.posthog.com/
        expect_fast_fail "GeoIP download: https://mmdbcdn.posthog.net" docker compose exec -T web python -c "$py" https://mmdbcdn.posthog.net/
        expect_fast_fail "any public address: https://1.1.1.1" docker compose exec -T web python -c "$py" https://1.1.1.1/
        expect_ok "another PostHog container (http://clickhouse:8123/ping)" docker compose exec -T web python -c "$py" http://clickhouse:8123/ping
        expect_ok "usage reporting switched off (OPT_OUT_CAPTURE)" docker compose exec -T web sh -c '[ "$OPT_OUT_CAPTURE" = 1 ]'
    fi
    [ "$bad" = 0 ] && echo "All good: outside calls are refused at once, inside ones work." || { echo "Some checks failed (above)."; return 1; }
}

status() {
    echo "/etc/hosts:      $(grep -c '^0.0.0.0 ' <(awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{on=1;next} $0==e{on=0} on' /etc/hosts)) names point at 0.0.0.0"
    echo "containers:      $([ -f "$POSTHOG_DIR/$OVERRIDE" ] && echo "$OVERRIDE in COMPOSE_FILE: $(tr ':' '\n' <<<"$(envget COMPOSE_FILE)" | grep -cx "$OVERRIDE") time(s)" || echo "no $OVERRIDE")"
    echo "firewall:        $(have iptables && iptables -w -L "$CHAIN" -n 2>/dev/null | grep -c REJECT || echo 0) refuse rules; DOCKER-USER jumps: $(have iptables && iptables -w -S DOCKER-USER 2>/dev/null | grep -c "$CHAIN" || echo 0)"
    echo "boot unit:       $(have systemctl && systemctl is-enabled posthog-no-internet.service 2>/dev/null || echo none)"
}

recreate() {
    [ -f "$POSTHOG_DIR/docker-compose.yml" ] || return 0
    say "Recreating PostHog's containers with the new names and settings"
    (cd "$POSTHOG_DIR" && docker compose up -d --remove-orphans >/dev/null 2>&1) || die "docker compose up failed in $POSTHOG_DIR"
    local mcp="$HERE/../posthog-mcp"
    if docker ps --format '{{.Names}}' | grep -q posthog-mcp; then
        (cd "$mcp" && bash ./up.sh >/dev/null 2>&1) || echo "    the PostHog MCP server did not restart: cd $mcp && ./up.sh"
    fi
}

case "${1:-}" in
    apply)
        need_root
        say "Pointing outside names at 0.0.0.0"
        hosts_file add
        echo "    /etc/hosts: $(all_hosts | sort -u | wc -l) names"
        compose_override
        mcp_override
        say "Firewall"
        firewall
        unit
        [ "${2:-}" = --no-restart ] || recreate
        say "Done. Prove it with: sudo $0 check"
        ;;
    firewall) need_root; firewall ;; # what the boot unit runs
    check) need_root; check ;;
    status) status ;;
    remove)
        need_root
        hosts_file remove
        firewall_off
        if have systemctl && [ -f "$UNIT" ]; then systemctl disable -q posthog-no-internet.service 2>/dev/null || true; rm -f "$UNIT"; systemctl daemon-reload; fi
        if [ -f "$POSTHOG_DIR/.env" ]; then (cd "$POSTHOG_DIR" && compose_list remove && rm -f "$OVERRIDE"); fi
        grep -q 'no-internet.sh' "$MCP_OVERRIDE" 2>/dev/null && rm -f "$MCP_OVERRIDE"
        [ "${2:-}" = --no-restart ] || recreate
        say "Removed: outside calls work again where there is internet."
        ;;
    *) sed -n '2,32p' "$0"; exit 2 ;;
esac
