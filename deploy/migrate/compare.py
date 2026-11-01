#!/usr/bin/env python3
# Compares the counts taken before and after an upgrade (counts.py). Prints every difference and
# RESULT: PASS or RESULT: FAIL. Exit code 0 only on PASS.
#
#   python3 compare.py before.json after.json [--no-replays]
# --no-replays: the replay files were not copied (posthog-upgrade.sh --no-replays); the replay metadata
# must still be complete, but the replay store is not checked.
import json
import re
import sys

NO_REPLAYS = "--no-replays" in sys.argv
before, after = (json.load(open(p)) for p in [a for a in sys.argv[1:] if not a.startswith("--")][:2])
problems = []


def check(ok, what):
    print(("  ok    " if ok else "  FAIL  ") + what)
    if not ok:
        problems.append(what)


def same(name, label):
    a, b = before.get(name, {}), after.get(name, {})
    diff = {k: (a.get(k), b.get(k)) for k in set(a) | set(b) if a.get(k) != b.get(k)}
    check(not diff, f"{label}: {sum(v for v in a.values() if isinstance(v, int))} before, {sum(v for v in b.values() if isinstance(v, int))} after" + (f"; {len(diff)} differ, e.g. {dict(list(diff.items())[:3])}" if diff else ""))


print("events, per project, day and event name")
same("events", "distinct events")
print("persons and groups")
same("persons", "persons")
same("groups", "groups")

print("replays")
for team, r in before.get("replays", {}).items():
    a = after.get("replays", {}).get(team, {})
    check(r == a, f"project {team}: {r['recordings']} recordings, {r['replay_events']} replay events, {r['blocks']} blocks before; after {a or 'none'}")
replay_store = after.get("storage", {}).get("replays", {})
if NO_REPLAYS:
    print(f"  skip  replay files not copied, as chosen: {len(before.get('replay_block_files', []))} files stay in the old MinIO volume")
missing = [u for u in before.get("replay_block_files", []) if u.split("/", 3)[3] not in replay_store]
NO_REPLAYS or check(not missing, f"every replay block file is in the replay store ({len(before.get('replay_block_files', []))} files)" + (f"; {len(missing)} missing, e.g. {missing[:3]}" if missing else ""))
# What the new replay reader (recording-api) accepts; it answers 400 to any other name.
READER = re.compile(r"^session_recordings/(30d|90d|1y|5y)/\d+-[0-9a-f]{16}$")
pointed = [u.split("/", 3)[3] for u in after.get("replay_block_files", [])]
unplayable = [k for k in pointed if not READER.match(k) or k not in replay_store]
NO_REPLAYS or check(not unplayable, f"every block a replay points at has a name the new replay reader accepts and is in the replay store ({len(pointed)} files)" + (f"; {len(unplayable)} not, e.g. {unplayable[:3]}" if unplayable else ""))

print("stored files")
REPLAY_PREFIXES = ("session_recordings/", "session_recordings_lts/", "session_recording_batches/")
general_before = {k: v for k, v in before.get("storage", {}).get("general", {}).items() if not k.startswith(REPLAY_PREFIXES + ("query_cache/",))}
general_after = after.get("storage", {}).get("general", {})
lost = [k for k, size in general_before.items() if general_after.get(k) != size]
check(not lost, f"every other stored file is in general storage with the same size ({len(general_before)} files)" + (f"; {len(lost)} missing or different, e.g. {lost[:3]}" if lost else ""))

print("database rows")
# Upgrades may add rows (new defaults, definitions); none may lose any.
for t, n in sorted(before.get("postgres", {}).items()):
    m = after.get("postgres", {}).get(t)
    if m is None:
        print(f"  note  {t}: gone in the new version (was {n} rows)")
        continue
    check(m >= n, f"{t}: {n} before, {m} after")

print(f"RESULT: {'PASS' if not problems else 'FAIL'} ({len(problems)} problem(s))")
sys.exit(0 if not problems else 1)
