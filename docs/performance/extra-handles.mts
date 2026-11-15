import {writeFileSync} from 'node:fs'
import {installClickhouseBridge} from '/tmp/claude-0/-root/2bc783d3-062c-48de-ba03-65e0907eb948/scratchpad/chlab/bridge.mts'
const root=process.env.LENS_ROOT!
Object.assign(process.env,{TASKS_DB:'/root/chlab/taskB/tasks.db',TRIAGE_DB:'/root/chlab/taskB/main.db',APP_EVENTS_FILE:root+'/config/app-events.reval.json',POSTHOG_HOST:'http://posthog.fake',POSTHOG_PROJECT_ID:'1',POSTHOG_PERSONAL_API_KEY:'fake',LENS_JOB_BOOTSTRAP:'/root/chlab/taskB/bootstrap.mts'})
installClickhouseBridge({log:'/root/chlab/taskB/extras-after-queries.jsonl'})
const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js'),{Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js'),{CancelTaskResultSchema}=await import('@modelcontextprotocol/sdk/types.js'),{registerTools}=await import(root+'/src/mcp/tools.ts')
const server=new McpServer({name:'bench',version:'1'});registerTools(server,undefined,{who:'taskB-extras',surveyRole:'none',dashboardRole:'share',admin:true,insights:true});const client=new Client({name:'bench',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b)
const out=[]
for(const [name,args] of [['message_doctor',{when:'last 12 months'}],['find_trade',{id:'4348',when:'last 4 years'}]] as const) {
 const t=performance.now(),result:any=await client.callTool({name,arguments:args},undefined,{timeout:25000}),seconds=(performance.now()-t)/1000;let body:any;try{body=JSON.parse(result.content[0].text)}catch{}
 const row={name,seconds,chars:JSON.stringify(result).length,result};out.push(row);console.log(JSON.stringify(row));writeFileSync('/root/chlab/taskB/extra-handles.json',JSON.stringify(out,null,2))
 if(body?.job_id) await client.request({method:'tasks/cancel',params:{taskId:body.job_id}},CancelTaskResultSchema)
}
await client.close();await server.close();process.exit()
