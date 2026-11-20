"""Pure SQL builders shared by the loader and its tests. No network on import."""
from pathlib import Path
import datetime as dt
import re

ROOT = Path(__file__).resolve().parent
COLUMNS = 'uuid event properties timestamp team_id distinct_id elements_chain created_at person_id person_created_at person_properties _timestamp _offset inserted_at'.split()


def quote(value):
    return "'" + str(value).replace('\\', '\\\\').replace("'", "\\'") + "'"


def maps():
    clients = [line.split('\t') for line in (ROOT / 'clients.tsv').read_text().splitlines()]
    users = [line.split('\t') for line in (ROOT / 'users.tsv').read_text().splitlines()]
    screens = [line.split('\t') for line in (ROOT / 'screens.tsv').read_text().splitlines()]
    assert len(clients) == 150 and len(dict(clients)) == 150 and len({r[1] for r in clients}) == 150
    assert {r[0] for r in clients} == {f'C{i:02}' for i in range(1,151)}
    assert dict(clients)['C01'] == 'SEM' and {'SEM','RIB','TR01'} <= {r[1] for r in clients}
    assert len(users) == 900
    for client, code in clients:
        rows = [r for r in users if r[0] == client]
        assert {r[1] for r in rows} == {f'user{i}' for i in range(1,7)} and len({r[2] for r in rows}) == 6
        assert all(re.fullmatch('[A-Z][A-Z0-9]*', r[2]) for r in rows)
    assert ('C01','user1','SEMOPS') in [tuple(r) for r in users]
    assert len(screens) == 41 and len(dict(screens)) == 41 and len({r[1] for r in screens}) == 41
    assert {r[0] for r in screens} == {'DlgList'} | {f'DlgTask{i:02}' for i in range(1,41)}
    return clients, users, screens


def team_id(value):
    if not re.fullmatch('[1-9][0-9]*', str(value)):
        raise ValueError('team_id must be a positive integer')
    return int(value)


def bounds(day):
    start = dt.date.fromisoformat(day)
    return f"timestamp >= toDateTime({quote(start)}, 'UTC') AND timestamp < toDateTime({quote(start + dt.timedelta(days=1))}, 'UTC')"


def transform(expr, pairs):
    return f"transform({expr}, [{','.join(quote(a) for a,b in pairs)}], [{','.join(quote(b) for a,b in pairs)}], {expr})"


def select_day(team, day, end, types):
    team = team_id(team)
    clients, users, screens = maps()
    end = dt.date.fromisoformat(end)  # exclusive upper boundary of frozen year
    screen_aliases = screens + [('List', 'Deal List')] + [(f'Task{i}', name) for i, (_,name) in enumerate(screens[1:],1)] + [(f'Task{i:02}', name) for i, (_,name) in enumerate(screens[1:],1) if i < 10]
    exprs = dict(uuid='src.uuid', event='src.event', properties='rewritten_properties', timestamp='src.timestamp', team_id=str(team), distinct_id='rewritten_id', elements_chain="''", created_at='src.timestamp', person_id="reinterpretAsUUID(MD5(rewritten_id))", person_created_at='src.timestamp', person_properties="'{}'", _timestamp='src.timestamp', _offset='0', inserted_at='src.timestamp')
    casts = ',\n'.join(f'CAST({exprs[c]} AS {types[c]}) AS `{c}`' for c in COLUMNS)
    return f"""WITH
splitByChar('|', src.distinct_id)[3] AS source_client,
splitByChar('|', src.distinct_id)[4] AS source_user,
{transform('source_client', clients)} AS client_code,
transform(concat(source_client, '|', source_user), [{','.join(quote(a+'|'+b) for a,b,c in users)}], [{','.join(quote(c) for a,b,c in users)}], upper(replaceRegexpAll(splitByChar('@', source_user)[1], '[^A-Za-z0-9]', ''))) AS user_handle,
concat('C1DEV|01|', client_code, '|', user_handle) AS rewritten_id,
JSONExtractString(src.properties, 'dialog_id') AS dialog,
JSONExtractString(src.properties, 'dialog_name') AS old_screen,
JSONExtractString(src.properties, 'tab_name') AS old_tab,
{transform('dialog', screens)} AS screen,
if(dialog IN [{','.join(quote(a) for a,b in screens)}], screen, {transform('old_screen', screen_aliases)}) AS new_screen,
{transform('old_tab', screen_aliases)} AS new_tab,
if(src.timestamp >= toDateTime({quote(end-dt.timedelta(days=60))}, 'UTC'), 'REVAL 27.0.0', if(src.timestamp >= toDateTime({quote(end-dt.timedelta(days=180))}, 'UTC'), 'REVAL 26.2.0', 'REVAL 26.1.0')) AS release_title,
JSONMergePatch(src.properties, concat('{{"client_id":null,"dialog_name":', toJSONString(new_screen), ',"tab_name":', toJSONString(new_tab), ',"title":', toJSONString(release_title), ',"$session_id":', toJSONString(src.`$session_id`), '}}')) AS rewritten_properties
SELECT {casts}
FROM lab.events AS src WHERE {bounds(day)} SETTINGS max_block_size=20000, prefer_column_name_to_alias=1 FORMAT Native"""


def delete_day(team, day, preserve=''):
    return f'ALTER TABLE posthog.sharded_events DELETE WHERE team_id = {team_id(team)} AND {bounds(day)}{preserve} SETTINGS mutations_sync=2'


def persons(team):
    team = team_id(team)
    # One row per distinct id. Excluding existing active keys makes repeated completion safe.
    common = f'FROM posthog.sharded_events WHERE team_id = {team} GROUP BY distinct_id'
    return [f"""INSERT INTO posthog.person_distinct_id2 (team_id, distinct_id, person_id, is_deleted, version, _timestamp, _offset, _partition)
SELECT {team}, distinct_id, any(person_id), 0, 1, now(), 0, '0' {common}
HAVING distinct_id NOT IN (SELECT distinct_id FROM posthog.person_distinct_id2 FINAL WHERE team_id = {team} AND is_deleted = 0)""",
f"""INSERT INTO posthog.person (id, created_at, team_id, properties, is_identified, is_deleted, version, _timestamp, _offset)
SELECT any(person_id), min(timestamp), {team}, '{{}}', 1, 0, 1, now(), 0 {common}
HAVING any(person_id) NOT IN (SELECT id FROM posthog.person FINAL WHERE team_id = {team} AND is_deleted = 0)"""]
