# PostHog tools (posthog_exec) at one year of real data

Measured 2026-11-15 on the test VM: real self-hosted PostHog, one project holding a full year of Reval-shaped events (97,384,059 events, 365 days, 900 users, 150 clients). The VM has 4 vCPUs and 16 GB RAM shared by about 40 PostHog services; ClickHouse was given 5 GB. Lens ran on the host with PostHog's own MCP server behind `posthog_exec`. Timings are PostHog's own query time through its MCP server.

| PostHog tool, last 12 months | Time | Result |
|---|---:|---|
| query-trends, DAU by month | 1.9 s | ok |
| query-retention, monthly, 12 periods | 1.8 s | ok |
| query-lifecycle, monthly | 6.9 s | ok |
| query-trends, DAU by month, breakdown by client (top 10) | 32.5 s | ok |
| execute-sql, monthly breakdown (agent-written) | up to 48 s | ok, as a Lens job |
| query-funnel, 3 steps on dialog properties, 1-day window | 60.9 s | **failed: PostHog max execution time (504)** |
| query-paths | 40–44 s | no result: dialogs are event properties in Reval data; PostHog paths follow event names or page URLs |

## What a PM sees

- `posthog_exec` analytics return a result or a Lens job handle within about 20 s, so no call reaches the 60 s MCP client limit. Jobs wait up to `LENS_POSTHOG_QUERY_TIMEOUT_SECONDS` (600).
- PostHog enforces its own per-query time limit (about 60 s for synchronous API queries). Lens cannot extend it. When PostHog stops a query there, Lens says so and points to the right alternative: a shorter range, filters, or Lens `workflow_completion` (dialog funnels and completion) and `aggregate_events` (counts by period). Both read Lens daily summaries and answer at any history length.
- A wrongly formed command gets a fixed correction ("call <tool> <json_input>"), not "unavailable".

## At 300M+ rows (three or more years)

PostHog query time grows roughly with the rows a query scans. Queries over the last 12 months scan the same rows whatever the total history. "All time" or multi-year PostHog queries scan proportionally more. Expect funnels and large breakdowns over more than a quarter to hit PostHog's time limit on hardware like this VM. For production:

- Give ClickHouse dedicated memory and CPUs. PostHog's self-hosting guidance sizes ClickHouse separately from the app services.
- Keep long-range questions on Lens tools, which do not scan raw events at question time.
