#!/usr/bin/env python3
"""Generate small additive hobby overrides; never replace upstream ClickHouse XML."""
import json
import os
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

OVERRIDE = 'docker-compose.lens-tuning.yml'

def env_edit(path, enabled):
    path = Path(path)
    lines = path.read_text().splitlines()
    for key in ('COMPOSE_FILE', 'EXTRA_COMPOSE_FILES'):
        index = next((i for i, line in enumerate(lines) if line.startswith(key + '=')), None)
        default = ['docker-compose.yml'] + (['docker-compose.override.yml'] if (path.parent / 'docker-compose.override.yml').exists() else []) if key == 'COMPOSE_FILE' else []
        items = lines[index].split('=', 1)[1].strip().strip('\"\'').split(':') if index is not None else default
        if key == 'COMPOSE_FILE' and not any(items):
            raise ValueError('empty COMPOSE_FILE')
        items = [x for x in items if x and x != OVERRIDE]
        if enabled:
            items.append(OVERRIDE)
        value = key + '=' + ':'.join(items)
        if index is None:
            lines.append(value)
        else:
            lines[index] = value
    path.write_text('\n'.join(lines) + '\n')

def generate(out, env_path, config_path=None):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    saved = {}
    if Path(env_path).exists():
        saved = dict(line.split('=', 1) for line in Path(env_path).read_text().splitlines() if '=' in line and not line.startswith('#'))
    def setting(key, default):
        return os.environ.get(key) or saved.get(key, '').strip().strip('\"\'') or str(default)
    def number(key, default, lo=1, hi=2**63-1):
        value = setting(key, default)
        if not re.fullmatch(r'[0-9]+', value) or not lo <= int(value) <= hi:
            raise ValueError(f'{key} must be an integer in {lo}..{hi}')
        return int(value)
    ram = number('LENS_TUNE_RAM_MB', int(re.search(r'MemTotal:\s+(\d+)', Path('/proc/meminfo').read_text())[1]) // 1024, 1024)
    workers = number('LENS_PH_WORKERS', 2 if ram < 32768 else 3, 1, 16)
    # Worker recycling is off by default: Granian restarts every worker at the same moment, and PostHog's web
    # app takes minutes to start, so hourly recycling meant minutes of 502s every hour (seen on the test box).
    lifetime = number('LENS_PH_WORKER_LIFETIME', 0, 0)
    if 0 < lifetime < 600: raise ValueError('LENS_PH_WORKER_LIFETIME must be 0 (off) or at least 600 seconds')
    # ClickHouse gets the memory the smaller web worker pool frees (about a seventh of RAM: ~3 GB on 22 GB).
    server = number('LENS_CH_SERVER_MB', min(8192, max(1024, ram // 7)), 512, ram)
    # One query may use most of it; big sorts and group-bys spill to disk at a quarter instead of failing.
    query = number('LENS_CH_QUERY_MB', server * 6 // 10, 16, server)
    spill = number('LENS_CH_SPILL_MB', server // 4, 1, query)
    # Threads: PostHog's own choice unless set (0 = leave alone).
    threads = number('LENS_CH_THREADS', 0, 0, 64)
    marks = number('LENS_CH_MARK_CACHE_MB', 256, 1)
    raw = number('LENS_CH_UNCOMPRESSED_CACHE_MB', 0, 0)
    ratio = setting('LENS_CH_RAM_RATIO', '0')
    if not re.fullmatch(r'0(?:\.\d+)?|1(?:\.0+)?', ratio) or not 0 <= float(ratio) <= 1:
        raise ValueError('LENS_CH_RAM_RATIO must be between 0 and 1 (0: use LENS_CH_SERVER_MB)')
    mib = 1024 * 1024
    config = ET.Element('clickhouse')
    for key, value in {'max_server_memory_usage': server*mib, 'max_server_memory_usage_to_ram_ratio': ratio,
                       'mark_cache_size': marks*mib, 'uncompressed_cache_size': raw*mib}.items():
        if key == 'max_server_memory_usage_to_ram_ratio' and float(ratio) == 0: continue
        ET.SubElement(config, key).text = str(value)
    users = ET.Element('clickhouse')
    profile = ET.SubElement(ET.SubElement(users, 'profiles'), 'default')
    for key, value in {'max_memory_usage': query*mib, 'max_bytes_before_external_group_by': spill*mib,
                       'max_bytes_before_external_sort': spill*mib,
                       # HogQL can explicitly set the absolute group-by threshold to zero.
                       # The independent ratio still spills before consuming the query budget.
                       'max_bytes_ratio_before_external_group_by': spill/server,
                       'max_bytes_ratio_before_external_sort': spill/server,
                       **({'max_threads': threads} if threads else {})}.items():
        ET.SubElement(profile, key).text = str(value)
    # No <constraints>: PostHog sends its own per-query SETTINGS, and ClickHouse rejects (does not clamp)
    # a query whose setting exceeds a constraint, which would break PostHog's own screens.
    for name, tree in [('server.xml', config), ('users.xml', users)]:
        ET.indent(tree)
        ET.ElementTree(tree).write(out / name, encoding='unicode')
        ET.parse(out / name)
    services = {
        'web': {'environment': {'GRANIAN_WORKERS': str(workers), **({'GRANIAN_WORKERS_LIFETIME': str(lifetime)} if lifetime else {})}},
        'clickhouse': {'volumes': [
            './lens-tuning/server.xml:/etc/clickhouse-server/config.d/zz-lens-tuning.xml:ro',
            './lens-tuning/users.xml:/etc/clickhouse-server/users.d/zz-lens-tuning.xml:ro']},
        'proxy': {'entrypoint': ['/bin/sh'], 'command': ['/etc/lens-tuning/proxy.sh'], 'volumes': [
            './lens-tuning/proxy.sh:/etc/lens-tuning/proxy.sh:ro',
            './lens-tuning/static.caddy:/etc/lens-tuning/static.caddy:ro']},
    }
    if config_path:
        existing = json.loads(Path(config_path).read_text())['services']
        for service in services:
            if service not in existing:
                raise ValueError(f'missing hobby service: {service}')
        if not existing['proxy'].get('environment', {}).get('CADDYFILE'):
            raise ValueError('proxy needs the hobby CADDYFILE environment setting')
    (out / OVERRIDE).write_text(json.dumps({'services': services}, indent=2) + '\n')
    (out / 'settings.json').write_text(json.dumps(dict(ram_mb=ram, workers=workers, worker_lifetime_s=lifetime,
        query_mb=query, spill_mb=spill, threads=threads, server_mb=server, ram_ratio=float(ratio),
        mark_cache_mb=marks, uncompressed_cache_mb=raw), indent=2) + '\n')

if __name__ == '__main__':
    if sys.argv[1] in ('add', 'remove'):
        env_edit(sys.argv[2], sys.argv[1] == 'add')
    else:
        generate(*sys.argv[1:])
