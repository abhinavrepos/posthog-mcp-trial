#!/usr/bin/env python3
"""Preserve site environment before stock Compose replacement. No third-party modules."""
import argparse
import json
import ipaddress
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def env(path):
    result = {}
    if Path(path).exists():
        for line in Path(path).read_text().splitlines():
            m = re.match(r'^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=(.*)$', line)
            if m:
                value = m[2].strip()
                if value.startswith('"') and value.endswith('"'):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        value = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]
                else:
                    value = re.sub(r'\s+#.*$', '', value).strip()
                result[m[1]] = value
    return result


def put(path, values):
    path = Path(path)
    lines = path.read_text().splitlines() if path.exists() else []
    lines = [s for s in lines if not ((m := re.match(r'^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=', s)) and m[1] in values)]
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        stream.write('\n'.join(lines + [k + '=' + json.dumps(str(v)) for k, v in values.items()]) + '\n')


def preserve(folder, addresses='', offline=False, before_upgrade=False, stock_folder=None):
    root = Path(folder)
    settings = env(root / '.env')
    services = {}
    if not offline:
        # Fail closed: do not replace a site's config if Compose cannot resolve it.
        compose_env = os.environ.copy()
        compose_env.pop('COMPOSE_FILE', None)
        data = subprocess.check_output(['docker', 'compose', 'config', '--format', 'json'], cwd=root, env=compose_env, timeout=120)
        services = json.loads(data)['services']
    else:
        # Fixture/dry-run input uses JSON (valid YAML), or simple Compose environment mappings/lists.
        for path in sorted(root.glob('docker-compose*.yml')):
            service = section = None
            for line in path.read_text().splitlines():
                m = re.match(r'^    ([\w-]+):\s*$', line)
                if m:
                    service, section = m[1], None
                elif re.match(r'^        environment:', line):
                    section = 'environment'
                elif re.match(r'^        \S', line):
                    section = None
                elif service and section:
                    m = re.match(r'^\s+(?:-\s*)?([A-Z_][A-Z_0-9]*)(?:=|:\s*)(.*)$', line)
                    if m:
                        services.setdefault(service, {}).setdefault('environment', {})[m[1]] = m[2].strip().strip('\"\'')
    # Preserve all web environment not present in the target stock templates, plus site controls.
    stock_root = Path(stock_folder) if stock_folder else root / 'posthog'
    stock = '\n'.join(p.read_text() for p in stock_root.glob('docker-compose*.yml'))
    target_env = stock_root / '.env.services'
    if target_env.exists():
        stock += '\n' + target_env.read_text()
    web = dict(env(root / '.env.services'))
    web.update(services.get('web', {}).get('environment', {}))
    keys = {'EXTRA_CSRF_TRUSTED_ORIGINS', 'CSRF_TRUSTED_ORIGINS', 'SITE_URL', 'SECURE_COOKIES',
            'TRUST_ALL_PROXIES', 'ALLOWED_HOSTS', 'DISABLE_SECURE_SSL_REDIRECT'}
    keep = {k: v for k, v in web.items() if k in keys or not re.search(r'\b' + re.escape(k) + r'\b', stock)}
    for k in keys:
        if k in settings and k not in keep:
            keep[k] = settings[k]
    trusted_raw = [keep.get('EXTRA_CSRF_TRUSTED_ORIGINS', ''), keep.get('CSRF_TRUSTED_ORIGINS', '')]
    caddy = services.get('proxy', {}).get('environment', {}).get('CADDY_HOST', settings.get('CADDY_HOST', ''))
    caddyfile = services.get('proxy', {}).get('environment', {}).get('CADDYFILE', '')
    rendered_sites = ','.join(re.findall(r'(?m)^([^\s#{}][^{}\n]*)\{[ \t]*$', caddyfile))
    raw = [addresses] if addresses else [settings.get('ADDRESSES', ''), keep.get('SITE_URL', ''), caddy, rendered_sites, settings.get('DOMAIN', ''), web.get('DOMAIN', '')]
    if not any(raw):
        # Older installs sometimes keep all the public names only in CSRF settings.
        raw = trusted_raw
    sites = []
    for item in raw:
        for value in re.split(r'[,\s]+', str(item or '')):
            value = value.strip('\"\'[]')
            if not value or '${' in value or value in ('http://', 'https://'):
                continue
            if '://' not in value:
                if any(urlsplit(s).netloc == value for s in sites):
                    continue
                value = ('http://' if re.match(r'^\d+\.\d+\.\d+\.\d+', value) else 'https://') + value
            u = urlsplit(value)
            if u.scheme in ('http', 'https') and u.netloc and value not in sites:
                sites.append(u.scheme + '://' + u.netloc)
    # Names must serve both balancer modes: HTTP termination and TLS re-encryption.
    # Keep the requested first address for SITE_URL; only expand the Caddy listeners.
    requested_sites = []
    for address in sites:
        u = urlsplit(address)
        try:
            ipaddress.ip_address(u.hostname)
        except ValueError:
            # Expanded CADDY_HOST is an input on the next run; keep only the first
            # requested scheme for each name so ADDRESSES does not grow on update.
            if any(urlsplit(s).netloc == u.netloc for s in requested_sites):
                continue
        requested_sites.append(address)
    first_address = sites[0] if sites else ''
    listeners = []
    for address in sites:
        u = urlsplit(address)
        try:
            ipaddress.ip_address(u.hostname)
            variants = [address] if u.scheme == 'https' else []
        except ValueError:
            variants = ['https://' + u.netloc]
        variants.append('http://' + u.netloc)
        listeners.extend(v for v in variants if v not in listeners)
    sites = listeners
    trusted_sites = list(sites)
    for value in re.split(r'[,\s]+', ','.join(str(v or '') for v in trusted_raw)):
        value = value.strip("\"'[]")
        if value.startswith(('http://', 'https://')) and urlsplit(value).netloc:
            trusted_sites.append(value)
    origins = sorted({scheme + '://' + urlsplit(s).netloc for s in trusted_sites for scheme in ('http', 'https')})
    if origins:
        keep['EXTRA_CSRF_TRUSTED_ORIGINS'] = ','.join(origins)
        keep['CSRF_TRUSTED_ORIGINS'] = ','.join(origins)
    keep['DISABLE_SECURE_SSL_REDIRECT'] = 'true'
    if any(s.startswith('http://') for s in sites):
        keep['SECURE_COOKIES'] = 'false'
    if sites:
        keep['SITE_URL'] = first_address
    # Merge existing site JSON/YAML through resolved services above; only replace these environments.
    out = root / 'docker-compose.site.yml'
    existing = {}
    if out.exists():
        try:
            existing = json.loads(out.read_text())
        except ValueError:
            # Preserve arbitrary hand-authored YAML as an earlier, separately included layer.
            saved = root / 'docker-compose.site.saved.yml'
            saved.write_bytes(out.read_bytes())
            saved.chmod(0o600)
            settings['EXTRA_COMPOSE_FILES'] = ':'.join(dict.fromkeys(filter(None, [*settings.get('EXTRA_COMPOSE_FILES', '').split(':'), saved.name])))
    result = existing.setdefault('services', {})
    result.setdefault('web', {}).setdefault('environment', {}).update(keep)
    # Worker-only company settings also need to survive stock replacement. Do not
    # resurrect a service removed by the target release with an environment-only entry.
    for name, service in services.items():
        if name in ('web', 'proxy') or (stock and not re.search(r'^    ' + re.escape(name) + r':', stock, re.M)):
            continue
        custom = {k: v for k, v in service.get('environment', {}).items()
                  if not re.search(r'\b' + re.escape(k) + r'\b', stock)}
        if 'SITE_URL' in service.get('environment', {}) and keep.get('SITE_URL'):
            custom['SITE_URL'] = keep['SITE_URL']
        if custom:
            result.setdefault(name, {}).setdefault('environment', {}).update(custom)
    if before_upgrade:
        result.get('proxy', {}).get('environment', {}).pop('CADDYFILE', None)
    # Merge TLS controls from both flows; Compose maps TLS_BLOCK to CADDY_TLS_BLOCK.
    tls_lines = []
    for block in (settings.get('TLS_BLOCK', ''), settings.get('CADDY_TLS_BLOCK', ''),
                  services.get('proxy', {}).get('environment', {}).get('CADDY_TLS_BLOCK', '')):
        for line in str(block or '').splitlines():
            line = line.strip()
            if line and '${' not in line and line not in tls_lines:
                tls_lines.append(line)
    # Replace incompatible auto_https modes rather than leaving duplicate directives.
    tls_lines = [line for line in tls_lines if not re.match(r'^(?:auto_https|local_certs)\b', line)]
    tls_lines += ['auto_https disable_redirects', 'local_certs']
    tls_block = '\n'.join(tls_lines)
    result.setdefault('proxy', {}).setdefault('environment', {})['CADDY_TLS_BLOCK'] = tls_block
    caddy_hosts = ', '.join([*sites, 'http://'])
    if sites:
        result.setdefault('proxy', {}).setdefault('environment', {})['CADDY_HOST'] = caddy_hosts
    updates = {'TLS_BLOCK': tls_block, 'CADDY_TLS_BLOCK': tls_block}
    if sites:
        updates['CADDY_HOST'] = caddy_hosts
        updates['ADDRESSES'] = ','.join(requested_sites)
        caddyfile = services.get('proxy', {}).get('environment', {}).get('CADDYFILE', '')
        if caddyfile and not before_upgrade:
            # Older upgrade renderers baked the site list into CADDYFILE. Updating CADDY_HOST
            # alone cannot change it. Preserve routes and change only the top-level site header.
            if '{$CADDY_HOST' not in caddyfile and '${CADDY_HOST' not in caddyfile:
                caddyfile, count = re.subn(r'(?m)^[^\s#{}][^{}\n]*\{[ \t]*$', caddy_hosts + ' {', caddyfile, count=1)
                if count != 1:
                    raise RuntimeError('Cannot locate Caddy site header; inspect proxy CADDYFILE before applying addresses')
            # A pre-rendered global block cannot consume the new environment values.
            def global_options(match):
                lines = [line for line in match[1].splitlines()
                         if not re.match(r'\s*(?:auto_https\b|local_certs\b|\$\{?CADDY_TLS_BLOCK)', line)]
                return '{\n' + '\n'.join(lines).strip('\n') + '\n  auto_https disable_redirects\n  local_certs\n}'
            if re.match(r'\s*\{', caddyfile):
                caddyfile = re.sub(r'\A\s*\{(.*?)^[ \t]*\}', global_options, caddyfile, count=1, flags=re.M | re.S)
            else:
                caddyfile = '{\n  auto_https disable_redirects\n  local_certs\n}\n' + caddyfile
            result['proxy']['environment']['CADDYFILE'] = caddyfile

    for key, default in [('COMPOSE_FILE', 'docker-compose.yml'), ('EXTRA_COMPOSE_FILES', '')]:
        updates[key] = ':'.join(dict.fromkeys(filter(None, [*(f for f in settings.get(key, default).split(':') if f != out.name), *(f for f in settings.get('EXTRA_COMPOSE_FILES', '').split(':') if f != out.name), out.name])))
    with os.fdopen(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        stream.write(json.dumps(existing, indent=2) + '\n')
    out.chmod(0o600)
    put(root / '.env', updates)
    print('Site settings preserved in', out, '; trusted origins:', ','.join(origins))
    return existing


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('folder')
    parser.add_argument('--addresses', default='')
    parser.add_argument('--stock-dir', help='target PostHog source when recovering a pre-upgrade backup')
    parser.add_argument('--before-upgrade', action='store_true')
    parser.add_argument('--fixture', action='store_true', help='parse simple fixture YAML without Docker')
    args = parser.parse_args()
    preserve(args.folder, args.addresses, args.fixture, args.before_upgrade, args.stock_dir)
