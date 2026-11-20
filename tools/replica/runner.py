#!/usr/bin/env python3
"""Host-only orchestration. Uses only Python's standard library, curl and Docker Compose."""
import concurrent.futures
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

from sql import COLUMNS, ROOT, bounds, delete_day, maps, persons, select_day, team_id

POSTHOG = os.environ.get('POSTHOG_DIR', '/opt/posthog')
SOURCE = os.environ.get('REPLICA_SOURCE', 'http://127.0.0.1:18123/')
STATE = Path(os.environ.get('REPLICA_STATE_DIR', str(ROOT / '.state')))
STOP = threading.Event()
MUTEX = threading.Lock()


DELETE_LOCK = threading.Lock()

def log(message):
    print(f'[{dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}] {message}', flush=True)


def disk():
    free = shutil.disk_usage(POSTHOG).free
    if free < 25 * 1024**3:
        STOP.set()
        raise RuntimeError(f'STOP: only {free / 1024**3:.2f} GiB free on {POSTHOG}; need at least 25 GiB')


def command(sql):
    return ['docker','compose','exec','-T','clickhouse','clickhouse-client','-d','posthog','--max_memory_usage=1500000000','--max_insert_block_size=20000','-q',sql]


def ch(sql):
    return subprocess.check_output(command(sql), cwd=POSTHOG, text=True).strip()


def source(sql):
    req = urllib.request.Request(SOURCE, data=sql.encode())
    with urllib.request.urlopen(req, timeout=600) as res:
        return res.read().decode().strip()


def save(path, obj):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(obj, indent=2)+'\n')
    temp.replace(path)


def dates(state):
    first, end = dt.date.fromisoformat(state['start']), dt.date.fromisoformat(state['end'])
    return [(first+dt.timedelta(days=i)).isoformat() for i in range((end-first).days)]


def replay_filter(team):
    # Replays deliberately share dates and identities with the copied data. Preserve
    # their known event UUIDs during repairs and compare only the historical copy.
    path = ROOT / 'replays-manifest.json'
    if not path.exists():
        return ''
    manifest = json.loads(path.read_text())
    if manifest['team'] != team:
        return ''
    import uuid
    ids = [str(uuid.UUID(e['uuid'])) for session in manifest['sessions'] for e in session['events']]
    return " AND uuid NOT IN (" + ','.join("toUUID('"+v+"')" for v in ids) + ')' if ids else ''


def counts(team, state):
    pred = f"timestamp >= toDateTime('{state['start']}', 'UTC') AND timestamp < toDateTime('{state['end']}', 'UTC')"
    query = f"SELECT toDate(timestamp, 'UTC'), count() FROM {{table}} WHERE {pred} {{extra}} GROUP BY 1 FORMAT TSV"
    src = source(query.format(table='lab.events',extra=''))
    dst = ch(query.format(table='posthog.sharded_events',extra=f'AND team_id = {team}' + replay_filter(team)))
    def parse(s):
        return {line.split('\t')[0]:int(line.split('\t')[1]) for line in s.splitlines()}
    a,b = parse(src),parse(dst)
    return [(d,a.get(d,0),b.get(d,0)) for d in dates(state)]


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('load','verify'):
        raise SystemExit('Usage: runner.py load|verify TEAM_ID')
    mode, team = sys.argv[1], team_id(sys.argv[2])
    maps()
    STATE.mkdir(parents=True, exist_ok=True)
    lock = (STATE / f'team-{team}.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Another loader/verifier already holds this team lock')
    path = STATE / f'team-{team}.json'
    digest = hashlib.sha256(b''.join((ROOT / n).read_bytes() for n in ['clients.tsv','users.tsv','screens.tsv','sql.py'])).hexdigest()
    if path.exists():
        state = json.loads(path.read_text())
        if state['fingerprint'] != digest or state['source'] != SOURCE:
            raise SystemExit('Map/SQL/source changed since loading began. Restore them or use a new project and state directory.')
    else:
        if mode == 'verify':
            raise SystemExit('No frozen load state; run load-year.sh first')
        last = dt.date.fromisoformat(source("SELECT toDate(max(timestamp), 'UTC') FROM lab.events FORMAT TSV"))
        state = dict(start=(last-dt.timedelta(days=364)).isoformat(), end=(last+dt.timedelta(days=1)).isoformat(), fingerprint=digest, source=SOURCE, done=[])
        save(path,state)
    log(f"{mode.upper()} team {team}; UTC [{state['start']}, {state['end']}); resume {path}; source {SOURCE}")
    if mode == 'load':
        disk()
        schema = json.loads(ch('DESCRIBE TABLE posthog.sharded_events FORMAT JSON'))['data']
        types = {row['name']:row['type'] for row in schema}
        for col in COLUMNS:
            if col not in types:
                raise RuntimeError(f'Missing target column {col}')
        # Fail before any deletion if source IDs cannot be mapped. Scan only the frozen year.
        _,users,_ = maps()
        keys = ','.join("'"+a+'|'+b+"'" for a,b,c in users)
        client_keys = ','.join("'" + c + "'" for c in {line.split('\t')[0] for line in (ROOT / 'clients.tsv').read_text().splitlines() if line})
        unknown = source(f"SELECT count() FROM lab.events WHERE timestamp >= toDateTime('{state['start']}', 'UTC') AND timestamp < toDateTime('{state['end']}', 'UTC') AND splitByChar('|', distinct_id)[3] NOT IN ({client_keys}) FORMAT TSV")
        if int(unknown):
            raise RuntimeError(f'{unknown} source rows have unmapped identities; nothing deleted')
        def load(day):
            if STOP.is_set():
                return
            for attempt in range(1,4):
                if STOP.is_set():
                    return
                disk()
                try:
                    log(f'{day}: attempt {attempt}/3, DELETE synchronously then INSERT Native')
                    with DELETE_LOCK:  # this ClickHouse allows one unfinished mutation: deletes run one at a time
                        ch(delete_day(team,day,replay_filter(team)))
                    query = select_day(team,day,state['end'],types)
                    # Separate processes preserve streaming and check BOTH exit statuses (pipefail).
                    producer = subprocess.Popen(['curl','--fail-with-body','-sS','--max-time','7200',SOURCE,'--data-binary',query], stdout=subprocess.PIPE)
                    try:
                        consumer = subprocess.Popen(command(f"INSERT INTO sharded_events ({','.join(COLUMNS)}) FORMAT Native"), cwd=POSTHOG, stdin=producer.stdout)
                        producer.stdout.close()
                        while consumer.poll() is None:
                            try:
                                disk()
                                if STOP.is_set():
                                    raise RuntimeError('Another lane failed; stopping this insertion')
                            except Exception:
                                consumer.terminate()
                                producer.terminate()
                                consumer.wait()
                                raise
                            time.sleep(2)
                        destination_status = consumer.returncode
                        if destination_status and producer.poll() is None:
                            producer.terminate()
                        source_status = producer.wait(timeout=30)
                    finally:
                        if producer.poll() is None:
                            producer.terminate()
                        producer.wait()
                    if source_status or destination_status:
                        raise RuntimeError(f'pipeline source={source_status} target={destination_status}')
                    expected = int(source(f'SELECT count() FROM lab.events WHERE {bounds(day)} FORMAT TSV'))
                    actual = int(ch(f'SELECT count() FROM sharded_events WHERE team_id={team} AND {bounds(day)}{replay_filter(team)} FORMAT TSV'))
                    if expected != actual:
                        raise RuntimeError(f'count mismatch source={expected} target={actual}')
                    disk()
                    with MUTEX:
                        state['done'].append(day)
                        state['done'].sort()
                        save(path,state)
                    log(f'{day}: DONE, {actual:,} rows (exact match)')
                    return
                except Exception as exc:
                    log(f'{day}: FAILED: {exc}')
                    if attempt == 3 or STOP.is_set():
                        STOP.set()
                        raise
        pending = [d for d in dates(state) if d not in state['done']]
        log(f'{len(pending)} days pending; exactly 3 parallel lanes; memory cap 1.5 GB per insertion')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(load,d) for d in pending]
            for future in concurrent.futures.as_completed(futures):
                future.result()
        if STOP.is_set():
            raise RuntimeError('Load stopped; rerun to resume')
        for query in persons(team):
            disk()
            log('Filling missing person keys from sharded_events (GROUP BY distinct_id)')
            ch(query)
    mismatches = []
    for day,a,b in counts(team,state):
        if a != b:
            mismatches.append(day)
            log(f'MISMATCH {day}: source={a} target={b}')
    if mismatches:
        # Make a subsequent load repair even previously completed days that changed externally.
        state['done'] = [d for d in state['done'] if d not in mismatches]
        save(path,state)
        raise RuntimeError(f'{len(mismatches)} mismatched days; marked pending for next load')
    log('PASS: all 365 daily counts equal the source exactly')

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        log(f'FATAL: {exc}')
        sys.exit(1)
