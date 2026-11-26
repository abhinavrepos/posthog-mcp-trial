# Replay Vision — ERPNext v16 evaluation report — RUN A (frozen, held-out headline)

> Pre-registered config: detectors v3 at commit df293ad, baselines frozen from calibration before held-out analysis. Findings and insights are the archived `pipeline.json` of that run, re-scored with the final scorer (`run.ts --score-only run-a-frozen-v3`; the evaluation-time line is therefore 0 s). Ground-truth correction applied before scoring: I3 wait labels use the screen where the wait started (harness labelling bug, independent of detector output; `score.ts:truthScreen`).

Generated 2026-11-26T22:25:33.510Z by `tools/replay-vision/run.ts`. Frozen config hash (detectors + severity + calibration baselines) `bb11ab0ac62383cad7f16dd6288bc70161a4e0728eeac6565485bd8565a2739e`, baseline hash `de9659c9dc8d05212c44e63f2916bc47aff4b37d23f9365f34730cdd19ef9c75`, detectors `rv-d1-15-r1-r2-s1-s3-v3`, severity `severity-v1`. The hash was written to `frozen-config.json` (copy in this folder) after calibration and before any held-out session was analysed. Calibration and held-out sessions have disjoint seeds and session ids. Held-out results are the headline; calibration is reported separately.

## Design

- Calibration: 4 clean repeats × 6 personas (Expert, Novice, Hurried, Careful, Explorer, Returning; users rv.cal.0–5) × 3 workflows (Sales Invoice create→Save→Submit, Purchase Order create→Save→Submit, Accounts Receivable report filter + inspect) = 72 sessions. Baselines are recomputed from these alone (product `recomputeBaselines`). Calibrated screens (≥20 sessions, ≥5 users): accounts receivable:report, purchase order:new, sales invoice:new.
- Held-out controls: 6 users (rv.eval.0–5) × 3 workflows, no injection (18 sessions).
- Held-out injected cohorts: 19 cohorts, 61 sessions. Dose = distinct affected users (1/3/6) for I2 validation loop, I5 inert Apply, I6 scroll hunt, I7 Customer↔Invoice revisits; I2 with abandonment; I3 save waits of 2/6/15 s; I1 relabelled field with 3–9 s hesitation; R2 re-open; D5 abandonment. Each cohort is scored in its own scope (cohort + the 18 controls), as one client would be in the product.
- Pipeline: product code only (`analyzeFile → storeFindings → runMetrics → recomputeBaselines (calibration only) → refreshInsights`), see `pipeline.ts`. No LLM call; provider calls and spend: 0 / $0.

## Coverage and cost

- 151 sessions analysed (79 held-out complete, 0 held-out partial; calibration 72/72 complete). A session without rrweb Meta + FullSnapshot is marked partial/missing_snapshot by the analysis.
- Snapshot JSONL from PostHog's public API: total 220.2 MiB, median 1437 KiB, p95 3520 KiB, max 4156 KiB.
- Browser time 3689 s for 151 sessions; evaluation (download cache + analysis + insights + scoring) 0 s; peak RSS 117 MiB.

| Workflow | Calibration done | Held-out controls done | Held-out injected done |
| --- | ---: | ---: | ---: |
| invoice | 22/24 | 6/6 | 42/42 |
| purchase | 21/24 | 6/6 | 9/9 |
| report | 23/24 | 6/6 | 10/10 |

(Injected abandonment sessions count as done when the line item was entered; they never save by design.)

## Held-out moment detection (headline)

61 delivered ground-truth moments (0 planned injections were not delivered and are excluded: none). 129 pipeline findings on 79 held-out sessions.

- Recall, all compatible detectors: **95.1% [86.5, 98.3] (58/61)**
- Precision, all findings incl. diagnostics and natural behaviour: 45.0% [36.6, 53.6] (58/129)
- Precision of strong/medium findings: 48.7% [39.9, 57.6] (58/119); on injected sessions only: 48.7% [39.9, 57.6] (58/119)
- Moment-level precision (a finding is correct when it overlaps a compatible planted moment, so co-firing S1/S2/S3 or R1/R2 on one moment all count): all 68.2% [59.8, 75.6] (88/129); strong/medium 65.5% [56.6, 73.5] (78/119)
- Element agreement among matched moments: 100.0% [93.8, 100.0] (58/58)

Strict precision (one finding per moment) counts every other finding as a false positive, including co-firing compatible detectors and real behaviour the script did not plant, so it is a lower bound.

| Detector | TP | FP | FP on controls | FN | Precision, Wilson 95% | Recall, Wilson 95% |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| D1 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| D10 | 6 | 0 | 0 | 0 | 100.0% [61.0, 100.0] (6/6) | 100.0% [61.0, 100.0] (6/6) |
| D12 | 0 | 0 | 0 | 3 | undefined (n=0) | 0.0% [0.0, 56.2] (0/3) |
| D14 | 0 | 10 | 0 | 0 | 0.0% [0.0, 27.8] (0/10) | undefined (n=0) |
| D2 | 0 | 0 | 0 | 10 | undefined (n=0) | 0.0% [0.0, 27.8] (0/10) |
| D4 | 13 | 0 | 0 | 0 | 100.0% [77.2, 100.0] (13/13) | 100.0% [77.2, 100.0] (13/13) |
| D5 | 6 | 18 | 0 | 0 | 25.0% [12.0, 44.9] (6/24) | 100.0% [61.0, 100.0] (6/6) |
| D6 | 0 | 0 | 0 | 3 | undefined (n=0) | 0.0% [0.0, 56.2] (0/3) |
| D7 | 0 | 0 | 0 | 13 | undefined (n=0) | 0.0% [0.0, 22.8] (0/13) |
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
| hesitation | 0 | 3 | 0.0% [0.0, 56.2] (0/3) |
| revisit | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| reopen | 3 | 0 | 100.0% [43.8, 100.0] (3/3) |
| scroll_hunt | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| slow_wait | 6 | 0 | 100.0% [61.0, 100.0] (6/6) |
| abandon | 6 | 0 | 100.0% [61.0, 100.0] (6/6) |

### Controls (false positives)

Control sessions with any finding: 0.0% [0.0, 17.6] (0/18); with a strong/medium finding: 0.0% [0.0, 17.6] (0/18); with a strong/medium finding other than D14: 0.0% [0.0, 17.6] (0/18). Finding kinds on controls: none. Published insights in the controls-only scope: 0.


## Severity (per cohort, product rule vs planned rule)

Quadratic-weighted κ, 4 levels with "None" (no insight published): 0.60; among cohorts with an insight: 0.27. Spearman ρ dose (users) vs severity over the I2/I5/I6/I7 dose series: 0.75. Inversions: I2-validation 1u:None → 3u:High → 6u:High (0); I5-dead-apply 1u:None → 3u:Medium → 6u:Medium (0); I6-scroll-hunt 1u:None → 3u:Medium → 6u:Medium (0); I7-revisit 1u:None → 3u:High → 6u:High (0).

| Planned \ Predicted | None | Low | Medium | High |
| --- | ---: | ---: | ---: | ---: |
| Low | 4 | 0 | 0 | 0 |
| Medium | 1 | 0 | 6 | 5 |
| High | 0 | 0 | 0 | 2 |

| Cohort | Users | Planned | Predicted | Insight U | Rank of matching insight | Product severity reason |
| --- | ---: | --- | --- | ---: | ---: | --- |
| I2-validation-u1 | 1 | Low | None | – | – | no insight published |
| I2-validation-u3 | 3 | Medium | High | 3 | 1 | High: strong D4 (2 cycles) in 3>=3 users. U/N 3/6; median lost 2.9 s; A 0; calibrated; signal D4; rate 3/9 vs prior 0%: increase |
| I2-validation-u6 | 6 | Medium | High | 6 | 1 | High: strong D4 (2 cycles) in 6>=3 users. U/N 6/6; median lost 1.9 s; A 0; calibrated; signal D4; rate 6/12 vs prior 0%: increase |
| I2-validation-abandon-u3 | 3 | High | High | 3 | 2 | High: 3 users abandoned after friction. U/N 3/6; median lost 2.7 s; A 3; calibrated; signal D4; rate 3/9 vs prior 0%: increase |
| I5-dead-apply-u1 | 1 | Low | None | – | – | no insight published |
| I5-dead-apply-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 1.1 s; A 0; calibrated; signal D1; rate 3/9 vs prior 0%: increase |
| I5-dead-apply-u6 | 6 | Medium | Medium | 6 | 1 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 1.1 s; A 0; calibrated; signal D1; rate 6/12 vs prior 0%: increase |
| I6-scroll-hunt-u1 | 1 | Low | None | – | – | no insight published |
| I6-scroll-hunt-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 100.0%>=10%. U/N 3/3; median lost 9.2 s; A 0; uncalibrated; signal S3 |
| I6-scroll-hunt-u6 | 6 | Medium | Medium | 6 | 1 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 8.6 s; A 0; uncalibrated; signal S3 |
| I7-revisit-u1 | 1 | Low | None | – | – | no insight published |
| I7-revisit-u3 | 3 | Medium | High | 3 | 1 | High: 2 users abandoned after friction. U/N 3/6; median lost 0.0 s; A 2; calibrated; signal R2 |
| I7-revisit-u6 | 6 | Medium | High | 6 | 2 | High: 6 users abandoned after friction. U/N 6/6; median lost 0.0 s; A 6; calibrated; signal R2 |
| I1-hesitation-u3 | 3 | Medium | None | – | – | no insight published |
| I3-wait-6s-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 6.0 s; A 0; calibrated; signal D10 |
| I3-wait-15s-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 15 s; A 0; calibrated; signal D10 |
| R2-reopen-u3 | 3 | Medium | High | 3 | 2 | High: 3 users abandoned after friction. U/N 3/6; median lost 0.0 s; A 3; calibrated; signal R2 |
| D5-abandon-u3 | 3 | High | High | 3 | 1 | High: 3 users abandoned after friction. U/N 3/6; median lost 13 s; A 3; calibrated; signal D5; rate 3/9 vs prior 0%: increase |

Negative dose control (2 s wait, below the D10 floor): I3-wait-2s-u3: 0 D10 findings, insight none.

## Insights

Published (validated) insights across all scopes: 26. hit@3 72.2% [49.1, 87.5] (13/18), hit@10 72.2% [49.1, 87.5] (13/18) (correct screen, accepted element, compatible detector, user count ±1, rubric ≥14). Mean rubric 17.2/18. Generic insights: 0. Citations 93, hallucinated (not traceable to a stored candidate of a session in scope at that offset and event id): 0.

### Example insights (exact product text, one per family and screen)

- **I2-validation-u6** — [High] Sales Invoice (new) › Save: 6 of 6 users / 6 sessions: clicked Save and got a visible validation error 2 times in a row, editing fields between attempts (6 sessions, 1.7 s–3.5 s per loop); No abandonment observed; median 1.9 s lost per affected user. Likely cause: the requirement behind the validation error shown after Save is not visible before clicking, so the edits users make between attempts do not resolve it. Fix: on Sales Invoice (new), validate the fields Save depends on inline as they are filled, and name the failing field next to Save instead of only in the error message. Evidence: http://localhost/project/1/replay/01a219cb-019e-727c-a25b-bd1b30578d8d?t=10 @0:10, http://localhost/project/1/replay/01a219cc-aab4-7286-8e6d-83344d337532?t=12 @0:12, http://localhost/project/1/replay/01a219cc-45ec-7cd2-9178-d3e34885986e?t=13 @0:13, http://localhost/project/1/replay/01a219cb-5760-776f-86d6-c05636b15df1?t=15 @0:15, http://localhost/project/1/replay/01a219cb-c85f-74bd-9ba6-6564d9041e1f?t=17 @0:17. Signals: D4, confidence high.
- **I7-revisit-u6** — [High] Sales Invoice (new) › Item: 6 of 6 users / 6 sessions: left the form after editing 226 fields without saving; last field edited: Item (6 sessions); 6 of 6 affected users abandoned the form without saving; median 6.2 s lost per affected user. Likely cause: no friction signal was recorded before users left; the reason is not observable in the replay. Fix: on Sales Invoice (new), keep a recoverable draft of the form and surface what blocks saving next to Item. Evidence: http://localhost/project/1/replay/01a219dc-0431-741b-96c9-29dcb9f3dbe8?t=0 @0:00, http://localhost/project/1/replay/01a219d9-5f96-7323-88f3-80ccede74f63?t=0 @0:00, http://localhost/project/1/replay/01a219d9-d781-71ea-bf01-fb2d33767010?t=0 @0:00, http://localhost/project/1/replay/01a219db-726b-7654-a48f-5ccf8260e281?t=0 @0:00, http://localhost/project/1/replay/01a219da-6bac-711c-899b-71538f1133f4?t=0 @0:00. Signals: D5, confidence high.
- **I7-revisit-u6** — [High] Sales Invoice (new) › sales invoice:new: 6 of 6 users / 6 sessions: re-opened Sales Invoice (new) 3 times within one task (6 sessions); 6 of 6 affected users abandoned the form without saving; no measurable time lost. Likely cause: Sales Invoice (new) does not keep what users need in view, so they reopen it 3 times. Fix: keep the state users return for visible on Sales Invoice (new) (pinned filters, recent records) instead of requiring a reopen. Evidence: http://localhost/project/1/replay/01a219d9-5f96-7323-88f3-80ccede74f63?t=0 @0:00, http://localhost/project/1/replay/01a219d9-d781-71ea-bf01-fb2d33767010?t=0 @0:00, http://localhost/project/1/replay/01a219da-6bac-711c-899b-71538f1133f4?t=0 @0:00, http://localhost/project/1/replay/01a219da-e47e-78ba-bf32-ba604f577be2?t=0 @0:00, http://localhost/project/1/replay/01a219db-726b-7654-a48f-5ccf8260e281?t=0 @0:00. Signals: R2, confidence med.
- **I7-revisit-u6** — [High] Sales Invoice (new) › customer:list: 6 of 6 users / 6 sessions: went from Sales Invoice (new) to Customer (list) and straight back 2 times in one task, staying 1.8 s–2.0 s on Customer (list) (6 sessions); 3 of 6 affected users abandoned the form without saving; median 3.7 s lost per affected user. Likely cause: information needed to finish Sales Invoice (new) is only shown on Customer (list), so users leave to look it up (2 round trips per task). Fix: show the needed Customer (list) details on Sales Invoice (new), e.g. as a preview next to the linked field, so users need not leave the form. Evidence: http://localhost/project/1/replay/01a219d9-5f96-7323-88f3-80ccede74f63?t=3 @0:03, http://localhost/project/1/replay/01a219dc-0431-741b-96c9-29dcb9f3dbe8?t=3 @0:03, http://localhost/project/1/replay/01a219da-6bac-711c-899b-71538f1133f4?t=4 @0:04, http://localhost/project/1/replay/01a219db-726b-7654-a48f-5ccf8260e281?t=5 @0:05, http://localhost/project/1/replay/01a219da-e47e-78ba-bf32-ba604f577be2?t=5 @0:05. Signals: R1, confidence med.
- **I5-dead-apply-u6** — [Medium] Sales Invoice (new) › Apply: 6 of 6 users / 6 sessions: clicked Apply 5 times within 0.9 s–1.4 s at the same spot (6 sessions); No abandonment observed; median 1.1 s lost per affected user. Likely cause: Apply gives no immediate visible feedback, so users click it again (5 clicks, each within 1 s and 30 px of the last). Fix: give Apply on Sales Invoice (new) an immediate pressed/disabled state and a progress indicator while its action runs. Evidence: http://localhost/project/1/replay/01a219d3-0f58-785e-acdf-9915833dcec9?t=4 @0:04, http://localhost/project/1/replay/01a219d0-c2d4-76e2-bb2c-d0633f25ec9c?t=4 @0:04, http://localhost/project/1/replay/01a219d1-b426-7a5d-b77e-13ba5774199a?t=4 @0:04, http://localhost/project/1/replay/01a219d2-8d10-706e-a7ff-8e382ebc3d56?t=6 @0:06, http://localhost/project/1/replay/01a219d2-1565-74e9-8952-77a1036ad959?t=6 @0:06. Signals: D1, confidence high.
- **I6-scroll-hunt-u6** — [Medium] Item (list) › Scroll container: 6 of 6 users / 6 sessions: scrolled 12.0× the visible height in Scroll container with 6 direction reversals, without clicking or typing between reversals (6 sessions; page extent ≥ 8762 px); No abandonment observed; median 8.6 s lost per affected user. Likely cause: the target in Scroll container on Item (list) is hard to find by scrolling (6 up/down reversals of at least a quarter screen each, no search or filter used). Fix: on Item (list), put search/filter above Scroll container, sort the most likely target first, and keep the list short by default. Evidence: http://localhost/project/1/replay/01a219d6-17f9-7a35-8bac-18b9ab03cc53?t=5 @0:05, http://localhost/project/1/replay/01a219d5-bafa-7738-9fc7-1b6be835fb7a?t=6 @0:06, http://localhost/project/1/replay/01a219d6-da5c-708f-b62c-066d065156bb?t=7 @0:07, http://localhost/project/1/replay/01a219d5-592c-777a-8d80-dc0fb0c97f68?t=7 @0:07, http://localhost/project/1/replay/01a219d4-f6a2-7c0c-8f1c-be2c11f6a30a?t=7 @0:07. Signals: S1+S2+S3, confidence med.
- **I6-scroll-hunt-u6** — [Medium] Accounts Receivable (report) › item:list: 6 of 6 users / 6 sessions: went from Accounts Receivable (report) to Item (list) and straight back 1 times in one task, staying 5.2 s–7.3 s on Item (list) (6 sessions); No abandonment observed; median 6.3 s lost per affected user. Likely cause: information needed to finish Accounts Receivable (report) is only shown on Item (list), so users leave to look it up (1 round trips per task). Fix: show the needed Item (list) details on Accounts Receivable (report), e.g. as a preview next to the linked field, so users need not leave the form. Evidence: http://localhost/project/1/replay/01a219d6-17f9-7a35-8bac-18b9ab03cc53?t=3 @0:03, http://localhost/project/1/replay/01a219d5-bafa-7738-9fc7-1b6be835fb7a?t=4 @0:04, http://localhost/project/1/replay/01a219d5-592c-777a-8d80-dc0fb0c97f68?t=4 @0:04, http://localhost/project/1/replay/01a219d6-da5c-708f-b62c-066d065156bb?t=5 @0:05, http://localhost/project/1/replay/01a219d4-f6a2-7c0c-8f1c-be2c11f6a30a?t=5 @0:05. Signals: R1, confidence med.
- **I3-wait-6s-u3** — [Medium] Purchase Order (new) › Save: 3 of 6 users / 3 sessions: waited 6.0 s (median 6.0 s) after Save before the screen responded (3 sessions; 6 clicks/keys during the waits); No abandonment observed; median 6.0 s lost per affected user. Likely cause: the response to Save is slow (loading overlay stayed visible for 6.0 s). Fix: profile the request behind Save on Purchase Order (new), bring it under 3 s, and show progress with an estimated time while it runs. Evidence: http://localhost/project/1/replay/01a219e0-4916-70ac-8da7-9466eb1a53ec?t=12 @0:12, http://localhost/project/1/replay/01a219df-4813-7cb2-be18-d82e6b98ecb2?t=16 @0:16, http://localhost/project/1/replay/01a219df-c59c-7618-8758-c965247c49d4?t=17 @0:17. Signals: D10, confidence med.
- **I1-hesitation-u3** — [Low] Sales Invoice (new) › Due Date: 3 of 6 users / 3 sessions: repeated Due Date 4 times 1–10 s apart with no visible state change (3 sessions); No abandonment observed; median 8.8 s lost per affected user. Likely cause: the first Due Date gave no visible confirmation, so users repeated it. Fix: confirm Due Date on Sales Invoice (new) with a visible state change or message. Evidence: http://localhost/project/1/replay/01a219dd-1b19-7e79-8c02-ab1bd40d9e55?t=4 @0:04, http://localhost/project/1/replay/01a219dd-8bc7-7cac-8246-3ee3787404bd?t=5 @0:05, http://localhost/project/1/replay/01a219dc-8461-7e30-8581-b54021dd63e0?t=6 @0:06, http://localhost/project/1/replay/01a219dd-8bc7-7cac-8246-3ee3787404bd?t=13 @0:13. Signals: D14, confidence med.
- **I3-wait-2s-u3** — [Low] Purchase Order (new) › Save: 3 of 6 users / 3 sessions: repeated Save 3 times 1–10 s apart with no visible state change (3 sessions); No abandonment observed; median 2.0 s lost per affected user. Likely cause: the first Save gave no visible confirmation, so users repeated it. Fix: confirm Save on Purchase Order (new) with a visible state change or message. Evidence: http://localhost/project/1/replay/01a219de-1635-79c2-8437-c23f8f8d60ef?t=10 @0:10, http://localhost/project/1/replay/01a219de-68ea-76d9-9873-745522a8ccb2?t=15 @0:15, http://localhost/project/1/replay/01a219de-d3a6-7ab2-b7ce-50fc57fe1c5a?t=17 @0:17. Signals: D14, confidence med.

## Misses

- hesitation 220130:0 (01a219dc-8461-7e30-8581-b54021dd63e0, window 5.4–16.1 s): pipeline found D14@sales invoice:new:6.5s
- hesitation 220131:0 (01a219dd-1b19-7e79-8c02-ab1bd40d9e55, window 3.8–12.6 s): pipeline found D14@sales invoice:new:4.2s
- hesitation 220132:0 (01a219dd-8bc7-7cac-8246-3ee3787404bd, window 4.9–14.4 s): pipeline found D14@sales invoice:new:5.6s, D14@sales invoice:new:13.2s

## Calibration (separate, not a headline)

72 clean sessions, no planted moments. Findings: D14×8. Sessions with a strong/medium finding other than D14: 0.0% [0.0, 5.1] (0/72).

## Limits

Scripted personas, not people: recall concerns planted behaviour, and precision on controls counts unplanted real behaviour as false positives. Natural friction was not labelled by blind human reviewers, so natural-friction precision and human severity κ are not available. Six users per scope bound every rate (see the Wilson intervals). The proxy blocks svg/script/style nodes from replay so the first upload fits the local capture limit; replay frames lack icons. Revisits use full page loads (typed URL), not in-app links.
