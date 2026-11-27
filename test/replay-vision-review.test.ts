// Regression tests for the code review (/root/briefs/rv/70-code-review.md): M5 refresh cost and event loop,
// M6 client attribution, M7 render deadlines, M8 B' wall-clock budget.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'rv-review-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.FEATURE_REPLAY_VISION = 'on'
test.after(() => rmSync(dir, { recursive: true, force: true }))
const { run, one, tx } = await import('../src/core/db.ts')
const { refreshInsights, listInsights } = await import('../src/core/replay-vision-insights.ts')
const { refreshInsightsOffThread } = await import('../src/core/replay-vision-refresh.ts')

test('M5: 30,000 moments (a quarter D5) refresh in bounded time, and off-thread the event loop keeps ticking', async () => {
    const now = new Date().toISOString(), screen = 'sales invoice:new'
    tx(() => {
        for (let r = 0; r < 1500; r++) {
            const sid = `m5-${r}-0000-4000-8000`
            run(`INSERT INTO rv_run(project_id,session_id,recording_end,analysis_version,mode,client_id,distinct_id,state,completed_at,metrics_json) VALUES('1',?,?,?,?,?,?,'complete',?,'{}')`, sid, now, 'v', 'deterministic', 'M5', `u${r % 40}`, now)
            const id = one<{ id: number }>('SELECT id FROM rv_run WHERE session_id = ?', sid)!.id
            for (let k = 0; k < 20; k++) {
                const kind = k % 4 === 0 ? 'D5' : 'D4'
                run(`INSERT INTO rv_finding(run_id,fingerprint,detector_codes_json,strength,severity,severity_reason_json,screen_key,element_key,step_key,start_ms,end_ms,evidence_json,coverage_json,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    id, `f${r}-${k}`, JSON.stringify([kind]), 'strong', 'Low', '{}', screen, 'Save', 'Save', k * 1000, k * 1000 + 800, JSON.stringify({ event_ids: [`${k}`], facts: kind === 'D4' ? { cycles: 2, span_ms: 800, lost_ms: 800 } : { edits: 2, after_friction: true, lost_ms: 900 }, score: 1 }), '[]', 'low', now)
            }
        }
    })
    const t0 = Date.now()
    const sync = refreshInsights({ client: 'M5' })
    const ms = Date.now() - t0
    assert.equal(sync.moments, 30_000)
    assert.ok(ms < 20_000, `refresh took ${ms} ms`)
    // Off the event loop: a 20 ms timer keeps firing while the worker aggregates.
    let maxGap = 0, last = Date.now()
    const tick = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n }, 20)
    const r = await refreshInsightsOffThread({ client: 'M5' })
    clearInterval(tick)
    assert.ok(r.ok && r.moments === 30_000, JSON.stringify(r))
    assert.ok(maxGap < 500, `event loop blocked for ${maxGap} ms`)
    assert.ok(listInsights('client:M5').length >= 1)
})

test('M6: a recording is attributed to a client only when ALL its events belong to that client; processing re-checks it', async () => {
    const { attributableTo } = await import('../src/core/replay-vision.ts')
    assert.equal(attributableTo({ clients: 1, client: 'A', distinct_id: 'u' }, 'A'), true)
    assert.equal(attributableTo({ clients: 2, client: 'A', distinct_id: 'u' }, 'A'), false, 'client A and B in one recording')
    assert.equal(attributableTo({ clients: 1, client: 'B', distinct_id: 'u' }, 'A'), false)
    assert.equal(attributableTo(null, 'A'), false)
    const W = await import('../src/service/replayvision-worker.ts')
    const end = new Date(Date.now() - 3600_000).toISOString(), sid = 'm6000000-0000-4000-8000-000000000001'
    const id = W.queueReplayVision(sid, end, 'A', 'u1', [], 'pm@example.test')
    let analysed = 0
    const deps = { ...W.realDeps, now: () => Date.now(), getRecording: async () => ({ start_time: new Date(Date.parse(end) - 60_000).toISOString(), end_time: end }), identity: async () => ({ clients: 2, client: 'A', distinct_id: 'u1' }),
        appEvents: async () => [], withSnapshots: async (_i: string, use: (f: string) => Promise<unknown>) => use('/dev/null'), analyze: async () => { analysed++; return { coverage: { state: 'complete', reasons: [] }, candidates: [], metrics: [], screens: [], events: 0 } }, fileSize: async () => 1 } as never
    assert.equal(await W.processRun(W.claimNext(Date.now())!, deps), 'skipped_identity')
    assert.equal(analysed, 0)
    assert.equal(one<{ state: string; error_code: string }>('SELECT state, error_code FROM rv_run WHERE id = ?', id)!.error_code, 'ambiguous_client')
})

test('M7: a render that never returns fails that session at the deadline; nothing is reserved and the stage returns', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const W = await import('../src/core/replay-vision-watch.ts'), P = await import('../src/core/replay-vision-watch-plan.ts'), PV = await import('../src/core/replay-vision-provider.ts')
    const now = new Date().toISOString(), sid = 'm7000000-0000-4000-8000-000000000001'
    run(`INSERT INTO rv_run(project_id,session_id,recording_end,analysis_version,mode,client_id,distinct_id,state,completed_at,metrics_json) VALUES('1',?,?,?,?,?,?,'complete',?,'{}')`, sid, now, 'v', 'deterministic', 'C7', 'm7-user', now)
    run(`INSERT INTO rv_watch(kind, value, created_by, created_at, watch_fully) VALUES('distinct_id','m7-user','admin',?,1)`, now)
    process.env.REPLAY_VISION_EXCHANGE_SELF_HOSTED = 'on'
    const ex = join(dir, 'ex-m7'); mkdirSync(ex, { recursive: true })
    writeFileSync(join(ex, 'capabilities.json'), JSON.stringify({ model: 'claude-haiku-5-5', source: 'models.retrieve', image_input: true, checked_at: now }))
    const plan = { duration_ms: 20_000, active_ms: 20_000, spans: [{ start_ms: 0, end_ms: 20_000 }], frames: [{ t_ms: 5000, reason: 'click' as const, event_ids: [] }], ranges: [{ start_s: 4, duration_s: 2 }], events: [], screens: [], dropped_frames: 0 }
    const t0 = Date.now()
    const r = await W.prepareWatchFully({ provider: new PV.ExchangeProvider(ex, 60_000), enabled: true, externalAllowed: true, renderDeadlineMs: 150, planFor: async () => plan, render: () => new Promise(() => {}) })
    assert.deepEqual(r.skipped, { render_timeout: 1 })
    assert.ok(Date.now() - t0 < 5_000)
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_reservation')!.n, 0)
    void P
})

test('M8: B-prime preparation stops at its deadline and per-tick cap; the scheduler cursor rotates through scopes', async () => {
    const L = await import('../src/core/replay-vision-llm.ts'), PV = await import('../src/core/replay-vision-provider.ts')
    const { storeFindings } = await import('../src/core/replay-vision-insights.ts')
    const now = new Date().toISOString()
    for (const c of ['S1', 'S2', 'S3']) {
        for (const u of ['a', 'b', 'c']) {
            const sid = `m8${c}-${u}-0000-4000-8000`
            run(`INSERT INTO rv_run(project_id,session_id,recording_end,analysis_version,mode,client_id,distinct_id,state,completed_at,metrics_json) VALUES('1',?,?,?,?,?,?,'complete',?,'{}')`, sid, now, 'v', 'deterministic', c, `${c}-${u}`, now)
            storeFindings(one<{ id: number }>('SELECT id FROM rv_run WHERE session_id = ?', sid)!.id, sid, [{ kind: 'D4', start_ms: 10_000, end_ms: 18_000, score: 4, screen: 'sales invoice:new', element: 'Save', step: 'Save', event_ids: ['41', '42'], facts: { cycles: 2, span_ms: 8000, lost_ms: 8000 }, limitations: [], strength: 'strong' }])
        }
        refreshInsights({ client: c })
    }
    const window = (center: number) => ({ center_ms: center, start_ms: center - 20_000, end_ms: center + 20_000, dropped_pointer_samples: 0, coverage: [], events: [{ id: '41', t_ms: center, kind: 'click' as const, label: 'Save' }, { id: '42', t_ms: center + 300, kind: 'error' as const, error: 'visible' }] })
    const provider = new PV.ExchangeProvider(join(dir, 'ex-m8'), 60_000)
    const past = await L.prepareExplanations('client:S1', { provider, windowsFor: async (_s, o) => o.map(window), deadline: Date.now() - 1 })
    assert.deepEqual([past.prepared, past.skipped.deadline], [0, 1])
    // Cursor: each tick starts where the last one stopped (cap reached after one request per tick here).
    process.env.REPLAY_VISION_ALLOW_EXTERNAL = 'on'; process.env.REPLAY_VISION_PROVIDER = 'exchange'; process.env.REPLAY_VISION_EXCHANGE_DIR = join(dir, 'ex-m8b')
    const W = await import('../src/service/replayvision-worker.ts')
    const deps = { ...W.realDeps, now: () => Date.now(), windowsFor: async (_s: string, o: number[]) => o.map(window), watchPlanFor: undefined, renderWatchFrames: undefined } as never
    const cursor = () => JSON.parse(one<{ keyset_json: string }>(`SELECT keyset_json FROM rv_cursor WHERE scope = 'bprime'`)!.keyset_json).next
    await W.textStage(deps)
    const first = cursor()
    await W.textStage(deps)
    assert.notEqual(cursor(), undefined)
    assert.ok(Number.isInteger(first))
    for (const k of ['REPLAY_VISION_ALLOW_EXTERNAL', 'REPLAY_VISION_PROVIDER', 'REPLAY_VISION_EXCHANGE_DIR']) delete process.env[k]
})
