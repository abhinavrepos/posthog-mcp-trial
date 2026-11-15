import { writeFileSync } from 'node:fs'
import { installClickhouseBridge, records, setPhase } from '/tmp/claude-0/-root/2bc783d3-062c-48de-ba03-65e0907eb948/scratchpad/chlab/bridge.mts'
const root=process.env.LENS_ROOT!, mode=process.env.BENCH_MODE || 'before'
Object.assign(process.env,{TASKS_DB:'/root/chlab/taskB/tasks.db',TRIAGE_DB:'/root/chlab/taskB/main.db',APP_EVENTS_FILE:root+'/config/app-events.reval.json',POSTHOG_HOST:'http://posthog.fake',POSTHOG_PROJECT_ID:'1',POSTHOG_PERSONAL_API_KEY:'fake',LENS_JOB_BOOTSTRAP:'/root/chlab/taskB/bootstrap.mts'})
installClickhouseBridge({log:`/root/chlab/taskB/${mode}-queries.jsonl`})
const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js'),{Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js')
const {registerTools}=await import(root+'/src/mcp/tools.ts')
const server=new McpServer({name:'bench',version:'1'});registerTools(server,undefined,{who:'taskB-bench',surveyRole:'none',dashboardRole:'share',admin:true,insights:true})
const client=new Client({name:'bench',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b)
const calls:[string,any][]=[['client_activity_changes',{from:'2022-11-15',to:'2026-11-13'}],['compare_client_patterns',{client:'C04',from:'2022-11-15',to:'2026-11-13',months:47}],['client_signals',{when:'last 90 days'}],['dialog_friction',{when:'last 12 months'}],['top_pains',{when:'last 12 months'}],['discover_workflows',{when:'last 12 months'}],['workflow_completion',{when:'last 4 years',dialogs:['DlgTask01','DlgTask02']}],['rescue_queue',{when:'last 90 days'}],['describe_app_events',{days:1460}],['signal_scorecard',{weeks:209}],['aggregate_events',{when:'last 4 years',metrics:['events'],group_by:['app_version'],bucket:'month'}]]
const out:any[]=[]
for(const [name,args] of calls) {
 setPhase(name);const i=records.length,t=performance.now();let result:any,error:any
 try {result=await client.callTool({name,arguments:args},undefined,{timeout:600000})}catch(e){error=String(e)}
 const row={name,seconds:(performance.now()-t)/1000,chars:JSON.stringify(result||'').length,read_rows:records.slice(i).reduce((n,r)=>n+(r.read_rows||0),0),result,error}
 out.push(row);console.log(JSON.stringify({...row,result:undefined}));writeFileSync(`/root/chlab/taskB/${mode}.json`,JSON.stringify(out,null,2))
}
await client.close();await server.close();process.exit()
