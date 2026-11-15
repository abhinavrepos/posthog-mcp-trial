/** Real MCP load test. Never installs packages or changes server settings. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolve } from 'node:path'

const option = (key: string, fallback: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.split('=').slice(1).join('=') ?? fallback
const users = option('users', '5,10,20').split(',').map(Number)
const minutes = Number(option('minutes', '8'))
if (users.some(n => !Number.isInteger(n) || n < 1 || n > 150) || !(minutes > 0 && minutes <= 10)) throw Error('Invalid users/minutes')
const out = resolve(option('out', 'tools/load-test/results'))
mkdirSync(out, { recursive: true })
const endpoint = option('url', 'http://127.0.0.1:18331/mcp')
const labDir = option('lab', process.env.LENS_LOAD_LAB_DIR ?? '/root/chlab/agent')
const mainFile = `${labDir}/main.db`, tasksFile = `${labDir}/tasks.db`
const main = new DatabaseSync(mainFile, { readOnly: true }), tasks = new DatabaseSync(tasksFile, { readOnly: true })
main.exec('PRAGMA busy_timeout=1000'); tasks.exec('PRAGMA busy_timeout=1000')
const bounds = tasks.prepare('SELECT min(day) lo,max(day) hi FROM task_daily').get() as {lo:string;hi:string}
const clients = (tasks.prepare('SELECT DISTINCT client FROM task_daily ORDER BY client').all() as {client:string}[]).map(x => x.client)
// Token plaintext exists only in this process and its short-lived creation child; never in artifacts.
const tokenEnv = {...process.env,TRIAGE_DB:mainFile,TASKS_DB:tasksFile,APP_EVENTS_FILE:'config/app-events.reval.json'}
const tokenLabel = 'Lens load test'
const tokenCode = `const {createMcpToken}=await import('./src/service/access.ts'); const made=Array.from({length:${Math.max(...users)}},(_,i)=>createMcpToken({email:'user'+String(i+1).padStart(2,'0')+'@example.invalid',posthog_admin:true},'${tokenLabel}')); console.log(JSON.stringify(made)); process.exit(0)`
const made: {token:string;id:string}[] = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', tokenCode], {env:tokenEnv,encoding:'utf8'}).trim())
const tokens = made.map(x => x.token)
/** Revoke this run's tokens however the run ends, so no admin-capable test credential outlives it. */
function revokeTokens() {
    const ids = JSON.stringify(made.map(x => x.id))
    try { execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e',`const {revokeMcpToken}=await import('./src/service/access.ts'); for (const id of ${ids}) revokeMcpToken(id,'load-test'); process.exit(0)`], {env:tokenEnv,stdio:'ignore'}) }
    catch { console.error('WARNING: could not revoke load-test tokens; revoke label "'+tokenLabel+'" manually.') }
}
process.once('exit', revokeTokens)
for (const sig of ['SIGINT','SIGTERM'] as const) process.once(sig, () => process.exit(130))
function serverPid(port: number) {
    const sockets = new Set<string>()
    for (const file of ['/proc/net/tcp','/proc/net/tcp6']) for (const line of readFileSync(file,'utf8').split('\n').slice(1)) {
        const fields=line.trim().split(/\s+/)
        if (fields[3]==='0A' && parseInt(fields[1]?.split(':')[1],16)===port) sockets.add(fields[9])
    }
    for (const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
        try { for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { if (sockets.has(readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1] ?? '')) return Number(pid) } catch {} } } catch {}
    }
    return null // Listener inode is visible, but sandbox PID namespace may hide its owner.
}
const pid = serverPid(new URL(endpoint).port ? Number(new URL(endpoint).port) : 80)
const relevantEnv = Object.fromEntries((pid ? readFileSync(`/proc/${pid}/environ`,'utf8') : '').split('\0').filter(x=>/^LENS_(MCP_CALLS_|MCP_CONCURRENT_|JOB_|JOBS_|POSTHOG_MAX_|TOOL_CACHE_)/.test(x)).map(x=>x.split('=')))
writeFileSync(`${out}/metadata.json`,JSON.stringify({created:new Date().toISOString(),endpoint,pid,users,minutes,bounds,clientCount:clients.length,relevantEnv,seed:18331},null,2))
let seed=18331
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
const quantile=(a:number[],p:number)=> a.length ? [...a].sort((x,y)=>x-y)[Math.ceil(p*a.length)-1] : null
const percentiles=(a:number[])=>({p50:quantile(a,.5),p95:quantile(a,.95),p99:quantile(a,.99)})
async function connect(token:string,label:string) {
    const c=new Client({name:`lens-load-${label}`,version:'1.0.0'})
    await c.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}))
    return c
}
function body(result:any):string { return (result.content ?? []).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n') }
function handle(result:any):{job_id:string;poll_after_seconds?:number}|undefined {
    for(const c of result.content ?? []) if(c.type==='text') { try { const v=JSON.parse(c.text); if(v.status==='running' && v.job_id)return v }catch{} }
}
function errorKind(result:any):string|null {
    if(!result.isError)return null
    const s=body(result)
    if(/rate limit/i.test(s))return 'rate_limit'
    if(/queue is full|analyses are already running/i.test(s))return 'busy'
    if(/invalid arguments|invalid time|expected .*received|validation/i.test(s))return 'validation'
    if(/too large|timed out|timeout|memory|capacity/i.test(s))return 'capacity'
    if(/unavailable|busy|fetch failed/i.test(s))return 'unavailable'
    if(/not found|expired job|requested item/i.test(s))return 'not_found'
    return 'internal'
}
type Call = {at:string;user:number;tool:string;args:Record<string,unknown>;firstMs:number;finalMs:number|null;handle:boolean;error:string|null;chars:number;phase:string;requestId:number;message?:string}
let requestId=0
for(const n of users) {
    const calls:Call[]=[], samples:any[]=[]
    let stopped=false,reason='duration',business=0,bad=0,workflow:string|undefined
    const file=`${out}/n${n}.jsonl`
    writeFileSync(file,'')
    const emit=(r:Call)=>{calls.push(r);appendFileSync(file,JSON.stringify({type:'call',...r})+'\n')}
    const sessions=await Promise.all(tokens.slice(0,n).map((t,i)=>connect(t,String(i+1))))
    // Independent pre-existing lab admin identity avoids consuming a PM user's rate allowance.
    const probe=await connect(readFileSync(`${labDir}/token.txt`,'utf8').trim(),'probe')
    const started=Date.now(),deadline=started+minutes*60000,drainDeadline=deadline+60000
    console.log(JSON.stringify({event:'scenario_start',n,at:new Date(started).toISOString()}))
    async function rpc(c:Client,user:number,tool:string,args:Record<string,unknown>,phase:string,parent?:number):Promise<{result:any;row:Call}> {
        const at=Date.now(),id=parent ?? ++requestId
        let result:any
        try {result=await c.callTool({name:tool,arguments:args},undefined,{timeout:45000})} catch(e) {result={isError:true,content:[{type:'text',text:String(e)}]}}
        const ms=Date.now()-at,h=handle(result),error=errorKind(result)
        const row:Call={at:new Date(at).toISOString(),user,tool,args,firstMs:ms,finalMs:h?null:ms,handle:!!h,error,chars:JSON.stringify(result).length,phase,requestId:id,...(error?{message:body(result).slice(0,700)}:{})}
        emit(row)
        return {result,row}
    }
    async function action(c:Client,user:number,tool:string,args:Record<string,unknown>) {
        const at=Date.now(),initial=await rpc(c,user,tool,args,'initial')
        let result=initial.result,h=handle(result),polls=0
        while(h && Date.now()<drainDeadline && !stopped) {
            await sleep(Math.max(2000,Math.min(10000,(h.poll_after_seconds ?? 5)*1000)))
            const next=await rpc(c,user,'get_job_result',{job_id:h.job_id},'poll',initial.row.requestId)
            polls++
            if(next.row.error==='rate_limit' || next.row.error==='busy') {await sleep(10000);continue}
            result=next.result;h=handle(result)
        }
        const error=errorKind(result),complete=!h
        const completion={type:'completion',requestId:initial.row.requestId,tool,user,finalMs:complete?Date.now()-at:null,error:complete?error:'censored',polls,chars:JSON.stringify(result).length}
        appendFileSync(file,JSON.stringify(completion)+'\n')
        initial.row.finalMs=completion.finalMs
        // Count each business operation once; transport/poll errors remain visible as physical calls.
        business++; if(error && error!=='rate_limit' && error!=='busy')bad++
        if(bad/business>.05) {stopped=true;reason=`non-throttle errors ${bad}/${business} exceed 5%`}
        if(tool==='discover_workflows' && !error && complete) {
            const text=body(result)
            // Workflow ids are stable wf_<base64url> strings, retrieved from returned data.
            const match=text.match(/"id"\s*:\s*"(wf_[^"]+)"/)
            if(match)workflow=match[1]
        }
        return result
    }
    const sampler=(async()=>{
        while(!stopped && Date.now()<deadline) {
            const tick=Date.now()
            let sample:any={type:'sample',at:new Date(tick).toISOString()}
            try {
                if(pid)sample.rssKiB=Number(readFileSync(`/proc/${pid}/status`,'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]); else sample.rssUnavailable='Server listener inode visible but owning PID hidden by sandbox namespace'
                const active=main.prepare("SELECT count(*) total,sum(CASE WHEN owner LIKE 'user%@example.invalid' THEN 1 ELSE 0 END) test FROM analysis_jobs WHERE status='working' AND expires>?").get(Date.now())
                sample.activeJobs=active
                const r=await rpc(probe,0,'resolve_client',{query:'C01'},'probe')
                sample.responsivenessMs=r.row.firstMs;sample.probeError=r.row.error
            }catch(e){sample.sampleError=String(e)}
            samples.push(sample);appendFileSync(file,JSON.stringify(sample)+'\n')
            await sleep(Math.max(0,5000-(Date.now()-tick)))
        }
    })()
    const mix=['resolve_client','client_story','task_map','dialog_friction','top_pains','rescue_queue','aggregate_events','resolve_client','client_story','task_map','discover_workflows','dialog_friction','rescue_queue','workflow_completion','top_pains','client_story','compare_client_patterns','client_signals']
    await Promise.all(sessions.map(async(c,i)=>{
        await sleep(Math.floor(random()*2000))
        let step=i%mix.length
        while(!stopped && Date.now()<deadline) {
            let tool=mix[step++%mix.length]
            const client=clients[Math.floor(random()*clients.length)]
            let args:Record<string,unknown>={period:'last_28_days'}
            if(tool==='resolve_client')args={query:client}
            if(tool==='client_story')args={client,from:bounds.lo,to:bounds.hi,bucket:'month'}
            if(tool==='task_map')args={...args,client}
            if(tool==='dialog_friction')args={...args,client}
            if(tool==='top_pains')args={period:'last_7_days'}
            if(tool==='aggregate_events')args={period:'last_12_months',bucket:'month',group_by:['app_version'],metrics:['events','sessions','clients']}
            if(tool==='discover_workflows')args={period:'last_12_months',limit:15}
            if(tool==='workflow_completion') {if(!workflow) {tool='discover_workflows';args={period:'last_12_months',limit:15}} else args={period:'last_12_months',workflow}}
            if(tool==='compare_client_patterns')args={from:bounds.lo,to:bounds.hi,group:'inactive',months:12}
            if(tool==='client_signals')args={period:'last_90_days',client}
            await action(c,i+1,tool,args)
            if(!stopped && Date.now()<deadline)await sleep(Math.min(2000+Math.floor(random()*8001),deadline-Date.now()))
        }
    }))
    await sampler
    await Promise.all([...sessions,probe].map(c=>c.close().catch(()=>{})))
    const tools=Object.fromEntries([...new Set(calls.filter(c=>c.phase!=='probe').map(c=>c.tool))].map(tool=>{
        const rows=calls.filter(c=>c.tool===tool && c.phase!=='probe')
        const errors=Object.fromEntries([...new Set(rows.map(c=>c.error).filter(Boolean))].map(k=>[k,rows.filter(c=>c.error===k).length]))
        return [tool,{calls:rows.length,firstMs:percentiles(rows.map(c=>c.firstMs)),finalMs:percentiles(rows.filter(c=>c.finalMs!==null).map(c=>c.finalMs!)),handles:rows.filter(c=>c.handle).length,errors,censored:rows.filter(c=>c.finalMs===null).length}]
    }))
    const summary={n,started:new Date(started).toISOString(),ended:new Date().toISOString(),elapsedSeconds:(Date.now()-started)/1000,reason,business,bad,physicalCalls:calls.filter(c=>c.phase!=='probe').length,tools,maxRssMiB:pid ? Math.max(...samples.map(s=>(s.rssKiB ?? 0)/1024)) : null,responsivenessMs:percentiles(samples.filter(s=>!s.probeError).map(s=>s.responsivenessMs)),probeErrors:samples.filter(s=>s.probeError).length,sampleCount:samples.length,maxWorkingJobs:Math.max(...samples.map(s=>Number(s.activeJobs?.total ?? 0))),maxTestWorkingJobs:Math.max(...samples.map(s=>Number(s.activeJobs?.test ?? 0)))}
    writeFileSync(`${out}/n${n}-summary.json`,JSON.stringify(summary,null,2))
    console.log(JSON.stringify({event:'scenario_end',...summary}))
    if(stopped)break
}
main.close();tasks.close()
