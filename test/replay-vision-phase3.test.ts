// Phase 3: remaining detectors, baselines, severity, aggregation and the insight validator.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forAll, NASTY } from './rv-prop.ts'

const dir = mkdtempSync(join(tmpdir(), 'rv-phase3-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
test.after(() => rmSync(dir, { recursive: true, force: true }))

const { detectCandidates, screenVisits, DETECTOR_CONFIG } = await import('../src/core/replay-vision-detectors.ts')
const { classifySeverity, buildBaseline, classifyMetric, wilsonLower, binaryAnomaly } = await import('../src/core/replay-vision-severity.ts')
const { aggregateInsights, formatInsight } = await import('../src/core/replay-vision-aggregate.ts')
const { validateInsight } = await import('../src/core/replay-vision-validator.ts')
const { sessionMetrics } = await import('../src/core/replay-vision-metrics.ts')
const { runMetrics, recomputeBaselines, loadBaselines, baselineContext } = await import('../src/core/replay-vision-baseline.ts')
const { storeFindings, refreshInsights, listInsights, deleteSessionData } = await import('../src/core/replay-vision-insights.ts')
const { run, one, all } = await import('../src/core/db.ts')
type TL = import('../src/core/replay-timeline.ts').Timeline
type Item = import('../src/core/replay-timeline.ts').TimelineItem
type Cand = import('../src/core/replay-vision-detectors.ts').Candidate
type SevIn = import('../src/core/replay-vision-severity.ts').SeverityInput
type Moment = import('../src/core/replay-vision-aggregate.ts').Moment

function tl(items: Partial<Item>[], cov: Partial<TL['coverage']> = {}, height = 800): TL {
    // Real rrweb records a Focus interaction on a field before input on it (click or Tab); edits model that, unless
    // marked scripted (a value set by the page itself, which never counts as a user edit).
    const expanded = items.flatMap((x) => x.kind === 'input_activity' && x.node_id !== undefined && !(x as { scripted?: boolean }).scripted ? [{ offset_ms: (x.offset_ms ?? 0) - 1, kind: 'focus' as const, node_id: x.node_id, label: x.label }, x] : [x])
    const full = expanded.map((x, i) => ({ event_id: String(i + 1), offset_ms: 0, raw_offset_ms: x.offset_ms ?? 0, window_id: 'main', kind: 'click', source: 'rrweb', ...x }) as Item)
    return {
        items: full, start_time: '2026-11-26T10:00:00Z', width: 1280, height,
        screens: [...new Set(full.filter((e) => e.kind === 'navigation').map((e) => e.screen!))],
        coverage: { state: 'complete', lines: full.length, bad_lines: 0, full_snapshot_seen: true, meta_seen: true, pointer_seen: true, click_seen: true, dom_seen: true, input_masked: true, iframe_seen: false, iframe_unseen: false, canvas_unseen: true, clock_anomaly: false, truncated: false, reasons: [], ...cov },
    }
}
const nav = (t: number, screen: string): Partial<Item> => ({ offset_ms: t, kind: 'navigation', screen })
const click = (t: number, label?: string, extra: Partial<Item> = {}): Partial<Item> => ({ offset_ms: t, kind: 'click', interaction: 2, label, tag: 'button', x: 100, y: 100, ...extra })
const nodeOf = (label: string) => 1000 + [...label].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 100_000, 7)
const edit = (t: number, label = 'Customer'): Partial<Item> => ({ offset_ms: t, kind: 'input_activity', label, node_id: nodeOf(label) })
const focus = (t: number, label: string): Partial<Item> => ({ offset_ms: t, kind: 'focus', label })
const verr = (t: number): Partial<Item> => ({ offset_ms: t, kind: 'error', error_kind: 'visible' })
const scroll = (t: number, y: number): Partial<Item> => ({ offset_ms: t, kind: 'scroll', scroll_y: y, scroll_id: 1 })
const kinds = (c: Cand[]) => c.map((x) => x.kind)

test('R1 counts A→B→A loops per task and respects the population dwell median; R2 counts re-opens', () => {
    const t = tl([nav(0, 'sales invoice:new'), edit(1000), nav(5000, 'customer:form'), click(6000, 'Customer'), nav(9000, 'sales invoice:new'), edit(10_000),
        nav(14_000, 'customer:form'), click(15_000, 'Customer'), nav(18_000, 'sales invoice:new'), edit(19_000)])
    const r1 = detectCandidates(t).filter((c) => c.kind === 'R1')
    assert.equal(r1.length, 1)
    assert.equal(r1[0]!.facts.loops, 2); assert.equal(r1[0]!.screen, 'sales invoice:new'); assert.equal(r1[0]!.element, 'customer:form')
    assert.equal(r1[0]!.facts.dwell_b_ms, 4000)
    // B's dwell (4 s) is not below a 3 s population median: not a quick lookup loop.
    assert.equal(detectCandidates(t, DETECTOR_CONFIG, { screenDwellMedianMs: { 'customer:form': 3000 } }).filter((c) => c.kind === 'R1').length, 0)
    assert.equal(detectCandidates(t, DETECTOR_CONFIG, { screenDwellMedianMs: { 'customer:form': 30_000 } }).find((c) => c.kind === 'R1')!.facts.calibrated, true)
    const r2 = detectCandidates(t).filter((c) => c.kind === 'R2')
    assert.deepEqual(r2.map((c) => [c.screen, c.facts.reopens]), [['sales invoice:new', 3]])
    // A single lookup and return is still detected and labelled.
    const one = detectCandidates(tl([nav(0, 'a:new'), nav(3000, 'b:form'), nav(5000, 'a:new')])).find((c) => c.kind === 'R1')!
    assert.equal(one.facts.single_lookup, true)
})

test('same-route navigation within 2 s is one visit; a task ends at the saved-record transition', () => {
    const v = screenVisits(tl([nav(0, 'a:new'), nav(800, 'a:new'), nav(1500, 'a:new'), nav(9000, 'b:list')]).items)
    assert.equal(v.length, 2)
    // new → form is success: a later revisit belongs to a new task, so no loop across it.
    const t = tl([nav(0, 'sales invoice:new'), edit(500), nav(3000, 'sales invoice:form'), nav(6000, 'customer:form'), nav(8000, 'sales invoice:form')])
    assert.equal(detectCandidates(t).filter((c) => c.kind === 'R1').length, 0)
})

test('S2 reversals need hysteresis max(0.25·H, 200 px); S3 needs 3 reversals in 15 s without clicks; S1 is D/H', () => {
    const base = [nav(0, 'item:list'), click(100, 'Search')]
    const ys = [0, 1000, 900, 1500, 1000, 2000, 1200, 2400]
    const t = tl([...base, ...ys.map((y, i) => scroll(1000 + i * 1000, y))])
    const c = detectCandidates(t)
    const s2 = c.find((x) => x.kind === 'S2')!
    assert.equal(s2.facts.reversals, 4, '100 px overshoot is not a reversal; 500, 1000, 800, 1200 px turns are')
    const s3 = c.find((x) => x.kind === 'S3')!
    assert.equal(s3.facts.hunting_rule, 'reversals'); assert.equal(s3.element, 'Page')
    assert.ok(c.some((x) => x.kind === 'S1'))
    assert.equal(s2.facts.distance_px, 1000 + 100 + 600 + 500 + 1000 + 800 + 1200)
    // A click between reversals breaks the hunting window.
    const withClicks = tl([...base, ...ys.flatMap((y, i) => [scroll(1000 + i * 3000, y), click(2000 + i * 3000, 'Item')])])
    assert.ok(!detectCandidates(withClicks).some((x) => x.kind === 'S3' && x.facts.hunting_rule === 'reversals'))
    // Population page extent P lowers D/P.
    const ctx = { pageExtentPx: { 'item:list|main:1': 100_000 } }
    assert.equal(detectCandidates(t, DETECTOR_CONFIG, ctx).find((x) => x.kind === 'S2')!.facts.p_source, 'population')
})

test('D4 counts Save → visible error → edit cycles; without edits it is not a loop', () => {
    const loop = tl([nav(0, 'sales invoice:new'), click(1000, 'Save'), verr(1500), edit(2000), click(3000, 'Save'), verr(3200), edit(4000), click(5000, 'Save'), verr(5300)])
    const d4 = detectCandidates(loop).find((c) => c.kind === 'D4')!
    assert.equal(d4.facts.cycles, 3); assert.equal(d4.element, 'Save'); assert.equal(d4.step, 'Save'); assert.equal(d4.start_ms, 1000)
    const noEdits = tl([nav(0, 'sales invoice:new'), click(1000, 'Save'), verr(1500), click(3000, 'Save'), verr(3200)])
    assert.ok(!kinds(detectCandidates(noEdits)).includes('D4'))
})

test('D10 measures Save → saved record and overlays; D5 needs an exit, never the tail; D6 hesitation; D2 needs DOM coverage', () => {
    const slow = detectCandidates(tl([nav(0, 'sales invoice:new'), edit(500), click(1000, 'Save'), nav(7500, 'sales invoice:form')])).find((c) => c.kind === 'D10')!
    assert.equal(slow.facts.wait_ms, 6500); assert.equal(slow.facts.signal, 'save_response'); assert.equal(slow.screen, 'sales invoice:new')
    const overlay = detectCandidates(tl([nav(0, 'x:form'), click(1000, 'Submit'), { offset_ms: 1200, kind: 'coverage', label: 'wait_start' }, { offset_ms: 16_000, kind: 'coverage', label: 'wait_end' }])).find((c) => c.kind === 'D10')!
    assert.equal(overlay.facts.wait_ms, 15_000); assert.equal(overlay.facts.strong, true)
    const left = detectCandidates(tl([nav(0, 'quotation:new'), edit(1000, 'Customer'), click(2000, 'Save'), verr(2200), nav(9000, 'quotation:list')])).find((c) => c.kind === 'D5')!
    assert.equal(left.facts.last_error, true); assert.equal(left.element, 'Customer'); assert.equal(left.screen, 'quotation:new')
    assert.ok(!kinds(detectCandidates(tl([nav(0, 'quotation:new'), edit(1000)]))).includes('D5'), 'session tail is uncertain')
    assert.ok(!kinds(detectCandidates(tl([nav(0, 'quotation:new'), edit(1000), nav(5000, 'quotation:form'), nav(9000, 'quotation:list')]))).includes('D5'), 'saved record is success')
    const h = detectCandidates(tl([nav(0, 'journal entry:new'), focus(1000, 'Posting Date'), edit(5200, 'Posting Date')])).find((c) => c.kind === 'D6')!
    assert.equal(h.facts.hesitation_ms, 4200); assert.equal(h.element, 'Posting Date')
    const dead = [nav(0, 'x:form'), click(1000, 'Apply')]
    assert.ok(kinds(detectCandidates(tl(dead))).includes('D2'))
    assert.ok(!kinds(detectCandidates(tl(dead, { dom_seen: false }))).includes('D2'), 'no DOM coverage: silence is not evidence')
    assert.ok(!kinds(detectCandidates(tl([...dead, { offset_ms: 1800, kind: 'mutation' }]))).includes('D2'))
})

test('D3 needs an rrweb console/network error within 1 s; repeated background errors need a visible error', () => {
    const net = (t: number): Partial<Item> => ({ offset_ms: t, kind: 'error', error_kind: 'network' })
    const c = detectCandidates(tl([nav(0, 'x:form'), click(1000, 'Submit'), net(1400), click(5000, 'Submit'), net(5300), click(9000, 'Submit'), net(9200), verr(9300)]))
    const d3 = c.filter((x) => x.kind === 'D3')
    assert.deepEqual(d3.map((x) => x.start_ms), [1000, 9000], 'first of its kind, then only with a visible error')
    assert.ok(!kinds(detectCandidates(tl([nav(0, 'x:form'), click(1000, 'Submit'), { offset_ms: 1100, kind: 'error', error_kind: 'exception', source: 'app' }]))).includes('D3'))
})

test('event order within one timestamp does not change detector output (property)', () => {
    forAll(60, 11, (r) => {
        const items: Partial<Item>[] = [nav(0, 'a:new')]
        let t = 0
        for (let i = 0; i < 40; i++) {
            t += r.pick([0, 0, 100, 400, 1500, 4000])
            items.push(r.pick([click(t, r.pick(['Save', 'Submit', 'Apply', undefined])), edit(t), focus(t, 'Customer'), verr(t), scroll(t, r.int(0, 4000)), nav(t, r.pick(['a:new', 'b:form', 'a:list'])), { offset_ms: t, kind: 'mutation' }]))
        }
        const a = tl(items), b = { ...a, items: r.shuffle(a.items) }
        const key = (c: Cand[]) => JSON.stringify(c.map((x) => [x.kind, x.start_ms, x.end_ms, x.screen, x.element, x.event_ids]))
        assert.equal(key(detectCandidates(b)), key(detectCandidates(a)))
    })
})

test('severity boundaries: U 2/3, p 24.9/25%, T 59/60 s, strong patterns, cold-start, single-user and weak-only caps', () => {
    const base: SevIn = { kind: 'D10', users_affected: 3, users_reached: 12, median_lost_ms: 60_000, abandoned_users: 0, calibrated: true }
    const cases: [Partial<SevIn>, string][] = [
        [{}, 'High'], [{ users_affected: 2, users_reached: 8 }, 'Medium'],
        [{ users_affected: 249, users_reached: 1000 }, 'Medium'], [{ users_affected: 250, users_reached: 1000 }, 'High'],
        [{ median_lost_ms: 59_999 }, 'Medium'], [{ median_lost_ms: 60_000 }, 'High'],
        [{ users_affected: 2, users_reached: 100, median_lost_ms: 29_999 }, 'Low'], [{ users_affected: 2, users_reached: 100, median_lost_ms: 30_000 }, 'Medium'],
        [{ users_affected: 2, users_reached: 21, median_lost_ms: 0 }, 'Low'], [{ users_affected: 2, users_reached: 20, median_lost_ms: 0 }, 'Medium'],
        [{ calibrated: false }, 'Medium'], [{ calibrated: false, abandoned_users: 2 }, 'High'],
        [{ users_affected: 1, users_reached: 1, abandoned_users: 2 }, 'Low'],
        [{ kind: 'D8' }, 'Low'], [{ kind: 'D9' }, 'Low'], [{ kind: 'S2' }, 'Low'], [{ kind: 'D15' }, 'Low'], [{ kind: 'D14' }, 'Low'],
        [{ kind: 'S1' }, 'Low'], [{ kind: 'S1', corroborated: true }, 'High'], [{ weak_only: true }, 'Low'],
        [{ kind: 'D4', cycles: 2, users_reached: null, median_lost_ms: 0 }, 'High'], [{ kind: 'D4', cycles: 1, users_reached: null, median_lost_ms: 0 }, 'Low'],
        [{ kind: 'D4', cycles: 2, users_affected: 2, users_reached: null, median_lost_ms: 0 }, 'Medium'],
        [{ kind: 'R1', loops: 3, users_reached: null, median_lost_ms: 0 }, 'High'], [{ kind: 'R1', loops: 2, users_reached: null, median_lost_ms: 0 }, 'Low'],
        [{ kind: 'D3', users_reached: null, median_lost_ms: 0 }, 'High'], [{ kind: 'D3', strong_error: false, users_reached: null, median_lost_ms: 0 }, 'Low'],
        [{ users_reached: null, median_lost_ms: 0 }, 'Low'], [{ observed_rate_lower_bound: true, median_lost_ms: 0 }, 'Low'],
        [{ abandoned_users: 2, users_reached: null, median_lost_ms: 0, users_affected: 2 }, 'High'],
    ]
    for (const [patch, want] of cases) assert.equal(classifySeverity({ ...base, ...patch }).severity, want, JSON.stringify(patch))
    const r = classifySeverity({ ...base, kind: 'D4', cycles: 3, abandoned_users: 3 })
    assert.match(r.reason, /^High: 3 users abandoned after friction\. U\/N 3\/12/)
    assert.match(classifySeverity({ ...base, calibrated: false }).reason, /capped Medium: uncalibrated/)
})

test('severity is monotone in users, time and abandonment, and total on arbitrary input (property)', () => {
    const order = { Low: 0, Medium: 1, High: 2 } as const
    const codes = ['D1','D2','D3','D4','D5','D6','D7','D8','D9','D10','R1','R2','D12','S1','S2','S3','D14','D15'] as const
    forAll(3000, 5, (r) => {
        const x: SevIn = { kind: r.pick(codes), users_affected: r.int(0, 30), users_reached: r.bool(0.2) ? null : r.int(30, 200), median_lost_ms: r.int(0, 200_000), abandoned_users: r.int(0, 4), calibrated: r.bool(), cycles: r.int(0, 5), loops: r.int(0, 5), corroborated: r.bool(), strong_error: r.bool(0.8) }
        x.abandoned_users = Math.min(x.abandoned_users, x.users_affected)
        const y = { ...x, users_affected: x.users_affected + r.int(0, 3), median_lost_ms: x.median_lost_ms + r.int(0, 60_000) }
        y.abandoned_users = Math.min(y.users_affected, x.abandoned_users + r.int(0, 2))
        assert.ok(order[classifySeverity(y).severity] >= order[classifySeverity(x).severity], JSON.stringify({ x, y }))
        const nasty: SevIn = { kind: r.pick(codes), users_affected: r.pick(NASTY), users_reached: r.bool() ? r.pick(NASTY) : null, median_lost_ms: r.pick(NASTY), abandoned_users: r.pick(NASTY), calibrated: r.bool(), cycles: r.pick(NASTY), loops: r.pick(NASTY) }
        const out = classifySeverity(nasty)
        assert.ok(['High', 'Medium', 'Low'].includes(out.severity))
        assert.ok(!/NaN|Infinity/.test(out.reason), out.reason)
    })
})

test('baseline: one extreme session moves median and MAD by at most one rank step (property); MAD=0 falls back to percentile', () => {
    forAll(500, 7, (r) => {
        const values = Array.from({ length: r.int(20, 80) }, () => Math.round(r.float(0, 50)))
        const a = buildBaseline(values, 10), b = buildBaseline([...values, r.pick([1e9, -1e9, 1e6])], 10)
        const sorted = values.slice().sort((p, q) => p - q), k = Math.ceil(0.5 * sorted.length) - 1
        assert.ok(b.median >= sorted[Math.max(0, k - 1)]! && b.median <= sorted[Math.min(sorted.length - 1, k + 1)]!, `median ${a.median} → ${b.median}`)
        const shift = Math.abs(b.median - a.median)
        const devs = values.map((v) => Math.abs(v - a.median)).sort((p, q) => p - q)
        assert.ok(b.mad >= devs[Math.max(0, k - 1)]! - shift - 1e-9 && b.mad <= devs[Math.min(devs.length - 1, k + 1)]! + shift + 1e-9, `mad ${a.mad} → ${b.mad}`)
    })
    const zero = buildBaseline([...Array(19).fill(0), 7], 6)
    assert.equal(zero.mad, 0)
    assert.deepEqual([classifyMetric(7, zero, 1).method, classifyMetric(7, zero, 1).band], ['percentile', 'anomalous'])
    assert.equal(classifyMetric(7, zero, 8).band, 'normal', 'below the absolute floor')
    assert.equal(classifyMetric(9, buildBaseline([1, 2, 3], 2), 1).method, 'cold')
})

test('Wilson lower bound and binary rate comparison', () => {
    assert.ok(Math.abs(wilsonLower(5, 10) - 0.2366) < 1e-3)
    assert.equal(wilsonLower(0, 0), 0); assert.equal(wilsonLower(NaN, 5), 0)
    assert.ok(binaryAnomaly(8, 10, 0.1, 0.2)); assert.ok(!binaryAnomaly(2, 10, 0.1, 0.2))
    assert.ok(!binaryAnomaly(3, 3, 0.4, 0.5), 'three of three is not enough evidence against a 50% prior')
})

const cand = (kind: Cand['kind'], start: number, facts: Cand['facts'], over: Partial<Cand> = {}): Cand => ({ kind, start_ms: start, end_ms: start + 2000, score: 2, screen: 'sales invoice:new', element: 'Save', step: 'Save', event_ids: [`e${start}`], facts, limitations: [], strength: kind === 'D4' || kind === 'D5' ? 'strong' : 'medium', ...over })
const moment = (sid: string, uid: string, c: Cand, abandoned = false): Moment => ({ session_id: sid, user_id: uid, candidate: c, time_lost_ms: Number(c.facts.lost_ms) || 0, abandoned })

test('aggregation counts distinct users, never inflates U by repeats, and is invariant to ids (property)', () => {
    const d4 = (s: number) => cand('D4', s, { cycles: 2, span_ms: 9000, lost_ms: 9000 })
    const moments = [moment('s1', 'u1', d4(1000)), moment('s2', 'u1', d4(2000)), moment('s3', 'u1', d4(3000)), moment('s4', 'u2', d4(4000)), moment('s5', 'u3', d4(5000))]
    const reach = new Map([['sales invoice:new', { users: 6, source: 'test' }]])
    const [a] = aggregateInsights(moments, reach, new Map([['sales invoice:new', true]]))
    assert.equal(a!.draft.users_affected, 3); assert.equal(a!.draft.sessions_affected, 5); assert.equal(a!.draft.severity, 'High')
    assert.equal(new Set(a!.draft.citations.map((c) => c.session_id)).size, 5)
    assert.match(a!.text, /^\[High\] Sales Invoice \(new\) › Save: 3 of 6 users \/ 5 sessions: clicked Save and got a visible validation error 2 times in a row/)
    assert.match(a!.text, /Likely cause: .* Fix: on Sales Invoice \(new\), validate .* Evidence: http\S+\/replay\/s1\?t=1 @0:01/)
    // Repeats by one user: U stays 1 → at most a labelled single-session insight, Low.
    const single = aggregateInsights([moment('s1', 'u1', d4(1000)), moment('s1', 'u1', d4(30_000))], reach, new Map())
    assert.equal(single[0]!.draft.single_session, true); assert.equal(single[0]!.draft.severity, 'Low')
    assert.equal(aggregateInsights([moment('s1', 'u1', d4(1000)), moment('s2', 'u1', d4(1000))], reach, new Map()).length, 0, 'one user, two sessions, no labelled single session')
    forAll(50, 3, (r) => {
        const users = ['u1', 'u2', 'u3', 'u4'], perm = r.shuffle(users), rename = new Map(users.map((u, i) => [u, `x${perm[i]}`]))
        const ms = Array.from({ length: r.int(2, 12) }, (_, i) => moment(`s${i}`, r.pick(users), d4(1000 * (i + 1))))
        const renamed = ms.map((m) => ({ ...m, user_id: rename.get(m.user_id)!, session_id: `z-${m.session_id}`, candidate: { ...m.candidate } }))
        const f = (xs: Moment[]) => aggregateInsights(xs, reach, new Map([['sales invoice:new', true]])).map((x) => [x.draft.severity, x.draft.users_affected, x.draft.sessions_affected, x.draft.time_lost_ms])
        assert.deepEqual(f(renamed), f(ms))
    })
})

test('validator rejects generic text, invented citations and wrong detectors; weak-only groups never publish', () => {
    const d4 = (s: number) => cand('D4', s, { cycles: 2, span_ms: 9000, lost_ms: 9000 })
    const ev = [{ session_id: 'a', candidate: d4(1000) }, { session_id: 'b', candidate: d4(2000) }]
    const good = aggregateInsights(ev.map((e, i) => moment(e.session_id, `u${i}`, e.candidate)), new Map([['sales invoice:new', { users: 4, source: 't' }]]), new Map([['sales invoice:new', true]]))[0]!.draft
    assert.ok(validateInsight(good, ev).valid)
    assert.ok(!validateInsight({ ...good, behaviour: 'Users were frustrated by Save 2 times' }, ev).valid)
    assert.ok(!validateInsight({ ...good, fix: 'Fix: improve the UX of Save.' }, ev).valid)
    assert.ok(!validateInsight({ ...good, citations: [good.citations[0]!, { ...good.citations[1]!, event_ids: ['invented'] }] }, ev).valid)
    assert.ok(!validateInsight({ ...good, citations: good.citations.map((c) => ({ ...c, offset_ms: c.offset_ms + 60_000 })) }, ev).valid, 'offset far from the cited moment')
    assert.ok(!validateInsight({ ...good, signals: ['D10'] }, ev).valid, 'cited moment is not of the claimed detector')
    assert.ok(!validateInsight({ ...good, element: 'ext-comp-1042' }, ev).valid, 'generated id is not a visible label')
    const dwell = (s: number) => cand('D8', s, { dwell_ms: 4000 }, { element: 'Posting Date', step: 'Use Posting Date', strength: 'weak' })
    assert.equal(aggregateInsights([moment('a', 'u1', dwell(1000)), moment('b', 'u2', dwell(1000)), moment('c', 'u3', dwell(1000))], new Map(), new Map()).length, 0)
    assert.ok(formatInsight(good).includes('Signals: D4'))
})

test('baselines use every admitted deterministic run incl. zero-hit visits, never LLM-mode rows; refresh writes only validated insights', () => {
    const now = new Date().toISOString()
    const screen = 'sales invoice:new'
    const insertRun = (sid: string, uid: string, cands: Cand[], mode = 'deterministic') => {
        const t = tl([nav(0, screen), edit(100)])
        const metrics = sessionMetrics(t, cands)
        run(`INSERT INTO rv_run(project_id,session_id,recording_end,analysis_version,mode,client_id,distinct_id,state,completed_at,metrics_json) VALUES('1',?,?,?,?,?,?,'complete',?,?)`,
            sid, now, 'v', mode, 'C1', uid, now, JSON.stringify(runMetrics([screen], cands, 10, 100, metrics)))
        return Number(one<{ id: number }>('SELECT id FROM rv_run WHERE session_id = ? AND mode = ?', sid, mode)!.id)
    }
    const d4 = (s: number) => cand('D4', s, { cycles: 2, span_ms: 9000, lost_ms: 9000, error_category: 'visible validation error' })
    const d5 = (s: number) => cand('D5', s, { edits: 3, after_friction: true, last_error: true, exit_to: 'sales invoice:list', lost_ms: 40_000, last_field: 'Customer' }, { element: 'Customer', step: 'Abandon form' })
    for (let i = 0; i < 4; i++) insertRun(`clean-${i}`, `clean-user-${i}`, [])
    const ids = ['a', 'b', 'c'].map((u, i) => insertRun(`loop-${u}`, `user-${u}`, i < 2 ? [d4(1000), d5(20_000)] : [d4(1000)]))
    insertRun('loop-a2', 'user-a', [d4(5000)]) // a repeat by user a
    insertRun('llm-only', 'llm-user', [cand('D10', 1000, { wait_ms: 999_999, lost_ms: 999_999 })], 'text')
    recomputeBaselines()
    const b = loadBaselines()
    const d4b = b.get(`D4|${screen}`)!
    assert.equal(d4b.n_sessions, 8, '4 clean zero-hit runs + 4 with D4; the text-mode run is excluded')
    assert.equal(d4b.median, 0, 'zero-hit runs pull the median down: the baseline is not built from flagged sessions')
    assert.equal(d4b.p90, 2); assert.equal(d4b.rate, 0.5)
    assert.equal(b.get(`D10|${screen}`)!.p95, 0, 'LLM-mode run cannot shift the baseline')
    assert.deepEqual(baselineContext(b), { screenDwellMedianMs: {}, pageExtentPx: {} }, 'cold: fewer than 20 sessions / 5 users')
    const sessions = ['loop-a', 'loop-b', 'loop-c', 'loop-a2']
    const runIds = [...ids, Number(one<{ id: number }>("SELECT id FROM rv_run WHERE session_id='loop-a2'")!.id)]
    runIds.forEach((id, i) => storeFindings(id, sessions[i]!, i === 3 ? [d4(5000)] : i < 2 ? [d4(1000), d5(20_000)] : [d4(1000)]))
    const r = refreshInsights({ client: 'C1' })
    const loop = r.insights.find((x) => x.family === 'validation')!
    assert.equal(loop.draft.users_affected, 3); assert.equal(loop.draft.sessions_affected, 4)
    assert.equal(loop.draft.users_reached, 7, 'fallback N: distinct users among analysed deterministic recordings (4 clean + a, b, c), labelled a lower bound')
    assert.equal(loop.abandoned_users, 2)
    assert.equal(loop.draft.severity, 'High', '2 users abandoned after friction: High even on a cold screen')
    assert.match(loop.reach_source, /analysed recordings \(observed lower bound\)/)
    const stored = listInsights('client:C1')
    assert.ok(stored.length >= 1 && stored[0]!.severity === 'High')
    assert.ok(stored.every((s) => s.rubric_score >= 14))
    const abandon = r.insights.find((x) => x.family === 'abandon')!
    assert.equal(abandon.draft.element, 'Customer'); assert.equal(abandon.draft.severity, 'High'); assert.equal(abandon.abandoned_users, 2)
    assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM rv_finding WHERE severity = 'High'")!.n, 6, 'member moments take their insight severity (4 D4 + 2 D5)')
    assert.ok(all<{ cause: string }>('SELECT cause FROM rv_insight').every((x) => !/frustrat|confus/i.test(x.cause)))
    // Idempotent refresh; deletion of the sources removes the insight.
    assert.equal(refreshInsights({ client: 'C1' }).insights.length, r.insights.length)
    for (const s of sessions) deleteSessionData(s)
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_insight')!.n, 0)
})

test('co-starting signals are cited once per moment; equal rounded ranges print once', () => {
    const f = { distance_px: 5000, d_over_h: 7, d_over_p: 2.9, reversals: 8, page_lower_bound_px: 1810, hunting_rule: 'reversals', lost_ms: 12_000 }
    const sc = (k: Cand['kind'], s: number) => cand(k, s, f, { element: 'Item list', step: 'Scroll', screen: 'item:list', strength: k === 'S2' ? 'weak' : 'medium' })
    const ms = ['a', 'b'].flatMap((u, i) => (['S1', 'S2', 'S3'] as const).map((k) => moment(`s-${u}`, u, sc(k, 1000 + i * 37))))
    const [a] = aggregateInsights(ms, new Map([['item:list', { users: 5, source: 't' }]]), new Map())
    assert.deepEqual(a!.draft.citations.map((c) => c.session_id), ['s-a', 's-b'])
    assert.match(a!.draft.behaviour, /scrolled 7\.0× the visible height in Item list with 8 direction reversals/)
    assert.ok(!/(\d[^–]*)–\1/.test(a!.draft.behaviour), 'no "x–x" ranges')
})

test('inputs the page sets by script (no prior focus on the field) are not user edits: no D5, no "edited 226 fields"', () => {
    // Shape of ERPNext session 01a219d9-…: ~226 rrweb inputs within 1 s of opening a new form, none preceded by a
    // click or focus on the field, then the user leaves to Customer (list). Before the fix this was a D5 with 226 edits.
    const scripted = Array.from({ length: 226 }, (_, i) => ({ offset_ms: 700 + i * 4, kind: 'input_activity' as const, label: i % 2 ? 'Item' : 'Qty', node_id: 5000 + i, scripted: true }))
    const t = tl([nav(0, 'sales invoice:new'), ...scripted, nav(3200, 'customer:list'), click(4000, 'Customer')])
    assert.ok(!detectCandidates(t).some((c) => c.kind === 'D5'))
    // The same exit after one real edit (focus, then input on that field) is an abandonment with exactly one edit.
    const t2 = tl([nav(0, 'sales invoice:new'), ...scripted, edit(2000, 'Customer'), nav(3200, 'customer:list'), click(4000, 'Customer')])
    const d5 = detectCandidates(t2).find((c) => c.kind === 'D5')
    assert.equal(d5?.facts.edits, 1)
    assert.equal(d5?.element, 'Customer')
})
