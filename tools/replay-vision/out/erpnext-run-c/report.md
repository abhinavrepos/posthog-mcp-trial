# Replay Vision — ERPNext v16 evaluation report — RUN C (fresh held-out, frozen v6)

> Detectors v6 (decisions 1, 2, 4 of 30-review.md), config + calibration baselines frozen in frozen-config.json (commit f07ceae) before any run C session was analysed; the scorer verified the hash. New seeds (controls 3000x0, cohorts 3200xx); calibration sessions shared with run A. No tuning on run C.

Generated 2026-11-26T23:30:08.253Z by `tools/replay-vision/run.ts`. Frozen config hash (detectors + severity + calibration baselines) `301965740bccf143885ae8f586845b232eb2aa9ad5cb312554848751096f68f5`, baseline hash `99a90f432af3f6598db9231893e405d19508dd5f0a5a8045ac42cc8857c72999`, detectors `rv-d1-15-r1-r2-s1-s3-v6`, severity `severity-v1`. The hash was written to `frozen-config.json` after calibration and before any held-out session was analysed. Calibration and held-out sessions have disjoint seeds and session ids. Held-out results are the headline; calibration is reported separately.

## Design

- Calibration: 4 clean repeats × 6 personas (Expert, Novice, Hurried, Careful, Explorer, Returning; users rv.cal.0–5) × 3 workflows (Sales Invoice create→Save→Submit, Purchase Order create→Save→Submit, Accounts Receivable report filter + inspect) = 72 sessions. Baselines are recomputed from these alone (product `recomputeBaselines`). Calibrated screens (≥20 sessions, ≥5 users): accounts receivable:report, purchase order:new, sales invoice:new.
- Held-out controls: 6 users (rv.eval.0–5) × 3 workflows, no injection (18 sessions).
- Held-out injected cohorts: 19 cohorts, 61 sessions. Dose = distinct affected users (1/3/6) for I2 validation loop, I5 inert Apply, I6 scroll hunt, I7 Customer↔Invoice revisits; I2 with abandonment; I3 save waits of 2/6/15 s; I1 relabelled field with 3–9 s hesitation; R2 re-open; D5 abandonment. Each cohort is scored in its own scope (cohort + the 18 controls), as one client would be in the product.
- Pipeline: product code only (`analyzeFile → storeFindings → runMetrics → recomputeBaselines (calibration only) → refreshInsights`), see `pipeline.ts`. No LLM call; provider calls and spend: 0 / $0.

## Coverage and cost

- 151 sessions analysed (79 held-out complete, 0 held-out partial; calibration 72/72 complete). A session without rrweb Meta + FullSnapshot is marked partial/missing_snapshot by the analysis.
- Snapshot JSONL from PostHog's public API: total 222.0 MiB, median 1439 KiB, p95 3178 KiB, max 3792 KiB.
- Browser time 3656 s for 151 sessions; evaluation (download cache + analysis + insights + scoring) 132 s; peak RSS 294 MiB.

| Workflow | Calibration done | Held-out controls done | Held-out injected done |
| --- | ---: | ---: | ---: |
| invoice | 22/24 | 6/6 | 42/42 |
| purchase | 21/24 | 5/6 | 9/9 |
| report | 23/24 | 6/6 | 10/10 |

(Injected abandonment sessions count as done when the line item was entered; they never save by design.)

## Held-out moment detection (headline)

61 delivered ground-truth moments (0 planned injections were not delivered and are excluded: none). 120 pipeline findings on 79 held-out sessions.

- Recall, all compatible detectors: **100.0% [94.1, 100.0] (61/61)**
- Precision, all findings incl. diagnostics and natural behaviour: 50.8% [42.0, 59.6] (61/120)
- Precision of strong/medium findings: 55.5% [46.1, 64.4] (61/110); on injected sessions only: 55.5% [46.1, 64.4] (61/110)
- Moment-level precision (a finding is correct when it overlaps a compatible planted moment, so co-firing S1/S2/S3 or R1/R2 on one moment all count): all 84.2% [76.6, 89.6] (101/120); strong/medium 82.7% [74.6, 88.7] (91/110)
- Element agreement among matched moments: 100.0% [94.1, 100.0] (61/61)

Strict precision (one finding per moment) counts every other finding as a false positive, including co-firing compatible detectors and real behaviour the script did not plant, so it is a lower bound.

| Detector | TP | FP | FP on controls | FN | Precision, Wilson 95% | Recall, Wilson 95% |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| D1 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| D10 | 6 | 0 | 0 | 0 | 100.0% [61.0, 100.0] (6/6) | 100.0% [61.0, 100.0] (6/6) |
| D12 | 0 | 0 | 0 | 3 | undefined (n=0) | 0.0% [0.0, 56.2] (0/3) |
| D14 | 0 | 6 | 0 | 0 | 0.0% [0.0, 39.0] (0/6) | undefined (n=0) |
| D2 | 0 | 0 | 0 | 10 | undefined (n=0) | 0.0% [0.0, 27.8] (0/10) |
| D4 | 13 | 0 | 0 | 0 | 100.0% [77.2, 100.0] (13/13) | 100.0% [77.2, 100.0] (13/13) |
| D5 | 6 | 0 | 0 | 0 | 100.0% [61.0, 100.0] (6/6) | 100.0% [61.0, 100.0] (6/6) |
| D6 | 3 | 0 | 0 | 0 | 100.0% [43.8, 100.0] (3/3) | 100.0% [43.8, 100.0] (3/3) |
| D7 | 10 | 0 | 0 | 3 | 100.0% [72.2, 100.0] (10/10) | 76.9% [49.7, 91.8] (10/13) |
| D8 | 0 | 0 | 0 | 3 | undefined (n=0) | 0.0% [0.0, 56.2] (0/3) |
| R1 | 10 | 13 | 0 | 0 | 43.5% [25.6, 63.2] (10/23) | 100.0% [72.2, 100.0] (10/10) |
| R2 | 13 | 0 | 0 | 0 | 100.0% [77.2, 100.0] (13/13) | 100.0% [77.2, 100.0] (13/13) |
| S1 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| S2 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| S3 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |

| Injection | TP | FN | Recall, Wilson 95% |
| --- | ---: | ---: | --- |
| validation_loop | 13 | 0 | 100.0% [77.2, 100.0] (13/13) |
| dead_button | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| hesitation | 3 | 0 | 100.0% [43.8, 100.0] (3/3) |
| revisit | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| reopen | 3 | 0 | 100.0% [43.8, 100.0] (3/3) |
| scroll_hunt | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| slow_wait | 6 | 0 | 100.0% [61.0, 100.0] (6/6) |
| abandon | 6 | 0 | 100.0% [61.0, 100.0] (6/6) |

### Controls (false positives)

Control sessions with any finding: 0.0% [0.0, 17.6] (0/18); with a strong/medium finding: 0.0% [0.0, 17.6] (0/18); with a strong/medium finding other than D14: 0.0% [0.0, 17.6] (0/18). Finding kinds on controls: none. Published insights in the controls-only scope: 0.


## Severity (per cohort, product rule vs planned rule)

Quadratic-weighted κ, 4 levels with "None" (no insight published): 0.91; among cohorts with an insight: 1.00. Spearman ρ dose (users) vs severity over the I2/I5/I6/I7 dose series: 0.76. Inversions: I2-validation 1u:Low → 3u:High → 6u:High (0); I5-dead-apply 1u:Low → 3u:Medium → 6u:Medium (0); I6-scroll-hunt 1u:None → 3u:Medium → 6u:Medium (0); I7-revisit 1u:None → 3u:Medium → 6u:Medium (0).

| Planned \ Predicted | None | Low | Medium | High |
| --- | ---: | ---: | ---: | ---: |
| Low | 2 | 2 | 0 | 0 |
| Medium | 0 | 0 | 10 | 0 |
| High | 0 | 0 | 0 | 4 |

| Cohort | Users | Planned | Predicted | Insight U | Rank of matching insight | Product severity reason |
| --- | ---: | --- | --- | ---: | ---: | --- |
| I2-validation-u1 | 1 | Low | Low | 1 | 1 | Low: anomalous finding (no High/Medium rule met). U/N 1/6; median lost 3.2 s; A 0; calibrated; signal D4; rate 1/7 vs prior 0%: increase |
| I2-validation-u3 | 3 | High | High | 3 | 1 | High: strong D4 (2 cycles) in 3>=3 users. U/N 3/6; median lost 2.5 s; A 0; calibrated; signal D4; rate 3/9 vs prior 0%: increase |
| I2-validation-u6 | 6 | High | High | 6 | 1 | High: strong D4 (2 cycles) in 6>=3 users. U/N 6/6; median lost 2.4 s; A 0; calibrated; signal D4; rate 6/12 vs prior 0%: increase |
| I2-validation-abandon-u3 | 3 | High | High | 3 | 2 | High: 3 users abandoned after friction. U/N 3/6; median lost 2.2 s; A 3; calibrated; signal D4; rate 3/9 vs prior 0%: increase |
| I5-dead-apply-u1 | 1 | Low | Low | 1 | 1 | Low: anomalous finding (no High/Medium rule met). U/N 1/6; median lost 1.3 s; A 0; calibrated; signal D1; rate 1/7 vs prior 0%: increase |
| I5-dead-apply-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 1.1 s; A 0; calibrated; signal D1; rate 3/9 vs prior 0%: increase |
| I5-dead-apply-u6 | 6 | Medium | Medium | 6 | 1 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 1.2 s; A 0; calibrated; signal D1; rate 6/12 vs prior 0%: increase |
| I6-scroll-hunt-u1 | 1 | Low | None | – | – | no insight published |
| I6-scroll-hunt-u3 | 3 | Medium | Medium | 3 | 2 | Medium: U 3>=2 and p 100.0%>=10%. U/N 3/3; median lost 8.3 s; A 0; uncalibrated; signal S3 |
| I6-scroll-hunt-u6 | 6 | Medium | Medium | 6 | 2 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 8.4 s; A 0; uncalibrated; signal S3 |
| I7-revisit-u1 | 1 | Low | None | – | – | no insight published |
| I7-revisit-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 0.0 s; A 0; calibrated; signal R2 |
| I7-revisit-u6 | 6 | Medium | Medium | 6 | 1 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 0.0 s; A 0; calibrated; signal R2 |
| I1-hesitation-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 0.9 s; A 0; calibrated; signal D6 |
| I3-wait-6s-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 6.0 s; A 0; calibrated; signal D10 |
| I3-wait-15s-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 15 s; A 0; calibrated; signal D10 |
| R2-reopen-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 0.0 s; A 0; calibrated; signal R2 |
| D5-abandon-u3 | 3 | High | High | 3 | 1 | High: 3 users abandoned after friction. U/N 3/6; median lost 17 s; A 3; calibrated; signal D5; rate 3/9 vs prior 0%: increase |

Negative dose control (2 s wait, below the D10 floor): I3-wait-2s-u3: 0 D10 findings, insight none.

## Insights

Published (validated) insights across all scopes: 26. hit@3 88.9% [67.2, 96.9] (16/18), hit@10 88.9% [67.2, 96.9] (16/18) (correct screen, accepted element, compatible detector, user count ±1, rubric ≥14). Mean rubric 17.3/18. Generic insights: 0. Citations 88, hallucinated (not traceable to a stored candidate of a session in scope at that offset and event id): 0.

### Example insights (exact product text, one per family and screen)

- **I2-validation-u6** — [High] Sales Invoice (new) › Save: 6 of 6 users / 6 sessions: clicked Save and got a visible validation error 2 times in a row, editing fields between attempts (6 sessions, 1.9 s–2.8 s per loop); No abandonment observed; median 2.4 s lost per affected user. Likely cause: the requirement behind the validation error shown after Save is not visible before clicking, so the edits users make between attempts do not resolve it. Fix: on Sales Invoice (new), validate the fields Save depends on inline as they are filled, and name the failing field next to Save instead of only in the error message. Evidence: http://localhost/project/1/replay/01a21a12-b305-71f3-8500-93eb93d9d029?t=11 @0:11, http://localhost/project/1/replay/01a21a11-d343-7512-8e20-6d992d3a9b84?t=12 @0:12, http://localhost/project/1/replay/01a21a11-70ae-73c4-a160-0ccc040fae72?t=12 @0:12, http://localhost/project/1/replay/01a21a13-8764-7696-b23c-685d153f9816?t=17 @0:17, http://localhost/project/1/replay/01a21a13-0d87-755c-8232-e462a29c791f?t=17 @0:17. Signals: D4, confidence high.
- **I2-validation-abandon-u3** — [High] Sales Invoice (new) › Due Date: 3 of 6 users / 3 sessions: left the form after editing 5 fields without saving; last field edited: Due Date (3 sessions, 3 right after a validation error, error click or slow save); 3 of 3 affected users abandoned the form without saving; median 18 s lost per affected user. Likely cause: friction on this form (visible validation error, error click or slow save recorded before leaving) stopped 3 of 3 attempts. Fix: on Sales Invoice (new), keep a recoverable draft of the form and surface what blocks saving next to Due Date. Evidence: http://localhost/project/1/replay/01a21a14-00e2-735c-aadc-135ec96ef8fb?t=3 @0:03, http://localhost/project/1/replay/01a21a14-e568-7efd-ab01-ec4093413d3d?t=4 @0:04, http://localhost/project/1/replay/01a21a14-603b-7bb2-82ef-c73e84367bff?t=6 @0:06. Signals: D5, confidence high.
- **I2-validation-u6** — [Medium] Sales Invoice (new) › Save: 6 of 6 users / 6 sessions: returned to the Save field 4 times within one form attempt (6 sessions); No abandonment observed; no measurable time lost. Likely cause: the value Save expects is unclear; users re-focused it 4 times before moving on. Fix: show the expected format and an example directly under Save on Sales Invoice (new), and validate Save on blur. Evidence: http://localhost/project/1/replay/01a21a12-b305-71f3-8500-93eb93d9d029?t=11 @0:11, http://localhost/project/1/replay/01a21a11-d343-7512-8e20-6d992d3a9b84?t=12 @0:12, http://localhost/project/1/replay/01a21a11-70ae-73c4-a160-0ccc040fae72?t=12 @0:12, http://localhost/project/1/replay/01a21a13-8764-7696-b23c-685d153f9816?t=17 @0:17, http://localhost/project/1/replay/01a21a13-0d87-755c-8232-e462a29c791f?t=17 @0:17. Signals: D7, confidence med.
- **I5-dead-apply-u6** — [Medium] Sales Invoice (new) › Apply: 6 of 6 users / 6 sessions: clicked Apply 5 times within 0.9 s–1.4 s at the same spot (6 sessions); No abandonment observed; median 1.2 s lost per affected user. Likely cause: Apply gives no immediate visible feedback, so users click it again (5 clicks, each within 1 s and 30 px of the last). Fix: give Apply on Sales Invoice (new) an immediate pressed/disabled state and a progress indicator while its action runs. Evidence: http://localhost/project/1/replay/01a21a18-9db7-7c81-ad0f-b50ac323cd21?t=4 @0:04, http://localhost/project/1/replay/01a21a19-9033-7819-b4be-5e32449da41c?t=4 @0:04, http://localhost/project/1/replay/01a21a18-32d2-7ed8-bcd8-e610799f6051?t=4 @0:04, http://localhost/project/1/replay/01a21a17-2b9a-748d-9de0-d7d268c71a1c?t=6 @0:06, http://localhost/project/1/replay/01a21a17-a9ce-7120-84d7-0f936bf5c11a?t=6 @0:06. Signals: D1, confidence high.
- **I6-scroll-hunt-u6** — [Medium] Accounts Receivable (report) › item:list: 6 of 6 users / 6 sessions: went from Accounts Receivable (report) to Item (list) and straight back 1 times in one task, staying 5.4 s–7.0 s on Item (list) (6 sessions); No abandonment observed; median 6.0 s lost per affected user. Likely cause: information needed to finish Accounts Receivable (report) is only shown on Item (list), so users leave to look it up (1 round trips per task). Fix: show the needed Item (list) details on Accounts Receivable (report), e.g. as a preview next to the linked field, so users need not leave the form. Evidence: http://localhost/project/1/replay/01a21a1b-6097-7147-8a84-74a3aed0fb5b?t=0 @0:00, http://localhost/project/1/replay/01a21a1d-1882-7664-abe9-ea930acff643?t=0 @0:00, http://localhost/project/1/replay/01a21a1c-1550-7554-a603-576dba7a01f2?t=3 @0:03, http://localhost/project/1/replay/01a21a1c-bb4e-7d43-a33d-e46cb30a3ffa?t=4 @0:04, http://localhost/project/1/replay/01a21a1c-6249-797c-8a58-8e0153357b1e?t=4 @0:04. Signals: R1, confidence med.
- **I6-scroll-hunt-u6** — [Medium] Item (list) › Scroll container: 6 of 6 users / 6 sessions: scrolled 12.0× the visible height in Scroll container with 6 direction reversals, without clicking or typing between reversals (6 sessions; page extent ≥ 8762 px); No abandonment observed; median 8.4 s lost per affected user. Likely cause: the target in Scroll container on Item (list) is hard to find by scrolling (6 up/down reversals of at least a quarter screen each, no search or filter used). Fix: on Item (list), put search/filter above Scroll container, sort the most likely target first, and keep the list short by default. Evidence: http://localhost/project/1/replay/01a21a1b-6097-7147-8a84-74a3aed0fb5b?t=2 @0:02, http://localhost/project/1/replay/01a21a1d-1882-7664-abe9-ea930acff643?t=2 @0:02, http://localhost/project/1/replay/01a21a1c-1550-7554-a603-576dba7a01f2?t=5 @0:05, http://localhost/project/1/replay/01a21a1c-6249-797c-8a58-8e0153357b1e?t=6 @0:06, http://localhost/project/1/replay/01a21a1c-bb4e-7d43-a33d-e46cb30a3ffa?t=7 @0:07. Signals: S1+S2+S3, confidence med.
- **I7-revisit-u6** — [Medium] Sales Invoice (new) › sales invoice:new: 6 of 6 users / 6 sessions: re-opened Sales Invoice (new) 3 times within one task (6 sessions); No abandonment observed; no measurable time lost. Likely cause: Sales Invoice (new) does not keep what users need in view, so they reopen it 3 times. Fix: keep the state users return for visible on Sales Invoice (new) (pinned filters, recent records) instead of requiring a reopen. Evidence: http://localhost/project/1/replay/01a21a1f-81f5-7afe-a7d9-4f9d1d44e3a4?t=0 @0:00, http://localhost/project/1/replay/01a21a20-0eaa-7713-ab41-7b2a46a47290?t=0 @0:00, http://localhost/project/1/replay/01a21a20-9d23-7dcb-8e4a-1ff855a8f53c?t=0 @0:00, http://localhost/project/1/replay/01a21a21-1bcf-732d-85d3-d41eced10379?t=0 @0:00, http://localhost/project/1/replay/01a21a21-91fb-7f17-8a2b-7900bde57651?t=0 @0:00. Signals: R2, confidence med.
- **I7-revisit-u6** — [Medium] Sales Invoice (new) › customer:list: 6 of 6 users / 6 sessions: went from Sales Invoice (new) to Customer (list) and straight back 2 times in one task, staying 1.8 s–2.0 s on Customer (list) (6 sessions); No abandonment observed; median 3.8 s lost per affected user. Likely cause: information needed to finish Sales Invoice (new) is only shown on Customer (list), so users leave to look it up (2 round trips per task). Fix: show the needed Customer (list) details on Sales Invoice (new), e.g. as a preview next to the linked field, so users need not leave the form. Evidence: http://localhost/project/1/replay/01a21a20-9d23-7dcb-8e4a-1ff855a8f53c?t=3 @0:03, http://localhost/project/1/replay/01a21a21-1bcf-732d-85d3-d41eced10379?t=3 @0:03, http://localhost/project/1/replay/01a21a22-2708-7313-b49e-165c69ceab6a?t=4 @0:04, http://localhost/project/1/replay/01a21a20-0eaa-7713-ab41-7b2a46a47290?t=4 @0:04, http://localhost/project/1/replay/01a21a1f-81f5-7afe-a7d9-4f9d1d44e3a4?t=4 @0:04. Signals: R1, confidence med.
- **I1-hesitation-u3** — [Medium] Sales Invoice (new) › Due Date: 3 of 6 users / 3 sessions: paused 3.8 s–7.4 s on Due Date before typing (3 sessions); No abandonment observed; median 0.9 s lost per affected user. Likely cause: the label Due Date does not tell users what to enter; first input came 3.8 s–7.4 s after focus. Fix: rename Due Date on Sales Invoice (new) to the term users expect and add a one-line description with an example under it. Evidence: http://localhost/project/1/replay/01a21a23-8c97-7657-9025-521c2a945b18?t=4 @0:04, http://localhost/project/1/replay/01a21a23-1f7a-7b05-a1d9-d7c500f27b4f?t=4 @0:04, http://localhost/project/1/replay/01a21a22-9dc5-7d66-a6d7-e6414e55c8cc?t=5 @0:05. Signals: D6, confidence med.
- **I3-wait-6s-u3** — [Medium] Purchase Order (new) › Save: 3 of 6 users / 3 sessions: waited 6.0 s (median 6.0 s) after Save before the screen responded (3 sessions; 6 clicks/keys during the waits); No abandonment observed; median 6.0 s lost per affected user. Likely cause: the response to Save is slow (loading overlay stayed visible for 6.0 s). Fix: profile the request behind Save on Purchase Order (new), bring it under 3 s, and show progress with an estimated time while it runs. Evidence: http://localhost/project/1/replay/01a21a26-0685-7ff4-821c-3c296a667996?t=9 @0:09, http://localhost/project/1/replay/01a21a25-2064-785d-9bbd-9ff358f39ca6?t=10 @0:10, http://localhost/project/1/replay/01a21a25-8689-7493-8ef5-d00f42309512?t=16 @0:16. Signals: D10, confidence med.

## Misses

None.

## Calibration (separate, not a headline)

72 clean sessions, no planted moments. Findings: none. Sessions with a strong/medium finding other than D14: 0.0% [0.0, 5.1] (0/72).

## Limits

Scripted personas, not people: recall concerns planted behaviour, and precision on controls counts unplanted real behaviour as false positives. Natural friction was not labelled by blind human reviewers, so natural-friction precision and human severity κ are not available. Six users per scope bound every rate (see the Wilson intervals). The proxy blocks svg/script/style nodes from replay so the first upload fits the local capture limit; replay frames lack icons. Revisits use full page loads (typed URL), not in-app links.
