import { readFileSync, writeFileSync } from 'node:fs'
import { installClickhouseBridge,setPhase } from '/tmp/claude-0/-root/2bc783d3-062c-48de-ba03-65e0907eb948/scratchpad/chlab/bridge.mts'
const root=process.env.LENS_ROOT!
Object.assign(process.env,{TASKS_DB:'/root/chlab/taskB/tasks.db',TRIAGE_DB:'/root/chlab/taskB/main.db',APP_EVENTS_FILE:root+'/config/app-events.reval.json',POSTHOG_HOST:'http://posthog.fake',POSTHOG_PROJECT_ID:'1',POSTHOG_PERSONAL_API_KEY:'fake',LENS_JOB_BOOTSTRAP:'/root/chlab/taskB/bootstrap.mts'})
installClickhouseBridge({log:'/root/chlab/taskB/after-queries.jsonl'})
const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js'),{Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js')
const {registerTools}=await import(root+'/src/mcp/tools.ts');const server=new McpServer({name:'bench',version:'1'});registerTools(server,undefined,{who:'taskB-after',surveyRole:'none',dashboardRole:'share',admin:true,insights:true});const client=new Client({name:'bench',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b)
const before=JSON.parse(readFileSync('/root/chlab/taskB/before.json','utf8'))
const args:any={client_activity_changes:{from:'2022-11-15',to:'2026-11-13'},compare_client_patterns:{client:'C04',from:'2022-11-15',to:'2026-11-13',months:47},client_signals:{when:'last 90 days'},dialog_friction:{when:'last 12 months'},top_pains:{when:'last 12 months'},discover_workflows:{when:'last 12 months'},workflow_completion:{when:'last 4 years',dialogs:['DlgTask01','DlgTask02']},rescue_queue:{when:'last 90 days'},describe_app_events:{days:1460},signal_scorecard:{weeks:209},aggregate_events:{when:'last 4 years',metrics:['events'],group_by:['app_version'],bucket:'month'}}
const only=process.env.AFTER_ONLY
const out:any[]=only?JSON.parse(readFileSync('/root/chlab/taskB/after.json','utf8')).filter((r:any)=>r.name!==only):[]
for(const name of [...before.map((r:any)=>r.name), 'aggregate_events_covered','describe_app_events_covered'].filter(name=>!only||name===only)){
 const tool=name.replace('_covered',''),input=name.endsWith('_covered')?(tool==='aggregate_events'?{when:'2026-11-07 to 2026-11-13',metrics:['events','sessions','users','clients'],group_by:['app_version'],bucket:'month'}:{days:7}):args[name]
 setPhase(name);const t=performance.now();let result:any=await client.callTool({name:tool,arguments:input},undefined,{timeout:25000});const seconds=(performance.now()-t)/1000,chars=JSON.stringify(result).length
 let status:any;try{status=JSON.parse(result.content[0].text)}catch{}
 const handle=status?.status==='running'?status.job_id:undefined
 while(status?.status==='running') {await new Promise(r=>setTimeout(r,2000));result=await client.callTool({name:'get_job_result',arguments:{job_id:handle}},undefined,{timeout:25000});try{status=JSON.parse(result.content[0].text)}catch{status=undefined}}
 const row={name,seconds,chars,job_id:handle,complete_seconds:(performance.now()-t)/1000,result_chars:JSON.stringify(result).length,result};out.push(row);console.log(JSON.stringify({...row,result:undefined}));writeFileSync('/root/chlab/taskB/after.json',JSON.stringify(out,null,2))
}
await client.close();await server.close();process.exit()
