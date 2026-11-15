import assert from 'node:assert/strict'
import {test,after,beforeEach} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const dir=mkdtempSync(join(tmpdir(),'lens-fouryear-'))
Object.assign(process.env,{TASKS_DB:join(dir,'tasks.db'),TRIAGE_DB:join(dir,'main.db'),APP_EVENTS_FILE:'config/app-events.reval.json'})
const {tasksDb,storeAttempts,coverage,forgetAnswers}=await import('../src/core/tasks.ts')
const {db}=await import('../src/core/db.ts')
const {analyticalWindow,parseTimeWindow}=await import('../src/core/timewindow.ts')
const {historyFriction,analysisCoverage}=await import('../src/core/analysishistory.ts')
const {toSteps,required,topPains}=await import('../src/core/appevents.ts')
const {clientTimeline,clientActivityChanges,compareClientPatterns}=await import('../src/core/clientpatterns.ts')
const {clientStory}=await import('../src/core/story.ts')
const {analyticalResult}=await import('../src/mcp/historyresult.ts')
const shift=(s:string,n:number)=>new Date(Date.parse(s)+n*86400000).toISOString().slice(0,10)
after(()=>{tasksDb.close();db.close();rmSync(dir,{recursive:true,force:true})})
beforeEach(()=>{for(const table of ['task_ingest','task_state','task_daily','client_daily','user_daily','task_users_daily','ops_daily','analysis_days','friction_daily','week_obs'])tasksDb.exec(`DELETE FROM ${table}`);db.exec('DELETE FROM client_outcomes;DELETE FROM client_outcome_episodes');forgetAnswers()})
function observed(from:string,to:string) {for(let d=from;d<=to;d=shift(d,1))tasksDb.prepare('INSERT OR REPLACE INTO task_ingest VALUES (?,0,0,0,0,0,?,1)').run(d,to)}
function active(client:string,...days:string[]) {for(const d of days)tasksDb.prepare('INSERT INTO client_daily VALUES (?,?,1,1,0,1,0)').run(d,client)}
test('validated shared calendar and four-year relative contract never falls back',()=>{
    const now=new Date('2026-11-15T12:00:00Z')
    for(const [input,from,to] of [ ['last 4 years','2022-11-15','2026-11-15'],['last 90 days','2026-08-17','2026-11-15'],['past 18 months','2025-05-15','2026-11-15'],['last quarter','2026-07-01','2026-10-01'],['2024','2024-01-01','2025-01-01'],['Q3 2025','2025-07-01','2025-10-01'],['March 2023','2023-03-01','2023-04-01'],['2023-01-01 to 2024-06-30','2023-01-01','2024-07-01']]) {
        const w=analyticalWindow(input,now,null)!;assert.equal(w.from.toISOString().slice(0,10),from);assert.equal(w.to.toISOString().slice(0,10),to)
    }
    assert.equal(analyticalWindow('last 4 years',now,'2026-11-10')!.to.toISOString(),'2026-11-11T00:00:00.000Z')
    for(const value of ['last 100 years','2024-02-30','2025-01-01 to 2024-01-01','not a window'])assert.throws(()=>parseTimeWindow(value,now))
})
test('missing middle, expired source and before tracking remain missing, while covered friction is answered',async()=>{
    const reg=required(),day='2025-01-02'
    storeAttempts(day,[],{finalized:true,analysisSessions:[toSteps([{sid:'s',ts:day+'T12:00:00Z',event:reg.events.screen,dialog:'DlgA',action:'OPEN',client:'A'}],reg)]})
    observed('2025-01-04','2025-01-04');tasksDb.prepare('INSERT INTO analysis_days VALUES (?)').run('2025-01-04')
    tasksDb.prepare('INSERT INTO task_state VALUES (?,?)').run('tracking_first_day','2025-01-02')
    tasksDb.prepare('INSERT INTO task_state VALUES (?,?)').run('analysis_unavailable:2025-01-04','retention')
    const q={from:new Date('2025-01-01'),to:new Date('2025-01-05')},c=analysisCoverage(q)
    assert.equal(c.covered_days,1);assert.deepEqual(c.datasets[0].missing_ranges.map(r=>r.reason),['before_tracking','pending','source_expired'])
    assert.equal(historyFriction(q)![0].opens,1)
    const pains=await topPains({...q,compare:'previous'});assert.equal((pains.coverage as {comparison:{status:string}}).comparison.status,'unavailable')
    assert.equal((pains.coverage as {requested:{from:string}}).requested.from,'2025-01-01')
})
test('four-year story uses bounded calendar months and a historical anchor',async()=>{
    observed('2021-01-01','2024-12-31');active('A','2021-01-01','2024-12-31')
    const r=await clientStory({client:'A',from:'2021-01-01',anchor:'2024-12-31',bucket:'month'})
    assert.equal(r.timeline!.buckets.length,48);assert.equal(r.timeline!.buckets[0].sessions,1);assert.equal(r.timeline!.buckets.at(-1)!.sessions,1)
    assert.equal(r.timeline!.coverage.covered_days,1461);assert.ok(JSON.stringify(r).length<30000)
    assert.equal(clientTimeline({client:'A',from:'2021-01-01',to:'2024-12-31',bucket:'month'}).window.from,'2021-01-01')
})
test('silence requires established use and complete follow-up, detects reactivation and ignores shorter seasonal gaps',()=>{
    observed('2024-01-01','2024-12-31')
    active('A','2024-01-01','2024-01-02','2024-01-03','2024-04-01')
    active('seasonal','2024-01-01','2024-01-02','2024-01-03','2024-02-01','2024-03-01','2024-04-01','2024-05-01','2024-06-01','2024-07-01','2024-08-01','2024-09-01','2024-10-01','2024-11-01','2024-12-01')
    let r=clientActivityChanges({from:'2024-01-01',to:'2024-12-31'})
    assert.equal(r.clients.find(c=>c.client==='A')!.first_sustained_silence,'2024-01-04')
    assert.equal(r.clients.find(c=>c.client==='A')!.episodes[0].reactivated_on,'2024-04-01')
    assert.ok(!r.clients.some(c=>c.client==='seasonal'),'no inactivity: counted, not listed');assert.equal((r as {clients_active_without_inactivity?:number}).clients_active_without_inactivity,1)
    tasksDb.prepare('DELETE FROM task_ingest WHERE day=?').run('2024-02-05')
    r=clientActivityChanges({from:'2024-01-01',to:'2024-03-20'});assert.ok(!r.clients.some(c=>c.client==='A'),'an unobserved day breaks the silence proof')
})
test('cohort alignment gives exact group sizes and excludes incomplete months',()=>{
    observed('2024-01-01','2024-12-31');active('left','2024-01-01','2024-02-01','2024-03-01');active('stay','2024-01-02','2024-02-02','2024-03-02')
    db.prepare('INSERT INTO client_outcomes VALUES (?,?,?,?,?,?)').run('left','left','2024-04-01','','admin','2024-04-01')
    db.prepare('INSERT INTO client_outcomes VALUES (?,?,?,?,?,?)').run('stay','renewed','2024-05-31','','admin','2024-05-31')
    let r=compareClientPatterns({from:'2024-01-01',to:'2024-12-31',months:3,followup_days:60})
    assert.equal(r.target_clients,1);assert.equal(r.comparison_clients,1);assert.deepEqual(r.series.map(s=>s.months_before_index),[-3,-2,-1]);assert.equal(r.series[0].target.clients,1)
    tasksDb.prepare('DELETE FROM task_ingest WHERE day=?').run('2024-02-05');r=compareClientPatterns({from:'2024-01-01',to:'2024-12-31',months:3,followup_days:60})
    assert.equal(r.series[1].target.clients,0);assert.equal(r.series[1].target.sessions,null)
})
test('a lookback reaching before the window still counts the client (clamped), never drops it silently',()=>{
    // Found by an agent run: 12 months before an outcome, in a window starting mid-month, gave 0 target clients.
    observed('2024-01-01','2024-12-31');active('left2','2024-01-20','2024-02-01','2024-03-01');active('stay2','2024-01-21','2024-02-02','2024-03-02')
    db.prepare('INSERT OR REPLACE INTO client_outcomes VALUES (?,?,?,?,?,?)').run('left2','left','2024-04-10','','admin','2024-04-10')
    const r=compareClientPatterns({client:'left2',from:'2024-01-15',to:'2024-12-31',months:12,followup_days:60})
    assert.equal(r.target_clients,1,'clamped lookback still counts the client')
    assert.deepEqual(r.target_excluded,[])
    assert.equal(r.series.at(-1)!.months_before_index,-1)
})
test('MCP disclosure preserves all requested dates and bounds rows with exact omission counts',()=>{
    observed('2021-01-01','2024-12-31')
    const r=analyticalResult('task_map',{when:'2021-01-01 to 2024-12-31'},{_lensJson:{label:'',value:{rows:Array.from({length:1000},(_,i)=>({id:i,payload:'x'.repeat(100)}))}}}) as {_lensJson:{value:{coverage:{requested:{from:string;to_exclusive:string}};omitted_rows_by_path:Record<string,number>}}}
    assert.equal(r._lensJson.value.coverage.requested.from,'2021-01-01');assert.equal(r._lensJson.value.coverage.requested.to_exclusive,'2025-01-01');assert.ok(r._lensJson.value.omitted_rows_by_path.rows>0);assert.ok(JSON.stringify(r).length<30000)
    assert.equal(coverage({from:'2021-01-01',to:'2024-12-31'}).covered_days,1461)
})
