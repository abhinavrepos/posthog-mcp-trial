import {readFileSync,writeFileSync} from 'node:fs'
import {installClickhouseBridge} from '/tmp/claude-0/-root/2bc783d3-062c-48de-ba03-65e0907eb948/scratchpad/chlab/bridge.mts'
Object.assign(process.env,{TASKS_DB:'/root/chlab/taskB/tasks.db',TRIAGE_DB:'/root/chlab/taskB/main.db',APP_EVENTS_FILE:'/root/chlab/taskB/baseline/config/app-events.reval.json',POSTHOG_HOST:'http://posthog.fake',POSTHOG_PROJECT_ID:'1',POSTHOG_PERSONAL_API_KEY:'fake'})
installClickhouseBridge({log:'/root/chlab/taskB/parity-queries.jsonl'})
const {aggregateEvents}=await import('/root/chlab/taskB/baseline/src/core/aggregate.ts')
const t=performance.now(),live=await aggregateEvents({from:new Date('2026-11-07'),to:new Date('2026-11-14'),metrics:['events','sessions','users','clients'],group_by:['app_version'],bucket:'month'})
const result=JSON.parse(readFileSync('/root/chlab/taskB/after.json','utf8')).find((r:any)=>r.name==='aggregate_events_covered').result.content[0].text
const rolled=JSON.parse(result.match(/```json\n([\s\S]*?)\n```/)[1])
const {safeResult,jsonResult}=await import('/root/chlab/taskB/baseline/src/mcp/result.ts')
const safe=await safeResult(jsonResult('',live)) as any
const liveSafe=JSON.parse(safe.content[0].text)
const parity=JSON.stringify(liveSafe.totals)===JSON.stringify(rolled.totals)&&JSON.stringify(liveSafe.rows)===JSON.stringify(rolled.rows)
const out={seconds:(performance.now()-t)/1000,parity,live:{totals:liveSafe.totals,rows:liveSafe.rows},boundary:'same MCP safeResult/jsonResult',rolled:{totals:rolled.totals,rows:rolled.rows}}
writeFileSync('/root/chlab/taskB/parity.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out));process.exit(parity?0:1)
