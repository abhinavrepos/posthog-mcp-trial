#!/usr/bin/env python3
# Compares the counts taken before and after an upgrade (counts.py). Prints every difference and
# RESULT: PASS or RESULT: FAIL. Exit code 0 only on PASS.
#
#   python3 compare.py before.json after.json
import json
import sys

before, after = (json.load(open(p)) for p in sys.argv[1:3])
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
missing = [u for u in before.get("replay_block_files", []) if u.split("/", 3)[3] not in replay_store]
check(not missing, f"every replay block file is in the replay store ({len(before.get('replay_block_files', []))} files)" + (f"; {len(missing)} missing, e.g. {missing[:3]}" if missing else ""))

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
