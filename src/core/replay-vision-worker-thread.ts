import { parentPort, workerData } from 'node:worker_threads'
import { readTimeline } from './replay-timeline.ts'
import { detectCandidates } from './replay-vision-detectors.ts'
import {sessionMetrics} from './replay-vision-metrics.ts'

void (async () => {
  try {
    const timeline=await readTimeline(workerData.file,workerData.metadata)
    const candidates=detectCandidates(timeline,undefined,workerData.context??{})
    // Do not send the whole event stream or node map back to the HTTP process.
    parentPort?.postMessage({coverage:timeline.coverage,candidates,metrics:sessionMetrics(timeline,candidates),screens:timeline.screens,events:timeline.items.length})
  } catch {
    parentPort?.postMessage({coverage:{state:'partial',reasons:['worker_error']},candidates:[],metrics:[],screens:[],events:0})
  }
})()
