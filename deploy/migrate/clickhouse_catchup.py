#!/usr/bin/env python3
# Runs PostHog's ClickHouse migrations on a ClickHouse that is far behind, adding columns early where an
# old migration needs them. Run by posthog-upgrade.sh in the PostHog folder; prints what it changed.
#
# Why: many of PostHog's ClickHouse migrations drop a materialized view, alter its table, and recreate the
# view with today's definition, not the one of their time. On a ClickHouse migrated only to September 2025
# (0139), migration 0140 recreates the replay view with columns that migrations from 2026 add later
# (is_deleted from 0210, the ai_* columns...), and stops: "SELECT query outputs column with name 'X',
# which is not found in the target table". Each time that happens, this adds the column, with the exact
# definition PostHog's own later migration uses (its "ADD COLUMN IF NOT EXISTS X ..."), to the view's
# table family (writable_X, sharded_X, X), then runs the migrations again. The later migration then finds
# the column already there, which PostHog's IF NOT EXISTS allows.
import json
import os
import re
import subprocess
import sys

SRC = os.environ.get("POSTHOG_SRC", "posthog")
STATE = os.environ.get("STATE_DIR", "upgrade-state")
MAX_ROUNDS = 60
MISSING = re.compile(r"column with name '([^']+)', which is not found in the target table")
# ClickHouse creates its system log tables (crash_log, ...) on first write; a server that was just upgraded
# may not have them yet, and PostHog's metrics views read them. SYSTEM FLUSH LOGS creates them.
NO_SYSTEM_TABLE = re.compile(r"Unknown table expression identifier 'system\.([a-z_]+)'")
TARGET = re.compile(r"TO\s+(?:`?posthog`?\.)?`?([A-Za-z0-9_]+)`?")


sys.stdout.reconfigure(line_buffering=True)


def sh(*args, input=None):
    return subprocess.run(args, capture_output=True, text=True, input=input, stdin=None if input is not None else subprocess.DEVNULL)


def ch(sql):
    r = sh("docker", "compose", "exec", "-T", "clickhouse", "clickhouse-client", "-d", "posthog", "-q", sql)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:500])
    return r.stdout.strip()


def definition(col):
    """The type and default PostHog's own migrations give this column: the text after ADD COLUMN IF NOT EXISTS."""
    pat = re.compile(r"ADD COLUMN IF NOT EXISTS\s+`?" + re.escape(col) + r"`?\s+")
    found = []
    for root, _, files in os.walk(SRC):
        if "node_modules" in root or "/frontend" in root:
            continue
        for f in files:
            if not f.endswith(".py"):
                continue
            text = open(os.path.join(root, f), encoding="utf-8", errors="ignore").read()
            for m in pat.finditer(text):
                i, depth, out = m.end(), 0, []
                while i < len(text):
                    c = text[i]
                    if c in "([":
                        depth += 1
                    elif c in ")]":
                        if depth == 0:
                            break
                        depth -= 1
                    elif depth == 0 and c in ",\n\"'":
                        break
                    out.append(c)
                    i += 1
                d = "".join(out).strip()
                if d:
                    found.append(d)
    found = sorted(set(found), key=len, reverse=True)
    return found[0] if found else None


def family(target):
    base = re.sub(r"^(writable|sharded)_", "", target)
    names = [f"writable_{base}", f"sharded_{base}", base]
    existing = set(ch("SELECT name FROM system.tables WHERE database = 'posthog'").split())
    return [n for n in names if n in existing]


added = []
ch("SYSTEM FLUSH LOGS")
for round_ in range(1, MAX_ROUNDS + 1):
    # Written as it runs, so posthog-upgrade.sh can show which migration is running.
    log = os.path.join(STATE, f"clickhouse-migrate-{round_}.log")
    with open(log, "w") as f:
        rc = subprocess.run(
            ["docker", "compose", "run", "--rm", "-T", "--no-deps", "-e", "SKIP_ASYNC_MIGRATIONS_SETUP=1", "-e", "PYTHONUNBUFFERED=1", "web", "python", "manage.py", "migrate_clickhouse"],
            stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        ).returncode
    out = open(log, encoding="utf-8", errors="replace").read()
    if rc == 0:
        print(f"ClickHouse migrations finished (round {round_}).")
        break
    if NO_SYSTEM_TABLE.search(out):
        ch("SYSTEM FLUSH LOGS")
        if NO_SYSTEM_TABLE.search(out).group(1) not in ch("SELECT name FROM system.tables WHERE database = 'system'").split():
            sys.exit(f"ClickHouse has no system.{NO_SYSTEM_TABLE.search(out).group(1)} table, even after SYSTEM FLUSH LOGS; check its config.")
        print(f"  round {round_}: created system.{NO_SYSTEM_TABLE.search(out).group(1)} (SYSTEM FLUSH LOGS)")
        continue
    m = MISSING.search(out)
    if not m:
        tail = "\n".join(l for l in out.splitlines() if "Exception" in l or "Error" in l)[-1500:]
        sys.exit(f"ClickHouse migrations failed for another reason (see {STATE}/clickhouse-migrate-{round_}.log):\n{tail}")
    col = m.group(1)
    failing = out[: m.start()]
    t = TARGET.findall(failing)
    if not t:
        sys.exit(f"Could not tell which table the view writes to; see {STATE}/clickhouse-migrate-{round_}.log")
    d = definition(col)
    if not d:
        sys.exit(f"No later PostHog migration adds column {col}; see {STATE}/clickhouse-migrate-{round_}.log")
    tables = family(t[-1])
    for tbl in tables:
        ch(f"ALTER TABLE posthog.`{tbl}` ADD COLUMN IF NOT EXISTS `{col}` {d}")
    added.append({"column": col, "definition": d, "tables": tables})
    print(f"  round {round_}: added {col} {d} to {', '.join(tables)}")
else:
    sys.exit(f"Still failing after {MAX_ROUNDS} rounds.")

json.dump(added, open(os.path.join(STATE, "clickhouse-added-columns.json"), "w"), indent=2)
print(f"{len(added)} column(s) added early: {', '.join(a['column'] for a in added) or 'none'}")
