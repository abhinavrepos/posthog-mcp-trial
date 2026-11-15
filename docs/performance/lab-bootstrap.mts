import {workerData} from 'node:worker_threads'
import {installClickhouseBridge,setPhase} from '/tmp/claude-0/-root/2bc783d3-062c-48de-ba03-65e0907eb948/scratchpad/chlab/bridge.mts'
export default function(){installClickhouseBridge({log:'/root/chlab/taskB/worker-queries.jsonl'});setPhase(workerData.name)}
