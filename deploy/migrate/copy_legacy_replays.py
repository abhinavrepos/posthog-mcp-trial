# Copies folders of stored files into the replay store (SeaweedFS), where the new version reads them:
#   session_recording_batches/  replay blocks written by 2025 PostHog for projects with "legacy" replay
#                               retention; PostHog's migrate-storage-hobby never copies them to the replay
#                               store, so without this those recordings stay listed but no longer play
#                               (phase replays reads them straight from the old MinIO)
#   symbolsets/                 error tracking source maps, which cymbal reads from the replay store
#                               (migrate-storage-hobby copies them there only when run whole)
# Runs in the new PostHog's web container (it has both stores' settings). Copies bytes without reading
# them; files already there with the same size are skipped.
#
#   env PREFIXES         comma-separated folders to copy (default: both above)
#   env SOURCE_ENDPOINT  where to read them (default: the new general storage), with SOURCE_KEY and
#                        SOURCE_SECRET; posthog-upgrade.sh points it at a temporary MinIO on the old volume
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

env = os.environ.get
cfg = Config(signature_version="s3v4", retries={"max_attempts": 10}, max_pool_connections=32)
source = boto3.client(
    "s3",
    endpoint_url=env("SOURCE_ENDPOINT") or env("OBJECT_STORAGE_ENDPOINT"),
    aws_access_key_id=env("SOURCE_KEY") or env("OBJECT_STORAGE_ACCESS_KEY_ID"),
    aws_secret_access_key=env("SOURCE_SECRET") or env("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    config=cfg,
    region_name="us-east-1",
)
replays = boto3.client("s3", endpoint_url=env("SESSION_RECORDING_V2_S3_ENDPOINT"), aws_access_key_id=env("SESSION_RECORDING_V2_S3_ACCESS_KEY_ID"), aws_secret_access_key=env("SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY"), config=cfg, region_name="us-east-1")
src_bucket = env("OBJECT_STORAGE_BUCKET", "posthog")
dst_bucket = env("SESSION_RECORDING_V2_S3_BUCKET") or "posthog"
PREFIXES = [p for p in (env("PREFIXES") or "session_recording_batches/,symbolsets/").split(",") if p]

try:
    replays.head_bucket(Bucket=dst_bucket)
except ClientError:
    replays.create_bucket(Bucket=dst_bucket)

objs = [o for prefix in PREFIXES for page in source.get_paginator("list_objects_v2").paginate(Bucket=src_bucket, Prefix=prefix) for o in page.get("Contents", [])]
total_mb = sum(o["Size"] for o in objs) / 1e6
print(f"    {len(objs)} files under {', '.join(PREFIXES)} ({total_mb:.1f} MB)", flush=True)


def copy(o):
    try:
        if replays.head_object(Bucket=dst_bucket, Key=o["Key"])["ContentLength"] == o["Size"]:
            return "already there"
    except ClientError:
        pass
    body = source.get_object(Bucket=src_bucket, Key=o["Key"])["Body"].read()
    replays.put_object(Bucket=dst_bucket, Key=o["Key"], Body=body)
    if replays.head_object(Bucket=dst_bucket, Key=o["Key"])["ContentLength"] != o["Size"]:
        raise RuntimeError(f"size differs after copying {o['Key']}")
    return "copied"


results = {}
done = 0
last = time.time()
with ThreadPoolExecutor(16) as pool:
    for r in pool.map(copy, objs):
        results[r] = results.get(r, 0) + 1
        done += 1
        if time.time() - last >= 30:
            print(f"      ... {done} of {len(objs)} files", flush=True)
            last = time.time()
print(f"    {len(objs)} files: {results or 'none'}", flush=True)
sys.exit(0)
