import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { TaskAttempt } from '../src/core/taskstypes.ts'

const dir = mkdtempSync(join(tmpdir(), 'rescue-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json' })
const { tasksDb, storeAttempts, forgetAnswers } = await import('../src/core/tasks.ts')
const { db } = await import('../src/core/db.ts')
const { rescueQueue, setRescueAction, RESCUE } = await import('../src/core/rescue.ts')
const { readAudit } = await import('../src/service/access.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
const shift = (s: string, n: number) => new Date(Date.parse(s) + n * 86400000).toISOString().slice(0, 10)
const baseline = { from: '2026-01-08', to: '2026-02-04' }, window = { from: '2026-02-05', to: '2026-03-04' }
function reset() {
    for (const t of ['task_attempts', 'task_daily', 'task_paths_daily', 'task_users_daily', 'task_catalog', 'task_finishes_daily', 'task_ingest', 'dialog_names', 'client_names']) tasksDb.exec(`DELETE FROM ${t}`)
    db.exec('DELETE FROM rescue_actions; DELETE FROM audit')
    forgetAnswers()
    for (let d = '2026-01-01'; d <= window.to; d = shift(d, 1)) storeAttempts(d, [])
}
function attempts(day: string, n: number, done = n, duration_s = 10, task_id = 't_Hedge', client = 'ACME', user = 'alice'): TaskAttempt[] {
    return Array.from({ length: n }, (_, i) => ({ day, client, task_id, user, session_id: `${client}-${task_id}-${i}`, path: ['Hedge'], started_at: day + 'T10:00:00Z', ended_at: day + 'T10:01:00Z', duration_s, outcome: i < done ? 'done' : 'failed', errors: i < done ? 0 : 1, offset_s: 0 }))
}
function put(day: string, a: TaskAttempt[]) { storeAttempts(day, a, { dialogNames: new Map([['Hedge', 'Hedge Designation']]), clientNames: new Map([['ACME', 'Acme Treasury']]) }) }
const queue = () => rescueQueue({ window, baseline })
const kinds = async () => (await queue()).clients[0]?.reasons.map(r => r.kind) || []

test('missing needs minimum baseline done and zero attempts, and excludes dropped', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 5))
    assert.deepEqual(await kinds(), ['missing'])
    const c = (await queue()).clients[0]
    assert.match(c.reasons[0].text, /Stopped doing Hedge Designation: 5 done before/)
    assert.equal(c.reasons[0].before, 5); assert.equal(c.reasons[0].now, 0)
    assert.match(c.next_step, /moved elsewhere/); assert.equal(c.critical_task?.task_id, 't_Hedge')
    put(baseline.from, attempts(baseline.from, 4)); assert.deepEqual(await kinds(), [])
    put(baseline.from, attempts(baseline.from, 5)); put(window.from, attempts(window.from, 1, 0))
    assert.deepEqual(await kinds(), ['dropped'], 'failed attempts still count as activity')
})
test('failing starts at 15 percentage points and needs minimum attempts in both', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 20)); put(window.from, attempts(window.from, 20, 17))
    assert.deepEqual(await kinds(), ['failing']); assert.match((await queue()).clients[0].next_step, /two failed attempts/)
    put(window.from, attempts(window.from, 20, 18)); assert.deepEqual(await kinds(), [])
    put(window.from, attempts(window.from, 4, 0)); assert.ok(!(await kinds()).includes('failing'))
    put(baseline.from, attempts(baseline.from, 4)); put(window.from, attempts(window.from, 5, 0)); assert.ok(!(await kinds()).includes('failing'))
})
test('slower merges done histograms, requires five done, 30 percent and ten seconds', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 5, 5, 60)); put(window.from, attempts(window.from, 5, 5, 90))
    assert.deepEqual(await kinds(), ['slower']); assert.match((await queue()).clients[0].next_step, /flow time page/)
    put(window.from, attempts(window.from, 5, 5, 60)); assert.deepEqual(await kinds(), [])
    put(baseline.from, attempts(baseline.from, 5, 5, 5)); put(window.from, attempts(window.from, 5, 5, 10)); assert.deepEqual(await kinds(), [], 'under ten seconds')
    put(baseline.from, attempts(baseline.from, 5)); put(window.from, attempts(window.from, 4, 4, 90)); assert.ok(!(await kinds()).includes('slower'))
    // Several days must merge rather than averaging their medians.
    put(window.from, attempts(window.from, 4, 4, 90)); put(shift(window.from, 1), attempts(shift(window.from, 1), 2, 2, 90)); assert.ok((await kinds()).includes('slower'))
})
test('slower includes exactly 30 percent and exactly ten seconds, excludes either below', async () => {
    reset()
    const durations = (day: string, values: number[]) => values.flatMap(s => attempts(day, 1, 1, s))
    // The stored buckets interpolate these medians to exactly 50 and 65 seconds.
    put(baseline.from, durations(baseline.from, [...Array(4).fill(10), ...Array(6).fill(45), ...Array(2).fill(90)]))
    put(window.from, durations(window.from, [...Array(5).fill(10), ...Array(6).fill(60), 90]))
    let reason = (await queue()).clients[0].reasons[0]
    assert.equal(reason.kind, 'slower'); assert.equal(reason.before, 50); assert.equal(reason.now, 65)
    put(window.from, durations(window.from, [...Array(6).fill(45), ...Array(6).fill(90)]))
    assert.ok(!(await kinds()).includes('slower'), 'median 60 is less than 30 percent above 50')
    put(baseline.from, attempts(baseline.from, 12, 12, 20)) // median 25
    put(window.from, durations(window.from, [...Array(4).fill(10), ...Array(6).fill(30), ...Array(2).fill(90)])) // median 35
    reason = (await queue()).clients[0].reasons[0]
    assert.equal(reason.kind, 'slower'); assert.equal(reason.now - reason.before, 10)
    put(window.from, durations(window.from, [...Array(5).fill(10), ...Array(6).fill(30), 90])) // median 32.5
    assert.ok(!(await kinds()).includes('slower'), '30 percent higher but less than ten seconds')
})
test('dropped and overall activity thresholds include equality, minimum volume, and exclude below', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 10)); put(window.from, attempts(window.from, 5)); assert.deepEqual(await kinds(), ['dropped'])
    assert.match((await queue()).clients[0].next_step, /used less/)
    put(window.from, attempts(window.from, 6)); assert.deepEqual(await kinds(), [])
    put(baseline.from, attempts(baseline.from, 4)); put(window.from, attempts(window.from, 2)); assert.deepEqual(await kinds(), [])
    put(baseline.from, attempts(baseline.from, 20)); put(window.from, attempts(window.from, 12)); assert.deepEqual(await kinds(), ['activity_drop'])
    assert.match((await queue()).clients[0].next_step, /overall use fell/)
    put(window.from, attempts(window.from, 13)); assert.deepEqual(await kinds(), [])
    put(baseline.from, attempts(baseline.from, 19)); put(window.from, attempts(window.from, 11)); assert.deepEqual(await kinds(), [])
})
test('regular users need two ISO weeks; count and fraction thresholds; text has no identities', async () => {
    reset()
    const people = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com', 'g@x.com']
    for (const d of [baseline.from, shift(baseline.from, 7)]) put(d, people.flatMap(u => attempts(d, 2, 2, 10, 't_Hedge', 'ACME', u)))
    for (const n of [1, 2]) put(shift(baseline.from, n), attempts(shift(baseline.from, n), 10, 10, 10, 't_Hedge', 'ACME', 'occasional@x.com'))
    put(window.from, people.slice(1).flatMap(u => attempts(window.from, 5, 5, 10, 't_Hedge', 'ACME', u)))
    assert.ok(!(await kinds()).includes('users_lost'), 'one of seven is below both thresholds')
    put(window.from, people.slice(2).flatMap(u => attempts(window.from, 6, 6, 10, 't_Hedge', 'ACME', u)))
    let r = (await queue()).clients[0].reasons.find(r => r.kind === 'users_lost')!
    assert.equal(r.now, 2); assert.equal(r.before, 7); assert.equal(r.evidence?.lost_users, 2); assert.doesNotMatch(r.text, /@|occasional/)
    assert.match((await queue()).clients[0].next_step, /changed role/)
    reset()
    for (const d of [baseline.from, shift(baseline.from, 7)]) put(d, people.slice(0, 3).flatMap(u => attempts(d, 2, 2, 10, 't_Hedge', 'ACME', u)))
    put(window.from, people.slice(1, 3).flatMap(u => attempts(window.from, 6, 6, 10, 't_Hedge', 'ACME', u)))
    r = (await queue()).clients[0].reasons[0]; assert.equal(r.kind, 'users_lost'); assert.equal(r.now, 1); assert.equal(r.before, 3)
})
test('weights, urgent override, stable ordering, all reasons and next step from strongest', async () => {
    reset()
    for (const d of [baseline.from, shift(baseline.from, 7)]) put(d, ['alice', 'bob'].flatMap(u => attempts(d, 1, 1, 10, 't_Hedge', 'ACME', u)))
    const c = (await rescueQueue({ window, baseline, min_attempts: 4 })).clients[0]
    assert.equal(c.score, 9 * Math.log2(6)); assert.ok(c.score < RESCUE.urgent); assert.equal(c.level, 'urgent'); assert.equal(c.reasons[0].kind, 'missing')
    reset(); put(baseline.from, attempts(baseline.from, 30)); assert.equal((await queue()).clients[0].score, 40); assert.equal((await queue()).clients[0].level, 'urgent')
    put(baseline.from, attempts(baseline.from, 29)); assert.equal((await queue()).clients[0].level, 'watch')
    reset()
    put(baseline.from, [...attempts(baseline.from, 20), ...attempts(baseline.from, 20, 20, 10, 't_Slow'), ...attempts(baseline.from, 20, 20, 10, 't_Fail'), ...attempts(baseline.from, 20, 20, 10, 't_Drop'), ...attempts(baseline.from, 5, 5, 10, 't_Hedge', 'Small')])
    put(window.from, [...attempts(window.from, 20, 20, 90, 't_Slow'), ...attempts(window.from, 10, 5, 10, 't_Fail'), ...attempts(window.from, 8, 8, 10, 't_Drop')])
    const r = await queue(); assert.equal(r.clients[0].client, 'ACME'); assert.equal(r.clients[0].level, 'urgent'); assert.equal(r.clients[1].level, 'watch')
    assert.ok(r.clients[0].reasons.length > 3); assert.deepEqual(r.clients[0].reasons.slice(0, 3).map(r => r.kind), ['missing', 'activity_drop', 'failing'])
})
test('coverage guards levels and reasons and lists missing/truncated days; defaults use last complete day', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 20))
    tasksDb.prepare('DELETE FROM task_ingest WHERE day=?').run(window.from); forgetAnswers()
    let r = await queue(); assert.equal(r.coverage.complete, false); assert.deepEqual(r.clients, []); assert.deepEqual(r.coverage.unprocessed, [window.from]); assert.match(r.coverage.text!, /Not processed/)
    storeAttempts(window.from, [], { truncated: true }); r = await queue(); assert.equal(r.coverage.complete, false)
    storeAttempts(window.from, []); r = await rescueQueue(); assert.deepEqual(r.window, window); assert.deepEqual(r.baseline, baseline); assert.equal(r.data_through, window.to)
    await assert.rejects(rescueQueue({ window: { from: 'bad', to: window.to } }), /Dates/)
    await assert.rejects(rescueQueue({ min_attempts: 0 }), /min_attempts/)
})
test('trend compares identical windows shifted seven days: new, worse, same and better', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 5)); assert.equal((await queue()).clients[0].trend, 'same')
    // Prior window includes Jan 29, making that prior queue unflagged.
    put('2026-01-29', attempts('2026-01-29', 5)); assert.equal((await queue()).clients[0].trend, 'new')
    reset(); put(baseline.from, attempts(baseline.from, 20)); put(window.to, attempts(window.to, 5)); assert.equal((await queue()).clients[0].trend, 'better')
    reset(); put(baseline.from, attempts(baseline.from, 5)); put('2026-01-29', attempts('2026-01-29', 2)); assert.equal((await queue()).clients[0].trend, 'worse')
})
test('actions validate, audit, remain fresh, hide expected declines, expire, and reappear at +50%', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 5))
    const by = 'pm@example.com', snooze = shift(new Date().toISOString().slice(0, 10), 7)
    for (const change of [{ status: 'bad' }, { owner: 'bad' }, { note: 'x'.repeat(501) }, { due: '2026-02-30' }, { status: 'expected' }, { status: 'expected', snooze_until: shift(snooze, 121) }, { score_at_snooze: 0 }, { due: 5 }, {}]) await assert.rejects(setRescueAction('ACME', change, by))
    const score = (await queue()).clients[0].score
    const a = await setRescueAction('ACME', { status: 'expected', snooze_until: snooze, owner: by, note: 'Known move' }, by)
    assert.equal(a.score_at_snooze, score); assert.equal(a.updated_by, by); assert.equal(readAudit({ action: 'rescue.updated' }).length, 1)
    assert.equal((await queue()).hidden_snoozed, 1); assert.equal((await queue()).clients.length, 0); assert.equal((await rescueQueue({ include_snoozed: true })).clients.length, 1)
    put(baseline.from, [...attempts(baseline.from, 5), ...attempts(baseline.from, 5, 5, 10, 't_Second')])
    const r = await queue(); assert.equal(r.hidden_snoozed, 0); assert.equal(r.clients[0].reasons[0].kind, 'worse_since_snoozed')
    await setRescueAction('ACME', { note: 'Updated note' }, by)
    assert.equal((await queue()).clients[0].reasons[0].kind, 'worse_since_snoozed', 'editing a note must not reset the snooze score')
    db.prepare('UPDATE rescue_actions SET score_at_snooze=?').run(r.clients[0].score / 1.49)
    assert.equal((await queue()).hidden_snoozed, 1, 'below 50 percent stays hidden')
    db.prepare('UPDATE rescue_actions SET score_at_snooze=?').run(r.clients[0].score / 1.5)
    assert.equal((await queue()).hidden_snoozed, 0, 'exactly 50 percent reappears')
    await setRescueAction('ACME', { status: 'resolved', due: '2026-11-30' }, by)
    assert.equal((await queue()).clients[0].action?.status, 'resolved')
    db.prepare("UPDATE rescue_actions SET status='expected', snooze_until='2020-01-01'").run()
    assert.equal((await queue()).clients.length, 1)
})
test('cache repeats identically and storeAttempts invalidates history', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 5)); const r = await queue()
    const start = performance.now(); assert.deepEqual(await queue(), r); assert.ok(performance.now() - start < 10)
    put(window.from, attempts(window.from, 5)); assert.equal((await queue()).clients.length, 0)
})
test('year of 50 clients × 40 tasks daily rows is under 1 second cold and 10ms cached', async t => {
    reset()
    const hist = JSON.stringify(Array.from({ length: 21 }, (_, i) => i === 2 ? 10 : 0))
    const row = tasksDb.prepare('INSERT OR REPLACE INTO task_daily VALUES (?,?,?,?,?,?,?,?,?)')
    const ingest = tasksDb.prepare('INSERT OR REPLACE INTO task_ingest VALUES (?,0,0,0,0,0,?)')
    tasksDb.exec('BEGIN')
    for (let i = 0; i < 365; i++) {
        const d = shift(window.to, -i); ingest.run(d, d)
        for (let c = 0; c < 50; c++) for (let t = 0; t < 40; t++) row.run(d, `c${c}`, `t_Task${t}`, i < 28 ? 5 : 10, i < 28 ? 5 : 10, 0, 0, 1, hist)
    }
    tasksDb.exec('COMMIT'); forgetAnswers()
    let start = performance.now(); const r = await queue(); const cold = performance.now() - start
    start = performance.now(); const hot = await queue(); const warm = performance.now() - start
    t.diagnostic(`730,000 daily rows: cold ${cold.toFixed(1)} ms; cached ${warm.toFixed(2)} ms`)
    assert.equal(r.clients.length, 50); assert.deepEqual(hot, r)
    assert.ok(cold < 1000, `cold ${cold.toFixed(1)}ms`); assert.ok(warm < 10, `cached ${warm.toFixed(1)}ms`)
})

test('default comparison is the same length as the window, just before it', async () => {
    const { rescueQueue } = await import('../src/core/rescue.ts')
    const q = await rescueQueue({ window: { from: '2026-03-15', to: '2026-03-28' } })
    assert.deepEqual(q.baseline, { from: '2026-03-01', to: '2026-03-14' })
    const q28 = await rescueQueue({ window: { from: '2026-03-01', to: '2026-03-28' } })
    assert.deepEqual(q28.baseline, { from: '2026-02-01', to: '2026-02-28' })
})

test('snoozing while viewing a custom period: score from that period, hidden there; unflagged snoozes stay hidden', async () => {
    reset()
    // Flagged only in a 14-day view: work stops in the last fortnight, while the default 28-day view still sees it.
    const recent = { from: shift(window.to, -13), to: window.to }, before14 = { from: shift(recent.from, -14), to: shift(recent.from, -1) }
    put(before14.from, attempts(before14.from, 8))
    const view = { window: recent, baseline: before14 }
    const flagged = await rescueQueue(view)
    assert.equal(flagged.clients[0]?.reasons[0].kind, 'missing')
    assert.equal((await rescueQueue({})).clients.length, 0, 'not flagged in the default view')
    const snooze = shift(new Date().toISOString().slice(0, 10), 10)
    const a = await setRescueAction('ACME', { status: 'expected', snooze_until: snooze }, 'pm@example.com', view)
    assert.equal(a.score_at_snooze, flagged.clients[0].score, 'the score kept is the one the person saw')
    const after = await rescueQueue(view)
    assert.equal(after.clients.length, 0); assert.equal(after.hidden_snoozed, 1)
    // Snoozed while not flagged at all (score 0): stays hidden until the date instead of "worse" at once.
    await setRescueAction('ACME', { status: 'open', snooze_until: null }, 'pm@example.com')
    const z = await setRescueAction('ACME', { status: 'expected', snooze_until: snooze }, 'pm@example.com')
    assert.equal(z.score_at_snooze, 0)
    const hidden = await rescueQueue(view)
    assert.equal(hidden.clients.length, 0); assert.equal(hidden.hidden_snoozed, 1)
})

test('recovery captures first acted-on reasons, preserves them, and requires complete evidence after contact', async () => {
    reset(); put(baseline.from, attempts(baseline.from, 5))
    const action = await setRescueAction('ACME', { status: 'contacted' }, 'pm@example.com', { window, baseline })
    assert.deepEqual(JSON.parse(action.reasons_at_action!), [{ kind: 'missing', task_id: 't_Hedge' }])
    db.prepare('UPDATE rescue_actions SET acted_on=? WHERE client=?').run('2026-02-01', 'ACME')
    await setRescueAction('ACME', { status: 'resolved', note: 'Help offered' }, 'pm@example.com', { window, baseline })
    assert.equal((await queue()).clients[0].recovery, 'still_failing')
    db.prepare('UPDATE rescue_actions SET acted_on=?').run('2026-03-01')
    assert.equal((await queue()).clients[0].recovery, 'awaiting_evidence')
    put(window.from, attempts(window.from, 5))
    assert.equal((await queue()).recovered?.length, 0, 'overlapping action period cannot recover')
    db.prepare('UPDATE rescue_actions SET acted_on=?').run('2026-02-01')
    const recovered = await queue()
    assert.equal(recovered.clients.length, 0); assert.equal(recovered.recovered?.[0].recovery, 'recovered')
    assert.match(recovered.recovered![0].recovery_text!, /Hedge/)
    tasksDb.prepare('DELETE FROM task_ingest WHERE day=?').run(window.from); forgetAnswers()
    assert.equal((await queue()).recovered?.length, 0)
})

test('signal-only clients merge into rescue with exact weights, metadata and safe JSON', async () => {
    reset()
    for (let d = shift(window.to, -179); d <= window.to; d = shift(d, 1)) storeAttempts(d, [])
    for (const d of ['2025-12-29', '2026-01-29', '2026-02-26']) tasksDb.prepare('INSERT INTO errors_daily VALUES (?,?,?,?,?,?,?)').run(d, 'SIGNAL', 'DlgClose', 'save', 'Invalid date', 1, 0)
    tasksDb.prepare('INSERT INTO errors_daily VALUES (?,?,?,?,?,?,?)').run(window.to, 'SIGNAL', 'DlgClose', 'save', 'Rate missing', 10, 5) // a different error, so the close one stays concentrated at month-ends
    tasksDb.prepare('INSERT INTO user_daily VALUES (?,?,?,?,?)').run(window.to, 'SIGNAL', 'private-person@secret.example', 1, 0)
    forgetAnswers()
    const c = (await queue()).clients.find(c => c.client === 'SIGNAL')!
    assert.deepEqual(c.reasons.map(r => r.kind), ['giving_up', 'recurring_close_error'].sort())
    assert.equal(c.score, 6, 'two weight-three signals with no task baseline')
    assert.ok(c.reasons.find(r => r.kind === 'recurring_close_error')!.next_close_start)
    assert.doesNotMatch(JSON.stringify(await queue()), /private-person|secret.example|"users":\[/)
    tasksDb.exec('DELETE FROM errors_daily; DELETE FROM user_daily'); forgetAnswers()
})
