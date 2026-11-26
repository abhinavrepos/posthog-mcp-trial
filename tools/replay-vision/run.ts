// One-command orchestration of the ERPNext v16 evaluation.
//   npx tsx tools/replay-vision/run.ts            capture what is missing (resumable by seed), then evaluate
//   npx tsx tools/replay-vision/run.ts --capture  capture only
//   npx tsx tools/replay-vision/run.ts --rescore  evaluate only (product pipeline + scoring + report), no browser
//   npx tsx tools/replay-vision/run.ts --score-only run-a-frozen-v3   re-score an archived pipeline.json
//   npx tsx tools/replay-vision/run.ts --rescore --llm-pass1   also write B' exchange request files + manifest (nothing is sent)
//   npx tsx tools/replay-vision/run.ts --smoke    one injected invoice session into out/smoke
import {spawn} from 'node:child_process'
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {dirname,join} from 'node:path'
import {checkApplication,ensureLabUsers,ensureFixtures,labConfig,recordingOptIn} from './setup.ts'
import type {Readiness} from './capture.ts'
import {drivePlan,type Captured} from './personas.ts'
import {plans as designPlans,COHORTS,CONTROL_SEEDS} from './design.ts'

const base=dirname(fileURLToPath(import.meta.url)),smoke=process.argv.includes('--smoke')||process.argv.includes('--smoke-purchase')
const out=join(base,'out',process.argv.includes('--smoke-purchase')?'smoke-purchase':smoke?'smoke':'erpnext-v2'),c=labConfig()
process.env.POSTHOG_HOST=c.host;process.env.POSTHOG_PROJECT_ID=c.projectId;process.env.POSTHOG_PERSONAL_API_KEY=c.personalKey;process.env.POSTHOG_PROJECT_TOKEN=c.token
// The injected scroll-hunt target is a lab label, added to the product's label vocabulary for this run only.
process.env.REPLAY_VISION_LABELS=[process.env.REPLAY_VISION_LABELS,'Item 190'].filter(Boolean).join(',')
const plans=()=>designPlans(process.argv.includes('--smoke-purchase')?'purchase':smoke?'invoice':false)

async function load<T>(file:string):Promise<T[]>{try{return (await readFile(file,'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}}
async function startProxy(){const p=spawn(process.execPath,['--import','tsx',join(base,'proxy.ts')],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']})
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('proxy_start_timeout')),10000);p.stdout!.on('data',d=>{if(String(d).includes('"proxy"')){clearTimeout(timeout);resolve()}});p.once('exit',code=>{clearTimeout(timeout);reject(new Error(`proxy_exit_${code}`))})})
 return p
}
/** Captures of the current design only, last attempt per seed (the pilot seeds 2100xx are not part of it). */
async function currentCaptures():Promise<Captured[]>{
 const p=plans(),seeds=new Set([...p.calibration,...p.heldout].map(x=>x.seed)),bySeed=new Map<number,Captured>()
 for(const x of await load<Captured>(join(out,'sessions.jsonl')))if(seeds.has(x.plan.seed))bySeed.set(x.plan.seed,x)
 return [...bySeed.values()]
}
async function capture(){
 await checkApplication(c)
 const previous=await recordingOptIn(c);let proxy:ReturnType<typeof spawn>|undefined
 try{
  await recordingOptIn(c,true);proxy=await startProxy()
  const plan=plans(),all=[...plan.calibration,...plan.heldout]
  await ensureLabUsers(c,all.map(x=>x.user));const fixtures=await ensureFixtures(c)
  const {captureSession}=await import('./capture.ts')
  const capturesFile=join(out,'sessions.jsonl'),readinessFile=join(out,'readiness.jsonl')
  const captures=await load<Captured>(capturesFile),readiness=await load<Readiness>(readinessFile)
  for(const phase of ['calibration','heldout'] as const){
   for(const p of plan[phase]){
    if(captures.some(x=>x.plan.seed===p.seed&&x.session_id))continue
    const result=await drivePlan(c,p,fixtures)
    captures.push(result);await appendFile(capturesFile,JSON.stringify(result)+'\n')
    await writeFile(join(out,'ground-truth',`${p.seed}.json`),JSON.stringify({plan:p,session_id:result.session_id,truth:result.truth,steps:result.steps},null,2))
    console.log(JSON.stringify({phase,seed:p.seed,cohort:p.cohort,session:result.session_id,truth:result.truth.map(t=>t.observed),steps:result.steps.map(s=>s.name+(s.ok?'':'!')).join(' '),errors:result.errors}))
   }
   const seeds=new Set(plan[phase].map(x=>x.seed))
   for(const result of captures.filter(x=>seeds.has(x.plan.seed))){
    if(!result.session_id||readiness.some(x=>x.session_id===result.session_id&&x.status==='ready'))continue
    const r=await captureSession(result.session_id,smoke?45_000:75_000,result.ended_at)
    readiness.push(r);await appendFile(readinessFile,JSON.stringify(r)+'\n')
    console.log(JSON.stringify({phase,session:r.session_id,status:r.status,events:r.analysis.events,bytes:r.snapshot_bytes,error:r.error}))
   }
  }
 }finally{proxy?.kill('SIGTERM');await recordingOptIn(c,previous).catch(e=>console.error('recording_opt_in_restore_failed',e instanceof Error?e.message:'error'))}
}
async function evaluate(){
 const t0=Date.now()
 const captures=await currentCaptures()
 await writeFile(join(out,'session-ids.json'),JSON.stringify(captures.map(x=>({seed:x.plan.seed,phase:x.plan.phase,persona:x.plan.persona,user:x.plan.user,workflow:x.plan.workflow,injection:x.plan.injection||null,cohort:x.plan.cohort||null,session_id:x.session_id})),null,1))
 const {runPipeline}=await import('./pipeline.ts')
 const {score,calibrationSummary}=await import('./score.ts')
 const {writeReport}=await import('./report.ts')
 const pipeline=await runPipeline(out,captures,COHORTS.map((k,i)=>({id:k.id,seeds:Array.from({length:k.users},(_,j)=>220000+i*10+j)})),CONTROL_SEEDS,process.argv.includes('--llm-pass1'))
 await writeFile(join(out,'pipeline.json'),JSON.stringify(pipeline))
 const held=score(captures,pipeline,COHORTS,CONTROL_SEEDS),cal=calibrationSummary(captures,pipeline)
 await writeFile(join(out,'heldout-score.json'),JSON.stringify(held,null,1))
 await writeFile(join(out,'calibration-score.json'),JSON.stringify(cal,null,1))
 await writeReport(out,captures,pipeline,held,cal,{evaluate_ms:Date.now()-t0,peak_rss_mib:Math.round(process.resourceUsage().maxRSS/1024)})
 console.log(JSON.stringify({evaluated:out,sessions:captures.length,precision:held.precision,recall:held.recall}))
}
/** Re-score an archived pipeline.json (e.g. run-a-frozen-v3/) with the current scorer, without running the pipeline. */
async function scoreOnly(dir:string){
 const captures=await currentCaptures(),pipeline=JSON.parse(await readFile(join(dir,'pipeline.json'),'utf8'))
 const {score,calibrationSummary}=await import('./score.ts'),{writeReport}=await import('./report.ts')
 const held=score(captures,pipeline,COHORTS,CONTROL_SEEDS),cal=calibrationSummary(captures,pipeline)
 await writeFile(join(dir,'heldout-score.json'),JSON.stringify(held,null,1));await writeFile(join(dir,'calibration-score.json'),JSON.stringify(cal,null,1))
 await writeReport(dir,captures,pipeline,held,cal,{evaluate_ms:0,peak_rss_mib:Math.round(process.resourceUsage().maxRSS/1024)})
 console.log(JSON.stringify({rescored:dir,precision:held.precision,moment:held.precision_moment_level}))
}
async function main(){
 const so=process.argv.indexOf('--score-only');if(so>0){await scoreOnly(join(out,process.argv[so+1]||'.'));return}
 await mkdir(join(out,'ground-truth'),{recursive:true})
 if(!process.argv.includes('--rescore'))await capture()
 if(!process.argv.includes('--capture')&&!smoke)await evaluate()
}
main().catch(e=>{console.error(e instanceof Error?e.stack:'error');process.exitCode=1})
