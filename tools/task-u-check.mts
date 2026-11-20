// Run after task-u-server.mts with the lab bridge preload. Never alters lab data.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const client=new Client({name:'task-u-check',version:'1'})
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18371/mcp'),{requestInit:{headers:{Authorization:'Bearer task-u-lab-token'}}}))
const out:unknown[]=[]
async function call(name:string,args:Record<string,unknown>) {
    const started=performance.now()
    try {const result=await client.callTool({name,arguments:args},undefined,{timeout:25000});out.push({name,args,ms:Math.round(performance.now()-started),result})}
    catch(e){out.push({name,args,ms:Math.round(performance.now()-started),error:String(e)})}
}
await call('resolve_client',{query:'c 88'})
await call('resolve_client',{query:'c88'})
let screen='Task01', what='Save'
try {
    const start=performance.now()
    const query="SELECT JSON_VALUE(properties, '$.dialog_name') AS screen, any(JSON_VALUE(properties, '$.action_name')) AS what FROM lab.events WHERE timestamp >= now() - INTERVAL 7 DAY AND JSON_VALUE(properties, '$.client_id') = 'C88' AND notEmpty(screen) GROUP BY screen LIMIT 1 FORMAT JSON"
    const r=await fetch('http://127.0.0.1:18123/',{method:'POST',body:query,signal:AbortSignal.timeout(10000)})
    if(!r.ok)throw Error(await r.text())
    const data=await r.json() as {data:{screen:string;what:string}[]}
    if(data.data[0])({screen,what}=data.data[0])
    out.push({discovery_ms:Math.round(performance.now()-start),screen,what})
} catch(e) {out.push({discovery_error:String(e),fallback_fixture_screen:screen,fallback_fixture_what:what})}
await call('find_sessions',{client:'C88',screen,what,period:'last_12_months',limit:3})
for(const path of ['/healthz','/replays/live/api/time?from=2026-11-19&to=2026-11-19','/replays/pinned']) {
    const start=performance.now(),r=await fetch('http://127.0.0.1:18371'+path,{headers:{cookie:'sessionid=lab-admin-session-0001'}}),body=await r.text()
    out.push({path,status:r.status,ms:Math.round(performance.now()-start),body:body.slice(0,path.includes('pinned')?100:1000)})
}
await client.close()
console.log(JSON.stringify(out,null,2))
