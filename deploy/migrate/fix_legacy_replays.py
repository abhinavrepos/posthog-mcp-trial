# Makes replays recorded by 2025 PostHog with "legacy" retention playable in the new version.
# Runs in the new PostHog's web container, after copy_legacy_replays.py has put their block files in the
# replay store. Copies bytes and rewrites names; never reads a replay's content.
#
# Why: 2025 PostHog stored these replays' blocks as session_recording_batches/<timestamp>-<hex>. The new
# replay reader (recording-api) only accepts session_recordings/<30d|90d|1y|5y>/<timestamp>-<hex> and answers
# 400 to anything else, so the recordings are listed but none of them play. The new version also treats a
# replay without retention_period_days as expiring 30 days after it started, hiding older ones.
#
# What it does, per project:
#   1. picks a retention period that keeps every legacy replay: the project's own setting if it covers the
#      oldest one, otherwise the shortest of 90d, 1y and 5y that does;
#   2. copies each block file to session_recordings/<period>/<same name> in the replay store (the original
#      stays);
#   3. points the replay metadata in ClickHouse at the new names and sets retention_period_days.
import json
import os
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import boto3
import psycopg2
from botocore.config import Config
from botocore.exceptions import ClientError

PERIODS = [("30d", 30), ("90d", 90), ("1y", 365), ("5y", 1825)]
LEGACY = "session_recording_batches/"
env = os.environ.get


def ch(sql, fmt="JSONCompact"):
    q = urllib.parse.urlencode({"query": f"{sql} FORMAT {fmt}" if fmt else sql, "database": "posthog", "output_format_json_quote_64bit_integers": 0, "mutations_sync": 2})
    req = urllib.request.Request(f"http://{env('CLICKHOUSE_HOST', 'clickhouse')}:8123/?{q}", data=b"" if not fmt else None)
    with urllib.request.urlopen(req, timeout=3600) as r:
        body = r.read()
        return json.loads(body)["data"] if fmt else body


s3 = boto3.client(
    "s3",
    endpoint_url=env("SESSION_RECORDING_V2_S3_ENDPOINT"),
    aws_access_key_id=env("SESSION_RECORDING_V2_S3_ACCESS_KEY_ID"),
    aws_secret_access_key=env("SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY"),
    config=Config(signature_version="s3v4", retries={"max_attempts": 10}, max_pool_connections=32),
    region_name="us-east-1",
)
bucket = env("SESSION_RECORDING_V2_S3_BUCKET") or "posthog"
db = psycopg2.connect(env("DATABASE_URL", "postgres://posthog:posthog@db:5432/posthog"))
cur = db.cursor()

rows = ch(
    "SELECT team_id, min(min_first_timestamp), uniqExact(session_id), groupUniqArrayArray(block_urls) FROM session_replay_events "
    f"WHERE arrayExists(u -> position(u, '/{LEGACY}') > 0, block_urls) GROUP BY team_id"
)
if not rows:
    print("    no legacy replays")
for team, oldest, sessions, urls in rows:
    cur.execute("SELECT session_recording_retention_period FROM posthog_team WHERE id = %s", [team])
    setting = (cur.fetchone() or ["30d"])[0]
    age = (ch(f"SELECT dateDiff('day', toDateTime64('{oldest}', 6, 'UTC'), now())")[0][0]) + 14  # two weeks to spare
    days = dict(PERIODS)
    period = setting if setting in days and days[setting] >= age else next((p for p, d in PERIODS if d >= age), "5y")
    files = sorted({re.sub(r"\?.*$", "", u).split(f"/{LEGACY}", 1)[1] for u in urls if f"/{LEGACY}" in u})

    def copy(name):
        old, new = f"{LEGACY}{name}", f"session_recordings/{period}/{name}"
        size = s3.head_object(Bucket=bucket, Key=old)["ContentLength"]
        try:
            if s3.head_object(Bucket=bucket, Key=new)["ContentLength"] == size:
                return "already there"
        except ClientError:
            pass
        s3.copy_object(Bucket=bucket, Key=new, CopySource={"Bucket": bucket, "Key": old})
        if s3.head_object(Bucket=bucket, Key=new)["ContentLength"] != size:
            raise RuntimeError(f"size differs after copying {old}")
        return "copied"

    results = {}
    with ThreadPoolExecutor(16) as pool:
        for r in pool.map(copy, files):
            results[r] = results.get(r, 0) + 1
    ch(
        f"ALTER TABLE sharded_session_replay_events UPDATE "
        f"block_urls = arrayMap(u -> replaceOne(u, '/{LEGACY}', '/session_recordings/{period}/'), block_urls), "
        f"retention_period_days = {days[period]} "
        f"WHERE team_id = {int(team)} AND arrayExists(u -> position(u, '/{LEGACY}') > 0, block_urls)",
        fmt=None,
    )
    left = ch(f"SELECT count() FROM session_replay_events WHERE team_id = {int(team)} AND arrayExists(u -> position(u, '/{LEGACY}') > 0, block_urls)")[0][0]
    if left:
        raise SystemExit(f"project {team}: {left} replay rows still point at {LEGACY}")
    print(f"    project {team}: {sessions} legacy replays (oldest {oldest[:10]}) kept for {period} (project setting {setting}); {len(files)} block files {results}; metadata updated")
