import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Viewer } from '../src/service/access.ts'
const dir=mkdtempSync(join(tmpdir(),'scorecard-'))
Object.assign(process.env,{TRIAGE_DB:join(dir,'main.db'),TASKS_DB:join(dir,'tasks.db'),APP_EVENTS_FILE:'config/app-events.reval.json'})
const {tasksDb,forgetAnswers,aggregates,periodAggregates,storeAttempts}=await import('../src/core/tasks.ts')
const {db}=await import('../src/core/db.ts')
const {recordOutcome,clientOutcomes}=await import('../src/core/outcomes.ts')
const {scorecard}=await import('../src/core/scorecard.ts')
const {peerBenchmark}=await import('../src/core/peers.ts')
const {newClientValues}=await import('../src/core/newclients.ts')
const {rescueQueue}=await import('../src/core/rescue.ts')
const {mondayBrief}=await import('../src/core/briefing.ts')
const {clientStory}=await import('../src/core/story.ts')
const {handleAdmin}=await import('../src/service/admin.ts')
const {handleDashboards}=await import('../src/service/dashboards.ts')
const {DURATION_BUCKETS}=await import('../src/core/taskstypes.ts')
after(()=>{tasksDb.close();db.close();rmSync(dir,{recursive:true,force:true})})
const shift=(s:string,n:number)=>new Date(Date.parse(s)+n*86400000).toISOString().slice(0,10)
const viewer=(role:Viewer['role']='admin',dashboards:Viewer['dashboards']='view'):Viewer=>({email:'staff@example.com',name:'Staff',role,dashboards,posthog_admin:false,in_replay_project:true,session:'x'})
function reset(from='2025-12-01',to='2026-03-29') {
    for(const t of ['task_daily','task_users_daily','task_catalog','task_ingest','user_daily','client_daily','ops_daily','errors_daily','client_names','task_state'])tasksDb.exec(`DELETE FROM ${t}`)
    db.exec('DELETE FROM client_outcomes; DELETE FROM audit; DELETE FROM briefing_snapshots; DELETE FROM rescue_actions')
    const q=tasksDb.prepare('INSERT INTO task_ingest VALUES (?,0,0,0,0,0,?,1)')
    for(let d=from;d<=to;d=shift(d,1))q.run(d,to)
    tasksDb.prepare("INSERT INTO task_catalog VALUES ('t_Swap','Swap','IR Swap','save',?,?)").run(from,to)
    forgetAnswers()
}
function row(day:string,client:string,attempts:number,done=attempts,seconds=45,task='t_Swap') {
    const h=DURATION_BUCKETS.map(()=>0);let b=0;while(b+1<DURATION_BUCKETS.length&&seconds>=DURATION_BUCKETS[b+1])b++;h[b]=done
    tasksDb.prepare('INSERT OR REPLACE INTO task_daily VALUES (?,?,?,?,?,?,0,1,?)').run(day,client,task,attempts,done,attempts-done,JSON.stringify(h))
    tasksDb.prepare('INSERT OR REPLACE INTO client_names VALUES (?,?)').run(client,client)
    forgetAnswers()
}
async function request(handler:typeof handleAdmin|typeof handleDashboards,path:string,method='GET',body?:unknown,v=viewer(),header='1') {
    let status=0,html=''
    const req=Object.assign((async function*(){if(body!==undefined)yield JSON.stringify(body)})(),{method,headers:{'x-clip-page':header}})
    await handler(req as never,{writeHead(n:number){status=n},end(s:string){html=s}} as never,new URL('http://test'+path),v)
    return {status,html}
}
const scriptsParse=(html:string)=>{for(const [,s]of html.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Function(s))}
test('outcome CRUD is admin only, validated, audited and renders an escaped editor',async()=>{
    reset()
    const p={client:'Northwind',outcome:'left',decided_on:'2026-03-01',note:'Known later'}
    assert.throws(()=>recordOutcome(viewer('watch'),p),/Admins/)
    for(const body of [{...p,outcome:'maybe'},{...p,decided_on:'2026-02-30'},{...p,note:'x'.repeat(501)},{...p,client:''}])assert.throws(()=>recordOutcome(viewer(),body))
    const url='/replays/admin/api/outcomes'
    assert.equal((await request(handleAdmin,url,'POST',p,viewer('watch'))).status,403)
    assert.equal((await request(handleAdmin,url,'POST',p,viewer(),'')).status,403)
    assert.equal((await request(handleAdmin,url,'POST',p)).status,200)
    assert.equal(clientOutcomes()[0].recorded_by,'staff@example.com')
    recordOutcome(viewer(),{...p,outcome:'renewed'})
    assert.equal(clientOutcomes()[0].outcome,'renewed')
    assert.equal((await request(handleAdmin,url)).status,200)
    assert.equal((await request(handleAdmin,url,'POST',{...p,decided_on:'bad'})).status,400)
    const page=await request(handleAdmin,'/replays/admin');assert.match(page.html,/Client outcomes/);scriptsParse(page.html)
    assert.equal((await request(handleAdmin,url,'DELETE',{client:p.client})).status,200)
    assert.equal(clientOutcomes().length,0)
    assert.equal((db.prepare("SELECT count(*) AS n FROM audit WHERE action='outcome.recorded'").get() as any).n,3)
    assert.throws(()=>db.prepare('INSERT INTO client_outcomes VALUES (?,?,?,?,?,?)').run('a','left','2026-02-30','','x','x'))
})
test('weekly scorecard counts hits, misses, false alarms and first-observed lead days; outcomes bypass history cache',async()=>{
    reset()
    for(const c of ['Leaving','Renewing','AfterDecision'])row('2026-01-10',c,8)
    for(const [client,outcome,decided_on]of [['Leaving','left','2026-02-15'],['Renewing','renewed','2026-02-15'],['NeverFlagged','contracted','2026-02-15'],['AfterDecision','left','2026-02-01']])recordOutcome(viewer(),{client,outcome,decided_on})
    const s=await scorecard({weeks:8}),missing=s.rows.find(r=>r.kind==='missing')!
    assert.equal(s.coverage.processed_weeks,8)
    assert.equal(missing.flagged_clients,3);assert.equal(missing.hits,1);assert.equal(missing.misses,2);assert.equal(missing.possible_false_alarms,1)
    assert.equal(missing.median_lead_days,7)
    assert.deepEqual(missing.first_flags.find(f=>f.client==='Leaving'),{client:'Leaving',first_flag:'2026-02-08',lead_days:7})
    assert.equal(s.rows[0].kind,'overall');assert.equal(s.rows[0].hits,1)
    assert.match(s.explanation,/4 clients with a recorded outcome: a small sample, so treat this as a sanity check, not accuracy/)
    recordOutcome(viewer(),{client:'Leaving'},true)
    assert.equal((await scorecard({weeks:8})).outcome_clients,3)
    tasksDb.prepare("DELETE FROM task_ingest WHERE day='2026-03-15'").run();forgetAnswers()
    const gap=await scorecard({weeks:8});assert.ok(gap.coverage.skipped_weeks.includes('2026-03-29'));assert.ok(gap.coverage.processed_weeks<8)
    for(const weeks of [0,53,1.1,NaN])await assert.rejects(scorecard({weeks}),/Weeks/)
})
test('scorecard replays captured signal flags, respects missing captures, and excludes outcome notes',async()=>{
    reset()
    tasksDb.prepare('INSERT INTO errors_daily VALUES (?,?,?,?,?,?,?)').run('2026-02-01','SignalClient','Swap','save','Invalid trade',4,4)
    recordOutcome(viewer(),{client:'SignalClient',outcome:'left',decided_on:'2026-02-15',note:'private-person@hidden.example'})
    forgetAnswers()
    const s=await scorecard({weeks:8}),giving=s.rows.find(r=>r.kind==='giving_up')!
    assert.equal(giving.hits,1);assert.equal(giving.median_lead_days,7);assert.equal(s.rows[0].hits,1)
    assert.doesNotMatch(JSON.stringify(s),/private-person|hidden.example|staff@example/)
    tasksDb.prepare("INSERT INTO task_state VALUES ('signals_missing:2025-12-05','1')").run();forgetAnswers()
    const partial=await scorecard({weeks:8})
    assert.equal(partial.coverage.processed_weeks,8,'capture gaps do not skip complete rescue windows')
    assert.equal(partial.rows.find(r=>r.kind==='giving_up')!.hits,0,'signal now first observed on the decision date')
    assert.ok(partial.coverage.signal_incomplete_weeks.length)
})
test('calendar-week aggregate reuse preserves daily counts and duration histograms',async()=>{
    reset()
    for(let i=0;i<28;i++)for(let c=0;c<3;c++)row(shift('2026-03-02',i),'Client'+c,5+i,2+i,15+i*5)
    const window={from:'2026-03-02',to:'2026-03-29'},sorted=(xs:ReturnType<typeof aggregates>)=>xs.map(r=>({...r})).sort((a,b)=>a.client.localeCompare(b.client)||a.task_id.localeCompare(b.task_id))
    assert.deepEqual(sorted(await periodAggregates(window)),sorted(aggregates(window)))
    row('2026-03-10','Client0',50,40,300)
    assert.deepEqual(sorted(await periodAggregates(window)),sorted(aggregates(window)))
})
test('peer comparison uses median of medians, equal client rates, minimum samples and anonymous output',async()=>{
    reset()
    const w={from:'2026-03-02',to:'2026-03-29'}
    row(w.from,'Target',10,5,120)
    for(let i=0;i<5;i++)row(w.from,'SecretPeer'+i,i===4?1000:5,undefined,[15,30,45,60,600][i])
    let b=await peerBenchmark({client:'Target',window:w}),p=b.tasks[0]
    assert.equal(p.peer_clients,5);assert.equal(p.peer_median_s,52.5);assert.equal(p.client_median_s,150);assert.equal(p.ratio,150/52.5)
    assert.equal(p.done_rate,.5);assert.equal(p.peer_done_rate,1)
    assert.doesNotMatch(JSON.stringify(b),/SecretPeer|user|session_id/)
    row(w.from,'SixthPeer',5,5,90)
    assert.equal((await peerBenchmark({client:'Target',window:w})).tasks[0].peer_median_s,63.75)
    tasksDb.prepare("DELETE FROM task_daily WHERE client='SixthPeer'").run();forgetAnswers()
    let q=await rescueQueue({window:w});const c=q.clients.find(c=>c.client==='Target')!
    assert.ok(c.reasons.some(r=>r.kind==='peer_gap'));assert.equal(c.score,1);assert.match(c.next_step,/Watch one slow attempt/)
    const story=await clientStory({client:'Target',weeks:1});assert.ok(story.peers?.length);assert.doesNotMatch(JSON.stringify(story.peers),/SecretPeer/)
    row(w.from,'SecretPeer0',4);b=await peerBenchmark({client:'Target',window:w});assert.equal(b.tasks.length,0)
    row(w.from,'SecretPeer0',5);row(w.from,'Target',20,4);assert.equal((await peerBenchmark({client:'Target',window:w})).tasks.length,0)
})
test('peer story and rescue thresholds are inclusive, done-rate gaps can trigger independently',async()=>{
    reset();const w={from:'2026-03-02',to:'2026-03-29'}
    for(let i=0;i<5;i++)row(w.from,'Peer'+i,20,20,45)
    row(w.from,'Target',20,15,45)
    assert.ok((await rescueQueue({window:w})).clients.find(c=>c.client==='Target')?.reasons.some(r=>r.kind==='peer_gap'))
    row(w.from,'Target',20,16,45)
    assert.ok(!(await rescueQueue({window:w})).clients.find(c=>c.client==='Target')?.reasons.some(r=>r.kind==='peer_gap'))
    assert.equal((await clientStory({client:'Target',weeks:1})).peers?.length,1)
    row(w.from,'Target',20,18,45)
    assert.equal((await clientStory({client:'Target',weeks:1})).peers?.length,0)
    // Interpolated medians of 75 vs 37.5 are exactly 2x.
    for(let i=0;i<5;i++)row(w.from,'Peer'+i,20,20,30)
    row(w.from,'Target',20,20,60)
    assert.ok((await rescueQueue({window:w})).clients.find(c=>c.client==='Target')?.reasons.some(r=>r.kind==='peer_gap'))
})
test('new client top tasks need two distinct UTC weeks; briefing is bounded, oldest first, privacy safe',async()=>{
    reset()
    row('2026-02-23','Northwind',6,0)
    row('2026-03-02','Northwind',3,3,45,'t_Hedge');row('2026-03-09','Northwind',3,3,45,'t_Hedge')
    tasksDb.prepare("INSERT INTO task_catalog VALUES ('t_Hedge','Hedge','Hedge Designation','save','2026-03-02','2026-03-29')").run()
    for(let i=0;i<6;i++)row(shift('2026-03-01',i),'New'+i,2)
    row('2025-12-01','Old',6,0)
    tasksDb.prepare("INSERT INTO user_daily VALUES ('2026-02-23','Northwind','private-person@hidden.example',2,0)").run()
    forgetAnswers()
    const n=await newClientValues('2026-03-29'),north=n.find(c=>c.client==='Northwind')!
    assert.equal(north.tasks.find(t=>t.task_id==='t_Hedge')?.established,true)
    assert.match(north.text,/first seen 34 days ago/);assert.match(north.text,/IR Swap tried 6 times, never completed/)
    assert.ok(!n.some(c=>c.client==='Old'))
    const q=await rescueQueue(),reason=q.clients.find(c=>c.client==='Northwind')?.reasons.find(r=>r.kind==='not_established');assert.ok(reason)
    assert.equal(q.clients.find(c=>c.client==='Northwind')!.score,12)
    assert.ok(!q.clients.find(c=>c.client==='Old')?.reasons.some(r=>r.kind==='not_established'))
    const b=await mondayBrief({by:'pm',now:new Date('2026-03-30')})
    assert.equal(b.sections.new_clients?.length,5);assert.equal(b.sections.new_clients[0].client,'Northwind')
    assert.doesNotMatch(JSON.stringify({n,b,q}),/private-person|hidden.example/)
    const story=await request(handleDashboards,'/replays/dashboards?view=story&client=Northwind&weeks=1','GET',undefined,viewer('none','view'))
    assert.match(story.html,/Compared with other clients/);assert.doesNotMatch(story.html,/private-person|hidden.example/);scriptsParse(story.html)
    const page=await request(handleDashboards,'/replays/dashboards?view=briefing','GET',undefined,viewer('none','view'))
    assert.match(page.html,/Clients added in the last 90 days/);scriptsParse(page.html)
    // Backdating reveals this client was already older than 90 days; invalidate derived answers.
    row('2025-12-01','Northwind',1,0)
    assert.ok(!(await newClientValues('2026-03-29')).some(c=>c.client==='Northwind'))
})
test('not established starts at five attempts and considers only the top three tasks',async()=>{
    reset();row('2026-03-02','New',4,0)
    assert.ok(!(await rescueQueue()).clients.some(c=>c.client==='New'))
    row('2026-03-02','New',5,0)
    const c=(await rescueQueue()).clients.find(c=>c.client==='New')!
    assert.deepEqual(c.reasons.map(r=>r.kind),['not_established']);assert.equal(c.score,2)
    for(const task of ['t_A','t_B','t_C'])row('2026-03-02','New',6,6,45,task)
    assert.ok(!(await rescueQueue()).clients.some(c=>c.client==='New'))
})
test('scorecard page computes through read API for view role; none denied; scripts parse',async()=>{
    reset()
    for(const role of ['view','share'] as const){const page=await request(handleDashboards,'/replays/dashboards?view=scorecard','GET',undefined,viewer('none',role));assert.equal(page.status,200);assert.match(page.html,/Computing scorecard/);scriptsParse(page.html)}
    const api=await request(handleDashboards,'/replays/dashboards/api/scorecard?weeks=2','GET',undefined,viewer('none','view'));assert.equal(api.status,200);assert.equal(JSON.parse(api.html).weeks,2)
    for(const path of ['?view=scorecard','/api/scorecard'])assert.equal((await request(handleDashboards,'/replays/dashboards'+path,'GET',undefined,viewer('none','none'))).status,403)
    assert.equal((await request(handleDashboards,'/replays/dashboards/api/scorecard?weeks=53')).status,400)
})
test('cold synthetic year replay for 50 clients is below five seconds, and repeated reads reuse replay',async()=>{
    reset('2025-01-01','2025-12-31')
    const h=JSON.stringify(DURATION_BUCKETS.map((_,i)=>i===5?5:0)), insert=tasksDb.prepare('INSERT INTO task_daily VALUES (?,?,?,?,5,0,0,1,?)')
    tasksDb.exec('BEGIN')
    try {for(let d='2025-01-01';d<='2025-12-31';d=shift(d,1))for(let c=0;c<50;c++)for(let t=0;t<40;t++)insert.run(d,'Client'+c,'t_Task'+t,5,h);tasksDb.exec('COMMIT')}catch(e){tasksDb.exec('ROLLBACK');throw e}
    forgetAnswers();const start=performance.now();const s=await scorecard();const cold=performance.now()-start
    assert.ok(cold<5000,`cold replay took ${cold.toFixed(0)}ms`);assert.ok(s.coverage.processed_weeks>40)
    const warmStart=performance.now();await scorecard();assert.ok(performance.now()-warmStart<cold/2)
    console.log(`Scorecard synthetic year: ${cold.toFixed(0)}ms cold (730,000 daily rows)`)
})
test('weekly observations are stored once, reused, and dropped when a day they read is stored again', async () => {
    reset()
    tasksDb.prepare('INSERT INTO errors_daily VALUES (?,?,?,?,?,?,?)').run('2026-02-01','SignalClient','Swap','save','Invalid trade',4,4)
    forgetAnswers()
    const first = await scorecard({ weeks: 8 })
    const stored = (tasksDb.prepare('SELECT count(*) AS n FROM week_done').get() as { n: number }).n
    assert.ok(stored >= 1, 'replayed weeks are kept')
    // A second scorecard with the answer cache cleared but the store kept reads the stored weeks.
    forgetAnswers(true)
    assert.deepEqual(await scorecard({ weeks: 8 }), first)
    // Storing a day drops only the weeks ending on or after it.
    const weeks = (tasksDb.prepare('SELECT week_end FROM week_done ORDER BY week_end').all() as { week_end: string }[]).map((r) => r.week_end)
    const mid = weeks[Math.floor(weeks.length / 2)]
    storeAttempts(mid, [])
    const left = (tasksDb.prepare('SELECT week_end FROM week_done ORDER BY week_end').all() as { week_end: string }[]).map((r) => r.week_end)
    assert.deepEqual(left, weeks.filter((w) => w < mid))
})
