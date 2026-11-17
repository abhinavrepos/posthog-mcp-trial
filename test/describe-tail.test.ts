import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'lens-describe-tail-'))
Object.assign(process.env, { TASKS_DB: join(dir, 't.db'), TRIAGE_DB: join(dir, 'm.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_PROJECT_ID: 'test', POSTHOG_PERSONAL_API_KEY: 'test' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { storeAggregateDaily } = await import('../src/core/aggregatedaily.ts')
const { describeAppEvents, required } = await import('../src/core/appevents.ts')
const { toolContext } = await import('../src/core/toolcontext.ts')
after(() => { tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })

// "Describe our events since 2023" ends today: its last days are not processed yet. Those days made the rollup
// check fail and the answer fell back to a 7-day live read, which the agent reported as the volume of the years.
test('a window ending after the processed history is answered from the rollups, naming the unprocessed days', async (t) => {
    const reg = required(), DAY = 86400000, first = Date.parse('2026-01-01')
    for (let i = 0; i < 10; i++) {
        const day = new Date(first + i * DAY).toISOString().slice(0, 10)
        storeAggregateDaily(tasksDb, day, [{ event: reg.events.screen, client: 'C1', app_version: 'v1', dialog: 'D1', dialog_name: 'Deal', tab: '', action: 'OPEN', button: '', n: 100, users: ['u'], sessions: ['s' + i] }])
        tasksDb.prepare('INSERT INTO task_ingest VALUES (?,1,100,0,0,1,?,1)').run(day, new Date().toISOString())
    }
    const live: string[] = []
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
        live.push(String(init.body))
        return new Response(JSON.stringify({ columns: [], results: [] }))
    })
    // Requested through 2026-01-13 (exclusive): 3 days past the history, which ends on 2026-01-10.
    const window = { from: new Date(first), to: new Date(first + 13 * DAY), label: 'test', precision: 'range' as const }
    const v = await toolContext.run({ window, clients: new Set(), correlationId: 'x' }, () => describeAppEvents(13))
    assert.deepEqual(v.events.map((e) => [e.name, e.count]), [[reg.events.screen, 1000]])
    assert.match(v.note, /Counts cover 2026-01-01 to 2026-01-10 from Lens's daily history; the last 3 days of the requested window are not processed yet/)
    assert.deepEqual(v.window, { from: window.from.toISOString(), to: new Date(first + 10 * DAY).toISOString() })
    assert.deepEqual(v.requested_window, { from: window.from.toISOString(), to: window.to.toISOString() })
    assert.ok(!live.some((b) => /GROUP BY event/.test(b)), 'no live event count')
})


test('seven-day vocabulary fallback retains answered and requested dates through history and concise output', async (t) => {
    const { analyticalResult } = await import('../src/mcp/historyresult.ts')
    const { applyDetail } = await import('../src/mcp/structured.ts')
    const queries: string[] = []
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
        queries.push(String(init.body))
        return new Response(JSON.stringify({ columns: [], results: [] }))
    })
    const window = { from: new Date('2026-04-01'), to: new Date('2026-07-01'), label: 'Q2', precision: 'range' as const }
    const v = await toolContext.run({ window, clients: new Set(), correlationId: 'fallback' }, () => describeAppEvents(91))
    assert.deepEqual(v.window, { from: '2026-06-24T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' })
    assert.deepEqual(v.requested_window, { from: window.from.toISOString(), to: window.to.toISOString() })
    assert.match(v.note, /counts cover only.*at most 7 recent days/)
    assert.ok(queries.some(q => q.includes('2026-06-24T00:00:00.000Z')))
    for (const detail of ['full', 'concise'] as const) {
        const result = applyDetail('describe_app_events', analyticalResult('describe_app_events', {}, { _lensJson: { label: 'Vocabulary', value: v } }, window), detail) as any
        const out = result._lensJson.value
        assert.deepEqual(out.window, { from: '2026-06-24', to: '2026-06-30' })
        assert.deepEqual(out.requested_window, v.requested_window)
        assert.equal(out.coverage.requested.from, window.from.toISOString())
        assert.equal(out.coverage.answered[0].from, v.window.from)
        assert.match(out.note, /counts cover only/)
    }
})
