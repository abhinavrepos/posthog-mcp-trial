# Copies replay blocks stored under session_recording_batches/ (written by 2025 PostHog for projects with
# "legacy" replay retention) from general storage into the replay store, where the new version reads
# them. PostHog's migrate-storage-hobby copies only session_recordings/ into the replay store, so
# without this those recordings stay listed but no longer play.
# Runs in the new PostHog's web container (it has both stores' settings). Copies bytes without reading
# them; files already there with the same size are skipped.
import os
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

env = os.environ.get
cfg = Config(signature_version="s3v4", retries={"max_attempts": 10}, max_pool_connections=32)
general = boto3.client("s3", endpoint_url=env("OBJECT_STORAGE_ENDPOINT"), aws_access_key_id=env("OBJECT_STORAGE_ACCESS_KEY_ID"), aws_secret_access_key=env("OBJECT_STORAGE_SECRET_ACCESS_KEY"), config=cfg, region_name="us-east-1")
replays = boto3.client("s3", endpoint_url=env("SESSION_RECORDING_V2_S3_ENDPOINT"), aws_access_key_id=env("SESSION_RECORDING_V2_S3_ACCESS_KEY_ID"), aws_secret_access_key=env("SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY"), config=cfg, region_name="us-east-1")
src_bucket = env("OBJECT_STORAGE_BUCKET", "posthog")
dst_bucket = env("SESSION_RECORDING_V2_S3_BUCKET") or "posthog"
PREFIX = "session_recording_batches/"

try:
    replays.head_bucket(Bucket=dst_bucket)
except ClientError:
    replays.create_bucket(Bucket=dst_bucket)

objs = [o for page in general.get_paginator("list_objects_v2").paginate(Bucket=src_bucket, Prefix=PREFIX) for o in page.get("Contents", [])]


def copy(o):
    try:
        if replays.head_object(Bucket=dst_bucket, Key=o["Key"])["ContentLength"] == o["Size"]:
            return "already there"
    except ClientError:
        pass
    body = general.get_object(Bucket=src_bucket, Key=o["Key"])["Body"].read()
    replays.put_object(Bucket=dst_bucket, Key=o["Key"], Body=body)
    if replays.head_object(Bucket=dst_bucket, Key=o["Key"])["ContentLength"] != o["Size"]:
        raise RuntimeError(f"size differs after copying {o['Key']}")
    return "copied"


results = {}
with ThreadPoolExecutor(16) as pool:
    for r in pool.map(copy, objs):
        results[r] = results.get(r, 0) + 1
print(f"    {len(objs)} files under {PREFIX}: {results or 'none'}")
