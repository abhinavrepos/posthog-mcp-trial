# Replay Vision — Reval simulator (run R2) evaluation report

Generated 2026-11-27T05:48:16.467Z by `tools/replay-vision/run-reval.ts`. Frozen config hash (detectors + severity + calibration baselines) `7114a44ceb3df5a91975310d544aa6ab145273000e12c91a7b3e0d7d7116c860`, baseline hash `f6aaa1fc2cab97ac2b1703685da4773e82f63b597cc77896b69dd56636f5169b`, detectors `rv-d1-15-r1-r2-s1-s3-v9`, severity `severity-v1`. The hash was written to `frozen-config.json` after calibration and before any held-out session was analysed. Calibration and held-out sessions have disjoint seeds and session ids. Held-out results are the headline; calibration is reported separately.

## Design

- Application: the Reval simulator (`tools/reval-sim`): real Ext JS classic 6.2 (Reval ships 7.8), one page whose URL never changes, MDI tabs, floating parameter windows, tabbed dialogs, grids with custom Ext.LoadMasks, message boxes and toasts, an iframe screen; Reval's real events `PageView`/`Event` with `dialog_id`/`dialog_name`/`action`/`action_name`. Recorded by the standard posthog-js snippet into the real local PostHog.
- Product configuration: `APP_EVENTS_FILE=config/app-events.reval.json` (screens from PageView OPEN/CLOSE by dialog name, message boxes as visible errors, submit buttons and examples as labels) and `REPLAY_VISION_LABELS` = the deployment's visible labels (screen names, menu groups, buttons, field labels, tabs).
- Calibration: 4 clean repeats × 6 personas (users RVCAL0–5, distinct ids C1DEV|01|SEM|…) × 3 TRM workflows: deal entry (IR Swap: Trade Date, Counterparty, Notional, Cashflow tab, Recalc Cashflow, Save → toast), hedge designation (Hedge Relationship: tabs, Save, Approve; Hedge Designation report: parameters, Run, Export), amortisation (Loan: Amortisation tab; Cashflow Report: parameters, Run, scroll, XLSX Export). Screens are opened through the toolbar menus with real clicks.
- Held-out controls: users RVEVAL0–5 × 3 workflows (18 sessions). Held-out injected cohorts: 16 cohorts, 52 sessions: I2 Cap / Floor Save rejected by Reval's "Strike must be greater than zero" message box, edits, retry, give up (1/3/6 users); I5 inert Apply button in the IR Swap toolbar (1/3/6); I6 hunting trade 37 in the Trade List grid by scrolling (1/3/6); I7 Counterparty lookup closed and reopened twice during deal entry (1/3/6); I3 Hedge Relationship opening in 2/6/15 s (3 users each; 2 s is the negative dose control); I1 IR Swap "Notional" relabelled "Principal Amount" with a seeded 3–9 s pause (3 users). Each cohort is one product scope (cohort + the 18 controls).
- Pipeline and protocol: identical to ERPNext (product code only; baselines from calibration only; hash frozen before held-out analysis; one-to-one matching, Wilson 95% intervals). No LLM output is produced by this harness.

## Coverage and cost

- 142 sessions analysed (70 held-out complete, 0 held-out partial; calibration 72/72 complete). A session without rrweb Meta + FullSnapshot is marked partial/missing_snapshot by the analysis.
- Snapshot JSONL from PostHog's public API: total 39.1 MiB, median 249 KiB, p95 374 KiB, max 393 KiB.
- Browser time 3541 s for 142 sessions; evaluation (download cache + analysis + insights + scoring) 93 s; peak RSS 219 MiB.

| Workflow | Calibration done | Held-out controls done | Held-out injected done |
| --- | ---: | ---: | ---: |
| deal | 24/24 | 6/6 | 33/33 |
| hedge | 24/24 | 6/6 | 9/9 |
| amortisation | 24/24 | 6/6 | 10/10 |

(Injected abandonment sessions count as done when the line item was entered; they never save by design.)

## Held-out moment detection (headline)

49 delivered ground-truth moments (0 planned injections were not delivered and are excluded: none). 89 pipeline findings on 70 held-out sessions.

- Recall, all compatible detectors: **100.0% [92.7, 100.0] (49/49)**
- Precision, all findings incl. diagnostics and natural behaviour: 55.1% [44.7, 65.0] (49/89)
- Precision of strong/medium findings: 49.4% [38.6, 60.2] (39/79); on injected sessions only: 49.4% [38.6, 60.2] (39/79)
- Moment-level precision (a finding is correct when it overlaps a compatible planted moment, so co-firing S1/S2/S3 or R1/R2 on one moment all count): all 77.5% [67.8, 85.0] (69/89); strong/medium 74.7% [64.1, 83.0] (59/79)
- Element agreement among matched moments: 100.0% [92.7, 100.0] (49/49)

Strict precision (one finding per moment) counts every other finding as a false positive, including co-firing compatible detectors and real behaviour the script did not plant, so it is a lower bound.

| Detector | TP | FP | FP on controls | FN | Precision, Wilson 95% | Recall, Wilson 95% |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| D1 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| D10 | 6 | 0 | 0 | 0 | 100.0% [61.0, 100.0] (6/6) | 100.0% [61.0, 100.0] (6/6) |
| D12 | 0 | 0 | 0 | 3 | undefined (n=0) | 0.0% [0.0, 56.2] (0/3) |
| D2 | 0 | 0 | 0 | 10 | undefined (n=0) | 0.0% [0.0, 27.8] (0/10) |
| D4 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| D5 | 0 | 20 | 0 | 0 | 0.0% [0.0, 16.1] (0/20) | undefined (n=0) |
| D6 | 3 | 0 | 0 | 0 | 100.0% [43.8, 100.0] (3/3) | 100.0% [43.8, 100.0] (3/3) |
| D7 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| D8 | 0 | 0 | 0 | 3 | undefined (n=0) | 0.0% [0.0, 56.2] (0/3) |
| R1 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| R2 | 0 | 0 | 0 | 10 | undefined (n=0) | 0.0% [0.0, 27.8] (0/10) |
| S1 | 0 | 0 | 0 | 10 | undefined (n=0) | 0.0% [0.0, 27.8] (0/10) |
| S2 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |
| S3 | 10 | 0 | 0 | 0 | 100.0% [72.2, 100.0] (10/10) | 100.0% [72.2, 100.0] (10/10) |

| Injection | TP | FN | Recall, Wilson 95% |
| --- | ---: | ---: | --- |
| validation_loop | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| dead_button | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| hesitation | 3 | 0 | 100.0% [43.8, 100.0] (3/3) |
| revisit | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| reopen | 0 | 0 | undefined (n=0) |
| scroll_hunt | 10 | 0 | 100.0% [72.2, 100.0] (10/10) |
| slow_wait | 6 | 0 | 100.0% [61.0, 100.0] (6/6) |
| abandon | 0 | 0 | undefined (n=0) |

### Controls (false positives)

Control sessions with any finding: 0.0% [0.0, 17.6] (0/18); with a strong/medium finding: 0.0% [0.0, 17.6] (0/18); with a strong/medium finding other than D14: 0.0% [0.0, 17.6] (0/18). Finding kinds on controls: none. Published insights in the controls-only scope: 0.


## Severity (per cohort, product rule vs planned rule)

Quadratic-weighted κ, 4 levels with "None" (no insight published): 0.71; among cohorts with an insight: 0.52. Spearman ρ dose (users) vs severity over the I2/I5/I6/I7 dose series: 0.85. Inversions: R-I2-cap-validation 1u:Low → 3u:Medium → 6u:Medium (0); R-I5-dead-apply 1u:None → 3u:Medium → 6u:Medium (0); R-I6-trade-list-hunt 1u:None → 3u:Medium → 6u:Medium (0); R-I7-counterparty-lookup 1u:None → 3u:Medium → 6u:Medium (0).

| Planned \ Predicted | None | Low | Medium | High |
| --- | ---: | ---: | ---: | ---: |
| Low | 3 | 1 | 0 | 0 |
| Medium | 0 | 0 | 9 | 0 |
| High | 0 | 0 | 2 | 0 |

| Cohort | Users | Planned | Predicted | Insight U | Rank of matching insight | Product severity reason |
| --- | ---: | --- | --- | ---: | ---: | --- |
| R-I2-cap-validation-u1 | 1 | Low | Low | 1 | 1 | Low: anomalous finding (no High/Medium rule met). U/N 1/1; median lost 7.2 s; A 0; uncalibrated; signal D4 |
| R-I2-cap-validation-u3 | 3 | High | Medium | 3 | 1 | Medium: strong D4 (3 cycles) in 3>=3 users; capped Medium: uncalibrated screen (cold start, no abandonment). U/N 3/3; median lost 11 s; A 0; uncalibrated; signal D4 |
| R-I2-cap-validation-u6 | 6 | High | Medium | 6 | 1 | Medium: strong D4 (3 cycles) in 6>=3 users; capped Medium: uncalibrated screen (cold start, no abandonment). U/N 6/6; median lost 10 s; A 0; uncalibrated; signal D4 |
| R-I5-dead-apply-u1 | 1 | Low | None | – | – | no insight published |
| R-I5-dead-apply-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 0.9 s; A 0; calibrated; signal D1; rate 3/9 vs prior 4%: increase |
| R-I5-dead-apply-u6 | 6 | Medium | Medium | 6 | 1 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 1.1 s; A 0; calibrated; signal D1; rate 6/12 vs prior 4%: increase |
| R-I6-trade-list-hunt-u1 | 1 | Low | None | – | – | no insight published |
| R-I6-trade-list-hunt-u3 | 3 | Medium | Medium | 3 | 2 | Medium: U 3>=2 and p 100.0%>=10%. U/N 3/3; median lost 5.7 s; A 0; uncalibrated; signal S3 |
| R-I6-trade-list-hunt-u6 | 6 | Medium | Medium | 6 | 2 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 5.7 s; A 0; uncalibrated; signal S3 |
| R-I7-counterparty-lookup-u1 | 1 | Low | None | – | – | no insight published |
| R-I7-counterparty-lookup-u3 | 3 | Medium | Medium | 3 | 2 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 6.1 s; A 0; calibrated; signal R1 |
| R-I7-counterparty-lookup-u6 | 6 | Medium | Medium | 6 | 2 | Medium: U 6>=2 and p 100.0%>=10%. U/N 6/6; median lost 6.2 s; A 0; calibrated; signal R1 |
| R-I3-hedge-open-6s-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 6.5 s; A 0; calibrated; signal D10 |
| R-I3-hedge-open-15s-u3 | 3 | Medium | Medium | 2 | 1 | Medium: U 2>=2 and p 33.3%>=10%. U/N 2/6; median lost 15 s; A 0; calibrated; signal D10 |
| R-I1-notional-relabel-u3 | 3 | Medium | Medium | 3 | 1 | Medium: U 3>=2 and p 50.0%>=10%. U/N 3/6; median lost 2.2 s; A 0; calibrated; signal D6 |

Negative dose control (2 s wait, below the D10 floor): R-I3-hedge-open-2s-u3: 0 D10 findings, insight none.

## Insights

Published (validated) insights across all scopes: 20. hit@3 80.0% [54.8, 93.0] (12/15), hit@10 80.0% [54.8, 93.0] (12/15) (correct screen, accepted element, compatible detector, user count ±1, rubric ≥14). Mean rubric 17.7/18. Generic insights: 0. Citations 67, hallucinated (not traceable to a stored candidate of a session in scope at that offset and event id): 0.

### Example insights (exact product text, one per family and screen)

- **R-I6-trade-list-hunt-u6** — [High] Cashflow Report (screen) › Portfolio: 6 of 6 users / 6 sessions: left the form after editing 2 fields without saving; last field edited: Portfolio (6 sessions); 6 of 6 affected users abandoned the form without saving; median 9.8 s lost per affected user. Likely cause: no friction signal was recorded before users left; the reason is not observable in the replay. Fix: on Cashflow Report (screen), keep a recoverable draft of the form and surface what blocks saving next to Portfolio. Evidence: http://localhost/project/1/replay/01a21b70-9d03-73f3-8441-530a16e6152f?t=8 @0:08, http://localhost/project/1/replay/01a21b6f-3a3c-7a52-8010-abd2ddd28c29?t=9 @0:09, http://localhost/project/1/replay/01a21b6f-ab87-7193-a1b2-fd4cf2cf9cf2?t=9 @0:09, http://localhost/project/1/replay/01a21b70-1787-794a-9825-160f18fb8cda?t=9 @0:09, http://localhost/project/1/replay/01a21b6e-b5aa-725d-b89e-9acddf42465a?t=10 @0:10. Signals: D5, confidence high.
- **R-I7-counterparty-lookup-u6** — [High] Ir Swap (screen) › Counterparty: 6 of 6 users / 6 sessions: left the form after editing 2 fields without saving; last field edited: Counterparty (6 sessions); 6 of 6 affected users abandoned the form without saving; median 4.4 s lost per affected user. Likely cause: no friction signal was recorded before users left; the reason is not observable in the replay. Fix: on Ir Swap (screen), keep a recoverable draft of the form and surface what blocks saving next to Counterparty. Evidence: http://localhost/project/1/replay/01a21b73-d855-7bec-bb00-89e82bc0280a?t=2 @0:02, http://localhost/project/1/replay/01a21b75-82b2-7da6-aa33-9622494d7dbe?t=2 @0:02, http://localhost/project/1/replay/01a21b75-1884-74c4-9d1d-27e6fb956322?t=3 @0:03, http://localhost/project/1/replay/01a21b74-a542-7dda-b4f9-cac740f99c7c?t=3 @0:03, http://localhost/project/1/replay/01a21b74-382b-7df0-b4c7-a21333f220fb?t=3 @0:03. Signals: D5, confidence high.
- **R-I2-cap-validation-u6** — [Medium] Cap / Floor (screen) › Save: 6 of 6 users / 6 sessions: clicked Save and got a visible validation error 3 times in a row, editing fields between attempts (6 sessions, 6.7 s–15 s per loop); No abandonment observed; median 10 s lost per affected user. Likely cause: the requirement behind the validation error shown after Save is not visible before clicking, so the edits users make between attempts do not resolve it. Fix: on Cap / Floor (screen), validate the fields Save depends on inline as they are filled, and name the failing field next to Save instead of only in the error message. Evidence: http://localhost/project/1/replay/01a21b68-17a7-7b5f-86f3-453925fddbf8?t=16 @0:16, http://localhost/project/1/replay/01a21b68-93a4-7ee7-b6f5-1ed3a459af30?t=17 @0:17, http://localhost/project/1/replay/01a21b66-e2ac-7829-b447-cf38f8023d28?t=17 @0:17, http://localhost/project/1/replay/01a21b66-548a-7db6-898f-9847b8ce33f5?t=19 @0:19, http://localhost/project/1/replay/01a21b67-67e7-7bea-b4f5-13c46a53f964?t=19 @0:19. Signals: D4, confidence high.
- **R-I2-cap-validation-u6** — [Medium] Cap / Floor (screen) › Notional: 6 of 6 users / 6 sessions: returned to the Notional field 3 times within one form attempt (6 sessions); No abandonment observed; no measurable time lost. Likely cause: the value Notional expects is unclear; users re-focused it 3 times before moving on. Fix: show the expected format and an example directly under Notional on Cap / Floor (screen), and validate Notional on blur. Evidence: http://localhost/project/1/replay/01a21b68-17a7-7b5f-86f3-453925fddbf8?t=16 @0:16, http://localhost/project/1/replay/01a21b68-93a4-7ee7-b6f5-1ed3a459af30?t=16 @0:16, http://localhost/project/1/replay/01a21b66-e2ac-7829-b447-cf38f8023d28?t=17 @0:17, http://localhost/project/1/replay/01a21b67-67e7-7bea-b4f5-13c46a53f964?t=18 @0:18, http://localhost/project/1/replay/01a21b66-548a-7db6-898f-9847b8ce33f5?t=18 @0:18. Signals: D7, confidence med.
- **R-I5-dead-apply-u6** — [Medium] Ir Swap (screen) › Apply: 6 of 6 users / 6 sessions: clicked Apply 4–5 times within 0.7 s–1.4 s at the same spot (6 sessions); No abandonment observed; median 1.1 s lost per affected user. Likely cause: Apply gives no immediate visible feedback, so users click it again (4–5 clicks, each within 1 s and 30 px of the last). Fix: give Apply on Ir Swap (screen) an immediate pressed/disabled state and a progress indicator while its action runs. Evidence: http://localhost/project/1/replay/01a21b6b-30a5-7c03-a7d9-2c4d6ae758bf?t=4 @0:04, http://localhost/project/1/replay/01a21b6c-91fa-70de-a435-24e89bbc8335?t=4 @0:04, http://localhost/project/1/replay/01a21b6c-44aa-7938-9950-f5b8ecfc5947?t=5 @0:05, http://localhost/project/1/replay/01a21b6a-dd80-7b03-8de3-3b403354e7d4?t=6 @0:06, http://localhost/project/1/replay/01a21b6b-7458-72ea-9bf8-ff600592aa22?t=11 @0:11. Signals: D1, confidence high.
- **R-I6-trade-list-hunt-u6** — [Medium] Trade List (screen) › Scroll container: 6 of 6 users / 6 sessions: scrolled 1.7× the visible height in Scroll container with 5 direction reversals, without clicking or typing between reversals (6 sessions; page extent ≥ 1055 px); No abandonment observed; median 5.7 s lost per affected user. Likely cause: the target in Scroll container on Trade List (screen) is hard to find by scrolling (5 up/down reversals of at least a quarter screen each, no search or filter used). Fix: on Trade List (screen), put search/filter above Scroll container, sort the most likely target first, and keep the list short by default. Evidence: http://localhost/project/1/replay/01a21b70-9d03-73f3-8441-530a16e6152f?t=18 @0:18, http://localhost/project/1/replay/01a21b6f-ab87-7193-a1b2-fd4cf2cf9cf2?t=20 @0:20, http://localhost/project/1/replay/01a21b6f-3a3c-7a52-8010-abd2ddd28c29?t=20 @0:20, http://localhost/project/1/replay/01a21b71-01c1-7508-b0cf-deec8183bbb2?t=24 @0:24, http://localhost/project/1/replay/01a21b6e-b5aa-725d-b89e-9acddf42465a?t=25 @0:25. Signals: S2+S3, confidence med.
- **R-I7-counterparty-lookup-u6** — [Medium] Ir Swap (screen) › Counterparty: 6 of 6 users / 6 sessions: went from Ir Swap (screen) to Counterparty (screen) and straight back 2 times in one task, staying 2.7 s–3.4 s on Counterparty (screen) (6 sessions); No abandonment observed; median 6.2 s lost per affected user. Likely cause: information needed to finish Ir Swap (screen) is only shown on Counterparty (screen), so users leave to look it up (2 round trips per task). Fix: show the needed Counterparty (screen) details on Ir Swap (screen), e.g. as a preview next to the linked field, so users need not leave the form. Evidence: http://localhost/project/1/replay/01a21b73-d855-7bec-bb00-89e82bc0280a?t=4 @0:04, http://localhost/project/1/replay/01a21b75-82b2-7da6-aa33-9622494d7dbe?t=5 @0:05, http://localhost/project/1/replay/01a21b75-1884-74c4-9d1d-27e6fb956322?t=6 @0:06, http://localhost/project/1/replay/01a21b74-382b-7df0-b4c7-a21333f220fb?t=7 @0:07, http://localhost/project/1/replay/01a21b73-5d4f-7d4b-b6fb-5e732e0b6113?t=7 @0:07. Signals: R1, confidence med.
- **R-I3-hedge-open-6s-u3** — [Medium] Hedge Relationship (screen) › Hedge Relationship: 3 of 6 users / 3 sessions: waited 6.5 s (median 6.5 s) after Hedge Relationship before the screen responded (3 sessions; 18 clicks/keys during the waits); No abandonment observed; median 6.5 s lost per affected user. Likely cause: the response to Hedge Relationship is slow (loading overlay stayed visible for 6.5 s). Fix: profile the request behind Hedge Relationship on Hedge Relationship (screen), bring it under 3 s, and show progress with an estimated time while it runs. Evidence: http://localhost/project/1/replay/01a21b78-3d01-73e8-a294-e83659a6d1c7?t=1 @0:01, http://localhost/project/1/replay/01a21b77-33de-723d-8d12-ad66728dcbb0?t=1 @0:01, http://localhost/project/1/replay/01a21b77-bad0-78ac-8df0-f60a053b414d?t=2 @0:02. Signals: D10, confidence med.
- **R-I1-notional-relabel-u3** — [Medium] Ir Swap (screen) › Principal Amount: 3 of 6 users / 3 sessions: paused 5.1 s–7.2 s on Principal Amount before typing (3 sessions); No abandonment observed; median 2.2 s lost per affected user. Likely cause: the label Principal Amount does not tell users what to enter; first input came 5.1 s–7.2 s after focus. Fix: rename Principal Amount on Ir Swap (screen) to the term users expect and add a one-line description with an example under it. Evidence: http://localhost/project/1/replay/01a21b7a-918a-7564-922a-74bdc31bdd83?t=3 @0:03, http://localhost/project/1/replay/01a21b7b-422c-7243-9d5d-dfd1be7fec7e?t=3 @0:03, http://localhost/project/1/replay/01a21b7a-e1db-79b6-8d9c-0e3b42a4e2f4?t=6 @0:06. Signals: D6, confidence med.

## Misses

None.

## Calibration (separate, not a headline)

72 clean sessions, no planted moments. Findings: D1×2, D8×1. Sessions with a strong/medium finding other than D14: 2.8% [0.8, 9.6] (2/72).

## Limits

Scripted personas, not people: recall concerns planted behaviour, and precision on controls counts unplanted real behaviour as false positives. Natural friction was not labelled by blind human reviewers, so natural-friction precision and human severity κ are not available. Six users per scope bound every rate (see the Wilson intervals). The proxy blocks svg/script/style nodes from replay so the first upload fits the local capture limit; replay frames lack icons. Revisits use full page loads (typed URL), not in-app links.
