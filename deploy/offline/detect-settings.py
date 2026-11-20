#!/usr/bin/env python3
"""Sample events through the authenticated PostHog query API; never log event contents."""
import json
import sys
import urllib.request
from site_config_loader import env


def query(settings, sql):
    host = settings.get('POSTHOG_HOST', 'http://127.0.0.1').rstrip('/')
    url = host + '/api/projects/' + settings['POSTHOG_PROJECT_ID'] + '/query/'
    request = urllib.request.Request(url, data=json.dumps({'query': {'kind': 'HogQLQuery', 'query': sql}}).encode(),
                                     headers={'Authorization': 'Bearer ' + settings['POSTHOG_PERSONAL_API_KEY'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)['results']


def sample(settings):
    return query(settings, 'SELECT distinct_id, properties FROM events ORDER BY timestamp DESC LIMIT 100')


def detect(settings):
    rows = sample(settings)
    props = [(str(d), json.loads(p) if isinstance(p, str) else p) for d, p in rows]
    result = {}
    if any('dialog_id' in p or 'tab_name' in p for _, p in props):
        result['APP_EVENTS_FILE'] = 'config/app-events.reval.json'
    eligible = [(d, p) for d, p in props if not p.get(settings.get('PROP_CLIENT_ID', 'client_id'))]
    if eligible and all(len(d.split('|')) == 4 and bool(d.split('|')[2]) for d, _ in eligible):
        result.update(CLIENT_FROM_DISTINCT_ID='3', DISTINCT_ID_SEPARATOR='|')
    return result


if __name__ == '__main__':
    settings = {}
    for path in sys.argv[1:]:
        settings.update(env(path))
    try:
        for k, v in detect(settings).items():
            print(k + '=' + v)
            print('Detected ' + k + '=' + v + ' from sampled events', file=sys.stderr)
    except Exception as error:
        print('Event settings detection unavailable (' + type(error).__name__ + '); configure APP_EVENTS_FILE and CLIENT_FROM_DISTINCT_ID explicitly.', file=sys.stderr)
