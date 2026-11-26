import {mkdtemp,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {getRecording,getSnapshotsJsonl} from '../../src/core/posthog.ts'
import {analyzeFile,replayAppEvents} from '../../src/core/replay-vision.ts'
import type {AnalysisResult} from '../../src/core/replay-vision.ts'

export interface Readiness {session_id:string;start_time:string;end_time:string;snapshot_bytes:number;analysis:AnalysisResult;status:'ready'|'pending'|'unavailable';error?:string}
export async function captureSession(session_id:string,maxWaitMs=90_000,expectedEndAt?:string):Promise<Readiness>{
 const dir=await mkdtemp(join(tmpdir(),'rv-capture-')),file=join(dir,'snapshots.jsonl'),deadline=Date.now()+maxWaitMs
 try{
  let lastError='not_ready',previousSize=-1
  while(Date.now()<deadline){
   try{
    const meta=await getRecording(session_id)
    if(expectedEndAt&&Date.parse(meta.end_time)<Date.parse(expectedEndAt)-5000){lastError='recording_tail_not_ingested';await new Promise(r=>setTimeout(r,2500));continue}
    await getSnapshotsJsonl(session_id,file)
    const bytes=(await stat(file)).size
    if(bytes===0)throw new Error('empty_snapshots')
    if(bytes!==previousSize){previousSize=bytes;lastError='snapshot_size_not_stable';await new Promise(r=>setTimeout(r,2500));continue}
    const app_events=await replayAppEvents(session_id),analysis=await analyzeFile(file,{...meta,app_events})
    if(!('full_snapshot_seen' in analysis.coverage)||!analysis.coverage.full_snapshot_seen){lastError='missing_full_snapshot';await new Promise(r=>setTimeout(r,2500));continue}
    return {session_id,start_time:meta.start_time,end_time:meta.end_time,snapshot_bytes:bytes,analysis,status:'ready'}
   }catch(e){lastError=e instanceof Error?e.message.slice(0,100):'api_error';await new Promise(r=>setTimeout(r,3000))}
  }
  return {session_id,start_time:'',end_time:'',snapshot_bytes:0,analysis:{coverage:{state:'partial',reasons:['unavailable']},candidates:[],metrics:[],screens:[],events:0},status:'unavailable',error:lastError}
 }finally{await rm(dir,{recursive:true,force:true})}
}
