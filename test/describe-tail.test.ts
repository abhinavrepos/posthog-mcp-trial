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
    const v = await toolContext.run({ window, clients: new Set(), correlationId: 'x' }, () => describeAppEvents(13)) as unknown as { events: { name: string; count: number }[]; window: string }
    assert.deepEqual(v.events.map((e) => [e.name, e.count]), [[reg.events.screen, 1000]])
    assert.match(v.window, /Counts cover 2026-01-01 to 2026-01-10 from Lens's daily history; the last 3 days of the requested window are not processed yet/)
    assert.ok(!live.some((b) => /GROUP BY event/.test(b)), 'no live event count')
})
