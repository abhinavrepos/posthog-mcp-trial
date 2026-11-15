#!/usr/bin/env python3
"""Per question: wall time, turns, tool calls with duration and result size, errors, and the answer."""
import json, sys, glob, os

def load(path):
    rows = []
    for line in open(path):
        ts, _, raw = line.rstrip('\n').partition('\t')
        try: rows.append((float(ts), json.loads(raw)))
        except Exception: pass
    return rows

def analyse(path):
    rows = load(path)
    if not rows: return None
    start, calls, result = rows[0][0], {}, None
    for ts, ev in rows:
        if ev.get('type') == 'assistant':
            for c in ev.get('message', {}).get('content', []) or []:
                if c.get('type') == 'tool_use': calls[c['id']] = {'name': c['name'].replace('mcp__lens__', ''), 'input': c.get('input'), 'start': ts}
        elif ev.get('type') == 'user':
            for c in ev.get('message', {}).get('content', []) or []:
                if isinstance(c, dict) and c.get('type') == 'tool_result' and c.get('tool_use_id') in calls:
                    body = c.get('content')
                    text = ''.join(x.get('text', '') for x in body) if isinstance(body, list) else str(body or '')
                    k = calls[c['tool_use_id']]; k.update(end=ts, secs=round(ts - k['start'], 1), chars=len(text), error=bool(c.get('is_error')), head=text[:160].replace('\n', ' '))
        elif ev.get('type') == 'result': result = ev
    return {'id': os.path.basename(path)[:-6], 'wall_s': round(rows[-1][0] - start), 'turns': (result or {}).get('num_turns'),
            'subtype': (result or {}).get('subtype'), 'calls': list(calls.values()), 'answer': (result or {}).get('result', '')}

if __name__ == '__main__':
    tag = sys.argv[1]
    out = [a for a in (analyse(p) for p in sorted(glob.glob(os.path.join(os.environ.get('EVAL_DIR','./eval-runs'),'runs',f'{tag}-*.jsonl')))) if a]
    json.dump(out, open(os.path.join(os.environ.get('EVAL_DIR','./eval-runs'),f'{tag}-summary.json'), 'w'), indent=1)
    allcalls = [c for a in out for c in a['calls'] if 'secs' in c]
    print(f"{'question':10} {'wall':>6} {'turns':>5} {'calls':>5} {'max call':>9} {'slowest tool':24} {'errors':>6}")
    for a in out:
        done = [c for c in a['calls'] if 'secs' in c]
        slow = max(done, key=lambda c: c['secs'], default={'secs': 0, 'name': '-'})
        print(f"{a['id']:10} {a['wall_s']:>5}s {str(a['turns']):>5} {len(a['calls']):>5} {slow['secs']:>8}s {slow['name']:24} {sum(1 for c in done if c['error']):>6}  {a['subtype']}")
    print('\nTool calls over 30 s (close to a 60 s client limit) and over 60 s:')
    for c in sorted(allcalls, key=lambda c: -c['secs']):
        if c['secs'] >= 30: print(f"  {c['secs']:>6}s {'OVER 60s' if c['secs'] >= 60 else 'close':9} {c['name']:24} {json.dumps(c['input'])[:110]}")
    print('\nPer tool: calls, median s, max s, max chars, errors')
    by = {}
    for c in allcalls: by.setdefault(c['name'], []).append(c)
    for n, cs in sorted(by.items(), key=lambda x: -max(c['secs'] for c in x[1])):
        s = sorted(c['secs'] for c in cs)
        print(f"  {n:26} {len(cs):>3} {s[len(s)//2]:>7} {s[-1]:>7} {max(c['chars'] for c in cs):>8} {sum(c['error'] for c in cs):>3}")
    errs = [c for c in allcalls if c['error']]
    if errs:
        print('\nTool errors:')
        for c in errs: print(f"  {c['name']:24} {json.dumps(c['input'])[:90]} -> {c['head'][:150]}")
