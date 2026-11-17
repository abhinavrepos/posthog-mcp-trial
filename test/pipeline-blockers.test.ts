import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-pipeline-blockers-'))
Object.assign(process.env, {
    TASKS_DB: join(dir, 'tasks.db'), TRIAGE_DB: join(dir, 'triage.db'),
    APP_EVENTS_FILE: 'config/app-events.reval.json', TASKS_BACKFILL_DAYS_PER_RUN: '0',
    POSTHOG_HOST: 'http://localhost', POSTHOG_PERSONAL_API_KEY: 'test', POSTHOG_PROJECT_ID: '1',
})
const T = await import('../src/core/tasks.ts')
const { db } = await import('../src/core/db.ts')
const { parseTimeWindow } = await import('../src/core/timewindow.ts')
after(() => { T.setTaskQuery(); T.tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

const span = (text: string, now: string) => {
    const w = parseTimeWindow(text, new Date(now), 'America/New_York')
    return [w.from.toISOString(), w.to.toISOString()]
}

test('reporter day windows end at local midnight on 23-hour and 25-hour DST days', () => {
    assert.deepEqual(span('yesterday', '2026-03-09T16:00:00Z'), ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'])
    assert.deepEqual(span('yesterday', '2026-11-02T17:00:00Z'), ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'])
})

test('yesterday and weekdays use the local calendar near midnight across DST', () => {
    // 00:30 Monday after spring-forward: subtracting 24 hours lands on Saturday.
    assert.deepEqual(span('yesterday', '2026-03-09T04:30:00Z'), ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'])
    assert.deepEqual(span('on Sunday', '2026-03-09T04:30:00Z'), ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'])
    // 23:30 Sunday after fall-back: subtracting 24 hours is still Sunday.
    assert.deepEqual(span('yesterday', '2026-11-02T04:30:00Z'), ['2026-10-31T04:00:00.000Z', '2026-11-01T04:00:00.000Z'])
})

test('part-of-day and implicit yesterday clock windows preserve wall-clock hours across DST', () => {
    assert.deepEqual(span('yesterday afternoon', '2026-03-09T16:00:00Z'), ['2026-03-08T16:00:00.000Z', '2026-03-08T22:00:00.000Z'])
    assert.deepEqual(span('yesterday afternoon', '2026-11-02T17:00:00Z'), ['2026-11-01T17:00:00.000Z', '2026-11-01T23:00:00.000Z'])
    assert.deepEqual(span('around 3pm', '2026-03-08T14:00:00Z'), ['2026-03-07T19:15:00.000Z', '2026-03-07T20:45:00.000Z'])
})

test('automatic ingestion retries a finalized day whose dimension query failed, including after restart', async t => {
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
    const window = { from: day, to: day }
    let dimensionReads = 0
    const timeout = globalThis.setTimeout
    t.mock.method(globalThis, 'setTimeout', ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => timeout(fn, 0, ...args)) as typeof setTimeout)
    T.setTaskQuery(async (sql, values) => {
        if (sql.includes('min(timestamp) AS first_event')) return [{ first_event: `${day}T00:00:00Z` }]
        if (sql.includes('groupUniqArray') && values?.from === day) {
            dimensionReads++
            throw Object.assign(new Error('dimension read failed'), { status: 503 })
        }
        return []
    })
    try {
        await T.runIngest({ days: [day] })
        assert.equal(dimensionReads, 4, 'all transient-error retries were exhausted')
        assert.equal(T.tasksDb.prepare('SELECT finalized FROM task_ingest WHERE day=?').get(day)!.finalized, 1)
        assert.match(JSON.stringify(T.coverage(window)), /query_failed/)
        // A fresh process must recover using only persisted state, as after a service restart.
        const restarted = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            const T = await import(${JSON.stringify(new URL('../src/core/tasks.ts', import.meta.url).href)});
            const scans = [];
            T.setTaskQuery(async (sql, values) => {
                if (sql.includes('first_ctime')) scans.push(values.from);
                return [];
            });
            await T.runIngest({ maxBackfill: 1 });
            assert.ok(scans.includes(${JSON.stringify(day)}), 'the failed completed day must be scanned again');
            T.tasksDb.close();
            (await import(${JSON.stringify(new URL('../src/core/db.ts', import.meta.url).href)})).db.close();
        `], { encoding: 'utf8', timeout: 15_000 })
        assert.equal(restarted.status, 0, restarted.stderr)
        assert.equal(T.coverage(window).complete, true)
        assert.ok(T.tasksDb.prepare('SELECT 1 FROM aggregate_dimension_daily WHERE day=?').get(day))
        // A later confirmed retention loss is terminal even if an older failure marker remains.
        T.tasksDb.prepare('INSERT OR REPLACE INTO task_state VALUES (?,?)').run('analysis_unavailable:' + day, 'source expired')
        T.tasksDb.prepare('INSERT OR REPLACE INTO task_state VALUES (?,?)').run('query_failed:' + day, 'older failed query')
        const scans: string[] = []
        T.setTaskQuery(async (sql, values) => { if (sql.includes('first_ctime')) scans.push(String(values?.from)); return [] })
        await T.runIngest({ maxBackfill: 1 })
        assert.ok(!scans.includes(day), 'known expired days must not consume every subsequent backfill budget')
    } finally { T.setTaskQuery() }
})

test('intraday aggregates disclose expired source on every intersected UTC day instead of reporting zero', async t => {
    const { aggregateEvents } = await import('../src/core/aggregate.ts')
    const day = '2026-01-10'
    T.tasksDb.prepare('INSERT INTO aggregate_dimension_skipped VALUES (?,?)').run(day, 'source_expired')
    let reads = 0
    t.mock.method(globalThis, 'fetch', async () => { reads++; return Response.json({ columns: ['events'], results: [[0]] }) })
    try {
        for (const from of ['2026-01-10T10:00:00Z', '2026-01-09T10:00:00Z']) {
            const result = await aggregateEvents({ from: new Date(from), to: new Date('2026-01-10T16:00:00Z') })
            assert.equal(result.coverage.status, 'unavailable', 'an expired partial day cannot become a complete zero count')
            assert.deepEqual(result.totals, {})
        }
        assert.equal(reads, 0, 'a live query cannot reconstruct known expired evidence')
        // The exclusive midnight endpoint does not intersect the expired day.
        const before = await aggregateEvents({ from: new Date('2026-01-09'), to: new Date(day) })
        assert.equal(before.coverage.status, 'complete')
        assert.equal(reads, 1)
    } finally { T.tasksDb.prepare('DELETE FROM aggregate_dimension_skipped WHERE day=?').run(day) }
})

test('concurrent rescue status and note updates preserve both changes', async () => {
    const { setRescueAction } = await import('../src/core/rescue.ts')
    const client = 'concurrent-client'
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
    const view = { window: { from: day, to: day }, compare: 'none' as const }
    await setRescueAction(client, { note: 'original note' }, 'first@example.test', view)
    // Contacting reads history asynchronously. A teammate can save a note during that read.
    const contacted = setRescueAction(client, { status: 'contacted' }, 'first@example.test', view)
    const note = setRescueAction(client, { note: 'teammate update' }, 'second@example.test', view)
    await Promise.all([contacted, note])
    const action = db.prepare('SELECT status,note FROM rescue_actions WHERE client=?').get(client)!
    assert.equal(action.status, 'contacted')
    assert.equal(action.note, 'teammate update', 'saving status must not overwrite a concurrently saved note')
})
