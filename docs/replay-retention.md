# Rolling session-replay retention

An admin sets on **Admin → Clips → Session replay retention** how many days of session replays the
self-hosted PostHog keeps, for example 14. Each day, recordings that started before the cutoff are deleted
through PostHog's API, and Lens clips made from them follow the same rule. **Event data is out of scope:
this never touches the `events` table or event retention.**

This file covers the research (what PostHog offers), the design, and how to run it.

## 1. Research: how self-hosted PostHog stores and deletes recordings

Research date: 2026-11-15. The PostHog we run is pinned in `deploy/migrate/versions/versions.env`
(commit `c08ecdbe…`, Nov 2026). PostHog source is cited from `master` at that time, so check it again
after an upgrade.

### Where recordings live

| Where | What | Source |
|---|---|---|
| Object storage (MinIO on hobby installs, S3 on Cloud) | The snapshot data ("blocks"). Ingestion writes **batch files that hold compressed blocks from many sessions**, under retention-named prefixes: `session_recordings/<30d\|90d\|1y\|5y>/<timestamp>-<hex>`. | [Session replay architecture (handbook)][arch]: "Retention-aware: writes to different S3 paths based on team retention period"; "Each batch file contains multiple compressed session blocks". Our own `deploy/migrate/fix_legacy_replays.py` documents the `session_recordings/<period>/` layout that recording-api accepts. |
| ClickHouse `session_replay_events` (sharded, `AggregatingMergeTree`, `PARTITION BY toYYYYMM(min_first_timestamp)`) | One or more metadata rows per session: start/end, counts, `block_urls` (pointers into the batch files), `retention_period_days`, `is_deleted`. | [`session_replay_event_sql.py`][ddl]: `is_deleted … -- marks the recording as deleted for crypto shredding; once 1, merges keep it as 1`; `retention_period_days … Useful to show TTL for the recording`. |
| ClickHouse `session_recording_events` (old) | Snapshot data itself, for installs from before blob storage. Deprecated. | [Session replay storage configuration][storage]: "Older versions store recordings in ClickHouse, in the `session_recording_events` table." Lens's upgrade scripts (`deploy/migrate/copy_legacy_replays.py`, `fix_legacy_replays.py`) already moved our legacy replays to blob storage. |
| Postgres `posthog_sessionrecording` | Optional row per recording (pinned/persisted recordings, `object_storage_path`). | [Architecture handbook][arch]. |

### Built-in retention, and why it does not do "14 days"

* **Team setting `session_recording_retention_period`.** Settings → Replay → Data retention. Values are
  `30d`, `90d`, `1y`, `5y`. Cloud plans cap them. There is no 14-day option. It also **only applies to
  new recordings**: "Changes only apply to new recordings … Existing recordings keep their original
  period." ([Replay recording retention][retention]). `fix_legacy_replays.py` sees the same four periods
  in the data (`PERIODS = 30d, 90d, 1y, 5y`), and notes that the current version treats a replay without
  `retention_period_days` as expiring 30 days after it started.
* **ClickHouse TTL on `session_replay_events`.** The handbook says expiry is "automatic expiry based on
  retention_period_days", but the table DDL in the current source has **no `TTL` clause**. Old ClickHouse
  installs had `RECORDINGS_TTL_WEEKS` for `session_recording_events` only ([storage docs][storage]).
  Expired recordings are hidden from lists and the player from `retention_period_days` (PostHog
  computes `expiry_time` / `recording_ttl`), but the rows are not dropped by a TTL. **Not verified on a
  live ClickHouse** (`SHOW CREATE TABLE sharded_session_replay_events` would settle it).
* **Blob lifecycle rules.** For blob-backed installs PostHog says: "You should manage retention using
  blob storage lifecycle policies … The exact setup will vary depending on your environment and storage
  provider." ([storage docs][storage]). That is a bucket rule per prefix (for example, expire objects
  under `session_recordings/30d/` after 30 days). PostHog does not ship that rule for hobby MinIO.

So nothing built in gives a rolling window shorter than 30 days, or applies to recordings that already
exist. The team setting and lifecycle rules work in fixed buckets of 30d/90d/1y/5y.

### Supported APIs that delete recordings

From [`posthog/session_recordings/session_recording_api.py`][api] and
[`recordings/recording_api_client.py`][client]:

* **`DELETE /api/projects/:project_id/session_recordings/:session_id/`** (`destroy`). Calls the
  recording-api service (`POST {RECORDING_API_URL}/api/projects/{team_id}/recordings/delete` with
  `{session_ids, deleted_by}`), writes an activity-log entry, returns **204**. It returns 500
  `recording_api_failure` if recording-api reports the id as failed. The personal API key needs
  `session_recording:write` (`scope_object = "session_recording"`; deletes are write actions;
  [API reference][apiref]).
* **`POST /api/projects/:project_id/session_recordings/bulk_delete/`** with
  `{"session_recording_ids": [...] (max 100), "date_from": …}`. Two problems for our use:
  1. When `date_from` is omitted it defaults to the team's retention period (`… or "90d"`). The recordings
     are looked up within that window, so recordings older than the window, which are exactly the
     ones we want gone, are silently skipped (`deleted_count: 0`).
  2. Whether personal API keys may call this custom action at all is unclear. The (unmerged, closed
     2026-10-13) [PR #107240][pr107240] says "Personal API keys with `session_recording:write` can now call
     `bulk_delete`" and "Bulk delete now shreds expired recordings". Both were open bugs at our pinned
     version.

  **So Lens uses the single-recording `DELETE`.** It is the documented, scoped, per-recording endpoint.
* Person deletion with `delete_recordings=true`, and team/project deletion, also delete recordings
  ([Session replay privacy][privacy]). They are not usable for a rolling window.

### What a PostHog API delete actually removes, and what remains

PostHog documents deletion as **crypto-shredding in two phases** ([Session replay privacy][privacy]):

1. **Key shredding.** "the encryption key is permanently destroyed, making the recording unplayable
   immediately". recording-api marks the session deleted (`is_deleted = 1` in `session_replay_events`,
   per the [DDL comment][ddl]). Later block reads raise `RecordingDeletedError` "if the session's key
   was shredded" ([client][client]).
2. **Metadata cleanup.** "recording metadata is purged from the database after a 10-day grace period
   via a nightly scheduled job".

What remains after a successful API delete:

* **The blob bytes in MinIO/S3.** Blocks live inside shared batch files with other sessions' blocks, so
  PostHog cannot and does not delete per-session objects. The bytes stay until the bucket's lifecycle
  rule (if any) expires the batch file. If the blocks were encrypted with the per-session key, they are
  unreadable. **The privacy page states the per-session encryption for PostHog Cloud** ("On PostHog Cloud,
  session recordings are encrypted using per-session encryption keys"). I could not confirm from docs
  or source that a self-hosted hobby recording-api encrypts blocks. If it does not, a deleted
  recording's bytes stay readable in MinIO by anyone with bucket access until lifecycle expiry, even
  though PostHog no longer lists or plays it. **Treat this as open until checked on our install** (see §4).
* **ClickHouse metadata rows for up to ~10 days** (marked deleted), then purged by PostHog's nightly job.
* **Postgres `posthog_sessionrecording` rows / activity log entries** (the activity log records the
  deletion itself).
* **Data derived from the recording elsewhere**: events (out of scope), Lens clip MP4s (handled below),
  Lens replay signals in `tasks.db` (structure-only counts, no content; not touched).

Lens never writes to ClickHouse or object storage directly, by design: the API delete is the supported
path, and the bucket lifecycle rule is the supported way to reclaim bytes.

## 2. Design

### Setting

* `replay_retention_days` in the Lens `settings` table (`core/db.ts`, via `getSetting`/`setSetting`, like
  `default_role` and `chat_url`). JSON `null` = **off (default, nothing is deleted)**, otherwise a
  whole number of days from **7 to 3650** (`parseRetentionDays`, `src/service/replayretention.ts`).
* Every change writes the audit row `replay_retention.set` with `who`, `before`, `after` (`"off"` or
  days), and the preview it was confirmed against (`cutoff`, `would_delete`, `clips_would_delete`).
  It shows on Admin → Activity.

### Cutoff

`cutoff = UTC midnight of today − N days` (`cutoffFor`), computed **at run time from the current
setting**. A recording is deleted when it **started** (`min(min_first_timestamp)` of the session)
strictly before the cutoff. With 14 days on 2026-11-15 (at any hour UTC), the cutoff is
2026-11-01T00:00Z: recordings from Nov 1 to now stay. The window is 14 full days plus today, and the
belt moves by one day at each UTC midnight.

### Admin endpoints (all admin-only; non-admins get 403 from the existing gate in `handleAdmin`)

| Method | Path | Does |
|---|---|---|
| GET | `/replays/admin/api/replay-retention` | Setting, cutoff, whether the delete key is set, dry-run, cap, last run, next retry. |
| GET | `/replays/admin/api/replay-retention/preview?days=N` | `{count, oldest, cutoff, clips: {delete, kept_saved}}`. **Read-only**: one HogQL `count()` and a local clip scan. `count: null` if PostHog cannot answer. |
| POST | `/replays/admin/api/replay-retention` `{days, confirm}` | Saves. Needs header `x-clip-page: 1`. Computes the preview again on the server and answers **409 with the preview** unless `confirm: true` whenever the new value would delete anything (count > 0, unsaved clips to delete, or count unknown). Turning it off never needs confirmation. Saving deletes nothing by itself. |

The card on Admin → Clips shows the preview sentence ("With 14 days, 1,234 recordings recorded before
1 Nov 2026 (UTC) would be deleted, the oldest from …"), and shows a confirm checkbox when the change
would delete anything. It states that deleting cannot be undone and that raising the number or turning
it off later does not bring deleted recordings back.

### Daily job (`runReplayRetention`, `createRetentionScheduler`)

Hooked in `src/service/server.ts` next to `pruneOldClips`, the same way as the briefing delivery
(`core/briefingdelivery.ts`): a timer ticks hourly (first tick one minute after start), and a
once-per-UTC-day claim is kept in `settings` (`replay_retention_state`), so restarts do not run it twice.
Per run:

1. Setting off → return. **No PostHog calls at all.**
2. **Confirm the project**: `GET /api/projects/:POSTHOG_PROJECT_ID/` with `LENS_REPLAY_RETENTION_API_KEY`
   must answer 200 with that same `id`, and with `api_token == POSTHOG_PROJECT_TOKEN` when that is set.
   A missing key, a missing project id, a non-200 answer or a mismatch → **no listing and no deletes**,
   run audited with the reason.
3. List old recordings with HogQL on `raw_session_replay_events` (read key, as elsewhere in Lens), oldest
   first, `LENS_REPLAY_RETENTION_BATCH` (100) at a time, keyset-paginated after a **watermark**
   `(start, session_id)` stored in `settings` (`replay_retention_watermark`).
4. `DELETE …/session_recordings/:id/` one by one. 204 → deleted; 404/410 → already gone (counted, not an
   error). 429/5xx/network errors → retried twice with backoff (2 s, 4 s). Anything else, or still failing
   → **the run stops**. The watermark is saved after every successful delete. A short pause between batches.
5. Stops at `LENS_REPLAY_RETENTION_MAX_PER_RUN` (2000). The rest continues tomorrow (`capped: true`).
6. Clip cache (below). Skipped if the run stopped on an error.
7. Audit row `replay_retention.run` (who: `system`) with `days, cutoff, dry_run, deleted, already_gone,
   failed, capped, clips_deleted, clips_kept_saved, error`, and the same as one JSON log line. **Counts
   and dates only**: no session ids (error messages never include the URL), no content.

After a failed run, the scheduler waits 1 h, then 2 h, 4 h … at most 24 h before trying again. A
successful run resets this.

**Idempotent and safe to rerun.** The watermark means a rerun never asks PostHog to delete a recording
twice, even though PostHog keeps listing deleted recordings during its 10-day grace period. Without the
watermark (for example, a new Lens database), deletes of already-deleted recordings answer 404 and are
counted as `already_gone`. Calling `runReplayRetention()` by hand is harmless. An in-process lock and the
day claim prevent two runs at once.

**Dry run** (`LENS_REPLAY_RETENTION_DRY_RUN=1`): it does the project check and the listing (up to the
cap), then logs and audits `would_delete` and `clips_would_delete`. It does not delete anything in
PostHog or in Lens, and does not move the watermark.

### Lens clip cache

Clips today (`service/replays.ts`, `pruneOldClips`): an unsaved clip is deleted 14 days
(`CLIP_RETENTION_DAYS`) after it was last asked for. **A saved clip stays until everyone who saved it
unsaves it, or an admin deletes it.** Retention follows that policy:

* **Unsaved** clips whose recording started before the cutoff are deleted in the same run (MP4, comment
  variants and rows, through `deleteClip`). When the recording start is unknown, the clip's own
  `created_at` is used: a clip is made after its recording started, so an old `created_at` proves an
  old recording, and a recent one keeps the clip.
* **Saved** clips are **kept**. They are counted (`clips_kept_saved`) in the preview, in the run audit
  and on the card ("N saved clips of older recordings stay until unsaved"). An admin can unsave or
  delete them on Admin → Clips. Once unsaved, the next run deletes them.

Choice and reason: saving a clip is an explicit "keep this" by a person, and the admin page already
promises that saved clips stay. Silently breaking that promise would lose evidence attached to tickets.
The trade-off: a saved clip is a copy of part of a recording that PostHog no longer has, so retention is
not absolute for saved clips. This is visible in the counts.

## 3. Operations

### Switching it on

1. Make a personal API key in PostHog for **this project only**, with scopes `session_recording:write`
   and `project:read`. Put it in `.secrets.env` as `LENS_REPLAY_RETENTION_API_KEY`. Keep it separate from
   `POSTHOG_PERSONAL_API_KEY`, which stays read-only.
2. Optional first pass: `LENS_REPLAY_RETENTION_DRY_RUN=1`, restart the service, set the days, and the
   next day read the `replay_retention.run` row on Admin → Activity (or the `replay retention dry run`
   log line).
3. Admin → Clips → Session replay retention → "For a number of days" → 14 → read the preview → tick the
   confirmation → Save.
4. Remove the dry-run flag and restart. The first run comes within an hour, then once per UTC day.

A large backlog drains at `LENS_REPLAY_RETENTION_MAX_PER_RUN` per day. Raise it temporarily if PostHog
copes (each delete is one API call plus a recording-api call).

### Reclaiming disk in MinIO (recommended, operator step, not done by Lens)

The API delete makes recordings unlistable and unplayable, but bytes stay in the bucket until lifecycle
expiry (§1). To bound storage, add a MinIO lifecycle rule on the replay bucket that expires
`session_recordings/30d/` objects after the team's retention (30 days). A rule shorter than the Lens
setting would delete recordings Lens is meant to keep, because batch files hold many sessions. So the
rule must be **≥ the longest window you will set**. Lens's daily job then handles "fewer than 30 days".

### Things to check on a real install (not verifiable from here)

* `SHOW CREATE TABLE sharded_session_replay_events`: whether there is a TTL.
* After deleting one test recording: whether `GET …/session_recordings/:id/snapshots` fails, and whether
  the block file in MinIO is readable as plain JSON/gzip (no per-session encryption on self-hosted) or not.
* That `raw_session_replay_events` in HogQL lists recordings past their `retention_period_days` (the
  listing query depends on it). If PostHog hides them there, recordings older than the team period are
  already hidden and are deleted only by blob lifecycle and metadata expiry.

### Audit and logs

* `replay_retention.set`: who, before, after, and the confirmed preview.
* `replay_retention.run` (who `system`): one per run, including refused runs (project not confirmed,
  key missing) and dry runs.
* `clip.deleted` rows are not written per clip by the job (the count is in the run row), like
  `clips.pruned`.

## Sources

* [Replay recording retention (PostHog docs)][retention]
* [Session replay storage configuration (self-host)][storage]
* [Session replay architecture (PostHog handbook)][arch]
* [Session replay privacy: deletion and crypto-shredding][privacy]
* [Session recordings API reference][apiref]
* [`posthog/session_recordings/session_recording_api.py`][api]: `destroy`, `bulk_delete`, `MAX_RECORDINGS_PER_BULK_DELETE = 100`, the `date_from` default
* [`posthog/session_recordings/recordings/recording_api_client.py`][client]: `delete_recordings`, `RECORDING_API_URL`
* [`posthog/session_recordings/sql/session_replay_event_sql.py`][ddl]: `is_deleted`, `retention_period_days`, partitioning, no TTL
* [PR #107240 (closed, unmerged): bulk delete and expired recordings, API-key access][pr107240]

[retention]: https://posthog.com/docs/session-replay/data-retention
[storage]: https://posthog.com/docs/self-host/configure/session-replay-storage
[arch]: https://posthog.com/handbook/engineering/session-replay/session-replay-architecture
[privacy]: https://posthog.com/docs/session-replay/privacy
[apiref]: https://posthog.com/docs/api/session-recordings
[api]: https://github.com/PostHog/posthog/blob/master/posthog/session_recordings/session_recording_api.py
[client]: https://github.com/PostHog/posthog/blob/master/posthog/session_recordings/recordings/recording_api_client.py
[ddl]: https://github.com/PostHog/posthog/blob/master/posthog/session_recordings/sql/session_replay_event_sql.py
[pr107240]: https://github.com/PostHog/posthog/pull/107240

Raw snapshot cache files expire after `CLIP_SNAPSHOT_MAX_DAYS` (default 7, minimum 1),
independently of `CLIP_CACHE_MAX_MB`. Active readers are pinned until completion;
startup, snapshot fetches and the six-hour cache sweep prune expired files. Recording
deletion also removes that session's raw snapshots, partial downloads and render work,
even when a rendered clip was saved. Existing clips without current render metadata
are regenerated on request so earlier untrimmed exports are not reused.
