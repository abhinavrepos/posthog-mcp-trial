# Counts everything an upgrade must keep, so "before" and "after" can be compared. Runs inside the
# PostHog app container of either version (it has Python, boto3 and the storage settings), reading
# ClickHouse and Postgres over the network. Never reads the content of a replay or a file: only
# names, sizes and counts.
#
#   python /migration/counts.py > counts.json        env: STORES = "general" (old MinIO) or "both"
import json
import os
import sys
import urllib.parse
import urllib.request

import boto3
import psycopg2
from botocore.config import Config


def ch(sql):
    host = os.environ.get("CLICKHOUSE_HOST", "clickhouse")
    # 64-bit numbers come back as numbers, not strings.
    q = urllib.parse.urlencode({"query": sql + " FORMAT JSONCompact", "database": os.environ.get("CLICKHOUSE_DATABASE", "posthog"), "output_format_json_quote_64bit_integers": 0})
    with urllib.request.urlopen(f"http://{host}:8123/?{q}", timeout=600) as r:
        return json.loads(r.read())["data"]


out = {}
out["events"] = {f"{t}|{d}|{e}": int(n) for t, d, e, n in ch("SELECT team_id, toString(toDate(timestamp)), event, uniqExact(uuid) FROM events GROUP BY 1, 2, 3")}
out["persons"] = {str(t): int(n) for t, n in ch("SELECT team_id, uniqExact(id) FROM person WHERE NOT is_deleted GROUP BY team_id")}
out["groups"] = {str(t): int(n) for t, n in ch("SELECT team_id, uniqExact(group_type_index, group_key) FROM groups GROUP BY team_id")}
rows = ch("SELECT team_id, session_id, sum(event_count), groupArrayArray(block_urls) FROM session_replay_events GROUP BY team_id, session_id")
out["replays"] = {}
blocks = []
for t, sid, n, urls in rows:
    r = out["replays"].setdefault(str(t), {"recordings": 0, "replay_events": 0, "blocks": 0})
    r["recordings"] += 1
    r["replay_events"] += int(n)
    r["blocks"] += len(urls)
    blocks.extend(urls)
out["replay_block_files"] = sorted({u.split("?")[0] for u in blocks})

db = psycopg2.connect(os.environ.get("DATABASE_URL", "postgres://posthog:posthog@db:5432/posthog"))
cur = db.cursor()
TABLES = [
    "posthog_organization", "posthog_team", "posthog_user", "posthog_organizationmembership", "posthog_personalapikey",
    "posthog_dashboard", "posthog_dashboarditem", "posthog_dashboardtile", "posthog_cohort", "posthog_featureflag",
    "posthog_experiment", "posthog_action", "posthog_annotation", "posthog_survey", "posthog_hogfunction",
    "posthog_notebook", "posthog_person", "posthog_persondistinctid", "posthog_group", "posthog_grouptypemapping",
    "posthog_eventdefinition", "posthog_propertydefinition", "posthog_exportedasset", "posthog_sessionrecording",
    "posthog_sessionrecordingplaylist", "posthog_cohortpeople", "posthog_featureflaghashkeyoverride",
]
out["postgres"] = {}
for t in TABLES:
    cur.execute("SELECT to_regclass(%s)", [t])
    if cur.fetchone()[0]:
        cur.execute(f'SELECT count(*) FROM "{t}"')
        out["postgres"][t] = cur.fetchone()[0]

env = os.environ.get


def store(endpoint, key, secret, bucket):
    s3 = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=key, aws_secret_access_key=secret, config=Config(signature_version="s3v4"), region_name="us-east-1")
    files = {}
    try:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
            for o in page.get("Contents", []):
                files[o["Key"]] = o["Size"]
    except Exception as e:  # a store that does not exist yet
        print(f"note: could not list {endpoint}/{bucket}: {e}", file=sys.stderr)
    return files


out["storage"] = {"general": store(env("OBJECT_STORAGE_ENDPOINT", "http://objectstorage:19000"), env("OBJECT_STORAGE_ACCESS_KEY_ID", "object_storage_root_user"), env("OBJECT_STORAGE_SECRET_ACCESS_KEY", "object_storage_root_password"), env("OBJECT_STORAGE_BUCKET", "posthog"))}
if env("STORES") == "both":
    out["storage"]["replays"] = store(env("SESSION_RECORDING_V2_S3_ENDPOINT", "http://seaweedfs:8333"), env("SESSION_RECORDING_V2_S3_ACCESS_KEY_ID", "any"), env("SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY", "any"), env("SESSION_RECORDING_V2_S3_BUCKET") or "posthog")
json.dump(out, sys.stdout)
