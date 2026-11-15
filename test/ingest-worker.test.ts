import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('service ingestion serializes, invalidates readers, survives a worker exit, and restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lens-ingest-worker-'))
    process.env.TASKS_DB = join(dir, 'tasks.db')
    process.env.TRIAGE_DB = join(dir, 'triage.db')
    process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
    process.env.TASKS_BACKFILL_DAYS_PER_RUN = '0'
    process.env.LENS_SYNTHETIC_EVENTS = '300'
    process.env.LENS_INGEST_BOOTSTRAP = new URL('../tools/fixtures/synthetic-ingest.ts', import.meta.url).href
    process.env.LENS_SYNTHETIC_CRASH_FILE = join(dir, 'crash')
    const T = await import('../src/core/tasks.ts')
    const { ingestOwner } = await import('../src/core/ingestowner.ts')
    const { AnalysisWorkerPool } = await import('../src/mcp/jobpool.ts')
    const pool = new AnalysisWorkerPool(1)
    const findInPool = () => pool.run({ name: 'find_task', args: { query: '' }, caller: { who: 'test', admin: true, dashboardRole: 'share', surveyRole: 'none' } }).promise
    const { ingestMessages } = await import('../src/core/ingestmessages.ts')
    const day = new Date().toISOString().slice(0, 10)
    const messages: unknown[] = []
    const listen = (message: unknown) => messages.push(message)
    ingestMessages.on('stored', listen)
    try {
        T.storeAttempts(day, [])
        const empty = JSON.stringify(await findInPool())
        assert.match(empty, /candidates/)
        assert.doesNotMatch(empty, /t_DlgSave/)
        assert.deepEqual(T.findTasks(''), []) // memoize empty catalog
        let computes = 0
        const read = () => T.cached('worker-test', {}, async () => { computes++; return T.findTasks('') })
        await read()
        T.useTaskHistoryWorker()
        const generation = T.historyGeneration()
        const first = T.runIngest({ days: [day], maxBackfill: 0 })
        assert.equal(T.ingestStatus().running, true)
        await T.runIngest({ days: ['2020-01-01'] }) // skipped while running
        await first
        assert.equal(T.ingestStatus().running, false)
        assert.equal(T.ingestStatus().days_done, 1)
        assert.equal(T.ingestStatus().last_error, null)
        assert.ok(T.ingestStatus().last_run)
        assert.ok(T.historyGeneration() > generation)
        assert.ok((await read()).length > 0)
        assert.equal(computes, 2)
        assert.match(JSON.stringify(await findInPool()), /t_DlgSave/, 'reused analysis worker invalidates its catalog')
        assert.ok(messages.some(m => (m as { kinds: string[] }).kinds.includes('day')))
        T.tasksDb.exec("INSERT INTO week_done VALUES ('2099-01-01','now',1)")
        await T.runIngest({ days: [], maxBackfill: 0 })
        assert.ok(T.tasksDb.prepare('SELECT 1 FROM week_done').get(), 'cleanup keeps weekly observations')
        writeFileSync(process.env.LENS_SYNTHETIC_CRASH_FILE, '')
        await assert.rejects(T.ingestDay(day), /worker stopped/)
        assert.equal(T.ingestStatus().running, false)
        assert.match(T.ingestStatus().last_error!, /worker stopped/)
        await T.ingestDay(day) // restart on next manual request, same dispatcher
        assert.equal(T.ingestStatus().running, false)
        assert.equal(T.findTasks('').length, 1)
        assert.equal(T.tasksDb.prepare('PRAGMA busy_timeout').get()!.timeout, 30000)
    } finally {
        ingestMessages.off('stored', listen)
        pool.close()
        await ingestOwner.close()
        T.tasksDb.close()
        const { db } = await import('../src/core/db.ts'); db.close()
        rmSync(dir, { recursive: true, force: true })
    }
})
