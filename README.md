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
- `design_survey`, `save_survey`, `stop_survey`, `list_surveys`, `survey_results`: survey tools, according to the caller's survey role. Launching stays on the Surveys page. `design_survey` validates native PostHog fields and returns a draft plan.

PostHog tools require its upstream MCP URL/key. Survey tools require its survey key. Replay and person tools from PostHog are allowed. Results are not masked. `src/mcp/output-filter.ts` contains the single pass-through hook at the output boundary.

## Configuration and development

Use `.env.example` and `config/app-events.reval.json`. Event/property names come from `APP_EVENTS_FILE`. Client identity uses `CLIENT_FROM_DISTINCT_ID=N`, otherwise `PROP_CLIENT_ID`. The user part is configured by `{user}` in `distinctIdParts`.

Replay Vision D5 uses the optional `replaySuccess` map in `config/app-events.*.json` for apps that do not navigate from a new form to a saved-record URL. `noticeAfterSubmit` treats a matching notice/toast after Save as success; `noticeMatch` is a list of case-insensitive regular expressions checked against the configured button/action-name property (an empty list accepts any notice). `closeAfterSubmit` treats a screen CLOSE after Save as success when no later visible error occurs. `completion` (v10) lists `{dialogMatch, buttons}` rules: an interaction event whose dialog id matches the regular expression and whose button/action name is one of `buttons` completes that screen without a save (Reval: a report dialog `…Reqv` is complete once Run or Export is pressed), unless a visible error follows before the user leaves. D5 also follows a form across returns to it (a lookup screen opened and closed in between is not an exit). Configure only signals that the app actually emits; an edited screen exited without a configured success signal remains a D5 abandonment candidate.

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

## Native PostHog surveys

Signal configures PostHog's own surveys through its public API. The browser uses unmodified posthog-js and PostHog serves its original `surveys.js`. `design_survey` validates a native survey, `save_survey` creates a draft or updates a survey, `stop_survey` stops or archives it, and `list_surveys` / `survey_results` report shown, answered, dismissed, and answers. A caller with the launch survey role can set `start_date` explicitly to launch; the edit role can change drafts only. The Signal Surveys page still offers a launch flow with its ticket and acknowledgement check. PostHog's own survey UI and API are also available.

Use PostHog's native field names. A survey can set `name`, `description`, `type` (`popover`, `api`, `widget`, `external_survey`), `questions`, `appearance`, `conditions`, `targeting_flag_filters`, `linked_flag_id`, schedule and response limit. Questions support open text, links, ratings, single and multiple choice, optional answers, button labels, choices, shuffling, open choice, and native branching. Appearance includes position, colors, text, widget settings, thank-you and intro screens, and `surveyPopupDelaySeconds`. Conditions include URL and match type, selector, device types, event names with `propertyFilters` and `repeatedActivation`, cancel events, PostHog action IDs, wait period, and linked flag variant. Targeting filters can use person properties, cohorts, and rollout percentage. `start_date`, `end_date`, `archived`, `schedule`, `iteration_count`, `iteration_frequency_days`, and `responses_limit` are also configurable. The MCP rejects unsupported keys with a field path.

PostHog automatically renders `popover` and `widget` surveys. An `api` survey needs an application renderer; `external_survey` uses PostHog's hosted page.

Example: `save_survey({"name":"Export feedback","type":"popover","questions":[{"type":"rating","question":"How was the export?","scale":5}],"conditions":{"events":{"values":[{"name":"Export"}]},"seenSurveyWaitPeriodInDays":14},"appearance":{"position":"right","surveyPopupDelaySeconds":3},"clients":["SEM"]})`. PostHog's event condition accepts event-property filters, for example `{"name":"Event","propertyFilters":{"action_name":{"operator":"exact","values":["Export"]}}}`. Native surveys cannot enforce an ordered sequence of events or wait for Reval's loading mask.

Client targeting uses a native `distinct_id` regex in `targeting_flag_filters`, verified through `/flags?v=2` on the local PostHog for existing and new IDs. For Reval IDs such as `C1DEV|01|SEM|SEMOPS`, `clients:["SEM"]` targets `^[^|]*\\|[^|]*\\|(?:SEM)\\|`. The `$distinct_id` key does not match; use `distinct_id`. No transformation or new person property is needed. Signal's `clients` shorthand resolves names and writes this native filter; `sample_percent` sets the targeting flag rollout. Reval must identify the user before flags load; anonymous IDs will not match. Historical analytics still use `CLIENT_FROM_DISTINCT_ID=3` independently. Existing Signal chain surveys are migrated on their first read after upgrade: the final event and its property filters become a native event trigger, and old conditions are removed. Running multi-step surveys are stopped for review; one-step surveys retain their status. An ordered chain cannot be represented exactly by PostHog. Review migrated triggers and audiences before relaunch.

The normal install and upgrade path runs `deploy/posthog/survey-engine/apply.sh --remove` to unmount Signal's old renderer and restore PostHog's own survey UI and API. It removes only Signal-owned compose overrides.

The configurator uses PostHog's public survey API and native action and feature-flag fields. It does not set `appearance.whiteLabel`: this server requires a paid entitlement for that field. PostHog's survey footer remains unchanged.

## When PostHog or storage fails

Signal says what is unavailable and never fills in data. A PostHog answer that is not a valid query result or
survey list is refused as unreadable. Rate-limited, timed-out and 5xx queries are retried as before; when the
retries run out, a `Retry-After` wait is part of the message. A refused survey key or a wrong project id names
what to check. When Signal's own SQLite store is busy, full, read-only or damaged, pages answer 503 with a plain
message and MCP tools return an `unavailable` error; other failures still answer 500. Messages never contain
keys, file paths or stack traces.

## Testing

- `npx tsc --noEmit` and `npm test -- --test-concurrency=1`: the unit and integration suite.
- `test/native-surveys.test.ts`: validates native survey fields, client targeting and rejected legacy inputs.
- MCP regression (`docs/mcp-regression.md`): `tools/mcp-regression/run.mts` asks the 100 questions of
  `questions.json` to Claude (Sonnet) with only the Signal MCP connected, against a real PostHog, and grades the answers
  on ClickHouse; `nightly.sh` fails below 95%. `test/mcp-regression-gate.test.ts` (in `npm test`) checks the questions
  and the tool contract against a stand-in PostHog.
- `tools/real-mcp-check.mts`: Signal MCP tools over 1/7/30/90/365-day windows against a real PostHog, counts
  compared with ClickHouse (`CLICKHOUSE_URL`), with latencies, row caps and errors (`run/real-mcp/`).
- `npm run ui-shots -- <folder>`: screenshots of every page and tab at 1440 and 375 pixels in dark and light,
  plus empty and error states, against a stand-in PostHog with sample data.

## Updating a server from a laptop (no AWS)

1. On the laptop (WSL), in this repo on the branch to ship: `bash deploy/update/build-on-laptop.sh`.
   It writes `signal-code.tar.gz` and `signal-image.tar.gz` to Windows Downloads, checks them and prints checksums.
2. Copy both files with WinSCP (Binary mode) to the server's home folder.
3. On the server: `tar -xzf signal-code.tar.gz -O deploy/update/apply-on-server.sh > signal-apply.sh && sudo bash signal-apply.sh`.
   It keeps a rollback copy, swaps code and image, removes Signal's former survey engine from PostHog,
   updates the survey key's scopes and restarts Signal. The last line printed is the rollback command.
   Settings: `LENS_DIR` (default `~/posthog-lens`), `POSTHOG_DIR` (default `~/posthog-sept`).
