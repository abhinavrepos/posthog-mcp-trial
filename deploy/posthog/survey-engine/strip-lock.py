#!/usr/bin/env python3
"""Remove Signal's former survey lock (the @lens_surveys_* Caddy blocks) from compose files that copied it,
e.g. docker-compose.site.yml. Keeps everything else byte for byte; writes <file>.before-unlock first.
    python3 strip-lock.py docker-compose.site.yml [...]"""
import shutil, sys

def strip(text):
    out, skip, depth = [], False, 0
    for line in text.split('\n'):
        s = line.strip()
        if not skip and s.startswith('# Lens: in-app surveys are managed only in Lens'):
            skip, depth = True, 0
            continue
        if skip:
            if depth == 0 and not (s.startswith('@lens_surveys') or s.startswith('handle @lens_surveys')):
                skip = False
            else:
                depth += line.count('{') - line.count('}')
                continue
        out.append(line)
    return '\n'.join(out)

changed = 0
for path in sys.argv[1:]:
    text = open(path).read()
    if '@lens_surveys' not in text: continue
    new = strip(text)
    if '@lens_surveys' in new: sys.exit(f'{path}: lock found in an unexpected shape; not changed')
    shutil.copy2(path, path + '.before-unlock')
    open(path, 'w').write(new)
    changed += 1
    print(f'removed survey lock from {path}')
sys.exit(0 if changed or len(sys.argv) > 1 else 0)
