import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const exec = promisify(execFile)

// Keep uncaught timer errors and unhandled completion rejections in a child: either would kill
// the real MCP service. Two real SQLite connections reproduce contention without mocking SQLite.
for (const mode of ['completion', 'commit', 'maintenance', 'heartbeat', 'foreign-poll', 'cancellation', 'shutdown']) {
    test(`MCP jobs survive SQLite busy during ${mode}`, async () => {
        const dir = mkdtempSync(join(process.cwd(), '.job-busy-'))
        const source = `
            import assert from 'node:assert/strict'
            import { DatabaseSync } from 'node:sqlite'
            import { join } from 'node:path'
            import { mock } from 'node:test'
            import { JobRunner } from './src/core/jobs.ts'
            async function main() {
            const mode = ${JSON.stringify(mode)}
            const dir = ${JSON.stringify(dir)}
            if (mode === 'heartbeat') mock.timers.enable({ apis: ['setInterval'] })
            const db = new DatabaseSync(join(dir, 'jobs.db'))
            const runner = new JobRunner(db, { concurrency: 1, pruneMs: mode === 'maintenance' ? 10 : 60000 })
            // The service normally waits 5s before reporting SQLITE_BUSY. Shorten only that wait.
            db.exec('PRAGMA busy_timeout=1')
            const locker = new DatabaseSync(join(dir, 'jobs.db'))
            let foreign
            let deadline
            try {
                let complete
                let fail
                const job = runner.start('alice', 'slow', {}, 'revision', () => ({
                    promise: new Promise((resolve, reject) => { complete = resolve; fail = reject }),
                    cancel: () => fail(Error('cancelled worker')),
                    metadata: () => ({ clients: ['C01'], publicError: true }),
                }))
                await new Promise(resolve => setImmediate(resolve))
                let joined
                if (mode === 'foreign-poll') {
                    foreign = new JobRunner(db)
                    db.exec('PRAGMA busy_timeout=1')
                    joined = foreign.start('alice', 'slow', {}, 'revision', () => { throw Error('duplicate work') })
                    assert.equal(joined.id, job.id)
                }
                locker.exec(mode === 'foreign-poll' ? 'BEGIN EXCLUSIVE' : mode === 'commit'
                    ? 'BEGIN; SELECT * FROM analysis_jobs' : 'BEGIN IMMEDIATE')
                const value = { content: [{ type: 'text', text: 'one row: café' }] }
                if (mode === 'completion' || mode === 'commit') complete(value)
                if (mode === 'cancellation') runner.cancel('alice', job.id, 'revision')
                if (mode === 'heartbeat') { mock.timers.tick(15000); mock.timers.reset() }
                if (mode === 'shutdown') {
                    runner.close()
                    assert.equal((await job.done).isError, true)
                    locker.exec('ROLLBACK')
                    // Shutdown must cancel pending retries before the caller closes its database.
                    db.close()
                    await new Promise(resolve => setTimeout(resolve, 150))
                    return
                }
                const unlocked = new Promise(resolve => setTimeout(() => {
                    locker.exec('ROLLBACK')
                    if (!['completion', 'commit', 'cancellation'].includes(mode)) complete(value)
                    resolve()
                }, mode === 'foreign-poll' ? 250 : 50))
                await Promise.race([
                    Promise.all([unlocked, job.done, ...(joined ? [joined.done] : [])]),
                    new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('job hung after unlocking SQLite')), 3000) }),
                ])
                clearTimeout(deadline)
                const row = runner.get('alice', job.id, 'revision')
                if (mode === 'cancellation') {
                    assert.equal(row.status, 'cancelled', 'a late worker rejection cannot overwrite cancellation')
                    assert.equal((await job.done).isError, true)
                } else {
                    assert.equal(row.status, 'completed')
                    assert.deepEqual(runner.result(row), value)
                    assert.deepEqual(runner.context(row).clients, ['C01'])
                    assert.equal(runner.context(row).publicError, true)
                }
                if (joined) assert.deepEqual(await joined.done, value)
                const next = runner.start('alice', 'next', {}, 'revision', () => ({ promise: Promise.resolve(42) }))
                assert.equal(await next.done, 42, 'completion must release the concurrency slot')
            } finally {
                clearTimeout(deadline)
                if (locker.isTransaction) locker.exec('ROLLBACK')
                foreign?.close()
                if (db.isOpen) runner.close()
                locker.close()
                if (db.isOpen) db.close()
            }
            }
            await main()
        `
        try {
            const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 10000 })
                .then(() => ({ code: 0, stderr: '' }), error => ({ code: error.code, stderr: error.stderr }))
            assert.equal(result.code, 0, result.stderr)
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
}
