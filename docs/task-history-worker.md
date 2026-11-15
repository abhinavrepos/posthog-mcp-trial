# Task history worker

`startTaskHistory()` enables worker dispatch before scheduling the initial 15-second run.
Both `runIngest()` and `ingestDay()` then use the same main-process `ingestOwner`;
requests made while it is busy are skipped, preserving the existing scheduler semantics.
There are no admin/API callers of either function in this checkout (the other callers
are offline scripts and tests). New service entry points should use these functions
after `useTaskHistoryWorker()` or `startTaskHistory()`.

The lazy, reusable worker runs ingestion, retention and both backfill paths. It is
independent of `AnalysisWorkerPool`, opens its own task and service SQLite connections,
and inherits WAL and a 30-second busy timeout. Existing transaction boundaries are
preserved. `TASKS_WORKER_MEMORY_MB` sets its V8 old-generation limit (default 1536 MiB).
This limits the JavaScript heap, not total process RSS or native allocations.

The owner reflects pending work in `ingestStatus().running`; the worker updates the
existing SQLite `task_state` timestamps/errors. Error and exit events reject pending
work, clear reader caches conservatively, and leave the owner ready to create a new
worker on the next scheduled/manual request. Logs use `errorDiagnostic`; raw worker
exceptions are not sent back to the main process. An interrupted run is retried by
the next run, not automatically replayed immediately.

## Cache messages

The worker emits `{type: 'stored', days, kinds}` after committed day writes, aggregate
writes, performance backfills, and retention cleanup. The main process applies the
message locally and forwards it to every existing analysis-pool worker. Pool workers
process invalidations and jobs in message order.

| Writer/message | Reader effects |
| --- | --- |
| `storeAttempts`, kind `day` (includes analysis rollups) | Advance history generation; range-evict task answers; clear coverage and catalog memos. Writer deletes affected weekly observations as before. |
| `ingestAggregateDaily`, kind `aggregate` | Same day effects plus `forgetAnswers(true)`. |
| `backfillPerformanceHistory`, kind `performance` | Same day effects plus `forgetAnswers(true)`. |
| End-of-run retention, kind `cleanup` | Advance generation; `forgetAnswers(true)` clears local answers/memos, preserving durable weekly observations. |
| Every stored notification | Clear MCP tool answers/flights with an epoch guard against stale flight completion; forget privacy roster age and codename matcher. |
| Worker crash | Conservative cleanup notification, including analysis workers, covers writes committed immediately before a crash. |

`forgetAnswers(false)` still removes durable weekly observations for explicit maintenance.
Analysis-history readers have no separate answer cache. The SQLite data-version part
of `historyGeneration()` continues detecting changes made by other connections.

## Offline hooks and validation

Without `useTaskHistoryWorker()` / `startTaskHistory()`, `setTaskQuery`, `ingestDay`,
and `runIngest` remain in-process. Functions/closures are never transferred to the
worker. `LENS_INGEST_BOOTSTRAP` is an optional worker-only module URL with an async
`default()` hook for offline worker fixtures (analogous to `LENS_JOB_BOOTSTRAP`).
Production does not need this setting.

Run `node --import tsx tools/measure-ingest-loop.ts` for a real synthetic source scan,
step extraction, analysis rollups and SQLite writes, first in-process and then in
the dedicated worker. It uses temporary databases and asserts that ingestion takes
seconds and worker main-thread p99 delay stays below 200 ms. A 300,000-event run here
measured 12.15 seconds / 12163.48 ms p99 before, and 11.68 seconds / 12.78 ms p99 after.

The integration test covers serialization, status, catalog/answer invalidation in
the main thread and a reused analysis worker, weekly-preserving cleanup, forced
worker exit and recreation. Tool-cache tests cover stale in-flight completions.

Residual risks: SQLite still has one writer; concurrent service writes can contend
with existing ingestion transactions even though WAL readers continue. Worker heap
limits cannot isolate process-wide/native OOM or CPU contention on a single-core
host. Normal request handling and unrelated synchronous analytics remain outside
this change.

Validation in this sandbox: `npx tsc --noEmit` passed. `npm test` could not start
because tsx's IPC listener is forbidden. The fallback full `node --import tsx --test`
run was supplemented by executing all 67 test files individually to expose their
case counts; final focused tests also passed under `--test`. With isolated reruns
of the timing-sensitive scorecard and final updated cache test, results were
993 passed, 19 skipped, 12 failed cases due to sandbox EPERM restrictions, plus
`posthog-client.test.ts` aborting before case counts due to a forbidden listener.
59 of 67 files passed completely. The scorecard's isolated cold replay passed in
4716 ms (its five-second assertion failed under concurrent suite load).

Sandbox-blocked files:
- `comments.test.ts`: ffmpeg subprocess (one case).
- `egress.test.ts`: loopback listeners (three cases).
- `install-permissions.test.ts`: bash subprocess (one case).
- `offline-upgrade.test.ts`: bash subprocesses (four cases).
- `posthog-client.test.ts`: loopback listener, aborts before case reporting.
- `security-server.test.ts`: loopback listener (one case).
- `status-alerts.test.ts`: loopback webhook listener (one case).
- `survey-engine.test.ts`: Node subprocess (one case).
