#!/usr/bin/env python3
"""Read-only company-server checks. PASS/FAIL with actionable fixes, no secret output."""
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from site_config_loader import env

root = Path(sys.argv[1]).resolve()
ph = Path(os.environ.get('POSTHOG_DIR', '/opt/posthog'))
settings = env(root / '.secrets.env')
failures = 0


def run(args, **kwargs):
    child_env = os.environ.copy()
    child_env.pop('COMPOSE_FILE', None)
    return subprocess.check_output(args, timeout=180, stderr=subprocess.PIPE, env=child_env, **kwargs).decode()


def check(name, fix, action):
    global failures
    try:
        if action() is False:
            raise RuntimeError('Check failed')
        print('PASS ' + name, flush=True)
    except Exception as error:
        failures += 1
        print('FAIL ' + name + ' (' + type(error).__name__ + '); fix: ' + fix, flush=True)


def http(path):
    request = urllib.request.Request('http://127.0.0.1:' + settings.get('SERVICE_PORT', '8080') + path,
                                     headers={'Authorization': 'Bearer ' + settings.get('MCP_TOKEN', '')})
    with urllib.request.urlopen(request, timeout=90) as response:
        assert response.status == 200
        data = response.read()
        if '/api/' in path:
            body = json.loads(data)
            assert not body.get('error')


def web(script, extra=()):
    return run(['docker', 'compose', 'exec', '-T', *extra, 'web', 'python', 'manage.py', 'shell'], cwd=ph, input=script.encode())


def listening():
    port = settings.get('SERVICE_PORT', '8080')
    assert port == '8080'
    output = run(['ss', '-H', '-lnt'])
    assert any(address in output for address in ('0.0.0.0:8080', '*:8080', '[::]:8080'))


def clients():
    spec = importlib.util.spec_from_file_location('detect', Path(__file__).with_name('detect-settings.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = module.sample(settings)
    assert rows, 'No events to sample'
    index = int(settings.get('CLIENT_FROM_DISTINCT_ID', '0'))
    key = settings.get('PROP_CLIENT_ID', 'client_id')
    for distinct, props in rows:
        props = json.loads(props) if isinstance(props, str) else props
        parts = str(distinct).split(settings.get('DISTINCT_ID_SEPARATOR', '|'))
        assert (len(parts) >= index and parts[index - 1]) if index > 0 else props.get(key), 'Empty client'


def app_events():
    path = settings.get('APP_EVENTS_FILE')
    assert path and (root / path).is_file()
    # Check with the actual service uid and mounts, not root's host permissions.
    run(['docker', 'exec', 'posthog-lens', 'node', '-e',
         "const fs=require('node:fs');fs.accessSync(process.argv[1],fs.constants.R_OK)", path])


def upstream():
    containers = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.service=posthog-mcp']).split()
    assert len(containers) == 1, 'Expected exactly one PostHog MCP container'
    container = containers[0]
    script = "Promise.all(['/_health','/api/'].map(async p=>{const r=await fetch(process.env.POSTHOG_API_BASE_URL+p,{redirect:'manual'});if(![200,401,403].includes(r.status))throw Error('HTTP '+r.status)})).catch(()=>process.exit(1))"
    run(['docker', 'exec', container, 'node', '-e', script])


def mcp():
    # Bound network reads and parse complete JSON-RPC events as soon as received.
    url = 'http://127.0.0.1:' + settings.get('SERVICE_PORT', '8080') + '/mcp'
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
               'Authorization': 'Bearer ' + settings['MCP_TOKEN']}
    def call(payload):
        request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=90) as response:
            if response.headers.get('Mcp-Session-Id'):
                headers['Mcp-Session-Id'] = response.headers['Mcp-Session-Id']
            if 'text/event-stream' in response.headers.get('Content-Type', ''):
                deadline = time.monotonic() + 90
                for line in response:
                    if time.monotonic() > deadline:
                        raise TimeoutError('MCP response deadline')
                    if line.startswith(b'data: '):
                        data = json.loads(line[6:])
                        if data.get('id') == payload.get('id'):
                            return data
            return json.load(response)
    result = call({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'server-check', 'version': '1'}}})
    assert 'result' in result
    headers['MCP-Protocol-Version'] = result['result']['protocolVersion']
    request = urllib.request.Request(url, data=json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=15):
        pass
    result = call({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'posthog_exec', 'arguments': {'command': 'tools'}}})
    assert 'result' in result and not result['result'].get('isError')
    assert result['result'].get('content')


def csrf():
    from urllib.parse import urlsplit
    conf = env(os.environ.get('POSTHOG_LENS_CONF', '/etc/posthog-lens/posthog-lens.env'))
    addresses = conf.get('POSTHOG_ADDRESS') or env(ph / '.env').get('ADDRESSES', '')
    assert addresses, 'No configured addresses'
    script = "from django.conf import settings\nimport json\nprint('TRUSTED='+json.dumps(settings.CSRF_TRUSTED_ORIGINS))\n"
    out = web(script)
    trusted = json.loads(next(s[8:] for s in out.splitlines() if s.startswith('TRUSTED=')))
    for address in addresses.split(','):
        netloc = urlsplit(address if '://' in address else 'http://' + address).netloc
        for scheme in ('http', 'https'):
            assert scheme + '://' + netloc in trusted


def http_addresses():
    conf = env(os.environ.get('POSTHOG_LENS_CONF', '/etc/posthog-lens/posthog-lens.env'))
    addresses = conf.get('POSTHOG_ADDRESS') or env(ph / '.env').get('ADDRESSES', '')
    plain = [s.strip() for s in addresses.split(',') if s.strip().startswith('http://')]
    if not plain:
        return
    # A browser must reach HTTP directly; following a redirect would hide the original fault.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    for address in plain:
        with opener.open(address.rstrip('/') + '/_health', timeout=20) as response:
            assert response.status == 200
    web("from django.conf import settings\nassert not settings.SESSION_COOKIE_SECURE, 'HTTP session cookie is secure-only'\nassert not settings.CSRF_COOKIE_SECURE, 'HTTP CSRF cookie is secure-only'\nassert not settings.SESSION_COOKIE_DOMAIN, 'A cookie domain prevents login by IP'\n")


def replay():
    script = (root / 'deploy/migrate/replays_playable.py').read_text()
    # Reuse the actual replay reader, bounding metadata and fetching one block.
    script = script.replace('GROUP BY team_id, session_id', 'GROUP BY team_id, session_id LIMIT 100')
    script = script.replace('asyncio.run(main())', "from django.apps import apps\nassert apps.get_model('posthog', 'SessionRecording').objects.count() > 0\nrows = [r for r in rows if r[2]]\nassert rows, 'No replay blocks in sample'\nrows = [(rows[0][0], rows[0][1], rows[0][2][:1])]\nassert rows[0][2]\nasyncio.run(main())")
    out = web(script)
    assert 'PLAYABLE: 1 of 1 recordings, 1 of 1 blocks' in out


def live():
    base = 'http://127.0.0.1:' + settings.get('SERVICE_PORT', '8080')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    request = urllib.request.Request(base + '/replays/login', data=json.dumps({
        'email': settings['POSTHOG_ADMIN_EMAIL'], 'password': settings['POSTHOG_ADMIN_PASSWORD']}).encode(),
        headers={'Content-Type': 'application/json', 'x-clip-page': '1'})
    with opener.open(request, timeout=60) as response:
        assert json.load(response).get('ok')
    try:
        with opener.open(base + '/replays/live/api/now', timeout=90) as response:
            assert response.status == 200
            assert not json.load(response).get('error')
    finally:
        request = urllib.request.Request(base + '/replays/logout', data=b'{}', headers={'Content-Type': 'application/json', 'x-clip-page': '1'})
        with opener.open(request, timeout=30):
            pass


check('Lens listening on 8080 on all interfaces', 'sudo posthog-lens update <kit>; check SERVICE_PORT=8080 and host firewall', listening)
check('Lens health', 'sudo posthog-lens update <kit>; journalctl -u ticket-triage -n 50', lambda: http('/healthz'))
check('clients resolvable from sampled events', 'set CLIENT_FROM_DISTINCT_ID=3 for X|Y|CLIENT|USER in /etc/posthog-lens/posthog-lens.env, then update', clients)
check('APP_EVENTS_FILE set and readable', 'set APP_EVENTS_FILE=config/app-events.reval.json in /etc/posthog-lens/posthog-lens.env, then update', app_events)
check('PostHog MCP reaches PostHog with node fetch', 'sudo POSTHOG_DIR=' + str(ph) + ' bash deploy/posthog-mcp/up.sh', upstream)
check('posthog_exec through Lens (initialize + tools)', 'check MCP_TOKEN, FEATURE_POSTHOG_MCP and POSTHOG_MCP_API_KEY in .secrets.env; restart Lens', mcp)
check('config.js 200 for every team', 'run post-upgrade-repair.sh --yes to rebuild RemoteConfig', lambda: web((root / 'deploy/migrate/remote-config.py').read_text(), ['-e', 'REMOTE_CONFIG_VERIFY=1']))
check('every address trusted for CSRF in both schemes', 'run post-upgrade-repair.sh --yes to preserve/apply site addresses', csrf)
check('HTTP addresses answer directly and allow login cookies', 'run post-upgrade-repair.sh --yes; check Caddy site list, SECURE_COOKIES=false and cookie domain', http_addresses)
check('session_recording count > 0 and sample block fetchable', 'run posthog-upgrade.sh replays then verify (keep old MinIO until verified)', replay)
check('live page endpoint', 'check POSTHOG_ADMIN_EMAIL/POSTHOG_ADMIN_PASSWORD, APP_EVENTS_FILE and client settings; inspect Lens logs', live)
sys.exit(1 if failures else 0)
