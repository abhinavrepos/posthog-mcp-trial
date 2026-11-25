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
const {config,posthogLinkHost}=await import('../src/core/config.ts')
config.properties.clientName=''
const {knownClients,matchClients,resolveClient,clearClientCache}=await import('../src/core/resolve.ts')
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
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('FROM person_distinct_ids'))return response([])
        calls++;assert.match(q.query,/splitByChar\('\|', toString\(distinct_id\)\)\[3\]/)
        assert.match(q.query,/splitByChar\('\|', toString\(distinct_id\)\)\[4\]/)
        assert.ok(q.values.from && q.values.to);return response([{id:'SEM',user:'SEMOPS',did:'C1DEV|01|SEM|SEMOPS',n:210,last_seen:roster[0].last_seen}])
    })
    assert.equal((await resolveClient({text:'sem ops'}))[0].matched_user,'SEMOPS')
    await resolveClient({text:'SEM'});assert.equal(calls,1)
    const now=Date.now();t.mock.method(Date,'now',()=>now+600001)
    await resolveClient({text:'SEM'});assert.equal(calls,2)
})
test('resolve_client tolerates null roster fields and preserves per-user counts',async t=>{
    clearClientCache();t.after(clearClientCache)
    const rows=[{id:'SEM',user:null,did:null,n:99,last_seen:roster[0].last_seen},
        {id:'SEM',user:'SEMOPS',did:'C1DEV|01|SEM|SEMOPS',n:64,last_seen:roster[0].last_seen},
        {id:'SEM',user:'SEMOPS',did:'other-id',n:6,last_seen:roster[0].last_seen},
        {id:'SEM',user:null,did:null,n:null,last_seen:roster[0].last_seen}]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>response(
        JSON.parse(String(init.body)).query.query.includes('FROM person_distinct_ids')
            ? [{did:'other-id',email:'different@example.com'}] : rows))
    const clients=await knownClients()
    assert.deepEqual(clients[0].user_event_counts,[['','','','99'],['SEMOPS','','C1DEV|01|SEM|SEMOPS','64'],['SEMOPS','different@example.com','other-id','6'],['','','','']])
    assert.deepEqual(clients[0].users,['','SEMOPS']);assert.deepEqual(clients[0].emails,['','different@example.com'])
    for(const text of ['SEMOPS','different@example.com','C1DEV|01|SEM|SEMOPS']) {
        assert.equal((await resolveClient({text}))[0].user_events,70)
    }
})
test('resolve_client shares one roster query for windows within the same UTC days',async t=>{
    clearClientCache();t.after(clearClientCache);let calls=0
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{if(JSON.parse(String(init.body)).query.query.includes('FROM person_distinct_ids'))return response([]);calls++;return response([{id:'SEM',user:'SEMOPS',did:'one',n:210,last_seen:roster[0].last_seen}])})
    for(const minute of ['01','42']) await resolveClient({text:'SEM',from:new Date(`2026-11-18T08:${minute}:00Z`),to:new Date(`2026-11-20T12:${minute}:00Z`)})
    assert.equal(calls,1)
    await resolveClient({text:'SEM',from:new Date('2026-11-17T08:01:00Z'),to:new Date('2026-11-20T12:01:00Z')})
    assert.equal(calls,2)
})
test('resolve_client supports the configured client property instead of distinct-id extraction',async t=>{
    clearClientCache();const previous=config.properties.clientFromDistinctId;config.properties.clientFromDistinctId=0;t.after(()=>{config.properties.clientFromDistinctId=previous;clearClientCache()})
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{const q=JSON.parse(String(init.body)).query.query;if(q.includes('FROM person_distinct_ids'))return response([]);assert.match(q,/properties.client_id/);return response([{id:'C88',user:'SEMOPS',did:'one',n:210,last_seen:roster[0].last_seen}])})
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
    const result=await findSessions({detail:true,clientId:'SEM',screen:'cash positions',what:'failed to save',user:'sem ops',limit:1,...window})
    const s=result.sessions[0];assert.equal(s.user,'SEMOPS');assert.equal(s.error_messages_in_session,1);assert.equal(s.recording,true)
    assert.match(s.replay_url,/https:\/\/ph.example\/project\/7\/replay\/session-one\?t=7/)
    assert.match(s.clip_url,/https:\/\/lens.example\/replays\?url=/);assert.match(decodeURIComponent(s.clip_url),/session-one\?t=7/)
    assert.deepEqual(s.screens,['Chart of Accounts']);assert.equal(s.matched_actions[0].message,'Failed to save');assert.ok(calls>=3)
})
test('find_sessions explicitly reports missing recordings, validates cursors and the year bound',async t=>{
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        return response(q.query.includes('raw_session')?[]:q.query.includes('GROUP BY sid')?[{sid:'session-one',last:events[1].ts}]:events)
    })
    const result=await findSessions({detail:true,clientId:'SEM',limit:1,...window});assert.match(result.note,/none have a recording/)
    assert.equal(result.sessions[0].recording,false);assert.ok(result.sessions[0].replay_url && result.sessions[0].clip_url)
    await assert.rejects(findSessions({detail:true,clientId:'SEM',cursor:'bad',...window}),/next_cursor/)
    await assert.rejects(findSessions({detail:true,clientId:'SEM',from:new Date('2020-01-01'),to:new Date()}),/one year/)
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
test('public PostHog link settings never fall back to the internal API host',()=>{
    assert.equal(posthogLinkHost({POSTHOG_HOST:'http://web:8000',POSTHOG_ADDRESS:'ph.example,http://10.0.0.2'}),'https://ph.example')
    assert.equal(posthogLinkHost({POSTHOG_HOST:'http://localhost:8000',ADDRESSES:'10.0.0.2,ph.example'}),'http://10.0.0.2')
    assert.equal(posthogLinkHost({POSTHOG_HOST:'http://web:8000',POSTHOG_PUBLIC_HOST:'https://public',POSTHOG_LINK_URL:'https://links/'}),'https://links')
    assert.notEqual(posthogLinkHost({POSTHOG_HOST:'http://web:8000'}),'http://web:8000')
})
test('table rows preserve text, missing cells and escaped values in Pinned',()=>{
    const graph=pinGraph({title:'Rows',chart:{type:'table',rows:[{User:'<SEMOPS>',Events:12},{User:'Other'}]}},'pm@example.com')
    assert.deepEqual(graph.chart.series,[{name:'User',values:['<SEMOPS>','Other']},{name:'Events',values:[12,null]}])
    assert.match(pinnedHtml(viewer),/&lt;SEMOPS&gt;/)
    assert.equal(graphSchema.safeParse({title:'Bad',chart:{type:'table',rows:[{}]}}).success,false)
    unpinGraph(graph.id,'pm@example.com')
})
test('recording metadata uses the configured user part and clip failures hide snapshot HTTP codes',async t=>{
    const {recordingInfo}=await import('../src/core/recording-info.ts')
    const {createReplayWorker}=await import('../src/service/replays.ts')
    t.mock.method(globalThis,'fetch',async(url:unknown)=>String(url).includes('/query/') ? response([]) : Response.json({start_time:events[0].ts,end_time:events[1].ts,distinct_id:'C1DEV|01|SEM|SEMOPS'}))
    const info=await recordingInfo('session-one');assert.equal(info.user,'SEMOPS')
    const job={id:'failed',state:'queued' as const,owner:'pm@example.com',session_id:'session-one',start_s:0,length_s:30,info,created_at:Date.now()}
    const queue:import('../src/service/replays.ts').ReplayJob[]=[job]
    const work=createReplayWorker(queue,{render:async()=>{throw Error('Snapshot download for session-one → 500')},store:()=>{throw Error('must not store')},audit:()=>{},prune:()=>{}})
    work();await new Promise(resolve=>setImmediate(resolve))
    assert.equal((job as import('../src/service/replays.ts').ReplayJob).error,"PostHog can't load this recording's video (its files may have been deleted). Choose another replay.")
})
test('page renderers produce valid browser scripts and System opens a sign-in page',async()=>{
    const {handleAdmin}=await import('../src/service/admin.ts')
    const {handleConnect}=await import('../src/service/connect.ts')
    const {handleReplays}=await import('../src/service/replays.ts')
    const {liveHtml}=await import('../src/service/live.ts')
    const {surveysHtml}=await import('../src/service/surveyspage.ts')
    const {systemHtml}=await import('../src/service/system.ts')
    const admin={email:'admin@example.com',name:'Admin',role:'admin'} as never
    const pages=[pinnedHtml(admin),liveHtml(admin),surveysHtml(admin),systemHtml(admin)]
    for(const [path,handler] of [['/replays/admin',handleAdmin],['/replays/connect',handleConnect]] as const){
        let body=''
        const res={writeHead:()=>{},end:(text:string)=>{body=text}} as unknown as ServerResponse
        await handler({method:'GET'} as IncomingMessage,res,new URL('http://lens'+path),admin)
        pages.push(body)
    }
    let status=0,body=''
    await handleReplays({method:'GET',headers:{}} as IncomingMessage,{writeHead:(s:number)=>{status=s},end:(text:string)=>{body=text}} as ServerResponse,new URL('http://lens/replays/system'))
    assert.equal(status,200);assert.match(body,/Sign in to/);pages.push(body)
    for(const page of pages){
        assert.match(page,/<!doctype html>/)
        for(const script of page.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Function(script[1]))
    }
})
test('Live time endpoint reads fake PostHog directly and returns activity without tasks.db',async t=>{
    const queries:string[]=[]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query;queries.push(q.query)
        assert.match(q.query,/GROUP BY GROUPING SETS/)
        const base={d:'',h1:0,c:'',u:'',actions:2,people:1,sessions:1,clients:1,open_ms:12000,active_ms:12000}
        return response([base,{...base,c:'SEM',client_name:'Sem Operations',all_people:1,all_sessions:1,all_open_ms:12000,all_active_ms:12000,all_first:events[0].ts,all_last:events[1].ts}])
    })
    let status=0,body=''
    const res={writeHead:(s:number)=>{status=s},end:(s:string)=>{body=s}} as ServerResponse
    await handleLive({method:'GET'} as IncomingMessage,res,new URL('http://lens/replays/live/api/time?from=2026-11-18&to=2026-11-18&client=SEM'),viewer)
    assert.equal(status,200);const data=JSON.parse(body);assert.equal(data.totals.actions,2);assert.equal(data.totals.active_s,12);assert.equal(data.clients[0].client_id,'SEM')
    assert.equal(queries.length,1);assert.match(queries[0],/splitByChar/);assert.ok(!existsSync(join(dir,'tasks.db')))
})
test('MCP publishes only retained tools and pin/list/delete and surveys work through the real SDK boundary',async t=>{
    t.mock.method(globalThis,'fetch',async(url:unknown)=>Response.json(String(url).includes('/surveys/')?{results:[],next:null}:{results:[]}))
    const server=new McpServer({name:'test',version:'1'});registerTools(server,undefined,{who:'pm@example.com',email:'pm@example.com',surveyRole:'launch'})
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        const names=(await client.listTools()).tools.map(t=>t.name)
        for(const name of ['data_guide','resolve_client','find_sessions','get_replay_link','pin_graph','list_pinned','unpin_graph','get_job_result'])assert.ok(names.includes(name))
        for(const name of ['aggregate_events','find_trade','watch_client','pin_dashboard','triage_ticket','session_story'])assert.ok(!names.includes(name))
        assert.ok(names.includes('list_surveys'))
        assert.ok(!(await client.callTool({name:'list_surveys',arguments:{}})).isError)
        const result=await client.callTool({name:'pin_graph',arguments:{title:'Usage',chart:{type:'table',x:['Today'],series:[{name:'Events',values:[10]}]}}})
        assert.ok(!result.isError);const {id,url}=payload(result);assert.match(url,/^https:\/\/lens.example\/replays\/pinned#/)
        assert.equal(payload(await client.callTool({name:'list_pinned',arguments:{}}))[0].title,'Usage')
        assert.ok(payload(await client.callTool({name:'unpin_graph',arguments:{id}})).deleted)
        const table=await client.callTool({name:'pin_graph',arguments:{title:'Table rows',chart:{type:'table',rows:[{User:'SEMOPS',Events:12}]}}})
        assert.ok(!table.isError,JSON.stringify(table))
        const invalid=await client.callTool({name:'pin_graph',arguments:{title:'Invalid table',chart:{type:'table',rows:'not rows'}}})
        assert.ok(invalid.isError);assert.match(JSON.stringify(invalid),/rows|series/)

        assert.match(payload(table).url,/^https:\/\/lens.example\/replays\/pinned#/)
        await client.callTool({name:'unpin_graph',arguments:{id:payload(table).id}})
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
        const previous=process.env.CLIPS_PER_HOUR;process.env.CLIPS_PER_HOUR='1'
        try {
            const refused=payload(await client.callTool({name:'get_replay_link',arguments:{session_id:'session-one',start_s:0}}))
            assert.equal(refused.replay_url,'https://ph.example/project/7/replay/session-one?t=0')
            assert.match(refused.clip_url,/^https:\/\/lens.example\/replays\?url=/)
            assert.match(refused.reason,/limit/)
        } finally {if(previous===undefined)delete process.env.CLIPS_PER_HOUR;else process.env.CLIPS_PER_HOUR=previous}

    } finally {await client.close();await server.close()}
})
test('get_replay_link saves a rendered clip for the caller and returns both public links at zero offset',async()=>{
    const {storeClip,getClip,deleteClip}=await import('../src/service/replays.ts')
    const clip={name:'saved-test.mp4',file:'/synthetic.mp4',size_bytes:0,session_id:'session-save',start_offset_s:0,end_offset_s:30,video_duration_s:30,cached:true,render_s:0}
    const owner='pm@example.com'
    const server=new McpServer({name:'test',version:'1'});registerTools(server,undefined,{who:owner,email:owner,surveyRole:'view'},false,{render:async()=>clip,record:async(c,by)=>{storeClip(c,undefined,by)}})
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        const data=payload(await client.callTool({name:'get_replay_link',arguments:{session_id:'session-save',start_s:0,save:true}}))
        assert.equal(data.replay_url,'https://ph.example/project/7/replay/session-save?t=0')
        assert.equal(data.clip_url,'https://lens.example/replays?clip=saved-test.mp4')
        assert.deepEqual(getClip(clip.name)?.saved_by,[owner])
    } finally {deleteClip(clip.name);await client.close();await server.close()}
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
    assert.match(instructions,/"the year", "last year" or "all data".*data_guide coverage continuous_from\.\.continuous_to.*exact UTC bounds/)
    assert.match(instructions,/complete weeks use only fully covered weeks/)
    assert.match(instructions,/Resolve any person\/client phrase.*resolve_client before reinterpreting the question/);assert.match(instructions,/Report only what tools returned; no speculation about variation or significance/ )
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
    await findSessions({detail:true,clientId:'SEM',limit:1,recordedOnly:true,...window})
    await findSessions({detail:true,clientId:'SEM',limit:1,...window})
    assert.match(seen[0]!,/IN \(SELECT session_id FROM raw_session_replay_events/)
    assert.doesNotMatch(seen[1]!,/raw_session_replay_events/)
})

test('resolve_client finds a client with no events in the asked-for dates and marks it outside_window',async t=>{
    const {resolveClient}=await import('../src/core/resolve.ts')
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        // The asked-for window (August 2025) has no events; the wide lookback does.
        if(q.query.includes('FROM person_distinct_ids'))return response([])
        assert.doesNotMatch(q.query,/client_name|person\.properties/)
        assert.match(q.query,/GROUP BY id, user, did LIMIT 100000/)
        if(String(q.values.from).startsWith('2025-08'))return response([])
        return response([{id:'RIB',user:'RIBTRADER',did:'C1DEV|01|RIB|RIBTRADER',n:42,last_seen:'2026-11-14T10:00:00Z'}])
    })
    const m=await resolveClient({text:'rib',from:new Date('2025-08-01'),to:new Date('2025-09-01')}) as {id:string;outside_window?:boolean}[]
    assert.equal(m[0]?.id,'RIB'); assert.equal(m[0]?.outside_window,true)
})

test('find_sessions retains action screens, orders matches chronologically and attaches only nearby configured outcomes',async t=>{
    const timeline=[
        {...events[0],ts:'2026-11-18T09:00:00Z',name:'Other',action:'CLICK',message:'Save'},
        {...events[1],ts:'2026-11-18T09:00:01Z',name:'Other',dialog:'toast',message:'Missing account'},
        {...events[0],ts:'2026-11-18T09:00:12Z',action:'CLICK',message:'Save'},
        {...events[1],ts:'2026-11-18T09:00:13Z',name:'Chart of Accounts',dialog:'toast',message:'Trade Id Updated'},
        {...events[0],ts:'2026-11-18T09:00:14Z',name:'Other',action:'CLICK',message:'Save'},
        {...events[1],ts:'2026-11-18T09:00:50Z',message:'Failed too late'},
    ]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('raw_session'))return response([{session_id:'one',start:'2026-11-18T08:59:50Z',end:'2026-11-18T09:00:40Z'}])
        return response(q.query.includes('GROUP BY sid')?[{sid:'one',last:timeline.at(-1)!.ts}]:timeline)
    })
    const {sessions:[s]}=await findSessions({detail:true,clientId:'SEM',screen:'Chart of Accounts',what:'Save',...window})
    assert.equal(s.matches_on_target_screen,1);assert.equal(s.matches_elsewhere,2)
    assert.deepEqual(s.matched_actions.map((a:{at:string})=>a.at),[timeline[0].ts,timeline[2].ts,timeline[4].ts])
    const target=s.matched_actions[1]
    assert.equal(target.on_target_screen,true)
    assert.deepEqual(target.outcome,{at:timeline[3].ts,text:'Trade Id Updated',is_error:false,screen:'Chart of Accounts',dialog_id:'toast',after_s:1,basis:'same screen, before any other action'})
    assert.deepEqual(target.before,[{line:"09:00:00.000 CLICK 'Save' [Other]",dt_s:-12},{line:"09:00:01.000 MESSAGE is_error=true 'Missing account' [Other]",dt_s:-11}])
    assert.deepEqual(target.after,[{line:"09:00:13.000 MESSAGE is_error=false 'Trade Id Updated' [Chart of Accounts]",dt_s:1},{line:"09:00:14.000 CLICK 'Save' [Other]",dt_s:2},{line:"09:00:50.000 MESSAGE is_error=true 'Failed too late' [UNKNOWN]",dt_s:38}])
    assert.equal(s.matched_actions[0].on_target_screen,false);assert.equal(s.matched_actions[0].outcome?.is_error,true)
    assert.equal(s.matched_actions[2].outcome,null)
    assert.equal(s.session_start,timeline[0].ts);assert.equal(s.session_end,timeline.at(-1)!.ts)
    assert.equal(s.recording_start,'2026-11-18T08:59:50.000Z');assert.equal(s.recording_end,'2026-11-18T09:00:40.000Z');assert.equal(s.recording_duration_s,50)
    assert.equal(s.offset_s,17);assert.match(s.replay_url,/t=17/)
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
    const result=await findSessions({detail:true,clientId:'SEM',limit:30,...window})
    assert.equal(result.truncated_by_size,true);assert.ok(result.sessions.length>0 && result.sessions.length<20)
    const {jsonResult}=await import('../src/mcp/result.ts')
    assert.ok(JSON.stringify(jsonResult('Sessions',result)).length<=20000)
    const s=result.sessions[0];assert.ok(s.matched_actions.length>0 && s.matched_actions.length<=10);assert.equal(s.matched_actions_total,30);assert.equal(s.matched_actions_truncated,true)
    assert.equal(s.screens.length,15);assert.ok(s.screens_total>15)
    const last=hits[result.sessions.length-1];assert.equal(result.next_cursor,`${last.last}|${last.sid}`)
    assert.equal(s.recording_start,null);assert.equal(s.recording_end,null);assert.equal(s.recording_duration_s,null)
})

test('detail:true expands dense actions and screens while preserving the size cursor',async t=>{
    const hits=Array.from({length:11},(_,i)=>({sid:`dense-${10-i}`,last:`2026-11-18T09:00:${String(30-i).padStart(2,'0')}Z`}))
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('raw_session'))return response([])
        if(q.query.includes('GROUP BY sid'))return response(hits)
        return response(Array.from({length:137},(_,i)=>({...events[0],ts:new Date(Date.parse(events[0].ts)+i*1000).toISOString(),name:`Screen ${i%20}`,message:'Export'})))
    })
    const result=await findSessions({detail:true,clientId:'SEM',limit:10,...window})
    assert.ok(result.sessions.length>0 && result.sessions.length<10)
    assert.equal(result.truncated_by_size,true)
    assert.equal(result.next_cursor,`${hits[result.sessions.length-1].last}|${hits[result.sessions.length-1].sid}`)
    assert.equal(result.sessions[0].screens.length,15)
    assert.equal(result.sessions[0].matched_actions.length,10)
    const {jsonResult}=await import('../src/mcp/result.ts')
    assert.ok(JSON.stringify(jsonResult('Sessions',result)).length<=20000)
})
test('default page fits 20 sessions with 26 screens and 137 events each',async t=>{
    const hits=Array.from({length:21},(_,i)=>({sid:`dense-${20-i}`,last:new Date(Date.parse('2026-11-18T09:20:00Z')-i*1000).toISOString()}))
    const timeline=Array.from({length:137},(_,i)=>({...events[0],ts:new Date(Date.parse('2026-11-18T09:00:00Z')+i*1000).toISOString(),name:`Screen ${i%26} Financial Overview`,message:'Export monthly report'}))
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        return response(q.query.includes('raw_session')?[]:q.query.includes('GROUP BY sid')?hits:timeline)
    })
    const result=await findSessions({clientId:'SEM',limit:20,...window})
    assert.equal(result.sessions.length,20)
    assert.equal(result.truncated_by_size,undefined)
    assert.equal(result.next_cursor,`${hits[19].last}|${hits[19].sid}`)
    for(const s of result.sessions){
        assert.equal(s.events_in_session,137)
        assert.deepEqual(s.screens,['Screen 0 Fi','Screen 1 Fi','Screen 2 Fi','Screen 3 Fi','Screen 4 Fi','+21 more'])
        assert.ok(s.matched_action && s.replay_url && s.clip_url)
        assert.equal('matched_actions' in s,false)
    }
    const {jsonResult}=await import('../src/mcp/result.ts')
    const bytes=Buffer.byteLength(JSON.stringify(jsonResult('Sessions',result)))
    t.diagnostic(`20 dense sessions MCP result: ${bytes} bytes`)
    assert.ok(bytes<=19000)
})

test('data_guide exposes configured version, identity, coverage cache and SQL; resolve_client scopes counts through MCP',async t=>{
    clearClientCache()
    const {clearPosthogCache}=await import('../src/core/posthog.ts');clearPosthogCache()
    let coverageCalls=0,dailyCalls=0,rosterCalls=0
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('AS data_starts')){coverageCalls++;return response([{data_starts:'2025-11-15T08:00:05Z',data_ends:'2026-11-14T17:03:14Z'}])}
        if(q.query.includes('GROUP BY day')){dailyCalls++;return response([{day:'2025-11-15',n:100},{day:'2026-11-14',n:100}])}
        if(q.query.endsWith('LIMIT 1'))return response([{distinct_id:'C1DEV|01|SEM|SEMOPS'}])
        if(q.query.includes('AS opens'))return response([{name:'Cash Positions',opens:9},{name:'Trade Entry',opens:4}])
        if(q.query.includes('FROM person_distinct_ids'))return response([{did:'C1DEV|01|SEM|SEMOPS',email:'different@example.com'}])
        rosterCalls++;assert.match(q.query,/GROUP BY id, user, did/)
        return response([{id:'SEM',user:'SEMOPS',did:'C1DEV|01|SEM|SEMOPS',n:64,last_seen:roster[0].last_seen},{id:'SEM',user:'SEMOTHER',did:'C1DEV|01|SEM|SEMOTHER',n:146,last_seen:roster[0].last_seen}])
    })
    const server=new McpServer({name:'test',version:'1'});registerTools(server)
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        const guide=payload(await client.callTool({name:'data_guide',arguments:{}}))
        assert.equal(guide.run_sql,'posthog_exec command: call execute-sql {"query":"<HogQL>"}');assert.deepEqual(guide.sql_notes,['windowFunnel needs toDateTime(timestamp), not the DateTime64 timestamp','windowFunnel returns the max level reached, not per-stage counts; use countIf(level >= N) for cumulative stage counts'])
        assert.equal(guide.properties.version.name,'title');assert.equal(guide.events.screen,'PageView')
        assert.deepEqual(guide.screen_names.names,['Cash Positions','Trade Entry'])
        assert.equal(guide.identity.CLIENT_FROM_DISTINCT_ID,3);assert.equal(guide.identity.separator,'|')
        assert.equal(guide.identity.client.part,3);assert.equal(guide.identity.client.value,'SEM')
        assert.equal(guide.identity.user.part,4);assert.equal(guide.identity.user.value,'SEMOPS')
        assert.match(guide.examples[3],/SELECT countIf\(level >= 1\) AS stage_1, countIf\(level >= 2\) AS stage_2, countIf\(level >= 3\) AS stage_3/)
        assert.match(guide.examples[3],/windowFunnel\(3600\)\(toDateTime\(timestamp\)/)
        assert.match(guide.complete_weeks,/coverage.data_ends excludes sparse replay-fixture days/)
        assert.ok(guide.examples[4].includes(guide.coverage.data_ends.slice(0,10)))
        assert.match(guide.examples[4],/INTERVAL 4 WEEK AND timestamp < end_week GROUP BY week ORDER BY week/)
        assert.match(guide.examples[1],/OPEN/);assert.match(guide.examples[2],/properties.title/)
        const result=payload(await client.callTool({name:'resolve_client',arguments:{query:'SEMOPS',from:'2026-11-18',to:'2026-11-18'}}))
        assert.equal(result.matches[0].client_events,210);assert.equal(result.matches[0].user_events,64)
        assert.equal(result.matches[0].last_seen_in_window,new Date(roster[0].last_seen).toISOString());assert.ok(!('last_seen' in result.matches[0]));
        assert.equal(result.matches[0].events,undefined);assert.deepEqual(result.coverage,guide.coverage)
        assert.equal(rosterCalls,1);assert.equal(coverageCalls,1);assert.equal(dailyCalls,1)
        const now=Date.now();t.mock.method(Date,'now',()=>now+600001)
        await client.callTool({name:'data_guide',arguments:{}});assert.equal(coverageCalls,2);assert.equal(dailyCalls,2)
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

test('find_sessions stops outcomes at other actions and respects configured rules and screen fallback',async t=>{
    const row=(second:number,extra:Record<string,unknown>={})=>({...events[0],ts:`2026-11-18T09:00:${String(second).padStart(2,'0')}Z`,action:'CLICK',message:'',...extra})
    const timeline=[row(0,{message:'Save'}),...Array.from({length:10},(_,i)=>row(i+1)),row(11,{dialog:'toast',message:'Too far by event count'}),row(12,{message:'Save'}),row(13,{dialog:'messagebox',message:'No entry selected'}),row(14,{name:'',tab:'Fallback tab',message:'Save'}),row(15,{name:'',tab:'Fallback tab',dialog:'toast',message:'Could not save'})]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        return response(q.query.includes('raw_session')?[]:q.query.includes('GROUP BY sid')?[{sid:'one',last:timeline.at(-1)!.ts}]:timeline)
    })
    const {sessions:[s]}=await findSessions({detail:true,clientId:'SEM',what:'Save',...window})
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
    const {sessions:[s]}=await findSessions({detail:true,clientId:'SEM',...window})
    assert.equal(s.session_start,summary.session_start);assert.equal(s.session_end,summary.session_end)
    assert.equal(s.events_in_session,6000);assert.equal(s.error_messages_in_session,17)
})


test('find_sessions scopes outcomes to screens before navigation and exposes bounded neighbouring context',async t=>{
    const row=(ts:string,extra:Record<string,unknown>={})=>({...events[0],ts:`2026-11-18T09:00:${ts}Z`,action:'CLICK',message:'Save',...extra})
    const timeline=[
        row('00.000'), row('01.000',{action:'CLOSE',message:''}),
        row('02.000',{name:'Other',action:'OPEN',message:''}),
        row('03.000',{name:'Other',dialog:'toast',message:'Open completed'}),
        row('04.000'), row('05.234',{dialog:'toast',message:'Saved '+ 'x'.repeat(100)}),
        row('06.000'), row('07.000',{name:'Other',dialog:'toast',message:'Wrong screen'}),
        row('08.000'), row('38.001',{dialog:'toast',message:'Too late'}),
    ]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        return response(q.query.includes('raw_session')?[]:q.query.includes('GROUP BY sid')?[{sid:'one',last:timeline.at(-1)!.ts}]:timeline)
    })
    const {sessions:[s]}=await findSessions({detail:true,clientId:'SEM',...window})
    assert.equal(s.matched_actions[0].outcome,null)
    assert.deepEqual(s.matched_actions[4].outcome,{at:timeline[5].ts,text:timeline[5].message,is_error:false,screen:'Chart of Accounts',dialog_id:'toast',after_s:1.234,basis:'same screen, before any other action'})
    for(const i of [3,5,6,7,8,9])assert.equal(s.matched_actions[i].outcome,null)
    assert.deepEqual(s.matched_actions[4].before,[
        {line:"09:00:02.000 OPEN [Other]",dt_s:-2}, {line:"09:00:03.000 MESSAGE is_error=false 'Open completed' [Other]",dt_s:-1},
    ])
    assert.deepEqual(s.matched_actions[4].after,[
        {line:`09:00:05.234 MESSAGE is_error=false '${String(timeline[5].message).slice(0,80)}' [Chart of Accounts]`,dt_s:1.234},
        {line:"09:00:06.000 CLICK 'Save' [Chart of Accounts]",dt_s:2}, {line:"09:00:07.000 MESSAGE is_error=false 'Wrong screen' [Other]",dt_s:3},
    ])
    assert.equal(s.matched_actions[0].before.length,0);assert.equal(s.matched_actions[0].after.length,3)
    assert.equal(s.matched_actions[9].before.length,2);assert.equal(s.matched_actions[9].after.length,0)
    for(const a of s.matched_actions) {
        assert.ok(!('context' in a));assert.ok(a.before.length<=2 && a.after.length<=3)
        assert.ok(a.before.every((n:{dt_s:number})=>n.dt_s<0));assert.ok(a.after.every((n:{dt_s:number})=>n.dt_s>0))
        for(const list of [a.before,a.after])assert.deepEqual(list.map((n:{dt_s:number})=>n.dt_s),list.map((n:{dt_s:number})=>n.dt_s).sort((a:number,b:number)=>a-b))
    }

})

test('find_sessions gives a shorter literal search hint when what has no matches',async t=>{
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        assert.equal(q.values.what,'market data error')
        assert.match(q.query,/positionCaseInsensitive/)
        return response([])
    })
    const result=await findSessions({detail:true,clientId:'SEM',what:'market data error',from:new Date('2026-11-18'),to:new Date('2026-11-19')})
    assert.deepEqual(result.sessions,[])
    assert.match(result.hint ?? "",/No session in this window matched "market data error".*literal substring: try a shorter word/)
})

test('find_sessions lists only human screen names with tab fallback and labels messages',async t=>{
    const timeline=[
        {...events[0],name:'Trade Entry',tab:'Terms',dialog:'DlgTask04'},
        {...events[0],name:'DlgTask04',tab:'Fallback tab',dialog:'DlgTask04'},
        {...events[0],name:'',tab:'Cash Forecast',dialog:'DlgTask12'},
        {...events[0],name:'DlgTask04',tab:'',dialog:'DlgTask04'},
        {...events[0],name:'toast',tab:'Fake tab',dialog:'toast',action:'OPEN',message:'Saved'},
        {...events[0],name:'messagebox',tab:'Fake tab',dialog:'messagebox',action:'OPEN',message:'Invalid entry'},
    ].map((e,i)=>({...e,ts:`2026-11-18T09:00:0${i}.123Z`}))
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query.query
        return response(q.includes('raw_session')?[]:q.includes('GROUP BY sid')?[{sid:'one',last:timeline.at(-1)!.ts}]:timeline)
    })
    const {sessions:[s]}=await findSessions({detail:true,clientId:'SEM',...window})
    assert.deepEqual(s.screens,['Trade Entry','Fallback tab','Cash Forecast']);assert.equal(s.screens_total,3)
    assert.equal(s.matched_actions[4].action,'MESSAGE');assert.equal(s.matched_actions[4].is_error,false)
    assert.equal(s.matched_actions[5].action,'MESSAGE');assert.equal(s.matched_actions[5].is_error,true)
    assert.match(s.matched_actions[4].after[0].line,/09:00:05.123 MESSAGE is_error=true/)
})


test('find_sessions keeps target-screen matches when over 10 actions match, shown in time order',async t=>{
    const timeline=[
        ...Array.from({length:12},(_,i)=>({...events[0],ts:`2026-11-18T09:00:${String(i).padStart(2,'0')}Z`,name:'Other',action:'CLICK',message:'Save'})),
        {...events[0],ts:'2026-11-18T09:00:30Z',action:'CLICK',message:'Save'},
    ]
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('raw_session'))return response([])
        return response(q.query.includes('GROUP BY sid')?[{sid:'one',last:timeline.at(-1)!.ts}]:timeline)
    })
    const {sessions:[s]}=await findSessions({detail:true,clientId:'SEM',screen:'Chart of Accounts',what:'Save',...window})
    assert.equal(s.matched_actions.length,10);assert.equal(s.matched_actions_total,13)
    assert.equal(s.matched_actions.at(-1)!.at,timeline.at(-1)!.ts);assert.equal(s.matched_actions.at(-1)!.on_target_screen,true)
    const at=s.matched_actions.map((a:{at:string})=>String(a.at));assert.deepEqual(at,[...at].sort())
})

test('chat cannot change a running survey; nothing is sent to PostHog',async t=>{
    const running={id:'s-run',name:'Live one',type:'popover',created_at:'2026-11-01T00:00:00Z',start_date:'2026-11-02T00:00:00Z',end_date:null,archived:false,questions:[{id:'q',question:'Easy?',type:'rating',scale:5}],conditions:{},appearance:{}}
    const writes:string[]=[]
    t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
        if(init?.method && init.method!=='GET')writes.push(`${init.method} ${String(url)}`)
        return String(url).includes('/surveys/s-run/')?Response.json(running):Response.json({results:[]})
    })
    const server=new McpServer({name:'test',version:'1'});registerTools(server,undefined,{who:'pm@example.com',email:'pm@example.com',surveyRole:'launch'})
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);const client=new Client({name:'test',version:'1'});await client.connect(b)
    try {
        const r=await client.callTool({name:'save_survey',arguments:{survey_id:'s-run',name:'Live one',questions:[{type:'rating',text:'Easy?'}],steps:[{opens:'DlgTask01'}]}})
        const txt=(r.content as {text:string}[])[0]!.text
        assert.match(txt,/drafts only/);assert.match(txt,/Nothing was saved/)
        assert.deepEqual(writes.filter(w=>w.includes('/surveys')),[])
        const names=(await client.listTools()).tools.map(t=>t.name)
        assert.ok(!names.some(n=>/launch/.test(n)))
    } finally {await client.close()}
})

test('resolve_client understands "user at client" phrasing',async t=>{
    const {resolveClient,clearClientCache}=await import('../src/core/resolve.ts') as any
    clearClientCache?.()
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('FROM person_distinct_ids'))return response([])
        return response([{id:'TR03',user:'TR03OPS',did:'C1DEV|01|TR03|TR03OPS',n:42,last_seen:'2026-11-14T10:00:00Z'},{id:'TR03',user:'TR03RISK',did:'C1DEV|01|TR03|TR03RISK',n:9,last_seen:'2026-11-14T10:00:00Z'},{id:'SEM',user:'SEMOPS',did:'C1DEV|01|SEM|SEMOPS',n:7,last_seen:'2026-11-14T10:00:00Z'}])
    })
    for(const phrase of ['tr03ops at tr03','TR03OPS from TR03','tr03 ops, tr03']){
        const m=await resolveClient({text:phrase,from:new Date('2026-10-01'),to:new Date('2026-11-15')}) as {id:string;matched_user?:string}[]
        assert.equal(m[0]?.id,'TR03',phrase);assert.equal(m[0]?.matched_user,'TR03OPS',phrase);assert.equal(m.length,1,phrase)
    }
    const sem=await resolveClient({text:'sem ops at sem',from:new Date('2026-10-01'),to:new Date('2026-11-15')}) as {id:string;matched_user?:string}[]
    assert.equal(sem[0]?.matched_user,'SEMOPS')
})

test('every sidebar section has an icon',async()=>{
    const src=(await import('node:fs')).readFileSync(new URL('../src/service/replays.ts',import.meta.url),'utf8')
    const block=src.slice(src.indexOf('const ICON'),src.indexOf('const icon ='))
    for(const name of ['Replay clips','Live','Pinned','Surveys','Chat','System','Admin'])assert.match(block,new RegExp(`(?:'${name}'|\\b${name}):\\s*'<`),name)
})

test('pin_graph accepts a table as columns plus rows of values, and rejects ragged rows',async()=>{
    const {graphSchema}=await import('../src/core/pinned.ts')
    const ok=graphSchema.parse({title:'T',chart:{type:'table',columns:['Month','Opens'],rows:[['May',208],['Jun',201]]}})
    assert.deepEqual(ok.chart.series,[{name:'Month',values:['May','Jun']},{name:'Opens',values:[208,201]}])
    assert.throws(()=>graphSchema.parse({title:'T',chart:{type:'table',columns:['A','B'],rows:[[1]]}}))
})
