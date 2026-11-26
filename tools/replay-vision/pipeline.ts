// Runs the PRODUCT pipeline (src/core, src/service) over captured ERPNext sessions in an isolated SQLite file.
// Nothing here re-implements a detector, a baseline, severity or an insight: it calls the same functions the
// Monitor's processRun()/refreshInsights() call, in the same order:
//   analyzeFile() -> queueReplayVision() -> storeFindings() -> rv_run complete + runMetrics() -> recomputeBaselines()
//   -> refreshInsights(scope).
// Protocol (architecture "ERPNext v16 final evaluation"):
//   1. Calibration sessions are analysed cold (empty detector context), stored under client "calibration", and the
//      30-day baselines are recomputed from them alone. Detector, severity and baseline config are hashed and written
//      to frozen-config.json BEFORE any held-out session is analysed.
//   2. Held-out sessions are analysed with the frozen baselineContext() (population dwell medians / page extents).
//      Baselines are never recomputed from held-out sessions.
//   3. Each evaluation scope = the 18 held-out control sessions (6 users x 3 workflows) plus one injected cohort
//      (1, 3 or 6 affected users), inserted under client "scope", refreshInsights({client:"scope"}) is called and the
//      cohort's runs are deleted again. The controls-only scope measures insight-level false positives.
// Screen reach N for a scope = distinct users whose analysed sessions in that scope reached the screen
// (source "evaluation_sessions"); the product's HogQL reach is not used because other projects' traffic would leak in.
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,rmSync,writeFileSync,statSync} from 'node:fs'
import {join} from 'node:path'
import type {Captured} from './personas.ts'

export interface ScopeDef {id:string;seeds:number[]}
export interface PipelineSession {session_id:string;seed:number;phase:string;user:string;bytes:number;start_time:string;end_time:string;analysis:{coverage:any;candidates:any[];screens:string[];events:number}}
export interface PipelineInsight {id:string;family:string;signal:string;severity:string;severity_reason:string;screen:string;element:string;users_affected:number;users_reached:number|null;sessions_affected:number;calibrated:boolean;abandoned_users:number;time_lost_ms:number;rubric:{valid:boolean;score:number;criteria:Record<string,number>;reasons:string[]};text:string;citations:any[];members:{session_id:string;kind:string;start_ms:number;end_ms:number;event_ids:string[]}[]}
export interface PipelineOutput {frozen:{hash:string;baseline_hash:string;detectors_version:string;severity_version:string;calibration_sessions:number;calibrated_screens:string[]};sessions:Record<string,PipelineSession>;scopes:Record<string,{sessions:string[];insights:PipelineInsight[]}>}

/** llmPass1: also write B' exchange request files (exact Messages API bodies) for every cohort-scope insight and a manifest,
 * then stop: pass 2 (offlineCollect) runs only when responses exist. Nothing is sent anywhere by this code. */
export async function runPipeline(out:string,captures:Captured[],scopes:ScopeDef[],controlSeeds:number[],llmPass1=false,cacheDir?:string,opts:{freezeOnly?:boolean;expectHash?:string}={}):Promise<PipelineOutput>{
 const dbFile=join(out,'pipeline.db');for(const f of [dbFile,dbFile+'-wal',dbFile+'-shm'])rmSync(f,{force:true})
 process.env.TRIAGE_DB=dbFile
 const cache=cacheDir??join(out,'snapshots');mkdirSync(cache,{recursive:true})
 const {getRecording,getSnapshotsJsonl}=await import('../../src/core/posthog.ts')
 const {analyzeFile,replayAppEvents}=await import('../../src/core/replay-vision.ts')
 const {queueReplayVision}=await import('../../src/service/replayvision-worker.ts')
 const {storeFindings,refreshInsights}=await import('../../src/core/replay-vision-insights.ts')
 const {runMetrics,recomputeBaselines,loadBaselines,baselineContext,isCalibrated}=await import('../../src/core/replay-vision-baseline.ts')
 const {DETECTOR_CONFIG}=await import('../../src/core/replay-vision-detectors.ts')
 const {SEVERITY_CONFIG}=await import('../../src/core/replay-vision-severity.ts')
 const {run,all}=await import('../../src/core/db.ts')
 const {offlineRequests}=await import('../../src/core/replay-vision-llm.ts')
 const {ExchangeProvider}=await import('../../src/core/replay-vision-provider.ts')
 const {randomBytes}=await import('node:crypto')
 const exchangeDir=join(out,'llm-exchange'),exchange=new ExchangeProvider(exchangeDir,0),salt=randomBytes(16).toString('hex'),manifest:any[]=[]
 if(llmPass1)rmSync(exchangeDir,{recursive:true,force:true})
 const sessions:Record<string,PipelineSession>={}
 const meta=new Map<string,{start_time:string;end_time:string;app_events:any[]}>()
 async function fetchOne(sid:string){
  const file=join(cache,`${sid}.jsonl`)
  if(!existsSync(file)||statSync(file).size===0)await getSnapshotsJsonl(sid,file)
  if(!meta.has(sid)){const m=await getRecording(sid);meta.set(sid,{start_time:m.start_time,end_time:m.end_time,app_events:await replayAppEvents(sid)})}
  return file
 }
 const byPhase=(phase:string)=>captures.filter(c=>c.plan.phase===phase&&c.session_id)
 async function analyse(c:Captured,ctx:any){
  const sid=c.session_id!,file=await fetchOne(sid),m=meta.get(sid)!
  const a=await analyzeFile(file,{start_time:m.start_time,app_events:m.app_events},60_000,ctx)
  sessions[sid]={session_id:sid,seed:c.plan.seed,phase:c.plan.phase,user:c.plan.user,bytes:statSync(file).size,start_time:m.start_time,end_time:m.end_time,analysis:{coverage:a.coverage,candidates:a.candidates,screens:a.screens,events:a.events}}
  return a
 }
 function store(c:Captured,a:any,client:string):number{
  const sid=c.session_id!,m=meta.get(sid)!
  const id=queueReplayVision(sid,m.end_time,client,c.plan.user,[],'evaluation')
  storeFindings(id,sid,a.candidates)
  const state=a.coverage.state==='complete'?'complete':'partial'
  run(`UPDATE rv_run SET state = ?, completed_at = ?, coverage_json = ?, metrics_json = ? WHERE id = ?`,state,new Date().toISOString(),JSON.stringify({...a.coverage,run_state:state}),JSON.stringify(runMetrics(a.screens,a.candidates,a.events,sessions[sid].bytes,a.metrics)),id)
  return id
 }
 // 1. Calibration, cold.
 const cal=byPhase('calibration')
 for(const c of cal){const a=await analyse(c,{});if(a.coverage.state!=='complete'&&a.coverage.state!=='partial')continue;store(c,a,'calibration')}
 recomputeBaselines(undefined,new Date())
 const baselines=loadBaselines()
 const baselineJson=JSON.stringify([...baselines].sort(([a],[b])=>a.localeCompare(b)))
 const calibratedScreens=[...new Set([...baselines].filter(([k,b])=>k.startsWith('DWELL|')&&isCalibrated(b)).map(([k])=>k.split('|')[1]))].sort()
 const frozen={hash:createHash('sha256').update(JSON.stringify({DETECTOR_CONFIG,SEVERITY_CONFIG})+baselineJson).digest('hex'),baseline_hash:createHash('sha256').update(baselineJson).digest('hex'),detectors_version:DETECTOR_CONFIG.version,severity_version:SEVERITY_CONFIG.version,calibration_sessions:cal.length,calibrated_screens:calibratedScreens}
 if(opts.expectHash&&opts.expectHash!==frozen.hash)throw new Error(`frozen config mismatch: pre-registered ${opts.expectHash}, recomputed ${frozen.hash}`)
 if(!opts.expectHash)writeFileSync(join(out,'frozen-config.json'),JSON.stringify({...frozen,at:new Date().toISOString(),detectors:DETECTOR_CONFIG,severity:SEVERITY_CONFIG},null,2))
 if(opts.freezeOnly){writeFileSync(join(out,'calibration-baselines.json'),JSON.stringify(Object.fromEntries(baselines),null,1));return {frozen,sessions,scopes:{}}}
 writeFileSync(join(out,'calibration-baselines.json'),JSON.stringify(Object.fromEntries(baselines),null,1))
 // 2. Held-out, with the frozen context only.
 const ctx=baselineContext(baselines)
 const held=byPhase('heldout'),analyses=new Map<string,any>()
 for(const c of held)analyses.set(c.session_id!,await analyse(c,ctx))
 // 3. Scopes.
 const bySeed=new Map(held.map(c=>[c.plan.seed,c]))
 const controls=controlSeeds.map(s=>bySeed.get(s)).filter((c):c is Captured=>!!c)
 for(const c of controls)store(c,analyses.get(c.session_id!),'scope')
 const result:PipelineOutput['scopes']={}
 const scopeRuns=(ids:number[])=>ids
 for(const s of [{id:'controls',seeds:[]},...scopes]){
  const members=s.seeds.map(x=>bySeed.get(x)).filter((c):c is Captured=>!!c)
  const ids=scopeRuns(members.map(c=>store(c,analyses.get(c.session_id!),'scope')))
  const inScope=[...controls,...members]
  const reach=new Map<string,{users:number;source:string}>(),users=new Map<string,Set<string>>()
  for(const c of inScope)for(const screen of sessions[c.session_id!].analysis.screens){const u=users.get(screen)||new Set<string>();u.add(c.plan.user);users.set(screen,u)}
  for(const [screen,u] of users)reach.set(screen,{users:u.size,source:'evaluation_sessions'})
  const r=refreshInsights({client:'scope'},{reach})
  if(llmPass1&&s.id!=='controls'){
   // Insight ids are per scope key + family/screen/element, so the same id recurs across cohort scopes with different members: request each.
   const fresh=r.insights
   const windowsFor=async(sid:string,offsets:number[])=>{const m=meta.get(sid)!;const w=await analyzeFile(join(cache,`${sid}.jsonl`),{start_time:m.start_time,app_events:m.app_events},60_000,ctx,offsets);return w.windows??[]}
   for(const x of await offlineRequests(fresh,windowsFor,exchange,salt,10))manifest.push({...x,scope:s.id})
  }
  result[s.id]={sessions:inScope.map(c=>c.session_id!),insights:r.insights.map(x=>({id:x.id,family:x.family,signal:x.signal,severity:x.draft.severity,severity_reason:x.severity_reason,screen:x.draft.screen,element:x.draft.element,users_affected:x.draft.users_affected,users_reached:x.draft.users_reached,sessions_affected:x.draft.sessions_affected,calibrated:x.calibrated,abandoned_users:x.abandoned_users,time_lost_ms:x.draft.time_lost_ms,rubric:x.rubric,text:x.text,citations:x.draft.citations,members:x.members.map(m=>({session_id:m.session_id,kind:m.candidate.kind,start_ms:m.candidate.start_ms,end_ms:m.candidate.end_ms,event_ids:m.candidate.event_ids}))}))}
  if(ids.length){run(`DELETE FROM rv_finding WHERE run_id IN (${ids.map(()=>'?').join(',')})`,...ids);run(`DELETE FROM rv_run WHERE id IN (${ids.map(()=>'?').join(',')})`,...ids)}
  console.log(JSON.stringify({scope:s.id,sessions:inScope.length,insights:result[s.id].insights.length}))
 }
 const leftover=all<{n:number}>(`SELECT count(*) AS n FROM rv_run WHERE client_id = 'scope'`)[0]?.n
 if(leftover!==controls.length)throw new Error(`scope cleanup failed: ${leftover} runs`)
 if(llmPass1){mkdirSync(exchangeDir,{recursive:true});writeFileSync(join(exchangeDir,'manifest.json'),JSON.stringify(manifest,null,1))}
 return {frozen,sessions,scopes:result}
}
