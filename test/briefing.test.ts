import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const dir = mkdtempSync(join(tmpdir(), 'briefing-'))
Object.assign(process.env, { TRIAGE_DB: join(dir,'main.db'), TASKS_DB: join(dir,'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json' })
const { tasksDb, forgetAnswers } = await import('../src/core/tasks.ts')
const { db } = await import('../src/core/db.ts')
const { mondayBrief } = await import('../src/core/briefing.ts')
const { draftRescueSurvey } = await import('../src/core/rescuesurveys.ts')
const { compileSurvey } = await import('../src/core/surveys.ts')
const shift = (d: string,n: number) => new Date(Date.parse(d)+n*86400000).toISOString().slice(0,10)
after(() => { tasksDb.close(); db.close(); rmSync(dir,{recursive:true,force:true}) })
function reset() {
    for (const t of ['task_daily','task_users_daily','task_catalog','task_ingest','client_names','errors_daily','user_daily']) tasksDb.exec(`DELETE FROM ${t}`)
    db.exec('DELETE FROM briefing_snapshots; DELETE FROM rescue_actions')
    for (let i=0;i<220;i++) tasksDb.prepare('INSERT INTO task_ingest VALUES (?,0,0,0,0,0,?)').run(shift('2026-06-30',-i),'2026-07-01')
    tasksDb.prepare("INSERT INTO task_catalog VALUES ('t_Hedge','Hedge','Hedge Designation','save','2026-01-01','2026-06-30')").run()
    forgetAnswers()
}
function row(day: string, client: string, n: number) {
    tasksDb.prepare('INSERT OR REPLACE INTO task_daily VALUES (?,?,?,?,?,?,0,1,?)').run(day,client,'t_Hedge',n,n,0,JSON.stringify(Array(21).fill(0)))
    tasksDb.prepare('INSERT OR REPLACE INTO client_names VALUES (?,?)').run(client,client+' Company')
    forgetAnswers()
}
function action(client: string, due: string, status = 'contacted') {
    db.prepare('INSERT OR REPLACE INTO rescue_actions (client,status,due,updated_by,updated_at) VALUES (?,?,?,?,?)').run(client,status,due,'pm@example.com','2026-06-01')
}
test('briefing diffs, daily snapshots, overdue, close-soon, quiet rotation and retention', async () => {
    reset()
    for (let i=0;i<20;i++) { row(shift('2026-06-15',-i),'quiet-a',1); row(shift('2026-06-15',-i),'quiet-b',1) }
    row('2026-06-03','risk',8)
    action('risk','2026-06-14'); action('resolved','2026-06-01','resolved'); action('expected','2026-06-01','expected')
    for (const d of ['2026-03-29','2026-04-28','2026-05-28']) tasksDb.prepare('INSERT INTO errors_daily VALUES (?,?,?,?,?,?,?)').run(d,'close','Hedge','save','Invalid date',1,0)
    forgetAnswers()
    const now = new Date('2026-06-16T10:00:00Z')
    const first = await mondayBrief({by:'PM@example.com',now})
    assert.deepEqual(first.period,{from:'2026-06-09',to:'2026-06-15'})
    assert.ok(first.sections.new_or_worse.some(c=>c.client==='risk'))
    assert.equal(first.sections.overdue.length,1); assert.equal(first.sections.close_soon[0].client,'close')
    assert.equal(new URL(first.sections.close_soon[0].open,'http://lens').searchParams.get('task'),'t_Hedge')
    assert.equal(first.sections.quiet_review?.client,'quiet-a'); assert.match(first.sections.quiet_review!.text,/silence is not satisfaction/)
    const again = await Promise.all([mondayBrief({by:'pm@example.com',now}),mondayBrief({by:'pm@example.com',now})])
    assert.deepEqual(again,[first,first]); assert.equal((db.prepare('SELECT count(*) AS n FROM briefing_snapshots').get() as any).n,1)
    const next = await mondayBrief({by:'pm@example.com',now:new Date('2026-06-17T10:00:00Z')})
    assert.equal(next.sections.quiet_review?.client,'quiet-b'); assert.equal(next.sections.new_or_worse.length,0)
    const other = await mondayBrief({by:'other@example.com',now})
    assert.ok(other.sections.new_or_worse.length>0,'diff is personal')
    for(let i=1;i<=28;i++) await mondayBrief({by:'pm@example.com',now:new Date(shift('2026-06-17',i)+'T10:00:00Z')})
    assert.equal((db.prepare('SELECT count(*) AS n FROM briefing_snapshots WHERE "by"=?').get('pm@example.com') as any).n,26)
})
test('briefing reports verified recovery once and never treats missing coverage as recovery', async () => {
    reset(); row('2026-06-03','risk',8)
    action('risk','2026-06-14')
    db.prepare('UPDATE rescue_actions SET acted_on=?,reasons_at_action=? WHERE client=?').run('2026-06-01',JSON.stringify([{kind:'missing',task_id:'t_Hedge'}]),'risk')
    const first = await mondayBrief({by:'pm@example.com',now:new Date('2026-06-16')})
    assert.equal(first.sections.recovered.length,0)
    row('2026-06-15','risk',8)
    const recovered = await mondayBrief({by:'pm@example.com',now:new Date('2026-06-17')})
    assert.equal(recovered.sections.recovered[0].client,'risk')
    assert.match(recovered.sections.recovered[0].open,/history=1/)
    const next = await mondayBrief({by:'pm@example.com',now:new Date('2026-06-18')})
    assert.equal(next.sections.recovered.length,0)
    tasksDb.prepare('DELETE FROM task_ingest WHERE day=?').run('2026-06-17'); forgetAnswers()
    const incomplete = await mondayBrief({by:'new@example.com',now:new Date('2026-06-18')})
    assert.equal(incomplete.sections.recovered.length,0); assert.match(incomplete.headline,/incomplete/)
})
test('Ask them saves targeted valid drafts with task and export questions, notes, and refuses surveys off', async () => {
    reset()
    let saved: any, options: any, note: any
    const client = { client:'acme',client_name:'Acme',score:5,level:'watch' as const,trend:'new' as const,reasons:[{kind:'missing' as const,task_id:'t_Hedge',task_name:'Hedge Designation',text:'Stopped',now:0,before:5}],next_step:'Ask' }
    const queue = {coverage:{complete:true,unprocessed:[]},window:{from:'2026-06-01',to:'2026-06-28'},baseline:{from:'2026-05-04',to:'2026-05-31'},data_through:'2026-06-28',clients:[client],hidden_snoozed:0,note:''}
    const deps = { surveysActive:()=>true,rescueQueue:async()=>queue,saveSurvey:async(spec: any,opts: any)=>{saved=spec;options=opts;return {survey:{id:'draft-123'} as any,compiled:compileSurvey(spec,opts)}},setRescueAction:async(_c: string,change: any)=>{note=change;return {} as any} }
    const result = await draftRescueSurvey('acme','pm@example.com',deps)
    assert.equal(result.survey_id,'draft-123'); assert.match(result.message,/Draft created/)
    assert.deepEqual(saved.clients,['acme']); assert.deepEqual(options.clientIds,['acme']); assert.deepEqual(saved.steps,[{opens:'Hedge'}])
    assert.deepEqual(saved.questions,[{type:'rating',scale:5,text:'How easy was Hedge Designation for you this month?'},{type:'open',text:'What would make it easier?'}])
    assert.match(saved.name,/\[Rescue\] Acme/); assert.match(note.note,/draft-123/)
    assert.equal(compileSurvey(saved,options).problems.some(p=>p.level==='error'),false)
    const exported = {...queue,clients:[{...client,reasons:[{kind:'work_moving_out' as const,text:'Exports rose',now:0,before:0}]}]}
    await draftRescueSurvey('acme','pm@example.com',{...deps,rescueQueue:async()=>exported})
    assert.deepEqual(saved.steps,[{button:'XLSX Export'}]); assert.equal(saved.questions[0].type,'single'); assert.equal(saved.questions[0].choices.length,5)
    await assert.rejects(draftRescueSurvey('acme','pm@example.com',{...deps,surveysActive:()=>false}),/switched off/)
    await assert.rejects(draftRescueSurvey('unknown','pm@example.com',deps),/no current rescue/)
})

test('quiet review respects action updates, caps new clients at five and scans all JSON for user identities', async () => {
    reset()
    for(let i=0;i<14;i++) { row(shift('2026-06-15',-i),'quiet-a',1); row(shift('2026-06-15',-i),'quiet-b',1) }
    action('quiet-a','2026-07-01','open')
    for(let i=0;i<8;i++) row('2026-06-03',`risk-${i}`,6)
    tasksDb.prepare('INSERT INTO user_daily VALUES (?,?,?,?,?)').run('2026-06-15','quiet-a','private-user@hidden.example',1,0)
    tasksDb.prepare('UPDATE client_names SET name=? WHERE client=?').run('Company private-user@hidden.example','risk-0')
    forgetAnswers()
    const brief=await mondayBrief({by:'pm@example.com',now:new Date('2026-06-16')})
    assert.equal(brief.sections.new_or_worse.length,5); assert.equal(brief.counts.new_or_worse,8)
    assert.equal(brief.sections.quiet_review?.client,'quiet-b')
    assert.doesNotMatch(JSON.stringify(brief),/private-user|hidden.example/)
    assert.doesNotMatch((db.prepare('SELECT payload FROM briefing_snapshots').get() as any).payload,/private-user|hidden.example/)
})
