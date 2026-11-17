# posthog_exec: speed, size and accuracy (2026-11-17)

Real-PostHog lab, same 20 PostHog questions (Sonnet as Copilot), before = graded run mix3 (code 04c3a29), after = this commit (with the data dictionary of 7a87deb).

| | Before | After |
|---|---:|---:|
| Lens tool calls | 98 | 52 |
| posthog_exec calls | 71 | 32 |
| Doc lookups (tools/info/schema) | 28 | 7 |
| Doc characters read | 320,964 | 43,976 |
| All posthog_exec characters read | 395,439 | 60,604 |
| Time inside posthog_exec | 223 s | 159 s |
| Graded: correct / partial / wrong / gave up / unanswerable handled | 15 / 0 / 2 / 1 / 2 | 17 / 1 / 0 / 0 / 2 (p05 re-asked after its fix) |

Micro-benchmark through Lens over HTTP (scratch bench, 3 repeats): `info execute-sql` 46,430 -> 1,931 chars (keeps a HogQL digest), `info query-trends` 21,203 -> 8,369, `info query-funnel` 16,466 -> 7,373; docs answer in 0.02-0.09 s from the first request (warmed at startup, refreshed ahead of expiry) instead of 0.3 s, or ~11 s for a cold compact build.

What changed: compact `info`/`tools` (`info <tool> full` for the raw text), a docs cache with refresh-ahead and startup warming, bucket notes on trends (interval, week start, partial first/last), validation errors that name the field and what is expected (never the values), unknown commands that suggest real tools by subject, warnings for events/properties Reval does not have, SQL errors that keep the field name but blank quoted literals, and an explicit event-scope rule.
