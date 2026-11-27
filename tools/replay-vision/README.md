# Replay Vision — ERPNext v16 evaluation harness

A seeded, resumable browser experiment against the running ERPNext v16 stack (`rv-erpnext-*`, desk at
`http://127.0.0.1:8090`). It records real sessions into the local PostHog, runs the **product** Replay Vision
pipeline over them and scores the pipeline against independent ground truth. It changes neither ERPNext nor
posthog-js.

## Run

```sh
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/run.ts            # capture missing seeds, then evaluate
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/run.ts --capture  # capture only
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/run.ts --rescore  # evaluate only (no browser)
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/run.ts --score-only run-a-frozen-v3  # re-score an archived pipeline.json
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/run.ts --rescore --llm-pass1  # also write B' exchange requests (nothing is sent)
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/run.ts --llm-pass2 tools/replay-vision/out/erpnext-v2  # validate archived responses; no PostHog access
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/run.ts --smoke    # one injected session -> out/smoke
NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx tools/replay-vision/probe-snapshot.ts # FullSnapshot root-cause probe
node --import tsx --test tools/replay-vision/score.test.ts
```

Credentials come from `/root/briefs/ph-test.env`. Override the file with `RV_PH_ENV`, or set `POSTHOG_HOST`,
`POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_TOKEN`. `RV_ERP_URL` and `RV_PROXY_PORT` change
the endpoints. The harness needs Node 24, `tsx`, `puppeteer`, the ERPNext Compose stack and local PostHog.

Each run:
- checks ERPNext health;
- creates isolated `rv.*@example.test` System Users and `RV …` Customer/Item/Supplier fixtures through ERPNext's API;
- turns on `session_recording_opt_in` through the authenticated PostHog project API, reads it back to verify, and
  restores the previous value in `finally`. A SIGKILL skips the restore, so check the setting after an interrupted run.

ERPNext documents created by the personas are not deleted; their `RV-`/`RV ` names identify them.

## Files

| File | Role |
| --- | --- |
| `setup.ts` | Config, ERPNext health, lab users and fixtures, recording opt-in (set, verify, restore). |
| `proxy.ts` | Reverse proxy in front of ERPNext. Injects the standard PostHog loader (unmodified `array.js` and recorder, served by local PostHog) and the injection script into `/desk` HTML. |
| `injections.ts` | Browser-side friction switches. A truth mark is written only when the manipulation actually took effect. |
| `personas.ts` | Seeded Puppeteer drivers: curved cursor paths with Fitts-like timing, key-by-key typing, wheel scrolling and per-persona pacing, over three real workflows. Writes ground truth with absolute timestamps. |
| `design.ts` | The experimental design: personas, workflows, calibration repeats, control seeds, injected cohorts and their planned severity. Seeds are the resume key. |
| `capture.ts` | Readiness: waits until PostHog's public API serves a stable, complete recording with a FullSnapshot. |
| `pipeline.ts` | Runs the product pipeline (`analyzeFile → queueReplayVision → storeFindings → runMetrics → recomputeBaselines → refreshInsights`) in an isolated SQLite file, and freezes the config hash between calibration and held-out. |
| `score.ts` | One-to-one moment matching, Wilson 95% intervals, per-detector and per-injection tables, control false positives, per-cohort severity confusion matrix, κ, Spearman, insight hit@k, citation grounding. |
| `report.ts` | Writes `out/erpnext-v2/report.md`. |
| `probe-snapshot.ts` | Root-cause probe for missing FullSnapshots (see below). |

## Design

- **Calibration:** 4 clean repeats × 6 personas × 3 workflows = 72 sessions.
  - Personas: Expert, Novice, Hurried, Careful, Explorer, Returning (users `rv.cal.0–5`).
  - Seeds: `100000 + repeat·100 + user·10 + workflow`.
  - Sales Invoice: customer, due date, item row, Save, Submit, docstatus read back.
  - Purchase Order: supplier, required-by date, item row, Save, Submit.
  - Accounts Receivable: date filter, group by party, scroll.
  - Four repeats give 24 sessions from 6 users on each main screen, above the product's calibration floor of 20
    sessions and 5 users.
- **Held-out controls:** 6 users (`rv.eval.0–5`) × 3 workflows, no injection (seeds `2000x0–2000x2`).
- **Held-out injected cohorts** (`design.ts`, seeds `220000 + cohort·10 + j`). For four injections the dose is the
  number of distinct affected users (1, 3 or 6):
  - I2 validation loop: two rejected Saves, each showing a `role=alert` "Debit To is required".
  - I5 inert decorative Apply button, clicked 5 times.
  - I6 scroll hunt: a 200-row list with search hidden; the target is row 190.
  - I7 Customer ↔ Invoice revisits: two round trips.

  The other cohorts:
  - I2 again, with abandonment after the errors.
  - I3 save waits of 2, 6 and 15 s. The 2 s wait is below the D10 floor and serves as a negative dose control.
  - I1: Due Date relabelled "Effective Value Date" with its help text hidden, then a seeded 3–9 s hesitation.
  - R2: Sales Invoice re-opened twice.
  - D5: abandonment after entering an item.
  - I4 (Submit hidden in the ⋯ menu) is not implemented.
- **Planned severity** follows the architecture's planning rule and was written before any result:
  - 1 user → Low.
  - ≥3 users, no abandonment, <60 s lost → Medium.
  - ≥3 users with abandonment or ≥60 s lost → High.
- **Scopes:** each cohort is evaluated as one product scope: its own sessions plus the 18 controls (6 users). U/N,
  Wilson rates and severity are therefore computed as the Monitor would compute them for one client.
  - Reach N = distinct users whose analysed sessions in that scope reached the screen.
  - A controls-only scope measures false positives at the insight level.
- **Calibration / held-out split:** baselines are recomputed from calibration runs only. The hash of detector config
  + severity config + baselines is written to `frozen-config.json` before any held-out session is analysed.
  Held-out sessions are analysed with the frozen `baselineContext()` and never feed a baseline.
- **Superseded pilot:** seeds `210000–210014` were the earlier design (one session per injection, severity per
  session). They stay in `sessions.jsonl` and `ground-truth/` for provenance and are excluded by `design.ts`.

## Matching and metrics

- **Moment match:** a finding matches a ground-truth moment when:
  - session, `screenKey()` screen and a compatible detector all agree;
  - the finding overlaps `[t_start − 5 s, t_end + 5 s]`.

  Eligible pairs are sorted by overlap, with deterministic id tie-breaks, and matched greedily one-to-one.
- **Compatibility:**

  | Injection | Compatible detectors |
  | --- | --- |
  | I1 relabel + hesitation | D6, D8, D12 |
  | I2 validation loop | D4, D7 |
  | I3 save wait | D10 |
  | I5 inert Apply | D1, D2 |
  | I6 scroll hunt | S1, S2, S3 |
  | I7 revisit | R1, R2 |
  | Re-open | R2 |
  | Abandonment | D5 |
- **Precision** counts every unmatched finding as a false positive, including real behaviour the script did not
  plant, so it is a lower bound.
- **Insight found at k:** the top-k insights of the cohort's scope contain one with all of:
  - the correct screen;
  - an accepted element (`score.ts:ACCEPTED_ELEMENTS`, fixed before results);
  - a compatible detector;
  - a user count within ±1;
  - rubric ≥14.
- **Hallucinated citation:** a citation whose session is not in scope, or whose offset and event id do not equal a
  stored candidate's.
- **Zero denominators** are reported as undefined, never as 100%.

## Recording coverage: the missing-FullSnapshot root cause

The first 23 harness sessions (`out/sessions.jsonl`, not committed) had incremental rrweb events but no Meta and no
FullSnapshot. `probe-snapshot.ts` reproduces and isolates the problem on fresh sessions:

| Config | First `/s/` upload | Capture response | Snapshot API |
| --- | ---: | --- | --- |
| Default recorder (`RV_BLOCK_SELECTOR=none`) | 827,701 B | **413** | No recording: the batch holding Meta and FullSnapshot is lost |
| Harness (`blockSelector: 'svg,script,style'`) | 420,341 B | 200 | First event Meta (4), then FullSnapshot (2), mutations, clicks, inputs |

**Cause:** ERPNext's desk inlines about 1 MB of SVG icon sprites, and posthog-js serializes them into the
FullSnapshot. The first replay upload therefore exceeds the local replay-capture body limit and is rejected with
HTTP 413. The probe saw no retry of that batch. Later, smaller incremental batches are accepted, which is exactly the
shape of the 23 broken sessions.

**Ruled out:**
- Through the project API: sampling, minimum duration, linked flag, URL/event triggers.
- From the probe: recorder start timing (the recorder starts on page load).

**Bot filter:** separately, posthog-js sends nothing at all when the user agent contains `HeadlessChrome` or
`navigator.webdriver` is true. The drivers present a desktop Chrome user agent and disable the automation flag.

**Cost of the fix:** SVG icons, inline scripts and styles are absent from replay frames. Form labels, fields,
buttons, clicks, inputs and scrolls are complete. In production the same page would need either a larger capture
body limit or the same block selector.

**Extra checkpoint:** after load, the drivers call the recorder's full-snapshot checkpoint once (a private posthog-js
method), so that calibration and held-out sessions are recorded identically. The probe shows it is not needed for a
complete recording.

## Outputs (`out/erpnext-v2/`)

| File | Contents |
| --- | --- |
| `sessions.jsonl` | Append-only, one line per driven plan |
| `ground-truth/<seed>.json` | Ground truth for each seed |
| `readiness.jsonl` | Recording readiness checks |
| `session-ids.json` | Session index |
| `frozen-config.json` | Frozen detector, severity and baseline hash |
| `calibration-baselines.json` | Baselines built from calibration only |
| `pipeline.json` | Every finding and insight |
| `heldout-score.json`, `calibration-score.json` | Scores |
| `report.md` | The report (currently run B, post-hoc, detectors v5) |
| `llm-exchange/` | B′ pass 1: `requests/<custom_id>.json` (exact Messages API bodies, sanitized, session aliases only) and `manifest.json`; answers go to `responses/` for pass 2 (`offlineCollect`) |
| `llm-exchange/pass2-results.json` | Pass 2 validation, including accepted/rejected/insufficient counts; also appended to `report.md` |
| `run-a-frozen-v3/` | Run A, the held-out headline: frozen config hash, `pipeline.json` from detectors v3 (commit `df293ad`), its scores and report, re-scored with the final scorer via `run.ts --score-only run-a-frozen-v3` |

Run B re-analysed the same sessions after three detector fixes that were found by reading run A's held-out errors.
It is therefore not a held-out estimate; see `/root/briefs/rv/50-harness-report.md`.

The snapshot cache and `pipeline.db` stay local (`.gitignore`). No credential is written to any output.

## Limits

- Scripted personas are not people. Natural friction has no blind human labels, so natural-friction precision and
  human severity κ are unavailable.
- Six users per scope bound every rate.
- Revisits use full page loads, not in-app links.
