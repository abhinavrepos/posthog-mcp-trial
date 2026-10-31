# Uploads the stored files from a bundle (replays, exports, uploads) into this PostHog's storage.
# Run by posthog-import.sh in a container of the NEW PostHog, which already has the storage settings.
#
# Where each file goes:
#   session_recordings/team_id/<id>/...  older replay files, one folder per project: the project id in
#                                        the path is changed to the new one; general storage
#   session_recordings/...               replay blocks (the replay store, SESSION_RECORDING_V2_S3_*);
#                                        replay metadata points at these by name, so names are kept
#   anything else                        general storage (OBJECT_STORAGE_*), same name
# Files already there with the same size are skipped, so it can be run again.
import json
import os
import re
import sys
import tarfile
import time
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

TEAM_MAP = {int(k): int(v) for k, v in json.loads(os.environ["TEAM_MAP"]).items()}
cfg = Config(signature_version="s3v4", retries={"max_attempts": 10}, max_pool_connections=32)
env = os.environ.get


def client(endpoint, key, secret):
    return boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=key, aws_secret_access_key=secret, config=cfg, region_name=env("SESSION_RECORDING_V2_S3_REGION") or "us-east-1")


general = (client(env("OBJECT_STORAGE_ENDPOINT", "http://objectstorage:19000"), env("OBJECT_STORAGE_ACCESS_KEY_ID"), env("OBJECT_STORAGE_SECRET_ACCESS_KEY")), env("OBJECT_STORAGE_BUCKET", "posthog"))
replays = (
    client(env("SESSION_RECORDING_V2_S3_ENDPOINT") or env("OBJECT_STORAGE_ENDPOINT"), env("SESSION_RECORDING_V2_S3_ACCESS_KEY_ID") or env("OBJECT_STORAGE_ACCESS_KEY_ID"), env("SESSION_RECORDING_V2_S3_SECRET_ACCESS_KEY") or env("OBJECT_STORAGE_SECRET_ACCESS_KEY")),
    env("SESSION_RECORDING_V2_S3_BUCKET") or "posthog",
)
for c, b in (general, replays):
    try:
        c.head_bucket(Bucket=b)
    except ClientError:
        c.create_bucket(Bucket=b)

OLD_LAYOUT = re.compile(r"^(session_recordings/team_id/)(\d+)(/.*)$")


def destination(name):
    m = OLD_LAYOUT.match(name)
    if m:
        return general, f"{m.group(1)}{TEAM_MAP.get(int(m.group(2)), int(m.group(2)))}{m.group(3)}", "older replay files"
    if name.startswith("session_recordings/"):
        return replays, name, "replay blocks"
    return general, name, "other files"


counts = {}


def upload(item):
    (c, bucket), key, kind, data = item
    try:
        if c.head_object(Bucket=bucket, Key=key)["ContentLength"] == len(data):
            return kind, "already there"
    except ClientError:
        pass
    c.put_object(Bucket=bucket, Key=key, Body=data)
    return kind, "uploaded"


t0 = time.time()
folder = "/migration/bundle/storage"
for tar_name in sorted(os.listdir(folder)):
    if not tar_name.endswith(".tar"):
        continue
    batch = []
    with tarfile.open(os.path.join(folder, tar_name), "r|") as tar, ThreadPoolExecutor(16) as pool:
        futures = []
        for member in tar:
            if not member.isfile():
                continue
            data = tar.extractfile(member).read()
            dest, key, kind = destination(member.name)
            futures.append(pool.submit(upload, (dest, key, kind, data)))
            if len(futures) >= 256:
                for f in futures:
                    k, r = f.result()
                    counts[(k, r)] = counts.get((k, r), 0) + 1
                futures = []
        for f in futures:
            k, r = f.result()
            counts[(k, r)] = counts.get((k, r), 0) + 1
    print(f"  {tar_name}: done ({time.time() - t0:.0f}s)", flush=True)

for (kind, result), n in sorted(counts.items()):
    print(f"  {kind}: {n} {result}")
with open("/migration/state/storage.json", "w") as fh:
    json.dump({f"{k} {r}": n for (k, r), n in counts.items()}, fh, indent=2)
