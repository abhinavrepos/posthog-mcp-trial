import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'lens-roster-seed-'))
Object.assign(process.env, { TASKS_DB: join(dir, 'tasks.db'), TRIAGE_DB: join(dir, 'main.db'), POSTHOG_PROJECT_ID: 'test', POSTHOG_PERSONAL_API_KEY: 'test' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { refreshClientStore, storedClients } = await import('../src/core/clientroster.ts')
after(() => { tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })

// Four years of history and an empty roster (a new install after its backfill): a request must not wait on a
// full PostHog scan that cannot finish in one query. The roster comes from the task history at once.
test('empty roster with task history is seeded from it; only the tail is scanned before answering', async (t) => {
    const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
    tasksDb.prepare("INSERT INTO client_names VALUES ('C04','Harbor & Pine Capital'),('C01','Brightwater Logistics')").run()
    for (const [d, c] of [[day(1400), 'C01'], [day(300), 'C01'], [day(3), 'C04']]) tasksDb.prepare('INSERT INTO client_daily VALUES (?,?,1,1,0,0,0)').run(d, c)
    const blocking: { since: string; until: string }[] = []
    let full = 0, release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const { values } = JSON.parse(String(init.body)).query
        if (Date.parse(values.since) < Date.now() - 30 * 86400000) { full++; await held } // background full scan
        else blocking.push(values)
        return new Response(JSON.stringify({ columns: ['id', 'name', 'last_seen'], results: [] }), { status: 200 })
    })
    await refreshClientStore()
    const names = new Map(storedClients().map((c) => [c.id, c]))
    assert.equal(names.get('C04')!.name, 'Harbor & Pine Capital')
    assert.equal(names.get('C01')!.last_seen, `${day(300)}T00:00:00.000Z`)
    // The request waited only for the days after the history (its end minus the 2-day overlap).
    assert.equal(blocking.length, 1)
    assert.equal(blocking[0].since, new Date(Date.parse(day(3)) + 86400000 - 2 * 86400000).toISOString())
    assert.equal(full, 1, 'the full scan starts in the background')
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(full > 1, 'the background full scan continues slice by slice')
})
