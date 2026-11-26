// Phase 4: durable Monitor (discovery, quiet period, leases, caps, failures, retention), budget crash
// boundaries and the page's auth / CSRF / feature gate. PostHog is a fake; SQLite is a temp file.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const dir = mkdtempSync(join(tmpdir(), 'rv-monitor-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.FEATURE_REPLAY_VISION = 'on'
test.after(() => rmSync(dir, { recursive: true, force: true }))

const W = await import('../src/service/replayvision-worker.ts')
const B = await import('../src/core/replay-vision-budget.ts')
const { run, one, all } = await import('../src/core/db.ts')
const { PostHogError } = await import('../src/core/posthog.ts')
type Deps = import('../src/service/replayvision-worker.ts').VisionDeps
type Result = import('../src/core/replay-vision.ts').AnalysisResult

const T0 = Date.parse('2026-11-26T12:00:00Z')
const sid = (n: number) => `0000000${n}-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const okResult = (screen = 'sales invoice:new'): Result => ({
    coverage: { state: 'complete', reasons: [] }, screens: [screen], events: 50, metrics: [],
    candidates: [{ kind: 'D4', start_ms: 1000, end_ms: 9000, score: 4, screen, element: 'Save', step: 'Save', event_ids: ['1', '2'], facts: { cycles: 2, span_ms: 8000, lost_ms: 8000 }, limitations: [], strength: 'strong' }],
})
function fake(over: Partial<Deps> & { clock?: { t: number }; ends?: Map<string, string> } = {}): Deps & { clock: { t: number }; ends: Map<string, string>; analyzed: string[] } {
    const clock = over.clock ?? { t: T0 }, ends = over.ends ?? new Map<string, string>(), analyzed: string[] = []
    return {
        clock, ends, analyzed,
        now: () => clock.t,
        discover: async () => ({ rows: [], partial: false }),
        getRecording: async (id) => { const e = ends.get(id); if (!e) throw new PostHogError('not found', 404); return { start_time: new Date(Date.parse(e) - 60_000).toISOString(), end_time: e, distinct_id: 'u' } },
        appEvents: async () => [],
        withSnapshots: async (_id, use) => use('/dev/null'),
        analyze: async (_f, _m) => { analyzed.push(_m.start_time); return okResult() },
        fileSize: async () => 1000,
        reach: async () => new Map([['sales invoice:new', { users: 10, source: 'fake $pageview' }]]),
        windowsFor: async () => [],
        ...over,
    }
}
const reset = () => { for (const t of ['rv_run', 'rv_watch', 'rv_budget', 'rv_reservation', 'rv_provider_job', 'rv_cursor', 'rv_insight', 'rv_baseline']) run(`DELETE FROM ${t}`) }
const state = (id: number) => one<{ state: string; attempts: number; error_code: string | null }>('SELECT state, attempts, error_code FROM rv_run WHERE id = ?', id)!
const watch = (kind: string, value: string, cap = 200) => { run(`INSERT INTO rv_watch(kind, value, created_by, created_at, max_sessions_per_day) VALUES(?,?,?,?,?)`, kind, value, 'admin@x.test', new Date(T0).toISOString(), cap); return one<{ id: number }>('SELECT id FROM rv_watch WHERE value = ?', value)!.id }

test('discovery queues only watched, identified recordings, pages with a keyset, and never duplicates', async () => {
    reset()
    watch('client', 'C1')
    const rows = [1, 2, 3, 4, 5].map((n) => ({ session_id: sid(n), start: new Date(T0 - 3600_000).toISOString(), end: new Date(T0 - 1200_000 - n).toISOString(), client_id: n === 4 ? 'C2' : n === 5 ? null : 'C1', distinct_id: n === 5 ? null : `u${n}` }))
    const seen: unknown[] = []
    const d = fake({ discover: async (input) => { seen.push(input); const start = input.cursor ? 3 : 0; return { rows: rows.slice(start, start + 3), next: start ? undefined : { end: rows[2]!.end, session_id: rows[2]!.session_id }, partial: false } } })
    assert.equal(await W.discover(d), 3)
    assert.equal(seen.length, 2, 'second page via the keyset cursor')
    const q = seen[0] as { to: Date; from: Date }
    assert.equal(+q.to, T0 - W.MONITOR.quietMs, 'only recordings quiet for 10 min')
    assert.equal(await W.discover(d), 0, 'a second pass queues nothing new')
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_run')!.n, 3)
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_run_watch')!.n, 3)
    assert.equal(W.replayVisionJobState().unmatched_recordings >= 1, true)
    // No enabled watch: no PostHog call at all.
    run('UPDATE rv_watch SET enabled = 0')
    let called = false
    await W.discover(fake({ discover: async () => { called = true; return { rows: [], partial: false } } }))
    assert.equal(called, false)
})

test('quiet period: a discovered run waits one stable re-check, then analyses once; late blobs supersede', async () => {
    reset()
    const w = watch('client', 'C1')
    const d = fake()
    const end = new Date(T0 - 1200_000).toISOString()
    d.ends.set(sid(1), end)
    const id = W.queueReplayVision(sid(1), end, 'C1', 'u1', [w])
    assert.equal(await W.processRun(W.claimNext(d.now())!, d), 'stable_wait')
    assert.equal(W.claimNext(d.now()), undefined, 'not due before the re-check')
    d.clock.t += W.MONITOR.stableRecheckMs
    assert.equal(await W.processRun(W.claimNext(d.now())!, d), 'complete')
    assert.equal(d.analyzed.length, 1)
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_finding WHERE run_id = ?', id)!.n, 1)
    // Orchestrator decision 2: one strong D4 moment in one user publishes as a Low, single-session insight (one citation).
    assert.deepEqual(all<{ scope_key: string; severity: string; users_affected: number }>('SELECT scope_key, severity, users_affected FROM rv_insight ORDER BY scope_key').map((i) => [i.scope_key, i.severity, i.users_affected]), [['client:C1', 'Low', 1], ['user:u1', 'Low', 1]], 'one user: one Low insight per scope')
    // The recording grew after analysis: re-queue of the new end supersedes the old run and hides its findings.
    const later = new Date(T0 - 600_000).toISOString()
    d.ends.set(sid(1), later)
    const id2 = W.queueReplayVision(sid(1), later, 'C1', 'u1', [w])
    assert.notEqual(id2, id)
    assert.equal(state(id).state, 'superseded')
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_finding WHERE run_id = ?', id)!.n, 0)
    // A stale run whose end changed before analysis is superseded at processing time.
    const stale = W.queueReplayVision(sid(2), end, 'C1', 'u2', [w]); d.ends.set(sid(2), later)
    run(`UPDATE rv_run SET state = 'stable_wait', next_attempt_at = NULL WHERE id = ?`, stale)
    let r = W.claimNext(d.now())!
    while (r.id !== stale) { await W.processRun(r, d); r = W.claimNext(d.now())! }
    assert.equal(await W.processRun(r, d), 'superseded')
    assert.equal(one<{ n: number }>(`SELECT count(*) AS n FROM rv_run WHERE session_id = ? AND recording_end = ? AND state = 'pending'`, sid(2), later)!.n, 1)
})

test('lease expiry recovers a crashed run; three crashes or timeouts end failed_permanent; infrastructure errors do not count', async () => {
    reset()
    const d = fake()
    const end = new Date(T0 - 1200_000).toISOString()
    d.ends.set(sid(1), end)
    const id = W.queueReplayVision(sid(1), end, 'C1', 'u1', [], 'admin@x.test') // on-demand: no stable wait
    // Simulate three process crashes mid-analysis: claim, mark the attempt, never finish.
    for (let i = 0; i < 3; i++) {
        const r = W.claimNext(d.now())!
        assert.equal(r.id, id)
        run('UPDATE rv_run SET attempts = attempts + 1 WHERE id = ?', id)
        assert.equal(W.claimNext(d.now()), undefined, 'leased: nobody else takes it')
        d.clock.t += W.MONITOR.leaseMs + 1
    }
    assert.equal(W.claimNext(d.now()), undefined)
    assert.equal(state(id).state, 'failed_permanent')
    // Timeouts from the worker thread consume attempts the same way.
    const id2 = W.queueReplayVision(sid(2), end, 'C1', 'u1', [], 'admin@x.test'); d.ends.set(sid(2), end)
    const slow = fake({ clock: d.clock, ends: d.ends, analyze: async () => ({ coverage: { state: 'partial', reasons: ['timeout'] }, candidates: [], metrics: [], screens: [], events: 0 }) })
    for (let i = 0; i < 3; i++) { const r = W.claimNext(slow.now())!; assert.equal(r.id, id2); await W.processRun(r, slow); slow.clock.t += 3600_000 }
    assert.deepEqual([state(id2).state, state(id2).attempts], ['failed_permanent', 3])
    // PostHog 503 / recording API 500: retried later without using the session's attempts.
    const id3 = W.queueReplayVision(sid(3), end, 'C1', 'u1', [], 'admin@x.test'); d.ends.set(sid(3), end)
    const down = fake({ clock: d.clock, ends: d.ends, withSnapshots: async () => { throw new PostHogError('upstream', 503) } })
    for (let i = 0; i < 5; i++) { const r = W.claimNext(down.now())!; assert.equal(await W.processRun(r, down), 'retry'); down.clock.t += 11 * 60_000 }
    assert.deepEqual([state(id3).state, state(id3).attempts], ['retry', 0])
    // Snapshots not stored yet: pending retry; a deleted recording: unavailable.
    const pend = fake({ clock: d.clock, ends: d.ends, withSnapshots: async () => { throw new PostHogError('no stored snapshots yet', 404) } })
    assert.equal(await W.processRun(W.claimNext(pend.now())!, pend), 'retry')
    assert.equal(state(id3).attempts, 0)
    d.ends.delete(sid(3)); d.clock.t += 3600_000
    assert.equal(await W.processRun(W.claimNext(d.now())!, d), 'unavailable')
})

test('daily and per-watch caps write skipped_budget; force recomputes in place', async () => {
    reset()
    const w = watch('client', 'C1', 1)
    const d = fake()
    const ids = [1, 2].map((n) => { const e = new Date(T0 - 1200_000 - n).toISOString(); d.ends.set(sid(n), e); const id = W.queueReplayVision(sid(n), e, 'C1', `u${n}`, [w]); run(`UPDATE rv_run SET state = 'stable_wait' WHERE id = ?`, id); return id })
    const results = [await W.processRun(W.claimNext(d.now())!, d), await W.processRun(W.claimNext(d.now())!, d)]
    assert.deepEqual(results.sort(), ['complete', 'skipped_budget'])
    const skipped = ids.find((id) => state(id).state === 'skipped_budget')!
    assert.equal(state(skipped).error_code, `cap:watch:${w}`)
    assert.equal(B.budgetRow(B.dayOf(T0), 'global').used_sessions, 1)
    const done = ids.find((id) => id !== skipped)!
    assert.ok(W.forceRerun(done))
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_run WHERE session_id = (SELECT session_id FROM rv_run WHERE id = ?)', done)!.n, 1, 'force never duplicates the run')
})

test('three watched users with the same loop publish one ranked insight; deletion and retention remove derived data', async () => {
    reset()
    const w = watch('client', 'C1')
    const d = fake()
    for (const n of [1, 2, 3]) { const e = new Date(T0 - 1200_000 - n).toISOString(); d.ends.set(sid(n), e); const id = W.queueReplayVision(sid(n), e, 'C1', `u${n}`, [w]); run(`UPDATE rv_run SET state = 'stable_wait' WHERE id = ?`, id) }
    for (let i = 0; i < 3; i++) await W.processRun(W.claimNext(d.now())!, d)
    const ins = all<{ severity: string; users_affected: number; users_reached: number; reach_source: string; scope_key: string }>('SELECT severity, users_affected, users_reached, reach_source, scope_key FROM rv_insight')
    const client = ins.filter((i) => i.scope_key === 'client:C1')
    assert.deepEqual(client.map((i) => [i.scope_key, i.users_affected, i.users_reached, i.reach_source]), [['client:C1', 3, 10, 'fake $pageview']])
    assert.equal(client[0]!.severity, 'Medium', 'strong D4 in 3 users is High, capped Medium on a cold screen')
    // Each user's own scope holds one strong single moment: Low, one user (decision 2).
    assert.deepEqual(ins.filter((i) => i.scope_key.startsWith('user:')).map((i) => [i.scope_key, i.severity, i.users_affected]).sort(), [['user:u1', 'Low', 1], ['user:u2', 'Low', 1], ['user:u3', 'Low', 1]])
    W.deleteVisionSession(sid(1))
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_run WHERE session_id = ?', sid(1))!.n, 0)
    // Watch removal: runs no longer referenced are pruned; retention removes old data.
    run('DELETE FROM rv_watch WHERE id = ?', w)
    W.pruneVision(d.now())
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_run')!.n, 0)
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_insight')!.n, 0)
    const id = W.queueReplayVision(sid(9), new Date(T0).toISOString(), null, 'u9', [], 'admin@x.test')
    run(`UPDATE rv_run SET state = 'complete', completed_at = ? WHERE id = ?`, new Date(T0 - 40 * 86_400_000).toISOString(), id)
    W.pruneVision(T0)
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_run WHERE id = ?', id)!.n, 0)
})

test('provider budget survives a crash at every step: reserve → submit → end → reconcile, no leak and no double billing', () => {
    reset()
    const day = B.dayOf(T0)
    run(`INSERT INTO rv_run(project_id, session_id, recording_end, analysis_version, mode, state) VALUES('1','s-budget','e','v','text','complete')`)
    const runId = one<{ id: number }>("SELECT id FROM rv_run WHERE session_id = 's-budget'")!.id
    const g = () => B.budgetRow(day, 'global')
    // Crash right after reserve (intent persisted, outcome unknown): kept, never resubmitted, expires after 24 h.
    assert.ok(B.reserveProvider('job-intent-1', runId, 1000, 'anthropic', 'global', T0))
    assert.ok(B.reserveProvider('job-intent-1', runId, 1000, 'anthropic', 'global', T0), 'idempotent per custom id')
    assert.equal(g().reserved_llm_calls, 1)
    assert.deepEqual(B.startupReconcile(T0 + 1000), { released_orphans: 0, expired: 0, reconciled: 0, uncertain: 1 })
    assert.equal(B.startupReconcile(T0 + B.BUDGET.providerMaxAgeMs + 1).expired, 1)
    assert.deepEqual([g().reserved_llm_calls, g().reserved_cost_micros, g().used_llm_calls], [0, 0, 0])
    assert.equal(B.jobState('job-intent-1'), 'provider_expired')
    // Orphan reservation without a job row (crash inside an older version): released.
    run(`INSERT INTO rv_reservation(custom_id, run_id, day_utc, scope, cost_micros, state, created_at) VALUES('orphan-001', ?, ?, 'global', 500, 'reserved', ?)`, runId, day, new Date(T0).toISOString())
    run(`UPDATE rv_budget SET reserved_llm_calls = reserved_llm_calls + 1, reserved_cost_micros = reserved_cost_micros + 500 WHERE day_utc = ? AND scope = 'global'`, day)
    assert.equal(B.startupReconcile(T0).released_orphans, 1)
    assert.deepEqual([g().reserved_llm_calls, g().reserved_cost_micros], [0, 0])
    // Crash after the provider answered but before reconcile: the recorded usage reconciles exactly once.
    assert.ok(B.reserveProvider('job-ended-01', runId, 2000, 'anthropic', 'global', T0))
    B.markSubmitted('job-ended-01', 'msgbatch_x', T0)
    B.markEnded('job-ended-01', { input_tokens: 1200, output_tokens: 300, cost_micros: 270 })
    assert.equal(B.startupReconcile(T0).reconciled, 1)
    assert.equal(B.startupReconcile(T0).reconciled, 0)
    assert.equal(B.reconcileProvider('job-ended-01', 270, 1200, 300), false, 'second reconcile is a no-op')
    assert.deepEqual([g().used_llm_calls, g().estimated_cost_micros, g().used_input_tokens, g().reserved_llm_calls], [1, 270, 1200, 0])
    // Per-session ceiling: two calls per run (the expired one was released, the reconciled one counts).
    assert.ok(B.reserveProvider('job-second', runId, 1000, 'anthropic', 'global', T0))
    assert.equal(B.reserveProvider('job-third-x', runId, 1000, 'anthropic', 'global', T0), false)
    // A failed call still uses its slot at zero cost.
    B.markEnded('job-second', null, 'provider_http_500')
    B.startupReconcile(T0)
    assert.equal(g().used_llm_calls, 2)
    // Daily cost ceiling and invalid costs are refused.
    assert.equal(B.reserveProvider('job-too-dear', runId + 1, B.BUDGET.dailyCostMicros + 1, 'anthropic', 'global', T0), false)
    assert.equal(B.reserveProvider('job-zero-01', runId + 1, 0, 'anthropic', 'global', T0), false)
    assert.equal(B.reserveProvider('bad id!', runId + 1, 10, 'anthropic', 'global', T0), false)
})

test('daily call ceiling stops reservations at 100', () => {
    reset()
    for (let i = 0; i < 60; i++) run(`INSERT INTO rv_run(project_id, session_id, recording_end, analysis_version, mode, state) VALUES('1',?, 'e','v','text','complete')`, `cap-${i}`)
    const runs = all<{ id: number }>("SELECT id FROM rv_run WHERE session_id LIKE 'cap-%'")
    let ok = 0
    for (const r of runs) for (const k of [0, 1]) if (B.reserveProvider(`cap-${r.id}-${k}-xx`, r.id, 100, 'anthropic', 'global', T0)) ok++
    assert.equal(ok, B.BUDGET.dailyLlmCalls)
})

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as Readable & { method: string; url: string; headers: Record<string, string> }
    r.method = method; r.url = path; r.headers = { host: 'x', ...headers }
    return r
}
function res() {
    const out = { status: 0, body: '', headers: {} as Record<string, unknown> }
    return Object.assign(out, { writeHead(s: number, h?: Record<string, unknown>) { out.status = s; Object.assign(out.headers, h ?? {}); return this }, setHeader(k: string, v: unknown) { out.headers[k] = v }, end(b?: string) { out.body = b ?? '' } })
}

test('page API: sign-in, insight grant, admin-only writes, CSRF header, feature gate', async () => {
    reset()
    const { handleReplayVision } = await import('../src/service/replayvision.ts')
    const { handleReplays } = await import('../src/service/replays.ts')
    const admin = { email: 'admin@x.test', role: 'admin', insights: true } as never
    const grantee = { email: 'pm@x.test', role: 'watch', insights: true } as never
    const nobody = { email: 'v@x.test', role: 'watch', insights: false } as never
    const call = async (v: unknown, m: string, p: string, b?: unknown) => { const r = res(); await handleReplayVision(req(m, p, b) as never, r as never, new URL('http://x' + p), v as never); return r }
    assert.equal((await call(undefined, 'GET', '/replays/vision/api/status')).status, 401)
    assert.equal((await call(nobody, 'GET', '/replays/vision/api/status')).status, 403)
    const st = await call(grantee, 'GET', '/replays/vision/api/status')
    assert.equal(st.status, 200); assert.equal(st.headers['cache-control'], 'no-store')
    assert.ok(!/sk-ant|REPLAY_VISION_MASTER_KEY=/.test(st.body))
    assert.equal((await call(grantee, 'POST', '/replays/vision/api/watch', { kind: 'client', value: 'C9' })).status, 403)
    assert.equal((await call(admin, 'POST', '/replays/vision/api/watch', { kind: 'client', value: 'C9' })).status, 200)
    assert.equal((await call(admin, 'POST', '/replays/vision/api/watch', { kind: 'client', value: "C9' OR 1=1" })).status, 400)
    assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM rv_watch WHERE value = 'C9'")!.n, 1)
    const html = await call(grantee, 'GET', '/replays/vision')
    assert.match(html.body, /Ranked insights/); assert.ok(!html.body.includes('id="watch"'), 'no admin form for a grantee')
    // Central CSRF gate: a state-changing request without the page header never reaches the handler.
    const csrf = res(); await handleReplays(req('POST', '/replays/vision/api/watch', { kind: 'client', value: 'C8' }) as never, csrf as never, new URL('http://x/replays/vision/api/watch'))
    assert.equal(csrf.status, 403)
    assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM rv_watch WHERE value = 'C8'")!.n, 0)
    // Feature off: /replays/vision is not served by Replay Vision.
    process.env.FEATURE_REPLAY_VISION = 'off'
    const off = res(); await handleReplays(req('GET', '/replays/vision') as never, off as never, new URL('http://x/replays/vision'))
    assert.ok(!off.body.includes('Replay Vision ·'))
    assert.equal(W.replayVisionEnabled(), false)
    process.env.FEATURE_REPLAY_VISION = 'on'
})
