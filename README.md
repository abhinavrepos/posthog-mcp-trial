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
