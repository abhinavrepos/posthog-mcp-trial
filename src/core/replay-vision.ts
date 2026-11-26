import { Worker } from 'node:worker_threads'
import { withSnapshotsFile } from './clip.ts'
import { getRecording,hogql } from './posthog.ts'
import { DETECTOR_CONFIG, type Candidate, type DetectorContext } from './replay-vision-detectors.ts'
import { appScreenKey, type AppEventInput, type Coverage, type SanitizedWindow } from './replay-timeline.ts'
import { appEvents } from './appevents.ts'
import type {SessionMetric} from './replay-vision-metrics.ts'
import type { WatchPlan } from './replay-vision-watch-plan.ts'

export const analysisVersion=DETECTOR_CONFIG.version
export interface AnalysisResult {coverage:Coverage|{state:string;reasons:string[]};candidates:Candidate[];metrics:SessionMetric[];screens:string[];events:number;windows?:SanitizedWindow[];watch?:WatchPlan}
/** Normalize and detect in a resource-limited worker thread; never throws, a timeout or crash yields an empty partial result. */
export function analyzeFile(file:string,metadata:{start_time:string;app_events?:AppEventInput[];labels?:string[]},timeoutMs=60_000,context:DetectorContext={},windows?:number[],watchPlan=false):Promise<AnalysisResult> {
  return new Promise(resolve=>{
    const worker=new Worker(new URL('./replay-vision-worker-thread.ts',import.meta.url),{workerData:{file,metadata:{start_time:metadata.start_time,app_events:metadata.app_events,labels:metadata.labels??appVocabulary()},context,windows,watchPlan},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4},execArgv:['--import','tsx']})
    let done=false
    const finish=(r:AnalysisResult)=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate().catch(()=>{});resolve(r)}
    const failed=(reason:string):AnalysisResult=>({coverage:{state:'partial',reasons:[reason]},candidates:[],metrics:[],screens:[],events:0})
    const timer=setTimeout(()=>finish(failed('timeout')),timeoutMs)
    worker.once('message',(value:AnalysisResult)=>finish(value))
    worker.once('error',()=>finish(failed('worker_crash')))
    worker.once('exit',(code)=>{if(code!==0)finish(failed('worker_exit'))})
  })
}
function configuredApp(){try{return appEvents()}catch{return null}}
/**
 * The application's own vocabulary (APP_EVENTS_FILE): submit buttons and the button, tab, field-action and screen-name
 * examples become safe labels, so insights can name e.g. "Save", "Recalc Cashflow", "Trade Date" or "Hedge Designation".
 * REPLAY_VISION_LABELS adds deployment-specific labels on top. Empty when no application vocabulary is configured.
 */
export function appVocabulary():string[]{
  const a=configuredApp();if(!a)return []
  const p=a.properties
  return [...new Set([...a.submitButtons,...(p.button?.examples??[]),...(p.tab?.examples??[]),
    ...(p.dialogName?.examples??[]).filter(x=>!/^(unknown|messagebox|toast)$/i.test(x)),
    ...(p.action?.examples??[]).filter(x=>/^[A-Z][a-z]/.test(x))])].filter(x=>x.length<=60)
}
/** One app-event row resolved against the application vocabulary (pure; exported for tests). */
export function resolveAppEvent(r:Record<string,unknown>,a:ReturnType<typeof appEvents>):AppEventInput{
  const e:AppEventInput={timestamp:String(r.timestamp),event:String(r.event),path:String(r.path||'')}
  if(!a)return e
  const dialog=String(r.dialog??''),name=String(r.dialog_name??''),action=String(r.action??'').toUpperCase()
  const special=new Set([...a.dialogs.messages,...a.dialogs.notices,...a.dialogs.menu])
  if(a.dialogs.messages.includes(dialog))e.error=a.messageOutcome==='error'
  else if(a.dialogs.notices.includes(dialog))e.notice=true
  else if(e.event===a.events.screen&&dialog&&!/^(undefined|null)$/i.test(dialog)&&!special.has(dialog)){
    if(a.screenActions.open.map(x=>x.toUpperCase()).includes(action)){e.screen=appScreenKey(dialog,name);e.nav='open'}
    else if(a.screenActions.close.map(x=>x.toUpperCase()).includes(action)){e.screen=appScreenKey(dialog,name);e.nav='close'}
  }
  return e
}
/**
 * App events of one session: $pageview/$exception, plus (with APP_EVENTS_FILE) the application's screen event resolved to
 * screen opens/closes (screen key from the visible dialog name), its message dialogs as visible errors and its notices.
 */
export async function replayAppEvents(sessionId:string):Promise<AppEventInput[]> {
  const a=configuredApp(),p=a?.properties
  const extra=a&&p?.dialog?`,toString(properties.${p.dialog.name}) AS dialog,${p.dialogName?`toString(properties.${p.dialogName.name})`:"''"} AS dialog_name,${p.action?`toString(properties.${p.action.name})`:"''"} AS action`:''
  let app_events:AppEventInput[]=[]
  try {
    const rows=await hogql(`SELECT timestamp,event,toString(properties.$pathname) AS path${extra} FROM events WHERE toString(properties.$session_id)={sid} AND timestamp>=now()-INTERVAL 30 DAY ORDER BY timestamp LIMIT 500`,{sid:sessionId},{timeoutMs:10_000,retries:0})
    app_events=rows.map(r=>resolveAppEvent(r,a))
  }catch{}
  return app_events
}
export async function analyzeSession(sessionId:string,context:DetectorContext={}):Promise<AnalysisResult> {
  const recording=await getRecording(sessionId)
  const app_events=await replayAppEvents(sessionId)
  return withSnapshotsFile(sessionId,file=>analyzeFile(file,{start_time:recording.start_time,app_events},60_000,context))
}
