# Live query and history audit

Schema v8 rebuilds the unreleased v7 analysis tables. It keeps task rollups,
resets analysis_days, and makes the normal runIngest backfill queue rescan missing
analysis days on subsequent ingestion runs (tasks.backfillDaysPerRun per run).
Until coverage is finalized, complete, untruncated and aligned, tools use the live
reader. Day replacement, dictionary updates and all analysis summaries share the
existing task transaction. No independent answer cache survives replacement.

Session ownership is the ingestion start day. Friction and error-session counts
therefore add across days; client support is a small set derived from per-client
contributions. Workflow starts still belong to their actual open day. Only
sessions with opens on multiple dates retain sparse boundary identities, so a
repeated chain spanning midnight is counted once over the combined window.
Ordinary session identifiers never appear in discovery or friction support.
Users are interned in analysis_dictionary; exact daily membership is unioned over
the requested window. Error templates retain counts and bounded replay/message
examples, rather than all matching sessions.

- friction_daily packs per-client/dialog counters into a Brotli-compressed day
  record. Its session supports are counts, including per-template supports.
- workflow_daily keeps per-client breakdowns only for chains shared by multiple
  clients. A single-client chain's complete statistics live once in
  workflow_global_daily. Global details are partitioned by chain length.
- workflow_support_daily is a compact varint index of chain codes, session counts,
  sparse midnight identities and client membership. Each day/length also records
  maximum support and maximum client breadth. Their window sums are rigorous
  upper bounds. If **all** longer lengths are below the two-chain ranking cutoff
  and below 80% of every candidate above that cutoff, those lengths cannot rank
  or remove an answer and need not be decoded. Otherwise every length is read.
  Containment indexes proper contiguous sub-chains (at most five per chain).
  No per-day minimum-support pruning occurs. Ranking ties load every tied
  candidate's details before sorting by the original full workflow name.
- Discovery retains exact duration frequency distributions; completion retains
  fractional-second deltas. Their medians and p90s remain exact, not bucketed.
  The pre-existing task-map/flow-time histograms remain bucketed as before.
- workflow_episodes_daily stores an interned step string and open-code header per
  episode: original indices, second deltas, one-character kinds/outcomes, reply
  causes, button labels, and error template/text ids. Fields/grids are discarded
  **after** resolving episode boundaries and attribution. Completion decodes only
  requested-dialog steps; unrelated opens are allowed and cannot advance the
  ordered funnel. No full Step or RawEvent JSON is stored. Episodes retain the
  configured history (default 400 days): the `when` schema is an unrestricted
  string, explicit task windows allow 400 days, and completion also compares an
  equally long preceding window. There is no smaller schema maximum permitting
  safe shorter episode retention; missing coverage uses live reads.
- Completion reports rank clients by total attempts across both periods and show
  at most eight, further reducing that list if needed for the payload budget.
  clients_rest reports the omitted client count and additive attempt/outcome/
  failure/retry/abandonment totals. Overall metrics include every client. Replay
  lookups are limited to examples in displayed rows.
- analysis_names_daily interns dialog/title strings and combines observed counts
  for name resolution. analysis_client_daily keeps the *raw event* sufficient
  statistics for client signals, separately from attributed submit outcomes;
  top_pains can answer wholly from processed history without a raw client scan.
- task_attempts replay examples expire after 30 days in ingestDay/runIngest.
  flow_time permits 400-day windows, so this is explicitly an examples-only
  retention change: older slowest examples are absent, as stated in its note.
  Exact top-error counts now live in task_errors_daily with interned templates;
  all task counts, paths, user unions and histograms retain their previous history.
  Redundant secondary copies of daily user/path rows were removed: primary keys
  already lead with day and support the readers' bounded range scans.

The requested universal subset argument has a qualification: candidates require
an actual submit on their final dialog. An A,C,B occurrence with a submit only on
B qualifies as A,C,B and C,B, but not A,C. Thus qualified prefix support is not
universally a superset. Both HEAD and the supplied starting changes compare the
**longer chain count**, not a Set intersection. v8 preserves that exact rule.
Generated repeated/collapsed chains and episode boundaries compare the indexed
rule against that prior pairwise Set-support function. The counterexample is a
separate regression test; no unsupported intersection equivalence is claimed.

The durable client_roster in tasks.db is shared by anonymisation and resolution.
Only an empty store waits for a 400-day full scan. Refreshes scan from the last
successful scan's start timestamp minus two days through the new scan start (events
can arrive late with their original timestamps; ~0.5M rows at 100M events a year),
consume every client-id page, and atomically upsert name/last_seen and watermark.
A full rescan becomes due after LENS_ROSTER_FULL_RESCAN_DAYS (default 7) and runs
in the background; request refreshes still await their incremental scan. Failed
scans never advance a watermark or erase known names. knownClients reads the
local roster with no population cap and no separate 90-day event scan.

MCP relative last/past N day/week/month windows end at dataThrough(), inclusive
in UTC. Explicit windows remain literal. The live path uses timestamp bounds,
keyset session pages, and event pages keyed by (session, timestamp, uuid). All
pages are consumed; limits are page sizes, not population caps. No sampling or
extrapolation occurs (sample_rate=1). Workflows allow one day on either edge for
session context. Longer sessions and concurrent late-arriving data can still be
partial. Failed queries/pagination throw rather than returning partial totals.
A window-wide live read counts its events first and refuses above LENS_LIVE_MAX_EVENTS
(default 1,000,000), naming the last processed day, instead of reading part of the
window or exhausting memory (each keyset page re-reads the rest of the window).
Reads of explicit session-id batches are bounded by the batch and not counted.

A day that was processed before is re-read by the analysis backfill. If PostHog now
returns fewer sessions for it (retention, deletion), the stored history is kept and
the day is recorded as analysis_unavailable in task_state: the new analyses report
it as missing coverage instead of rebuilding from a smaller read.

Client signals use uniqExactIf and a per-user aggregate to count disappeared
users exactly. Period users arrays stay empty for shape compatibility; user_count
holds the total. quiet_users contains at most six examples; quiet_user_count is
the total. Signal weights use totals, never the example-array length.

## Remaining HogQL calls in src/core

This inventory includes calls inside Promise.all and injected query wrappers,
not only lines matching `await hogql(`. The regression test checks every direct
literal HogQL call for a timestamp predicate or these explicit exceptions.

| File | Scope and LIMIT meaning |
| --- | --- |
| liveevents.ts | Explicit [from,to); every timestamp/uuid keyset page is read. |
| workflowqueries.ts | Explicit [from,to) session discovery, keyset paging; event reads use liveevents with ±1 day. |
| appevents.ts | Dialog names and client groups keyset page within explicit windows. Client quiet-user aggregate covers both periods. Other calls use explicit windows or the 400-day session-story horizon. slowAttempts deliberately inspects a disclosed number of newest recorded sessions; findTrade returns a requested list of recent hits; session story and trade/slow context reads have per-session caps, not population estimates. Vocabulary calls return top examples, not totals inferred from those examples. |
| messagedoctor.ts | Explicit error window and all keyset session pages. All events from one minute before window through observed_through; no population cap or omitted oversized sessions. |
| brief.ts | Concentration now uses complete liveevents pages. |
| tasks.ts | All queries (through taskQuery) have explicit day bounds, including a preceding-day ownership check and next-day context. Event LIMITs are consumed keyset pages. Safety caps mark truncated and prevent finalization/history coverage. |
| incidents.ts | findIncidents has explicit bounds and returns the requested newest incident list. **recordingSpans exception:** raw_session_replay_events metadata is keyed by an explicit set of session ids; no event timestamp column/window applies. Start/end are what the lookup discovers. |
| recording-info.ts | Recording metadata supplies timestamp bounds with a one-minute margin; capped list of moments for one recording. |
| impact.ts | Shared base includes a rolling timestamp bound; optional failure-rate and top-screen-errors queries have their own bounds. Totals aggregate before ranked client/error display limits. |
| usage.ts | Shared scope has a rolling timestamp bound. Totals computed separately from top clients/busiest-day display limits. |
| silent.ts | Explicit window; deliberately returns recent struggle sessions. Repeated-event counts aggregate to the top event for each selected session before the outer limit (at most 200 selected sessions). |
| resolve.ts | knownClients reads the durable local roster without a cap. Email/domain lookups retain explicit rolling 90-day bounds and ranked matches. |
| clientroster.ts / anonroster.ts | Incremental since/until bounds with a two-day overlap; background or empty-store full scan covers 400 days. Every client-id page is consumed. |
| releases.ts | All queries have explicit or since timestamp bounds. Surveys use timestamp/uuid keyset pages rather than the first 20k answers. Area/error queries are ranked candidate lists; weekly/adoption output is grouped before limits. |
| experience.ts | Rolling timestamp bounds on events and replay metadata. Replay candidates are a disclosed processing queue, not population event estimates; vocabulary is a ranked name allowlist. |
| surveys.ts | surveyQuery wrapper: source CTEs bound timestamp by days, including funnel and response aggregates. Answer and label listings page; bounded ranked client/example lists expose truncation where appropriate. |

Counts are complete within the existing ingestion session horizon, not a promise
that PostHog will never receive a late event. Large historical windows still use
memory proportional to distinct chains/users and completion attempts. Checked in a
100M-event ClickHouse lab (PostHog's ClickHouse build, 97.4M Reval-shaped events, 60 days
ingested) against an independent oracle that does not use Lens code.
