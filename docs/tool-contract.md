# Lens MCP tool contract

All Lens tools pass through `wrapTools` in `src/mcp/tools.ts`, over both HTTP and stdio. The HTTP route supplies the authenticated email and database token id from `chatCaller`; raw tokens never enter audit records. Transport privacy refusals also consume budget and write audit metadata.

## Time arguments

Every tool with `when`, `days`, `weeks`, or `from`/`to` advertises the shared `src/mcp/timeinput.ts` model. Use exactly one selector:

- `period`: `today`, `yesterday`, `last_7_days`, `last_14_days`, `last_28_days`, `last_30_days`, `last_90_days`, `last_6_months`, `last_12_months`, `last_2_years`, `last_3_years`, `last_4_years`, `this_week`, `this_month`, `this_quarter`, `this_year`, `last_week`, `last_month`, `last_quarter`, `last_year`, `all_time`.
- `from` and `to`: real inclusive UTC dates, `YYYY-MM-DD`, ordered, no future dates, at most 1,500 inclusive days. Example: `{"from":"2024-11-01","to":"2025-11-30"}`.
- Deprecated `when`: existing natural language and timezone parsing. Legacy `days`/`weeks` still work; do not combine them with another selector.

Omitting all selectors uses the tool's documented default. Rolling windows end at the last fully processed day (`dataThrough`), or yesterday when processing history is unavailable. `last_month`, `last_quarter`, `last_year`, and `last_week` mean the previous full calendar unit. `this_*` starts in the current UTC calendar unit and ends at the processed prefix; on a boundary with no completed days yet, it requests the first literal day and discloses that processing is incomplete. `today` and `yesterday` are literal UTC days. `all_time` preserves the existing bounded 1,500-day history contract.

Comparison-capable tools accept `compare: "previous" | "none"` or `compare_from`/`compare_to`. Legacy `compare_with: {from,to}` and `compared_with` still work. Comparison selectors are mutually exclusive and date ranges have the same validation. Results carry inclusive `window.from`/`window.to`, with processing, coverage, and limit disclosures. SQL receives an exclusive end timestamp.

Day-count-only query functions use an async context for exact date ranges, and their caches include the resolved range. The scorecard MCP adapter samples complete Sunday observations inside the requested range, reusing weekly observations without changing the performance engineer's scorecard or weekly modules.

## Errors

Tool execution errors remain MCP `isError` results. Every invocation gets a UUID correlation id; stderr contains only the correlation id, tool, fixed error category, HTTP status and a fixed safe message in every privacy mode. Raw diagnostics are appended only to `LENS_DEBUG_ERRORS_FILE` when configured, with credential redaction and file mode 0600. Public messages never echo thrown diagnostics.

| Kind | Public recovery instruction |
| --- | --- |
| validation | Names the invalid field/constraint and supplies example arguments; time failures enumerate periods and show inclusive dates. |
| not_found | Use `resolve_client`, `find_task`, `discover_workflows`, or `list_surveys` to obtain a valid id. |
| capacity | Narrow the window, use a coarser bucket, or remove grouping dimensions. Includes memory and timeout failures. |
| unavailable | PostHog is unavailable/busy; retry later. History still building has its own progress guidance. |
| rate_limit | `Rate limit: N calls in the last minute; try again in S seconds.` |
| internal | Retry later; provide the correlation id to an administrator if the failure persists. |

The SDK normally validates before handlers. Lens delegates its `validateToolInput` step to the wrapper so schema failures also receive limits, audit records, and actionable execution errors. In-memory SDK integration tests cover this integration point. Advertised schemas remain strict JSON Schema; runtime cross-field validation uses Zod refinements.

## Budgets and audit

Two token buckets are checked atomically per authenticated invocation: one per token id and one per normalized user email across tokens. Defaults are 60 weighted calls/minute and 600/hour, with at most four active calls per user. Cache hits, invalid arguments, and privacy refusals count. Heavy tools cost five: `aggregate_events`, `workflow_completion`, `discover_workflows`, `signal_scorecard`, `describe_app_events`, `message_doctor`, `find_trade`, `top_pains`. Everything else costs one. Refills are continuous; rejection never sleeps or queues. Each bucket has constant-size state; idle entries expire after an hour. Budgets are process-local and reset on restart; deployments with multiple independent server processes need shared admission storage for a deployment-wide budget.

The main SQLite database migration adds `tool_audit`: `id`, `at`, `user_email`, `token_id`, `tool`, `argument_keys` (JSON keys only), `resolved_window` (JSON dates), `client_ids` (resolved ids only), `duration_ms`, `result_chars`, `is_error`, `error_kind`, `privacy_mode`, `correlation_id`. No argument values or result content are stored. Failed validation/refusals may have no resolved window or client. Shared-token and stdio invocations use stable identity labels because no personal email is available.

`GET /replays/admin/api/tool-audit?limit=100&offset=0` uses the existing admin authorization. Limits are bounded to 1,000 rows. Audit records older than 90 days are pruned hourly. Audit write failures are logged with the correlation id; they do not repeat a potentially mutating tool call. Configuration is documented in `.env.example`: `LENS_MCP_CALLS_PER_MINUTE`, `LENS_MCP_CALLS_PER_HOUR`, `LENS_MCP_CONCURRENT_CALLS`, `LENS_MCP_AUDIT_RETENTION_DAYS`.

## Validation in the Task A sandbox

- `npx tsc --noEmit`: clean.
- `npm test`: blocked before test execution by the sandbox's `tsx` IPC listener (`EPERM`). No dependencies were installed.
- Requested fallback, `node --import tsx --test test/*.test.ts`: 61 files, 50 passed and 11 failed. Parallel timing failures included anonymisation, rescue, and scorecard.
- Sequential fallback, `node --import tsx --test --test-concurrency=1 test/*.test.ts`: 61 files, 50 passed and 11 failed. Anonymisation passed; the failures were the eight sandbox-dependent files below, rescue/scorecard timing assertions, and a clip callback test fixture that needed the new error mapper injected. That fixture was subsequently fixed without removing its queue/hourly-admission assertions.
- Final targeted fallback for `tool-contract`, `brief`, `mcp-releases`, `security-mcp`, and `posthog-policy`: **5 files passed, 0 failed**.
- New contract tests executed directly with `node --import tsx test/tool-contract.test.ts`: **49 passed, 0 failed**.
- An earlier per-file diagnostic run passed all 16 rescue tests. The sequential full run exceeded its timing threshold. The unchanged scorecard cold-replay assertion also fails on a separate checkout of the git baseline: **6,825 ms against a 5,000 ms budget**. Its performance implementation and assertions were left to the parallel performance task.

The full suite is **not green in this sandbox**. These files cannot complete their external-operation checks here:

| File | Blocked operation |
| --- | --- |
| `test/comments.test.ts` | Executing the ffmpeg binary |
| `test/egress.test.ts` | Listening on loopback sockets |
| `test/install-permissions.test.ts` | Spawning bash |
| `test/offline-upgrade.test.ts` | Spawning bash |
| `test/posthog-client.test.ts` | Listening on a loopback socket (startup failure) |
| `test/security-server.test.ts` | Listening on a loopback socket |
| `test/status-alerts.test.ts` | Listening on a loopback socket |
| `test/survey-engine.test.ts` | Spawning Node for the build script |

Existing tests changed intentionally: `core` and `fouryear` assert the new error wording and full-calendar quarter; `dashboard-tools` checks the business-first sentence and actionable error; `messagedoctor` expects typed time fields; `privacy-modes` expects thrown diagnostics to be withheld; `experience` places replay fixtures on a completed day. `authorization-regressions` now exercises the actual SDK wrapper instead of extracting it into a stub, and `security-mcp` injects the new error mapper into its existing isolated callback fixture.

## File inventory

New contract implementation: `src/mcp/timeinput.ts`, `toolerror.ts`, `publicerror.ts`, `ratelimit.ts`, `toolaudit.ts`, `scorecardwindow.ts`, and `src/core/toolcontext.ts`.

Tool boundaries and registrations: `src/mcp/tools.ts`, `dashboardtools.ts`, `surveytools.ts`, `historyresult.ts`, `anonymise.ts`, `posthog-proxy.ts`, `stdio.ts`.

Core time/query integration: `src/core/timewindow.ts`, `usage.ts`, `impact.ts`, `appevents.ts`, `experience.ts`, `surveys.ts`, `brief.ts`, `story.ts`.

Persistence and service integration: `src/core/db.ts`, `src/service/access.ts`, `admin.ts`, `server.ts`; configuration: `.env.example`; documentation: this file.

Tests: new `test/tool-contract.test.ts`; updated `test/authorization-regressions.test.ts`, `core.test.ts`, `dashboard-tools.test.ts`, `experience.test.ts`, `fouryear.test.ts`, `messagedoctor.test.ts`, `privacy-modes.test.ts`, `security-mcp.test.ts`.

No edits to `src/core/aggregate.ts`, `analysishistory.ts`, `scorecard.ts`, `weekly.ts`, or `workflowqueries.ts`. No commits.

## Scaling note
The rate limiter keeps its buckets in process memory. That is correct for Lens's supported deployment (one service
process per installation, like the task-history ingester and the background jobs). Running more than one Lens
process behind a load balancer would need the buckets in a shared store (SQLite with a short write transaction,
or Redis/Valkey where available); until then each process would enforce the limits separately.

## PostHog analytics jobs

`posthog_exec` runs `call query-*` (every query tool), `call execute-sql`, and insight/dashboard calls with refresh/compute/query/run/calculate operations or enabled refresh/force_refresh/forceRefresh/compute flags as jobs inside `wrapTools`. `tools`, `help`, `search`, `info`, `schema`, `call docs-search`, definitions, and object list/get calls without refresh remain synchronous. Job-backed invocations cost five limiter units; cheap commands and `get_job_result` cost one. Single-flight binds the user, full command, and privacy/access revision. Private SQL and overlapping-command refusals are unchanged; results still pass the masking boundary, including polling.

The ordinary job race returns a result or `{status:"running",job_id}` within 20 seconds. Poll with `get_job_result`; request disconnects do not cancel the job. `LENS_POSTHOG_QUERY_TIMEOUT_SECONDS=600` controls the upstream execution limit, starting after queue admission; synchronous calls keep 30 seconds. Cancellation and expiry abort queued or active HTTP work, with best-effort upstream session deletion. This stops Lens waiting; PostHog's own query engine determines whether already-submitted database work stops immediately.

A process-wide FIFO gate admits `LENS_POSTHOG_MAX_CONCURRENT_QUERIES=3` analytics jobs independently of the general worker-thread limit. At most `LENS_POSTHOG_MAX_QUEUED_QUERIES=30` wait; overflow says PostHog is busy and to retry later. Existing per-user outstanding-job limits and expiry still apply. As with other process-local admission controls, use one Lens service process for these limits.

Upstream HTTP failures, JSON-RPC errors and MCP `isError` answers use fixed public messages with correlation ids. Memory/data-capacity failures suggest narrowing dates/filters or Lens `aggregate_events`; timeouts add job retry guidance; 429 responses include a valid Retry-After delay; 401/403 explain the key's access; unavailable servers suggest retrying later. Raw diagnostics go only to the optional administrator error file; stderr receives fixed safe metadata.

The `/posthog-mcp` streaming proxy keeps its existing streaming and 30-second timeout behavior and cannot return job handles. It applies the same failure mapping, including SSE error frames. Each authenticated proxied tools/call, including every batch member and policy refusal, uses the shared user/token limiter and tool audit (`posthog:<command>`, argument keys only). Analytics use the same PostHog concurrency gate; analytical batch members are dispatched sequentially as individual upstream requests to prevent upstream batch parallelism from bypassing that gate. Agents should use `posthog_exec` for long queries; this is the default PostHog tool when `POSTHOG_MCP_VIA_LENS=on`.

## Review E boundary updates

Read-only analytical tools use job dispatch by default. The explicit fast exceptions are `resolve_client`, `get_replay_link`, `find_task`, `list_dashboards`, `get_job_result`, and configuration-only describe tools; writes stay direct. Fast completed analyses return their ordinary output through the same boundary. A reusable `LENS_JOB_WORKERS` pool (default two) executes raw analytical callbacks, including synchronous SQLite and decoding, off the service thread. PostHog analytics keep their separate HTTP gate.

Every authenticated unknown tool call is limited and audited as `unknown`, with `error_kind=unknown_tool` and no untrusted argument keys. HTTP/stdio transport handles malformed names and preserves a normal JSON-RPC error; SDK-only callers are covered by the dispatcher fallback. Privacy refusal accounting accepts JSON-RPC errors without an MCP result.

Each job runner has a random instance owner. Working rows carry `owner_instance` and `lease_expires`; leases last 30 seconds and renew every 15 seconds. Startup recovery fails only leases expired more than 60 seconds ago (legacy unleased rows count as expired). Live jobs survive a second runner opening the database. Admission and worker/query concurrency remain process-local, as documented above.
