import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
const dir=mkdtempSync(join(tmpdir(),'thin-lens-'))
Object.assign(process.env,{TRIAGE_DB:join(dir,'main.db'),APP_EVENTS_FILE:'config/app-events.reval.json',CLIENT_FROM_DISTINCT_ID:'3',POSTHOG_HOST:'http://fake-posthog',POSTHOG_PROJECT_ID:'7',POSTHOG_PERSONAL_API_KEY:'test-key',POSTHOG_PUBLIC_HOST:'https://ph.example',SERVICE_PUBLIC_URL:'https://lens.example',FEATURE_POSTHOG_MCP:'on',POSTHOG_MCP_URL:'http://fake-mcp',POSTHOG_MCP_API_KEY:'fake',POSTHOG_SURVEY_API_KEY:'fake',FEATURE_SURVEYS:'on'})
const {config}=await import('../src/core/config.ts')
const {matchClients,resolveClient,clearClientCache}=await import('../src/core/resolve.ts')
const {findSessions}=await import('../src/core/appevents.ts')
const {pinGraph,listPinned,unpinGraph,graphSchema}=await import('../src/core/pinned.ts')
const {pinnedHtml}=await import('../src/service/pinned.ts')
const {handleLive}=await import('../src/service/live.ts')
const {registerTools}=await import('../src/mcp/tools.ts')
const {serverInstructions,INSTRUCTIONS_LIMIT}=await import('../src/mcp/instructions.ts')
const {createJobDispatch}=await import('../src/mcp/jobtools.ts')
const {JobRunner}=await import('../src/core/jobs.ts')
const {DatabaseSync}=await import('node:sqlite')
const viewer={email:'pm@example.com',name:'PM',role:'watch'} as never
const roster=[{id:'SEM',name:'Sem Operations',events:210,last_seen:'2026-11-19T10:00:00Z',users:['SEMOPS'],emails:['different@example.com'],distinct_ids:['C1DEV|01|SEM|SEMOPS']}]
const payload=(value:unknown)=>JSON.parse(String((value as {content:{text:string}[]}).content[0].text).split('\n').slice(1).join('\n'))
function response(rows:Record<string,unknown>[]) {
    const columns=Object.keys(rows[0] || {})
    return Response.json({columns,results:rows.map(r=>columns.map(k=>r[k]))})
}
for(const name of ['sem ops','semops','Sem-Ops','SEM','sem_operations','Sem Operations','different@example.com','semops@example.com','C1DEV|01|SEM|SEMOPS'])test(`resolve_client normalises ${name}`,()=>{
    const [m]=matchClients(name,roster);assert.equal(m.id,'SEM');assert.equal(m.last_seen,roster[0].last_seen);assert.equal(m.events,210)
    if(/sem.?ops/i.test(name) && name!=='SEM')assert.equal(m.matched_user,'SEMOPS')
})
test('resolve_client reads live configured client/user expressions and caches at most ten minutes',async t=>{
    clearClientCache();let calls=0
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        calls++;const q=JSON.parse(String(init.body)).query
        assert.match(q.query,/splitByChar\('\|', toString\(distinct_id\)\)\[3\]/)
        assert.match(q.query,/splitByChar\('\|', toString\(distinct_id\)\)\[4\]/)
        assert.ok(q.values.from && q.values.to);return response(roster)
    })
    assert.equal((await resolveClient({text:'sem ops'}))[0].matched_user,'SEMOPS')
    await resolveClient({text:'SEM'});assert.equal(calls,1)
    const now=Date.now();t.mock.method(Date,'now',()=>now+600001)
    await resolveClient({text:'SEM'});assert.equal(calls,2)
})
test('resolve_client supports the configured client property instead of distinct-id extraction',async t=>{
    clearClientCache();const previous=config.properties.clientFromDistinctId;config.properties.clientFromDistinctId=0;t.after(()=>{config.properties.clientFromDistinctId=previous;clearClientCache()})
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{assert.match(JSON.parse(String(init.body)).query.query,/properties.client_id/);return response([{...roster[0],id:'C88'}])})
    assert.equal((await resolveClient({text:'c 88'}))[0].id,'C88')
})
const events=[
    {ts:'2026-11-18T09:00:00Z',distinct_id:'C1DEV|01|SEM|SEMOPS',user:'SEMOPS',dialog:'DlgLedger',name:'Chart of Accounts',tab:'Cash Positions',action:'OPEN',message:'',event:'PageView'},
    {ts:'2026-11-18T09:00:12Z',distinct_id:'C1DEV|01|SEM|SEMOPS',user:'SEMOPS',dialog:'messagebox',name:'UNKNOWN',tab:'',action:'CLICK',message:'Failed to save',event:'Event'}
]
const window={from:new Date('2025-11-20'),to:new Date('2026-11-20')}
test('find_sessions uses names, action text, user and bounded newest paging; returns both links and real recording offset',async t=>{
    let calls=0
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query;calls++
        if(q.query.includes('raw_session_replay_events'))return response([{session_id:'session-one',start:'2026-11-18T09:00:00Z',end:'2026-11-18T09:02:00Z'}])
        if(q.query.includes('GROUP BY sid')){
            assert.equal(q.values.screen,'cash positions');assert.equal(q.values.what,'failed to save');assert.equal(q.values.user,'semops')
            assert.match(q.query,/properties.dialog_name/);assert.match(q.query,/properties.tab_name/);assert.match(q.query,/properties.action_name/)
            assert.match(q.query,/HAVING countIf/);assert.ok(+new Date(q.values.to)-+new Date(q.values.from)<=7*86400000)
            return response([{sid:'session-one',last:events[1].ts},{sid:'session-two',last:events[0].ts}])
        }
        return response(events)
    })
    const result=await findSessions({clientId:'SEM',screen:'cash positions',what:'failed to save',user:'sem ops',limit:1,...window})
    const s=result.sessions[0];assert.equal(s.user,'SEMOPS');assert.equal(s.error_messages_in_session,1);assert.equal(s.recording,true)
    assert.match(s.replay_url,/https:\/\/ph.example\/project\/7\/replay\/session-one\?t=12/)
    assert.match(s.clip_url,/https:\/\/lens.example\/replays\?url=/);assert.match(decodeURIComponent(s.clip_url),/session-one\?t=12/)
    assert.ok(s.screens.includes('Cash Positions'));assert.equal(s.matched_actions[0].message,'Failed to save');assert.ok(calls>=3)
})
test('find_sessions explicitly reports missing recordings, validates cursors and the year bound',async t=>{
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        return response(q.query.includes('raw_session')?[]:q.query.includes('GROUP BY sid')?[{sid:'session-one',last:events[1].ts}]:events)
    })
    const result=await findSessions({clientId:'SEM',limit:1,...window});assert.match(result.note,/none have a recording/)
    assert.equal(result.sessions[0].recording,false);assert.ok(result.sessions[0].replay_url && result.sessions[0].clip_url)
    await assert.rejects(findSessions({clientId:'SEM',cursor:'bad',...window}),/next_cursor/)
    await assert.rejects(findSessions({clientId:'SEM',from:new Date('2020-01-01'),to:new Date()}),/one year/)
})
test('pin_graph validates size and lengths, persists immutable snapshots, safely renders, and enforces ownership',()=>{
    const input={title:'<script>bad</script>',note:'Saved <now>',chart:{type:'line' as const,x:['Jan','Feb'],series:[{name:'Events',values:[2,5]}]}}
    const saved=pinGraph(input,'pm@example.com');input.chart.series[0].values[0]=999
    assert.equal(listPinned()[0].chart.series[0].values[0],2)
    assert.equal(saved.saved_by,'pm@example.com');assert.ok(saved.saved_at)
    const html=pinnedHtml(viewer);assert.match(html,/&lt;script&gt;bad/);assert.match(html,/<svg role="img"/);assert.match(html,/does not refresh/)
    assert.throws(()=>unpinGraph(saved.id,'someone@example.com'),/owner or an admin/)
    assert.equal(unpinGraph(saved.id,'admin@example.com',true),true)
    assert.equal(unpinGraph(saved.id,'pm@example.com'),false)
    for(const chart of [ {...input.chart,x:Array(501).fill('x')}, {...input.chart,series:Array(21).fill(input.chart.series[0])}, {...input.chart,series:[{name:'bad',values:[1]}]}, {...input.chart,series:[{name:'bad',values:[NaN,2]}]} ])assert.equal(graphSchema.safeParse({...input,chart}).success,false)
    for(const type of ['table','bar'] as const){const s=pinGraph({...input,chart:{...input.chart,type}},'pm@example.com');assert.match(pinnedHtml(viewer), type==='bar'?/<rect /:/<table>/);unpinGraph(s.id,'pm@example.com')}
})
test('Live time endpoint reads fake PostHog directly and returns activity without tasks.db',async t=>{
    const queries:string[]=[]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query;queries.push(q.query)
        if(q.query.includes('AS client_name'))return response([{client:'SEM',client_name:'Sem Operations'}])
        return response([{client:'SEM',user:'SEMOPS',sid:'session-one',day:'2026-11-18',hour:9,actions:2,first:events[0].ts,last:events[1].ts,open_ms:12000,active_ms:12000}])
    })
    let status=0,body=''
    const res={writeHead:(s:number)=>{status=s},end:(s:string)=>{body=s}} as ServerResponse
    await handleLive({method:'GET'} as IncomingMessage,res,new URL('http://lens/replays/live/api/time?from=2026-11-18&to=2026-11-18&client=SEM'),viewer)
    assert.equal(status,200);const data=JSON.parse(body);assert.equal(data.totals.actions,2);assert.equal(data.totals.active_s,12);assert.equal(data.clients[0].client_id,'SEM')
    assert.ok(queries.length>0);assert.match(queries[0],/splitByChar/);assert.ok(!existsSync(join(dir,'tasks.db')))
})
test('MCP publishes only retained tools and pin/list/delete and surveys work through the real SDK boundary',async t=>{
    t.mock.method(globalThis,'fetch',async()=>Response.json({results:[]}))
    const server=new McpServer({name:'test',version:'1'});registerTools(server,undefined,{who:'pm@example.com',email:'pm@example.com',surveyRole:'launch'})
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        const names=(await client.listTools()).tools.map(t=>t.name)
        for(const name of ['data_guide','resolve_client','find_sessions','get_replay_link','pin_graph','list_pinned','unpin_graph','get_job_result'])assert.ok(names.includes(name))
        for(const name of ['aggregate_events','find_trade','watch_client','pin_dashboard','triage_ticket','session_story'])assert.ok(!names.includes(name))
        assert.ok(names.includes('list_surveys'))
        assert.ok(!(await client.callTool({name:'list_surveys',arguments:{}})).isError)
        const result=await client.callTool({name:'pin_graph',arguments:{title:'Usage',chart:{type:'table',x:['Today'],series:[{name:'Events',values:[10]}]}}})
        assert.ok(!result.isError);const {id,url}=payload(result);assert.match(url,/\/replays\/pinned#/)
        assert.equal(payload(await client.callTool({name:'list_pinned',arguments:{}}))[0].title,'Usage')
        assert.ok(payload(await client.callTool({name:'unpin_graph',arguments:{id}})).deleted)
        assert.ok((await client.callTool({name:'pin_graph',arguments:{title:'Bad',chart:{type:'line',x:[1,2],series:[{name:'bad',values:[1]}]}}})).isError)
    } finally {await client.close();await server.close()}
})
test('posthog_exec allows PostHog replay and person tools without masking',async t=>{
    const seen:string[]=[]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        if(init.method==='DELETE')return new Response(null,{status:202})
        const body=JSON.parse(String(init.body))
        if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'ph',version:'1'}}})
        if(body.method==='notifications/initialized')return new Response(null,{status:202})
        seen.push(body.params.arguments.command)
        return Response.json({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:'SEMOPS user@example.com USD 250000'}]}})
    })
    const server=new McpServer({name:'test',version:'1'});registerTools(server)
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        for(const name of ['session-recording-get','persons-get']){
            const result=await client.callTool({name:'posthog_exec',arguments:{command:`call ${name} {"id":"one"}`}})
            assert.ok(!result.isError);assert.match(JSON.stringify(result),/SEMOPS user@example.com USD 250000/)
        }
        assert.equal(seen.length,2)
    } finally {await client.close();await server.close()}
})
test('get_replay_link retains both links when MP4 rendering fails',async()=>{
    const server=new McpServer({name:'test',version:'1'});registerTools(server,undefined,undefined,false,{render:async()=>{throw Error('renderer unavailable')},record:async()=>{}})
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        const result=await client.callTool({name:'get_replay_link',arguments:{session_id:'session-one',start_s:12}})
        const data=payload(result);assert.match(data.replay_url,/session-one\?t=12/);assert.match(data.clip_url,/\/replays\?url=/)
    } finally {await client.close();await server.close()}
})
test('long PostHog calls return a job handle and can be polled, with owner isolation',async()=>{
    const db=new DatabaseSync(':memory:'),runner=new JobRunner(db),dispatch=createJobDispatch({who:'owner'},{runner,budgetMs:5})
    let finish!:(v:unknown)=>void
    const pending=new Promise(resolve=>{finish=resolve})
    const started=performance.now(),job=await dispatch.execute('posthog_exec',{command:'call query-trends {}'},undefined,undefined,async()=>pending)
    assert.ok(performance.now()-started<500);assert.ok(job instanceof Object && 'id' in job)
    if(!('id' in job))throw Error('No job')
    finish({content:[{type:'text',text:'raw@example.com'}]});await new Promise(resolve=>setImmediate(resolve))
    const polled=await dispatch.poll(job.id as string);assert.match(JSON.stringify(polled.result),/raw@example.com/)
    await assert.rejects(createJobDispatch({who:'other'},{runner,budgetMs:1}).poll(job.id as string),/Unknown or expired/)
    runner.close();db.close()
})
test('instructions and tool descriptions stay short and direct',()=>{
    const instructions=serverInstructions();assert.ok(instructions.length<=INSTRUCTIONS_LIMIT)
    for(const phrase of ['posthog_exec','tools / info <tool> / call <tool> <json>','resolve_client','find_sessions','pin_graph','both'])assert.ok(instructions.includes(phrase))
    assert.doesNotMatch(instructions,/private|mask|aggregate_events|reval_brief/)
    const descriptions:string[]=[]
    const server={registerTool:(_name:string,cfg:{description:string})=>{descriptions.push(cfg.description)}} as unknown as McpServer
    registerTools(server);assert.ok(descriptions.length>=8);assert.ok(descriptions.every(s=>s.length<2048))
})
after(()=>rmSync(dir,{recursive:true,force:true}))

test('find_sessions recorded_only keeps only sessions that have a recording, and the default does not filter',async t=>{
    const seen:string[]=[]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('GROUP BY sid')){seen.push(q.query);return response([])}
        return response([])
    })
    const window={from:new Date('2026-11-12T00:00:00Z'),to:new Date('2026-11-19T00:00:00Z')}
    await findSessions({clientId:'SEM',limit:1,recordedOnly:true,...window})
    await findSessions({clientId:'SEM',limit:1,...window})
    assert.match(seen[0]!,/IN \(SELECT session_id FROM raw_session_replay_events/)
    assert.doesNotMatch(seen[1]!,/raw_session_replay_events/)
})

test('resolve_client finds a client with no events in the asked-for dates and marks it outside_window',async t=>{
    const {resolveClient}=await import('../src/core/resolve.ts')
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        // The asked-for window (August 2025) has no events; the wide lookback does.
        if(String(q.values.from).startsWith('2025-08'))return response([])
        return response([{id:'RIB',name:'RIB',events:42,last_seen:'2026-11-14T10:00:00Z',users:['RIBTRADER'],emails:[],distinct_ids:['C1DEV|01|RIB|RIBTRADER']}])
    })
    const m=await resolveClient({text:'rib',from:new Date('2025-08-01'),to:new Date('2025-09-01')}) as {id:string;outside_window?:boolean}[]
    assert.equal(m[0]?.id,'RIB'); assert.equal(m[0]?.outside_window,true)
})

test('find_sessions retains action screens, prioritises target matches and attaches only nearby configured outcomes',async t=>{
    const timeline=[
        {...events[0],ts:'2026-11-18T09:00:00Z',name:'Other',action:'CLICK',message:'Save'},
        {...events[1],ts:'2026-11-18T09:00:01Z',dialog:'toast',message:'Missing account'},
        {...events[0],ts:'2026-11-18T09:00:12Z',action:'CLICK',message:'Save'},
        {...events[1],ts:'2026-11-18T09:00:13Z',dialog:'toast',message:'Trade Id Updated'},
        {...events[0],ts:'2026-11-18T09:00:14Z',name:'Other',action:'CLICK',message:'Save'},
        {...events[1],ts:'2026-11-18T09:00:50Z',message:'Failed too late'},
    ]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('raw_session'))return response([{session_id:'one',start:'2026-11-18T08:59:50Z',end:'2026-11-18T09:00:40Z'}])
        return response(q.query.includes('GROUP BY sid')?[{sid:'one',last:timeline.at(-1)!.ts}]:timeline)
    })
    const {sessions:[s]}=await findSessions({clientId:'SEM',screen:'Chart of Accounts',what:'Save',...window})
    assert.equal(s.matches_on_target_screen,1);assert.equal(s.matches_elsewhere,2)
    assert.deepEqual(s.matched_actions[0],{at:timeline[2].ts,event:'PageView',action:'CLICK',message:'Save',screen:'Chart of Accounts',dialog_id:'DlgLedger',on_target_screen:true,outcome:{at:timeline[3].ts,text:'Trade Id Updated',is_error:false}})
    assert.equal(s.matched_actions[1].on_target_screen,false);assert.equal(s.matched_actions[1].outcome?.is_error,true)
    assert.equal(s.matched_actions[2].outcome,null)
    assert.equal(s.session_start,timeline[0].ts);assert.equal(s.session_end,timeline.at(-1)!.ts)
    assert.equal(s.recording_start,'2026-11-18T08:59:50.000Z');assert.equal(s.recording_end,'2026-11-18T09:00:40.000Z');assert.equal(s.recording_duration_s,50)
    assert.equal(s.offset_s,22);assert.match(s.replay_url,/t=22/)
    assert.equal(s.events_in_session,6);assert.equal(s.error_messages_in_session,2)
})

test('find_sessions bounds actions, screens and serialized pages without skipping the next session',async t=>{
    const hits=Array.from({length:21},(_,i)=>({sid:`session-${20-i}`,last:`2026-11-18T09:00:${String(40-i).padStart(2,'0')}Z`}))
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('raw_session'))return response([])
        if(q.query.includes('GROUP BY sid')){assert.match(q.query,/LIMIT 21/);return response(hits)}
        return response(Array.from({length:30},(_,i)=>({...events[0],name:`Screen ${i}`,tab:`Tab ${i}`,message:'Save '+ 'x'.repeat(400)})))
    })
    const result=await findSessions({clientId:'SEM',limit:30,...window})
    assert.equal(result.truncated_by_size,true);assert.ok(result.sessions.length>0 && result.sessions.length<20)
    const {jsonResult}=await import('../src/mcp/result.ts')
    assert.ok(JSON.stringify(jsonResult('Sessions',result)).length<=20000)
    const s=result.sessions[0];assert.equal(s.matched_actions.length,10);assert.equal(s.matched_actions_total,30);assert.equal(s.matched_actions_truncated,true)
    assert.equal(s.screens.length,15);assert.ok(s.screens_total>15)
    const last=hits[result.sessions.length-1];assert.equal(result.next_cursor,`${last.last}|${last.sid}`)
    assert.equal(s.recording_start,null);assert.equal(s.recording_end,null);assert.equal(s.recording_duration_s,null)
})

test('data_guide exposes configured version, identity, coverage cache and SQL; resolve_client scopes counts through MCP',async t=>{
    clearClientCache()
    const {clearPosthogCache}=await import('../src/core/posthog.ts');clearPosthogCache()
    let coverageCalls=0,rosterCalls=0
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('AS data_starts')){coverageCalls++;return response([{data_starts:'2025-11-15T08:00:05Z',data_ends:'2026-11-14T17:03:14Z'}])}
        if(q.query.endsWith('LIMIT 1'))return response([{distinct_id:'C1DEV|01|SEM|SEMOPS'}])
        rosterCalls++;assert.match(q.query,/groupArray\(tuple\(user,email,did,n\)\)/)
        return response([{...roster[0],user_event_counts:[['SEMOPS','different@example.com','C1DEV|01|SEM|SEMOPS',64],['SEMOTHER','','C1DEV|01|SEM|SEMOTHER',146]]}])
    })
    const server=new McpServer({name:'test',version:'1'});registerTools(server)
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        const guide=payload(await client.callTool({name:'data_guide',arguments:{}}))
        assert.equal(guide.properties.version.name,'title');assert.equal(guide.events.screen,'PageView')
        assert.equal(guide.identity.CLIENT_FROM_DISTINCT_ID,3);assert.equal(guide.identity.separator,'|')
        assert.equal(guide.identity.client.part,3);assert.equal(guide.identity.client.value,'SEM')
        assert.equal(guide.identity.user.part,4);assert.equal(guide.identity.user.value,'SEMOPS')
        assert.match(guide.examples[1],/OPEN/);assert.match(guide.examples[2],/properties.title/)
        const result=payload(await client.callTool({name:'resolve_client',arguments:{query:'SEMOPS',from:'2026-11-18',to:'2026-11-18'}}))
        assert.equal(result.matches[0].client_events,210);assert.equal(result.matches[0].user_events,64)
        assert.equal(result.matches[0].events,undefined);assert.deepEqual(result.coverage,guide.coverage)
        assert.equal(rosterCalls,1);assert.equal(coverageCalls,1)
        const now=Date.now();t.mock.method(Date,'now',()=>now+600001)
        await client.callTool({name:'data_guide',arguments:{}});assert.equal(coverageCalls,2)
    } finally {await client.close();await server.close();clearClientCache();clearPosthogCache()}
})

test('rate limit errors retain text and expose retry seconds and the specific limit at the MCP boundary',async t=>{
    const {ToolLimiter,toolLimiter}=await import('../src/mcp/ratelimit.ts')
    for(const [limit,limiter] of [['minute',new ToolLimiter(1,100,10,()=>0)],['hour',new ToolLimiter(100,1,10,()=>0)],['concurrent',new ToolLimiter(100,100,1,()=>0)]] as const){
        const release=limiter.acquire('test','token','data_guide');if(limit!=='concurrent')release()
        t.mock.method(toolLimiter,'acquire',(...args:Parameters<typeof toolLimiter.acquire>)=>limiter.acquire(...args))
        const server=new McpServer({name:'test',version:'1'});registerTools(server,undefined,{who:'test',tokenId:'token'} as never)
        const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
        try {
            const result=await client.callTool({name:'data_guide',arguments:{}})
            assert.equal(result.isError,true)
            assert.deepEqual(result.structuredContent,{error_kind:'rate_limit',retry_after_seconds:limit==='minute'?60:limit==='hour'?3600:1,limit})
            assert.match(JSON.stringify(result.content),/try again in/)
        } finally {release();await client.close();await server.close();t.mock.restoreAll()}
    }
})

test('find_sessions respects the ten-event outcome boundary, configured outcome rules and screen fallback',async t=>{
    const row=(second:number,extra:Record<string,unknown>={})=>({...events[0],ts:`2026-11-18T09:00:${String(second).padStart(2,'0')}Z`,action:'CLICK',message:'',...extra})
    const timeline=[row(0,{message:'Save'}),...Array.from({length:10},(_,i)=>row(i+1)),row(11,{dialog:'toast',message:'Too far by event count'}),row(12,{message:'Save'}),row(13,{dialog:'messagebox',message:'No entry selected'}),row(14,{name:'',tab:'Fallback tab',message:'Save'}),row(15,{dialog:'toast',message:'Could not save'})]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        return response(q.query.includes('raw_session')?[]:q.query.includes('GROUP BY sid')?[{sid:'one',last:timeline.at(-1)!.ts}]:timeline)
    })
    const {sessions:[s]}=await findSessions({clientId:'SEM',what:'Save',...window})
    assert.equal(s.matched_actions[0].outcome,null)
    assert.equal(s.matched_actions[1].outcome?.is_error,false)
    assert.equal(s.matched_actions[2].outcome?.is_error,true);assert.equal(s.matched_actions[2].screen,'Fallback tab')
    assert.ok(!('on_target_screen' in s.matched_actions[0]));assert.equal(s.error_messages_in_session,1)
})

test('find_sessions keeps full session bounds and counts when the detail timeline is capped',async t=>{
    const summary={session_start:'2026-11-18T08:59:00Z',session_end:'2026-11-18T09:30:00Z',events_in_session:6000,error_messages_in_session:17}
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('raw_session'))return response([])
        if(q.query.includes('GROUP BY sid'))return response([{sid:'one',last:summary.session_end}])
        assert.match(q.query,/max\(timestamp\) OVER \(\) AS session_end/)
        assert.match(q.query,/countIf\(.*\) OVER \(\) AS error_messages_in_session/)
        return response(events.map(e=>({...e,...summary})))
    })
    const {sessions:[s]}=await findSessions({clientId:'SEM',...window})
    assert.equal(s.session_start,summary.session_start);assert.equal(s.session_end,summary.session_end)
    assert.equal(s.events_in_session,6000);assert.equal(s.error_messages_in_session,17)
})
