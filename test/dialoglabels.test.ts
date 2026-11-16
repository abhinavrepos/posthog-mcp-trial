import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'lens-dialog-labels-'))
Object.assign(process.env, { TASKS_DB: join(dir, 'tasks.db'), TRIAGE_DB: join(dir, 'main.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_PROJECT_ID: 'test', POSTHOG_PERSONAL_API_KEY: 'test' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { dialogLabels } = await import('../src/core/appevents.ts')
const { briefSources } = await import('../src/core/brief.ts')
after(() => { tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })

// A 3-year reval_brief or find_trade only needs dialog names. Counting exact sessions per dialog live over years
// took minutes and hit ClickHouse's memory limit; names come from history, live reads stay within 30 days.
test('dialog labels for a multi-year window read live at most 30 days and take the rest from history', async (t) => {
    tasksDb.prepare("INSERT INTO dialog_names VALUES ('DlgOld','Old Hedge'),('DlgBoth','Stored name'),('DlgUnknown','UNKNOWN')").run()
    const reads: { from: string; to: string }[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const { values } = JSON.parse(String(init.body)).query
        reads.push({ from: values.from, to: values.to })
        return new Response(JSON.stringify({ columns: ['dialog', 'names', 'opens', 'sessions', 'clients'], results: [['DlgBoth', ['Live name'], 3, 2, 1]] }))
    })
    const to = new Date('2026-11-14T00:00:00Z'), from = new Date('2023-11-14T00:00:00Z')
    const names = await dialogLabels(from, to)
    assert.deepEqual(reads, [{ from: new Date(+to - 30 * 86400000).toISOString(), to: to.toISOString() }])
    assert.equal(names.get('DlgBoth')!.name, 'Live name')
    assert.equal(names.get('DlgOld')!.name, 'Old Hedge')
    assert.equal(names.has('DlgUnknown'), false)
    assert.equal(briefSources.dialogNames, dialogLabels)
    // A short window is unchanged: one live read of the window itself.
    reads.length = 0
    const short = await dialogLabels(new Date(+to - 7 * 86400000), to)
    assert.deepEqual(reads, [{ from: new Date(+to - 7 * 86400000).toISOString(), to: to.toISOString() }])
    assert.equal(short.has('DlgOld'), false)
})
