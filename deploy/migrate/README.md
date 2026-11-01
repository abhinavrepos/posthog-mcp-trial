# Upgrading the production PostHog (September 2025 → October 2026)

Production runs the self-hosted ("hobby") PostHog from 3 September 2025 (commit `1a237ef8`), with MinIO for
file storage. `posthog-upgrade.sh` upgrades it **in place, on top of its own data**, to exactly the version
this team runs and tested (commit `c08ecdbe`, every image pinned by digest in `versions/`). It follows
PostHog's own `bin/upgrade-hobby` step by step, without questions, with a full backup, a before/after
check of everything, and fixes for the problems the rehearsal found in PostHog's script (below).

## What you need on the production machine

- Root (or sudo), Docker with compose, `git`, `python3`, and internet access to Docker Hub, ghcr.io and GitHub.
- Free disk: about twice the size of the data volumes plus 30 GB (the script checks and says how much).
  With a VM snapshot you can skip the volume backup (`SKIP_VOLUME_BACKUP=1`) and need far less.
- The MinIO image already on the machine (`docker images | grep minio`). MinIO no longer publishes it; if it
  is missing, build it from `minio-image/` (see the Dockerfile there).
- A maintenance window. Events must stop arriving while it runs (the apps' events are not lost if their
  SDKs retry, but plan as if they are).

## Steps

```bash
# 1. Copy this repository's deploy/ folder to the machine, for example to /root/deploy
# 2. Stop the apps that send events to PostHog
# 3. In the PostHog folder (the one with docker-compose.yml and .env):
cd /root            # or wherever PostHog was installed
sudo /root/deploy/migrate/posthog-upgrade.sh
```

It runs phase after phase and stops at the first problem. Running it again continues where it stopped.
The output is also written to `upgrade-state/upgrade.log`.

| Phase | What happens | Rehearsal time |
| --- | --- | --- |
| 1 check | versions, volumes, free disk, MinIO image; refuses to start while events still arrive | 1 min |
| 2 before | counts of everything that must survive: events per day and name, persons, groups, replays, files, rows | 1 min |
| 3 backup | `pg_dumpall`, the install's files, and every Docker volume of the install (ZooKeeper included) | 1 min |
| 4 source | PostHog's source at the pinned commit, in `./posthog` | 1 min |
| 5 configure | `.env` and compose files as `upgrade-hobby` writes them, plus the pinned images | seconds |
| 6 pull | the pinned images | 5–10 min |
| 7 postgres | Postgres 12 → 15: new volume, restore the dump, before anything else starts | 1 min |
| 8 stone | Django migrations of the last PostHog before its migration squash (problem 3) | 45 min |
| 9 clickhouse | the new version's database and ClickHouse migrations (problems 4 and 5) | 37 min |
| 10 start | PostHog starts through `../posthog/scale.sh` | 7 min |
| 11 storage | MinIO → SeaweedFS with PostHog's `migrate-storage-hobby`, and the legacy replays (problems 6–8) | 1 min |
| 12 verify | counts compared with phase 2, then every replay fetched through the new replay reader | 1 min |

The rehearsal had 1,027,745 events, 1,000 replays, 31,000 persons and 300 groups, and took 1 hour 30 minutes
in total, start to `RESULT: PASS`. Most of it is migrations, whose time depends mostly on how many there
are, not on the amount of data, so production should take a similar time plus the backup and the copying
of its larger files.

The final rehearsal ran from the pre-upgrade backup with no manual steps and ended with:

```
RESULT: PASS (0 problem(s))       events 1,027,745 = 1,027,745 · persons 31,497 · groups 300 · every table equal
PLAYABLE: 1000 of 1000 recordings, 17698 of 17698 blocks, 398.5 MB
```

and afterwards the old admin password, the old personal API key and the same project token all worked,
and every dashboard loaded with fresh results.

When it prints `RESULT: PASS`, start the apps again and check a few dashboards and replays.

## If something goes wrong

```bash
sudo /root/deploy/migrate/posthog-upgrade.sh rollback
docker compose up -d
```

This puts back the install's files and **every** volume exactly as they were before phase 3 (rehearsed),
and removes volumes the new version created. Without volume backups, restore the VM snapshot instead.

## PostHog problems this script works around

Each was found by rehearsing on a copy of production (the 2025 version with a million events, 1,000 replays
in MinIO, persons, groups, cohorts, flags, insights and dashboards). Without these, PostHog's own upgrade
path leaves the instance either not starting or with replays that do not play.

1. **The Postgres 12 → 15 step removes the wrong volume.** `upgrade-hobby` runs `docker volume rm
   postgres-data`, but compose names the volume `<project>_postgres-data`, so nothing is removed and
   Postgres 15 refuses to start on Postgres 12 files. The script removes the real volume.
2. **The Postgres restore runs after PostHog has started.** The web container first builds an empty
   database, which the restore then has to drop while it is in use. The script restores first.
3. **The new version's database migrations cannot run on a 2025 database.** PostHog squashed its migrations
   on 8 September 2026, 68 products included. Products a 2025 database never had are installed from their
   squashed migration, which needs migrations from September 2026 that in turn need those products' tables.
   The migrations stop (`InvalidBasesError` for `ee.EnterpriseEventDefinition` at `posthog.1019`, then a
   missing `posthog_conversations_ticket` table at `posthog.1032`) and PostHog never starts. The script
   first runs the Django migrations of the last version before the squash (commit `3ae7a3ca`), the path
   continuously upgraded installs took; the target then finishes normally.
4. **ClickHouse migration 0140 stops on columns from the future.** Many ClickHouse migrations drop a view
   and recreate it with today's definition, not the one of their time. From migration 0139 (where 2025 left
   it), 0140 recreates the replay view with six columns that only 2026 migrations add (`is_deleted`,
   `ai_tags_fixed`, `ai_tags_freeform`, `ai_highlighted`, `surfacing_score`, `snapshot_mode_v2`).
   `clickhouse_catchup.py` adds each such column first, with the definition PostHog's own later migration
   uses; that migration then finds it there (`IF NOT EXISTS`).
5. **A metrics view needs `system.crash_log`,** which ClickHouse creates only when it first writes to it.
   The catch-up runs `SYSTEM FLUSH LOGS`.
6. **`migrate-storage-hobby` stops at the first bucket 2025 never had** (`ai-blobs`) and copies nothing after
   it, replays included. The script runs it one service at a time and skips missing buckets.
7. **Replays of "legacy retention" projects do not play.** 2025 stored their blocks as
   `session_recording_batches/<timestamp>-<hex>`. `migrate-storage-hobby` does not copy them to the replay
   store, and the new replay reader refuses that name anyway (it accepts only
   `session_recordings/<30d|90d|1y|5y>/...`): all replays were listed, none played. The script copies them,
   gives them an accepted name with a retention period that keeps every one of them, and updates their
   metadata in ClickHouse. Then it fetches every block of every replay through the new reader.
8. **Replays older than 30 days would disappear.** The new version treats a replay without a retention period
   as expiring 30 days after it started. The period set in problem 7 covers the oldest legacy replay.
9. **The Node image on Docker Hub is seven months old**, and the new version also needs settings and a
   database the hobby files do not provide. `../posthog/scale.sh` uses the current image (pinned) and adds
   them; the upgraded PostHog is started through it, so no service runs the stale image.
10. **A backup without ZooKeeper cannot be restored.** ClickHouse's replicated tables keep part of their
    state in ZooKeeper; restoring ClickHouse alone left 999 data parts set aside as broken. The backup takes
    every volume, and the rollback was rehearsed: all data back, nothing detached.

## Files

| File | What |
| --- | --- |
| `posthog-upgrade.sh` | the upgrade, in phases |
| `versions/` | the exact versions: commit and image digests (`pin-versions.sh` writes them on the tested machine) |
| `counts.py`, `compare.py` | the before/after counts and their comparison (names, sizes and counts only; no replay is opened) |
| `clickhouse_catchup.py` | runs the ClickHouse migrations, adding columns early where they need them (problems 4, 5) |
| `copy_legacy_replays.py`, `fix_legacy_replays.py` | the legacy replays: copy, rename, metadata (problems 7, 8) |
| `replays_playable.py` | fetches every block of every replay through the new replay reader (in verify) |
| `minio-image/` | MinIO `RELEASE.2025-04-22T22-12-26Z`, which MinIO no longer publishes |
| `posthog-export.sh`, `posthog-import.sh` | the other route: copying production into a PostHog that already has other data (not needed for an in-place upgrade) |
| `rehearsal/` | how the copy of production was built |
