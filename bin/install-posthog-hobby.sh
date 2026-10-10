#!/usr/bin/env bash
#
# PostHog hobby installer for a single AWS EC2 instance.
# It asks one question: the address that PostHog will be served on.
#
#   sudo bash install-posthog-hobby.sh                       # prompts for the address
#   sudo bash install-posthog-hobby.sh posthog.example.com   # HTTPS with a Let's Encrypt certificate
#   sudo bash install-posthog-hobby.sh 10.0.1.25             # plain HTTP on an IP address, no TLS
#   sudo bash install-posthog-hobby.sh http://posthog.internal   # plain HTTP on a domain, no TLS
#
# Plain HTTP sends logins and data unencrypted. Use it only on a private network or VPN.
#
# Before you run it:
#   1. Instance: 4 vCPU / 16 GB RAM or more (t3.xlarge, m6i.xlarge, m7g.xlarge), 50 GB+ gp3 disk.
#      Ubuntu 22.04/24.04, Debian 12 or Amazon Linux 2023. x86_64 and arm64 both work.
#   2. Security group: allow inbound TCP 80 (and 443 for HTTPS) from your users, and 22 for SSH.
#   3. HTTPS only: an A record for your domain pointing at the instance's public IP
#      (attach an Elastic IP so it does not change on restart).
#
# Optional environment overrides (none of these prompt):
#   POSTHOG_APP_TAG       image tag to run (default: latest)
#   POSTHOG_INSTALL_DIR   install location (default: /opt/posthog)
#   ANTHROPIC_API_KEY     enables PostHog AI
#   OPENAI_API_KEY        enables SQL and regex AI assist
#   SKIP_CHECKS=1         skip the RAM and disk checks
#
# Re-running the script is safe: it keeps the existing .env (secrets) and data volumes.

set -euo pipefail

POSTHOG_APP_TAG="${POSTHOG_APP_TAG:-latest}"
INSTALL_DIR="${POSTHOG_INSTALL_DIR:-/opt/posthog}"
REPO_URL="https://github.com/PostHog/posthog.git"
COMPOSE_STANDALONE_VERSION="v2.33.1"
MIN_RAM_GB=7          # AWS reports an "8 GB" instance as about 7.6 GB.
SWAP_BELOW_RAM_GB=15  # Instances with less RAM than this get a 4 GB swap file.
MIN_FREE_DISK_GB=30
HEALTH_TIMEOUT_MIN=75 # A first boot runs ~700 migrations; 4 vCPUs took 35 minutes in testing.

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    BOLD=$'\e[1m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
    BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi
step() { echo; echo "${BOLD}==> $*${RESET}"; }
info() { echo "    $*"; }
ok()   { echo "    ${GREEN}✔${RESET} $*"; }
warn() { echo "    ${YELLOW}⚠ $*${RESET}"; }
die()  { echo; echo "${RED}✘ $*${RESET}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        if [ -f "$0" ]; then
            exec sudo -E bash "$0" "$@"
        fi
        die "Run this script as root: sudo bash install-posthog-hobby.sh"
    fi
}

detect_os() {
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="$ID"
    case "$OS_ID" in
        ubuntu|debian) PKG=apt ;;
        amzn)
            [[ "$VERSION_ID" == 2023* ]] || die "Amazon Linux $VERSION_ID is not supported. Use Amazon Linux 2023 or Ubuntu."
            PKG=dnf
            ;;
        *) die "Unsupported OS '$PRETTY_NAME'. Use Ubuntu 22.04/24.04, Debian 12 or Amazon Linux 2023." ;;
    esac
    case "$(uname -m)" in
        x86_64|aarch64) ;;
        *) die "Unsupported CPU architecture $(uname -m). Use an x86_64 or arm64 instance." ;;
    esac
    ok "OS: $PRETTY_NAME ($(uname -m))"
}

normalize_domain() {
    local d="$1"
    d="${d#*://}"   # drop scheme
    d="${d%%/*}"    # drop path
    d="${d%%:*}"    # drop port
    d="${d%.}"      # drop trailing dot
    echo "$d" | tr '[:upper:]' '[:lower:]'
}

is_ipv4() {
    local IFS=. octet
    # shellcheck disable=SC2206
    local parts=($1)
    [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    for octet in "${parts[@]}"; do
        [ "$((10#$octet))" -le 255 ] || return 1
    done
}

ask_domain() {
    local raw="${1:-}"
    if [ -z "$raw" ] && [ -f "$INSTALL_DIR/.env" ]; then
        raw="$(grep -E '^DOMAIN=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- || true)"
        if [ -n "$raw" ] && grep -qE '^HTTP_ONLY=1' "$INSTALL_DIR/.env"; then
            raw="http://$raw"
        fi
        [ -n "$raw" ] && info "Using the address from the existing install: $raw"
    fi
    while [ -z "$raw" ]; do
        echo
        echo "${BOLD}Which address will PostHog be hosted on?${RESET}"
        echo "  A domain such as posthog.example.com gets HTTPS. An IP address or http://… runs plain HTTP."
        read -r -p "> " raw </dev/tty || die "No address given."
    done
    DOMAIN="$(normalize_domain "$raw")"
    HTTP_ONLY=0
    if [[ "$raw" == http://* ]] || [[ "$DOMAIN" =~ ^[0-9.]+$ ]]; then
        HTTP_ONLY=1
    fi
    if [[ "$DOMAIN" =~ ^[0-9.]+$ ]]; then
        is_ipv4 "$DOMAIN" || die "'$DOMAIN' is not a valid IPv4 address."
    elif ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
        || { [ "$HTTP_ONLY" = 0 ] && ! [[ "$DOMAIN" =~ \.[a-z]{2,}$ ]]; }; then
        die "'$DOMAIN' does not look like a valid domain name."
    fi
    if [ "$HTTP_ONLY" = 1 ]; then
        SITE_URL="http://${DOMAIN}"
        ok "Address: $SITE_URL (plain HTTP, no TLS)"
        warn "Logins and data travel unencrypted. Only use this on a private network or VPN."
    else
        SITE_URL="https://${DOMAIN}"
        ok "Address: $SITE_URL"
    fi
}

check_resources() {
    local ram_kb ram_gb cpus free_gb
    ram_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    ram_gb=$(( ram_kb / 1024 / 1024 ))
    cpus=$(nproc)
    mkdir -p "$INSTALL_DIR"
    free_gb=$(( $(df -Pk "$INSTALL_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))

    info "RAM: ${ram_gb} GB, vCPUs: ${cpus}, free disk at $INSTALL_DIR: ${free_gb} GB"
    if [ "${SKIP_CHECKS:-0}" != "1" ]; then
        [ "$ram_gb" -ge "$MIN_RAM_GB" ] || die "PostHog needs at least 8 GB of RAM (16 GB recommended). Resize the instance, or set SKIP_CHECKS=1 to try anyway."
        [ "$free_gb" -ge "$MIN_FREE_DISK_GB" ] || die "PostHog needs at least ${MIN_FREE_DISK_GB} GB of free disk (the images alone are about 20 GB). Grow the EBS volume, or set SKIP_CHECKS=1."
    fi
    if [ "$cpus" -lt 4 ]; then
        warn "Only ${cpus} vCPUs. The first boot can take an hour or more. 4+ vCPUs is recommended."
    fi
    RAM_GB=$ram_gb
}

ensure_swap() {
    if [ "$RAM_GB" -ge "$SWAP_BELOW_RAM_GB" ]; then
        return
    fi
    if [ "$(awk '/SwapTotal/ {print $2}' /proc/meminfo)" -gt 0 ]; then
        ok "Swap already configured"
        return
    fi
    info "Adding a 4 GB swap file, so memory spikes during the first boot do not kill containers"
    if ! fallocate -l 4G /swapfile 2>/dev/null; then
        dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    fi
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "Swap enabled"
}

# ---------------------------------------------------------------------------
# Packages and Docker
# ---------------------------------------------------------------------------
install_packages() {
    if [ "$PKG" = apt ]; then
        apt-get update -qq
        apt-get install -y -qq ca-certificates curl git openssl brotli python3 gnupg >/dev/null
    else
        dnf install -y -q git openssl python3 tar >/dev/null
        dnf install -y -q brotli >/dev/null 2>&1 || warn "brotli is not available; the GeoIP database will be skipped"
    fi
    ok "Base packages installed"
}

install_docker() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        upgrade_amazon_linux_docker
        ok "Docker is already installed ($(docker --version | cut -d, -f1), $(docker compose version --short))"
        systemctl enable --now docker >/dev/null 2>&1 || true
        return
    fi

    info "Installing Docker"
    if [ "$PKG" = apt ]; then
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        # shellcheck disable=SC1091
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${OS_ID} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
            > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
    else
        # dnf is locked to the release the AMI shipped with. Take docker from the newest
        # release, so instances launched from an older AMI skip the broken build below.
        dnf install -y -q --releasever=latest docker >/dev/null
        local arch plugin_dir=/usr/local/lib/docker/cli-plugins
        arch="$(uname -m)"
        mkdir -p "$plugin_dir"
        curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_STANDALONE_VERSION}/docker-compose-linux-${arch}" \
            -o "$plugin_dir/docker-compose"
        chmod +x "$plugin_dir/docker-compose"
    fi
    systemctl enable --now docker >/dev/null
    docker compose version >/dev/null || die "Docker Compose did not install correctly."
    ok "Docker installed ($(docker --version | cut -d, -f1), compose $(docker compose version --short))"

    # Let the login user run docker without sudo.
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
        usermod -aG docker "$SUDO_USER" || true
    fi
}

# docker-25.0.16-1.amzn2023.0.1 rejects containers that join a second network with a false
# "route conflict" error, and several PostHog services do that. Later builds fix it.
upgrade_amazon_linux_docker() {
    [ "$PKG" = dnf ] && rpm -q docker >/dev/null 2>&1 || return 0
    local before after
    before="$(rpm -q docker)"
    dnf upgrade -y -q --releasever=latest docker >/dev/null 2>&1 || warn "Could not upgrade the docker package"
    after="$(rpm -q docker)"
    if [ "$before" != "$after" ]; then
        systemctl restart docker
        ok "Upgraded $before to $after"
    fi
}

# Docker Hub limits anonymous pulls per IP. If we hit that limit, add Google's public
# Docker Hub mirror. Docker still falls back to Docker Hub for anything the mirror lacks.
add_registry_mirror() {
    local cfg=/etc/docker/daemon.json
    python3 - "$cfg" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
cfg = json.loads(path.read_text()) if path.exists() and path.read_text().strip() else {}
mirrors = cfg.setdefault("registry-mirrors", [])
if "https://mirror.gcr.io" not in mirrors:
    mirrors.append("https://mirror.gcr.io")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(cfg, indent=2) + "\n")
PY
    systemctl restart docker
    ok "Added mirror.gcr.io as a Docker Hub mirror"
}

# ---------------------------------------------------------------------------
# PostHog files
# ---------------------------------------------------------------------------
fetch_posthog_repo() {
    cd "$INSTALL_DIR"
    # The compose files must match the images: use master for "latest", or the exact commit.
    local ref=master
    [[ "$POSTHOG_APP_TAG" =~ ^[0-9a-f]{40}$ ]] && ref="$POSTHOG_APP_TAG"
    if [ ! -d posthog/.git ]; then
        info "Downloading PostHog's compose files from GitHub"
        rm -rf posthog
        git init -q posthog
        git -C posthog remote add origin "$REPO_URL"
    else
        info "Updating the existing PostHog checkout"
    fi
    git -C posthog fetch --depth 1 -q origin "$ref"
    git -C posthog checkout -q --force FETCH_HEAD
    ok "PostHog source at commit $(git -C posthog rev-parse --short HEAD)"
}

# Docker Compose fills ${CADDY_HOST} into the Caddyfile from .env when it reads the compose
# file. Without it, Caddy falls back to localhost:8000 and nothing answers on port 80 or 443.
caddy_host() {
    if [ "$HTTP_ONLY" = 1 ]; then
        echo "http://"
    else
        echo "${DOMAIN}, http://, https://"
    fi
}

set_env_value() {
    if grep -q "^$1=" .env; then
        sed -i -E "s|^$1=.*|$1=$2|" .env
    else
        echo "$1=$2" >> .env
    fi
}

write_env() {
    cd "$INSTALL_DIR"
    if [ -f .env ]; then
        # Never regenerate secrets: that logs everyone out and breaks encrypted data.
        set_env_value DOMAIN "${DOMAIN}"
        set_env_value HTTP_ONLY "${HTTP_ONLY}"
        set_env_value CADDY_HOST "\"$(caddy_host)\""
        ok "Kept the existing .env (secrets unchanged)"
        return
    fi
    umask 077
    cat > .env <<EOF
POSTHOG_SECRET=$(openssl rand -hex 28)
ENCRYPTION_SALT_KEYS=$(openssl rand -hex 16)
BROWSERLESS_SECRET=$(openssl rand -hex 32)
DOMAIN=${DOMAIN}
HTTP_ONLY=${HTTP_ONLY}
TLS_BLOCK=
CADDY_TLS_BLOCK=
CADDY_HOST="$(caddy_host)"
REGISTRY_URL=posthog/posthog
POSTHOG_APP_TAG=${POSTHOG_APP_TAG}
EOF
    [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> .env
    [ -n "${OPENAI_API_KEY:-}" ] && echo "OPENAI_API_KEY=${OPENAI_API_KEY}" >> .env
    umask 022
    ok "Generated .env with fresh secrets (back up $INSTALL_DIR/.env)"
}

write_compose_files() {
    cd "$INSTALL_DIR"
    cp posthog/docker-compose.base.yml docker-compose.base.yml
    cp posthog/docker-compose.hobby.yml docker-compose.yml
    cp posthog/.env.services .env.services
    # Caddy is the only way into the web container, and it replaces any X-Forwarded-For
    # header a client sends. So trusting the proxy chain is safe, and PostHog sees real
    # visitor IPs instead of Caddy's Docker address.
    printf '\n# Added by install-posthog-hobby.sh\nTRUST_ALL_PROXIES=true\n' >> .env.services

    write_http_only_override

    mkdir -p compose share
    # The compose directory is mounted at /compose, so call the helper by its absolute path.
    cat > compose/start <<'EOF'
#!/bin/bash
/compose/wait
./bin/migrate
./bin/docker-server
EOF
    cat > compose/temporal-django-worker <<'EOF'
#!/bin/bash
./bin/temporal-django-worker
EOF
    cat > compose/wait <<'EOF'
#!/usr/bin/env python3
import socket
import time

SERVICES = [("clickhouse", 9000), ("db", 5432)]
DEADLINE = time.monotonic() + 600

for host, port in SERVICES:
    print(f"Waiting for {host}:{port}", flush=True)
    while True:
        try:
            with socket.create_connection((host, port), timeout=3):
                print(f"{host} is ready", flush=True)
                break
        except OSError:
            if time.monotonic() > DEADLINE:
                print(f"{host} is still not reachable, continuing so the migration retries can take over", flush=True)
                break
            time.sleep(3)
EOF
    chmod +x compose/start compose/temporal-django-worker compose/wait
    ok "Compose files written"
}

# docker-compose.hobby.yml hardcodes https:// URLs and a Caddy site with TLS. Docker Compose
# merges docker-compose.override.yml on top automatically, so plain HTTP lives there.
write_http_only_override() {
    if [ "$HTTP_ONLY" != 1 ]; then
        rm -f docker-compose.override.yml
        return
    fi
    # Without this, Django marks cookies HTTPS-only and redirects to https://, so login fails.
    printf 'SECURE_COOKIES=false\n' >> .env.services
    cat > docker-compose.override.yml <<EOF
# Written by install-posthog-hobby.sh for plain HTTP. Remove it and re-run the script for HTTPS.
services:
    web:
        environment:
            SITE_URL: ${SITE_URL}
            LIVESTREAM_HOST: ${SITE_URL}/livestream
            OBJECT_STORAGE_PUBLIC_ENDPOINT: ${SITE_URL}
    worker:
        environment:
            SITE_URL: ${SITE_URL}
            OBJECT_STORAGE_PUBLIC_ENDPOINT: ${SITE_URL}
    plugins:
        environment:
            SITE_URL: ${SITE_URL}
            OBJECT_STORAGE_PUBLIC_ENDPOINT: ${SITE_URL}
    asyncmigrationscheck:
        environment:
            SITE_URL: ${SITE_URL}
    temporal-django-worker:
        environment:
            SITE_URL: ${SITE_URL}
EOF
}

download_geoip() {
    cd "$INSTALL_DIR"
    if [ -s share/GeoLite2-City.mmdb ]; then
        ok "GeoIP database already present"
        return
    fi
    if ! command -v brotli >/dev/null 2>&1; then
        warn "Skipping the GeoIP database (brotli is missing). Events will not get a location."
        return
    fi
    if curl -fsSL --http1.1 --retry 3 'https://mmdbcdn.posthog.net/' | brotli --decompress > share/GeoLite2-City.mmdb.tmp \
        && [ -s share/GeoLite2-City.mmdb.tmp ]; then
        mv share/GeoLite2-City.mmdb.tmp share/GeoLite2-City.mmdb
        echo "{\"date\": \"$(date +%Y-%m-%d)\"}" > share/GeoLite2-City.json
        chmod 644 share/GeoLite2-City.mmdb share/GeoLite2-City.json
        ok "GeoIP database downloaded"
    else
        rm -f share/GeoLite2-City.mmdb.tmp
        warn "Could not download the GeoIP database. Events will not get a location."
    fi
}

# ---------------------------------------------------------------------------
# Network checks (warnings only, so the install never stops here)
# ---------------------------------------------------------------------------
public_ip() {
    local token ip
    token=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
        -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
    if [ -n "$token" ]; then
        ip=$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" \
            http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
    fi
    [ -z "${ip:-}" ] && ip=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
    echo "${ip:-}"
}

check_ip_address() {
    local addrs
    addrs=" $(hostname -I 2>/dev/null || true) $(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | paste -sd' ' || true) "
    if [[ "$addrs" == *" $DOMAIN "* ]]; then
        ok "$DOMAIN is an address of this machine (private network)"
    elif [ "$DOMAIN" = "$(public_ip)" ]; then
        ok "$DOMAIN is this instance's public IP"
    else
        warn "$DOMAIN is not an address of this machine. Check that it reaches this instance."
    fi
    info "Reminder: the security group must allow inbound TCP 80 from the machines that will use PostHog."
}

check_dns() {
    local my_ip dns_ips
    if [[ "$DOMAIN" =~ ^[0-9.]+$ ]]; then
        check_ip_address
        return
    fi
    if [ "$HTTP_ONLY" = 1 ]; then
        if getent hosts "$DOMAIN" >/dev/null 2>&1; then
            ok "$DOMAIN resolves"
        else
            warn "$DOMAIN does not resolve from this machine. Check your DNS."
        fi
        info "Reminder: the security group must allow inbound TCP 80 from the machines that will use PostHog."
        return
    fi
    my_ip="$(public_ip)"
    dns_ips="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd' ' || true)"
    if [ -z "$my_ip" ]; then
        warn "Could not detect this instance's public IP. Make sure $DOMAIN points at it."
    elif [ -z "$dns_ips" ]; then
        warn "$DOMAIN does not resolve yet. Create an A record pointing at $my_ip."
        warn "Caddy keeps retrying the HTTPS certificate, so you can fix DNS while the install runs."
    elif [[ " $dns_ips " == *" $my_ip "* ]]; then
        ok "DNS: $DOMAIN points at this instance ($my_ip)"
    else
        warn "$DOMAIN resolves to $dns_ips, but this instance's public IP is $my_ip."
        warn "Update the A record, or the HTTPS certificate cannot be issued."
    fi
    info "Reminder: the security group must allow inbound TCP 80 and 443."
}

# ---------------------------------------------------------------------------
# Start the stack
# ---------------------------------------------------------------------------
pull_images() {
    cd "$INSTALL_DIR"
    local attempt out
    for attempt in 1 2 3 4; do
        info "Pulling images, attempt $attempt/4 (about 20 GB the first time)"
        if out=$(docker compose pull --quiet 2>&1); then
            ok "All images pulled"
            return
        fi
        echo "$out" | tail -5 | sed 's/^/      /'
        if echo "$out" | grep -qiE '429|toomanyrequests|rate limit'; then
            warn "Docker Hub rate limit reached"
            add_registry_mirror
        fi
        sleep $(( attempt * 15 ))
    done
    die "Could not pull the images. Check the errors above and re-run the script."
}

start_stack() {
    cd "$INSTALL_DIR"
    docker compose up -d --no-build --remove-orphans >/dev/null 2>&1 \
        || docker compose up -d --no-build --remove-orphans \
        || die "Docker Compose could not start the stack. See the errors above."
    ok "Containers started"
}

install_boot_service() {
    # Some services use "restart: on-failure", which Docker does not restart after a reboot.
    cat > /etc/systemd/system/posthog.service <<EOF
[Unit]
Description=PostHog (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/env docker compose up -d --no-build
ExecStop=/usr/bin/env docker compose stop
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable posthog.service >/dev/null 2>&1
    ok "PostHog will start automatically after a reboot"
}

wait_for_health() {
    cd "$INSTALL_DIR"
    local start now elapsed applied status web_state
    start=$(date +%s)
    info "The first boot creates the databases and runs ~700 migrations."
    info "Expect 15 to 45 minutes. Progress is shown every 30 seconds."
    while true; do
        status=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://localhost/_health || true)
        if [ "$status" = 200 ]; then
            echo
            ok "PostHog is up (after $(( ($(date +%s) - start) / 60 )) minutes)"
            return 0
        fi
        now=$(date +%s); elapsed=$(( (now - start) / 60 ))
        web_state=$(docker inspect -f '{{.State.Status}}' "$(docker compose ps -q web 2>/dev/null)" 2>/dev/null || echo unknown)
        applied=$(docker compose logs --no-log-prefix web 2>/dev/null | grep -c 'Applying .* OK' || true)
        printf '\r    … %3d min elapsed | web: %-8s | migrations applied: %-5s' "$elapsed" "$web_state" "$applied"
        if [ "$elapsed" -ge "$HEALTH_TIMEOUT_MIN" ]; then
            echo
            warn "PostHog did not answer /_health within ${HEALTH_TIMEOUT_MIN} minutes."
            info "Last lines from the web container:"
            docker compose logs --tail 30 web 2>&1 | sed 's/^/      /'
            return 1
        fi
        sleep 30
    done
}

check_https() {
    local code
    for _ in $(seq 1 20); do
        code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/_health" || true)
        if [ "$code" = 200 ]; then
            ok "HTTPS certificate issued for $DOMAIN"
            return 0
        fi
        sleep 15
    done
    warn "No valid HTTPS certificate yet. Usually the DNS record or the security group (port 80/443) is wrong."
    warn "Caddy keeps retrying on its own. Check with: cd $INSTALL_DIR && docker compose logs proxy"
}

print_summary() {
    local healthy="$1"
    echo
    if [ "$healthy" = 0 ]; then
        echo "${GREEN}${BOLD}🎉 PostHog is installed.${RESET} Open ${BOLD}${SITE_URL}${RESET} and create your account."
    else
        echo "${YELLOW}${BOLD}PostHog is installed, but it was not healthy yet when the script finished.${RESET}"
        echo "It may still be migrating. Check again in a few minutes:  curl http://localhost/_health"
    fi
    cat <<EOF

  Install directory   ${INSTALL_DIR}
  Secrets             ${INSTALL_DIR}/.env   (back this file up)
  Install log         ${LOG_FILE}

  Status              cd ${INSTALL_DIR} && docker compose ps
  Web logs            cd ${INSTALL_DIR} && docker compose logs -f web
  Stop / start        sudo systemctl stop posthog  /  sudo systemctl start posthog
  Upgrade             re-run this script (it keeps your data and secrets)
EOF
}

main() {
    require_root "$@"
    mkdir -p "$INSTALL_DIR"
    LOG_FILE="$INSTALL_DIR/install.log"
    exec > >(tee -a "$LOG_FILE") 2>&1

    echo "${BOLD}PostHog hobby installer 🦔${RESET}  ($(date -u '+%Y-%m-%d %H:%M UTC'))"

    step "Checking this machine"
    detect_os
    ask_domain "${1:-}"
    check_resources
    ensure_swap

    step "Installing Docker and tools"
    install_packages
    install_docker

    step "Preparing PostHog"
    fetch_posthog_repo
    write_env
    write_compose_files
    download_geoip

    step "Checking DNS"
    check_dns

    step "Starting PostHog"
    pull_images
    start_stack
    install_boot_service

    step "Waiting for PostHog to boot"
    local healthy=0
    wait_for_health || healthy=1
    if [ "$healthy" = 0 ] && [ "$HTTP_ONLY" = 0 ]; then
        step "Checking HTTPS"
        check_https || true
    fi

    print_summary "$healthy"
}

# A partial copy (for example a paste that lost the top of the file) has no "set -e" and
# no helper functions, so it would run commands that fail one after another. Stop instead.
if ! declare -F require_root >/dev/null || ! declare -F step >/dev/null; then
    echo "This copy of install-posthog-hobby.sh is incomplete (the top of the file is missing). Get the whole file again." >&2
    exit 1
fi

main "$@"
