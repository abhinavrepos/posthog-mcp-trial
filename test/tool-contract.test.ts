import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const dir=mkdtempSync(join(tmpdir(),'lens-contract-'))
Object.assign(process.env,{TRIAGE_DB:join(dir,'main.db'),TASKS_DB:join(dir,'tasks.db'),APP_EVENTS_FILE:'config/app-events.reval.json',POSTHOG_PROJECT_ID:'1',POSTHOG_SURVEY_API_KEY:'test',FEATURE_SURVEYS:'on',LENS_MCP_CALLS_PER_MINUTE:'60'}) // budget mechanics are tested at 60/min
const {timeInput,PERIODS,resolveTime,inclusiveWindow}=await import('../src/mcp/timeinput.ts')
const {analyticalWindow,setWindowDataThrough,parseTimeWindow}=await import('../src/core/timewindow.ts')
const {ToolLimiter}=await import('../src/mcp/ratelimit.ts')
const {toolError}=await import('../src/mcp/toolerror.ts')
const {wrapTools,registerTools,clearToolAnswers,auditToolRefusal}=await import('../src/mcp/tools.ts')
const {requestedToolWindow,auditClient}=await import('../src/core/toolcontext.ts')
const {readToolAudit,pruneToolAudit,writeToolAudit}=await import('../src/mcp/toolaudit.ts')
const {all,db}=await import('../src/core/db.ts')
after(()=>{db.close();rmSync(dir,{recursive:true,force:true})})
for(const period of PERIODS) test(`shared schema accepts ${period}`,()=>assert.equal(timeInput.parse({period}).period,period))
for(const input of [{period:'Nov 2024 to Nov 2025'},{from:'2024-02-30',to:'2024-03-01'},{from:'2024-2-01',to:'2024-03-01'},{from:'2024-01-01'},{from:'2024-02-02',to:'2024-02-01'},{from:'2020-01-01',to:'2025-01-01'},{from:'2999-01-01',to:'2999-01-02'},{period:'today',from:'2024-01-01',to:'2024-01-02'},{period:'today',when:'yesterday'},{compare_from:'2024-01-01'},{compare:'none',compare_from:'2024-01-01',compare_to:'2024-01-02'}]) test(`shared schema rejects ${JSON.stringify(input)}`,()=>assert.equal(timeInput.safeParse(input).success,false))
test('inclusive dates allow leap day and exactly 1500 days',()=>{
    assert.ok(timeInput.safeParse({from:'2024-02-29',to:'2024-03-01'}).success)
    const to=new Date(Date.parse('2020-01-01')+1499*86400000).toISOString().slice(0,10)
    assert.ok(timeInput.safeParse({from:'2020-01-01',to}).success)
})
test('calendar presets, literal days and rolling windows honor UTC and dataThrough',()=>{
    const now=new Date('2026-01-01T12:00:00Z'),through='2025-12-29'
    const span=(p:string)=>inclusiveWindow(analyticalWindow(p,now,through)!)
    assert.deepEqual(span('last_month'),{from:'2025-12-01',to:'2025-12-31'})
    assert.deepEqual(span('last_quarter'),{from:'2025-10-01',to:'2025-12-31'})
    assert.deepEqual(span('last_year'),{from:'2025-01-01',to:'2025-12-31'})
    assert.deepEqual(span('last_week'),{from:'2025-12-22',to:'2025-12-28'})
    assert.deepEqual(span('last_7_days'),{from:'2025-12-23',to:'2025-12-29'})
    assert.deepEqual(span('today'),{from:'2026-01-01',to:'2026-01-01'})
    assert.deepEqual(span('yesterday'),{from:'2025-12-31',to:'2025-12-31'})
    assert.deepEqual(span('this_month'),{from:'2026-01-01',to:'2026-01-01'})
    for(const period of PERIODS) assert.ok(analyticalWindow(period,now,through),period)
})
test('deprecated when still parses times; failures enumerate typed alternatives',()=>{
    assert.equal(resolveTime({when:'yesterday afternoon'}).precision,'part-of-day')
    assert.throws(()=>resolveTime({when:'Nov 2024 to Nov 2025'}),error=>PERIODS.every(p=>(error as Error).message.includes(p)) && /YYYY-MM-DD.*2024-11-01/.test((error as Error).message))
    assert.throws(()=>parseTimeWindow('nonsense'),/last_4_years/)
})
test('token bucket burst, refill, heavy cost and hour budget',()=>{
    let now=0;const limiter=new ToolLimiter(60,600,4,()=>now)
    for(let i=0;i<12;i++)limiter.acquire('u','t','top_pains')()
    assert.throws(()=>limiter.acquire('u','t','light'),/per-minute budget \(60 units.*1 seconds/)
    now=1000;limiter.acquire('u','t','light')()
    now=61000;for(let i=0;i<60;i++)limiter.acquire('u','t','light')()
    const hourly=new ToolLimiter(1000,5,4,()=>now)
    hourly.acquire('u','t','top_pains')()
    assert.throws(()=>hourly.acquire('u','t','light'),/720 seconds/)
    now+=720000;hourly.acquire('u','t','light')()
})
test('concurrency is per user across tokens; release is idempotent; token budget spans users',()=>{
    const limiter=new ToolLimiter(60,600,4)
    const release=Array.from({length:4},(_,i)=>limiter.acquire('U@X.COM',`t${i}`,'light'))
    assert.throws(()=>limiter.acquire('u@x.com','new','light'),/Too many calls at once/)
    release[0]();release[0]();limiter.acquire('u@x.com','new','light')()
    release.slice(1).forEach(r=>r())
    const token=new ToolLimiter(1,600,4)
    token.acquire('u','same','light')()
    assert.throws(()=>token.acquire('other','same','light'),/Rate limit/)
})
for(const [kind,message] of [['capacity','Bridge [at foo (/root/lens-engine/src/core/a.ts:646:28)] Code: 241. DB::Exception: Query memory limit exceeded SELECT secret'],['unavailable','PostHog fetch failed /root/private'],['not_found','No client matches Private Bank'],['internal','secret SQL SELECT * FROM sensitive']]) test(`error ${kind} is actionable and hides internals`,()=>{
    const mapped=toolError(new Error(message),'test','safe-id')
    assert.equal(mapped.kind,kind);assert.equal(mapped.result.isError,true)
    const text=mapped.result.content[0].text
    assert.match(text,/Correlation id: safe-id/);assert.doesNotMatch(text,/Bridge|DB::Exception|\/root|SELECT|646|Private Bank|Code: 241/)
})
async function connect(server:McpServer) {
    const client=new Client({name:'contract',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a),client.connect(b)])
    return {client,close:async()=>{await client.close();await server.close()}}
}
test('every advertised windowed tool has typed inputs and short business-first description',async()=>{
    const server=new McpServer({name:'test',version:'1'});registerTools(server)
    const c=await connect(server)
    try {for(const tool of (await c.client.listTools()).tools) {
        const p=tool.inputSchema.properties || {}
        if(['when','days','weeks','from','to'].some(k=>k in p)) {
            for(const key of ['period','from','to','when'])assert.ok(key in p,`${tool.name}.${key}`)
            assert.match(tool.description!,/Time: period or from\/to \(YYYY-MM-DD\)/)
            assert.match((p.when as {description:string}).description,/Deprecated: use period or from\/to/)
            assert.ok(tool.description!.split(/[.!?](?:\s|$)/)[0].length+1<=200,tool.name)
        }
    }} finally {await c.close()}
})
test('SDK boundary validates, maps failures, resolves comparison and audits keys without values',async()=>{
    clearToolAnswers();setWindowDataThrough(()=> '2025-03-30')
    const server=new McpServer({name:'test',version:'1'})
    wrapTools(server,false,{who:'PM',email:'pm@x.com',tokenId:'token-id'}, {work: (_name,_args,_window,execute)=>({promise:execute()})})
    let seen:unknown
    server.registerTool('aggregate_events',{description:'Counts work.',inputSchema:{when:z.string().optional(),client:z.string(),compare:z.enum(['previous','none']).optional(),compare_with:z.object({from:z.string(),to:z.string()}).optional()}},async args=>{
        seen=args;auditClient('resolved-123')
        return {content:[{type:'text',text:JSON.stringify({window:inclusiveWindow(requestedToolWindow()!)})}]}
    })
    server.registerTool('failure',{description:'Fails.',inputSchema:{}},async()=>{throw new Error('Bridge /root/private.ts DB::Exception: memory limit exceeded')})
    const c=await connect(server)
    try {
        const r=await c.client.callTool({name:'aggregate_events',arguments:{client:'Private Bank',from:'2024-02-01',to:'2024-02-29',compare_from:'2024-01-01',compare_to:'2024-01-29'}})
        assert.ok(!r.isError);assert.deepEqual(seen,{client:'Private Bank',when:'2024-02-01 to 2024-02-29',compare_with:{from:'2024-01-01',to:'2024-01-29'}})
        const bad=await c.client.callTool({name:'aggregate_events',arguments:{client:'Private Bank',period:'wrong'}})
        assert.equal(bad.isError,true);assert.match(JSON.stringify(bad),/Correlation id/)
        const failure=await c.client.callTool({name:'failure',arguments:{}})
        assert.equal(failure.isError,true);assert.doesNotMatch(JSON.stringify(failure),/Bridge|DB::Exception|\/root/)
        const rows=readToolAudit(10) as Record<string,unknown>[]
        assert.equal(rows.length,3)
        const good=rows.find(r=>r.is_error===0)!
        assert.equal(good.token_id,'token-id');assert.equal(good.user_email,'pm@x.com')
        assert.deepEqual(JSON.parse(String(good.resolved_window)),{from:'2024-02-01',to:'2024-02-29'})
        assert.equal(good.client_ids,'["resolved-123"]')
        assert.doesNotMatch(JSON.stringify(rows),/Private Bank|private.ts|DB::Exception/)
        assert.deepEqual(JSON.parse(String(good.argument_keys)),['client','compare_from','compare_to','from','to'])
    }finally{await c.close();setWindowDataThrough(()=>undefined)}
})
test('audit retention deletes only old metadata',()=>{
    writeToolAudit({at:'2000-01-01T00:00:00.000Z',user_email:'x',token_id:'id',tool:'old',argument_keys:[],client_ids:[],duration_ms:1,result_chars:1,is_error:false,privacy_mode:'open',correlation_id:'old'})
    pruneToolAudit(Date.now(),90)
    assert.equal(all("SELECT * FROM tool_audit WHERE tool='old'").length,0)
    assert.ok(readToolAudit().length>=3)
})
test('day-count core queries use the explicit UTC range, including exclusive SQL end',async t=>{
    const {config}=await import('../src/core/config.ts')
    const oldKey=config.posthog.personalApiKey
    config.posthog.personalApiKey='test-key'
    t.after(()=>{config.posthog.personalApiKey=oldKey})
    const {screenUsage}=await import('../src/core/usage.ts')
    const {toolContext}=await import('../src/core/toolcontext.ts')
    const seen:Record<string,unknown>[]=[]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{
        const q=JSON.parse(String(init?.body)).query
        seen.push(q.values)
        return Response.json({columns:[],results:[]})
    })
    const window=resolveTime({from:'2024-02-01',to:'2024-02-29'})
    const result=await toolContext.run({window,clients:new Set()},()=>screenUsage('/invoices',{days:29}))
    assert.equal(result.window?.from,'2024-02-01T00:00:00.000Z')
    assert.equal(result.window?.to,'2024-03-01T00:00:00.000Z')
    assert.ok(seen.length>=5)
    for(const values of seen) {assert.equal(values.from,'2024-02-01T00:00:00.000Z');assert.equal(values.to,'2024-03-01T00:00:00.000Z')}
})
test('job executions are counted and audited, heavy calls exhaust the shared user budget across tokens',async t=>{
    t.mock.method(console,'error',()=>{})
    clearToolAnswers()
    let runs=0
    const servers=await Promise.all(['one','two'].map(async token=>{
        const server=new McpServer({name:'test',version:'1'})
        wrapTools(server,false,{who:'limits',email:'limits@x.com',tokenId:token}, {work: (_name,_args,_window,execute)=>({promise:execute()})})
        server.registerTool('top_pains',{inputSchema:{when:z.string().optional()}},async()=>{runs++;auditClient('client-id');return {content:[{type:'text',text:'ok'}]}})
        return connect(server)
    }))
    try {
        for(let i=0;i<12;i++)assert.ok(!(await servers[i%2].client.callTool({name:'top_pains',arguments:{period:'last_7_days'}})).isError)
        const rejected=await servers[1].client.callTool({name:'top_pains',arguments:{period:'last_7_days'}})
        assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/Rate limit:.*try again in.*Correlation id/)
        assert.equal(runs,12)
        const rows=all<Record<string,unknown>>("SELECT * FROM tool_audit WHERE user_email='limits@x.com'")
        assert.equal(rows.length,13);assert.equal(rows.filter(r=>r.is_error===1).length,1)
        assert.equal(rows.at(-1)?.error_kind,'rate_limit')
        for(const row of rows.filter(r=>!r.is_error))assert.equal(row.client_ids,'["client-id"]')
    }finally {await Promise.all(servers.map(c=>c.close()))}
})
test('admin JSON audit endpoint denies non-admins and bounds pagination',async()=>{
    const {handleAdmin}=await import('../src/service/admin.ts')
    for(const role of ['watch','admin'] as const) {
        let status=0,body=''
        const res={writeHead:(code:number)=>{status=code},end:(value:string)=>{body=value}}
        await handleAdmin({method:'GET'} as never,res as never,new URL('https://lens/replays/admin/api/tool-audit?limit=2'),{email:'admin@x.com',name:'Admin',role,posthog_admin:false,in_replay_project:true,session:'session'})
        assert.equal(status,role==='admin'?200:403)
        if(role==='admin') {const value=JSON.parse(body);assert.equal(value.audit.length,2);assert.doesNotMatch(body,/Private Bank|DB::Exception/)}
    }
})
test('privacy guard refusals are budgeted and audited with safe keys and correlation ids',()=>{
    const {isError,content}=auditToolRefusal('find_trade',['client'],{isError:true,content:[{type:'text',text:'Use a client codename.'}]},{who:'guard',email:'guard@x.com',tokenId:'guard-id'}) as {isError:boolean;content:{text:string}[]}
    assert.equal(isError,true);assert.match(content.at(-1)!.text,/Correlation id/)
    const row=(readToolAudit(1) as Record<string,unknown>[])[0]
    assert.equal(row.error_kind,'privacy_refused');assert.equal(row.argument_keys,'["client"]')
    assert.equal(row.client_ids,'[]');assert.ok(Number(row.result_chars)>0)
})
test('returned upstream execution errors also withhold arbitrary paths and diagnostics',async t=>{
    t.mock.method(console,'error',()=>{})
    const server=new McpServer({name:'test',version:'1'})
    wrapTools(server,false,{who:'upstream-error',tokenId:'upstream-error'})
    server.registerTool('returned_failure',{inputSchema:{}},async()=>({isError:true,content:[{type:'text',text:'Unexpected backend error /opt/lens/queries.sql:42 private query plan'}]}))
    const c=await connect(server)
    try {
        const result=await c.client.callTool({name:'returned_failure',arguments:{}})
        assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Correlation id/)
        assert.doesNotMatch(JSON.stringify(result),/\/opt|queries.sql|query plan/)
    }finally{await c.close()}
})


test('non-job cache hits still consume budget and produce separate audit rows', async () => {
    clearToolAnswers()
    let runs=0
    const server=new McpServer({name:'test',version:'1'})
    wrapTools(server,false,{who:'cached-light',tokenId:'cached-light'})
    server.registerTool('screen_usage',{inputSchema:{}},async()=>{runs++;auditClient('cached-client');return {content:[{type:'text',text:'cached'}]}})
    const c=await connect(server)
    try {
        for(let i=0;i<3;i++) assert.ok(!(await c.client.callTool({name:'screen_usage',arguments:{}})).isError)
        assert.equal(runs,1)
        const rows=all<Record<string,unknown>>("SELECT * FROM tool_audit WHERE user_email='cached-light'")
        assert.equal(rows.length,3)
        for(const row of rows) assert.equal(row.client_ids,'["cached-client"]')
    } finally {await c.close()}
})

test('error diagnostics are safe in every privacy mode; raw details use only a private credential-redacted file',async t=>{
 const {setAnonymise}=await import('../src/core/anonymise.ts')
 const {posthogFailure}=await import('../src/mcp/posthog-error.ts')
 const {readFileSync,statSync}=await import('node:fs')
 const logs:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>{logs.push(args)})
 const raw='SELECT email, amount FROM private_table; alice@example.com 999999 /root/secret/query.sql Bearer credential-secret token=token-secret'
 try {
  for(const mode of ['open','standard','private'] as const) {
   setAnonymise({mode});toolError(Error(raw),'test','diagnostic-'+mode);posthogFailure(raw,500,undefined,'upstream-'+mode)
  }
  assert.doesNotMatch(JSON.stringify(logs),/SELECT|alice|999999|\/root|credential-secret|token-secret/)
  assert.ok(logs.every(args=>(args[1] as any).correlation_id && (args[1] as any).tool && (args[1] as any).error_kind && 'http_status' in (args[1] as any)))
  process.env.LENS_DEBUG_ERRORS_FILE=join(dir,'errors.log')
  process.env.LENS_TEST_SECRET='bare-upstream-credential'
  toolError(Error(raw+' bare-upstream-credential'),'test','private-file')
  const text=readFileSync(process.env.LENS_DEBUG_ERRORS_FILE,'utf8')
  assert.match(text,/private-file.*SELECT/);assert.doesNotMatch(text,/credential-secret|token-secret|bare-upstream-credential/)
  assert.equal(statSync(process.env.LENS_DEBUG_ERRORS_FILE).mode & 0o777,0o600)
 }finally{delete process.env.LENS_DEBUG_ERRORS_FILE;delete process.env.LENS_TEST_SECRET;setAnonymise({mode:'standard'})}
})

test('unknown tool calls are accounted and audited in all privacy modes, with normal RPC errors',async()=>{
 const {setAnonymise}=await import('../src/core/anonymise.ts')
 const {guardTransport,registryOf}=await import('../src/mcp/anonymise.ts')
 try {
  for(const mode of ['open','standard','private'] as const) {
   setAnonymise({mode})
   const who='unknown-'+mode,server=new McpServer({name:who,version:'1'})
   const caller={who,tokenId:who};wrapTools(server,false,caller)
   server.registerTool('known',{inputSchema:{}},async()=>({content:[]}))
   const client=new Client({name:who,version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
   await server.connect(a);guardTransport(a,registryOf(server),(name,keys,result)=>auditToolRefusal(name,keys,result,caller));await client.connect(b)
   try {
    for(const name of ['unknown-private-value',42,null,'']) await assert.rejects(client.callTool({name:name as never,arguments:{secret:'do not audit'}}),/Unknown tool/)
    const rows=all<Record<string,unknown>>('SELECT * FROM tool_audit WHERE user_email=?',who)
    assert.equal(rows.length,4);assert.ok(rows.every(row=>row.error_kind==='unknown_tool' && row.argument_keys==='[]'))
    assert.doesNotMatch(JSON.stringify(rows),/unknown-private-value|do not audit/)
   }finally{await client.close();await server.close()}
  }
 }finally{setAnonymise({mode:'standard'})}
})

test('error logs keep the error type and a cleaned message: amounts, people, paths and query text never logged', async (t) => {
    const lines: string[] = []
    t.mock.method(console, 'error', (...a: unknown[]) => { lines.push(JSON.stringify(a)) })
    const { errorDiagnostic } = await import('../src/core/errordiagnostics.ts')
    errorDiagnostic(new Error('Counterparty limit exceeded: 250000.00 USD for jane.doe@client07.example at /srv/lens/src/core/tasks.ts:695:60\nHogQL: SELECT secret FROM events'), 'dialog_friction', 'internal', 'cid')
    const line = lines.join('\n')
    assert.match(line, /Counterparty limit exceeded/); assert.match(line, /"error_type":"Error"/)
    for (const leak of ['250000', 'jane.doe', '/srv/lens', 'SELECT secret']) assert.ok(!line.includes(leak), leak)
})

test('core input checks use safe typed validation messages with contract help', async () => {
 const {ToolInputError}=await import('../src/core/toolinputerror.ts')
 const {compareClientPatterns,clientActivityChanges}=await import('../src/core/clientpatterns.ts')
 const {workflowDialogsFromId,validateWorkflow}=await import('../src/core/workflows.ts')
 const {createDashboard}=await import('../src/core/dashboards.ts')
 const checks:[()=>unknown,RegExp][]=[
  [()=>compareClientPatterns({months:49}),/Choose 1–48 months/],
  [()=>clientActivityChanges({limit:151}),/Invalid silence/],
  [()=>workflowDialogsFromId('private-invalid-id'),/Invalid discovered workflow id/],
  [()=>validateWorkflow({}),/Workflow name must/],
  [()=>createDashboard('owner',{kind:'private-kind',title:'a',params:{}}),/kind must be task_map, flow_time or posthog_chart/],
 ]
 for(const [call,expected] of checks) assert.throws(call,e=>{
  assert.ok(e instanceof ToolInputError)
  const mapped=toolError(e,'example','cid',{keys:['period'],example:{period:'last_7_days'}})
  assert.equal(mapped.kind,'validation');assert.match(mapped.result.content[0].text,expected)
  assert.match(mapped.result.content[0].text,/Example:.*last_7_days/);assert.match(mapped.result.content[0].text,/YYYY-MM-DD/)
  assert.doesNotMatch(mapped.result.content[0].text,/private-/);return true
 })
 assert.equal(toolError(new Error('Give issue_id, or error_type and error_message.'),'example','cid').kind,'internal')
})

test('defaults: 60 units a minute, 600 an hour, 8 calls at once; refusals name the limit', async () => {
  const {ToolLimiter}=await import('../src/mcp/ratelimit.ts')
  const saved=process.env.LENS_MCP_CALLS_PER_MINUTE
  delete process.env.LENS_MCP_CALLS_PER_MINUTE
  try {
    const l=new ToolLimiter(); assert.equal(l.minute,60); assert.equal(l.hour,600); assert.equal(l.concurrent,8)
    const running=Array.from({length:8},()=>l.acquire('a@example.invalid','t1','resolve_client'))
    assert.throws(()=>l.acquire('a@example.invalid','t1','resolve_client'),/Too many calls at once: 8 .*limit 8/)
    running.forEach(r=>r())
    const m=new ToolLimiter(10,600,8)
    m.acquire('b@example.invalid','t2','aggregate_events')(); m.acquire('b@example.invalid','t2','aggregate_events')()
    assert.throws(()=>m.acquire('b@example.invalid','t2','aggregate_events'),/per-minute budget \(10 units/)
  }
  finally { process.env.LENS_MCP_CALLS_PER_MINUTE=saved }
})
