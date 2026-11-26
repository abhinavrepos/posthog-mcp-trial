import { parentPort, workerData } from 'node:worker_threads'
import { readTimeline, sanitizedWindow } from './replay-timeline.ts'
import { detectCandidates } from './replay-vision-detectors.ts'
import {sessionMetrics} from './replay-vision-metrics.ts'
import { planWatch } from './replay-vision-watch-plan.ts'

void (async () => {
  try {
    const timeline=await readTimeline(workerData.file,workerData.metadata)
    // Watch-fully mode: the bounded frame plan and the sanitized whole-session timeline, nothing else.
    if(workerData.watchPlan){parentPort?.postMessage({coverage:timeline.coverage,candidates:[],metrics:[],screens:timeline.screens,events:timeline.items.length,watch:planWatch(timeline)});return}
    // Window mode (B′): return only sanitized ±20 s windows around the requested moments.
    if(Array.isArray(workerData.windows)){parentPort?.postMessage({coverage:timeline.coverage,candidates:[],metrics:[],screens:timeline.screens,events:timeline.items.length,windows:workerData.windows.slice(0,5).map((c:number)=>sanitizedWindow(timeline,Number(c)||0))});return}
    const candidates=detectCandidates(timeline,undefined,workerData.context??{})
    // Do not send the whole event stream or node map back to the HTTP process.
    parentPort?.postMessage({coverage:timeline.coverage,candidates,metrics:sessionMetrics(timeline,candidates),screens:timeline.screens,events:timeline.items.length})
  } catch {
    parentPort?.postMessage({coverage:{state:'partial',reasons:['worker_error']},candidates:[],metrics:[],screens:[],events:0})
  }
})()
