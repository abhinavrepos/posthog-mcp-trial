Run from the repository root with the existing node_modules symlink:

```sh
node --import tsx tools/load-test/run.mts --users=5,10,20 --minutes=8
node --import tsx tools/load-test/analyze.mts
```

The harness creates one personal token per simulated user through `createMcpToken`, opens independent SDK Streamable HTTP sessions, and reuses identities across scenarios. Tokens are kept in memory; they are never logged. Existing lab admin credentials supply an independent five-second probe. Main/tasks database reads use read-only SQLite connections. Token creation uses the explicitly authorized access module. No server settings are changed.

An 18-step script uses 13 light-intent operations and five heavy operations; some light-intent tools nevertheless cost five rate credits. Each user runs one business operation at a time, follows returned handles with `get_job_result`, and thinks a seeded random 2–10 seconds between operations. Clients vary across all available synthetic clients. Workflows are discovered before completion calls. Poll records and initial calls share a requestId; completion records contain end-to-end latency including waits and poll retries. Think time is outside that latency. JSONL stores tool arguments, first response latency, handle status, payload characters, error messages and error classes; no result payloads or token secrets are retained.

Each scenario admits work for eight minutes, allows up to one minute to drain job handles, and stops when non-rate_limit/non-busy business errors exceed 5%. Errors are counted once per business operation for stopping, and every physical call is retained for reporting. Unfinished handles are censored rather than counted as successful results. Total default scenario time is approximately 27 minutes including drains, with at most one final poll timeout beyond each drain deadline, plus setup/connection overhead. Request timeout is 45 seconds. Each scenario's admission cutoff is strict; think waits are shortened only at that boundary. A run-level early stop ends remaining scenarios as a safety measure.

`/proc/net/tcp{,6}` supplies the listener inode; scanning `/proc/*/fd` finds its PID when visible. RSS is process VmRSS (including worker-thread memory). The sandbox may hide the host server PID despite exposing its socket: that produces an explicit unavailable metric. Active jobs are sampled read-only from `analysis_jobs`. Persisted `working` combines executing and queued jobs; max(working − 2, 0) is a proxy for pending work, not an exact worker queue gauge. Other server traffic can affect this global gauge. Busy responses specifically saying the analysis queue is full are the direct saturation signal.

`analyze.mts` regenerates Markdown tables and analysis JSON. Physical first-answer latency includes errors; a separate non-error column prevents fast throttles from hiding successful latency. Final-result latency excludes errors and censored operations, and is attached to the initiating tool. For get_job_result, final-result latency measures only successful polls that actually returned a completed result. Percentiles use nearest rank. Five-second sampling cannot capture every short queue burst or RSS peak.

Tokens: each run creates one personal token per simulated PM (label "Lens load test") in the lab database and revokes them all when the process exits, including on Ctrl-C. Point `--lab=<dir>` (or `LENS_LOAD_LAB_DIR`) at the lab folder holding main.db, tasks.db and token.txt; never at production.
