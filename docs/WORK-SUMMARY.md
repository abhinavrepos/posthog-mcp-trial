# Historical work summary (superseded by native surveys)

Historical status as of 2026-11-25. The custom survey engine described below was removed in the native-surveys upgrade; see the README for current behavior. Built on `thin-lens` (the thin display layer over PostHog). `master` and the other
branches are kept unchanged. The full measured results are in [real-posthog-test.md](real-posthog-test.md).

## 1. Surveys on Reval: why the Hedge Designation survey did not show

| Cause | Fix |
|---|---|
| The survey named the Ext dialog (`DlgHedgeDesigListReport`) or the title. Reval reports this report by its menu id **`LinkListReqv`** | README "Surveys on Reval" documents this. `design_survey` warns when a step matched nothing in the last 30 days and suggests close matches (for example `LinkListReqv`) |
| A button matches by its exact label: `Export`, `XLS Export`, `XLSX Export` and `CSV Export` are four different buttons | Documented. Use an `Event` step with `action_name` containing `Export` for any of them |
| The client is part of the user id (`ENV\|SITE\|CLIENT\|USER`), not a property on events | `CLIENT_FROM_DISTINCT_ID=3` |

The rule "show only after Hedge Designation, then Export" is enforced in the browser by the survey engine
(`deploy/posthog/survey-engine/engine.js`). It counts in order within one browser session. Other actions in
between are allowed. An export minutes later still triggers the survey. Opening the report alone, exporting
first, or exporting from another screen never does.

## 2. Failure handling (no breaking changes)

- When PostHog or Signal's own storage fails, Signal says what is unavailable and never fills in data.
- PostHog answers that are not valid results are refused as unreadable. A busy PostHog (429) is retried as
  before. When the retries run out, the message includes the `Retry-After` wait.
- A busy or damaged SQLite store answers 503 on pages and `unavailable` in MCP tools. Other failures stay 500.
  Messages never contain keys, file paths or stack traces.
- A PostHog tool that PostHog itself removed (for example `query-run`) now answers "use execute-sql" instead
  of "PostHog is unavailable", which had made agents give up (commit a47bc62).

## 3. Interface (Volt design)

- Every page uses the Volt design, including **System**. Monday briefing, Rescue Queue and dashboards are
  not included.
- The sign-in page is modern and only signs in and out. The theme follows the computer's light or dark
  setting. Fonts are bundled, so pages work offline.
- **Pinned charts were redrawn (b333453).** The restyle had drawn every series in greys equal to the
  border and the surface, so series overlapped and disappeared. Charts now have:
  - a fixed, validated 8-colour palette with separate light and dark steps;
  - labelled y-axis ticks, x labels (every bar up to 12), and a legend for 2 or more series;
  - grouped bars with gaps, point markers, and hover values;
  - dashed lines for series 9 and above.

  The data table view is unchanged.

## 4. Simulated Reval

`pnpm reval-sim`: Ext JS classic on one page whose URL never changes, about 100 screens as MDI tabs, the real
posthog-js and the survey engine. **43 of 43 flows pass**, including:

- Hedge Designation then Export, an export minutes later, and an export before the report;
- loading masks, modal windows, reopened tabs, and client and sample audiences;
- a survey launched while the page is open.

posthog-js 1.443.0, 1.450.0 and 1.454.2 are verified.

## 5. Real PostHog test (self-hosted, 400M events over one year)

| What | Result |
|---|---|
| Data | 400,000,000 events in 400 chunks of exactly 1,000,000, spread over 365 days: 60 clients, 2,000 users, about 100 screens |
| 120 browser sessions, 6 kinds | **120/120 as expected.** The survey showed 0.23–1.16 s after the Export (median 0.55 s), also when the export came 3–4 min after opening the report. It never showed before the Export, for opening the report only, for an export elsewhere or first, or for another client |
| Server-side check | ClickHouse holds **exactly 60** `survey shown` events, one in each should-show session and 0 elsewhere |
| MCP over 1/7/30/90/365 days | Every count equals ClickHouse (Δ 0). 0 errors and 0 timeouts. A 365-day HogQL count over 400M rows takes about 1.4 s |
| Survey launched while pages are open | 6/6 pages showed it without a reload, 0.3–1.1 s after the export. The control pages (refresh off) showed nothing |

## 6. Problems found by the real test, and their fixes

| # | Problem | Fix | Commit |
|---|---|---|---|
| 1 | PostHog upgrade crash loop: ClickHouse migration 0378 needs a column that only 0391 adds | `deploy/posthog/clickhouse-premigrate.py`, run before `migrate` by the installer and the upgrade. It is a no-op when not needed and never blocks start | a0190e1 |
| 2 | Surveys are off by default in a new PostHog project (`surveys_opt_in`) | `survey-engine/opt-in.sh` from `install.sh`. `doctor` checks it | a0190e1 |
| 3 | The PostHog installer leaves out the object storage keys | Random dedicated keys are added when missing. Existing values are never changed | a0190e1 |
| 4 | `posthog-mcp/up.sh` broke on current PostHog (a moved import) | Import fallback | e6e55d1 |
| 5 | A survey launched while Reval is open needed a reload | The engine refreshes flags and surveys every 5 min while the page is visible and on focus. It also starts display when the page loaded with no running survey | a0190e1 |
| 6 | The upgraded PostHog serves posthog-js 1.450.0, which was not verified, so the early-capture hook was off | Verified (43/43 flows) and added | dc9fc55 |
| 7 | `design_survey` took 34 s over 365 days | Job handle (`get_job_result`). Reach is capped at 90 days, with a note. Now 12.7 s | 7761f58 |
| 8 | `execute-sql` silently stops at 500 rows | The result says "rows capped at 500 by PostHog; aggregate in SQL or page with LIMIT/OFFSET" | 7761f58 |
| 9 | `find_sessions` pages held only 1–5 dense sessions (19 KB budget) | Compact entries by default (top screens, matched action, links), `detail: true` for full lists. Real data: 2 pages now return **34–35 sessions** (was 2–9) | 88e6877 |
| 10 | The first MCP call after start took 10–12 s | Warm-up at startup and a shared in-flight load. **Still open:** the very first call right after start is 12 s (resolve_client) to 17 s (find_sessions); later calls 0.2–1.5 s | 88e6877 (partial) |
| 11 | The test loader wrote events later than now | Loader fixed. The data was not reloaded | (test tooling) |
| 12 | Pinned charts unreadable | Redrawn (section 3) | b333453 |

## 6a. MCP rerun after all fixes (400M rows, `run/real-mcp/results-2026-11-25T10-33-26-261Z.json`)

All counts still equal ClickHouse (Δ 0) in every window, with 0 errors.

| Days | HogQL count = ClickHouse | SEM events | find_sessions, 2 pages | find_sessions per page | design_survey | execute-sql 200k probe |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 209,199 | 4,871 | 35 / 34 sessions | 5–6 s (first call 17.5 s) | 7.8 s | 500 rows + cap note |
| 7 | 6,773,177 | 117,925 | 35 / 34 | 6–8 s | 7.3 s | same |
| 30 | 31,979,967 | 546,948 | 35 / 34 | 10–12 s | 8.3 s | same |
| 90 | 96,865,922 | 1,652,333 | 35 / 34 | job handle at 20 s, ready by the next poll | 13.2 s | same |
| 365 | 399,097,418 | 6,793,081 | 35 / 34 | job handle at 20 s, ready after 1–3 polls (about 35–55 s per page) | under 20 s, capped to 90 days | same |

Trade-off: pages now hold up to 7 times more sessions, so each page takes longer. Over 90 days or more, a page
comes back through `get_job_result`, which works as designed.

## 7. Customer-health (churn) prompt for the MCP

The prompt in the chat first used `query-run`, a tool the current PostHog MCP removed. Use `execute-sql`.
Copilot also found no rows because the dev server has `C1DEV`, `ASDEV`, `TR01` and so on, not `PROD`. Set
`ENV` accordingly.

```
Analyse client churn risk in Reval with the Signal MCP. Report only numbers from queries you ran; if a query fails, say which and continue.
Setup
- ENV = C1DEV   (use PROD in production)
- Run HogQL with: posthog_exec `call execute-sql {"query":"SELECT ..."}`
- Client = splitByChar('|', distinct_id)[3], user = [4]. Always filter splitByChar('|', distinct_id)[1] = '{ENV}' and on timestamp.
- Events: PageView (screen opens), Event (actions). Properties: dialog_id, action_name, control_type. Aggregate only.
1. Per client, last 90 days vs the 90 days before: active users, active days per user, distinct dialog_id, Export actions (action_name ILIKE '%Export%'), messagebox/toast per 100 events, days since last event.
2. Risk 0–100 = 30% user decline + 20% activity decline + 15% screen-breadth decline + 15% export decline + 10% friction rise + 10% recency. Skip clients with fewer than 3 users earlier.
3. Top 5: users who went inactive, screens dropped, top error texts; find_sessions for 3 sessions near the drop and get_replay_link.
4. pin_graph: weekly active users over 26 weeks for the top 5.
Output: table client | score | users before→now | exports before→now | friction | last active; one line per top-5 client with likely reason and replay links.
```

## 8. Tests

- `npx tsc --noEmit`: clean.
- `npm test -- --test-concurrency=1`: **395 tests, 392 pass, 0 fail, 3 skipped**.
- `pnpm reval-sim`: 43/43.
- Real PostHog: 120/120 sessions, 8/8 live-launch pages, MCP counts Δ 0 over 1–365 days.

## 9. Deploying to the dev server (`~/posthog-lens` on dqposthog01)

1. Pull `thin-lens-volt` (or merge PR #1). This includes the `query-run` fix.
2. Run `deploy/posthog-mcp/up.sh` to restart PostHog's MCP with a fresh key on current PostHog.
3. Restart Signal.
4. Run `deploy/posthog/survey-engine/apply.sh --remove` to restore the original PostHog survey renderer and open its survey UI.
5. Before the next PostHog upgrade, use Signal's upgrade script, which runs the premigrate step.
