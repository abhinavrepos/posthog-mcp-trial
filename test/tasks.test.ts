import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { RawEvent, Step } from '../src/core/appevents.ts'
import { DURATION_BUCKETS, type TaskAttempt } from '../src/core/taskstypes.ts'

const dir = mkdtempSync(join(tmpdir(), 'lens-tasks-'))
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { db: triageDb } = await import('../src/core/db.ts')
const { parseAppEvents, toSteps } = await import('../src/core/appevents.ts')
const { extractAttempts, storeAttempts, tasksDb, taskMap, flowTime, findTasks, ingestDay, ingestStatus, runIngest, setTaskQuery, forgetAnswers } = await import('../src/core/tasks.ts')
const reg = parseAppEvents(JSON.parse(readFileSync('config/app-events.reval.json', 'utf8')))
after(() => { tasksDb.close(); triageDb.close(); rmSync(dir, { recursive: true, force: true }) })
const DAY = 86_400_000
const day = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10)
const before = day(2), now = day(1)
function reset() {
    for (const t of ['task_attempts', 'task_daily', 'task_paths_daily', 'task_users_daily', 'task_catalog', 'task_finishes_daily', 'task_ingest', 'dialog_names', 'client_names', 'task_state']) tasksDb.exec(`DELETE FROM ${t}`)
}
function attempt(d = now, task = 't_DlgSave', outcome: TaskAttempt['outcome'] = 'done', duration = 40, user = 'alice'): TaskAttempt {
    return { day: d, client: 'ACME', user, session_id: 'sid', task_id: task, path: ['DlgList', task.slice(2)], started_at: `${d}T10:00:00.000Z`,
        ended_at: new Date(Date.parse(`${d}T10:00:00Z`) + duration * 1000).toISOString(), duration_s: duration, outcome,
        errors: outcome === 'failed' ? 1 : 0, first_error: outcome === 'failed' ? 'Invalid date' : undefined, offset_s: 15 }
}
function raw(i: number, dialog: string, extra: Partial<RawEvent> = {}): RawEvent {
    return { sid: 'session', ts: new Date(Date.parse(`${now}T10:00:00Z`) + i * 1000).toISOString(), ctime: 1_800_000_000_000 + i * 1000,
        event: 'PageView', dialog, action: 'OPEN', client: 'ACME', user: 'ENV|01|ACME|alice', ...extra }
}
function submit(i: number, dialog = 'DlgSave') { return raw(i, dialog, { event: 'Event', action: '', button: 'Save' }) }
function reply(i: number, good = true) { return raw(i, good ? 'toast' : 'messagebox', { event: 'Event', action: '', button: good ? 'Trade Id 1234 Updated' : 'Invalid date' }) }

test('extracts done, failed, abandoned, retries, and consecutive attempts', () => {
    const steps = toSteps([raw(0, 'DlgList'), raw(2, 'DlgSave'), submit(5), reply(6, false), submit(8), reply(9),
        raw(10, 'DlgOther'), submit(14, 'DlgOther'), reply(15), raw(20, 'menuCmb', { event: 'Event', control: 'SEARCH', action: 'x' }),
        raw(21, 'DlgSave'), submit(25), reply(26, false), raw(700, 'DlgSave'), submit(710)], reg)
    const a = extractAttempts([steps], reg)
    assert.deepEqual(a.map((x) => x.outcome), ['done', 'done', 'failed', 'abandoned'])
    assert.deepEqual(a.map((x) => x.task_id), ['t_DlgSave', 't_DlgOther', 't_DlgSave', 't_DlgSave'])
    assert.equal(a[0].errors, 1); assert.equal(a[0].first_error, 'Invalid date')
    assert.equal(a[0].duration_s, 9); assert.equal(a[1].duration_s, 5)
    assert.equal(a[1].offset_s, 10); assert.equal(a[0].user, 'alice')
    assert.deepEqual(a[0].path, ['DlgList', 'DlgSave'])
    assert.deepEqual(a, extractAttempts([steps], reg))
})
test('paths collapse consecutive opens, exclude special dialogs, and retain first 3 / last 4', () => {
    const events = [raw(0, 'menuCmb'), raw(1, 'Dlg0'), raw(2, 'Dlg0'), ...Array.from({ length: 9 }, (_, i) => raw(i + 3, `Dlg${i + 1}`)), submit(20, 'Dlg9'), reply(21)]
    const a = extractAttempts([toSteps(events, reg)], reg)[0]
    assert.deepEqual(a.path, ['Dlg0', 'Dlg1', 'Dlg2', '…', 'Dlg6', 'Dlg7', 'Dlg8', 'Dlg9'])
    assert.equal(a.path.length, 8)
    assert.deepEqual(extractAttempts([toSteps([submit(0, 'menuCmb'), reply(1)], reg)], reg), [])
    // The browser clock can differ from the server clock for the next episode.
    const s = toSteps([raw(0, 'DlgList'), raw(10, 'menuCmb', { event: 'Event', control: 'SEARCH' }), raw(11, 'DlgSave'), submit(13), reply(14)], reg)
    s[1].raw.ctime = s[0].raw.ctime! + 20_000
    assert.equal(extractAttempts([s], reg)[0].offset_s, 20)
    for (const x of s) x.raw.ctime = undefined
    assert.equal(extractAttempts([s], reg)[0].offset_s, 10)
})

test('map flags and boundaries, default baseline, identities, labels, and idempotent replacement', async () => {
    reset()
    const make = (d: string, task: string, n: number, done: number, duration = 40) => Array.from({ length: n }, (_, i) => attempt(d, `t_${task}`, i < done ? 'done' : 'failed', duration, i % 2 ? 'alice' : 'bob'))
    const b = [...make(before, 'Missing', 5, 5), ...make(before, 'Dropped', 10, 10), ...make(before, 'Slower', 5, 5, 40),
        ...make(before, 'Failing', 20, 20), ...make(before, 'UnderMin', 4, 4), ...make(before, 'UnderDrop', 10, 10),
        ...make(before, 'UnderSlow', 5, 5, 40), ...make(before, 'UnderFail', 20, 20)]
    const n = [...make(now, 'Dropped', 5, 5), ...make(now, 'Slower', 5, 5, 60), ...make(now, 'Failing', 20, 17), ...make(now, 'New', 5, 5),
        ...make(now, 'UnderDrop', 6, 6), ...make(now, 'UnderSlow', 5, 5, 44), ...make(now, 'UnderFail', 20, 18)]
    storeAttempts(before, b, { dialogNames: new Map([['Missing', 'Missing work']]), clientNames: new Map([['ACME', 'Acme Treasury']]) })
    storeAttempts(now, n)
    const map = await taskMap({ window: { from: now, to: now } })
    assert.deepEqual(map.params.baseline, { from: before, to: before })
    const flags = (task: string) => map.rows.find((r) => r.task_id === `t_${task}`)!.flags
    assert.deepEqual(flags('Missing'), ['missing', 'dropped'])
    assert.deepEqual(flags('Dropped'), ['dropped']); assert.deepEqual(flags('Slower'), ['slower'])
    assert.deepEqual(flags('Failing'), ['failing']); assert.deepEqual(flags('New'), ['new'])
    for (const task of ['UnderMin', 'UnderDrop', 'UnderSlow', 'UnderFail']) assert.deepEqual(flags(task), [])
    assert.equal(map.clients[0].client_name, 'Acme Treasury'); assert.equal(map.clients[0].missing, 1)
    assert.equal(map.rows.find((r) => r.task_id === 't_Missing')!.task_name, 'Missing work')
    const stable = await taskMap({ window: { from: before, to: now }, baseline: { from: day(4), to: day(3) } })
    assert.equal(stable.rows.find((r) => r.task_id === 't_Slower')!.now.users, 2)
    assert.equal(map.rows[0].flags.length > 0, true)
    storeAttempts(now, n)
    assert.deepEqual((await taskMap({ window: { from: now, to: now } })).rows, map.rows)
    storeAttempts(now, [])
    assert.equal((await taskMap({ window: { from: now, to: now } })).rows.every((r) => !r.now.attempts), true)
})

test('a failed write rolls the entire replacement back, including ingest metadata', async () => {
    reset()
    storeAttempts(now, [attempt(now)])
    const original = await taskMap({ window: { from: now, to: now } })
    const bad = attempt(now); bad.duration_s = NaN
    assert.throws(() => storeAttempts(now, [bad]), /NOT NULL/)
    assert.deepEqual((await taskMap({ window: { from: now, to: now } })).rows, original.rows)
    assert.equal(ingestStatus().attempts, 1)
    // Coverage never declares today fully processed or a truncated day complete.
    storeAttempts(day(0), [])
    assert.equal((await taskMap({ window: { from: now, to: now } })).data_through, now)
    tasksDb.prepare('UPDATE task_ingest SET truncated = 1 WHERE day = ?').run(now)
    forgetAnswers() // a direct edit: Lens itself only writes through storeAttempts, which renews answers
    const partial = await taskMap({ window: { from: now, to: now } })
    assert.equal(partial.data_through, null); assert.match(partial.note, /truncated/)
})

test('slower requires both the 30 percent and ten second thresholds, and five done', async () => {
    reset()
    const cases = ['ExactRatio', 'UnderRatio', 'ExactSeconds', 'UnderSeconds', 'UnderDone']
    for (const d of [before, now]) storeAttempts(d, cases.flatMap((task) => Array.from({ length: 80 }, () => attempt(d, `t_${task}`))))
    const hist = (entries: [number, number][]) => JSON.stringify(DURATION_BUCKETS.map((_, i) => entries.find(([b]) => b === i)?.[1] || 0))
    const update = tasksDb.prepare('UPDATE task_daily SET dur_hist = ? WHERE day = ? AND task_id = ?')
    for (const task of ['ExactRatio', 'UnderRatio', 'UnderDone']) update.run(hist([[6, 80]]), before, `t_${task}`) // median 52.5
    update.run(hist([[6, 29], [7, 40], [8, 11]]), now, 't_ExactRatio') // median 68.25 = +30%
    update.run(hist([[6, 30], [7, 40], [8, 10]]), now, 't_UnderRatio') // median 67.5
    update.run(hist([[7, 80]]), now, 't_UnderDone')
    tasksDb.prepare("UPDATE task_daily SET done = 4 WHERE task_id = 't_UnderDone' AND day = ?").run(now)
    for (const task of ['ExactSeconds', 'UnderSeconds']) update.run(hist([[4, 80]]), before, `t_${task}`) // median 25
    update.run(hist([[4, 20], [5, 60]]), now, 't_ExactSeconds') // median 35
    update.run(hist([[4, 24], [5, 56]]), now, 't_UnderSeconds') // median below 35
    const rows = (await taskMap({ window: { from: now, to: now } })).rows
    for (const task of cases) assert.equal(rows.find((r) => r.task_id === `t_${task}`)!.flags.includes('slower'), task.startsWith('Exact'), task)
})

test('flow series, paths, histogram interpolation, week selection, errors, replay, and search', async () => {
    reset()
    const a = [attempt(before, 't_DlgSave', 'done', 20), attempt(before, 't_DlgSave', 'done', 25), attempt(before, 't_DlgSave', 'failed', 80)]
    a[1].user = 'bob'; a[1].path = ['DlgSave']
    storeAttempts(before, a, { dialogNames: new Map([['DlgSave', 'Save Trade']]) })
    const other = attempt(now, 't_DlgSave', 'done', 60); other.client = 'OTHER'
    storeAttempts(now, [attempt(now, 't_DlgSave', 'done', 20), other, attempt(now, 't_DlgNew', 'abandoned')])
    const f = await flowTime({ task: 't_DlgSave', window: { from: before, to: now }, client: 'ACME' })
    assert.equal(f.params.granularity, 'day'); assert.equal(f.summary.attempts, 4); assert.equal(f.summary.done, 3)
    assert.equal(f.summary.users, 2); assert.equal(f.summary.median_s, 25); assert.equal(f.summary.p90_s, 29)
    assert.equal(f.all_clients.median_s, 20 + 10 * 2 / 3)
    assert.equal(f.series.length, 2); assert.equal(f.series_all![1].attempts, 2)
    assert.equal(f.paths[0].attempts, 3); assert.equal(f.paths[0].share, 0.75); assert.equal(f.paths[0].done_rate, 2 / 3)
    assert.equal(f.paths[0].labels.at(-1), 'Save Trade')
    assert.equal(f.slowest[0].duration_s, 80); assert.match(f.slowest[0].replay_url, /sid/)
    assert.deepEqual(f.top_errors, [{ template: 'Invalid date', count: 1 }]); assert.equal(f.data_through, now)
    const week = await flowTime({ task: 't_DlgSave', window: { from: day(60), to: now } })
    assert.equal(week.params.granularity, 'week'); assert.equal(new Date(week.series[0].period).getUTCDay(), 1)
    assert.equal((await flowTime({ task: 't_DlgSave', window: { from: day(31), to: now } })).params.granularity, 'day')
    assert.equal(findTasks('TRADE dlg')[0].task_id, 't_DlgSave'); assert.equal(findTasks('trade nonexistent').length, 0)
    assert.equal(findTasks('')[0].attempts_90d, 5)
    const empty = await flowTime({ task: 't_DlgUnknown', window: { from: now, to: now } })
    assert.equal(empty.summary.median_s, null); assert.equal(empty.summary.done_rate, null)
    const status = ingestStatus(); assert.equal(status.days_done, 2); assert.equal(status.attempts, 6)
})

test('flow slowest limits are bounded, ordered and cached separately', async () => {
    reset()
    storeAttempts(now, Array.from({ length: 120 }, (_, i) => ({
        ...attempt(now, 't_DlgSave', i % 2 ? 'failed' : 'done', i + 1), session_id: `slow-${i}`,
    })))
    const p = { task: 't_DlgSave', window: { from: now, to: now } }
    const defaults = await flowTime(p)
    assert.equal(defaults.slowest.length, 10)
    const expanded = await flowTime({ ...p, slowest_limit: 100 })
    assert.deepEqual(expanded.slowest.map(a => a.duration_s), Array.from({ length: 100 }, (_, i) => 120 - i))
    assert.equal((await flowTime({ ...p, slowest_limit: 3 })).slowest.length, 3)
    assert.equal(await flowTime(p), defaults)
    assert.equal(await flowTime({ ...p, slowest_limit: 100 }), expanded)
    for (const slowest_limit of [0, -1, 101, 1.5, NaN, Infinity]) {
        await assert.rejects(flowTime({ ...p, slowest_limit }), /slowest_limit/)
    }
})

test('parameter validation is clear', async () => {
    for (const window of [{ from: '2026-02-30', to: now }, { from: now, to: before }, { from: day(401), to: now }]) await assert.rejects(taskMap({ window }), /Dates|Window/)
    await assert.rejects(flowTime({ task: 'invalid', window: { from: now, to: now } }), /task id/)
    await assert.rejects(taskMap({ window: { from: now, to: now }, client: 'x'.repeat(257) }), /Client/)
    await assert.rejects(taskMap({ window: { from: now, to: now }, min_attempts: 0 }), /min_attempts/)
    assert.throws(() => findTasks('', 0), /limit/)
    assert.throws(() => storeAttempts(now, [attempt(before)]), /belong/)
    await assert.rejects(runIngest({ days: ['invalid'] }), /Dates/)
})

test('ingest: one session query, 50,000-event keyset pages with timestamp ties, few queries per day; reruns replace the day', async () => {
    reset()
    const ids = Array.from({ length: 2750 }, (_, i) => ({ sid: `s${String(i).padStart(4, '0')}`, first_ts: `${now}T10:00:00.000Z`, first_ctime: 0 }))
    // A full page of 50,000 rows with equal timestamps forces a second read that must continue after the last uuid.
    const page1 = Array.from({ length: 50_000 }, (_, i) => {
        const e = i < 3 ? [raw(0, 'DlgSave'), submit(1), reply(2)][i] : raw(3, 'DlgList')
        return { ...e, sid: ids[0].sid, event_uuid: `u${String(i).padStart(5, '0')}`, ctime: 0, client_name: 'Acme' }
    })
    let sessionQueries = 0, eventQueries = 0
    const fake = async (sql: string, values: Record<string, unknown> = {}) => {
        assert.match(sql, /LIMIT \d+/)
        assert.equal(sql.includes(now), false, 'dates must be bound')
        assert.match(sql, /\$session_id/, 'sessions matched on the $session_id column')
        if (sql.includes('GROUP BY sid')) { sessionQueries++; return ids }
        eventQueries++
        assert.match(sql, /ORDER BY \$session_id, timestamp, toString\(uuid\) LIMIT 50000/)
        if (values.uuid === '') return page1
        assert.deepEqual([values.sid, values.uuid], [ids[0].sid, page1.at(-1)!.event_uuid], 'continues after the last row')
        return []
    }
    await ingestDay(now, fake)
    assert.deepEqual([sessionQueries, eventQueries], [1, 2], 'a full Reval-size day costs a handful of queries')
    assert.equal(ingestStatus().attempts, 1)
    assert.match(findTasks('')[0].name, /Save → 'Trade Id … Updated'/)
    await ingestDay(now, fake)
    assert.equal(ingestStatus().attempts, 1, 'a rerun replaces the day')
    assert.equal((tasksDb.prepare('SELECT events FROM task_ingest').get() as { events: number }).events, 50_000)
    await ingestDay(now, async (sql) => { assert.match(sql, /LIMIT/); return [] })
    assert.equal(ingestStatus().attempts, 0); assert.equal(findTasks('').length, 0)
})

test('ingest retries when PostHog is busy or rate-limited, and gives up on other errors', async () => {
    reset()
    let calls = 0
    const busyTwice = async () => {
        if (++calls <= 2) throw Object.assign(new Error('under heavy load'), { status: calls === 1 ? 513 : 429 })
        return []
    }
    await ingestDay(now, busyTwice, [1, 1, 1])
    assert.equal(calls, 3, 'two busy answers, then it worked')
    calls = 0
    await ingestDay(now, async () => { if (++calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); return [] }, [1])
    assert.equal(calls, 2, 'a timeout is retried')
    calls = 0
    await assert.rejects(ingestDay(now, async () => { calls++; throw Object.assign(new Error('bad query'), { status: 400 }) }, [1, 1, 1]), /bad query/)
    assert.equal(calls, 1, 'no retry for a real error')
    calls = 0
    await assert.rejects(ingestDay(now, async () => { calls++; throw Object.assign(new Error('busy'), { status: 503 }) }, [1, 1]), /busy/)
    assert.equal(calls, 3, 'gives up after its waits')
})

test('scheduler continues after errors, serializes runs, backfills newest first, and prunes only attempts', async () => {
    reset()
    const { config } = await import('../src/core/config.ts')
    const seen: string[] = [], logs: string[] = [], oldError = console.error
    console.error = (line: string) => { logs.push(line) }
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    setTaskQuery(async (_sql, values = {}) => {
        seen.push(String(values.from))
        if (seen.length === 1) { await wait; throw new Error('temporary failure') }
        return []
    })
    const old = day(config.tasks.historyDays + 2)
    storeAttempts(old, [attempt(old)])
    try {
        const work = runIngest({ maxBackfill: 2 })
        assert.equal(ingestStatus().running, true)
        await runIngest({ days: [day(9)] })
        assert.equal(seen.length, 1)
        release(); await work
        assert.deepEqual(seen, [day(0), day(1), day(2), day(3)])
        assert.equal(ingestStatus().running, false)
        assert.match(ingestStatus().last_error!, /temporary failure/)
        assert.equal(JSON.parse(logs[0]).event, 'tasks.ingest_error')
        assert.equal((tasksDb.prepare('SELECT count(*) AS n FROM task_attempts').get() as { n: number }).n, 0)
        assert.equal((tasksDb.prepare('SELECT count(*) AS n FROM task_daily').get() as { n: number }).n, 1)
        assert.equal((tasksDb.prepare('SELECT count(*) AS n FROM task_users_daily').get() as { n: number }).n, 1)
        await runIngest({ days: [day(0)] })
        assert.equal(ingestStatus().last_error, null)
        assert.ok(ingestStatus().last_run)
    } finally { release(); setTaskQuery(); console.error = oldError }
})

test('scale: 365 days × 50 clients × 40 tasks, 200k attempts; queries <600ms, cached <5ms, extraction <3s', async () => {
    reset()
    const hist = JSON.stringify(DURATION_BUCKETS.map((_, i) => i === 7 ? 5 : 0))
    const path = JSON.stringify(['DlgList', 'DlgT0'])
    tasksDb.exec('BEGIN')
    const daily = tasksDb.prepare('INSERT INTO task_daily VALUES (?,?,?,?,?,?,?,?,?)')
    const paths = tasksDb.prepare('INSERT INTO task_paths_daily VALUES (?,?,?,?,?,?,?,?)')
    const users = tasksDb.prepare('INSERT INTO task_users_daily VALUES (?,?,?,?)')
    for (let d = 1; d <= 365; d++) for (let c = 0; c < 50; c++) for (let t = 0; t < 40; t++) {
        const date = day(d), client = `C${c}`, task = `t_DlgT${t}`
        daily.run(date, client, task, 6, 5, 1, 0, 1, hist)
        paths.run(date, client, task, path, path, 6, 5, hist)
        users.run(date, client, task, 'user')
    }
    const ins = tasksDb.prepare('INSERT INTO task_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < 200_000; i++) ins.run(day(1 + i % 365), `C${i % 50}`, 'user', `session${i}`, `t_DlgT${i % 40}`, path, path, `${now}T10:00:00Z`, `${now}T10:01:00Z`, 60 + i % 30, 'done', 0, null, 0)
    tasksDb.exec('COMMIT; ANALYZE')
    // Best of three: other test files run in parallel on the same machine, so one run can be unlucky.
    const best = async <T>(fn: () => Promise<T>) => {
        let ms = Infinity, out!: T
        for (let i = 0; i < 3; i++) { forgetAnswers(); const t = performance.now(); out = await fn(); ms = Math.min(ms, performance.now() - t) }
        return { ms, out }
    }
    // Timed without the cache (forgetAnswers before each run); then a repeat comes from the cache.
    const { ms: mapMs, out: map } = await best(() => taskMap({ window: { from: day(28), to: now }, min_attempts: 5 }))
    const repeat = performance.now(); await taskMap({ window: { from: day(28), to: now }, min_attempts: 5 }); const cachedMs = performance.now() - repeat
    assert.ok(cachedMs < 5, `cached taskMap took ${cachedMs}ms`)
    assert.equal(map.rows.length, 2000)
    const { ms: flowMs, out: flow } = await best(() => flowTime({ task: 't_DlgT0', client: 'C0', window: { from: day(365), to: now } }))
    assert.ok(flow.series.length >= 52)
    const steps: Step[][] = Array.from({ length: 22_000 }, () => toSteps([raw(0, 'DlgList'), raw(1, 'DlgSave'), submit(2), reply(3), raw(4, 'DlgSave')], reg))
    const startExtract = performance.now(), extracted = extractAttempts(steps, reg), extractMs = performance.now() - startExtract
    assert.equal(extracted.length, 22_000)
    console.log(`tasks scale: map=${mapMs.toFixed(1)}ms (cached ${cachedMs.toFixed(2)}ms) flow=${flowMs.toFixed(1)}ms extract110k=${extractMs.toFixed(1)}ms`)
    assert.ok(mapMs < 600, `taskMap took ${mapMs}ms`)
    assert.ok(flowMs < 600, `flowTime took ${flowMs}ms`)
    assert.ok(extractMs < 3000, `extraction took ${extractMs}ms`)
})

test('days not processed yet are never flagged as missing work', async () => {
    reset()
    // Baseline processed with work; the recent period not processed at all.
    for (let i = 20; i <= 33; i++) storeAttempts(day(i), Array.from({ length: 3 }, () => attempt(day(i))))
    const r = await taskMap({ window: { from: day(13), to: day(1) }, baseline: { from: day(33), to: day(20) } })
    assert.equal(r.coverage.complete, false)
    assert.equal(r.coverage.unprocessed.length, 13)
    assert.match(r.coverage.text!, /Not processed yet: 13 days/)
    assert.equal(r.rows.some((x) => x.flags.length), false, 'no flags while a period is unprocessed')
    // Once processed (empty days), a real stop is flagged.
    for (let i = 1; i <= 13; i++) storeAttempts(day(i), [])
    const done = await taskMap({ window: { from: day(13), to: day(1) }, baseline: { from: day(33), to: day(20) } })
    assert.equal(done.coverage.complete, true)
    assert.ok(done.rows.some((x) => x.flags.includes('missing')))
})
