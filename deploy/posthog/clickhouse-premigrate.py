#!/usr/bin/env python3
# Runs in PostHog's web container just before ./bin/migrate (compose/start). It adds columns that a
# PostHog ClickHouse migration needs before the later migration that adds them has run, so an upgraded
# stack does not crash-loop on "SELECT query outputs column with name 'X', which is not found in the
# target table".
#
# Known case: 0378_hobby_query_log_archive_v3_one_layer recreates ops_query_log_archive_v3_mv with
# log_comment, which only 0391_query_log_archive_log_comment adds. A stack whose archive tables come from
# an older PostHog (before 0391) never boots. The statements below are 0391's own, with ADD COLUMN IF NOT
# EXISTS, so 0391 still runs cleanly afterwards.
#
# Each statement runs only when its table exists and lacks the column, so on a new install (no tables yet)
# and on an up-to-date stack it does nothing. It never stops PostHog from starting: errors are printed and
# migrate runs as usual.
import os
import sys

FIXES = [
    # (table, column, definition after the column name): from PostHog's 0391_query_log_archive_log_comment.
    ("sharded_query_log_archive_v3", "log_comment",
     "SimpleAggregateFunction(max, String) TTL toDateTime(initial_query_start_time) + toIntervalMonth(1) AFTER lc_estimated_bytes"),
    ("writable_query_log_archive_v3", "log_comment", "SimpleAggregateFunction(max, String) AFTER lc_estimated_bytes"),
]


def main() -> int:
    try:
        from clickhouse_driver import Client
    except ImportError:
        print("[premigrate] clickhouse_driver not available, skipping", flush=True)
        return 0
    db = os.environ.get("CLICKHOUSE_DATABASE", "posthog")
    client = Client(
        host=os.environ.get("CLICKHOUSE_HOST", "clickhouse"),
        user=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
        database="default",
        connect_timeout=10,
        send_receive_timeout=120,
    )
    changed = 0
    for table, column, definition in FIXES:
        try:
            # The column it comes AFTER must exist too; otherwise this is an older layout PostHog migrates itself.
            after = definition.rsplit("AFTER ", 1)[-1].strip() if "AFTER " in definition else None
            cols = {r[0] for r in client.execute(
                "SELECT name FROM system.columns WHERE database = %(db)s AND table = %(t)s", {"db": db, "t": table})}
            if not cols or column in cols or (after and after not in cols):
                continue
            client.execute(f"ALTER TABLE {db}.{table} ADD COLUMN IF NOT EXISTS {column} {definition}")
            print(f"[premigrate] added {column} to {db}.{table} (needed by an earlier migration than the one that adds it)", flush=True)
            changed += 1
        except Exception as e:  # never block migrate
            print(f"[premigrate] {table}.{column}: {str(e).splitlines()[0][:300]}", flush=True)
    if not changed:
        print("[premigrate] nothing to add", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[premigrate] skipped: {str(e).splitlines()[0][:300]}", flush=True)
        sys.exit(0)
