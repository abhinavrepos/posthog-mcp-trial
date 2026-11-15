# Multi-user MCP load test

Measured on 2026-11-15 against the existing Lens server at `http://127.0.0.1:18331/mcp`. The lab supplies 150 synthetic clients, one year of retained history (2025-11-15 through 2026-11-14), and a simulated PostHog backed by approximately 389 million ClickHouse events. This is a shared-machine measurement, not a production capacity guarantee.

## Method

The harness in `tools/load-test/run.mts` uses the MCP SDK `Client` and `StreamableHTTPClientTransport`. Each PM has a personal token created through `src/service/access.ts` with `posthog_admin: true`, an independent session, and one business operation in flight. Identities are reused across scenarios, so per-user token buckets carry over. Tokens stay in memory and are absent from result files. A failed PID-discovery preflight created an unused set of 20 tokens before the measured run; the measured run uses one new token per user. These tokens were revoked afterwards; the harness now revokes its own tokens on exit (including Ctrl-C).

Scenarios admit work for eight minutes at N=5, 10 and 20, in that order. Each user follows an offset 18-step script with seeded random 2–10 second think time and clients selected across the 150-client roster. Thirteen steps are light-intent PM work: resolve_client; client_story in monthly buckets over the retained year; task_map and dialog_friction for last_28_days; top_pains for last_7_days; rescue_queue for last_28_days. Five steps are heavier: aggregate_events over last_12_months by month and app_version (events, sessions, clients); workflow_completion over last_12_months using a discovered workflow ID; discover_workflows for last_12_months; compare_client_patterns across the retained year; client_signals for last_90_days. Explicit period or inclusive from/to inputs are used throughout. A completion step falls back to discovery until an ID has been returned.

An initial answer can be a result or a job handle. Handles are polled using get_job_result, respecting the advertised poll delay, with an additional ten-second wait on throttled polls. Polls are separate physical-call records linked to the initiating operation. End-to-end completion latency includes polling and waits, excludes think time, and is assigned to the original tool. Outstanding handles have a bounded drain period; unfinished operations are censored. Non-rate_limit/non-busy business-operation errors above 5% stop the run early. Request timeouts are 45 seconds.

A separate pre-existing lab admin token probes resolve_client(C01) every five seconds without spending the PM users' budgets. Read-only SQLite samples record active analysis jobs. Persisted status `working` includes both running and pending work, so max(working − 2, 0) is only a proxy for pending jobs with two configured workers. It is not an exact queue gauge. Samples include any other shared-server work. Queue-full busy responses are the direct saturation signal; five-second sampling can miss short bursts.

**RSS limitation:** `/proc/net/tcp` exposes the port's listening inode, but the sandbox PID namespace hides the owning server process from `/proc/*/fd`. Therefore neither server VmRSS nor runtime environment overrides can be independently sampled. RSS is reported as unavailable, never zero. No sandbox restriction was bypassed and the server was not restarted or reconfigured. The known launch script sets `LENS_TOOL_CACHE_SECONDS=0`; other caches and warmed worker state can still affect later scenarios.

Raw calls, completions and samples are in `tools/load-test/results/n{N}.jsonl`; metadata and scenario summaries are alongside them. Regenerate tables with `node --import tsx tools/load-test/analyze.mts`. Payload characters count the serialized SDK response envelope. Percentiles use nearest rank; p99 on small sample sets is often the maximum. First-answer columns show both all calls and non-error calls. Final-result percentiles use successful completed operations, excluding errors and censored observations; get_job_result reports the duration of successful terminal polls. An em dash means no qualifying observation. Error percentages use physical calls as denominator.

## Results

All admission windows completed without triggering the >5% error stop. There were **1,035 physical calls**, **325 business operations**, **312 successful completions**, and **13 censored operations** (one at five users, twelve at twenty). Total measured wall time including drains and session transitions was **27 minutes 20 seconds**, below the 45-minute limit. No production default was changed.

| PM users | Physical calls | Business operations | Successful / censored | Initial handles | Responsiveness p95 | Max active jobs / pending-work proxy | Max RSS |
|---:|---:|---:|---:|---:|---:|---:|---|
| 5 | 177 | 104 | 103 / 1 | 33/104 (31.73%) | 870 ms | 5 / 3 | Unavailable |
| 10 | 281 | 85 | 85 / 0 | 69/85 (81.18%) | 965 ms | 10 / 8 | Unavailable |
| 20 | 577 | 136 | 124 / 12 | 114/136 (83.82%) | 748 ms | 20 / 18 | Unavailable |

For **each scenario**, rate_limit, busy, validation, capacity, internal, unavailable and other observed tool error counts were **0 (0%)**. All 288 responsiveness probes succeeded. There were **zero queue-full refusals**. Active jobs exceeded two in 69/96, 94/96 and 95/96 samples respectively: pending work was common even though admission capacity was not exhausted. This is an absence of rejection at the tested load, not a claim of low queue latency.

The strongest signal is completion latency rather than errors. Aggregate_events successful p95 completion increased from 137.868 s to 150.902 s to 170.202 s. At twenty users, even locally backed PM tools frequently waited long enough to return handles, and 12/136 operations were unfinished at the observation cutoff. Successful-only completion percentiles omit those censored tails and may understate latency for the full arrival set. Censoring is a measurement cutoff, not a tool error. The five-second probe p95 stayed below one second, although its ten-user p99 reached 2.287 s. Scenario ordering, warming, shared-machine traffic and the early concurrent test run prevent treating differences as a controlled worker-capacity curve.

Coverage was limited by the eight-minute closed-loop scripts. All requested tools were exercised overall; client_signals had no calls in the ten-user scenario and is shown as a zero-observation row. Several other scenario/tool combinations have very small samples. The script's tool proportions describe intended steps, not guaranteed equal realized counts when long jobs delay progress. A censored job can finish after its client's observation deadline and can overlap the next scenario; database samples deliberately include that carryover.

### 5 PM users

2026-11-15T16:07:58.873Z to 2026-11-15T16:16:59.540Z; 9.01 minutes; stop: duration. 177 physical calls, 104 business operations (103 successful), 74 handle responses (41.81% of physical calls); 33/104 initial calls returned handles. Errors 0.00%. Highest observed successful per-user rolling-minute consumption: 28 weighted credits. Max RSS: unavailable (sandbox PID namespace). Responsiveness p95: 0.870 s; 0/96 probe errors. Sampled active jobs max 5 (5 test-owned); pending-work proxy max 3; 69/96 samples above two active jobs.

| Tool | Calls | First p50/p95/p99, all (s) | First p50/p95/p99, non-error (s) | Final p50/p95/p99, successful (s) | Handles | Errors / physical calls | Censored |
|---|---:|---|---|---|---:|---|---:|
| aggregate_events | 7 | 20.058 / 20.157 / 20.157 | 20.058 / 20.157 / 20.157 | 85.312 / 137.868 / 137.868 | 100.00% | 0 | 1 |
| client_signals | 5 | 0.423 / 3.992 / 3.992 | 0.423 / 3.992 / 3.992 | 0.424 / 3.993 / 3.993 | 0.00% | 0 | 0 |
| client_story | 17 | 7.607 / 20.142 / 20.142 | 7.607 / 20.142 / 20.142 | 7.607 / 53.260 / 53.260 | 29.41% | 0 | 0 |
| compare_client_patterns | 5 | 11.468 / 20.042 / 20.042 | 11.468 / 20.042 / 20.042 | 11.468 / 25.151 / 25.151 | 20.00% | 0 | 0 |
| dialog_friction | 12 | 2.752 / 20.853 / 20.853 | 2.752 / 20.853 / 20.853 | 2.756 / 75.634 / 75.634 | 25.00% | 0 | 0 |
| discover_workflows | 5 | 20.034 / 20.599 / 20.599 | 20.034 / 20.599 / 20.599 | 29.468 / 37.763 / 37.763 | 80.00% | 0 | 0 |
| get_job_result | 73 | 15.039 / 15.136 / 15.156 | 15.039 / 15.136 / 15.156 | 2.084 / 13.072 / 14.018 | 56.16% | 0 | 0 |
| rescue_queue | 12 | 8.204 / 20.126 / 20.126 | 8.204 / 20.126 / 20.126 | 8.205 / 78.419 / 78.419 | 25.00% | 0 | 0 |
| resolve_client | 11 | 0.185 / 0.214 / 0.214 | 0.185 / 0.214 / 0.214 | 0.185 / 0.214 / 0.214 | 0.00% | 0 | 0 |
| task_map | 12 | 0.663 / 20.119 / 20.119 | 0.663 / 20.119 / 20.119 | 0.663 / 65.268 / 65.268 | 25.00% | 0 | 0 |
| top_pains | 13 | 0.268 / 20.065 / 20.065 | 0.268 / 20.065 / 20.065 | 0.269 / 65.311 / 65.311 | 15.38% | 0 | 0 |
| workflow_completion | 5 | 20.060 / 20.520 / 20.520 | 20.060 / 20.520 / 20.520 | 57.038 / 69.068 / 69.068 | 100.00% | 0 | 0 |

### 10 PM users

2026-11-15T16:17:01.375Z to 2026-11-15T16:26:01.128Z; 9.00 minutes; stop: duration. 281 physical calls, 85 business operations (85 successful), 196 handle responses (69.75% of physical calls); 69/85 initial calls returned handles. Errors 0.00%. Highest observed successful per-user rolling-minute consumption: 16 weighted credits. Max RSS: unavailable (sandbox PID namespace). Responsiveness p95: 0.965 s; 0/96 probe errors. Sampled active jobs max 10 (10 test-owned); pending-work proxy max 8; 94/96 samples above two active jobs.

| Tool | Calls | First p50/p95/p99, all (s) | First p50/p95/p99, non-error (s) | Final p50/p95/p99, successful (s) | Handles | Errors / physical calls | Censored |
|---|---:|---|---|---|---:|---|---:|
| aggregate_events | 7 | 20.061 / 20.975 / 20.975 | 20.061 / 20.975 / 20.975 | 131.365 / 150.902 / 150.902 | 100.00% | 0 | 0 |
| client_signals | 0 | — / — / — | — / — / — | — / — / — | — | 0 | 0 |
| client_story | 14 | 20.086 / 20.553 / 20.553 | 20.086 / 20.553 / 20.553 | 46.159 / 120.416 / 120.416 | 85.71% | 0 | 0 |
| compare_client_patterns | 1 | 20.121 / 20.121 / 20.121 | 20.121 / 20.121 / 20.121 | 86.995 / 86.995 / 86.995 | 100.00% | 0 | 0 |
| dialog_friction | 10 | 20.045 / 20.158 / 20.158 | 20.045 / 20.158 / 20.158 | 45.356 / 105.361 / 105.361 | 90.00% | 0 | 0 |
| discover_workflows | 8 | 20.090 / 20.357 / 20.357 | 20.090 / 20.357 / 20.357 | 54.444 / 129.443 / 129.443 | 100.00% | 0 | 0 |
| get_job_result | 196 | 15.036 / 15.251 / 15.689 | 15.036 / 15.251 / 15.689 | 3.228 / 13.947 / 15.073 | 64.80% | 0 | 0 |
| rescue_queue | 11 | 20.052 / 20.417 / 20.417 | 20.052 / 20.417 / 20.417 | 49.596 / 106.217 / 106.217 | 90.91% | 0 | 0 |
| resolve_client | 9 | 0.443 / 1.900 / 1.900 | 0.443 / 1.900 / 1.900 | 0.443 / 1.900 / 1.900 | 0.00% | 0 | 0 |
| task_map | 12 | 20.044 / 20.506 / 20.506 | 20.044 / 20.506 / 20.506 | 46.143 / 85.518 / 85.518 | 83.33% | 0 | 0 |
| top_pains | 8 | 20.068 / 20.291 / 20.291 | 20.068 / 20.291 / 20.291 | 45.910 / 93.732 / 93.732 | 87.50% | 0 | 0 |
| workflow_completion | 5 | 20.113 / 20.272 / 20.272 | 20.113 / 20.272 / 20.272 | 80.272 / 114.162 / 114.162 | 100.00% | 0 | 0 |

### 20 PM users

2026-11-15T16:26:01.800Z to 2026-11-15T16:35:19.214Z; 9.29 minutes; stop: duration. 577 physical calls, 136 business operations (124 successful), 453 handle responses (78.51% of physical calls); 114/136 initial calls returned handles. Errors 0.00%. Highest observed successful per-user rolling-minute consumption: 13 weighted credits. Max RSS: unavailable (sandbox PID namespace). Responsiveness p95: 0.748 s; 0/96 probe errors. Sampled active jobs max 20 (20 test-owned); pending-work proxy max 18; 95/96 samples above two active jobs.

| Tool | Calls | First p50/p95/p99, all (s) | First p50/p95/p99, non-error (s) | Final p50/p95/p99, successful (s) | Handles | Errors / physical calls | Censored |
|---|---:|---|---|---|---:|---|---:|
| aggregate_events | 9 | 20.064 / 20.175 / 20.175 | 20.064 / 20.175 / 20.175 | 125.649 / 170.202 / 170.202 | 100.00% | 0 | 2 |
| client_signals | 6 | 20.031 / 20.117 / 20.117 | 20.031 / 20.117 / 20.117 | 65.224 / 128.047 / 128.047 | 83.33% | 0 | 1 |
| client_story | 22 | 20.042 / 20.419 / 20.621 | 20.042 / 20.419 / 20.621 | 66.678 / 126.145 / 128.827 | 90.91% | 0 | 2 |
| compare_client_patterns | 6 | 20.038 / 20.126 / 20.126 | 20.038 / 20.126 / 20.126 | 75.101 / 116.240 / 116.240 | 100.00% | 0 | 0 |
| dialog_friction | 17 | 20.045 / 20.626 / 20.626 | 20.045 / 20.626 / 20.626 | 52.487 / 129.651 / 129.651 | 88.24% | 0 | 1 |
| discover_workflows | 9 | 20.056 / 20.211 / 20.211 | 20.056 / 20.211 / 20.211 | 93.575 / 145.874 / 145.874 | 100.00% | 0 | 2 |
| get_job_result | 441 | 15.030 / 15.137 / 15.255 | 15.030 / 15.137 / 15.255 | 2.821 / 13.636 / 14.040 | 76.87% | 0 | 0 |
| rescue_queue | 16 | 20.034 / 20.688 / 20.688 | 20.034 / 20.688 / 20.688 | 85.441 / 125.593 / 125.593 | 93.75% | 0 | 1 |
| resolve_client | 13 | 0.192 / 0.858 / 0.858 | 0.192 / 0.858 / 0.858 | 0.193 / 0.858 / 0.858 | 0.00% | 0 | 0 |
| task_map | 17 | 20.040 / 20.302 / 20.302 | 20.040 / 20.302 / 20.302 | 65.127 / 128.156 / 128.156 | 88.24% | 0 | 1 |
| top_pains | 16 | 20.042 / 20.222 / 20.222 | 20.042 / 20.222 / 20.222 | 67.102 / 127.025 / 127.025 | 93.75% | 0 | 2 |
| workflow_completion | 5 | 20.043 / 20.167 / 20.167 | 20.043 / 20.167 / 20.167 | 125.235 / 148.222 / 148.222 | 100.00% | 0 | 0 |

## Defaults

Retain all seven defaults. This run measures a closed-loop PM workload with one operation per person; it does not establish an open-loop arrival capacity or resource headroom for increasing parallelism. Successful admission coexists with long analysis waits. Increasing admission budgets or queue depth would allow more pending work without demonstrating better completion throughput.

| Setting | Recommendation | Evidence and limits |
|---|---:|---|
| LENS_MCP_CALLS_PER_MINUTE | Keep 60 weighted credits | No throttles in the measured mix; the three scenarios peaked at 28, 16 and 13 successful weighted credits per user in a rolling minute. Light-intent top_pains, dialog_friction and rescue_queue cost five credits too. There is no measured need to raise this budget. |
| LENS_MCP_CALLS_PER_HOUR | Keep 600 weighted credits | No hourly throttles occurred. Eight-minute scenarios and partially depleted buckets are insufficient to validate an hour of sustained traffic; retain this longer-term protection rather than extrapolating a new default from short runs. |
| LENS_MCP_CONCURRENT_CALLS | Keep 4 | Users serialized business operations and polls; this experiment does not stress four concurrent calls from one user. Global PM concurrency is not the same limit. |
| LENS_JOBS_PER_USER | Keep 4 | Users normally had one detached analysis at a time. No per-user busy refusals occurred; this does not prove that allowing more detached analyses per person is safe. |
| LENS_JOB_QUEUE | Keep 64 | No queue-full refusals occurred. Active-plus-pending job sampling remained below the 66-job admission envelope (two active plus 64 pending). Do not enlarge a queue that already produces long completion waits. Exact queue occupancy is not exposed. |
| LENS_JOB_WORKERS | Keep 2 | Most analyses use handles under concurrency, and completion latency worsens for many tools from five to ten users. This is evidence of waiting, not evidence that extra workers improve throughput. Without server RSS, CPU or a controlled worker-count comparison, increasing workers is unproven on this shared machine. |
| LENS_POSTHOG_MAX_CONCURRENT_QUERIES | Keep 3 | There were no capacity/unavailable errors. The lab backend is simulated and its query-gate occupancy is not instrumented here; more queries cannot be justified from successful MCP calls alone. |

The reported single-agent burst of about 12 heavy calls is a different workload: each costs five credits, so twelve back-to-back submissions consume a full initial 60-credit bucket, with polling and other tools needing further credits. This is a refillable token bucket, not a strict count of twelve calls in every wall-clock minute. That burst is a reason to pace an agent and honor retry timing; it is not evidence that the multi-user defaults should be increased. Supporting a denser burst would need a separate controlled burst test with resource measurements and a stated latency target.

No production default, `.env.example` entry or existing default assertion was changed. The new harness and report are the only intended source additions.

## Validation

Repository typecheck and standalone strict typecheck of the two harness files passed before load completion. The first full `npm test` was run concurrently with the five-user scenario: 1,035 tests, 1,018 passed, two failed, 15 skipped. Both failures were elapsed-time assertions (`round 2: 200 KB answer with 2,000 clients cleans within 1.5 seconds`, and `cold synthetic year replay for 50 clients is below five seconds`). This contributes contention to the first scenario and is a limitation of its early measurements. The unmodified default-concurrency suite was rerun after the scenarios and produced the same counts and the same two timing failures (the year replay measured 5,367 ms against its 5,000 ms assertion). The complete suite then passed with reduced test-file concurrency:

- `npm run typecheck`: passed, exit 0.
- Standalone strict `tsc --noEmit` for `tools/load-test/run.mts` and `analyze.mts`: passed, exit 0. The repository tsconfig does not include tools/, so this is a separate check.
- `npm test -- --test-concurrency=1`: **1,035 tests; 1,020 passed; 0 failed; 15 skipped; 80 suites**, exit 0, 37.943 seconds. Both previously failing timing assertions passed. No timing threshold or existing test was changed.
- Read-only post-run check: **zero working load-test jobs** remained. No server restart, configuration change, dependency installation or commit was performed; node_modules remains its original symlink.

Logs are retained in `tools/load-test/tests.log`, `tests-final.log`, `tests-serial.log`, `typecheck-final.log` and `harness-typecheck.log`. The sandbox blocked process visibility for RSS; no test was blocked by a sandbox denial. The 15 skips are the suite's reported skips, not silently counted as passes.

## Follow-up: controlled worker-count comparison (same day)

The ten-user scenario was rerun with the lab server restarted under `LENS_JOB_WORKERS=4` (everything else unchanged; no concurrent test suite). Results, successful final-latency p50 / p95 in seconds:

| Tool | 2 workers | 4 workers |
|---|---|---|
| aggregate_events | 131.4 / 150.9 | 97.0 / 119.8 |
| discover_workflows | 54.4 / 129.4 | 48.6 / 105.2 |
| workflow_completion | 80.3 / 114.2 | 49.7 / 88.5 |
| client_story | 46.2 / 120.4 | 32.6 / 87.3 |
| dialog_friction | 45.4 / 105.4 | 39.3 / 87.0 |
| rescue_queue | 49.6 / 106.2 | 39.6 / 85.3 |
| task_map | 46.1 / 85.5 | 30.8 / 58.3 |
| top_pains | 45.9 / 93.7 | 25.1 / 59.8 |

Business operations completed in eight minutes rose from 85 to 110 (+29%), with zero errors. Server RSS peaked at 5.9 GiB with four workers, and the responsiveness probe p99 rose to 8.3 s (one stall), versus 2.3 s with two.

Conclusion: doubling workers helps modestly but light, rollup-backed tools (0.3–8 s alone) still wait 25–40 s because the pool is a single FIFO and they queue behind 50–150 s heavy jobs. More workers also cost memory roughly linearly. The fix is scheduling, not raw parallelism: a dedicated light lane so light tools never queue behind heavy analyses. `LENS_JOB_WORKERS` stays at 2 pending that change.
