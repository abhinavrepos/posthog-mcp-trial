import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { signalsFromReplay } from '../src/core/replaysignals.ts'

const ev = (timestamp: number, type: number, data: object, window = 'a') => [window, { timestamp, type, data }]
const el = (id: number, tagName: string, attributes = {}, childNodes: unknown[] = []) => ({ id, type: 2, tagName, attributes, childNodes })
const inc = (t: number, source: number, data = {}, window = 'a') => ev(t, 3, { source, ...data }, window)
const full = (t = 0, hidden = false, delta = 0) => ev(t, 2, { node: el(1 + delta, 'form', {}, [
    el(2 + delta, 'button', { id: 'save' }), el(3 + delta, 'input'),
    el(4 + delta, 'div', hidden ? { style: 'display:none' } : {}, [el(5 + delta, 'div', { role: 'alert' }, [el(6 + delta, 'span', { class: 'error' })])]),
]) })
const lines = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n')
const run = (events: unknown[], duration = 10000) => signalsFromReplay(lines(events), duration)
const fixture = (name: string) => readFileSync(new URL(`./fixtures/replay/${name}.jsonl`, import.meta.url), 'utf8')
const real = (name: string, duration: number) => signalsFromReplay(fixture(name), duration, { names: ['counterparty', 'dead'] })

test('real rage-dead: Save burst is not dead; unrelated toast expiry cannot cancel Preview', () => {
    const s = real('rage-dead', 70005)
    assert.deepEqual(s.rage_clicks.map(r => [r.target, r.count]), [['button#save', 4]])
    assert.deepEqual(s.dead_clicks, [{ target: 'button#dead', at_ms: 9009 }])
})

test('real error-looping: four failed submissions and three failed retries, no dead clicks', () => {
    const s = real('error-looping', 70003)
    assert.equal(s.errors_shown.length, 4)
    assert.deepEqual(s.error_loops, [{ field: 'field:counterparty', count: 3 }])
    assert.equal(s.dead_clicks.length, 0)
    // Stop before the final reply: a submitted retry is not yet another failed retry.
    const events = fixture('error-looping').trim().split('\n').map(s => JSON.parse(s))
    const start = events[0][1].timestamp
    const pending = signalsFromReplay(lines(events.filter(e => e[1].timestamp - start < 12255)), 12254, { names: ['counterparty'] })
    assert.deepEqual(pending.error_loops, [{ field: 'field:counterparty', count: 2 }])
})

test('real idle: quiet tail and a loaded page without interaction are idle', () => {
    assert.equal(real('idle', 70003).idle_ms, 68614)
    const prefix = fixture('idle').trim().split('\n').map(s => JSON.parse(s)).filter(e => e[1].type !== 3)
    const start = prefix[0][1].timestamp
    const s = signalsFromReplay(lines([...prefix, ev(start + 25, 1, {})]), 60000)
    assert.equal(s.idle_ms, 60000)
    assert.equal(s.active_ms, 0)
})

test('hidden ancestors suppress errors and visibility changes update descendants', () => {
    const show = inc(100, 0, { attributes: [{ id: 4, attributes: { style: 'display:block' } }] })
    const hide = inc(200, 0, { attributes: [{ id: 4, attributes: { 'aria-hidden': 'true' } }] })
    assert.equal(run([full(0, true)]).errors_shown.length, 0)
    assert.deepEqual(run([full(0, true), show, hide]).errors_shown.map(e => e.at_ms), [100])
})

test('checkpoint snapshots and nested error classes do not repeat persistent errors', () => {
    const s = run([full(), full(1000), full(2000, false, 100)])
    assert.equal(s.errors_shown.length, 1)
})

test('successful and pending retries do not count as error loops', () => {
    const base = [full(0, true), inc(100, 2, { type: 2, id: 2 }), inc(200, 0, { attributes: [{ id: 4, attributes: { style: null } }] }),
        inc(300, 5, { id: 3 }), inc(400, 2, { type: 2, id: 2 }), inc(500, 0, { attributes: [{ id: 5, attributes: { class: 'error' } }] }),
        inc(600, 5, { id: 3 }), inc(700, 2, { type: 2, id: 2 })]
    assert.deepEqual(run(base).error_loops, [{ field: 'field', count: 1 }])
    assert.deepEqual(run([...base, inc(800, 0, { removes: [{ id: 4 }] })]).error_loops, [{ field: 'field', count: 1 }])
})

test('another window cannot cancel dead clicks; removing the clicked dialog can', () => {
    const s = run([full(0, true), inc(100, 2, { type: 2, id: 2 }), ev(200, 2, { node: el(1, 'div') }, 'b')])
    assert.deepEqual(s.dead_clicks, [{ target: 'button#save', at_ms: 100 }])
    assert.equal(run([full(0, true), inc(100, 2, { type: 2, id: 2 }), inc(200, 0, { removes: [{ id: 1 }] })]).dead_clicks.length, 0)
})

test('slow failures count once and distinct templated requests survive across plugin events', () => {
    const request = (name: string, startTime: number, status: number) => ({ name, timeOrigin: 1, startTime, duration: 6000, status })
    const a = request('/api/trades/1234', 100, 200), b = request('/api/trades/5678', 110, 500)
    const network = (t: number, requests: object[]) => ev(t, 6, { plugin: 'rrweb/network@1', payload: { requests } })
    const s = run([network(0, [a]), network(10, [b]), network(20, [a, b])])
    assert.equal(s.network_errors, 1)
    assert.equal(s.slow_calls, 1)
    assert.equal(s.network_errors + s.slow_calls, 2)
})

test('unordered snapshot lines produce the same idle, rage and offsets as chronological input', () => {
    const events = [full(0, true), ...[10, 20, 30, 40, 50, 60, 61].map(t => inc(t * 1000, 5, { id: 3 }))]
    const shuffled = [events[6], events[0], events[1], events[2], events[3], events[4], events[5], events[7]]
    assert.deepEqual(run(shuffled, 61000), run(events, 61000))
    assert.equal(run(shuffled, 61000).idle_ms, 0)
})
