import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

// Resilience drill: Lens's own SQLite files when the disk fills up, the file system turns read-only, or a file is
// damaged. The real reason must reach the log, the System page and Copilot, and the service must keep running.
const dir = mkdtempSync(join(tmpdir(), 'lens-resilience-storage-'))
Object.assign(process.env, { TRIAGE_ENV_FILE: '/tmp/lens-resilience-storage-absent.env', TRIAGE_DB: join(dir, 'triage.db'), TASKS_DB: join(dir, 'tasks.db') })
const { db, tx } = await import('../src/core/db.ts')
const { JobRunner } = await import('../src/core/jobs.ts')
const { plainReason } = await import('../src/core/jobhealth.ts')
const { toolError } = await import('../src/mcp/toolerror.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

/** Lets the file grow by no more pages: the next write that needs one fails with SQLITE_FULL, as on a full disk. */
function fillDisk(target: DatabaseSync): () => void {
    const pages = (target.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    target.exec(`PRAGMA max_page_count = ${pages}`)
    return () => target.exec('PRAGMA max_page_count = 1073741823')
}
const big = () => randomBytes(64 * 1024).toString('hex') // does not compress

test('a full disk during a transaction reports "the disk is full", not "cannot rollback"', () => {
    db.exec('CREATE TABLE IF NOT EXISTS resilience_drill (x TEXT)')
    const free = fillDisk(db)
    try {
        const e = (() => { try { tx(() => { for (let i = 0; i < 50; i++) db.prepare('INSERT INTO resilience_drill VALUES (?)').run(big()) }) } catch (e) { return e as Error } })()
        assert.ok(e, 'the write failed')
        assert.match(e.message, /database or disk is full/)
        assert.equal(plainReason(e), 'the disk is full')
        assert.equal(db.isTransaction, false)
    } finally { free() }
    // Space is back: the same write works without a restart.
    tx(() => db.prepare('INSERT INTO resilience_drill VALUES (?)').run('ok'))
    assert.equal((db.prepare('SELECT count(*) AS n FROM resilience_drill').get() as { n: number }).n, 1)
})

test('a job finishing on a full disk does not stop the service; the waiting caller gets its answer and a later poll is told why', async () => {
    const jobsDb = new DatabaseSync(':memory:'), runner = new JobRunner(jobsDb)
    const rejections: unknown[] = [], onRejection = (e: unknown) => { rejections.push(e) }
    process.on('unhandledRejection', onRejection)
    let release!: (v: unknown) => void
    const job = runner.start('alice', 'aggregate_events', {}, 'r', () => ({ promise: new Promise(r => { release = r }) }))
    await new Promise(r => setImmediate(r))
    const free = fillDisk(jobsDb)
    try {
        const answer = { rows: big() }
        release(answer)
        assert.deepEqual(await job.done, answer, 'the caller still waiting gets the result')
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(rejections, [], 'no unhandled rejection (it stopped the service)')
        const row = runner.get('alice', job.id, 'r')
        assert.equal(row.status, 'failed')
        assert.equal(row.error, "Lens could not store this job's result because the disk is full. Submit the tool again later.")
        const r = toolError(new Error(row.error!), 'get_job_result')
        assert.equal(r.kind, 'unavailable'); assert.match(r.result.content[0].text, /^Lens could not store this job's result because the disk is full\./)
    } finally { free(); process.off('unhandledRejection', onRejection); runner.close(); jobsDb.close() }
})

test('the job heartbeat survives a database that refuses writes instead of crashing the service every 15 s', t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const jobsDb = new DatabaseSync(':memory:'), runner = new JobRunner(jobsDb)
    const lines: string[] = []
    t.mock.method(console, 'log', (s: string) => { lines.push(s) })
    runner.start('alice', 'aggregate_events', {}, 'r', () => ({ promise: new Promise(() => {}) }))
    jobsDb.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON analysis_jobs BEGIN SELECT RAISE(ABORT, 'attempt to write a readonly database'); END`)
    assert.doesNotThrow(() => t.mock.timers.tick(15_000))
    assert.doesNotThrow(() => t.mock.timers.tick(60_000))
    assert.ok(lines.some(l => /analysis jobs: database write failed.*storage is read-only/.test(l)), 'one plain log line')
    jobsDb.exec('DROP TRIGGER refuse')
    runner.close(); jobsDb.close()
})

test('Copilot is told plainly when Lens itself cannot write: full disk, read-only storage, damaged file', () => {
    const cases: [string, RegExp, string][] = [
        ['database or disk is full', /^Lens's disk is full, so this could not finish\. A Lens administrator must free disk space/, 'the disk is full'],
        ["ENOSPC: no space left on device, write '/opt/posthog-lens/clips/x.mp4'", /^Lens's disk is full/, 'the disk is full'],
        ['attempt to write a readonly database', /^Lens cannot write its data \(its storage is read-only\)/, "Lens's storage is read-only"],
        ["EROFS: read-only file system, open '/opt/posthog-lens/run/triage.db'", /^Lens cannot write its data/, "Lens's storage is read-only"],
        ['database disk image is malformed', /^Lens's database file is damaged\. A Lens administrator must restore it from a backup/, "Lens's database file is damaged"],
        ['file is not a database', /^Lens's database file is damaged/, "Lens's database file is damaged"],
    ]
    for (const [raw, want, reason] of cases) {
        const r = toolError(new Error(raw), 'client_experience')
        assert.equal(r.kind, 'unavailable', raw)
        assert.match(r.result.content[0].text, want)
        assert.doesNotMatch(r.result.content[0].text, /\/opt\/|\.db'|\.mp4/, 'no internal path')
        assert.equal(plainReason(new Error(raw)), reason)
    }
})

test('a corrupted database file is reported as damaged when opened', () => {
    const file = join(dir, 'corrupt.db')
    const w = new DatabaseSync(file); w.exec('CREATE TABLE t (x)'); w.close()
    // Overwrite the header: SQLite refuses the file.
    writeFileSync(file, Buffer.alloc(4096, 7))
    const e = (() => { try { new DatabaseSync(file).exec('SELECT * FROM t') } catch (e) { return e as Error } })()
    assert.ok(e)
    assert.equal(plainReason(e), "Lens's database file is damaged")
})
