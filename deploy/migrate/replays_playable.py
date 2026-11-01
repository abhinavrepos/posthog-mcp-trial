# Fetches every block of every replay through the new replay reader (recording-api), the way the PostHog app
# does when someone watches a replay, and reports how many came back. Keeps only counts and byte totals; the
# bytes themselves are discarded unread.
#
#   python manage.py shell < replays_playable.py      (in the web container; posthog-upgrade.sh phase verify)
# Prints "PLAYABLE: <n> of <m> recordings, <a> of <b> blocks".
import asyncio
import json
import re
import urllib.parse
import urllib.request

import aiohttp
from django.conf import settings

from posthog.session_recordings.recordings.recording_api_client import RecordingApiClient

URL = re.compile(r"^s3://[^/]+/([^?]+)\?range=bytes=(\d+)-(\d+)$")


def ch(sql):
    q = urllib.parse.urlencode({"query": sql + " FORMAT JSONCompact", "database": "posthog", "output_format_json_quote_64bit_integers": 0})
    with urllib.request.urlopen(f"http://{settings.CLICKHOUSE_HOST}:8123/?{q}", timeout=600) as r:
        return json.loads(r.read())["data"]


rows = ch("SELECT team_id, session_id, groupArrayArray(block_urls) FROM session_replay_events GROUP BY team_id, session_id")


async def main():
    ok_blocks = bad_blocks = 0
    ok_recordings = 0
    total_bytes = 0
    failures = []
    sem = asyncio.Semaphore(32)
    async with aiohttp.ClientSession() as http:
        client = RecordingApiClient(http, settings.RECORDING_API_URL)

        async def one(team, sid, urls):
            nonlocal ok_blocks, bad_blocks, ok_recordings, total_bytes
            good = True
            for u in urls:
                m = URL.match(u)
                if not m:
                    bad_blocks += 1
                    good = False
                    continue
                async with sem:
                    try:
                        data = await client.fetch_block(m.group(1), int(m.group(2)), int(m.group(3)), sid, int(team), decompress=True)
                        total_bytes += len(data)
                        ok_blocks += 1
                    except Exception as e:  # noqa: BLE001
                        bad_blocks += 1
                        good = False
                        if len(failures) < 5:
                            failures.append(f"{sid}: {str(e)[:160]}")
            if good and urls:
                ok_recordings += 1

        await asyncio.gather(*(one(t, s, u) for t, s, u in rows))
    total_blocks = sum(len(u) for _, _, u in rows)
    print(f"PLAYABLE: {ok_recordings} of {len(rows)} recordings, {ok_blocks} of {total_blocks} blocks, {total_bytes / 1e6:.1f} MB")
    for f in failures:
        print(f"  failed: {f}")


asyncio.run(main())
