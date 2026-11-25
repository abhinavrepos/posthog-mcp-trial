# Real PostHog test: 400M events / 1 year, 120 survey sessions, Signal MCP

Date: 2026-11-25. Code: `/root/tl-int`, branch `thin-lens-volt` (PR #1).

## Setup

- Self-hosted PostHog in `/opt/posthog` (hobby compose), `posthog/posthog:latest` (rev 744f8ae), Node services
  `ghcr.io/posthog/posthog-node:latest` (rev b7f2082), ClickHouse 26.9.5. One project (team 1), `surveys_opt_in=true`.
  Host: 16 vCPU, 121 GB RAM, 900 GB disk.
- Signal survey engine served by PostHog: `/static/surveys.js` contains "Survey by ION" (no reapply needed).
- PostHog's own MCP server started with `deploy/posthog-mcp/up.sh` (pinned image, port 8787, read-only key
  `posthog-mcp`) so `posthog_exec` exists.
- Synthetic load: `load-chunk.sql` into `sharded_events`, 1M rows per chunk, `_offset` = row number, so chunk
  *n* is `intDiv(_offset, 1000000) = n`. Simulated Reval data: 60 clients (C00…C59, client 07 = SEM), 2,000 users,
  ~100 screens, PageView/Event with dialog/action/button properties, weekday-weighted, 06:00–18:00 UTC.

## Step 1: PostHog health

When this run started, PostHog was **down**. `web` had restarted 60 times (about 40 minutes of crash loops)
and `/_health` returned 502.

- Cause: ClickHouse migration **0378_hobby_query_log_archive_v3_one_layer** recreates
  `ops_query_log_archive_v3_mv` with a `log_comment` column, but that column only gets added to
  `sharded_query_log_archive_v3` / `writable_query_log_archive_v3` in **0391**. A stack whose archive tables come
  from an older install (here 20:11 the day before, then upgraded to `latest` at 22:02) fails with
  `Code: 8 … SELECT query outputs column with name 'log_comment', which is not found in the target table`,
  and `bin/migrate` exits, so the container restarts forever. This is an upstream PostHog ordering bug.
- Fix: the two `ALTER TABLE … ADD COLUMN IF NOT EXISTS log_comment …` statements from 0391, run by hand. 0391
  is idempotent, so it still applies cleanly afterwards. Migrations 0378–0394 then ran,
  `[migrate] outcome: phase=none status=0`, `/_health` 200, `showmigrations` with 0 unapplied.
- `ingestion-general` and `plugins` stayed up (6 h, no new restarts). `recording-api` keeps restarting (accepted).

## Step 2: survey sessions (120 sessions, 6 parallel)

Survey `01a210e2-972b-0000-d447-ecd431f4e366`, "Hedge Designation (LinkListReqv) then Export", client SEM, show
once, made and launched through Signal. PostHog served its targeting flag 120 ms after launch.
Run log: `/root/briefs/real-sessions-run2.log`. Results: `run/real-sessions/results-mwvlqpv2.json`.

**120 of 120 sessions as expected. No survey showed before the Export.**

| Kind | Sessions | Expected | Showed | Pass | Delay after Export, ms (min / median / p95 / max) | Early show |
| --- | ---: | --- | ---: | ---: | --- | ---: |
| export (Export after 0.5–20 s in the report) | 45 | shows | 45 | 45/45 | 232 / 540 / 1048 / 1057 | 0 |
| export-late (3–4 min in the report first) | 15 | shows | 15 | 15/15 | 240 / 650 / 1161 / 1161 | 0 |
| open-only | 15 | none | 0 | 15/15 | — | 0 |
| export-elsewhere (Export in DlgTradeList) | 15 | none | 0 | 15/15 | — | 0 |
| export-first (Export before the report) | 15 | none | 0 | 15/15 | — | 0 |
| other-client (ACME) | 15 | none | 0 | 15/15 | — | 0 |
| **All shown** | **60** | | | | **232 / 547 / 1079 / 1161** | |

Previous run (2026-11-24, `real-sessions-120.log`): 120/120, 242 / 556 / 1120 / 1165 ms. The two runs agree.

ClickHouse check (`posthog.events`, matched on the user part of the distinct_id):

| | Expected | Stored |
| --- | ---: | ---: |
| Sessions with events | 120 | 120 (clients SEM and ACME) |
| `survey shown` for this survey | 60, one per should-show session | **60**, exactly one in each should-show session, 0 elsewhere |
| `lens_chain:hedge-export-mwvlqpv2-0287b7` | 60 | **60**, same sessions, 0 elsewhere |
| Mismatching sessions | 0 | **0** |

Event-time gap from `lens_chain` to `survey shown`: min 23 ms, median 366 ms, max 993 ms.

## Step 3: 400M load

Chunks 0–48 were already in when this run started, all complete (chunk 0 also holds the real ingested events,
whose Kafka `_offset`s are small, so synthetic rows are counted by `distinct_id LIKE 'PROD|01|%'`).
`done-chunks.txt` listed only up to 36. 37–48 were complete and were added. Chunks 49–399 were loaded by
`/root/briefs/load-rest.sh` (parallelism 6, each finished chunk appended to `done-chunks.txt`) from 04:27 to
05:56 UTC: 351 chunks in 89 min (~3.9 M rows/min, 0 failures). The load ran after the survey sessions, so it did
not affect their timing.

| Check | Result |
| --- | ---: |
| Chunks with `intDiv(_offset, 1000000)` in 0..399 | **400** |
| Chunks with exactly 1,000,000 rows | **400** (no partial chunks, nothing to delete or reinsert) |
| Synthetic rows total | **400,000,000** |
| Timestamp range | 2025-11-24 06:00:01 → 2026-11-25 17:59:59 |
| Within `now() - 365 days` at 06:00 UTC on 11-25 | 399,978,844. The other **21,156** (0.005%) were generated against `now()` at load time (from 20:54 the day before) and have aged past 365 days since |
| Later than now (06:00–18:00 UTC moved onto "today") | 206,583 |
| All events, team 1 (with real ingested ones) | 400,002,153 |
| `sharded_events` on disk | 23.6 GiB, 153 active parts |

All 400M events fall inside a 365-day window measured from load time. Measured from now, 21,156 have aged out,
and that number grows by about 1.1 M a day.

## Step 4: Signal MCP against real PostHog at 400M

`tools/real-mcp-check.mts` starts `src/mcp/stdio.ts` over stdio with the test keys and the Reval settings
(`APP_EVENTS_FILE=config/app-events.reval.json`, `CLIENT_FROM_DISTINCT_ID=3`). For each window it calls
`resolve_client('SEM')`, `find_sessions` (screen LinkListReqv, then without a screen, 2 pages of 20 by cursor),
`posthog_exec call execute-sql` with a count, a 200,000-row probe, `list_surveys` and `design_survey` (Hedge then
Export, with reach estimate). It compares the counts with direct ClickHouse queries. Windows are calendar days
ending today (UTC), with the end exclusive at tomorrow 00:00. Results:
`run/real-mcp/results-2026-11-25T06-04-13-589Z.json` (all 400 chunks loaded, no ingestion running).

**Counts: every MCP count equals ClickHouse exactly (Δ 0) in all five windows. 0 errors, 0 timeouts in 55 calls.**

| Window | resolve_client SEM events | ClickHouse SEM | posthog_exec HogQL count | ClickHouse count | Δ | execute-sql rows for LIMIT 200000 | find_sessions LinkListReqv (2 pages) | find_sessions all (2 pages) | design_survey reach (sessions) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 d | 4,339 | 4,339 | 208,637 | 208,637 | 0 | 500 | 9 | 2 | 160 |
| 7 d | 117,393 | 117,393 | 6,772,615 | 6,772,615 | 0 | 500 | 9 | 2 | 320 |
| 30 d | 546,416 | 546,416 | 31,979,405 | 31,979,405 | 0 | 500 | 9 | 2 | 931 |
| 90 d | 1,651,801 | 1,651,801 | 96,865,360 | 96,865,360 | 0 | 500 | 9 | 2 | 2,552 |
| 365 d | 6,792,549 | 6,792,549 | 399,096,856 | 399,096,856 | 0 | 500 | 9 | 2 | 9,848 |

Latency per call, ms (first call of the run includes MCP and PostHog warm-up):

| Window | resolve_client | find_sessions p1 / p2 (screen) | find_sessions p1 / p2 (all) | posthog_exec count | posthog_exec 200k probe | list_surveys | design_survey | ClickHouse direct count |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 d | 10,763 (cold) | 12,344 (cold) / 1,634 | 1,351 / 902 | 755 | 504 | 303 | 7,251 | 27 |
| 7 d | 782 | 2,293 / 1,997 | 1,461 / 968 | 979 | 459 | 173 | 6,596 | 41 |
| 30 d | 477 | 4,040 / 3,183 | 1,345 / 2,155 | 571 | 464 | 289 | 8,041 | 98 |
| 90 d | 1,222 | 6,682 / 5,232 | 2,775 / 2,412 | 901 | 688 | 272 | 12,770 | 228 |
| 365 d | 4,170 | 14,199 / 11,141 | 4,808 / 5,132 | 1,418 | 503 | 282 | **34,113** | 717 |

No call returned a job handle: every call answered within the 20 s handle budget except `design_survey` at 365 d
(34 s, answered inline; it has no job path). Earlier run during the load (results-2026-11-25T04-28-20-466Z.json,
~55M rows) had the same shape, 0 errors, and SEM counts equal in the 1/7/90 d windows (30/365 d differed only
because chunks landed between the two queries).

## Findings

1. **PostHog web crash loop after upgrade (new, step 1).** Migration 0378 needs a column that 0391 adds, so an
   upgraded hobby stack never boots. Fixed here by hand (see Step 1). Signal's installer and upgrade path should
   run the 0391 `ADD COLUMN IF NOT EXISTS` statements before `migrate`, or pin a PostHog version where 0378 and 0391
   ship in the right order. Worth reporting upstream.
2. **`surveys_opt_in` is off by default.** A new PostHog project has surveys turned off, and posthog-js then never
   loads surveys. It is on here (set earlier). Signal's survey sync (`LENS_SURVEY_SYNC`, settings key) has to turn it on,
   and the installer should check it.
3. **The PostHog installer leaves out object storage keys.** The first `docker compose` run failed:
   `required variable OBJECT_STORAGE_ACCESS_KEY_ID is missing a value` (and `…SECRET_ACCESS_KEY`) for
   asyncmigrationscheck, feature-flags, hypercache-server, ingestion-general and others (`posthog-install.log`). The
   keys had to be added to `/opt/posthog/.env` by hand.
4. **posthog-node version drift.** The hobby compose uses floating tags: `web` runs `posthog/posthog:latest`
   rev 744f8ae, while the Node services (plugins, ingestion-*) run `posthog-node:latest` rev b7f2082, built from a
   different commit. Signal pins `NODE_BASE_IMAGE` by digest in `deploy/migrate/versions/versions.env`, but a plain
   PostHog hobby install does not, so web and Node can disagree after any re-pull.
5. **`deploy/posthog-mcp/up.sh` broke on current PostHog (new).** PostHog moved `GRANTABLE_API_SCOPE_OBJECTS` to
   `posthog.scopes.exposure`. The key-making step failed silently (`2>/dev/null`) and the script exited with no
   message. Patched locally with an import fallback (uncommitted in `/root/tl-int`; see "Not committed").
6. **A survey launched while a page is open shows only after a reload.** posthog-js reads flags once per page load,
   and PostHog's flags service learns a new survey's internal targeting flag a few seconds after launch. Users with
   Reval already open do not see a newly launched survey until they reload. The test waits until the flag is served
   before it opens sessions (120 ms this run).
7. **The synthetic loader writes events up to ~14 hours in the future.** It moves each timestamp to 06:00–18:00 UTC
   on its day, so events "today" can be later than now (`resolve_client` coverage shows `latest_event` 17:59Z at
   04:30Z). They are counted in the 1-day windows on both sides, so comparisons are not affected. Separately, events
   from the earliest chunks age past 365 days as time passes (see Step 3).
8. The `real-sessions.ts` results recorded distinct_ids as `PROD|01|…`, but the simulated Reval sends `C1DEV|01|…`.
   Fixed in the committed script.

## MCP findings

9. **`execute-sql` through `posthog_exec` returns at most 500 rows**, with no truncation marker in the text (asked for
   200,000, got 500 in every window, ~22 KB). Counts and aggregates are exact. Row listings are silently capped at
   500. Agents should aggregate in SQL. A "rows capped at 500" note in Signal's output filter would help.
10. **find_sessions pages are capped at 19 KB, not 20 sessions.** With dense sessions (~137 events each in this data) a
    page held 4–5 sessions with a screen filter and **1 session** without. `truncated_by_size: true` and `next_cursor`
    were always present, and paging worked. Listing 50 sessions over a year therefore takes 10–50 calls at 1–14 s each.
11. **`design_survey` with a reach estimate is the slowest call: 34 s at 365 d** (13 s at 90 d). It is the only call over
    the 20 s job budget, and it has no job handle, so a client with a 30 s tool timeout would fail at 365 d.
12. **Cold start:** the first `resolve_client` and `find_sessions` of a fresh MCP process took 10–12 s. Later calls
    were sub-second to 4 s.
13. The checker as first written did not work out of the box: survey tools only register with `APP_EVENTS_FILE`
    set, `resolve_client` finds no clients without `CLIENT_FROM_DISTINCT_ID=3`, and `execute-sql` answers as
    `header\nvalue` text, not JSON. All three are configuration and parsing issues in the test, not product bugs.

## Committed

- `tools/reval-sim/real-sessions.ts` (the distinct_id label fixed) and a README Testing note, on `thin-lens-volt`.

## Not committed (left in the working tree)

- `tools/real-mcp-check.mts` (written by Codex, extended here: Reval client env, text results from `execute-sql`,
  200k-row probe, SEM count against ClickHouse, 120 s client timeout).
- `deploy/posthog-mcp/up.sh` import fallback (finding 5): a 4-line fix, recommended for commit.
- `tools/reval-sim/debug-real.mts` (was already untracked).

## Fixes (2026-11-25, brief fix-ops.md)

Commits on `thin-lens-volt`, pushed: e6e55d1 (up.sh scope import, `tools/real-mcp-check.mts`), 7761f58 (Codex's MCP
changes in `src/`, `test/`, committed separately), a0190e1 (deploy, survey engine, doctor, reval-sim, README).

| # | Finding | Fix | Verified |
| --- | --- | --- | --- |
| 1 | Upgrade crash-loop (0378 needs `log_comment`, 0391 adds it) | `deploy/posthog/clickhouse-premigrate.py`, installed as `compose/premigrate` and run by `compose/start` before `./bin/migrate` (hobby installer and `posthog-upgrade.sh`, which also runs it before its migrate phase). It runs 0391's `ADD COLUMN IF NOT EXISTS` statements only when the table exists, lacks the column and has the column it comes after. It never blocks migrate | In the real web container: live stack → "nothing to add"; a scratch database with the old table layout → both columns added, second run "nothing to add"; empty database → "nothing to add". Also installed in `/opt/posthog/compose/` (takes effect on the next web start) |
| 2 | `surveys_opt_in` off by default | `deploy/posthog/survey-engine/opt-in.sh`: a temporary personal key (project read/write, Signal project only), one `PATCH /api/projects/:id/`, a check, then the key is deleted (also on failure). Called by `install.sh` step `surveys`. `scripts/doctor.ts` fails when Signal surveys are on but `surveys_opt_in` is not true | On real PostHog: turned off by hand → `--check` exit 1 → script turned it on → second run "already on" → 0 temporary keys left. Doctor shows `ok Surveys on in the PostHog project — surveys_opt_in=true` |
| 3 | Installer missing object storage keys | `ensure_dedicated_secrets` in the hobby installer (new and existing `.env`) and the same block in `posthog-upgrade.sh`: drops PostHog's shared `object_storage_root_*`, adds random 64-hex keys (plus `INTERNAL_REQUEST_TOKEN`, `BROWSERLESS_SECRET`, `RECORDING_API_JWT_SECRET`) when missing or empty, never changes a value, `chmod 600`. Matches PostHog's own `bin/deploy-hobby` | On a sample `.env`: shared keys replaced, empty value filled, existing kept, idempotent, mode 600. SeaweedFS registers whatever keys `.env` holds at each start |
| 4 | posthog-node / web version drift | Not changed (Signal pins `NODE_BASE_IMAGE` by digest only through `scale.sh`). New effect found: re-applying the survey engine on the upgraded image refused the early-capture hook, because the image ships **posthog-js 1.450.0**, whose `array.js` hash (dbf476b0…) is not on the verified list (1.443.0, 1.454.2). The engine falls back to PostHog's original `array.js`, by design. Surveys work (sessions below); only the startup event history before surveys load is off. Verify 1.450.0 and add its hash, or pin PostHog | — |
| 5 | `up.sh` broken on current PostHog | Import fallback to `posthog.scopes.exposure` | PostHog MCP started on :8787 and used for every MCP run |
| 6 | Survey launched while the page is open needed a reload | Survey engine (`engine.js`): every 5 min while visible, and on focus or visibility change (at most once a minute), it calls `posthog.reloadFeatureFlags()` and `getSurveys(…, true)`. Two more causes found on real PostHog: **(a)** when the page loads while no survey runs, remote config says `surveys: false` and posthog-js builds the renderer with display off for the whole page. The engine now re-reads `/array/<token>/config` on refresh and calls `startAutomaticDisplay()` once it lists surveys (remote config lists surveys only with `surveys_opt_in` on, as on a reload). **(b)** With display off nothing read the survey list, so the engine buffered startup events and replayed them at the first refresh, and the survey showed for steps done *before* the launch. The engine now reads the list at startup. `window.__lensSurveyRefreshMs` sets the interval (0 = off) | See below |
| 7 | Loader future timestamps | `/root/briefs/load-chunk.sql` (original kept as `load-chunk.sql.orig`): today's working hours later than now go to yesterday, the oldest day's early hours go to the next day, and the weekend shift never leaves the window. Data not reloaded | SELECT of 2M generated rows (no insert): 0 future, 0 older than 365 days, 100% between 06:00 and 18:00, 5.7% weekend (unchanged) |

### Survey engine verification

- **reval-sim: 43 of 43 flows pass** (42 before, plus "Survey launched while the page is open shows after the refresh
  interval"). The stand-in PostHog's remote config now lists running surveys or `false` like real PostHog, which is what
  exposed (a). Control runs: refresh off → the new flow fails; refresh on without the deferred-display start → fails;
  with the fix → passes. The new flow also checks that nothing shows after the launch until the steps are done again.
  (The startup replay (b) does not reproduce with the sim's posthog-js 1.454; it was found and verified on real PostHog.)
- **Real PostHog, `tools/reval-sim/real-live-launch.ts`** (6 pages with a 20 s refresh, 2 control pages with refresh off,
  survey launched after all pages had done Hedge Designation then Export): **8 of 8 as expected.** Nothing showed before
  launch or before the second export. After a 28 s wait the survey showed 331 / 743 / 1045 / 435 / 842 / 1147 ms after
  the Export on the 6 pages, with no reload. Control pages showed nothing. Before (a) and (b) were fixed: 0 of 6, then
  6 of 6 showing before the export.
- **Real PostHog, `real-sessions.ts` regression (24 sessions, 8 parallel): 24 of 24**; delay after Export min 237, median
  547, p95 1049, max 1049 ms (same as the 120-session run).
- `npx tsc --noEmit` clean; `npm test -- --test-concurrency=1`: **390 pass, 0 fail, 2 skipped** (392 tests, includes
  Codex's changes).

### MCP rerun after Codex's changes (400M, results-2026-11-25T08-21-50-167Z.json)

All counts still equal ClickHouse (Δ 0 in all five windows); 0 errors, 0 timeouts.

| Check | Before | After | |
| --- | --- | --- | --- |
| `design_survey` 365 d | 34,113 ms, inline | **12,697 ms**, reach capped to 90 days (2,596 sessions, same as the 90 d window) | ✓ under 20 s |
| `design_survey` 90 d | 12,770 ms | 12,489 ms | ✓ |
| execute-sql 200k-row probe | 500 rows, no marker | 500 rows plus the row-cap note (502 text lines) in every window | ✓ |
| find_sessions page fill (LinkListReqv / all, 2 pages) | 5+4 / 1+1 | **5+4 / 1+1, still `truncated_by_size`** | ✗ |
| First call of a fresh MCP process | resolve_client 10.8 s, find_sessions 12.3 s | called at once: 12.0 s / 12.0 s; **after 20 s idle: 5.7 s / 2.4 s** (warm calls 0.2–1 s) | partial |

Open items (in Codex's `src/core`, not changed here):
- **find_sessions:** the brief summaries apply only to sessions with 50+ events. Real sessions here have about 26, and
  their 10 matched actions (~5.5 KB of a ~6.5 KB session) still fill the 19 KB page at 1–5 sessions. Trim by page size
  (fewer matched actions and neighbours once the page passes the budget), not by event count.
- **Warm start:** the background roster read helps only if the first call comes some seconds after startup. Await the
  in-flight read in the first call, or warm the find_sessions query path too.

Not committed: `tools/reval-sim/debug-real.mts` (untracked from before).
