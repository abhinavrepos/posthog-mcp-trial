import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'lens-signals-'))
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.TRIAGE_DB = join(dir, 'main.db')
const { tasksDb: db, forgetAnswers, storeAttempts } = await import('../src/core/tasks.ts')
const { clientSignals } = await import('../src/core/signals.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const to = '2026-06-15'
const shift = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10)
function reset() {
    for (const table of ['ops_daily', 'errors_daily', 'user_daily', 'client_daily', 'task_ingest', 'task_users_daily', 'task_catalog']) db.exec(`DELETE FROM ${table}`)
    const ins = db.prepare('INSERT INTO task_ingest VALUES (?,0,0,0,0,0,?)')
    for (let i = 0; i < 180; i++) ins.run(shift(to, -i), to)
    forgetAnswers()
}
const signals = async () => (await clientSignals({ to })).signals
const error = (day: string, chains: number, unrecovered: number, template = 'Invalid date') => db.prepare('INSERT OR REPLACE INTO errors_daily VALUES (?,?,?,?,?,?,?)').run(day, 'ACME', 'DlgSave', 'save', template, chains, unrecovered)

test('giving up exact thresholds, just below, baseline and coverage', async () => {
    reset(); error(to, 10, 4); error(shift(to, -14), 10, 2)
    assert.equal((await signals())[0]?.kind, 'giving_up')
    error(to, 11, 4); forgetAnswers(); assert.equal((await signals()).length, 0)
    error(to, 10, 4); error(shift(to, -14), 100, 21); forgetAnswers(); assert.equal((await signals()).length, 0)
    error(shift(to, -14), 10, 2); db.prepare('DELETE FROM task_ingest WHERE day=?').run(shift(to, -20)); forgetAnswers()
    assert.equal((await signals()).length, 0); assert.equal((await clientSignals({ to })).coverage.complete, false)
})
test('close windows count Jan 30 and Feb 1 once, numeric months and next start', async () => {
    reset()
    for (const day of ['2026-01-30', '2026-02-01', '2026-02-25', '2026-03-03']) error(day, 1, 0)
    assert.equal((await signals()).length, 0)
    error('2026-03-27', 1, 0); forgetAnswers()
    const s = (await signals())[0]
    assert.equal(s.kind, 'recurring_close_error'); assert.deepEqual(s.evidence.months, [202601, 202602, 202603]); assert.equal(s.next_close_start, '2026-06-26')
    db.prepare('DELETE FROM errors_daily WHERE day=?').run('2026-03-27'); error('2026-03-26', 1, 0); forgetAnswers(); assert.equal((await signals()).length, 0)
})
function exports(recentExports = 10, recentProductive = 30, days = 3, after = 0, recentDone = 21) {
    const row = db.prepare('INSERT OR REPLACE INTO client_daily VALUES (?,?,1,3,?,?,?)')
    row.run(shift(to, -28), 'ACME', 30, 84, 0)
    for (let i = 0; i < days; i++) row.run(shift(to, -i), 'ACME', i ? 1 : recentExports - days + 1, i ? 0 : recentDone, i ? 0 : after)
    const op = db.prepare("INSERT OR REPLACE INTO ops_daily VALUES (?,?,'Dlg','save','productive',?,0,0,0,0)")
    op.run(shift(to, -28), 'ACME', 270); op.run(to, 'ACME', recentProductive)
}
test('export shares, counts, active days and completion/error alternatives', async () => {
    reset(); exports(); assert.equal((await signals())[0]?.kind, 'work_moving_out')
    for (const [n, p, days, after, done] of [[9, 27, 3, 0, 21], [10, 31, 3, 0, 21], [10, 30, 2, 0, 21], [10, 30, 3, 2, 22]]) {
        reset(); exports(n, p, days, after, done); assert.equal((await signals()).length, 0)
    }
    reset(); exports(10, 30, 3, 3, 28); assert.match((await signals())[0].text, /3 exports came right after an error/)
})
function keyPeople(cohort = 3) {
    const ins = db.prepare('INSERT INTO user_daily VALUES (?,?,?,?,?)')
    for (let i = 70; i >= 15; i--) {
        for (let u = 0; u < cohort; u++) ins.run(shift(to, -i), 'ACME', `private-person-${u}@secret.example`, 1, u === 0 ? 3 : u === 1 ? 7 : 0)
    }
    ins.run(to, 'ACME', 'private-person-1@secret.example', 1, 105)
    db.prepare("INSERT INTO task_catalog VALUES ('t_Dlg','Dlg','Save work','',?,?)").run(shift(to, -70), to)
    db.prepare("INSERT INTO task_users_daily VALUES (?, 'ACME','t_Dlg',?)").run(shift(to, -30), 'private-person-0@secret.example')
}
test('key person share, drop boundary, task names, privacy and small cohort', async () => {
    reset(); keyPeople()
    const s = (await signals()).find(s => s.kind === 'key_person_gap')!
    assert.ok(s); assert.deepEqual(s.tasks, ['Save work']); assert.equal(s.evidence.share, .3)
    assert.doesNotMatch(JSON.stringify(await signals()), /private-person|secret\.example/)
    db.prepare('UPDATE user_daily SET completed=106 WHERE day=?').run(to); forgetAnswers(); assert.equal((await signals()).length, 0)
    reset(); keyPeople(2); assert.equal((await signals()).length, 0)
    reset(); keyPeople(); db.prepare('UPDATE user_daily SET completed=2 WHERE user=? AND day < ?').run('private-person-0@secret.example', shift(to, -14)); forgetAnswers(); assert.equal((await signals()).length, 0)
})
test('identity-bearing templates and titles are scrubbed; evidence contains only numbers', async () => {
    reset(); keyPeople()
    for (const d of ['2026-01-30', '2026-02-27', '2026-03-30']) error(d, 1, 0, 'private-person-0@secret.example failed')
    const out = await signals(); assert.doesNotMatch(JSON.stringify(out), /private-person|secret\.example/)
    for (const s of out) for (const value of Object.values(s.evidence)) assert.ok(typeof value === 'number' || Array.isArray(value) && value.every(n => typeof n === 'number'))
})
test('store invalidates cached answers and default to uses the last full day', async () => {
    reset(); error(to, 10, 4); const r = await clientSignals({ to })
    assert.equal(await clientSignals({ to }), r); assert.equal((await clientSignals()).to, to)
    storeAttempts(to, []); assert.equal((await signals()).length, 0)
})
test('synthetic year of 50 clients: cold under 1s and cached under 10ms', async t => {
    reset()
    const c = db.prepare('INSERT OR REPLACE INTO client_daily VALUES (?,?,1,3,10,5,3)')
    const u = db.prepare('INSERT INTO user_daily VALUES (?,?,?,1,2)')
    const o = db.prepare("INSERT INTO ops_daily VALUES (?,?,'Dlg','save','productive',10,5,0,0,0)")
    const e = db.prepare("INSERT INTO errors_daily VALUES (?,?,'Dlg','save','Invalid date',10,4)")
    const ingest = db.prepare('INSERT OR REPLACE INTO task_ingest VALUES (?,0,0,0,0,0,?)')
    db.exec('BEGIN')
    for (let i = 0; i < 365; i++) {
        const d = shift(to, -i); ingest.run(d, d)
        for (let n = 0; n < 50; n++) { const client = `c${n}`; c.run(d, client); o.run(d, client); e.run(d, client); for (let p = 0; p < 3; p++) u.run(d, client, `identity-${p}`) }
    }
    db.exec('COMMIT'); forgetAnswers()
    let start = performance.now(); const r = await clientSignals({ to }); const cold = performance.now() - start
    start = performance.now(); assert.equal(await clientSignals({ to }), r); const hot = performance.now() - start
    t.diagnostic(`cold ${cold.toFixed(1)}ms; cached ${hot.toFixed(2)}ms`); assert.ok(cold < 1000); assert.ok(hot < 10)
})

test('v1 processed history and pruned captures cannot look like zero activity', async () => {
    reset(); error(to, 10, 4)
    const day = shift(to, -40)
    db.prepare('INSERT INTO task_state VALUES (?,?)').run('signals_missing:' + day, '1')
    forgetAnswers(); assert.equal((await signals()).length, 0)
    assert.ok((await clientSignals({ to })).coverage.unprocessed.includes(day))
    storeAttempts(day, [], { summary: { ops: [], errors: [], users: [], clients: [] } })
    assert.equal((await signals())[0]?.kind, 'giving_up')
})

test('key person needs six weeks, a median gap at most three, and zero recent events', async () => {
    reset(); keyPeople()
    db.prepare('INSERT INTO user_daily VALUES (?,?,?,1,0)').run(shift(to, -13), 'ACME', 'private-person-0@secret.example')
    assert.equal((await signals()).length, 0)
    reset(); keyPeople()
    db.prepare('DELETE FROM user_daily WHERE user=? AND day < ?').run('private-person-0@secret.example', shift(to, -44))
    // Restore enough work share after removing three weeks; cadence alone is insufficient.
    db.prepare('UPDATE user_daily SET completed=100 WHERE user=?').run('private-person-0@secret.example')
    assert.equal((await signals()).length, 0)
    reset(); keyPeople()
    const who = 'private-person-0@secret.example'
    db.prepare('DELETE FROM user_daily WHERE user=?').run(who)
    const ins = db.prepare('INSERT INTO user_daily VALUES (?,?,?,1,30)')
    for (let i = 70; i >= 15; i -= 4) ins.run(shift(to, -i), 'ACME', who)
    assert.equal((await signals()).length, 0)
})

test('export share must reach both the 15 point increase and 1.5 times baseline', async () => {
    reset(); exports(12, 8)
    db.prepare("UPDATE ops_daily SET submits=45 WHERE day=?").run(shift(to, -28))
    assert.equal((await signals())[0]?.kind, 'work_moving_out')
    db.prepare('UPDATE ops_daily SET submits=9 WHERE day=?').run(to); forgetAnswers()
    assert.equal((await signals()).length, 0)
})
test('median active-day gap of exactly three days qualifies', async () => {
    reset(); keyPeople()
    const who = 'private-person-0@secret.example'
    db.prepare('DELETE FROM user_daily WHERE user=?').run(who)
    const ins = db.prepare('INSERT INTO user_daily VALUES (?,?,?,1,100)')
    for (let i = 70; i >= 15; i -= 3) ins.run(shift(to, -i), 'ACME', who)
    const s = (await signals()).find(s => s.kind === 'key_person_gap')
    assert.equal(s?.evidence.median_gap_days, 3)
})
