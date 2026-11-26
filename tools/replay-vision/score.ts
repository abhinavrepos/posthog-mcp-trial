// Scoring of the product pipeline's output against independent ground truth (architecture "ERPNext v16 final
// evaluation"). Ground truth comes only from the driver/proxy (personas.ts, injections.ts); this file never looks at
// a candidate to decide what the truth is. All findings and insights come from pipeline.ts (product code).
import type {Captured,Severity} from './personas.ts'
import type {PipelineOutput,PipelineInsight} from './pipeline.ts'
import type {Cohort} from './design.ts'
import {screenKey} from '../../src/core/replay-timeline.ts'
import {wilsonLower} from '../../src/core/replay-vision-severity.ts'
import {GENERIC} from '../../src/core/replay-vision-validator.ts'

export interface Hit {id:string;session_id:string;kind:string;screen:string;element:string;start_ms:number;end_ms:number;strength:string}
export interface Label {id:string;session_id:string;kind:string;screen:string;element:string;start_ms:number;end_ms:number;expected_detectors:string[];cohort:string|null}
/** Compatibility (architecture): I1<->D6/D8/D12, I2<->D4/D7, I3<->D10, I5<->D2/D1, I6<->S1/S2/S3, I7<->R1/R2; R2 re-open<->R2; abandonment<->D5. */
export const COMPATIBLE:Record<string,string[]>={validation_loop:['D4','D7'],dead_button:['D1','D2'],hesitation:['D6','D8','D12'],revisit:['R1','R2'],reopen:['R2'],scroll_hunt:['S1','S2','S3'],slow_wait:['D10'],abandon:['D5']}
/** Element names a correct insight may use, fixed before any result was read ('*' = element not required, kind must match). */
export const ACCEPTED_ELEMENTS:Record<string,string[]>={validation_loop:['save','debit to'],dead_button:['apply'],hesitation:['effective value date','due date'],revisit:['*'],reopen:['*'],scroll_hunt:['*'],slow_wait:['save'],abandon:['*']}
export const WINDOW_MS=5000

export function wilsonInterval(success:number,total:number):[number,number]|null{return total>0?[wilsonLower(success,total),1-wilsonLower(total-success,total)]:null}
export const fraction=(n:number,d:number)=>({n,d,value:d?n/d:null,ci95:wilsonInterval(n,d)})
/** Greedy one-to-one matching: same session, same screen, compatible detector, overlap with [t_start-5 s, t_end+5 s]. */
export function oneToOne(truth:Label[],hits:Hit[]){
 const eligible:{truth:number;hit:number;overlap:number}[]=[]
 for(let i=0;i<truth.length;i++)for(let j=0;j<hits.length;j++){
  const a=truth[i],b=hits[j]
  if(a.session_id!==b.session_id||a.screen!==b.screen||!a.expected_detectors.includes(b.kind))continue
  const overlap=Math.min(a.end_ms+WINDOW_MS,b.end_ms)-Math.max(a.start_ms-WINDOW_MS,b.start_ms)
  if(overlap>=0)eligible.push({truth:i,hit:j,overlap})
 }
 eligible.sort((a,b)=>b.overlap-a.overlap||truth[a.truth].id.localeCompare(truth[b.truth].id)||hits[a.hit].id.localeCompare(hits[b.hit].id))
 const usedTruth=new Set<number>(),usedHit=new Set<number>(),matched:typeof eligible=[]
 for(const pair of eligible)if(!usedTruth.has(pair.truth)&&!usedHit.has(pair.hit)){usedTruth.add(pair.truth);usedHit.add(pair.hit);matched.push(pair)}
 return {matched,usedTruth,usedHit}
}
export const LEVELS=['None','Low','Medium','High'] as const
export type Level=typeof LEVELS[number]
export function weightedKappa(pairs:[string,string][],levels:readonly string[]=LEVELS):number|null{
 if(pairs.length<2)return null
 const k=levels.length,idx=(x:string)=>levels.indexOf(x),m:number[][]=Array.from({length:k},()=>Array(k).fill(0))
 for(const [a,b] of pairs)m[idx(a)][idx(b)]++
 const n=pairs.length,row=m.map(x=>x.reduce((a,b)=>a+b,0)),col=m[0].map((_,j)=>m.reduce((s,x)=>s+x[j],0))
 let observed=0,expected=0
 for(let i=0;i<k;i++)for(let j=0;j<k;j++){const w=(i-j)**2/(k-1)**2;observed+=w*m[i][j]/n;expected+=w*row[i]*col[j]/(n*n)}
 return expected?1-observed/expected:null
}
export function spearman(pairs:[number,number][]):number|null{
 if(pairs.length<3)return null
 const rank=(v:number[])=>v.map(x=>{const sorted=[...v].sort((a,b)=>a-b),first=sorted.indexOf(x),last=sorted.lastIndexOf(x);return (first+last)/2+1})
 const x=rank(pairs.map(p=>p[0])),y=rank(pairs.map(p=>p[1])),mx=x.reduce((a,b)=>a+b,0)/x.length,my=y.reduce((a,b)=>a+b,0)/y.length
 const cov=x.reduce((s,v,i)=>s+(v-mx)*(y[i]-my),0),vx=x.reduce((s,v)=>s+(v-mx)**2,0),vy=y.reduce((s,v)=>s+(v-my)**2,0)
 return vx&&vy?cov/Math.sqrt(vx*vy):null
}
/** The cohort's insight: compatible detector among its members, the injection's screen, members from the cohort's sessions. */
export function cohortInsight(insights:PipelineInsight[],injection:string,screen:string,sessions:Set<string>):PipelineInsight|undefined{
 return insights.filter(x=>x.screen===screen&&x.members.some(m=>sessions.has(m.session_id)&&COMPATIBLE[injection].includes(m.kind))).sort((a,b)=>b.users_affected-a.users_affected||LEVELS.indexOf(b.severity as Level)-LEVELS.indexOf(a.severity as Level))[0]
}
export function insightMatches(x:PipelineInsight,injection:string,screen:string,users:number){
 const ok=ACCEPTED_ELEMENTS[injection]
 return x.screen===screen&&(ok.includes('*')||ok.includes(x.element.toLowerCase()))&&x.members.some(m=>COMPATIBLE[injection].includes(m.kind))&&Math.abs(x.users_affected-users)<=1&&x.rubric.score>=14
}
/** Screen the injection happens on (the truth label's screen when one was delivered). */
function injectionScreen(k:Cohort,labels:Label[]):string{
 return labels.find(l=>l.cohort===k.id)?.screen??(k.injection==='scroll_hunt'?'item:list':k.workflow==='purchase'?'purchase order:new':k.workflow==='report'?'accounts receivable:report':'sales invoice:new')
}

/** Screen where the injected moment happened. The driver records the screen when it writes the label; for I3 that is
 * after the delayed Save has navigated to the saved record, so the start screen is used. Captures made before
 * screen_start existed (2026-11-26 run) clicked Save on the new form by construction, so doctype:form maps to doctype:new.
 * This correction depends only on the harness, never on a pipeline finding. */
export function truthScreen(t:{kind:string;screen:string;screen_start?:string}):string{
 if(t.screen_start)return screenKey(t.screen_start)
 const k=screenKey(t.screen)
 return t.kind==='slow_wait'?k.replace(/:form$/,':new'):k
}
export function score(captured:Captured[],p:PipelineOutput,cohorts:Cohort[],controlSeeds:number[]){
 const held=captured.filter(c=>c.plan.phase==='heldout'&&c.session_id&&p.sessions[c.session_id])
 const analysed=held.filter(c=>['complete','partial'].includes(p.sessions[c.session_id!].analysis.coverage.state))
 const seedOf=new Map(held.map(c=>[c.session_id!,c.plan.seed]))
 const labels:Label[]=[],hits:Hit[]=[],undelivered:{seed:number;kind:string}[]=[]
 for(const c of analysed){
  const s=p.sessions[c.session_id!],start=Date.parse(s.start_time)
  for(const t of c.truth){
   if(!t.observed){undelivered.push({seed:c.plan.seed,kind:t.kind});continue}
   if(!t.expected_detectors.length)continue
   labels.push({id:t.id,session_id:c.session_id!,kind:t.kind,screen:truthScreen(t),element:t.element,start_ms:t.t_start-start,end_ms:t.t_end-start,expected_detectors:COMPATIBLE[t.kind],cohort:c.plan.cohort??null})
  }
  s.analysis.candidates.forEach((x:any,i:number)=>hits.push({id:`${c.session_id}:${i}`,session_id:c.session_id!,kind:x.kind,screen:x.screen,element:x.element,start_ms:x.start_ms,end_ms:x.end_ms,strength:x.strength}))
 }
 const match=oneToOne(labels,hits),tp=match.matched.length
 // Many-to-one: a finding is correct when it overlaps a compatible ground-truth moment (co-firing S1/S2/S3 or R1/R2 on one moment all count).
 const compatibleHit=(h:Hit)=>labels.some(l=>l.session_id===h.session_id&&l.screen===h.screen&&l.expected_detectors.includes(h.kind)&&Math.min(l.end_ms+WINDOW_MS,h.end_ms)-Math.max(l.start_ms-WINDOW_MS,h.start_ms)>=0)
 const sm=hits.flatMap((h,i)=>h.strength!=='weak'?[i]:[])
 const injectedSessions=new Set(analysed.filter(c=>c.plan.injection).map(c=>c.session_id))
 const detectors=[...new Set([...hits.map(h=>h.kind),...Object.values(COMPATIBLE).flat()])].sort()
 const per_detector=Object.fromEntries(detectors.map(kind=>{
  const h=hits.filter(x=>x.kind===kind),t=labels.filter(x=>x.expected_detectors.includes(kind)),m=oneToOne(t,h).matched.length
  const onControls=h.filter(x=>controlSeeds.includes(seedOf.get(x.session_id)!)).length
  return [kind,{tp:m,fp:h.length-m,fn:t.length-m,fp_on_controls:onControls,precision:fraction(m,h.length),recall:fraction(m,t.length)}]
 }))
 const per_injection=Object.fromEntries(Object.keys(COMPATIBLE).map(kind=>{
  const idx=labels.flatMap((x,i)=>x.kind===kind?[i]:[]),n=idx.filter(i=>match.usedTruth.has(i)).length
  const missed=idx.filter(i=>!match.usedTruth.has(i)).map(i=>{const l=labels[i];return {id:l.id,session_id:l.session_id,window_s:[Math.round(l.start_ms/100)/10,Math.round(l.end_ms/100)/10],found_on_session:hits.filter(h=>h.session_id===l.session_id).map(h=>`${h.kind}@${h.screen}:${Math.round(h.start_ms/100)/10}s`)}})
  return [kind,{tp:n,fn:idx.length-n,recall:fraction(n,idx.length),missed}]
 }))
 const controls=analysed.filter(c=>controlSeeds.includes(c.plan.seed))
 const ctlHits=(pred:(h:Hit)=>boolean)=>controls.filter(c=>hits.some(h=>h.session_id===c.session_id&&pred(h))).length
 const controlKinds:Record<string,number>={};for(const h of hits)if(controls.some(c=>c.session_id===h.session_id))controlKinds[h.kind]=(controlKinds[h.kind]||0)+1
 // Severity and insight retrieval per cohort scope.
 const severity:{cohort:string;users:number;planned:Severity;predicted:Level;reason:string|null;insight_users:number|null;calibrated:boolean|null;text:string|null}[]=[]
 const insight_hits:{cohort:string;rank:number|null;hit3:boolean;hit10:boolean}[]=[]
 for(const k of cohorts){
  const scope=p.scopes[k.id];if(!scope||!k.planned)continue
  const sessions=new Set(held.filter(c=>c.plan.cohort===k.id).map(c=>c.session_id!)),screen=injectionScreen(k,labels)
  const x=cohortInsight(scope.insights,k.injection,screen,sessions)
  severity.push({cohort:k.id,users:k.users,planned:k.planned,predicted:(x?.severity as Level)??'None',reason:x?.severity_reason??null,insight_users:x?.users_affected??null,calibrated:x?.calibrated??null,text:x?.text??null})
  const rank=scope.insights.findIndex(y=>insightMatches(y,k.injection,screen,k.users))
  insight_hits.push({cohort:k.id,rank:rank<0?null:rank+1,hit3:rank>=0&&rank<3,hit10:rank>=0&&rank<10})
 }
 const negative=cohorts.filter(k=>!k.planned).map(k=>{const sessions=new Set(held.filter(c=>c.plan.cohort===k.id).map(c=>c.session_id!));const x=cohortInsight(p.scopes[k.id]?.insights??[],k.injection,injectionScreen(k,labels),sessions);return {cohort:k.id,insight:x?{severity:x.severity,users:x.users_affected}:null,d10_hits:hits.filter(h=>sessions.has(h.session_id)&&h.kind==='D10').length}})
 const matrix=Object.fromEntries(['Low','Medium','High'].map(a=>[a,Object.fromEntries(LEVELS.map(b=>[b,severity.filter(s=>s.planned===a&&s.predicted===b).length]))]))
 const series=['I2-validation','I5-dead-apply','I6-scroll-hunt','I7-revisit'].map(prefix=>{const rows=severity.filter(s=>new RegExp(`^${prefix}-u\\d$`).test(s.cohort)).sort((a,b)=>a.users-b.users);let inversions=0;for(let i=1;i<rows.length;i++)if(LEVELS.indexOf(rows[i].predicted)<LEVELS.indexOf(rows[i-1].predicted))inversions++;return {series:prefix,levels:rows.map(r=>`${r.users}u:${r.predicted}`),inversions}})
 const dosePairs:[number,number][]=severity.filter(s=>/^(I2-validation|I5-dead-apply|I6-scroll-hunt|I7-revisit)-u\d$/.test(s.cohort)).map(s=>[s.users,LEVELS.indexOf(s.predicted)])
 // Insight quality across every scope (aggregateInsights returns only validated insights, i.e. what would be published).
 const allInsights=Object.entries(p.scopes).flatMap(([id,s])=>s.insights.map(x=>({scope:id,x,sessions:new Set(s.sessions)})))
 let citations=0,hallucinated=0
 for(const {x,sessions} of allInsights)for(const c of x.citations){citations++
  const s=p.sessions[c.session_id],dur=s?Date.parse(s.end_time)-Date.parse(s.start_time):0
  const grounded=!!s&&sessions.has(c.session_id)&&c.offset_ms>=0&&c.offset_ms<=dur+1000&&s.analysis.candidates.some((k:any)=>k.start_ms===c.offset_ms&&k.event_ids.includes(c.event_ids[0])&&(!c.signal||k.kind===c.signal))&&c.url.includes(c.session_id)
  if(!grounded)hallucinated++}
 const rubricScores=allInsights.map(({x})=>x.rubric.score)
 return {
  n_heldout_sessions:held.length,n_analysed:analysed.length,coverage:Object.fromEntries(['complete','partial'].map(k=>[k,held.filter(c=>p.sessions[c.session_id!].analysis.coverage.state===k).length])),
  n_truth:labels.length,undelivered,n_hits:hits.length,tp,fp:hits.length-tp,fn:labels.length-tp,
  precision:fraction(tp,hits.length),recall:fraction(tp,labels.length),
  precision_moment_level:fraction(hits.filter(compatibleHit).length,hits.length),sm_precision_moment_level:fraction(hits.filter(h=>h.strength!=='weak'&&compatibleHit(h)).length,hits.filter(h=>h.strength!=='weak').length),
  sm_precision:fraction(sm.filter(i=>match.usedHit.has(i)).length,sm.length),
  sm_precision_injected_sessions:(()=>{const idx=sm.filter(i=>injectedSessions.has(hits[i].session_id));return fraction(idx.filter(i=>match.usedHit.has(i)).length,idx.length)})(),
  matched_element_agreement:fraction(match.matched.filter(m=>ACCEPTED_ELEMENTS[labels[m.truth].kind].some(e=>e==='*'||e===hits[m.hit].element.toLowerCase())).length,tp),
  per_detector,per_injection,
  controls:{sessions:controls.length,with_any_finding:fraction(ctlHits(()=>true),controls.length),with_sm_finding:fraction(ctlHits(h=>h.strength!=='weak'),controls.length),with_non_d14_sm_finding:fraction(ctlHits(h=>h.strength!=='weak'&&h.kind!=='D14'),controls.length),finding_kinds:controlKinds,published_insights:p.scopes.controls?.insights.map(x=>({severity:x.severity,users:x.users_affected,text:x.text}))??[]},
  severity:{cohorts:severity,negative_dose_controls:negative,matrix,quadratic_weighted_kappa_4level:weightedKappa(severity.map(s=>[s.planned,s.predicted])),quadratic_weighted_kappa_detected_only:weightedKappa(severity.filter(s=>s.predicted!=='None').map(s=>[s.planned,s.predicted]),['Low','Medium','High']),dose_spearman:spearman(dosePairs),series},
  insight:{published:allInsights.length,hit_at_3:fraction(insight_hits.filter(h=>h.hit3).length,insight_hits.length),hit_at_10:fraction(insight_hits.filter(h=>h.hit10).length,insight_hits.length),per_cohort:insight_hits,mean_rubric:rubricScores.length?rubricScores.reduce((a,b)=>a+b,0)/rubricScores.length:null,generic:allInsights.filter(({x})=>GENERIC.test(x.text)).length,citations,hallucinated_citations:hallucinated},
  unmatched_hits_on_injected:hits.filter((h,i)=>!match.usedHit.has(i)&&injectedSessions.has(h.session_id)).map(h=>`${h.kind}@${h.screen} ${h.element} ${Math.round(h.start_ms/100)/10}s`),
 }
}
export function calibrationSummary(captured:Captured[],p:PipelineOutput){
 const cal=captured.filter(c=>c.plan.phase==='calibration'&&c.session_id&&p.sessions[c.session_id])
 const kinds:Record<string,number>={};let sm=0
 for(const c of cal){const cs=p.sessions[c.session_id!].analysis.candidates;for(const x of cs)kinds[x.kind]=(kinds[x.kind]||0)+1;if(cs.some((x:any)=>x.strength!=='weak'&&x.kind!=='D14'))sm++}
 return {sessions:cal.length,complete:cal.filter(c=>p.sessions[c.session_id!].analysis.coverage.state==='complete').length,finding_kinds:kinds,sessions_with_non_d14_sm_finding:fraction(sm,cal.length),calibrated_screens:p.frozen.calibrated_screens}
}
