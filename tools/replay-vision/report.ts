// Writes out/<run>/report.md from the pipeline output and the scores. Numbers only come from those two objects.
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {Captured} from './personas.ts'
import type {PipelineOutput} from './pipeline.ts'
import type {score as scoreFn,calibrationSummary} from './score.ts'
import {COHORTS,CALIBRATION_REPEATS} from './design.ts'

type F={n:number;d:number;value:number|null;ci95:[number,number]|null}
const pct=(v:F|undefined)=>!v||v.value===null?`undefined (n=0)`:`${(100*v.value).toFixed(1)}% [${(100*v.ci95![0]).toFixed(1)}, ${(100*v.ci95![1]).toFixed(1)}] (${v.n}/${v.d})`
const num=(x:number|null|undefined,d=2)=>x===null||x===undefined?'undefined':x.toFixed(d)

export interface ReportApp { title: string; design: string; workflows: string[]; done(c: Captured): boolean; note?: string }
export async function writeReport(out:string,captures:Captured[],p:PipelineOutput,h:ReturnType<typeof scoreFn>,cal:ReturnType<typeof calibrationSummary>,run:{evaluate_ms:number;peak_rss_mib:number},app?:ReportApp){
 const sessions=Object.values(p.sessions),bytes=sessions.map(s=>s.bytes).sort((a,b)=>a-b)
 const q=(f:number)=>bytes[Math.min(bytes.length-1,Math.max(0,Math.ceil(f*bytes.length)-1))]??0
 const erpDone=(c:Captured)=>c.plan.workflow==='report'?c.steps.some(s=>s.name==='report_filters_applied'&&s.ok):c.plan.injection==='abandon'||c.plan.abandon_after?c.steps.some(s=>s.name==='line_item_entered'&&s.ok):c.steps.some(s=>s.name==='submitted'&&s.ok)
 const done=app?app.done:erpDone
 const wf=(phase:string,w:string,inj:boolean)=>{const xs=captures.filter(c=>c.plan.phase===phase&&c.plan.workflow===w&&!!c.plan.injection===inj);return `${xs.filter(done).length}/${xs.length}`}
 const browserS=Math.round(captures.reduce((s,x)=>s+Math.max(0,Date.parse(x.ended_at)-Date.parse(x.started_at)),0)/1000)
 const det=Object.entries(h.per_detector).filter(([,v])=>v.tp+v.fp+v.fn>0).map(([k,v])=>`| ${k} | ${v.tp} | ${v.fp} | ${v.fp_on_controls} | ${v.fn} | ${pct(v.precision)} | ${pct(v.recall)} |`).join('\n')
 const inj=Object.entries(h.per_injection).map(([k,v])=>`| ${k} | ${v.tp} | ${v.fn} | ${pct(v.recall)} |`).join('\n')
 const m=h.severity.matrix as Record<string,Record<string,number>>
 const sevRows=['Low','Medium','High'].map(a=>`| ${a} | ${m[a].None} | ${m[a].Low} | ${m[a].Medium} | ${m[a].High} |`).join('\n')
 const cohortRows=h.severity.cohorts.map(s=>{const hit=h.insight.per_cohort.find(x=>x.cohort===s.cohort);return `| ${s.cohort} | ${s.users} | ${s.planned} | ${s.predicted} | ${s.insight_users??'–'} | ${hit?.rank??'–'} | ${(s.reason??'no insight published').replace(/\|/g,'/')} |`}).join('\n')
 const examples=Object.entries(p.scopes).flatMap(([scope,s])=>s.insights.map(x=>({scope,x}))).filter(({scope})=>scope!=='controls')
 const seen=new Set<string>(),picked:typeof examples=[]
 for(const e of examples.sort((a,b)=>['High','Medium','Low'].indexOf(a.x.severity)-['High','Medium','Low'].indexOf(b.x.severity)||b.x.users_affected-a.x.users_affected)){const k=e.x.family+'|'+e.x.screen;if(seen.has(k))continue;seen.add(k);picked.push(e);if(picked.length===10)break}
 const misses=Object.entries(h.per_injection).flatMap(([k,v])=>v.missed.map(x=>`- ${k} ${x.id} (${x.session_id}, window ${x.window_s[0]}–${x.window_s[1]} s): pipeline found ${x.found_on_session.join(', ')||'nothing'}`)).join('\n')
 const designDefault=`## Design

- Calibration: ${CALIBRATION_REPEATS} clean repeats × 6 personas (Expert, Novice, Hurried, Careful, Explorer, Returning; users rv.cal.0–5) × 3 workflows (Sales Invoice create→Save→Submit, Purchase Order create→Save→Submit, Accounts Receivable report filter + inspect) = ${cal.sessions} sessions. Baselines are recomputed from these alone (product \`recomputeBaselines\`). Calibrated screens (≥20 sessions, ≥5 users): ${cal.calibrated_screens.join(', ')||'none'}.
- Held-out controls: 6 users (rv.eval.0–5) × 3 workflows, no injection (18 sessions).
- Held-out injected cohorts: ${COHORTS.length} cohorts, ${COHORTS.reduce((a,k)=>a+k.users,0)} sessions. Dose = distinct affected users (1/3/6) for I2 validation loop, I5 inert Apply, I6 scroll hunt, I7 Customer↔Invoice revisits; I2 with abandonment; I3 save waits of 2/6/15 s; I1 relabelled field with 3–9 s hesitation; R2 re-open; D5 abandonment. Each cohort is scored in its own scope (cohort + the 18 controls), as one client would be in the product.
- Pipeline: product code only (\`analyzeFile → storeFindings → runMetrics → recomputeBaselines (calibration only) → refreshInsights\`), see \`pipeline.ts\`. No LLM call; provider calls and spend: 0 / $0.

`
 const text=`# Replay Vision — ${app?.title??'ERPNext v16'} evaluation report

Generated ${new Date().toISOString()} by \`tools/replay-vision/${app?'run-reval.ts':'run.ts'}\`. Frozen config hash (detectors + severity + calibration baselines) \`${p.frozen.hash}\`, baseline hash \`${p.frozen.baseline_hash}\`, detectors \`${p.frozen.detectors_version}\`, severity \`${p.frozen.severity_version}\`. The hash was written to \`frozen-config.json\` after calibration and before any held-out session was analysed. Calibration and held-out sessions have disjoint seeds and session ids. Held-out results are the headline; calibration is reported separately.

${app?app.design:designDefault}## Coverage and cost

- ${sessions.length} sessions analysed (${h.coverage.complete} held-out complete, ${h.coverage.partial} held-out partial; calibration ${cal.complete}/${cal.sessions} complete). A session without rrweb Meta + FullSnapshot is marked partial/missing_snapshot by the analysis.
- Snapshot JSONL from PostHog's public API: total ${(bytes.reduce((a,b)=>a+b,0)/1048576).toFixed(1)} MiB, median ${(q(.5)/1024).toFixed(0)} KiB, p95 ${(q(.95)/1024).toFixed(0)} KiB, max ${((bytes.at(-1)??0)/1024).toFixed(0)} KiB.
- Browser time ${browserS} s for ${captures.length} sessions; evaluation (download cache + analysis + insights + scoring) ${(run.evaluate_ms/1000).toFixed(0)} s; peak RSS ${run.peak_rss_mib} MiB.

| Workflow | Calibration done | Held-out controls done | Held-out injected done |
| --- | ---: | ---: | ---: |
${(app?.workflows??['invoice','purchase','report']).map(w=>`| ${w} | ${wf('calibration',w,false)} | ${wf('heldout',w,false)} | ${wf('heldout',w,true)} |`).join('\n')}

(Injected abandonment sessions count as done when the line item was entered; they never save by design.)

## Held-out moment detection (headline)

${h.n_truth} delivered ground-truth moments (${h.undelivered.length} planned injections were not delivered and are excluded: ${h.undelivered.map(u=>u.kind+'#'+u.seed).join(', ')||'none'}). ${h.n_hits} pipeline findings on ${h.n_analysed} held-out sessions.

- Recall, all compatible detectors: **${pct(h.recall)}**
- Precision, all findings incl. diagnostics and natural behaviour: ${pct(h.precision)}
- Precision of strong/medium findings: ${pct(h.sm_precision)}; on injected sessions only: ${pct(h.sm_precision_injected_sessions)}
- Moment-level precision (a finding is correct when it overlaps a compatible planted moment, so co-firing S1/S2/S3 or R1/R2 on one moment all count): all ${pct(h.precision_moment_level)}; strong/medium ${pct(h.sm_precision_moment_level)}
- Element agreement among matched moments: ${pct(h.matched_element_agreement)}

Strict precision (one finding per moment) counts every other finding as a false positive, including co-firing compatible detectors and real behaviour the script did not plant, so it is a lower bound.

| Detector | TP | FP | FP on controls | FN | Precision, Wilson 95% | Recall, Wilson 95% |
| --- | ---: | ---: | ---: | ---: | --- | --- |
${det}

| Injection | TP | FN | Recall, Wilson 95% |
| --- | ---: | ---: | --- |
${inj}

### Controls (false positives)

Control sessions with any finding: ${pct(h.controls.with_any_finding)}; with a strong/medium finding: ${pct(h.controls.with_sm_finding)}; with a strong/medium finding other than D14: ${pct(h.controls.with_non_d14_sm_finding)}. Finding kinds on controls: ${Object.entries(h.controls.finding_kinds).map(([k,v])=>`${k}×${v}`).join(', ')||'none'}. Published insights in the controls-only scope: ${h.controls.published_insights.length}.
${h.controls.published_insights.map(x=>`- ${x.text}`).join('\n')}

## Severity (per cohort, product rule vs planned rule)

Quadratic-weighted κ, 4 levels with "None" (no insight published): ${num(h.severity.quadratic_weighted_kappa_4level)}; among cohorts with an insight: ${num(h.severity.quadratic_weighted_kappa_detected_only)}. Spearman ρ dose (users) vs severity over the I2/I5/I6/I7 dose series: ${num(h.severity.dose_spearman)}. Inversions: ${h.severity.series.map(s=>`${s.series} ${s.levels.join(' → ')} (${s.inversions})`).join('; ')}.

| Planned \\ Predicted | None | Low | Medium | High |
| --- | ---: | ---: | ---: | ---: |
${sevRows}

| Cohort | Users | Planned | Predicted | Insight U | Rank of matching insight | Product severity reason |
| --- | ---: | --- | --- | ---: | ---: | --- |
${cohortRows}

Negative dose control (2 s wait, below the D10 floor): ${h.severity.negative_dose_controls.map(x=>`${x.cohort}: ${x.d10_hits} D10 findings, insight ${x.insight?x.insight.severity+' U='+x.insight.users:'none'}`).join('; ')}.

## Insights

Published (validated) insights across all scopes: ${h.insight.published}. hit@3 ${pct(h.insight.hit_at_3)}, hit@10 ${pct(h.insight.hit_at_10)} (correct screen, accepted element, compatible detector, user count ±1, rubric ≥14). Mean rubric ${num(h.insight.mean_rubric,1)}/18. Generic insights: ${h.insight.generic}. Citations ${h.insight.citations}, hallucinated (not traceable to a stored candidate of a session in scope at that offset and event id): ${h.insight.hallucinated_citations}.

### Example insights (exact product text, one per family and screen)

${picked.map(({scope,x})=>`- **${scope}** — ${x.text}`).join('\n')||'None.'}

## Misses

${misses||'None.'}

## Calibration (separate, not a headline)

${cal.sessions} clean sessions, no planted moments. Findings: ${Object.entries(cal.finding_kinds).map(([k,v])=>`${k}×${v}`).join(', ')||'none'}. Sessions with a strong/medium finding other than D14: ${pct(cal.sessions_with_non_d14_sm_finding)}.

## Limits

Scripted personas, not people: recall concerns planted behaviour, and precision on controls counts unplanted real behaviour as false positives. Natural friction was not labelled by blind human reviewers, so natural-friction precision and human severity κ are not available. Six users per scope bound every rate (see the Wilson intervals). The proxy blocks svg/script/style nodes from replay so the first upload fits the local capture limit; replay frames lack icons. Revisits use full page loads (typed URL), not in-app links.
`
 await writeFile(join(out,'report.md'),text)
}
