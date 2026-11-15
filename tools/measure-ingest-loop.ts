// Run: node --import tsx tools/measure-ingest-loop.ts
import assert from 'node:assert/strict'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'lens-ingest-loop-'))
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.TASKS_BACKFILL_DAYS_PER_RUN = '0'
process.env.LENS_INGEST_BOOTSTRAP = new URL('./fixtures/synthetic-ingest.ts', import.meta.url).href
const tasks = await import('../src/core/tasks.ts')
const { ingestOwner } = await import('../src/core/ingestowner.ts')
const bootstrap = (await import('./fixtures/synthetic-ingest.ts')).default
const pause = () => new Promise(resolve => setTimeout(resolve, 30))
async function measure() {
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    await pause()
    const started = performance.now()
    const day = new Date().toISOString().slice(0, 10)
    await tasks.runIngest({ days: [day], maxBackfill: 0 })
    const seconds = (performance.now() - started) / 1000
    await pause()
    delay.disable()
    return { seconds: +seconds.toFixed(2), p99_ms: +(delay.percentile(99) / 1e6).toFixed(2), max_ms: +(delay.max / 1e6).toFixed(2) }
}
try {
    bootstrap()
    const before = await measure()
    tasks.setTaskQuery()
    tasks.useTaskHistoryWorker()
    const after = await measure()
    console.log(JSON.stringify({ events: Number(process.env.LENS_SYNTHETIC_EVENTS || 300000), before, after }, null, 2))
    assert.ok(before.seconds >= 2, 'Synthetic ingest must take seconds')
    assert.ok(after.p99_ms < 200, `Worker p99 ${after.p99_ms}ms exceeds 200ms`)
    assert.equal(tasks.ingestStatus().last_error, null)
} finally {
    await ingestOwner.close()
    tasks.tasksDb.close()
    const { db } = await import('../src/core/db.ts'); db.close()
    rmSync(dir, { recursive: true, force: true })
}
