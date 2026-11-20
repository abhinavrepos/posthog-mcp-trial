import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir=mkdtempSync(join(tmpdir(),'resolve-performance-'))
after(()=>rmSync(dir,{recursive:true,force:true}))
Object.assign(process.env,{TRIAGE_DB:join(dir,'main.db'),POSTHOG_HOST:'http://fake-posthog',POSTHOG_PROJECT_ID:'7',POSTHOG_PERSONAL_API_KEY:'test-key',CLIENT_FROM_DISTINCT_ID:'3',PROP_CLIENT_NAME:'client_name',PROP_PERSON_EMAIL:'contact_email'})
const {config}=await import('../src/core/config.ts')
const {knownClients,resolveClient,clearClientCache,warmClientNames}=await import('../src/core/resolve.ts')
const response=(rows:Record<string,unknown>[])=>{
    const columns=Object.keys(rows[0] || {})
    return Response.json({columns,results:rows.map(r=>columns.map(k=>r[k]))})
}
const counts=[{id:'RIB',user:'TRADER',did:'one',n:64,last_seen:'2026-11-18T10:00:00Z'},
    {id:'RIB',user:'TRADER',did:'two',n:6,last_seen:'2026-11-19T10:00:00Z'},
    {id:'RIB',user:'OTHER',did:'three',n:30,last_seen:'2026-11-17T10:00:00Z'}]
test('cheap counts use persons emails, preserve user totals, and share day caches',async t=>{
    clearClientCache();t.after(clearClientCache)
    const old=config.properties.clientName;config.properties.clientName='';t.after(()=>{config.properties.clientName=old})
    let countCalls=0,emailCalls=0
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('FROM person_distinct_ids')){
            emailCalls++;assert.match(q.query,/p\.properties\.contact_email/);assert.match(q.query,/JOIN persons p ON p.id = pdi.person_id/);assert.match(q.query,/LIMIT 100000/)
            return response([{did:'one',email:'person@example.com'}])
        }
        countCalls++;assert.doesNotMatch(q.query,/client_name|person\.properties|argMax|any\(/)
        assert.match(q.query,/GROUP BY id, user, did LIMIT 100000/)
        return response(counts)
    })
    const [m]=await resolveClient({text:'person@example.com'})
    assert.equal(m.matched_user,'TRADER');assert.equal(m.user_events,70);assert.equal(m.events,100);assert.equal(m.last_seen,'2026-11-19T10:00:00.000Z')
    await resolveClient({text:'rib'});assert.equal(countCalls,1);assert.equal(emailCalls,1)
    const now=Date.now();t.mock.method(Date,'now',()=>now+600001)
    await resolveClient({text:'TRADER'});assert.equal(countCalls,2);assert.equal(emailCalls,2)
})
test('a failed persons query and failed quick names still resolve by id and user',async t=>{
    clearClientCache();t.after(clearClientCache)
    let quick=0,emails=0
    const timeouts:number[]=[],timeout=AbortSignal.timeout
    t.mock.method(AbortSignal,'timeout',(ms:number)=>{timeouts.push(ms);return timeout(ms)})
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('FROM person_distinct_ids')){emails++;return new Response('unavailable',{status:500})}
        if(q.query.includes('argMax')){quick++;assert.equal(Math.round((+new Date(q.values.to)-+new Date(q.values.from))/86400000),30);return new Response('unavailable',{status:500})}
        return response(counts)
    })
    const [id]=await resolveClient({text:'RIB'});assert.equal(id.name,'RIB')
    const [user]=await resolveClient({text:'TRADER'});assert.equal(user.user_events,70)
    assert.equal(quick,1);assert.equal(emails,1);assert.equal(timeouts.filter(ms=>ms===8000).length,2)
})
test('pending startup roster uses quick names; ready roster enriches cached counts and refreshes ahead of expiry',async t=>{
    clearClientCache();t.after(clearClientCache)
    t.mock.timers.enable({apis:['setTimeout','Date'],now:new Date('2026-11-20T00:00:00Z')})
    let release!:(value:Response)=>void,wide=0,quick=0,countCalls=0
    const pending=new Promise<Response>(resolve=>{release=resolve})
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const q=JSON.parse(String(init.body)).query
        if(q.query.includes('FROM person_distinct_ids'))return response([])
        if(q.query.includes('argMax')){
            const days=Math.round((+new Date(q.values.to)-+new Date(q.values.from))/86400000)
            if(days===400){wide++;return wide===1?pending:response([{id:'RIB',name:'Refreshed Energie'}])}
            assert.equal(days,30);quick++;return response([{id:'RIB',name:'Recent Energie'}])
        }
        countCalls++;return response(counts)
    })
    warmClientNames();warmClientNames()
    assert.equal((await resolveClient({text:'Recent Energie'}))[0].id,'RIB')
    await knownClients();assert.equal(wide,1);assert.equal(quick,1)
    release(response([{id:'RIB',name:'Nordlicht Energie'}]));await new Promise(resolve=>setImmediate(resolve))
    assert.equal((await resolveClient({text:'Nordlicht Energie'}))[0].id,'RIB')
    assert.equal(countCalls,1);assert.equal(quick,1);assert.equal(wide,1)
    t.mock.timers.tick(55*60000);await new Promise(resolve=>setImmediate(resolve))
    assert.equal(wide,2);assert.equal((await resolveClient({text:'Refreshed Energie'}))[0].id,'RIB')
})
test('startup skips names without a configured clientName or PostHog credentials',async t=>{
    clearClientCache();t.after(clearClientCache)
    let calls=0
    t.mock.method(globalThis,'fetch',async()=>{calls++;return response([])})
    const oldName=config.properties.clientName,oldKey=config.posthog.personalApiKey
    t.after(()=>{config.properties.clientName=oldName;config.posthog.personalApiKey=oldKey})
    config.properties.clientName='';warmClientNames()
    config.properties.clientName=oldName;config.posthog.personalApiKey='';warmClientNames()
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0)
})
test('resolve_client is job backed and a slow resolver returns a pollable handle within budget',async()=>{
    const {JOB_TOOLS,FAST_TOOLS,jobBacked,createJobDispatch}=await import('../src/mcp/jobtools.ts')
    const {JobRunner}=await import('../src/core/jobs.ts')
    const {DatabaseSync}=await import('node:sqlite')
    assert.equal(JOB_TOOLS.has('resolve_client'),true);assert.equal(FAST_TOOLS.has('resolve_client'),false);assert.equal(jobBacked('resolve_client',true),true)
    const db=new DatabaseSync(':memory:'),runner=new JobRunner(db)
    try {
        const dispatch=createJobDispatch(undefined,{runner,budgetMs:5})
        let finish!:(value:unknown)=>void
        const pending=new Promise(resolve=>{finish=resolve}),start=performance.now()
        const job=await dispatch.execute('resolve_client',{query:'RIB'},undefined,undefined,async()=>pending)
        assert.ok(performance.now()-start<500);assert.match(JSON.stringify(job.result),/job_id/)
        finish({matches:[{id:'RIB'}],coverage:{}});await new Promise(resolve=>setImmediate(resolve))
        assert.deepEqual((await dispatch.poll(job.id)).result,{matches:[{id:'RIB'}],coverage:{}})
    } finally {runner.close();db.close()}
})
