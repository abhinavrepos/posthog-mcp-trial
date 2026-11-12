import test from 'node:test'
import { gzipSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { safeName, signalsFromReplay } from '../src/core/replaysignals.ts'

const element = (id: number, tagName: string, attributes: Record<string, unknown> = {}, childNodes: unknown[] = []) => ({ id, type: 2, tagName, attributes, childNodes })
const event = (timestamp: number, type: number, data: unknown) => ['', { timestamp, type, data }]
const inc = (t: number, source: number, data: object = {}) => event(t, 3, { source, ...data })
const click = (t: number, id = 2) => inc(t, 2, { type: 2, id })
const full = () => event(0, 2, { node: element(1, 'form', {}, [element(2, 'button', { 'data-action': 'save', type: 'submit' }, [element(4, 'span')]), element(3, 'input', { 'data-field': 'notional' })]) })
const jsonl = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n')
const run = (...events: unknown[]) => signalsFromReplay(jsonl(events), undefined, { names: ['notional'] })
const meta = (t: number) => event(t, 4, { href: 'https://example.com/trades?secret=hidden' })
const error = (t: number, id = 8) => inc(t, 0, { adds: [{ parentId: 1, node: element(id, 'div', { role: 'alert' }) }] })

test('safeName accepts structural identifiers and rejects sensitive or free-form names', () => {
    for (const s of ['save', 'trade-date', 'field_12', 'button', 'alert']) assert.equal(safeName(s), s)
    for (const s of [null, 12, '', ' ', 'x'.repeat(41), 'trade123', 'USD', 'eur-value', '£rate', 'a@b.test', '4.6692%', '1,23', 'Zanthor Capital']) assert.equal(safeName(s), undefined)
})

test('clicks, rage, dead clicks and named ancestor resolution', () => {
    const s = run(full(), click(100, 4), click(200, 4), click(300, 4), click(400, 3), meta(2000))
    assert.equal(s.clicks, 4)
    assert.deepEqual(s.rage_clicks, [{ target: 'span#save', count: 3, at_ms: 100 }])
    assert.equal(s.dead_clicks.length, 3)
    assert.equal(run(full(), click(100), inc(200, 0, { texts: [{ id: 99, value: 'never read' }] }), meta(2000)).dead_clicks.length, 0)
    assert.equal(run(full(), click(100), meta(900), meta(2000)).dead_clicks.length, 0)
})

test('errors, repeated edit-submit loops, focus duration and input counts', () => {
    const s = run(full(), inc(100, 2, { type: 5, id: 3 }), click(200), error(300), inc(400, 5, { id: 3, text: 'ignored' }), click(500), error(600, 9), inc(700, 5, { id: 3 }), click(800), inc(900, 2, { type: 6, id: 3 }), meta(2000))
    assert.equal(s.errors_shown.length, 2)
    assert.deepEqual(s.error_loops, [{ field: 'field:notional', count: 2 }])
    assert.deepEqual(s.fields, [{ field: 'field:notional', edits: 2, focus_count: 1, ms: 800 }])
})

test('mutation attributes, added descendants, removals and full snapshot reset', () => {
    const s = run(full(), inc(10, 0, { adds: [{ parentId: 2, node: element(10, 'span') }] }), click(20, 10), inc(30, 0, { attributes: [{ id: 2, attributes: { 'data-action': 'run', class: 'invalid' } }] }), click(40, 10), inc(50, 0, { removes: [{ id: 2 }] }), click(60, 10), meta(2000))
    assert.equal(s.errors_shown.length, 1)
    assert.deepEqual(s.dead_clicks.map(c => c.target), ['element'])
    assert.equal(run(full(), event(10, 2, { node: element(1, 'div') }), click(20), meta(2000)).dead_clicks[0].target, 'element')
})

test('hesitation, cursor circling, scroll hunting and idle time', () => {
    const moves = Array.from({ length: 11 }, (_, i) => inc(8100 + i * 100, 1, { positions: [{ x: i % 2 ? 10 : 0, y: 0, timeOffset: 0 }] }))
    const scrolls = Array.from({ length: 7 }, (_, i) => inc(10000 + i * 100, 3, { id: 1, x: 0, y: i % 2 ? 100 : 0 }))
    const s = run(full(), ...moves, click(9500), ...scrolls, meta(30000))
    assert.equal(s.hesitations.length, 1)
    assert.equal(s.cursor.circling_bursts, 1)
    assert.equal(s.cursor.px_per_min, 200)
    assert.equal(s.cursor.direction_changes_per_min, 18)
    assert.equal(s.scroll.px, 600)
    assert.equal(s.scroll.reversals, 5)
    assert.equal(s.scroll.hunting_bursts, 1)
    assert.equal(s.idle_ms, 19400)
    assert.equal(s.active_ms + s.idle_ms, s.duration_ms)
})

const network = (t: number, requests: object[]) => event(t, 6, { plugin: 'rrweb/network@1', payload: { requests } })
test('network uses replaynet filtering and deduplication; console counts only errors', () => {
    const req = { name: 'https://example.com/api/trade/90210?private=value', method: 'POST', startTime: 200, timeOrigin: 0, duration: 6000, status: 500 }
    const s = run(full(), click(100), network(5000, [{ ...req, timestamp: undefined, startTime: 200, timeOrigin: 1 }, { name: '/x.js', status: 500 }]), network(5000, [{ ...req, startTime: 200, timeOrigin: 1 }]), event(5500, 6, { plugin: 'rrweb/console@1', payload: { level: 'error', trace: ['private'] } }), event(5600, 6, { plugin: 'rrweb/console@1', payload: { level: 'warn' } }), meta(7000))
    assert.equal(s.network_errors, 1)
    assert.equal(s.slow_calls, 1)
    assert.equal(s.console_errors, 1)
    assert.equal(s.dead_clicks.length, 0, 'delayed network record still cancels dead click by request start')
})

test('privacy: no canary survives any output channel', () => {
    const canaries = ['7,314,159.26', 'CAD 2,718,281', '4.6692%', 'Zanthor Capital', 'TRD-90210-77', 'private@example.com']
    for (const canary of canaries) {
        const attributes = Object.fromEntries(['id', 'name', 'role', 'type', 'data-testid', 'data-field', 'data-dialog', 'data-action', 'aria-label', 'value', 'title', 'placeholder', 'data-private'].map(k => [k, canary]))
        const s = run(event(0, 2, { node: element(1, 'div', {}, [element(2, 'button', attributes, [{ id: 9, type: 3, textContent: canary }]), element(3, 'input', attributes)]) }), click(100), inc(200, 5, { id: 3, text: canary }), inc(300, 2, { id: 3, type: 5 }), inc(400, 0, { adds: [{ node: element(10, 'div', { ...attributes, role: 'alert' }) }], texts: [{ id: 9, value: canary }] }), event(500, 4, { href: `https://example.com/${canary}?q=${canary}` }), event(600, 6, { plugin: 'rrweb/console@1', payload: { level: 'error', payload: [canary] } }), network(700, [{ name: `https://example.com/${canary}?q=${canary}`, duration: 6000, status: 500, requestBody: canary, responseBody: canary }]), meta(2000))
        assert.ok(!JSON.stringify(s).includes(canary), canary)
    }
})

test('empty, malformed and separate windows', () => {
    assert.equal(signalsFromReplay('').duration_ms, 0)
    assert.equal(signalsFromReplay('bad\nnull\n').clicks, 0)
    const other = ['other', { timestamp: 100, type: 3, data: { source: 2, type: 2, id: 2 } }]
    assert.equal(run(full(), other, meta(2000)).dead_clicks[0].target, 'element')
})

test('20,000 JSONL lines process in under one second', () => {
    const fixture = jsonl([full(), ...Array.from({ length: 19999 }, (_, i) => inc(i + 1, 1, { positions: [{ x: i, y: 0 }] }))])
    const start = performance.now()
    const s = signalsFromReplay(fixture)
    const elapsed = performance.now() - start
    assert.equal(s.duration_ms, 19999)
    assert.ok(elapsed < 1000, `${elapsed.toFixed(1)} ms`)
    console.log(`20,000 lines: ${elapsed.toFixed(1)} ms`)
})

 test('rage uses a rolling one-second window and does not combine distinct nodes', () => {
    assert.equal(run(full(), click(0), click(900), click(1100), click(1200), meta(3000)).rage_clicks.length, 1)
    assert.equal(run(full(), click(100, 2), click(200, 4), click(300, 2), meta(2000)).rage_clicks.length, 0)
})


test('PostHog compressed containers restore structure without exposing their content', () => {
    const pack = (v: unknown) => gzipSync(JSON.stringify(v)).toString('latin1')
    const s = run(event(0, 2, pack({ node: element(1, 'form', {}, [
        element(2, 'button', { 'data-action': 'save', type: 'submit' }),
        element(3, 'input', { 'data-field': 'notional', value: '7,314,159.26' }),
    ]) })), click(100, 3), click(200),
    inc(300, 0, { adds: pack([{ parentId: 1, node: element(8, 'div', { role: 'alert' }) }]), attributes: pack([]), removes: pack([]), texts: pack([]) }), meta(2000))
    assert.equal(s.errors_shown.length, 1)
    assert.equal(s.dead_clicks.length, 0)
    assert.ok(!JSON.stringify(s).includes('7,314,159.26'))
})

test('existing alert visibility and text mutation IDs trigger repeated errors', () => {
    const snapshot = event(0, 2, { node: element(1, 'form', {}, [
        element(2, 'button', { type: 'submit', id: 'save' }),
        element(3, 'input', { name: 'notional' }),
        element(8, 'div', { role: 'alert', class: 'error', hidden: '', 'aria-hidden': 'true', style: 'display:none' },
            [{ type: 3, id: 9, textContent: 'private' }]),
    ]) })
    const attr = (t: number, attributes: object) => inc(t, 0, { attributes: [{ id: 8, attributes }] })
    const s = run(snapshot, click(100), attr(200, { hidden: null }), attr(250, { 'aria-hidden': 'false' }),
        attr(300, { style: 'display:block' }), inc(400, 5, { id: 3 }), click(500),
        inc(600, 0, { texts: [{ id: 9, value: 'private again' }] }), inc(700, 5, { id: 3 }), click(800),
        attr(900, { class: 'error' }), meta(2000))
    assert.deepEqual(s.errors_shown.map(e => e.at_ms), [300, 600, 900])
    assert.deepEqual(s.error_loops, [{ field: 'field:notional', count: 2 }])
    assert.equal(s.dead_clicks.length, 0)
})

test('sampled curved paths reverse individual axes; small jitter does not circle', () => {
    const path = Array.from({ length: 49 }, (_, i) => ({
        x: Math.round(100 * Math.cos(i * Math.PI / 6)), y: Math.round(100 * Math.sin(i * Math.PI / 6)),
        timeOffset: -2400 + i * 50,
    }))
    assert.ok(run(full(), inc(3000, 1, { positions: path }), meta(4000)).cursor.circling_bursts >= 1)
    const jitter = path.map((p, i) => ({ ...p, x: i % 2, y: 0 }))
    assert.equal(run(full(), inc(3000, 1, { positions: jitter }), meta(4000)).cursor.circling_bursts, 0)
})

test('idle tails require observed duration; quiet gaps between inputs count without heartbeat events', () => {
    const recording = jsonl([full(), click(100), inc(1000, 5, { id: 3 })])
    assert.equal(signalsFromReplay(recording).idle_ms, 0, 'unknown tail cannot be inferred')
    const s = signalsFromReplay(recording, 51000)
    assert.equal(s.idle_ms, 50000)
    assert.equal(s.duration_ms, 51000)
    assert.equal(run(full(), click(100), click(50100), meta(52000)).idle_ms, 50000)
})


test('initial quiet time is excluded only with explicit page-load evidence', () => {
    assert.equal(run(full(), click(20000), meta(21000)).idle_ms, 20000)
    assert.equal(run(full(), event(10, 1, {}), click(20000), meta(21000)).idle_ms, 0)
})

test('names require explicit membership with normalized token comparison', () => {
    const recording = jsonl([event(0, 2, { node: element(1, 'form', {}, [
        element(2, 'button', { id: 'ZanthorCapital' }),
        element(3, 'input', { 'data-field': 'counterparty' }),
    ]) }), click(100), inc(200, 5, { id: 3 }), meta(2000)])
    const generic = signalsFromReplay(recording)
    assert.equal(generic.dead_clicks[0].target, 'button')
    assert.equal(generic.fields[0].field, 'field')
    const named = signalsFromReplay(recording, undefined, { names: new Set(['ＺＡＮＴＨＯＲ\u200bＣＡＰＩＴＡＬ', 'Counter Party']) })
    // The output carries the reviewed list's spelling, never the page's own text.
    assert.equal(named.dead_clicks[0].target, 'button#ZANTHORCAPITAL')
    assert.equal(named.fields[0].field, 'field:Counter-Party')
})

test('safeName normalizes format characters and rejects Unicode digit runs and decimals', () => {
    assert.equal(safeName('ｓａ\u200bｖｅ'), 'save')
    for (const value of ['trade-１２３４５', 'trade-١٢٣٤٥', 'rate-４．６６９２', 'rate-١,٢', 'trade-1٢३']) {
        assert.equal(safeName(value), undefined, value)
    }
})
