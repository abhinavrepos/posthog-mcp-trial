# Checks that a bundle arrived complete. Run by posthog-import.sh (phase verify) in a container of the
# NEW PostHog:  python manage.py shell < verify.py   (env TEAM_MAP, SOURCE_DB_NAME)
#
#   events    for every project, day and event name: the same number of distinct events as the old PostHog
#   persons   the same number of persons, in ClickHouse and in Postgres
#   replays   the same recordings with the same number of replay events, and every block each recording
#             points at exists in storage with the right size. Only names and sizes are checked: no replay
#             is opened or read
#   database  the same number of rows for each kind of thing (dashboards, insights, cohorts, flags ...)
# Prints RESULT: PASS or RESULT: FAIL.
import json
import os
import re
from collections import defaultdict

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from django.apps import apps
from django.db import connections

from posthog.clickhouse.client import sync_execute

TEAM_MAP = {int(k): int(v) for k, v in json.loads(os.environ["TEAM_MAP"]).items()}
B = "/migration/bundle/clickhouse"
problems = []


def check(ok, what):
    print(("  ok    " if ok else "  FAIL  ") + what, flush=True)
    if not ok:
        problems.append(what)


def tsv(name):
    path = os.path.join(B, name)
    return [l.rstrip("\n").split("\t") for l in open(path)] if os.path.exists(path) and os.path.getsize(path) else []


new_ids = list(TEAM_MAP.values())
print(f"projects old -> new: {TEAM_MAP}")

# ------------------------------------------------------------------ events
print("events")
want = defaultdict(int)
for team, day, event, _n, uniq in tsv("summary.events.tsv"):
    if int(team) in TEAM_MAP:
        want[(TEAM_MAP[int(team)], day, event)] = int(uniq)
got = {
    (t, str(d), e): n
    for t, d, e, n in sync_execute(
        "SELECT team_id, toDate(timestamp) AS d, event, uniqExact(uuid) FROM events WHERE team_id IN %(t)s GROUP BY team_id, d, event",
        {"t": new_ids},
    )
}
diff = [(k, want[k], got.get(k, 0)) for k in want if got.get(k, 0) != want[k]]
extra = [k for k in got if k not in want]
check(not diff, f"{sum(want.values())} events in {len(want)} (project, day, event) groups match" + (f"; {len(diff)} differ, e.g. {diff[:3]}" if diff else ""))
check(not extra, "no events here that the old PostHog did not have" + (f"; {len(extra)} extra groups, e.g. {extra[:3]}" if extra else ""))

# ------------------------------------------------------------------ persons
print("persons")
for team, n in tsv("summary.persons.tsv"):
    if int(team) not in TEAM_MAP:
        continue
    new = TEAM_MAP[int(team)]
    ch_n = sync_execute("SELECT uniqExact(id) FROM person WHERE team_id = %(t)s", {"t": new})[0][0]
    pg_n = connections["default"].cursor()
    pg_n.execute("SELECT count(*) FROM posthog_person WHERE team_id = %s", [new])
    pg_n = pg_n.fetchone()[0]
    check(ch_n == int(n), f"project {new}: {ch_n} persons in ClickHouse (old: {n})")
    check(pg_n >= int(n) * 0.999, f"project {new}: {pg_n} persons in Postgres (old ClickHouse: {n})")

# ------------------------------------------------------------------ replays
print("replays")
env = os.environ.get
s3 = boto3.client(
    "s3",
    endpoint_url=env("SESSION_RECORDING_V2_S3_ENDPOINT") or env("OBJECT_STORAGE_ENDPOINT"),
    aws_access_key_id=env("SESSION_RECORDING_V2_S3_ACCESS_KEY_ID") or env("OBJECT_STORAGE_ACCESS_KEY_ID"),
    aws_secret_access_key=env("SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY") or env("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    config=Config(signature_version="s3v4"),
    region_name="us-east-1",
)
sizes = {}


def size_of(bucket, key):
    if (bucket, key) not in sizes:
        try:
            sizes[(bucket, key)] = s3.head_object(Bucket=bucket, Key=key)["ContentLength"]
        except ClientError:
            sizes[(bucket, key)] = None
    return sizes[(bucket, key)]


URL = re.compile(r"^s3://([^/]+)/([^?]+)\?range=bytes=(\d+)-(\d+)$")
for team, sessions, events, blocks in tsv("summary.replays.tsv"):
    if int(team) not in TEAM_MAP:
        continue
    new = TEAM_MAP[int(team)]
    rows = sync_execute(
        "SELECT session_id, sum(event_count), groupArrayArray(block_urls) FROM session_replay_events WHERE team_id = %(t)s GROUP BY session_id",
        {"t": new},
    )
    check(len(rows) == int(sessions), f"project {new}: {len(rows)} recordings (old: {sessions})")
    check(sum(r[1] for r in rows) == int(events), f"project {new}: {sum(r[1] for r in rows)} replay events (old: {events})")
    missing = short = 0
    n_blocks = 0
    for _sid, _n, urls in rows:
        for u in urls:
            n_blocks += 1
            m = URL.match(u)
            if not m:
                continue
            size = size_of(m.group(1), m.group(2))
            if size is None:
                missing += 1
            elif size <= int(m.group(4)):
                short += 1
    check(n_blocks == int(blocks), f"project {new}: {n_blocks} replay blocks listed (old: {blocks})")
    check(missing == 0 and short == 0, f"project {new}: every replay block is in storage ({len(sizes)} files checked; missing {missing}, too short {short})")

# ------------------------------------------------------------------ database
print("database")
src = dict(connections.databases["default"])
src["NAME"] = env("SOURCE_DB_NAME", "migration_source")
connections.databases["migration_source"] = src
names = ["dashboard", "insight", "dashboardtile", "cohort", "featureflag", "experiment", "action", "annotation", "survey", "hogfunction", "notebook", "persondistinctid", "eventdefinition", "propertydefinition", "grouptypemapping", "exportedasset", "sessionrecordingplaylist"]
for name in names:
    try:
        m = apps.get_model("posthog", name)
    except LookupError:
        continue
    for old, new in TEAM_MAP.items():
        if not any(f.name == "team" for f in m._meta.fields):
            continue
        a = m._base_manager.using("migration_source").filter(team_id=old).count()
        b = m._base_manager.using("default").filter(team_id=new).count()
        if a or b:
            check(a == b, f"project {new}: {name} {b} (old: {a})")

print(f"RESULT: {'PASS' if not problems else 'FAIL'} ({len(problems)} problem(s))")
