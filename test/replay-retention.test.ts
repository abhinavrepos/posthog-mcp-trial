import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, beforeEach, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-replay-retention-'))
Object.assign(process.env, {
    TRIAGE_ENV_FILE: join(dir, 'none.env'),
    TRIAGE_DB: join(dir, 'main.db'),
    TASKS_DB: join(dir, 'tasks.db'),
    CLIP_OUT_DIR: join(dir, 'clips'),
    CLIP_CACHE_DIR: join(dir, 'cache'),
    POSTHOG_HOST: 'http://posthog.test',
    POSTHOG_PROJECT_ID: '1',
    POSTHOG_PROJECT_TOKEN: 'phc_test',
    POSTHOG_PERSONAL_API_KEY: 'phx_read',
    LENS_REPLAY_RETENTION_API_KEY: 'phx_delete',
})
mkdirSync(join(dir, 'clips'))
const D = await import('../src/core/db.ts')
const R = await import('../src/service/replayretention.ts')
const { handleAdmin } = await import('../src/service/admin.ts')
const { storeClip, setSaved, getClip, jobView } = await import('../src/service/replays.ts')
const { pinGraph, listPinned } = await import('../src/core/pinned.ts')
const { readAudit } = await import('../src/service/access.ts')
after(() => { D.db.close(); rmSync(dir, { recursive: true, force: true }) })

// ------------------------------------------------------------------ a fake PostHog (no network)
interface Rec { id: string; start: string; deleted?: boolean }
const ph = {
    sessions: [] as Rec[],
    projectId: 1,
    period: '30d',
    patches: [] as string[],
    patchStatus: 200,
    hideDeleted: false,
    deletes: [] as string[],
    queries: [] as { kind: 'list' | 'count'; values: Record<string, unknown> }[],
    calls: 0,
    failDelete: undefined as undefined | ((id: string, attempt: number) => number | undefined),
    attempts: new Map<string, number>(),
}
const older = (values: Record<string, unknown>) => ph.sessions
    // PostHog keeps listing a deleted recording during its grace period: the watermark must move past it.
    .filter((s) => (!ph.hideDeleted || !s.deleted) && s.start < String(values.cutoff))
    .filter((s) => s.start > String(values.after_start) || (s.start === String(values.after_start) && s.id > String(values.after_id)))
    .sort((a, b) => (a.start === b.start ? (a.id < b.id ? -1 : 1) : a.start < b.start ? -1 : 1))
globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    ph.calls++
    const url = new URL(String(input)), method = init.method || 'GET'
    const auth = new Headers(init.headers).get('authorization')
    if (url.pathname === '/api/projects/1/query/' && method === 'POST') {
        assert.equal(auth, 'Bearer phx_read', 'queries use the read key')
        const { query } = JSON.parse(String(init.body))
        assert.match(query.query, /OR is_deleted = 1[\s\S]*HAVING max\(is_deleted\) = 0/)
        const values = query.values as Record<string, unknown>
        if (/count\(\)/.test(query.query)) {
            ph.queries.push({ kind: 'count', values })
            const rows = older(values)
            return Response.json({ columns: ['n', 'oldest'], results: [[rows.length, rows[0]?.start ?? null]] })
        }
        ph.queries.push({ kind: 'list', values })
        return Response.json({ columns: ['session_id', 'start_key'], results: older(values).slice(0, Number(values.limit)).map((s) => [s.id, s.start]) })
    }
    if (url.pathname === '/api/projects/1/' && (method === 'GET' || method === 'PATCH')) {
        assert.equal(auth, 'Bearer phx_delete', 'the project check uses the delete key')
        if (method === 'PATCH') {
            const { session_recording_retention_period } = JSON.parse(String(init.body))
            ph.patches.push(session_recording_retention_period)
            if (ph.patchStatus !== 200) return new Response('{}', { status: ph.patchStatus })
            ph.period = session_recording_retention_period
        }
        return Response.json({ id: ph.projectId, api_token: 'phc_test', session_recording_retention_period: ph.period })
    }
    const m = /^\/api\/projects\/1\/session_recordings\/([^/]+)\/$/.exec(url.pathname)
    if (m && method === 'DELETE') {
        assert.equal(auth, 'Bearer phx_delete')
        const id = decodeURIComponent(m[1])
        const attempt = (ph.attempts.get(id) ?? 0) + 1
        ph.attempts.set(id, attempt)
        const fail = ph.failDelete?.(id, attempt)
        if (fail) return new Response('{}', { status: fail })
        ph.deletes.push(id)
        const s = ph.sessions.find((x) => x.id === id)
        if (!s || s.deleted) return new Response('{}', { status: 404 })
        s.deleted = true
        return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
}

const NOW = new Date('2026-11-15T10:30:00Z')
const env = (extra: Record<string, string> = {}) => ({ LENS_REPLAY_RETENTION_API_KEY: 'phx_delete', ...extra })
const sleeps: number[] = []
const logs: { msg: string; extra?: Record<string, unknown> }[] = []
const deps = (extra: Record<string, string> = {}, now = NOW) => ({ env: env(extra), now: () => now, sleep: async (ms: number) => { sleeps.push(ms) }, log: (msg: string, extra?: Record<string, unknown>) => { logs.push({ msg, extra }) } })
const day = (iso: string) => iso.replace('T', ' ').replace('Z', '').padEnd(26, '0') // ClickHouse-style toString(DateTime64(6))
const sessions = (n: number, start = '2026-10-01T00:00:00.000Z') => Array.from({ length: n }, (_, i) => ({ id: `s${String(i).padStart(3, '0')}`, start: day(new Date(Date.parse(start) + i * 60_000).toISOString()) }))
const runs = () => readAudit({ action: 'replay_retention.run' })

beforeEach(() => {
    D.run("DELETE FROM settings WHERE key LIKE 'replay_retention%'")
    D.run('DELETE FROM audit')
    D.run('DELETE FROM clips')
    D.run('DELETE FROM pinned_graphs')
    Object.assign(ph, { sessions: [], projectId: 1, period: '30d', patches: [], patchStatus: 200, hideDeleted: false, deletes: [], queries: [], calls: 0, failDelete: undefined, attempts: new Map() })
    sleeps.length = 0; logs.length = 0
})
const setDays = (n: number | null) => D.setSetting(R.RETENTION_KEY, n)

// ------------------------------------------------------------------ cutoff math
test('the cutoff is UTC midnight today minus N days, whatever the time of day', () => {
    const at = (iso: string, days = 14) => R.cutoffFor(days, new Date(iso)).toISOString()
    assert.equal(at('2026-11-15T00:00:00.000Z'), '2026-11-01T00:00:00.000Z')
    assert.equal(at('2026-11-15T23:59:59.999Z'), '2026-11-01T00:00:00.000Z')
    assert.equal(at('2026-11-16T00:00:00.000Z'), '2026-11-02T00:00:00.000Z')
    // A local evening that is already tomorrow in UTC uses the UTC day.
    assert.equal(R.cutoffFor(14, new Date('2026-11-15T19:30:00-05:00')).toISOString(), '2026-11-02T00:00:00.000Z')
    assert.equal(at('2028-03-01T05:00:00Z', 7), '2028-02-23T00:00:00.000Z', 'leap year')
    assert.equal(at('2027-01-03T12:00:00Z', 7), '2026-12-27T00:00:00.000Z', 'year boundary')
    assert.equal(at('2026-11-15T12:00:00Z', 3650), '2016-11-17T00:00:00.000Z')
})

test('a recording that started exactly at the cutoff is kept; one a microsecond earlier is deleted', async () => {
    setDays(14)
    ph.sessions = [{ id: 'before', start: '2026-10-31 23:59:59.999999' }, { id: 'at', start: '2026-11-01 00:00:00.000000' }, { id: 'new', start: '2026-11-14 08:00:00.000000' }]
    const r = await R.runReplayRetention(deps())
    assert.deepEqual(ph.deletes, ['before'])
    assert.equal(r.cutoff, '2026-11-01T00:00:00.000Z')
    assert.equal(ph.queries[0]!.values.cutoff, '2026-11-01 00:00:00')
})

test('the setting is off by default and accepts only off or 7..3650 whole days', () => {
    assert.equal(R.retentionDays(), null)
    for (const ok of ['off', null, '', undefined]) assert.equal(R.parseRetentionDays(ok), null)
    assert.equal(R.parseRetentionDays(7), 7)
    assert.equal(R.parseRetentionDays('3650'), 3650)
    for (const bad of [6, 3651, 0, -14, 14.5, '14d', '1e2', 'on', true, {}]) assert.throws(() => R.parseRetentionDays(bad), /from 7 to 3650/, String(bad))
})

// ------------------------------------------------------------------ off, preview
test('off means no PostHog calls at all, and the scheduler does nothing', async () => {
    ph.sessions = sessions(5)
    const r = await R.runReplayRetention(deps())
    assert.equal(r.ran, false); assert.equal(r.reason, 'off')
    assert.equal(await R.createRetentionScheduler(deps())(), undefined)
    assert.equal(ph.calls, 0)
    assert.equal(runs().length, 0)
})

test('preview counts and dates what would go, and never deletes', async () => {
    setDays(null)
    ph.sessions = [...sessions(3, '2026-09-20T08:00:00Z'), ...sessions(2, '2026-11-10T08:00:00Z').map((s) => ({ ...s, id: 'n' + s.id }))]
    const p = await R.previewRetention(14, deps())
    assert.equal(p.count, 3)
    assert.equal(p.cutoff, '2026-11-01T00:00:00.000Z')
    assert.equal(p.oldest, '2026-09-20T08:00:00.000Z')
    assert.equal(ph.deletes.length, 0)
    assert.ok(ph.queries.every((q) => q.kind === 'count'))
    assert.equal(R.retentionDays(), null, 'a preview does not save anything')
})

// ------------------------------------------------------------------ runs
test('deletes in small batches up to the per-run cap, and the next run carries on', async () => {
    setDays(14)
    ph.sessions = sessions(25)
    const r = await R.runReplayRetention(deps({ LENS_REPLAY_RETENTION_BATCH: '10', LENS_REPLAY_RETENTION_MAX_PER_RUN: '22' }))
    assert.equal(r.deleted, 22); assert.equal(r.capped, true); assert.equal(r.error, undefined)
    assert.deepEqual(ph.queries.filter((q) => q.kind === 'list').map((q) => q.values.limit), [10, 10, 2])
    assert.equal(ph.deletes.length, 22)
    const next = await R.runReplayRetention(deps({ LENS_REPLAY_RETENTION_BATCH: '10', LENS_REPLAY_RETENTION_MAX_PER_RUN: '22' }))
    assert.equal(next.deleted, 3); assert.equal(next.capped, false)
    assert.deepEqual(ph.deletes, sessions(25).map((s) => s.id), 'each recording once, oldest first')
})

test('the per-run cap defaults to 2000', async () => {
    assert.equal(R.retentionEnv({}).maxPerRun, 2000)
    assert.equal(R.retentionEnv({ LENS_REPLAY_RETENTION_MAX_PER_RUN: 'lots' }).maxPerRun, 2000)
    assert.equal(R.retentionEnv({ LENS_REPLAY_RETENTION_MAX_PER_RUN: '50' }).maxPerRun, 50)
})

test('a rerun is idempotent: nothing is deleted twice, even though PostHog still lists deleted recordings', async () => {
    setDays(14)
    ph.sessions = sessions(5)
    assert.equal((await R.runReplayRetention(deps())).deleted, 5)
    const again = await R.runReplayRetention(deps())
    assert.equal(again.deleted, 0); assert.equal(again.failed, 0)
    assert.equal(ph.deletes.length, 5)
    // Without the watermark (a fresh database), PostHog answers 404 for what is gone: counted, not an error.
    D.run("DELETE FROM settings WHERE key = 'replay_retention_watermark'")
    const fresh = await R.runReplayRetention(deps())
    assert.equal(fresh.already_gone, 5); assert.equal(fresh.error, undefined)
})

test('an error stops the run, is audited, and the rerun resumes at the failed recording', async () => {
    setDays(14)
    ph.sessions = sessions(5)
    ph.failDelete = (id) => (id === 's002' ? 403 : undefined)
    const r = await R.runReplayRetention(deps())
    assert.equal(r.deleted, 2); assert.equal(r.failed, 1); assert.match(r.error!, /403/)
    assert.deepEqual(ph.deletes, ['s000', 's001'])
    assert.equal(ph.attempts.get('s002'), 1, 'a 403 is not retried')
    const row = runs()[0]!
    assert.equal(row.who, 'system'); assert.equal(row.deleted, 2); assert.equal(row.failed, 1); assert.equal(row.cutoff, '2026-11-01T00:00:00.000Z'); assert.match(String(row.error), /403/)
    assert.doesNotMatch(JSON.stringify(runs()) + JSON.stringify(logs), /s00\d/, 'audit and logs hold counts, not session ids')
    ph.failDelete = undefined
    const rerun = await R.runReplayRetention(deps())
    assert.equal(rerun.deleted, 3)
    assert.deepEqual(ph.deletes, ['s000', 's001', 's002', 's003', 's004'])
})

test('PostHog overload is retried with backoff, then stops the run', async () => {
    setDays(14)
    ph.sessions = sessions(3)
    ph.failDelete = (id, attempt) => (id === 's000' && attempt === 1 ? 503 : id === 's001' ? 500 : undefined)
    const r = await R.runReplayRetention(deps())
    assert.equal(r.deleted, 1); assert.equal(r.failed, 1); assert.match(r.error!, /500/)
    assert.equal(ph.attempts.get('s001'), 3)
    assert.deepEqual(sleeps, [2000, 2000, 4000])
    assert.equal(ph.attempts.get('s002'), undefined, 'nothing after the failure')
})

test('never deletes when the project cannot be confirmed or the delete key is missing', async () => {
    setDays(14)
    ph.sessions = sessions(3)
    ph.projectId = 2
    const wrong = await R.runReplayRetention(deps())
    assert.equal(wrong.ran, false); assert.match(wrong.error!, /different project/)
    const nokey = await R.runReplayRetention({ ...deps(), env: {} })
    assert.match(nokey.error!, /LENS_REPLAY_RETENTION_API_KEY/)
    assert.equal(ph.deletes.length, 0)
    assert.equal(ph.queries.length, 0, 'not even listed')
    assert.equal(runs().length, 2, 'both refusals are audited')
})

test('dry run logs what would be deleted and deletes nothing, in PostHog or Lens', async () => {
    setDays(14)
    ph.sessions = sessions(4)
    const clip = storeTestClip('old-dry', '2026-10-01T00:00:00Z')
    const r = await R.runReplayRetention(deps({ LENS_REPLAY_RETENTION_DRY_RUN: '1' }))
    assert.equal(r.dry_run, true); assert.equal(r.would_delete, 4); assert.equal(r.clips_would_delete, 1); assert.equal(r.deleted, 0)
    assert.equal(ph.deletes.length, 0)
    assert.ok(getClip(clip))
    assert.equal(logs.at(-1)!.msg, 'replay retention dry run')
    assert.equal(runs()[0]!.would_delete, 4)
    // The watermark did not move: a real run afterwards deletes all of them.
    assert.equal((await R.runReplayRetention(deps())).deleted, 4)
})

// ------------------------------------------------------------------ clips
let clipNo = 0
function storeTestClip(session: string, recordingStart: string | undefined): string {
    const name = `${session}-${++clipNo}_0-10.mp4`
    writeFileSync(join(dir, 'clips', name), 'x')
    storeClip({ name, session_id: session, start_offset_s: 0, end_offset_s: 10 }, recordingStart ? { start: recordingStart } : undefined, 'maker@example.com')
    return name
}
test('the clip cache follows the cutoff; saved clips are kept until unsaved', async () => {
    setDays(14)
    const pinned = pinGraph({ title: 'Saved', chart: { type: 'table', rows: [{ Value: 42 }] } }, 'keeper@example.com')
    const oldUnsaved = storeTestClip('old', '2026-10-20T10:00:00Z')
    const oldSaved = storeTestClip('old2', '2026-10-20T11:00:00Z')
    setSaved(oldSaved, 'keeper@example.com', true)
    const recent = storeTestClip('recent', '2026-11-10T10:00:00Z')
    const unknownStart = storeTestClip('unknown', undefined) // made today: its recording may be recent, so kept
    const p = await R.previewRetention(14, deps())
    assert.deepEqual(p.clips, { delete: 1, kept_saved: 1 })
    assert.ok(getClip(oldUnsaved), 'preview deletes no clip')
    const r = await R.runReplayRetention(deps())
    assert.equal(r.clips_deleted, 1); assert.equal(r.clips_kept_saved, 1)
    assert.equal(getClip(oldUnsaved), undefined); assert.equal(existsSync(join(dir, 'clips', oldUnsaved)), false)
    assert.equal(listPinned()[0]?.id, pinned.id)
    assert.ok(getClip(oldSaved)); assert.ok(getClip(recent)); assert.ok(getClip(unknownStart))
    // Once unsaved, the next run removes it.
    setSaved(oldSaved, 'keeper@example.com', false)
    assert.equal((await R.runReplayRetention(deps())).clips_deleted, 1)
    assert.equal(getClip(oldSaved), undefined)
})

test('clips are left alone when the run stopped on an error', async () => {
    setDays(14)
    ph.sessions = sessions(1)
    ph.failDelete = () => 403
    const clip = storeTestClip('old', '2026-10-20T10:00:00Z')
    const r = await R.runReplayRetention(deps())
    assert.ok(r.error); assert.equal(r.clips_deleted, 0); assert.ok(getClip(clip))
})

// ------------------------------------------------------------------ schedule
test('the daily job runs once per UTC day and backs off after a failure', async () => {
    setDays(14)
    ph.sessions = sessions(2)
    ph.failDelete = () => 403
    const at = (iso: string) => R.createRetentionScheduler(deps({}, new Date(iso)))()
    assert.ok((await at('2026-11-15T01:00:00Z'))?.error)
    assert.equal(await at('2026-11-15T01:30:00Z'), undefined, 'waits an hour after the first failure')
    assert.ok((await at('2026-11-15T02:01:00Z'))?.error)
    assert.equal(await at('2026-11-15T03:30:00Z'), undefined, 'then two hours')
    ph.failDelete = undefined
    assert.equal((await at('2026-11-15T04:02:00Z'))?.deleted, 2)
    assert.equal(await at('2026-11-15T23:00:00Z'), undefined, 'once a day')
    assert.equal((await at('2026-11-16T00:05:00Z'))?.ran, true, 'and again the next UTC day')
    assert.equal(R.retentionState().failures, 0)
})

// ------------------------------------------------------------------ admin HTTP
class Res {
    status = 0; text = ''; headers: Record<string, string> = {}
    writeHead(s: number, h: Record<string, string> = {}) { this.status = s; this.headers = h; return this }
    end(t = '') { this.text = String(t) }
    get body() { return JSON.parse(this.text) }
}
const admin = { email: 'admin@example.com', name: 'A', role: 'admin', posthog_admin: false, in_replay_project: true, session: 's' } as const
const viewer = { ...admin, email: 'watcher@example.com', role: 'watch' } as const
async function call(v: typeof admin | typeof viewer, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-clip-page': '1' }) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, headers, url: path })
    const res = new Res()
    await handleAdmin(req as never, res as never, new URL('http://lens' + path), v as never)
    return res
}

test('non-admins cannot read or change the setting or the preview (403)', async () => {
    ph.sessions = sessions(3)
    assert.equal((await call(viewer, 'GET', '/replays/admin/api/replay-retention')).status, 403)
    assert.equal((await call(viewer, 'GET', '/replays/admin/api/replay-retention/preview?days=14')).status, 403)
    assert.equal((await call(viewer, 'POST', '/replays/admin/api/replay-retention', { days: 14, confirm: true })).status, 403)
    assert.equal(R.retentionDays(), null)
    assert.equal(ph.calls, 0)
})

test('admins preview, must confirm a destructive change, and the change is audited with who, old and new', async () => {
    ph.sessions = sessions(3)
    const preview = await call(admin, 'GET', '/replays/admin/api/replay-retention/preview?days=14')
    assert.equal(preview.status, 200); assert.equal(preview.body.count, 3); assert.equal(preview.body.oldest, '2026-10-01T00:00:00.000Z')
    assert.equal((await call(admin, 'GET', '/replays/admin/api/replay-retention/preview?days=5')).status, 400)
    const unconfirmed = await call(admin, 'POST', '/replays/admin/api/replay-retention', { days: 14 })
    assert.equal(unconfirmed.status, 409); assert.equal(unconfirmed.body.preview.count, 3)
    assert.equal(R.retentionDays(), null)
    assert.equal((await call(admin, 'POST', '/replays/admin/api/replay-retention', { days: 14, confirm: true }, {})).status, 403, 'needs the page header')
    const ok = await call(admin, 'POST', '/replays/admin/api/replay-retention', { days: 14, confirm: preview.body.confirmation })
    assert.equal(ok.status, 200); assert.equal(ok.body.days, 14)
    assert.equal(ph.deletes.length, 0, 'saving deletes nothing by itself; the daily job does')
    const set = readAudit({ action: 'replay_retention.set' })[0]!
    assert.equal(set.who, 'admin@example.com'); assert.equal(set.before, 'off'); assert.equal(set.after, 14); assert.equal(set.would_delete, 3)
    // Raising it with nothing to delete needs no confirmation; turning it off neither.
    ph.sessions = []
    assert.equal((await call(admin, 'POST', '/replays/admin/api/replay-retention', { days: 30 })).status, 200)
    assert.equal((await call(admin, 'POST', '/replays/admin/api/replay-retention', { days: 'off' })).status, 200)
    assert.deepEqual(readAudit({ action: 'replay_retention.set' }).map((r) => [r.before, r.after]), [[30, 'off'], [14, 30], ['off', 14]])
    assert.equal((await call(admin, 'POST', '/replays/admin/api/replay-retention', { days: 6 })).status, 400)
    const state = await call(admin, 'GET', '/replays/admin/api/replay-retention')
    assert.equal(state.body.days, null); assert.equal(state.body.max_per_run, 2000)
})

test('enabling is blocked when PostHog cannot count', async () => {
    const saved = globalThis.fetch
    globalThis.fetch = async () => new Response('{}', { status: 400 })
    try {
        const r = await call(admin, 'POST', '/replays/admin/api/replay-retention', { days: 14, confirm: true })
        assert.equal(r.status, 409); assert.equal(r.body.preview.count, null)
    } finally { globalThis.fetch = saved }
    assert.equal(R.retentionDays(), null)
})

test('the admin page shows the retention card, says deletion is permanent, and its script parses', async () => {
    const { Script } = await import('node:vm')
    const page = await call(admin, 'GET', '/replays/admin')
    assert.equal(page.status, 200)
    for (const text of ['Session replay retention', 'does not bring deleted recordings back', 'ret-confirm', 'Analytics events outside replay are kept', 'Replay files stay on disk after deletion', 'Cancel decrease', 'Saved Lens clips and pinned graphs are kept']) assert.ok(page.text.includes(text), text)
    for (const s of page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(s[1]!))
})

for (const next of [null, 30]) test(`a live setting change to ${next ?? 'off'} stops deletions and clip cleanup without an error`, async () => {
    setDays(14)
    ph.sessions = sessions(3)
    const clip = storeTestClip('live-change', '2026-10-01T00:00:00Z')
    ph.failDelete = () => { setDays(next); return undefined }
    const r = await R.runReplayRetention(deps())
    assert.equal(r.deleted, 1)
    assert.equal(r.error, undefined); assert.equal(r.failed, 0)
    assert.match(r.reason!, next === null ? /disabled/ : /increased/)
    assert.equal(r.clips_deleted, 0); assert.ok(getClip(clip))
    assert.equal(runs()[0]!.reason, r.reason)
})

test('a setting change during retry backoff stops the next delete attempt', async () => {
    setDays(14); ph.sessions = sessions(1); ph.failDelete = () => 503
    const r = await R.runReplayRetention({ ...deps(), sleep: async () => { setDays(null) } })
    assert.equal(ph.attempts.get('s000'), 1)
    assert.equal(r.error, undefined); assert.equal(r.failed, 0); assert.match(r.reason!, /disabled/)
})

test('a setting change after an empty listing prevents clip cleanup', async () => {
    setDays(14)
    const clip = storeTestClip('empty-change', '2026-10-01T00:00:00Z')
    const r = await R.runReplayRetention({ ...deps(), query: async () => { setDays(30); return [] } })
    assert.match(r.reason!, /increased/); assert.equal(r.error, undefined); assert.ok(getClip(clip))
})

test('weekly bounded rescans catch late arrivals behind the persistent watermark', async () => {
    setDays(14); ph.sessions = sessions(2)
    await R.runReplayRetention(deps())
    ph.sessions.push({ id: 'late', start: '2026-09-01 00:00:00.000000' })
    assert.equal((await R.runReplayRetention(deps({}, new Date('2026-11-21T10:30:00Z')))).deleted, 0)
    const r = await R.runReplayRetention(deps({ LENS_REPLAY_RETENTION_MAX_PER_RUN: '1' }, new Date('2026-11-22T10:30:00Z')))
    assert.equal(r.deleted, 1); assert.equal(r.capped, true); assert.equal(ph.deletes.at(-1), 'late')
    const resumed = await R.runReplayRetention(deps({}, new Date('2026-11-22T10:30:00Z')))
    assert.equal(resumed.already_gone, 2); assert.equal(resumed.error, undefined)
    assert.equal(ph.queries.at(-1)!.values.after_id, 'late')
})


test('recording deletion removes raw snapshots, partial downloads and render work, preserving other sessions', async () => {
    setDays(14)
    ph.sessions = [{ id: 'cache-old', start: day('2026-10-01T00:00:00Z') }]
    for (const sub of ['snapshots', 'render']) {
        const folder = join(dir, 'cache', sub); mkdirSync(folder, { recursive: true })
        for (const name of ['cache-old_123.jsonl', 'cache-old_456.jsonl.tmp', 'cache-old_0-30', 'cache-other_123.jsonl']) writeFileSync(join(folder, name), 'synthetic')
    }
    await R.runReplayRetention(deps({ LENS_REPLAY_RETENTION_DRY_RUN: '1' }))
    assert.ok(existsSync(join(dir, 'cache', 'snapshots', 'cache-old_123.jsonl')))
    await R.runReplayRetention(deps())
    for (const sub of ['snapshots', 'render']) {
        for (const name of ['cache-old_123.jsonl', 'cache-old_456.jsonl.tmp', 'cache-old_0-30']) assert.equal(existsSync(join(dir, 'cache', sub, name)), false)
        assert.ok(existsSync(join(dir, 'cache', sub, 'cache-other_123.jsonl')))
    }
})


test('regenerating a clip replaces old range metadata used by the page and comments', () => {
    const clip = { name: 'metadata_0-120.mp4', session_id: 'metadata', start_offset_s: 0, end_offset_s: 120 }
    storeClip(clip, {}, 'person')
    storeClip({ ...clip, end_offset_s: 60.003 }, {}, 'person')
    const record = getClip(clip.name)!
    assert.equal(record.end_s, 60.003)
    assert.match(jobView({ id: 'metadata', state: 'done', owner: 'person', session_id: 'metadata', start_s: 0, length_s: 120, info: {} as never, created_at: Date.now(), clip: record }).clip!.range, /60.003 s/)
})

const path = '/replays/admin/api/replay-retention'

test('a confirmed first enable tracks a years-old backlog across capped daily runs', async () => {
    ph.hideDeleted = true
    ph.sessions = [...sessions(5, '2022-01-01T00:00:00Z'), { id: 'already-deleted', start: '2021-01-01 00:00:00.000000', deleted: true }]
    const p = await call(admin, 'GET', path + '/preview?days=30')
    assert.equal(p.body.count, 5)
    const saved = await call(admin, 'POST', path, { days: 30, confirm: p.body.confirmation })
    assert.equal(saved.body.remaining, 5)
    for (const [date, deleted, remaining] of [['15', 2, 3], ['16', 4, 1], ['17', 5, 0]] as const) {
        const now = new Date('2026-11-' + date + 'T10:30:00Z')
        const tick = R.createRetentionScheduler(deps({ LENS_REPLAY_RETENTION_MAX_PER_RUN: '2' }, now))
        assert.ok(await tick())
        assert.equal(await tick(), undefined)
        const status = R.retentionStatus(now)
        assert.equal(status.deleted_total, deleted)
        assert.equal(status.remaining, remaining)
        assert.equal(status.last_run?.at, now.toISOString())
        assert.ok(Date.parse(status.next_run!) > now.getTime())
        const job = R.retentionJobState(now)
        assert.equal(job.level, 'ok')
        assert.match(job.detail!, new RegExp(remaining + ' remaining'))
    }
})

test('decreasing from 365 to 30 requires the current count, and Admin can cancel the 24-hour hold', async () => {
    setDays(365)
    const start = new Date(Date.now() - 120 * 86_400_000)
    ph.sessions = sessions(2, start.toISOString())
    const shown = (await call(admin, 'GET', path + '/preview?days=30')).body
    assert.equal(shown.count, 2)
    ph.sessions.push({ id: 'another', start: day(start.toISOString()) })
    const stale = await call(admin, 'POST', path, { days: 30, confirm: shown.confirmation })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.preview.count, 3)
    assert.equal(R.retentionDays(), 365)
    const saved = await call(admin, 'POST', path, { days: 30, confirm: stale.body.preview.confirmation })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.hold.previous, 365)
    const during = new Date(Date.parse(saved.body.hold.until) - 1)
    assert.equal(await R.createRetentionScheduler(deps({}, during))(), undefined)
    assert.equal(ph.deletes.length, 0)
    assert.equal(R.retentionJobState(during).level, 'waiting')
    assert.match(R.retentionJobState(during).detail!, /Decrease on hold/)
    const cancelled = await call(admin, 'POST', path + '/cancel', {})
    assert.equal(cancelled.body.days, 365)
    assert.equal(cancelled.body.hold, null)
    assert.equal((await R.createRetentionScheduler(deps({}, during))())?.deleted, 0)
})

test('at the end of the hold, the smaller policy deletes recordings the old policy kept', async () => {
    setDays(365)
    ph.sessions = sessions(2)
    R.setRetentionDays(30, admin.email, await R.previewRetention(30, deps()), NOW)
    assert.equal((await R.runReplayRetention(deps())).reason, 'decrease on hold')
    const nextDay = new Date(NOW.getTime() + 86_400_000)
    assert.equal(R.cancelRetentionDecrease(admin.email, nextDay), false)
    assert.equal((await R.createRetentionScheduler(deps({}, nextDay))())?.deleted, 2)
})

test('raising Lens retention warns about earlier expiry and offers the smallest PostHog bucket', async () => {
    setDays(30)
    ph.sessions = sessions(1)
    await R.runReplayRetention(deps())
    const preview = (await call(admin, 'GET', path + '/preview?days=365')).body
    assert.equal(preview.requires_confirm, false)
    assert.match(preview.posthog.warning, /expire before the 365 days/)
    assert.equal(preview.posthog.offer, '1y')
    assert.equal((await call(admin, 'POST', path, { days: 365 })).status, 200)
    assert.equal(ph.sessions[0]?.deleted, true)
    assert.deepEqual(ph.patches, [], 'Lens changes do not patch PostHog')
    const read = await call(admin, 'GET', path)
    assert.equal(read.body.posthog.offer, '1y')
    assert.equal((await call(admin, 'POST', path + '/posthog', { days: 365, period: '90d' })).status, 422)
    ph.patchStatus = 403
    assert.match((await call(admin, 'POST', path + '/posthog', { days: 365, period: '1y' })).body.error, /HTTP 403/)
    assert.equal(ph.period, '30d')
    ph.patchStatus = 200
    assert.deepEqual((await call(admin, 'POST', path + '/posthog', { days: 365, period: '1y' })).body.posthog, { period: '1y' })
    assert.deepEqual(ph.patches, ['1y', '1y'])
    ph.period = '5y'
    const longer = (await call(admin, 'GET', path + '/preview?days=3650')).body
    assert.match(longer.posthog.warning, /at most 1,825 days/)
    assert.equal(longer.posthog.offer, undefined)
    await call(admin, 'POST', path + '/posthog', { days: 365, period: '1y' })
    assert.deepEqual(ph.patches, ['1y', '1y'], 'never lower the PostHog setting')
})

test('turning off clears the schedule and leaves the deletion history visible', async () => {
    setDays(30)
    ph.sessions = sessions(1)
    await R.createRetentionScheduler(deps())()
    const off = (await call(admin, 'POST', path, { days: 'off' })).body
    assert.equal(off.days, null)
    assert.equal(off.next_run, null)
    assert.equal(off.deleted_total, 1)
    assert.equal(ph.sessions[0]?.deleted, true)
    assert.match(R.retentionJobState(NOW).detail!, /No run scheduled/)
})

test('a failed DELETE is persisted as a job warning and subsequent success preserves the last error', async () => {
    setDays(30)
    ph.sessions = sessions(1)
    ph.failDelete = () => 403
    await R.createRetentionScheduler(deps())()
    const failed = R.retentionStatus(NOW)
    assert.equal(failed.last_error?.message, 'PostHog answered 403')
    assert.equal(failed.next_run, '2026-11-15T11:30:00.000Z')
    assert.equal(R.retentionJobState(NOW).level, 'warn')
    assert.match(R.retentionJobState(NOW).detail!, /PostHog answered 403/)
    ph.failDelete = undefined
    const later = new Date(failed.next_run!)
    await R.createRetentionScheduler(deps({}, later))()
    assert.equal(R.retentionJobState(later).level, 'ok')
    assert.deepEqual(R.retentionStatus(later).last_error, failed.last_error)
})

test('a backlog still advances after a week without restarting from the oldest batch', async () => {
    setDays(30)
    ph.sessions = sessions(10)
    for (let i = 0; i < 10; i++) {
        const now = new Date(NOW.getTime() + i * 86_400_000)
        const r = await R.createRetentionScheduler(deps({ LENS_REPLAY_RETENTION_MAX_PER_RUN: '1' }, now))()
        assert.equal(r?.deleted, 1)
    }
    assert.deepEqual(ph.deletes, sessions(10).map((s) => s.id))
})

test('a decrease saved during a run stops further recording and clip deletions', async () => {
    setDays(30)
    ph.sessions = sessions(2)
    const clip = storeTestClip('in-flight', '2026-10-01T00:00:00Z')
    ph.failDelete = () => { R.setRetentionDays(7, admin.email, undefined, NOW); return undefined }
    const r = await R.createRetentionScheduler(deps())()
    assert.equal(r?.deleted, 1)
    assert.equal(r?.clips_deleted, 0)
    assert.match(r?.reason ?? '', /policy changed/)
    assert.ok(getClip(clip))
    assert.equal(R.retentionStatus(NOW).hold?.previous, 30)
    assert.equal(await R.createRetentionScheduler(deps())(), undefined)
})
