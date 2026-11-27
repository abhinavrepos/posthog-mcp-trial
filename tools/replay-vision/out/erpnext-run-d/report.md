# Replay Vision — ERPNext v16 evaluation report

Generated 2026-11-27T05:46:42.522Z by `tools/replay-vision/run.ts`. Frozen config hash (detectors + severity + calibration baselines) `f3ddc7bf845839234d88a4ff39f67edc5375155a0b9c7643c9a0a2f1c34d2151`, baseline hash `a4954c56d55b73d7388760a762ccbec3ee90b2c236c30e9b09d47ae25c497b75`, detectors `rv-d1-15-r1-r2-s1-s3-v9`, severity `severity-v1`. The hash was written to `frozen-config.json` after calibration and before any held-out session was analysed. Calibration and held-out sessions have disjoint seeds and session ids. Held-out results are the headline; calibration is reported separately.

## Design

- Calibration: 4 clean repeats × 6 personas (Expert, Novice, Hurried, Careful, Explorer, Returning; users rv.cal.0–5) × 3 workflows (Sales Invoice create→Save→Submit, Purchase Order create→Save→Submit, Accounts Receivable report filter + inspect) = 72 sessions. Baselines are recomputed from these alone (product `recomputeBaselines`). Calibrated screens (≥20 sessions, ≥5 users): accounts receivable:report, purchase order:new, sales invoice:new.
- Held-out controls: 6 users (rv.eval.0–5) × 3 workflows, no injection (18 sessions).
- Held-out injected cohorts: 19 cohorts, 61 sessions. Dose = distinct affected users (1/3/6) for I2 validation loop, I5 inert Apply, I6 scroll hunt, I7 Customer↔Invoice revisits; I2 with abandonment; I3 save waits of 2/6/15 s; I1 relabelled field with 3–9 s hesitation; R2 re-open; D5 abandonment. Each cohort is scored in its own scope (cohort + the 18 controls), as one client would be in the product.
- Pipeline: product code only (`analyzeFile → storeFindings → runMetrics → recomputeBaselines (calibration only) → refreshInsights`), see `pipeline.ts`. No LLM call; provider calls and spend: 0 / $0.

## Coverage and cost

- 151 sessions analysed (79 held-out complete, 0 held-out partial; calibration 72/72 complete). A session without rrweb Meta + FullSnapshot is marked partial/missing_snapshot by the analysis.
- Snapshot JSONL from PostHog's public API: total 224.7 MiB, median 1438 KiB, p95 3176 KiB, max 4102 KiB.
- Browser time 3670 s for 151 sessions; evaluation (download cache + analysis + insights + scoring) 142 s; peak RSS 344 MiB.

| Workflow | Calibration done | Held-out controls done | Held-out injected done |
| --- | ---: | ---: | ---: |
| invoice | 22/24 | 6/6 | 42/42 |
| purchase | 21/24 | 6/6 | 9/9 |
| report | 23/24 | 6/6 | 10/10 |

(Injected abandonment sessions count as done when the line item was entered; they never save by design.)

## Held-out moment detection (headline)

61 delivered ground-truth moments (0 planned injections were not delivered and are excluded: none). 104 pipeline findings on 79 held-out sessions.

- Recall, all compatible detectors: **100.0% [94.1, 100.0] (61/61)**
- Precision, all findings incl. diagnostics and natural behaviour: 58.7% [49.0, 67.6] (61/104)
- Precision of strong/medium findings: 64.9% [54.8, 73.8] (61/94); on injected sessions only: 64.9% [54.8, 73.8] (61/94)
- Moment-level precision (a finding is correct when it overlaps a compatible planted moment, so co-firing S1/S2/S3 or R1/R2 on one moment all count): all 87.5% [79.8, 92.5] (91/104); strong/medium 86.2% [77.8, 91.7] (81/94)
- Element agreement among matched moments: 100.0% [94.1, 100.0] (61/61)

Strict precision (one finding per moment) counts every other finding as a false positive, including co-firing compatible detectors and real behaviour the script did not plant, so it is a lower bound.

| Detector | TP | FP | FP on controls | FN | Precision, Wilson 95% | Recall, Wilson 95% |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| D1 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| D10 | 6 | 0 | 0 | 0 | 100.0% [61.0, 100.0] (6/6) | 100.0% [61.0, 100.0] (6/6) |
| D12 | 0 | 0 | 0 | 3 | undefined (n=0) | 0.0% [0.0, 56.2] (0/3) |
| D2 | 0 | 0 | 0 | 10 | undefined (n=0) | 0.0% [0.0, 27.8] (0/10) |
| D4 | 13 | 0 | 0 | 0 | 100.0% [77.2, 100.0] (13/13) | 100.0% [77.2, 100.0] (13/13) |
| D5 | 6 | 0 | 0 | 0 | 100.0% [61.0, 100.0] (6/6) | 100.0% [61.0, 100.0] (6/6) |
| D6 | 3 | 0 | 0 | 0 | 100.0% [43.8, 100.0] (3/3) | 100.0% [43.8, 100.0] (3/3) |
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
| I2-validation-u1 | 1 | Low | Low | 1 | 1 | Low: anomalous finding (no High/Medium rule met). U/N 1/6; median lost 3.0 s; A 0; calibrated; signal D4; rate 1/7 vs prior 0%: increase |
| I2-validation-u3 | 3 | High | High | 3 | 1 | High: strong D4 (2 cycles) in 3>=3 users. U/N 3/6; median lost 2.2 s; A 0; calibrated; signal D4; rate 3/9 vs prior 0%: increase |
| I2-validation-u6 | 6 | High | High | 6 | 1 | High: strong D4 (2 cycles) in 6>=3 users. U/N 6/6; median lost 3.2 s; A 0; calibrated; signal D4; rate 6/12 vs prior 0%: increase |
| I2-validation-abandon-u3 | 3 | High | High | 3 | 2 | High: 3 users abandoned after friction. U/N 3/6; median lost 2.8 s; A 3; calibrated; signal D4; rate 3/9 vs prior 0%: increase |
| I5-dead-apply-u1 | 1 | Low | Low | 1 | 1 | Low: anomalous finding (no High/Medium rule met). U/N 1/6; median lost 1.1 s; A 0; calibrated; signal D1; rate 1/7 vs prior 0%: increase |
| I5-dead-apply-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 1.0 s; A 0; calibrated; signal D1; rate 3/9 vs prior 0%: increase |
| I5-dead-apply-u6 | 6 | Medium | Medium | 6 | 1 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 1.1 s; A 0; calibrated; signal D1; rate 6/12 vs prior 0%: increase |
| I6-scroll-hunt-u1 | 1 | Low | None | – | – | no insight published |
| I6-scroll-hunt-u3 | 3 | Medium | Medium | 3 | 2 | Medium: U 3>=2 and p 100.0%>=10%. U/N 3/3; median lost 8.3 s; A 0; uncalibrated; signal S3 |
| I6-scroll-hunt-u6 | 6 | Medium | Medium | 6 | 2 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 8.5 s; A 0; uncalibrated; signal S3 |
| I7-revisit-u1 | 1 | Low | None | – | – | no insight published |
| I7-revisit-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 3.9 s; A 0; calibrated; signal R1 |
| I7-revisit-u6 | 6 | Medium | Medium | 6 | 1 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 3.9 s; A 0; calibrated; signal R1 |
| I1-hesitation-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 2.0 s; A 0; calibrated; signal D6 |
| I3-wait-6s-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 6.0 s; A 0; calibrated; signal D10 |
| I3-wait-15s-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 15 s; A 0; calibrated; signal D10 |
| R2-reopen-u3 | 3 | Medium | Medium | 3 | 2 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 0.0 s; A 0; calibrated; signal R2 |
| D5-abandon-u3 | 3 | High | High | 3 | 1 | High: 3 users abandoned after friction. U/N 3/6; median lost 19 s; A 3; calibrated; signal D5; rate 3/9 vs prior 0%: increase |

Negative dose control (2 s wait, below the D10 floor): I3-wait-2s-u3: 0 D10 findings, insight none.

## Insights

Published (validated) insights across all scopes: 22. hit@3 88.9% [67.2, 96.9] (16/18), hit@10 88.9% [67.2, 96.9] (16/18) (correct screen, accepted element, compatible detector, user count ±1, rubric ≥14). Mean rubric 17.2/18. Generic insights: 0. Citations 74, hallucinated (not traceable to a stored candidate of a session in scope at that offset and event id): 0.

### Example insights (exact product text, one per family and screen)

- **I2-validation-u6** — [High] Sales Invoice (new) › Save: 6 of 6 users / 6 sessions: clicked Save and got a visible validation error 2 times in a row, editing fields between attempts (6 sessions, 2.0 s–3.8 s per loop); No abandonment observed; median 3.2 s lost per affected user. Likely cause: the requirement behind the validation error shown after Save is not visible before clicking, so the edits users make between attempts do not resolve it. Fix: on Sales Invoice (new), validate the fields Save depends on inline as they are filled, and name the failing field next to Save instead of only in the error message. Evidence: http://localhost/project/1/replay/01a21b41-17de-7abe-83c2-29935ba7b3d8?t=11 @0:11, http://localhost/project/1/replay/01a21b40-2835-7e2e-8db1-5eeb472d7495?t=12 @0:12, http://localhost/project/1/replay/01a21b3f-bfba-7120-8637-e87c05c4fdf4?t=13 @0:13, http://localhost/project/1/replay/01a21b3e-cb0e-7113-bc35-aa845dba906c?t=16 @0:16, http://localhost/project/1/replay/01a21b3f-434b-7866-a4c2-34016b3a9f5e?t=17 @0:17. Signals: D4, confidence high.
- **I2-validation-abandon-u3** — [High] Sales Invoice (new) › Payment Due Date: 3 of 6 users / 3 sessions: left the form after editing 5 fields without saving; last field edited: Payment Due Date (3 sessions, 3 right after a validation error, error click or slow save); 3 of 3 affected users abandoned the form without saving; median 21 s lost per affected user. Likely cause: friction on this form (visible validation error, error click or slow save recorded before leaving) stopped 3 of 3 attempts. Fix: on Sales Invoice (new), keep a recoverable draft of the form and surface what blocks saving next to Payment Due Date. Evidence: http://localhost/project/1/replay/01a21b42-60cf-76c2-b879-1e1a3f83797d?t=4 @0:04, http://localhost/project/1/replay/01a21b41-f683-7ac1-a50a-ae4117290e85?t=4 @0:04, http://localhost/project/1/replay/01a21b41-755f-7265-ae80-44475c7b706a?t=6 @0:06. Signals: D5, confidence high.
- **I5-dead-apply-u6** — [Medium] Sales Invoice (new) › Apply: 6 of 6 users / 6 sessions: clicked Apply 5 times within 0.9 s–1.4 s at the same spot (6 sessions); No abandonment observed; median 1.1 s lost per affected user. Likely cause: Apply gives no immediate visible feedback, so users click it again (5 clicks, each within 1 s and 30 px of the last). Fix: give Apply on Sales Invoice (new) an immediate pressed/disabled state and a progress indicator while its action runs. Evidence: http://localhost/project/1/replay/01a21b46-e693-706b-970d-d5fa1b63f853?t=4 @0:04, http://localhost/project/1/replay/01a21b46-7e1f-753a-9264-3ca23e712130?t=4 @0:04, http://localhost/project/1/replay/01a21b45-17fb-7eed-9aba-66e71cca0de5?t=4 @0:04, http://localhost/project/1/replay/01a21b45-76ae-7de7-8f08-4dfcc0ee32ec?t=6 @0:06, http://localhost/project/1/replay/01a21b45-f53e-795a-9a62-cbbb23c9d4e7?t=6 @0:06. Signals: D1, confidence high.
- **I6-scroll-hunt-u6** — [Medium] Accounts Receivable (report) › item:list: 6 of 6 users / 6 sessions: went from Accounts Receivable (report) to Item (list) and straight back 1 times in one task, staying 5.4 s–7.3 s on Item (list) (6 sessions); No abandonment observed; median 6.3 s lost per affected user. Likely cause: information needed to finish Accounts Receivable (report) is only shown on Item (list), so users leave to look it up (1 round trips per task). Fix: show the needed Item (list) details on Accounts Receivable (report), e.g. as a preview next to the linked field, so users need not leave the form. Evidence: http://localhost/project/1/replay/01a21b49-5227-78f5-920b-b72af202e189?t=0 @0:00, http://localhost/project/1/replay/01a21b48-ffda-70e7-bbeb-e027946c508b?t=2 @0:02, http://localhost/project/1/replay/01a21b4a-0068-755f-aec5-a9e4e0d78c3d?t=3 @0:03, http://localhost/project/1/replay/01a21b4a-4e1e-7f1b-bc2b-6a4d87c12479?t=4 @0:04, http://localhost/project/1/replay/01a21b48-9e28-7669-b1db-d35a97bee291?t=4 @0:04. Signals: R1, confidence med.
- **I6-scroll-hunt-u6** — [Medium] Item (list) › Item 190: 6 of 6 users / 6 sessions: scrolled 12.0× the visible height in Item 190 with 6 direction reversals, without clicking or typing between reversals (6 sessions; page extent ≥ 8762 px); No abandonment observed; median 8.5 s lost per affected user. Likely cause: the target in Item 190 on Item (list) is hard to find by scrolling (6 up/down reversals of at least a quarter screen each, no search or filter used). Fix: on Item (list), put search/filter above Item 190, sort the most likely target first, and keep the list short by default. Evidence: http://localhost/project/1/replay/01a21b49-5227-78f5-920b-b72af202e189?t=2 @0:02, http://localhost/project/1/replay/01a21b48-ffda-70e7-bbeb-e027946c508b?t=4 @0:04, http://localhost/project/1/replay/01a21b4a-0068-755f-aec5-a9e4e0d78c3d?t=5 @0:05, http://localhost/project/1/replay/01a21b4a-4e1e-7f1b-bc2b-6a4d87c12479?t=7 @0:07, http://localhost/project/1/replay/01a21b48-9e28-7669-b1db-d35a97bee291?t=7 @0:07. Signals: S1+S2+S3, confidence med.
- **I7-revisit-u6** — [Medium] Sales Invoice (new) › customer:list: 6 of 6 users / 6 sessions: went from Sales Invoice (new) to Customer (list) and straight back 2 times in one task, staying 1.7 s–2.0 s on Customer (list) (6 sessions); No abandonment observed; median 3.9 s lost per affected user. Likely cause: information needed to finish Sales Invoice (new) is only shown on Customer (list), so users leave to look it up (2 round trips per task). Fix: show the needed Customer (list) details on Sales Invoice (new), e.g. as a preview next to the linked field, so users need not leave the form. Evidence: http://localhost/project/1/replay/01a21b4e-f0fe-75b1-a2da-02efcf2eb98b?t=4 @0:04, http://localhost/project/1/replay/01a21b4f-717f-7aee-9ffd-0be82afd96e9?t=4 @0:04, http://localhost/project/1/replay/01a21b4d-5357-7c78-a1f8-2a7e159b49a1?t=4 @0:04, http://localhost/project/1/replay/01a21b4e-5f72-7dcc-95b7-5774e2c12e57?t=5 @0:05, http://localhost/project/1/replay/01a21b4d-cea7-7c2a-b311-5bd553f22e94?t=5 @0:05. Signals: R1, confidence med.
- **I7-revisit-u6** — [Medium] Sales Invoice (new) › sales invoice:new: 6 of 6 users / 6 sessions: re-opened Sales Invoice (new) 3 times within one task (6 sessions); No abandonment observed; no measurable time lost. Likely cause: Sales Invoice (new) does not keep what users need in view, so they reopen it 3 times. Fix: keep the state users return for visible on Sales Invoice (new) (pinned filters, recent records) instead of requiring a reopen. Evidence: http://localhost/project/1/replay/01a21b4c-b7af-72e2-bbe6-3ab52772cb8b?t=0 @0:00, http://localhost/project/1/replay/01a21b4d-5357-7c78-a1f8-2a7e159b49a1?t=0 @0:00, http://localhost/project/1/replay/01a21b4d-cea7-7c2a-b311-5bd553f22e94?t=0 @0:00, http://localhost/project/1/replay/01a21b4e-5f72-7dcc-95b7-5774e2c12e57?t=0 @0:00, http://localhost/project/1/replay/01a21b4e-f0fe-75b1-a2da-02efcf2eb98b?t=0 @0:00. Signals: R2, confidence med.
- **I1-hesitation-u3** — [Medium] Sales Invoice (new) › Effective Value Date: 3 of 6 users / 3 sessions: paused 4.0 s–5.6 s on Effective Value Date before typing (3 sessions); No abandonment observed; median 2.0 s lost per affected user. Likely cause: the label Effective Value Date does not tell users what to enter; first input came 4.0 s–5.6 s after focus. Fix: rename Effective Value Date on Sales Invoice (new) to the term users expect and add a one-line description with an example under it. Evidence: http://localhost/project/1/replay/01a21b4f-f099-7fbb-ba10-db821dee1cee?t=4 @0:04, http://localhost/project/1/replay/01a21b50-52fe-7707-a759-e9a2436be206?t=5 @0:05, http://localhost/project/1/replay/01a21b50-d274-7532-a68b-6eacc3e53316?t=6 @0:06. Signals: D6, confidence med.
- **I3-wait-6s-u3** — [Medium] Purchase Order (new) › Save: 3 of 6 users / 3 sessions: waited 6.0 s (median 6.0 s) after Save before the screen responded (3 sessions; 6 clicks/keys during the waits); No abandonment observed; median 6.0 s lost per affected user. Likely cause: the response to Save is slow (loading overlay stayed visible for 6.0 s). Fix: profile the request behind Save on Purchase Order (new), bring it under 3 s, and show progress with an estimated time while it runs. Evidence: http://localhost/project/1/replay/01a21b53-78f1-7ee6-8e14-bbdd8cef7070?t=11 @0:11, http://localhost/project/1/replay/01a21b53-0d34-7143-bb08-0aa91ba8fa40?t=11 @0:11, http://localhost/project/1/replay/01a21b52-90b8-7b79-9a71-b9bfc30862b4?t=15 @0:15. Signals: D10, confidence med.

## Misses

None.

## Calibration (separate, not a headline)

72 clean sessions, no planted moments. Findings: none. Sessions with a strong/medium finding other than D14: 0.0% [0.0, 5.1] (0/72).

## Limits

Scripted personas, not people: recall concerns planted behaviour, and precision on controls counts unplanted real behaviour as false positives. Natural friction was not labelled by blind human reviewers, so natural-friction precision and human severity κ are not available. Six users per scope bound every rate (see the Wilson intervals). The proxy blocks svg/script/style nodes from replay so the first upload fits the local capture limit; replay frames lack icons. Revisits use full page loads (typed URL), not in-app links.
