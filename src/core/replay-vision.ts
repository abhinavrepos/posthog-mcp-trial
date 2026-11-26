import { Worker } from 'node:worker_threads'
import { withSnapshotsFile } from './clip.ts'
import { getRecording,hogql } from './posthog.ts'
import { DETECTOR_CONFIG, type Candidate } from './replay-vision-detectors.ts'
import type { Coverage } from './replay-timeline.ts'

export const analysisVersion=DETECTOR_CONFIG.version
export interface AnalysisResult {coverage:Coverage|{state:string;reasons:string[]};candidates:Candidate[];screens:string[];events:number}
export function analyzeFile(file:string,metadata:{start_time:string;app_events?:{timestamp:string;event:string;path?:string}[]},timeoutMs=60_000):Promise<AnalysisResult> {
  return new Promise(resolve=>{
    const worker=new Worker(new URL('./replay-vision-worker-thread.ts',import.meta.url),{workerData:{file,metadata},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4},execArgv:['--import','tsx']})
    let done=false
    const finish=(r:AnalysisResult)=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate().catch(()=>{});resolve(r)}
    const failed=(reason:string):AnalysisResult=>({coverage:{state:'partial',reasons:[reason]},candidates:[],screens:[],events:0})
    const timer=setTimeout(()=>finish(failed('timeout')),timeoutMs)
    worker.once('message',(value:AnalysisResult)=>finish(value))
    worker.once('error',()=>finish(failed('worker_crash')))
    worker.once('exit',(code)=>{if(code!==0)finish(failed('worker_exit'))})
  })
}
export async function replayAppEvents(sessionId:string):Promise<{timestamp:string;event:string;path?:string}[]> {
  let app_events:{timestamp:string;event:string;path?:string}[]=[]
  try {const rows=await hogql(`SELECT timestamp,event,toString(properties.$pathname) AS path FROM events WHERE toString(properties.$session_id)={sid} AND timestamp>=now()-INTERVAL 30 DAY ORDER BY timestamp LIMIT 500`,{sid:sessionId},{timeoutMs:10_000,retries:0});app_events=rows.map(r=>({timestamp:String(r.timestamp),event:String(r.event),path:String(r.path||'')}))}catch{}
  return app_events
}
export async function analyzeSession(sessionId:string):Promise<AnalysisResult> {
  const recording=await getRecording(sessionId)
  const app_events=await replayAppEvents(sessionId)
  return withSnapshotsFile(sessionId,file=>analyzeFile(file,{...recording,app_events}))
}
