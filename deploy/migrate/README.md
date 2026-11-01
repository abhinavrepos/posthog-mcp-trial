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
| 8 stone | Django migrations of the last PostHog before its migration squash (see below) | (filled in) |
| 9 start | PostHog starts through `../posthog/scale.sh`; its own migrations finish | (filled in) |
| 10 storage | MinIO → SeaweedFS with PostHog's `migrate-storage-hobby`, plus the legacy replay folder | (filled in) |
| 11 verify | counts again, compared with phase 2: `RESULT: PASS` or `FAIL` | 1 min |

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
in MinIO, persons, groups, cohorts, flags, insights and dashboards):

1. **The Postgres 12 → 15 step removes the wrong volume.** `upgrade-hobby` runs `docker volume rm
   postgres-data`, but compose names the volume `<project>_postgres-data`, so nothing is removed and
   Postgres 15 refuses to start on Postgres 12 files. The script removes the real volume.
2. **The Postgres restore runs after PostHog has started.** The web container first builds an empty
   database, which the restore then has to drop while it is in use. The script restores first.
3. **The new version's migrations cannot run on a 2025 database.** PostHog squashed its migrations on
   8 September 2026, 68 products included. Products a 2025 database never had are installed from their
   squashed migration, which needs migrations from September 2026 that in turn need those products' tables.
   The migrations stop part way (`InvalidBasesError` for `ee.EnterpriseEventDefinition` at `posthog.1019`,
   then a missing `posthog_conversations_ticket` table at `posthog.1032`) and PostHog never starts. The
   script first runs the Django migrations of the last version before the squash (commit `3ae7a3ca`), the
   path continuously upgraded installs took; the target then finishes normally.
4. **Replays of "legacy retention" projects stop playing.** In 2025 those replays were stored under
   `session_recording_batches/`. `migrate-storage-hobby` copies only `session_recordings/` to the new
   replay store, so the recordings stay listed but the blocks are not where the new reader looks. The
   script copies them too and checks that every block of every replay is there.
5. **The Node image on Docker Hub is seven months old**, and the new version also needs settings and a
   database the hobby files do not provide. `../posthog/scale.sh` uses the current image (pinned) and adds
   them; the upgraded PostHog is started through it.
6. **A backup without ZooKeeper cannot be restored.** ClickHouse's replicated tables keep part of their state
   in ZooKeeper; restoring ClickHouse alone left its data parts set aside as broken. The backup includes
   every volume.

## Files

| File | What |
| --- | --- |
| `posthog-upgrade.sh` | the upgrade, in phases |
| `versions/` | the exact versions: commit and image digests (`pin-versions.sh` writes them on the tested machine) |
| `counts.py`, `compare.py` | the before/after counts and their comparison (names, sizes and counts only; no replay is opened) |
| `copy_legacy_replays.py` | the `session_recording_batches/` copy (problem 4) |
| `minio-image/` | MinIO `RELEASE.2025-04-22T22-12-26Z`, which MinIO no longer publishes |
| `posthog-export.sh`, `posthog-import.sh` | the other route: copying production into a PostHog that already has other data (not needed for an in-place upgrade) |
| `rehearsal/` | how the copy of production was built |
