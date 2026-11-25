# Signal

Signal is a thin display layer for Reval product managers. PostHog does the analysis; Signal queries it live and displays the results. Signal does not ingest days, build rollups, or maintain a task history.

| Page | Purpose |
|---|---|
| Replays | Turn recordings into MP4 clips; save, comment, download and share according to your role |
| Live | Current people and event-derived active/idle time, queried live from PostHog |
| Surveys | Design, launch, stop and inspect surveys |
| Pinned | Graph snapshots saved by agents; no automatic refresh |
| Admin | People, access roles, personal keys and audit |
| Connect | Create and revoke personal MCP keys |
| System | Health of PostHog, Signal and the machine (for people with the System page role) |

The root redirects to `/replays`. Pinned graphs are at `/replays/pinned`. `/health` and `/healthz` remain available. Pages use PostHog sign-in and Signal roles.

## MCP

Connect to `/mcp` with a personal token from Connect, or the configured shared token. Local clients may use `node --import tsx src/mcp/stdio.ts`.

Every time-based tool takes one `window` argument: `{"last":"24h"}` or `{"last":"7d"}` (rolling, ending now: the
default kind, and what "last 7 days" means), `{"day":"2026-11-24"}` (one UTC day) or `{"from":"2026-11-01","to":"2026-11-24"}`
(inclusive UTC dates); `"7d"` and `"2026-11-24"` are shorthands. The older `period`, `from`/`to`, `when` and `days` still
work. Every window ends at the latest at now, so rows stamped later are never counted. Every result starts with a
`context`: the resolved window (from, to, kind, `clamped_to_now`), the filters, the source and how much is shown
(`shown`, `truncated`, `more`). A call that takes longer than about 45 seconds (`LENS_JOB_SYNC_MS`) returns a job
handle. Validation errors carry a corrected example call. Tool descriptions say what each tool answers, with example
questions, when another tool fits better, limits and defaults, and one correct call.

- `posthog_exec`: Signal recipes and PostHog's own tools. `recipe` lists the recipes and `recipe <name> <json>` runs one: `events_per_client`, `top_screens`, `top_buttons`, `exports_by_label`, `messages`, `error_rate`, `active_users`, each with `window` and an optional `client` (tested against ClickHouse by `tools/mcp-regression/recipe-check.mts`). Other commands: `tools`, `info <tool>`, `call <tool> <json>`. PostHog's `execute-sql` returns at most 500 rows; a result of exactly 500 rows carries a note saying so (aggregate in SQL instead of listing rows).
- `get_job_result`: poll your job handle.
- `resolve_client`: resolve a client code/name, user, email or distinct id. Includes the match reason, matched user, last seen, and event count for the requested window. The live roster is cached for at most ten minutes; the MCP server starts reading the 30- and 90-day rosters when it starts.
- `find_sessions`: client, optional screen/action text/user, a window of up to one year, limit and cursor. Returns both PostHog replay and Signal clip page URLs. It reports missing recordings explicitly. Entries are compact by default (session, user, start, duration, event count, top five screens, matched action, links); `detail: true` adds matched actions with their neighbours, outcomes and context. A page is limited by size (about 19 KB) as well as by `limit`, and `truncated_by_size` with `next_cursor` says there is more. A slow page returns a job handle.
- `get_replay_link`: PostHog replay and MP4 clip links; waits up to 25 seconds and finishes pending clips in the background.
- `pin_graph`: save `{title, chart: {type: 'line'|'bar'|'table', x: [...], series: [{name, values: [...]}]}, note?}`. At most 20 series and 500 points; series lengths must match `x`.
- `list_pinned`: list saved snapshots.
- `unpin_graph`: delete your own graph; an admin may delete any graph.
- `design_survey`, `save_survey`, `stop_survey`, `list_surveys`, `survey_results`: survey tools, according to the caller's survey role. Launching stays on the Surveys page. A `design_survey` reach estimate over more than 90 days uses the last 90 days and says so; a slow one returns a job handle.

PostHog tools require its upstream MCP URL/key. Survey tools require its survey key. Replay and person tools from PostHog are allowed. Results are not masked. `src/mcp/output-filter.ts` contains the single pass-through hook at the output boundary.

## Configuration and development

Use `.env.example` and `config/app-events.reval.json`. Event/property names come from `APP_EVENTS_FILE`. Client identity uses `CLIENT_FROM_DISTINCT_ID=N`, otherwise `PROP_CLIENT_ID`. The user part is configured by `{user}` in `distinctIdParts`.

For the owner's IDs (`C1DEV|01|SEM|SEMOPS`), set `CLIENT_FROM_DISTINCT_ID=3`; the provided map identifies user part 4. `sem ops` resolves to client SEM with matched user SEMOPS, and session finding preserves that user filter. Screen names come from `dialog_name` and `tab_name`, codes from `dialog_id`; actions come from `action` and `action_name`.

Run with `node --import tsx src/service/server.ts`. Check with `npx tsc --noEmit` and `npm test -- --test-concurrency=1`. The clip queue defaults to five concurrent renders and two per person. SQLite keeps access, audits, clips, survey metadata, jobs and pinned snapshots. Historical database migrations remain compatible with installed databases; retired history files are not read.

### PostHog install and upgrade

`deploy/install.sh` (and `deploy/posthog/install-posthog-hobby.sh`, `deploy/migrate/posthog-upgrade.sh`) also:

- give every install its own random object storage keys (`OBJECT_STORAGE_ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` in
  PostHog's `.env`, never PostHog's shared `object_storage_root_*`), and add any that an older `.env` lacks;
- run `compose/premigrate` (`deploy/posthog/clickhouse-premigrate.py`) before PostHog's `bin/migrate`: it adds
  columns that an early PostHog ClickHouse migration needs before the later one that adds them (0378 needs
  `log_comment`, which 0391 adds), so an upgraded stack does not crash-loop. It does nothing on a new or
  up-to-date stack;
- turn surveys on in the Signal project (`surveys_opt_in`, off in a new PostHog project) through PostHog's API with a
  short-lived key (`deploy/posthog/survey-engine/opt-in.sh`, `--check` to only report). `lens.sh doctor` fails when
  surveys are on in Signal but off in the project.

**Link addresses.** MCP answers and pages build links from two settings in `.secrets.env`:
`SERVICE_PUBLIC_URL` for Signal's own pages (clips, Pinned, surveys), for example `http://10.10.10.5:8080`, and
`POSTHOG_LINK_URL` for PostHog replay links, for example `http://10.10.10.5:8010` or
`https://c1.posthog.example.com`. Each is reduced to one `scheme://host[:port]`: a path or a second address is
dropped, so a link never holds two addresses. After a change, restart Signal and rerun `deploy/posthog-mcp/up.sh`
(PostHog's MCP uses `POSTHOG_LINK_URL` too).

**Memory (`deploy/posthog/tune.sh`, `--dry-run` to preview, `--undo` to remove).** Without it, ClickHouse may use
90% of RAM and one heavy query can starve the rest of PostHog. On a machine with 48 GB or more, `tune.sh` caps
ClickHouse at half the RAM, up to 32 GB. One query may use 60% of that, and big sorts and group-bys spill to disk
at 8 GB. On smaller machines the cap is a seventh of RAM, up to 8 GB. Override it with `LENS_CH_SERVER_MB` in
PostHog's `.env`.

Measured on the test box (400M events over a year): all PostHog containers use about 12 GB when idle, and the
heaviest one-year query peaked at 21 GB. On a 64 GB server with 300–400k events a day (up to 40k an hour), expect
12–16 GB in steady use and well under the 32 GB cap at peak. Disk use is about 17 GB per year of events.

Lab verification helpers are `tools/task-u-server.mts` (port 18371, isolated SQLite) and `tools/task-u-check.mts` (MCP and HTTP checks). Start the server with the lab's bridge preload. A stopped ClickHouse lab produces unavailable errors rather than invented data.

## Interface

Pages use the Volt design: monochrome surfaces, a grouped sidebar (Monitor, Engage, Manage), one primary
action per page, neutral tiles with small status dots, and tables that become stacked rows on phones. The
theme follows the computer's light or dark setting (dark when there is none); `data-theme="light"` or
`"dark"` on `<html>` overrides it. Geist and Geist Mono (SIL Open Font License, `assets/fonts/`) are served by
Signal itself, so pages load nothing from outside and work offline. The shared styles are in
`src/service/volt.ts`; routes, element ids, form names and page scripts are those of the earlier pages.

## Surveys on Reval

A survey shows after a user does its steps, in order, in one browser session. Other actions in between are
fine. Steps name what Reval sends, not what people see:

- **Screens** by `dialog_id`. Reports send their menu id: Hedge Designation is `LinkListReqv`, not its Ext
  dialog `DlgHedgeDesigListReport` and not its title.
- **Buttons** by their exact label (`action_name`). `Export`, `XLS Export`, `XLSX Export` and `CSV Export` are
  four different buttons; for any of them use an `event` step on `Event` with `action_name` containing `Export`.
- **Clients**: Reval puts the client in the user id (`ENV|SITE|CLIENT|USER`), not on events, so client-limited
  surveys need `CLIENT_FROM_DISTINCT_ID=3`.

Example, "after a user opens Hedge Designation and then exports from it":
`steps: [{opens: 'LinkListReqv'}, {button: 'Export', dialog: 'LinkListReqv'}]`. It does not show for opening
the report alone, for an export in another screen, or for an export before the report was opened; it shows
when the export happens, also minutes later, once Reval's loading mask has gone.

A survey launched while Reval is already open shows without a reload. posthog-js reads its flags (a survey's
targeting flag is one) once per page load, so the survey engine reloads flags and surveys every 5 minutes while
the page is visible, and when it comes back into view (at most once a minute). When the page loaded while no
survey was running, PostHog's script starts with survey display off; the engine turns it on once PostHog's
remote config lists surveys again, as a reload would. Steps done before the launch do not count: after a launch,
users do the steps again. `window.__lensSurveyRefreshMs` changes the interval (0 turns it off).

`design_survey` adds warnings, never errors, when a step's screen, button or field, or the client audience,
matched nothing in the last 30 days of events, with close matches (for example `LinkListReqv` for
`DlgHedgeDesigListReport`). These checks use their own fixed 30-day window and a 40-second limit per query, run next to the reach estimate, and never hold
up other queries; if PostHog cannot answer them, one warning says the check was skipped.

## When PostHog or storage fails

Signal says what is unavailable and never fills in data. A PostHog answer that is not a valid query result or
survey list is refused as unreadable. Rate-limited, timed-out and 5xx queries are retried as before; when the
retries run out, a `Retry-After` wait is part of the message. A refused survey key or a wrong project id names
what to check. When Signal's own SQLite store is busy, full, read-only or damaged, pages answer 503 with a plain
message and MCP tools return an `unavailable` error; other failures still answer 500. Messages never contain
keys, file paths or stack traces.

## Testing

- `npx tsc --noEmit` and `npm test -- --test-concurrency=1`: the unit and integration suite.
- `pnpm reval-sim [name filter]`: a simulated Reval (Ext JS classic, one page whose URL never changes, about
  100 screens as MDI tabs, floating windows, report parameter windows, grids, message boxes, toasts and an
  iframe) with the real posthog-js and the survey engine as `deploy/posthog/survey-engine/build.mjs` builds
  it, served by a stand-in PostHog. Surveys are made through Signal, and 43 flows in headless Chrome check
  when each survey shows and when it must not: the Hedge Designation then Export order, steps before
  posthog-js has loaded, reopened tabs, tab switches, loading masks and modal windows, client and sample
  audiences, per-user limits and gaps, show once or every time, dismissals, logout and a new user without a
  reload, client change, a survey launched while the page is open, and 100 screens in a row. Ext JS (GPL) is not in this repository: set
  `REVAL_VENDOR` to a folder with `extjs/ext-all.js` and the classic theme, and `posthog-js/` (an npm
  package copy). Results go to `run/reval-sim/results.json`. The startup hook in `array.js` is built only for verified
  posthog-js files (hashes in `build.mjs`: 1.443.0, 1.454.2, and 1.450.0 as PostHog's web image serves it, which is
  PostHog's own build, not npm's); to verify a new one, put PostHog's served `array.js` and `surveys.js` in a vendor
  copy's `posthog-js/dist/`, add the hash and run all flows with that `REVAL_VENDOR`.
- `tools/reval-sim/real-sessions.ts`: the same simulated Reval against a real self-hosted PostHog (its own
  posthog-js, flags service and survey engine). It makes and launches a Hedge Designation then Export survey
  through Signal, waits until PostHog serves its targeting flag, then runs `SESSIONS` (120) browser sessions,
  `PARALLEL` (6) at a time: exports right away or after 3 to 4 minutes, opens without exporting, exports
  elsewhere or first, and another client. It reports sessions as expected and the delay from Export to the
  survey on screen (min, median, p95, max), and writes `run/real-sessions/results-<stamp>.json`. Set
  `REAL_PH`, `REAL_TOKEN` (project token), `REAL_KEY` (personal key with survey write) and `REAL_PROJECT`.
  The project needs surveys turned on (`surveys_opt_in`), and PostHog must serve the Signal survey engine.
- `tools/reval-sim/real-live-launch.ts`: a survey launched while Reval is open, against a real PostHog. `PAGES`
  (6) pages open and do the steps first, then Signal launches the survey; after the engine's refresh (`REFRESH_MS`,
  20000) the same pages, without a reload, do the steps again and must see it. `CONTROL` (2) pages run with the
  refresh off and must see nothing. Same `REAL_*` settings; results in `run/real-live-launch/`.
- MCP regression (`docs/mcp-regression.md`): `tools/mcp-regression/run.mts` asks the 100 questions of
  `questions.json` to Claude (Sonnet) with only the Signal MCP connected, against a real PostHog, and grades the answers
  on ClickHouse; `nightly.sh` fails below 95%. `test/mcp-regression-gate.test.ts` (in `npm test`) checks the questions
  and the tool contract against a stand-in PostHog.
- `tools/real-mcp-check.mts`: Signal MCP tools over 1/7/30/90/365-day windows against a real PostHog, counts
  compared with ClickHouse (`CLICKHOUSE_URL`), with latencies, row caps and errors (`run/real-mcp/`).
- `npm run ui-shots -- <folder>`: screenshots of every page and tab at 1440 and 375 pixels in dark and light,
  plus empty and error states, against a stand-in PostHog with sample data.
