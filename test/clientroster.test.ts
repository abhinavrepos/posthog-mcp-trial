import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'lens-roster-'))
Object.assign(process.env, { TASKS_DB: join(dir, 'tasks.db'), TRIAGE_DB: join(dir, 'main.db'), POSTHOG_PROJECT_ID: 'test', POSTHOG_PERSONAL_API_KEY: 'test' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { refreshClientStore, storedClients } = await import('../src/core/clientroster.ts')
const { knownClients } = await import('../src/core/resolve.ts')
after(() => { tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })
test('empty roster scans once, then bounded increments discover new clients without a population cap', async (t) => {
    const requests: { query: string; values: Record<string, string> }[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)).query
        requests.push(body)
        const rows = requests.length === 1 ? Array.from({ length: 1001 }, (_, i) => [`client-${i}`, `Client ${i}`, new Date().toISOString()]) : requests.length === 18 ? [['new-client', 'New client', new Date().toISOString()]] : []
        return new Response(JSON.stringify({ columns: ['id', 'name', 'last_seen'], results: rows }), { status: 200 })
    })
    await refreshClientStore()
    // The full scan is 17 bounded slices (newest first) that tile the 1500 days exactly, never one 4-year query.
    const full = requests.slice(0, 17)
    assert.equal(requests.length, 17)
    assert.ok(full.every((r) => Date.parse(r.values.until) - Date.parse(r.values.since) <= 90 * 86400000))
    for (let i = 1; i < full.length; i++) assert.equal(full[i].values.until, full[i - 1].values.since)
    assert.ok(Date.parse(full.at(-1)!.values.since) < Date.now() - 1499 * 86400000)
    const watermark = String(tasksDb.prepare("SELECT value FROM task_state WHERE key = 'roster:scanned'").get()!.value)
    await refreshClientStore()
    assert.equal(storedClients().length, 1002)
    assert.equal(storedClients().find((c) => c.id === 'new-client')!.name, 'New client')
    assert.match(requests[17].query, /timestamp >= \{since\} AND timestamp < \{until\}/)
    assert.equal(requests[17].values.since, new Date(Date.parse(watermark) - 2 * 86400000).toISOString())
    await knownClients()
    assert.equal((await knownClients()).length, 1002)
    assert.ok(requests.slice(17).every((r) => Date.parse(r.values.since) > Date.now() - 2 * 86400000 - 60000))
})
test('stale full scan runs in the background while request refresh stays incremental; failures preserve names', async (t) => {
    tasksDb.prepare("INSERT OR REPLACE INTO task_state VALUES ('roster:full','2000-01-01T00:00:00.000Z')").run()
    let fullResolve: (() => void) | undefined, fullStarted = false
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const { values } = JSON.parse(String(init.body)).query
        if (Date.parse(values.since) < Date.now() - 30 * 86400000) { // a full-scan slice; increments start 2 days back
            fullStarted = true
            await new Promise<void>((resolve) => { fullResolve = resolve })
            throw new Error('full scan unavailable')
        }
        return new Response(JSON.stringify({ columns: [], results: [] }), { status: 200 })
    })
    await refreshClientStore()
    assert.equal(fullStarted, true)
    assert.ok(fullResolve)
    assert.equal(storedClients().find((c) => c.id === 'new-client')!.name, 'New client')
    fullResolve!()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(tasksDb.prepare("SELECT value FROM task_state WHERE key = 'roster:full'").get()!.value, '2000-01-01T00:00:00.000Z')
})
