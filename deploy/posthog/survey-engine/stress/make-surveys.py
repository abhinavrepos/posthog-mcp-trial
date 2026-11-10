import json, sys, urllib.request, datetime
host, key = sys.argv[1], open(sys.argv[2]).read().strip()
def call(method, path, body=None):
    req = urllib.request.Request(host + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + key, 'content-type': 'application/json'})
    with urllib.request.urlopen(req) as r: return json.loads(r.read() or b'null')
ex = lambda *v: {'operator': 'exact', 'values': list(v)}
ready = {'documentComplete': True, 'noVisibleMask': True, 'maxWaitMs': 15000}
look = {'backgroundColor': '#0b2a4a', 'textColor': '#ffffff', 'submitButtonColor': '#f5a623', 'submitButtonTextColor': '#0b2a4a',
        'ratingButtonColor': '#163d66', 'ratingButtonActiveColor': '#f5a623', 'borderColor': '#f5a623', 'position': 'right', 'surveyPopupDelaySeconds': 0}
def chain(cid, steps, **extra): return dict({'version': 1, 'id': cid, 'steps': steps, 'ready': ready, 'managedBy': 'lens'}, **extra)
defs = {
 'S1': ('ACME', chain('acme-3step', [{'event': 'PageView', 'properties': {'dialog_id': ex('DlgA'), 'action': ex('OPEN')}},
                                    {'event': 'Event', 'properties': {'dialog_id': ex('DlgA'), 'action_name': ex('Save')}},
                                    {'event': 'PageView', 'properties': {'dialog_id': ex('DlgZ'), 'action': ex('OPEN')}}],
                        resetOn=[{'event': 'PageView', 'properties': {'dialog_id': ex('DlgA'), 'action': ex('CLOSE')}}])),
 'S2': (None, chain('msg-link', [{'event': 'Event', 'properties': {'dialog_id': ex('toast'), 'action_name': {'operator': 'regex', 'values': ['^Link Id [0-9]+ Added$']}}}])),
 'S3': ('GAMMA', chain('gamma-timed', [{'event': 'PageView', 'properties': {'dialog_id': ex('DlgB'), 'action': ex('OPEN')}},
                                      {'event': 'Event', 'properties': {'dialog_id': ex('DlgB'), 'action_name': ex('Run')}}], withinSeconds=8)),
 'S4': ('BETA', chain('beta-c', [{'event': 'Event', 'properties': {'dialog_id': ex('DlgC'), 'action_name': ex('Save')}}])),
}
ids = {}
for name, (client, lc) in defs.items():
    body = {'name': f'[Lens stress] {name}', 'type': 'popover', 'schedule': 'once',
            'questions': [{'type': 'rating', 'question': f'Q: {name} how easy was it?', 'scale': 5, 'display': 'number', 'lowerBoundLabel': 'Hard', 'upperBoundLabel': 'Easy'}],
            'conditions': {'events': {'repeatedActivation': True, 'values': [{'name': 'lens_chain:' + lc['id']}]}, 'lensChain': lc},
            'appearance': look}
    if client: body['targeting_flag_filters'] = {'groups': [{'properties': [{'key': 'client', 'type': 'person', 'operator': 'exact', 'value': [client]}], 'rollout_percentage': 100}]}
    s = call('POST', '/api/projects/1/surveys/', body)
    call('PATCH', f"/api/projects/1/surveys/{s['id']}/", {'start_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})
    back = call('GET', f"/api/projects/1/surveys/{s['id']}/")
    ids[name] = s['id']
    print(name, s['id'], 'lensChain kept:', back['conditions'].get('lensChain', {}).get('id'), 'flag active:', (back.get('targeting_flag') or {}).get('active'))
json.dump(ids, open(sys.argv[3], 'w'))
