import {readFileSync,writeFileSync} from 'node:fs'
import {installClickhouseBridge,records} from '/tmp/claude-0/-root/2bc783d3-062c-48de-ba03-65e0907eb948/scratchpad/chlab/bridge.mts'
const root=process.env.LENS_ROOT!,mode=process.env.BENCH_MODE!
Object.assign(process.env,{TASKS_DB:'/root/chlab/taskB/tasks.db',TRIAGE_DB:'/root/chlab/taskB/main.db',APP_EVENTS_FILE:root+'/config/app-events.reval.json',POSTHOG_HOST:'http://posthog.fake',POSTHOG_PROJECT_ID:'1',POSTHOG_PERSONAL_API_KEY:'fake',LENS_JOB_BOOTSTRAP:'/root/chlab/taskB/bootstrap.mts'})
installClickhouseBridge({log:`/root/chlab/taskB/${mode}-one-queries.jsonl`})
const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js'),{Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js'),{registerTools}=await import(root+'/src/mcp/tools.ts')
const server=new McpServer({name:'bench',version:'1'});registerTools(server,undefined,{who:'taskB-after',surveyRole:'none',dashboardRole:'share',admin:true,insights:true});const client=new Client({name:'bench',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b)
const name='compare_client_patterns',args={client:'C04',from:'2022-11-15',to:'2026-11-13',months:47}
const t=performance.now();let result:any=await client.callTool({name,arguments:args},undefined,{timeout:180000});const seconds=(performance.now()-t)/1000,chars=JSON.stringify(result).length;let status:any;try{status=JSON.parse(result.content[0].text)}catch{};const job_id=status?.status==='running'?status.job_id:undefined
while(status?.status==='running'){await new Promise(r=>setTimeout(r,1000));result=await client.callTool({name:'get_job_result',arguments:{job_id}});try{status=JSON.parse(result.content[0].text)}catch{status=undefined}}
const row={name,seconds,chars,read_rows:records.reduce((n,r)=>n+(r.read_rows||0),0),result_chars:JSON.stringify(result).length,job_id,complete_seconds:(performance.now()-t)/1000,result}
const file=`/root/chlab/taskB/${mode}.json`,all=JSON.parse(readFileSync(file,'utf8')).filter((r:any)=>r.name!==name);all.push(row);writeFileSync(file,JSON.stringify(all,null,2));console.log(JSON.stringify({...row,result:undefined}));await client.close();await server.close();process.exit()
