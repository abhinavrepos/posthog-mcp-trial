// Watch fully (00-charter.md, night-run decisions): bounded idle-trimmed frame plan, image request through the
// exchange provider, gates (flag, client opt-in, verified image input, budget), citation-validated V1 findings.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const dir = mkdtempSync(join(tmpdir(), 'rv-watch-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.FEATURE_REPLAY_VISION = 'on'
test.after(() => rmSync(dir, { recursive: true, force: true }))

const P = await import('../src/core/replay-vision-watch-plan.ts')
const W = await import('../src/core/replay-vision-watch.ts')
const PV = await import('../src/core/replay-vision-provider.ts')
const B = await import('../src/core/replay-vision-budget.ts')
const { run, one, all } = await import('../src/core/db.ts')
type Item = import('../src/core/replay-timeline.ts').TimelineItem
type TL = import('../src/core/replay-timeline.ts').Timeline

function tl(items: Partial<Item>[]): TL {
    const full = items.map((x, i) => ({ event_id: String(i + 1), raw_offset_ms: x.offset_ms ?? 0, window_id: 'w', source: 'rrweb', kind: 'click', offset_ms: 0, ...x }) as Item)
    return { items: full, start_time: '2026-11-26T10:00:00Z', width: 1440, height: 900, screens: [...new Set(full.filter((e) => e.kind === 'navigation').map((e) => e.screen!))],
        coverage: { state: 'complete', lines: full.length, bad_lines: 0, full_snapshot_seen: true, meta_seen: true, pointer_seen: true, click_seen: true, dom_seen: true, input_masked: true, iframe_seen: false, iframe_unseen: false, canvas_unseen: false, clock_anomaly: false, truncated: false, reasons: [] } }
}
/** A real (tiny, valid) PNG whose IHDR claims width x height; pad adds bytes after IEND for size tests. */
function png(width = 960, height = 600, pad = 0): Buffer {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
    const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(height + 1))), chunk('IEND', Buffer.alloc(0)), Buffer.alloc(pad)])
}
const nav = (t: number, screen: string): Partial<Item> => ({ offset_ms: t, kind: 'navigation', screen })
const click = (t: number, label: string, node = 7): Partial<Item> => ({ offset_ms: t, kind: 'click', interaction: 2, label, tag: 'button', node_id: node, x: 500, y: 300 })
const verr = (t: number): Partial<Item> => ({ offset_ms: t, kind: 'error', error_kind: 'visible' })

// A session with 20 s of work, 100 s idle, 10 s of work: Save → visible error twice, then a second screen.
const session = tl([nav(0, 'sales invoice:new'), click(2000, 'Customer', 3), click(6000, 'Save'), verr(6300), click(9000, 'Save'), verr(9300), click(14_000, 'Save'),
    ...Array.from({ length: 12 }, (_, i) => ({ offset_ms: 15_000 + i * 400, kind: 'pointer' as const, x: 100 + i, y: 100 })),
    nav(120_000, 'customer:list'), click(122_000, 'Customer', 9), click(126_000, 'Back', 10)])

test('frame plan: idle trimmed, anchored on errors/navigation/clicks, bounded frames and render seconds, citations from sent events', () => {
    const plan = P.planWatch(session)
    assert.equal(plan.spans.length, 2, 'the 100 s pause is idle')
    assert.ok(plan.active_ms < 40_000 && plan.duration_ms >= 126_000)
    assert.ok(plan.frames.every((f) => plan.spans.some((s) => f.t_ms >= s.start_ms && f.t_ms <= s.end_ms)), 'no frame in idle time')
    assert.ok(plan.frames.some((f) => f.reason === 'error') && plan.frames.some((f) => f.reason === 'navigation'))
    const sent = new Set(plan.events.map((e) => e.id))
    assert.ok(plan.frames.every((f) => f.event_ids.every((id) => sent.has(id))))
    assert.ok(plan.ranges.reduce((a, r) => a + r.duration_s, 0) <= P.WATCH_LIMITS.maxRenderS)
    for (const f of plan.frames) assert.ok(plan.ranges.some((r) => f.t_ms / 1000 >= r.start_s && f.t_ms / 1000 <= r.start_s + r.duration_s), 'every frame lies in a render range')
    // 300 clicks over 10 minutes: still at most maxFrames, errors kept first.
    const busy = tl([nav(0, 'item:list'), ...Array.from({ length: 300 }, (_, i) => click(1000 + i * 2000, 'Next', 20)), verr(301_000)])
    const p2 = P.planWatch(busy)
    assert.ok(p2.frames.length <= P.WATCH_LIMITS.maxFrames && p2.dropped_frames > 0)
    assert.ok(p2.frames.some((f) => f.reason === 'error'))
    assert.ok(p2.events.length <= P.WATCH_LIMITS.maxEvents)
})

test('frames are bounded by format, per-frame bytes, count and total bytes; image tokens come from PNG dimensions', () => {
    assert.deepEqual(W.pngSize(png(960, 600)), { width: 960, height: 600 })
    assert.equal(W.pngSize(Buffer.from('not a png at all, really not')), null)
    assert.equal(W.imageTokens(960, 600), Math.ceil(960 * 600 / 750))
    assert.ok(W.imageTokens(4000, 4000) <= Math.ceil(1568 * 1568 / 750))
    const f = (t: number, b: Buffer) => ({ png: b, frame: { t_ms: t, reason: 'click' as const, event_ids: [] } })
    const { kept, dropped } = W.boundFrames([f(1, Buffer.from('GIF89a........................')), f(2, png(960, 600, P.WATCH_LIMITS.maxFrameBytes)), ...Array.from({ length: 30 }, (_, i) => f(10 + i, png()))])
    assert.equal(kept.length, P.WATCH_LIMITS.maxFrames)
    assert.equal(dropped.not_png, 1); assert.equal(dropped.frame_too_large, 1); assert.ok(dropped.frame_count! >= 1)
    const big = Array.from({ length: 16 }, (_, i) => f(i, png(960, 600, 500 * 1024)))
    const t = W.boundFrames(big)
    assert.ok(t.kept.reduce((a, x) => a + x.png.length, 0) <= P.WATCH_LIMITS.maxTotalBytes && t.dropped.total_bytes! > 0)
})

test('request: base64 PNG image blocks with captions, Haiku 5.5, structured output; trimmed to the input-token cap', () => {
    const plan = P.planWatch(session)
    const frames = plan.frames.map((frame) => ({ png: png(), frame }))
    const params = W.buildWatchParams(plan, frames)
    assert.equal(params.model, 'claude-haiku-5-5')
    const content = params.messages[0]!.content as { type: string; source?: { type: string; media_type: string; data: string } }[]
    const images = content.filter((b) => b.type === 'image')
    assert.equal(images.length, frames.length)
    assert.ok(images.every((b) => b.source!.type === 'base64' && b.source!.media_type === 'image/png' && Buffer.from(b.source!.data, 'base64').equals(frames[0]!.png)))
    assert.ok(JSON.stringify(params.output_config).includes('json_schema'))
    // 16 frames claiming 4000x4000 cost ~3.3k tokens each: the request is cut to fit 40k.
    const huge = Array.from({ length: 16 }, (_, i) => ({ png: png(4000, 4000), frame: { t_ms: i * 2000, reason: 'fill' as const, event_ids: [] } }))
    const fit = W.fitWatchRequest(plan, huge)!
    assert.ok(fit.frames.length < 16 && W.estimateWatchTokens(fit.params) <= W.WATCH_MAX_INPUT_TOKENS)
    assert.ok(W.watchWorstCaseMicros(fit.params) > 0)
})

test('validation keeps only findings that cite sent events, name a cited element on its screen and refer to nearby frames', () => {
    const plan = P.planWatch(session)
    const save = plan.events.find((e) => e.kind === 'click' && e.label === 'Save')!, err = plan.events.find((e) => e.kind === 'error')!
    const frameNear = plan.frames.findIndex((f) => Math.abs(f.t_ms - save.t_ms) <= 3000) + 1
    const sent = { events: plan.events, frames: plan.frames.map((f) => ({ t_ms: f.t_ms, event_ids: f.event_ids })) }
    const good = { screen: 'sales invoice:new', element: 'Save', summary: 'Save shows an error banner twice and the form stays unsaved', likely_cause: 'Likely cause: a required value is not marked before clicking Save.', fix: 'Fix: mark the required field next to Save before it is clicked.', cited_event_ids: [save.id, err.id], frame_refs: [frameNear], confidence: 'med' as const }
    const v = W.validateWatchFindings([good,
        { ...good, cited_event_ids: ['999999'] },
        { ...good, element: 'Delete' },
        { ...good, screen: 'customer:list' },
        { ...good, frame_refs: [99] },
        { ...good, frame_refs: [plan.frames.length] },
        { ...good, summary: 'users were frustrated by the form' },
        { ...good, likely_cause: 'Because of things.' },
        { ...good, fix: 'Fix: improve the form.' },
    ], sent)
    assert.equal(v.accepted.length, 1)
    assert.equal(v.accepted[0]!.kind, 'V1'); assert.equal(v.accepted[0]!.element, 'Save'); assert.equal(v.accepted[0]!.step, 'Save')
    assert.deepEqual(v.rejected.map((r) => r.reason), ['hallucinated_citation', 'element_not_in_cited_events', 'screen_mismatch', 'unknown_frame', 'frame_far_from_events', 'generic', 'format', 'fix_not_specific'])
})

const SID = '01a21a10-0000-7000-8000-00000000abcd'
function seed() {
    for (const t of ['rv_watch_fully_job', 'rv_finding', 'rv_run', 'rv_watch', 'rv_client_policy', 'rv_reservation', 'rv_provider_job', 'rv_budget']) run(`DELETE FROM ${t}`)
    run(`INSERT INTO rv_run(id, project_id, session_id, recording_end, analysis_version, mode, client_id, distinct_id, state, completed_at) VALUES(1,'1',?,'2026-11-26T10:05:00Z','v6','deterministic','C1','u1','complete',?)`, SID, new Date().toISOString())
    run(`INSERT INTO rv_finding(run_id,fingerprint,detector_codes_json,strength,severity,severity_reason_json,screen_key,element_key,step_key,start_ms,end_ms,evidence_json,coverage_json,confidence,created_at) VALUES(1,'f1','["D4"]','strong','Low','{}','sales invoice:new','Save','Save',6000,9300,'{}','[]','low',?)`, new Date().toISOString())
    run(`INSERT INTO rv_watch(id, kind, value, created_by, created_at) VALUES(1,'distinct_id','u1','admin','2026-11-26T00:00:00Z'), (2,'client','C1','admin','2026-11-26T00:00:00Z')`)
}
function depsFor(provider: InstanceType<typeof PV.ExchangeProvider>) {
    const plan = P.planWatch(session)
    let renders = 0
    return { renders: () => renders, deps: { provider, enabled: true, externalAllowed: true, planFor: async () => plan, render: async (_s: string, p: typeof plan) => { renders++; return p.frames.map((frame) => ({ png: png(), frame })) } } }
}
const message = (findings: unknown[], usage = { input_tokens: 9000, output_tokens: 300 }) => ({ type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify({ decision: findings.length ? 'findings' : 'none', findings }) }] })

test('gates: unverified image input, watch_fully off, no client opt-in, feature or external analysis off: nothing rendered or sent', async () => {
    seed()
    const ex = join(dir, 'ex-gates'), provider = new PV.ExchangeProvider(ex, 60_000), { deps, renders } = depsFor(provider)
    const { mkdirSync } = await import('node:fs'); mkdirSync(ex, { recursive: true })
    assert.equal((await W.watchFullyAvailability(provider)).available, false, 'no capabilities.json: unverified, so unavailable')
    assert.deepEqual((await W.prepareWatchFully(deps)).skipped, { image_input_unavailable: 1 })
    writeFileSync(join(ex, 'capabilities.json'), JSON.stringify({ model: 'claude-haiku-5-5', source: 'guess', image_input: true, checked_at: new Date().toISOString() }))
    assert.equal((await W.watchFullyAvailability(provider)).available, false, 'only a Models API result counts')
    writeFileSync(join(ex, 'capabilities.json'), JSON.stringify({ model: 'claude-haiku-5-5', source: 'models.retrieve', image_input: false, checked_at: new Date().toISOString() }))
    assert.match((await W.watchFullyAvailability(provider)).reason, /does not support image input/)
    writeFileSync(join(ex, 'capabilities.json'), JSON.stringify({ model: 'claude-haiku-5-5', source: 'models.retrieve', image_input: true, checked_at: new Date().toISOString() }))
    assert.equal((await W.watchFullyAvailability(provider)).available, true)
    assert.equal((await W.prepareWatchFully(deps)).prepared, 0, 'watch_fully is off by default')
    assert.equal(W.setWatchFully(2, true), false, 'client watches cannot be watched fully')
    assert.equal(W.setWatchFully(1, true), true)
    assert.equal((await W.prepareWatchFully(deps)).prepared, 0, 'client C1 has no vision opt-in')
    run(`INSERT INTO rv_client_policy(client_id, vision_opt_in, updated_by, updated_at) VALUES('C1',1,'admin',?)`, new Date().toISOString())
    assert.deepEqual((await W.prepareWatchFully({ ...deps, enabled: false })).skipped, { feature_off: 1 })
    assert.deepEqual((await W.prepareWatchFully({ ...deps, externalAllowed: false })).skipped, { external_analysis_off: 1 })
    assert.equal(renders(), 0)
    assert.ok(!existsSync(join(ex, 'requests')) || readdirSync(join(ex, 'requests')).length === 0)
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_reservation')!.n, 0, 'nothing reserved')
})

test('end to end through the exchange: reserve, exact image request, no resubmission, validated V1 findings stored, budget reconciled once', async () => {
    seed()
    const ex = join(dir, 'ex-e2e'), provider = new PV.ExchangeProvider(ex, 60_000), { deps } = depsFor(provider)
    const { mkdirSync } = await import('node:fs'); mkdirSync(ex, { recursive: true })
    writeFileSync(join(ex, 'capabilities.json'), JSON.stringify({ model: 'claude-haiku-5-5', source: 'models.retrieve', image_input: true, checked_at: new Date().toISOString() }))
    W.setWatchFully(1, true)
    run(`INSERT INTO rv_client_policy(client_id, vision_opt_in, updated_by, updated_at) VALUES('C1',1,'admin',?)`, new Date().toISOString())
    const r1 = await W.prepareWatchFully(deps)
    assert.equal(r1.prepared, 1)
    const files = readdirSync(join(ex, 'requests'))
    assert.equal(files.length, 1)
    const body = JSON.parse(readFileSync(join(ex, 'requests', files[0]!), 'utf8'))
    assert.equal(body.model, 'claude-haiku-5-5')
    const imgs = body.messages[0].content.filter((b: { type: string }) => b.type === 'image')
    assert.ok(imgs.length >= 1 && imgs.length <= P.WATCH_LIMITS.maxFrames)
    assert.ok(!JSON.stringify(body).includes(SID), 'no session id in the request')
    const job = one<{ custom_id: string; state: string; sent_json: string }>('SELECT custom_id, state, sent_json FROM rv_watch_fully_job')!
    assert.equal(job.state, 'submitted')
    assert.equal(one<{ state: string }>('SELECT state FROM rv_reservation WHERE custom_id = ?', job.custom_id)!.state, 'reserved')
    assert.equal((await W.prepareWatchFully(deps)).prepared, 0, 'a run is sent once')
    // The answer: one grounded finding, one hallucinated.
    const sent = JSON.parse(job.sent_json) as { events: { id: string; kind: string; label?: string; t_ms: number }[]; frames: { t_ms: number }[] }
    const save = sent.events.find((e) => e.kind === 'click' && e.label === 'Save')!
    const near = sent.frames.findIndex((f) => Math.abs(f.t_ms - save.t_ms) <= 3000) + 1
    const finding = { screen: 'sales invoice:new', element: 'Save', summary: 'An error banner appears after Save and the form stays unsaved', likely_cause: 'Likely cause: the field the banner names is not marked before Save.', fix: 'Fix: mark that field next to Save before it is clicked.', cited_event_ids: [save.id], frame_refs: [near], confidence: 'high' }
    writeFileSync(join(ex, 'responses', `${job.custom_id}.json`), JSON.stringify(message([finding, { ...finding, cited_event_ids: ['nope'] }])))
    const r2 = await W.collectWatchFully({ provider })
    assert.equal(r2.accepted_findings, 1); assert.equal(r2.rejected_findings, 1)
    const rows = all<{ detector_codes_json: string; element_key: string }>('SELECT detector_codes_json, element_key FROM rv_finding WHERE run_id = 1 ORDER BY id')
    assert.deepEqual(rows.map((r) => [r.detector_codes_json, r.element_key]), [['["D4"]', 'Save'], ['["V1"]', 'Save']], 'deterministic finding kept, V1 added')
    assert.equal(one<{ state: string }>('SELECT state FROM rv_reservation WHERE custom_id = ?', job.custom_id)!.state, 'reconciled')
    assert.equal(one<{ state: string }>('SELECT state FROM rv_watch_fully_job')!.state, 'complete')
    assert.equal((await W.collectWatchFully({ provider })).collected, 0, 'settled exactly once')
})

test('no answer before the deadline releases the reservation; a full budget refuses before sending', async () => {
    seed()
    const ex = join(dir, 'ex-timeout'), provider = new PV.ExchangeProvider(ex, 1), { deps } = depsFor(provider)
    const { mkdirSync } = await import('node:fs'); mkdirSync(ex, { recursive: true })
    writeFileSync(join(ex, 'capabilities.json'), JSON.stringify({ model: 'claude-haiku-5-5', source: 'models.retrieve', image_input: true, checked_at: new Date().toISOString() }))
    W.setWatchFully(1, true)
    run(`INSERT INTO rv_client_policy(client_id, vision_opt_in, updated_by, updated_at) VALUES('C1',1,'admin',?)`, new Date().toISOString())
    assert.equal((await W.prepareWatchFully(deps)).prepared, 1)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal((await W.collectWatchFully({ provider })).expired, 1)
    assert.equal(one<{ state: string }>('SELECT state FROM rv_reservation')!.state, 'released')
    assert.equal(one<{ state: string }>('SELECT state FROM rv_provider_job')!.state, 'provider_expired')
    assert.equal(one<{ n: number }>(`SELECT count(*) AS n FROM rv_finding WHERE detector_codes_json = '["V1"]'`)!.n, 0, 'nothing invented')
    // Budget: the day's call ceiling is used up.
    seed(); W.setWatchFully(1, true)
    run(`INSERT INTO rv_client_policy(client_id, vision_opt_in, updated_by, updated_at) VALUES('C1',1,'admin',?)`, new Date().toISOString())
    run(`INSERT INTO rv_budget(day_utc, scope, used_llm_calls) VALUES(?, 'global', ?)`, B.dayOf(), B.BUDGET.dailyLlmCalls)
    assert.deepEqual((await W.prepareWatchFully(deps)).skipped, { budget: 1 })
})

test('the real worker builds the plan from a recording without leaking page text', async () => {
    const { analyzeFile } = await import('../src/core/replay-vision.ts')
    const base = Date.parse('2026-11-26T00:00:00Z'), ev = (ms: number, type: number, data: unknown) => ['main', { timestamp: base + ms, type, data }]
    const root = { id: 1, type: 2, tagName: 'div', childNodes: [{ id: 2, type: 2, tagName: 'button', childNodes: [{ id: 3, type: 3, textContent: 'Save' }] }, { id: 4, type: 2, tagName: 'p', childNodes: [{ id: 5, type: 3, textContent: 'ACME Treasury secret 4711' }] }] }
    const rows = [ev(0, 4, { href: 'http://app/desk/sales-invoice/new', width: 1000, height: 800 }), ev(1, 2, { node: root, initialOffset: { top: 0, left: 0 } }), ev(2000, 3, { source: 2, type: 2, id: 2, x: 5, y: 5 }), ev(60_000, 3, { source: 2, type: 2, id: 2, x: 5, y: 5 })]
    const file = join(dir, 'rec.jsonl'); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const r = await analyzeFile(file, { start_time: new Date(base).toISOString() }, 30_000, {}, undefined, true)
    assert.ok(r.watch && r.watch.frames.length >= 2 && r.watch.spans.length === 2)
    assert.ok(!JSON.stringify(r.watch).includes('ACME') && !JSON.stringify(r.watch).includes('4711'))
    assert.equal(r.candidates.length, 0, 'plan mode returns no findings')
})

test('V1 findings from two users aggregate into one validated "vision" insight with code-computed counts and citations', async () => {
    const { aggregateInsights } = await import('../src/core/replay-vision-aggregate.ts')
    const plan = P.planWatch(session)
    const save = plan.events.find((e) => e.kind === 'click' && e.label === 'Save')!
    const near = plan.frames.findIndex((f) => Math.abs(f.t_ms - save.t_ms) <= 3000) + 1
    const sent = { events: plan.events, frames: plan.frames.map((f) => ({ t_ms: f.t_ms, event_ids: f.event_ids })) }
    const [c] = W.validateWatchFindings([{ screen: 'sales invoice:new', element: 'Save', summary: 'An error banner appears after Save and the form stays unsaved', likely_cause: 'Likely cause: the field named in the error is not marked before Save.', fix: 'Fix: mark that field next to Save before it is clicked.', cited_event_ids: [save.id], frame_refs: [near], confidence: 'high' }], sent).accepted
    const moments = ['01a21a10-0000-7000-8000-000000000001', '01a21a10-0000-7000-8000-000000000002'].map((sid, i) => ({ session_id: sid, user_id: `u${i}`, candidate: c!, time_lost_ms: 0, abandoned: false }))
    const out = aggregateInsights(moments, new Map([['sales invoice:new', { users: 6, source: 'test' }]]), new Map())
    assert.equal(out.length, 1)
    assert.equal(out[0]!.family, 'vision')
    assert.equal(out[0]!.draft.users_affected, 2)
    assert.ok(out[0]!.rubric.valid && out[0]!.text.includes('An error banner appears after Save'))
    assert.equal(out[0]!.draft.citations.length, 2)
})
