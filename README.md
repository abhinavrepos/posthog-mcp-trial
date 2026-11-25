# PostHog Lens

Lens is a thin display layer for Reval product managers. PostHog does the analysis; Lens queries it live and displays the results. Lens does not ingest days, build rollups, or maintain a task history.

| Page | Purpose |
|---|---|
| Replays | Turn recordings into MP4 clips; save, comment, download and share according to your role |
| Live | Current people and event-derived active/idle time, queried live from PostHog |
| Surveys | Design, launch, stop and inspect surveys |
| Pinned | Graph snapshots saved by agents; no automatic refresh |
| Admin | People, access roles, personal keys and audit |
| Connect | Create and revoke personal MCP keys |
| System | Health of PostHog, Lens and the machine (for people with the System page role) |

The root redirects to `/replays`. Pinned graphs are at `/replays/pinned`. `/health` and `/healthz` remain available. Pages use PostHog sign-in and Lens roles.

## MCP

Connect to `/mcp` with a personal token from Connect, or the configured shared token. Local clients may use `node --import tsx src/mcp/stdio.ts`.

- `posthog_exec`: PostHog's own tools. Commands: `tools`, `info <tool>`, `call <tool> <json>`. Long calls return a job handle within about 20 seconds.
- `get_job_result`: poll your job handle.
- `resolve_client`: resolve a client code/name, user, email or distinct id. Includes the match reason, matched user, last seen, and event count for the requested window. The live roster is cached for at most ten minutes.
- `find_sessions`: client, optional screen/action text/user, a window of up to one year, limit and cursor. Returns both PostHog replay and Lens clip page URLs. It reports missing recordings explicitly.
- `get_replay_link`: PostHog replay and MP4 clip links; waits up to 25 seconds and finishes pending clips in the background.
- `pin_graph`: save `{title, chart: {type: 'line'|'bar'|'table', x: [...], series: [{name, values: [...]}]}, note?}`. At most 20 series and 500 points; series lengths must match `x`.
- `list_pinned`: list saved snapshots.
- `unpin_graph`: delete your own graph; an admin may delete any graph.
- `design_survey`, `save_survey`, `stop_survey`, `list_surveys`, `survey_results`: survey tools, according to the caller's survey role. Launching stays on the Surveys page.

PostHog tools require its upstream MCP URL/key. Survey tools require its survey key. Replay and person tools from PostHog are allowed. Results are not masked. `src/mcp/output-filter.ts` contains the single pass-through hook at the output boundary.

## Configuration and development

Use `.env.example` and `config/app-events.reval.json`. Event/property names come from `APP_EVENTS_FILE`. Client identity uses `CLIENT_FROM_DISTINCT_ID=N`, otherwise `PROP_CLIENT_ID`. The user part is configured by `{user}` in `distinctIdParts`.

For the owner's IDs (`C1DEV|01|SEM|SEMOPS`), set `CLIENT_FROM_DISTINCT_ID=3`; the provided map identifies user part 4. `sem ops` resolves to client SEM with matched user SEMOPS, and session finding preserves that user filter. Screen names come from `dialog_name` and `tab_name`, codes from `dialog_id`; actions come from `action` and `action_name`.

Run with `node --import tsx src/service/server.ts`. Check with `npx tsc --noEmit` and `npm test -- --test-concurrency=1`. The clip queue defaults to five concurrent renders and two per person. SQLite keeps access, audits, clips, survey metadata, jobs and pinned snapshots. Historical database migrations remain compatible with installed databases; retired history files are not read.

Lab verification helpers are `tools/task-u-server.mts` (port 18371, isolated SQLite) and `tools/task-u-check.mts` (MCP and HTTP checks). Start the server with the lab's bridge preload. A stopped ClickHouse lab produces unavailable errors rather than invented data.

## Interface

Pages use the Volt design: monochrome surfaces, a grouped sidebar (Monitor, Engage, Manage), one primary
action per page, neutral tiles with small status dots, and tables that become stacked rows on phones. The
theme follows the computer's light or dark setting (dark when there is none); `data-theme="light"` or
`"dark"` on `<html>` overrides it. Geist and Geist Mono (SIL Open Font License, `assets/fonts/`) are served by
Lens itself, so pages load nothing from outside and work offline. The shared styles are in
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

`design_survey` adds warnings, never errors, when a step's screen, button or field, or the client audience,
matched nothing in the last 30 days of events, with close matches (for example `LinkListReqv` for
`DlgHedgeDesigListReport`). These checks use their own fixed 30-day window and a 15-second limit and never hold
up other queries; if PostHog cannot answer them, one warning says the check was skipped.

## When PostHog or storage fails

Lens says what is unavailable and never fills in data. A PostHog answer that is not a valid query result or
survey list is refused as unreadable. Rate-limited, timed-out and 5xx queries are retried as before; when the
retries run out, a `Retry-After` wait is part of the message. A refused survey key or a wrong project id names
what to check. When Lens's own SQLite store is busy, full, read-only or damaged, pages answer 503 with a plain
message and MCP tools return an `unavailable` error; other failures still answer 500. Messages never contain
keys, file paths or stack traces.

## Testing

- `npx tsc --noEmit` and `npm test -- --test-concurrency=1`: the unit and integration suite.
- `pnpm reval-sim [name filter]`: a simulated Reval (Ext JS classic, one page whose URL never changes, about
  100 screens as MDI tabs, floating windows, report parameter windows, grids, message boxes, toasts and an
  iframe) with the real posthog-js and the survey engine as `deploy/posthog/survey-engine/build.mjs` builds
  it, served by a stand-in PostHog. Surveys are made through Lens, and 42 flows in headless Chrome check
  when each survey shows and when it must not: the Hedge Designation then Export order, steps before
  posthog-js has loaded, reopened tabs, tab switches, loading masks and modal windows, client and sample
  audiences, per-user limits and gaps, show once or every time, dismissals, logout and a new user without a
  reload, client change, and 100 screens in a row. Ext JS (GPL) is not in this repository: set
  `REVAL_VENDOR` to a folder with `extjs/ext-all.js` and the classic theme, and `posthog-js/` (an npm
  package copy). Results go to `run/reval-sim/results.json`.
- `tools/reval-sim/real-sessions.ts`: the same simulated Reval against a real self-hosted PostHog (its own
  posthog-js, flags service and survey engine). It makes and launches a Hedge Designation then Export survey
  through Lens, waits until PostHog serves its targeting flag, then runs `SESSIONS` (120) browser sessions,
  `PARALLEL` (6) at a time: exports right away or after 3 to 4 minutes, opens without exporting, exports
  elsewhere or first, and another client. It reports sessions as expected and the delay from Export to the
  survey on screen (min, median, p95, max), and writes `run/real-sessions/results-<stamp>.json`. Set
  `REAL_PH`, `REAL_TOKEN` (project token), `REAL_KEY` (personal key with survey write) and `REAL_PROJECT`.
  The project needs surveys turned on (`surveys_opt_in`), and PostHog must serve the Lens survey engine.
- `npm run ui-shots -- <folder>`: screenshots of every page and tab at 1440 and 375 pixels in dark and light,
  plus empty and error states, against a stand-in PostHog with sample data.
