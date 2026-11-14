import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-reliability-'))
Object.assign(process.env, {
    TASKS_DB: join(dir, 'tasks.db'), TRIAGE_DB: join(dir, 'triage.db'), CLIP_CACHE_DIR: join(dir, 'cache'),
    CLIP_CACHE_MAX_MB: '0.001', APP_EVENTS_FILE: 'config/app-events.reval.json',
    POSTHOG_HOST: 'https://posthog.test', POSTHOG_PERSONAL_API_KEY: 'test', POSTHOG_PROJECT_ID: '1',
})
const T = await import('../src/core/tasks.ts')
const C = await import('../src/core/clip.ts')
const X = await import('../src/core/experience.ts')
const P = await import('../src/core/posthog.ts')
const { db } = await import('../src/core/db.ts')
const { pruneJobs } = await import('../src/service/replays.ts')
const fetchOriginal = globalThis.fetch
const shift = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
after(() => { globalThis.fetch = fetchOriginal; T.tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('an unfinished past day stays uncovered and is backfilled; only closed scan windows finalize', async () => {
    const past = shift(-2)
    T.storeAttempts(past, [])
    assert.equal(T.coverage({ from: past, to: past }).complete, false)
    T.setTaskQuery(async () => [])
    try { await T.runIngest({ maxBackfill: 1 }) } finally { T.setTaskQuery() }
    assert.equal(T.coverage({ from: past, to: past }).complete, true)
    assert.equal(T.coverage({ from: shift(-1), to: shift(-1) }).complete, false)
    T.storeAttempts(past, [], { finalized: true, truncated: true })
    assert.equal(T.coverage({ from: past, to: past }).complete, false)
})

test('a startup database write failure releases the ingestion guard', async () => {
    T.tasksDb.exec(`CREATE TRIGGER fail_run BEFORE INSERT ON task_state WHEN NEW.key='last_run' BEGIN SELECT RAISE(ABORT, 'locked writer'); END`)
    await assert.rejects(T.runIngest({ days: [] }), /locked writer/)
    assert.equal(T.ingestStatus().running, false)
    T.tasksDb.exec('DROP TRIGGER fail_run')
    T.tasksDb.prepare('INSERT OR REPLACE INTO task_state VALUES (?,?)').run('last_error', 'previous error')
    T.tasksDb.exec(`CREATE TRIGGER fail_clear BEFORE DELETE ON task_state WHEN OLD.key='last_error' BEGIN SELECT RAISE(ABORT, 'locked delete'); END`)
    await assert.rejects(T.runIngest({ days: [] }), /locked delete/)
    assert.equal(T.ingestStatus().running, false)
    T.tasksDb.exec('DROP TRIGGER fail_clear')
    await T.runIngest({ days: [] })
    assert.ok(T.ingestStatus().last_run)
})

test('transient replay failures back off and recover; terminal ones remain skipped', async () => {
    const candidate = { session_id: 'retry-session', client: 'A', user: 'u', start: shift(-1) }
    const deps = { candidates: async () => [candidate], names: async () => [], durationMs: async () => 10_000 }
    await X.processReplays(1, { ...deps, jsonl: async () => { throw new P.PostHogError('unavailable', 503) } })
    assert.equal(T.tasksDb.prepare('SELECT 1 FROM replay_skips WHERE session_id=?').get(candidate.session_id), undefined)
    const retry = T.tasksDb.prepare('SELECT retry_after FROM replay_retries WHERE session_id=?').get(candidate.session_id)!
    assert.ok(Number(retry.retry_after) > Date.now())
    const hogql = async () => [{ ...candidate }]
    assert.equal((await X.candidates(30, 10, { hogql })).length, 0)
    T.tasksDb.prepare('UPDATE replay_retries SET retry_after=0').run()
    assert.equal((await X.candidates(30, 10, { hogql })).length, 1)
    const result = await X.processReplays(1, { ...deps, jsonl: async () => '["w",{"type":3,"timestamp":1000,"data":{"source":2,"type":2,"id":1}}]\n' })
    assert.equal(result.read, 1)
    assert.equal(T.tasksDb.prepare('SELECT 1 FROM replay_retries WHERE session_id=?').get(candidate.session_id), undefined)
    candidate.session_id = 'timeout-session'
    await X.processReplays(1, { ...deps, jsonl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) } })
    assert.ok(T.tasksDb.prepare('SELECT 1 FROM replay_retries WHERE session_id=?').get(candidate.session_id))
    assert.equal(T.tasksDb.prepare('SELECT 1 FROM replay_skips WHERE session_id=?').get(candidate.session_id), undefined)
    candidate.session_id = 'deleted-session'
    await X.processReplays(1, { ...deps, jsonl: async () => { throw new P.PostHogError('deleted', 404) } })
    assert.ok(T.tasksDb.prepare('SELECT 1 FROM replay_skips WHERE session_id=?').get(candidate.session_id))
})

function snapshotFetch(body: string, last = 0) {
    globalThis.fetch = async (url) => {
        const path = String(url)
        if (path.includes('blob_v2=true')) return Response.json({ sources: [{ source: 'blob_v2', blob_key: '0' }, { source: 'blob_v2', blob_key: String(last) }] })
        if (!path.includes('snapshots')) return Response.json({ end_time: '2026-01-01' })
        return new Response(body)
    }
}

test('cache protects requested snapshots and refuses oversized files explicitly', async () => {
    const cache = join(dir, 'prune'); mkdirSync(cache)
    const requested = join(cache, 'requested.jsonl'), other = join(cache, 'other.jsonl')
    writeFileSync(requested, 'x'.repeat(800)); writeFileSync(other, 'x'.repeat(800))
    C.pruneCache(cache, requested)
    assert.ok(existsSync(requested)); assert.equal(existsSync(other), false)
    snapshotFetch(JSON.stringify(['w', { data: 'x'.repeat(2000) }]))
    await assert.rejects(C.snapshotsFile('oversized'), (e: any) => e.status === 413)
    assert.deepEqual(readdirSync(join(dir, 'cache', 'snapshots')), [])
})

test('failed render cleanup and startup cleanup remove partial output', async () => {
    const work = join(dir, 'cache', 'render', 'broken')
    await assert.rejects(C.withRenderWork(work, async () => {
        mkdirSync(work, { recursive: true }); writeFileSync(join(work, 'video.mp4'), 'partial'); throw new Error('rasterization failed')
    }), /rasterization failed/)
    assert.equal(existsSync(work), false)
    mkdirSync(work, { recursive: true }); writeFileSync(join(work, 'frame.png'), 'abandoned')
    C.cleanRenderWork()
    assert.ok(existsSync(work), 'recent directories may belong to another process')
    const old = new Date(Date.now() - 2 * 86_400_000)
    utimesSync(work, old, old)
    C.cleanRenderWork()
    assert.equal(existsSync(work), false)
})

test('job retention expires completed entries and caps history without dropping active jobs', () => {
    const jobs = new Map<string, { finished_at?: number }>([['old', { finished_at: 1 }], ['recent', { finished_at: 3_600_001 }], ['active', {}]])
    pruneJobs(jobs, 3_600_002)
    assert.deepEqual([...jobs.keys()], ['recent', 'active'])
    pruneJobs(jobs, 3_600_002, 1)
    assert.deepEqual([...jobs.keys()], ['active'])
})

test('snapshot normalization streams split UTF-8 lines and bounds bytes and blob requests', async () => {
    const raw = '{"window_id":"w","data":[{"text":"é"}]}\n'
    globalThis.fetch = async (url) => {
        if (String(url).includes('blob_v2=true')) return Response.json({ sources: [{ source: 'blob_v2', blob_key: '0' }] })
        const bytes = Buffer.from(raw)
        return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } }))
    }
    assert.equal(await P.getSnapshotsJsonl('split'), '["w",{"text":"é"}]\n')
    const output = join(dir, 'normalized.jsonl')
    await P.getSnapshotsJsonl('split', output)
    assert.equal(readFileSync(output, 'utf8'), '["w",{"text":"é"}]\n')
    process.env.REPLAY_MAX_MB = '1'
    snapshotFetch(JSON.stringify(['w', { data: 'x'.repeat(1024 * 1024) }]))
    await assert.rejects(P.getSnapshotsJsonl('large'), (e: any) => e.status === 413)
    delete process.env.REPLAY_MAX_MB
    process.env.REPLAY_MAX_CHUNKS = '1'
    snapshotFetch(raw, 21)
    await assert.rejects(P.getSnapshotsJsonl('many'), (e: any) => e.status === 413)
    delete process.env.REPLAY_MAX_CHUNKS
})


test('signal extraction bounds embedded gzip expansion in its worker', async () => {
    process.env.REPLAY_MAX_MB = '1'
    try {
        const packed = gzipSync(JSON.stringify({ node: 'x'.repeat(2 * 1024 * 1024) })).toString('latin1')
        const jsonl = JSON.stringify(['w', { type: 2, timestamp: 1000, data: packed }])
        await assert.rejects(X.replaySignals({ jsonl }, 10_000, []), /Recording too large by decompression policy/)
    } finally { delete process.env.REPLAY_MAX_MB }
})


test('crossing midnight while scanning cannot finalize a partial scan', async (t) => {
    const day = '2026-03-01', window = { from: day, to: day }
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-02T23:59:59Z') })
    try {
        await T.ingestDay(day, async () => {
            t.mock.timers.setTime(Date.parse('2026-03-03T12:00:00Z'))
            return []
        })
        assert.equal(T.coverage(window).complete, false)
        await assert.rejects(T.ingestDay(day, async () => { throw new Error('PostHog unavailable') }), /unavailable/)
        assert.equal(T.coverage(window).complete, false)
        await T.ingestDay(day, async () => [])
        assert.equal(T.coverage(window).complete, true)
    } finally { t.mock.timers.reset() }
})

test('upgrading keeps history scanned after its window closed as final', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'lens-final-')), 't.db'))
    db.exec(`CREATE TABLE task_ingest(day TEXT PRIMARY KEY, sessions INTEGER NOT NULL, events INTEGER NOT NULL, attempts INTEGER NOT NULL,
        truncated INTEGER NOT NULL, seconds REAL NOT NULL, done_at TEXT NOT NULL)`)
    db.prepare('INSERT INTO task_ingest VALUES (?,0,0,0,?,0,?)').run('2026-10-01', 0, '2026-10-05T00:00:00Z')   // scanned late: final
    db.prepare('INSERT INTO task_ingest VALUES (?,0,0,0,?,0,?)').run('2026-10-02', 0, '2026-10-02T12:00:00Z')   // scanned the same day: not final
    db.prepare('INSERT INTO task_ingest VALUES (?,0,0,0,?,0,?)').run('2026-10-03', 1, '2026-10-09T00:00:00Z')   // truncated: not final
    db.exec(`ALTER TABLE task_ingest ADD COLUMN finalized INTEGER NOT NULL DEFAULT 0;
        UPDATE task_ingest SET finalized = 1 WHERE truncated = 0 AND done_at >= date(day, '+2 days');`)
    const rows = db.prepare('SELECT day, finalized FROM task_ingest ORDER BY day').all() as { day: string; finalized: number }[]
    assert.deepEqual(rows.map((r) => r.finalized), [1, 0, 0])
    const source = (await import('node:fs')).readFileSync('src/core/tasks.ts', 'utf8')
    assert.ok(source.includes("UPDATE task_ingest SET finalized = 1 WHERE truncated = 0 AND done_at >= date(day, '+2 days');"))
})
