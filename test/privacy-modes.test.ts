import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { after, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const dir = mkdtempSync(join(tmpdir(), 'privacy-modes-'))
process.env.TRIAGE_DB = join(dir, 'privacy.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.LENS_TOOL_CACHE_SECONDS = '120'
const D = await import('../src/core/db.ts')
const A = await import('../src/core/anonymise.ts')
const { tasksDb, cached } = await import('../src/core/tasks.ts')
const { aiSafety, safetyWith } = await import('../src/core/aisafety.ts')
const { rescuePrivacy } = await import('../src/core/rescueprivacy.ts')
const { cleanMessage } = await import('../src/core/appevents.ts')
const { wrapTools, cachedToolCall, withPrewarm } = await import('../src/mcp/tools.ts')
const { guardTransport, registryOf, guardRequest } = await import('../src/mcp/anonymise.ts')
const { anonRefusal, handlePosthogMcp, posthogExec, routingBlock } = await import('../src/mcp/posthog-proxy.ts')
const { serverInstructions } = await import('../src/mcp/instructions.ts')
after(() => { tasksDb.close(); D.db.close(); rmSync(dir, { recursive:true, force:true }) })
const clients = Array.from({ length:32 }, (_, i) => ({ id:`ACME${i}`, name:`Zorblax Treasury ${i}` }))
A.syncClients(clients)
A.applyNumbering({ prefix:'XYZ', start:100 }, 'test')
const label = A.codenameOf('ACME0')!
const source = { client:'ACME0', client_name:'Zorblax Treasury 0', user_id:'opaque-person', email:'person@example.com', amount:250000, trade_id:'123456789', text:'Trade Id 123456789; person@example.com; USD 250000' }

function child(code: string, env: NodeJS.ProcessEnv = {}) {
    return new Promise<string>((resolve,reject) => {
        const p = spawn(process.execPath, ['--import','tsx','--input-type=module','-e',code], { env:{...process.env,...env,NODE_TEST_CONTEXT:undefined}, stdio:['ignore','pipe','pipe'] })
        let out='',err='';p.stdout.on('data', x=>out+=x);p.stderr.on('data',x=>err+=x)
        p.on('error',reject);p.on('close',n=>n===0?resolve(out):reject(Error(err)))
    })
}

test('legacy settings migrate only to standard/private and create an audit record', () => {
    for (const [legacy, mode] of [[{},'standard'],[{on:false},'standard'],[{on:true,lens:false,codes:false,emails:false,posthog:'off'},'private']] as const) {
        D.setSetting('anon', legacy)
        assert.equal(A.privacyMode(),mode)
        assert.equal(D.getSetting<{mode:string}>('anon',{mode:''}).mode,mode)
        assert.ok(D.one("SELECT * FROM audit WHERE action='privacy.mode_migrated'"))
        if(mode==='private') assert.ok(A.anonFor('lens') && A.anonSettings().codes && A.anonSettings().emails)
    }
})

test('all modes render MCP JSON and errors through the actual tool boundary', async () => {
    const server=new McpServer({name:'test',version:'1'});wrapTools(server)
    server.registerTool('mode_output',{description:'Returns source data.'},async()=>({content:[{type:'text',text:JSON.stringify(source)}]}))
    server.registerTool('mode_error',{description:'Returns source error.'},async()=>{throw Error(JSON.stringify(source))})
    const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
    await server.connect(a);guardTransport(a,registryOf(server));await client.connect(b)
    try {
        for(const mode of ['open','standard','private'] as const) {
            A.setAnonymise({mode})
            for(const name of ['mode_output','mode_error']) {
                const result=await client.callTool({name,arguments:{}}),text=JSON.stringify(result)
                assert.match(text,/123456789/)
                if(mode==='open') { assert.match(text,/person@example.com/);assert.match(text,/250000/);assert.match(text,/Zorblax Treasury 0/) }
                else { assert.doesNotMatch(text,/person@example.com|250000|opaque-person/);assert.match(text,/<amount>/) }
                if(mode==='private') { assert.match(text,new RegExp(label));assert.doesNotMatch(text,/ACME0|Zorblax/) }
                if(mode==='standard') assert.match(text,/Zorblax Treasury 0/)
            }
        }
    } finally { await client.close();await server.close() }
})

class Capture extends Writable {
    text='';headersSent=false
    writeHead(){this.headersSent=true;return this} setHeader(){}
    _write(c:Buffer,_e:BufferEncoding,cb:()=>void){this.text+=c.toString();cb()}
}
const proxyOptions={url:'https://upstream.test/mcp',apiKey:'secret',token:'token',name:'lens',enabled:true}
async function proxy(command:string) {
    const req=Object.assign(Readable.from([JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'exec',arguments:{command}}})]),{method:'POST',url:'/',headers:{authorization:'Bearer token'}})
    const res=new Capture();await handlePosthogMcp(req as never,res as never,proxyOptions);return res.text
}
test('PostHog JSON, SSE and errors honor every mode; SQL is private-only refused', async t => {
    let sse=false,error=false,calls=0
    t.mock.method(globalThis,'fetch',async()=> { calls++;const payload={jsonrpc:'2.0',id:2,...(error?{error:{code:-1,message:JSON.stringify(source)}}:{result:source})};return new Response(sse?`data: ${JSON.stringify(payload)}\n\n`:JSON.stringify(payload),{headers:{'content-type':sse?'text/event-stream':'application/json'}}) })
    for(const mode of ['open','standard','private'] as const) {
        A.setAnonymise({mode,posthog:'filter'})
        for(sse of [false,true]) for(error of [false,true]) {
            const text=await proxy('call query-trends {}')
            assert.match(text,/123456789/)
            if(mode==='open') assert.match(text,/person@example.com/)
            else assert.doesNotMatch(text,/person@example.com|250000|opaque-person/)
            if(mode==='private') {assert.match(text,new RegExp(label));assert.doesNotMatch(text,/ACME0|Zorblax/)}
            else assert.match(text,/Zorblax Treasury 0/)
        }
        const before=calls,text=await proxy('call posthog:execute-sql {"query":"select 1"}')
        if(mode==='private') {assert.equal(calls,before);assert.match(text,/Raw SQL/)} else assert.equal(calls,before+1)
    }
})

test('standalone posthog_exec enforces modes and masks results without relying on its caller', async t=> {
    t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=> {
        if(init?.method==='DELETE')return new Response(null,{status:204})
        const body=JSON.parse(String(init?.body||'{}'))
        if(body.method==='notifications/initialized')return new Response(null,{status:202})
        return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-03-26'}:source})
    })
    for(const mode of ['open','standard','private'] as const){
        A.setAnonymise({mode,posthog:'filter'})
        const value=await posthogExec('call execute-sql {"query":"select 1"}',proxyOptions),text=JSON.stringify(value)
        if(mode==='private') {assert.equal(value.isError,true);assert.match(text,/Raw SQL/)}
        else if(mode==='open')assert.match(text,/person@example.com/)
        else {assert.doesNotMatch(text,/person@example.com|250000/);assert.match(text,/Zorblax/)}
    }
})

test('mode and codename revision partition tool/prewarm and core answer caches', async()=> {
    let n=0;const work=async()=>({n:++n,source:await aiSafety(source)})
    A.setAnonymise({mode:'open'});await withPrewarm(60000,()=>cachedToolCall('top_pains',{new:true},work))
    await cached('mode-test',{},work)
    A.setAnonymise({mode:'standard'})
    assert.doesNotMatch(JSON.stringify(await cachedToolCall('top_pains',{new:true},work)),/person@example.com/)
    assert.doesNotMatch(JSON.stringify(await cached('mode-test',{},work)),/person@example.com/)
    A.setAnonymise({mode:'private'})
    assert.doesNotMatch(JSON.stringify(await cachedToolCall('top_pains',{new:true},work)),/Zorblax|ACME0/)
    assert.doesNotMatch(JSON.stringify(await cached('mode-test',{},work)),/Zorblax|ACME0/)
    const before=n;A.applyNumbering({prefix:'New label',start:1000},'test')
    assert.match(JSON.stringify(await cachedToolCall('top_pains',{new:true},work)),/New label/);assert.equal(n,before+1)
})

test('request mode stays frozen, and a changed policy prevents an in-flight answer being released',async()=>{
    A.setAnonymise({mode:'open'})
    await A.withPrivacy(async()=> {A.setAnonymise({mode:'private'});assert.equal(A.privacyMode(),'open');assert.equal(A.privacyCurrent(),false)})
    let release!:()=>void,started!:()=>void
    const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r)
    const s=new McpServer({name:'test',version:'1'});wrapTools(s)
    s.registerTool('slow_result',{description:'Returns delayed data.'},async()=>{started();await wait;return{content:[{type:'text',text:JSON.stringify(source)}]}})
    const c=new Client({name:'c',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await s.connect(a);await c.connect(b)
    try {A.setAnonymise({mode:'open'});const answer=c.callTool({name:'slow_result',arguments:{}});await ready;A.setAnonymise({mode:'private'});release();assert.match(JSON.stringify(await answer),/Privacy settings changed/)}finally{await c.close();await s.close()}
})

test('numbering preview/apply is stable, retires labels, validates normalized real-name collisions',()=>{
    const before=A.listCodenames(),p={prefix:'Google client',start:2000},preview=A.previewNumbering(p)
    assert.deepEqual(A.listCodenames(),before)
    A.applyNumbering(p,'admin');assert.deepEqual(A.listCodenames().map(c=>c.codename),preview.map(c=>c.codename))
    for(const old of before)assert.equal(A.clientOfCodename(old.codename),undefined)
    for(const c of A.listCodenames()) {assert.equal(A.clientOfCodename(c.codename),c.client);assert.equal(A.hideClients(c.codename).text,c.codename)}
    assert.throws(()=>A.previewNumbering({prefix:'Google client',start:2001}),/reassigns/)
    for(const prefix of ['', 'x'.repeat(41),'unsafe<', 'ACME0 client','Zorblax Treasury 0 client','ＺＯＲＢＬＡＸ Treasury 0'])assert.throws(()=>A.previewNumbering({prefix,start:1}))
    A.setCodename('ACME0',{aliases:['Hidden Brand']},'test')
    assert.throws(()=>A.previewNumbering({prefix:'Hidden-Brand client',start:1}),/real client/)
    assert.doesNotThrow(()=>A.previewNumbering({prefix:'client',start:5000}))
    assert.throws(()=>A.applyNumbering({prefix:'XYZ',start:100},'test'),/retired/)
})

test('inbound numbered tokens, slug and URL encoding have strict numeric boundaries',()=>{
    A.applyNumbering({prefix:'Edge label',start:10},'test')
    const first=A.listCodenames()[0]
    assert.equal(first.codename,'Edge label 10')
    assert.equal(A.clientOfCodename('edge-label-10'),first.client)
    assert.equal(A.clientOfCodename('edge%20label%2010'),first.client)
    assert.equal(A.clientOfCodename('EDGE LABEL 10'),first.client)
    assert.equal(A.clientOfCodename('edge label 100'),undefined)
    assert.equal(A.revealCodenames('Edge label 100 vs Edge label 10'),`Edge label 100 vs ${first.client}`)
    A.syncClients([{id:'100000',name:'Numeric Corporation'}])
    assert.equal(A.hideClients('Trade Id 100000').text,'Trade Id 100000')
    assert.equal(A.hideClientsDeep({client:'100000',trade_id:'100000'}).value.client,A.codenameOf('100000'))
    assert.equal(safetyWith({trade_id:'123456789'},[]).trade_id,'123456789')
    assert.ok(guardRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'client_story',arguments:{client:'Edge label 100'}}}).answer)
})

test('large codename suffix survives all safety passes; open bypasses early masking and rescue privacy',async()=>{
    A.applyNumbering({prefix:'Large client',start:100000},'test')
    const cn=A.codenameOf('ACME0')!
    assert.equal(await aiSafety(cn),cn)
    assert.equal(A.hideClients(`ACME0 ${cn}`).text,`${cn} ${cn}`)
    A.setAnonymise({mode:'open'})
    assert.equal(cleanMessage('person@example.com USD 250000',{redact:[]}), 'person@example.com USD 250000')
    assert.equal(await rescuePrivacy('person@example.com'),'person@example.com')
    A.setAnonymise({mode:'standard'})
    assert.doesNotMatch(cleanMessage('person@example.com USD 250000',{redact:[]}),/person@example.com|250000/)
})

test('initial ranks cryptographically shuffle legacy clients, survive restart, and concurrent allocation is unique',async()=>{
    const db=join(dir,'migration.db'),env={TRIAGE_DB:db}
    await child(`const D=await import('./src/core/db.ts');for(let i=0;i<32;i++)D.run('INSERT INTO client_codenames(client,name,codename,aliases,set_by,set_at) VALUES (?,?,?,?,?,?)','C'+String(i).padStart(2,'0'),'Name '+i,'Old '+i,'[]','lens','now');D.db.close()`,env)
    const read=`const A=await import('./src/core/anonymise.ts');const D=await import('./src/core/db.ts');(await import('node:fs')).writeFileSync(process.env.TRIAGE_DB+'.json',JSON.stringify(D.all('SELECT client,rank,codename FROM client_codenames ORDER BY rank')));D.db.close()`
    await child(read,env)
    const rows=JSON.parse(readFileSync(db+'.json','utf8')) as {client:string;rank:number;codename:string}[]
    assert.deepEqual(rows.map(r=>r.rank),Array.from({length:32},(_,i)=>i))
    assert.notDeepEqual(rows.map(r=>r.client),rows.map(r=>r.client).sort())
    await child(read,env)
    assert.equal(readFileSync(db+'.json','utf8'),JSON.stringify(rows))
    await Promise.all(['new-a','new-b'].map(id=>child(`const A=await import('./src/core/anonymise.ts');A.syncClients([{id:'${id}',name:'New account'}])`,env)))
    await child(read,env)
    const added=JSON.parse(readFileSync(db+'.json','utf8')) as typeof rows
    assert.deepEqual(added.slice(0,32),rows)
    assert.deepEqual(added.slice(32).map(r=>r.rank),[32,33])
})

test('direct SQL tool calls cannot bypass private proxy policy',()=>{
    for(const mode of ['open','standard','private'] as const){A.setAnonymise({mode,posthog:'filter'});const result=anonRefusal({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'execute-sql',arguments:{query:'select 1'}}});assert.equal(!!result.refusal,mode==='private')}
})

test('instructions explain SQL policy per mode and fit the 2048 character limit',()=>{
    for(const mode of ['open','standard','private'] as const){A.setAnonymise({mode});const text=serverInstructions(true);assert.ok(text.length<2048,`${mode}: ${text.length}`);assert.match(text,new RegExp(mode));if(mode==='private')assert.match(routingBlock('lens'),/execute-sql is refused/)}
})

test('admin page has three explained modes, a safe mapping preview, and a privacy audit', async()=> {
    const { handlePrivacy } = await import('../src/service/privacy.ts')
    const { Script } = await import('node:vm')
    const req={method:'GET',headers:{}} as never
    const res=new Capture()
    await handlePrivacy(req,res as never,new URL('http://lens/replays/admin/privacy'),{email:'admin@example.test',role:'admin'} as never)
    for(const text of ['Open','Standard (default)','Private','Privacy audit','Preview mapping','stored already generalised'])assert.ok(res.text.includes(text),text)
    assert.doesNotMatch(res.text,/New random codename|s-lens|s-triage|s-emails/)
    for(const script of res.text.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Script(script[1]))
    const p={prefix:'Preview next',start:9000},revision=A.privacyRevision()
    A.previewNumbering(p);A.syncClients([{id:'preview-new',name:'New Preview Account'}])
    assert.throws(()=>A.applyNumbering(p,'test',revision),/preview again/)
    const prefix='x'.repeat(40)
    A.applyNumbering({prefix,start:900000},'test')
    assert.ok(A.listCodenames().every(c=>c.codename.startsWith(prefix)))
})

test('saved briefing answers are rebuilt after mode changes and deliveries follow the current mode', async()=>{
    const { mondayBrief, BRIEF_VERSION }=await import('../src/core/briefing.ts')
    const { createBriefingScheduler }=await import('../src/core/briefingdelivery.ts')
    const { config }=await import('../src/core/config.ts')
    const by='mode-brief@example.test',now=new Date('2026-11-16T09:00:00Z')
    A.setAnonymise({mode:'open'})
    const brief=await mondayBrief({by,now})
    assert.equal(brief.version,BRIEF_VERSION)
    assert.equal(brief.privacy_key,A.privacyKey())
    A.setAnonymise({mode:'private'})
    const rebuilt=await mondayBrief({by,now})
    assert.equal(rebuilt.privacy_key,A.privacyKey())
    assert.notEqual(brief.privacy_key,rebuilt.privacy_key)
    const deliveries:string[]=[]
    const tick=createBriefingScheduler({...config.briefing,webhook:'https://delivery.test',kind:'slack',day:'mon',hour:9},{
        brief:async()=>({...rebuilt,headline:'ACME0 Zorblax Treasury 0 person@example.com USD 250000',sections:{...rebuilt.sections,new_or_worse:[],close_soon:[],overdue:[],quiet_review:null}}),
        fetch:async(_url,init)=>{deliveries.push(String(init?.body));return new Response(null,{status:200})},log:()=>{}
    })
    for(const [i,mode] of (['open','standard','private'] as const).entries()){
        A.setAnonymise({mode});await tick(new Date(`2026-11-${16+i*7}T09:00:00Z`))
        const text=deliveries[i]
        assert.ok(text)
        if(mode==='open'){assert.match(text,/250000/);assert.match(text,/person＠example.com/)}
        else assert.doesNotMatch(text,/person＠example.com|250000/)
        if(mode==='private')assert.doesNotMatch(text,/ACME0|Zorblax/)
    }
})

test('a new client always gets a codename: retired labels and real client names are skipped', () => {
    const scheme = A.numbering(), next = (D as any).getSetting?.('codename_next_rank', 0)
    const nextLabel = (n: number) => `${scheme.prefix} ${scheme.start + n}`
    // A real client literally named like the next label, and the label after it retired.
    const base = A.listCodenames().length
    A.syncClients([{ id: 'REAL1', name: nextLabel(base + 1) }])
    D.db.prepare('INSERT OR IGNORE INTO retired_codenames(label) VALUES (?)').run(A.slug(nextLabel(base + 2)))
    assert.doesNotThrow(() => A.syncClients([{ id: 'NEWCO', name: 'Quillfen Holdings' }]))
    const mine = A.codenameOf('NEWCO')!
    assert.ok(mine, 'new client has a codename')
    assert.notEqual(mine.toLowerCase(), nextLabel(base + 1).toLowerCase(), 'not a real client name')
    assert.notEqual(A.slug(mine), A.slug(nextLabel(base + 2)), 'not a retired label')
    void next
})
