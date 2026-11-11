import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { MondayBrief } from '../src/core/briefing.ts'
const dir=mkdtempSync(join(tmpdir(),'briefing-delivery-'))
Object.assign(process.env,{TRIAGE_DB:join(dir,'main.db'),TASKS_DB:join(dir,'tasks.db')})
const { db, getSetting }=await import('../src/core/db.ts')
const { tasksDb, forgetAnswers }=await import('../src/core/tasks.ts')
const { createBriefingScheduler, deliveryPayload, briefingDeliveryStatus }=await import('../src/core/briefingdelivery.ts')
after(()=>{tasksDb.close();db.close();rmSync(dir,{recursive:true,force:true})})
const now=new Date('2026-06-29T08:05:00Z')
const item=(n: number)=>({client:'c'+n,client_name:'Client '+n,text:'Use fell private-user@hidden.example',open:'/replays/dashboards?view=story&client=c'+n})
const brief: MondayBrief={generated_at:now.toISOString(),period:{from:'2026-06-22',to:'2026-06-28'},headline:'Eight clients need review.',sections:{new_or_worse:Array.from({length:8},(_,i)=>item(i)),close_soon:[item(10)],overdue:[item(11)],recovered:[],quiet_review:item(12)},counts:{new_or_worse:8,close_soon:1,overdue:1},queue_scores:{},verified_recoveries:[]}
const opts={webhook:'http://127.0.0.1/webhook-secret',kind:'teams',day:'mon',hour:8}
function reset() {
    db.exec("DELETE FROM settings WHERE key LIKE 'briefing_%'; DELETE FROM briefing_snapshots")
    tasksDb.exec('DELETE FROM user_daily')
    tasksDb.prepare('INSERT INTO user_daily VALUES (?,?,?,?,?)').run('2026-06-28','c0','private-user@hidden.example',1,0)
    forgetAnswers()
}
test('opt-in schedule, bounded privacy-safe payloads, concurrent calls and persisted once-per-day delivery for both kinds',async()=>{
    for(const kind of ['teams','slack']) {
        reset(); const payloads: any[]=[],logs: string[]=[]
        const deps={brief:async()=>brief,log:(s: string)=>logs.push(s),fetch:(async(_url: unknown,init?: RequestInit)=>{
            assert.ok(init?.signal); assert.equal(init?.method,'POST')
            payloads.push(JSON.parse(String(init?.body))); return new Response('ok')
        }) as typeof fetch}
        const tick=createBriefingScheduler({...opts,kind},deps)
        await tick(new Date('2026-06-29T07:59:00Z')); await tick(new Date('2026-06-30T08:05:00Z')); assert.equal(payloads.length,0)
        await Promise.all([tick(now),tick(now),createBriefingScheduler({...opts,kind},deps)(now)])
        assert.equal(payloads.length,1)
        await createBriefingScheduler({...opts,kind},deps)(now); assert.equal(payloads.length,1,'restart reads persisted successful date')
        assert.equal(getSetting('briefing_last_sent',null),now.toISOString())
        assert.equal(briefingDeliveryStatus().last_sent,now.toISOString())
        const p=payloads[0]
        assert.match(p.text,/Eight clients/); assert.match(p.text,/New or worse: 8/)
        assert.match(p.text,/Client 4/); assert.doesNotMatch(p.text,/Client 5|Client 6|Client 7/)
        for(const text of ['Close soon: 1','Overdue: 1','Quiet review: Client 12','/replays/dashboards?view=briefing']) assert.ok(p.text.includes(text))
        assert.doesNotMatch(JSON.stringify(p),/private-user|hidden.example|"user"/)
        if(kind==='teams') { assert.equal(p['@type'],'MessageCard');assert.equal(p['@context'],'http://schema.org/extensions');assert.ok(p.summary) }
        else assert.deepEqual(Object.keys(p),['text'])
        assert.deepEqual(logs,[])
        await tick(new Date('2026-07-06T08:00:00Z')); assert.equal(payloads.length,2)
    }
    let calls=0
    await createBriefingScheduler({...opts,webhook:''},{fetch:(async()=>{calls++;throw Error()}) as typeof fetch})(now)
    assert.equal(calls,0)
    assert.deepEqual(deliveryPayload('slack','hello'),{text:'hello'})
})
test('one retry, failures log without secrets and never throw, failure slot persists across restarts',async()=>{
    reset(); let calls=0; const logs: string[]=[]
    const deps={brief:async()=>brief,log:(s: string)=>logs.push(s),fetch:(async()=>{calls++;throw new Error('webhook-secret')}) as typeof fetch}
    await assert.doesNotReject(createBriefingScheduler(opts,deps)(now))
    assert.equal(calls,2);assert.equal(logs.length,2);assert.doesNotMatch(logs.join(' '),/webhook-secret/)
    assert.equal(getSetting('briefing_last_sent',null),null)
    await createBriefingScheduler(opts,deps)(new Date('2026-06-29T08:30:00Z'));assert.equal(calls,2)
    reset(); calls=0
    await createBriefingScheduler(opts,{...deps,fetch:(async()=>{calls++;return new Response('',{status:calls===1?503:200})}) as typeof fetch})(now)
    assert.equal(calls,2);assert.equal(getSetting('briefing_last_sent',null),now.toISOString())
    reset()
    await assert.doesNotReject(createBriefingScheduler(opts,{...deps,brief:async()=>{throw Error('secret')}})(now))
    assert.equal(getSetting('briefing_last_sent',null),null)
    assert.doesNotMatch(logs.join(' '),/secret/)
    await assert.doesNotReject(createBriefingScheduler({...opts,hour:24},deps)(now))
})
test('Teams and Slack send actual JSON POSTs to a local HTTP receiver',async t=>{
    const received: {method?: string;type?: string;body: any}[]=[]
    const server=createServer(async(req,res)=>{
        let body='';for await(const chunk of req) body+=chunk
        received.push({method:req.method,type:req.headers['content-type'],body:JSON.parse(body)})
        res.end('ok')
    })
    try {
        await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    } catch(e) {
        if((e as NodeJS.ErrnoException).code==='EPERM') {t.skip('Sandbox prohibits listening on localhost');return}
        throw e
    }
    try {
        const address=server.address() as {port: number}
        for(const kind of ['teams','slack']) {
            reset()
            const tick=createBriefingScheduler({...opts,kind,webhook:`http://127.0.0.1:${address.port}/hook`},{brief:async()=>brief})
            await tick(now);await tick(now)
        }
        assert.equal(received.length,2)
        assert.equal(received[0].method,'POST');assert.equal(received[0].type,'application/json')
        assert.equal(received[0].body['@type'],'MessageCard');assert.deepEqual(Object.keys(received[1].body),['text'])
    } finally {await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
