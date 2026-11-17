# Offline PostHog documentation measurements

Reproduce with `node --import tsx scripts/measure-posthog-docs.ts` (no server, credentials, or installs).

Fixtures contain only static upstream documentation from the saved mix3-p*/dictpost-* conversations. The complete tools list comes from mix-p17.jsonl. No query results or client data are included. Some old saved schemas contain `<amount>` in numeric bounds from the previous privacy pass: the fixture helper repairs those positions only for rendering. Before sizes retain the original saved text.

Sizes use the same response serialization as the HTTP baseline: Python `json.dumps`, including spaces and ASCII escapes. Snapshot differences explain the small differences from before.json for trends (21,203 there) and funnel (16,466 there).

| Command | Before chars | After chars |
| --- | ---: | ---: |
| info execute-sql | 46,430 | 705 |
| info query-trends | 21,191 | 2,490 |
| tools | 22,378 | 21,057 |
| info query-funnel | 16,455 | 3,092 |
| info query-paths | 44,110 | 5,319 |

These are offline fixture measurements, not new latency measurements. Compact info uses every field schema available in the saved conversations; a live cold info request fetches and caches additional abbreviated field schemas, so its exact size can differ. Warm metadata requests perform no upstream fetch, initialization, notification, or session deletion. Cold info may make parallel schema requests to preserve nested types, required fields, and enums. Calls always fetch fresh results and retain the existing privacy passes.

The catalog has 753 full tool names and supplies no descriptions. Keeping every name on its own line exceeds 6,000 characters before adding any descriptions. Lens preserves all names, groups them by prefix, and uses short descriptions when the upstream supplies them. Meeting 6,000 would require a separate decision to narrow the catalog or change the full-name-per-line requirement.

Bucket annotations require at least three consistent calendar buckets, an explicit day/week/month interval, and absolute date bounds. Weekly start days come from the interior bucket dates. Date-only upper bounds include that day; UTC midnight timestamps are exact bounds. Relative dates, missing upper bounds, incompatible tables, irregular buckets, and unsupported intervals remain unannotated. Numbers are unchanged; the note passes through the normal data privacy filters.
