import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generate, snapshot, complete, decodeSnapshots } from './record-replays.ts'

test('fixed seed yields deterministic, varied and mapped sessions', () => {
    const m = generate(42, 'http://localhost', 270001, 1_800_000_000_000)
    assert.deepEqual(m, generate(42, 'http://localhost', 270001, 1_800_000_000_000))
    assert.equal(m.sessions.length, 60)
    assert.equal(new Set(m.sessions.map(s => s.session_id)).size, 60)
    assert.equal(new Set(m.sessions.map(s => s.client)).size, 10)
    assert.deepEqual(new Set(m.sessions.map(s => s.outcome)), new Set(['success', 'error', 'retry', 'abandoned']))
    assert(m.sessions.some(s => s.client === 'SEM' && s.user === 'SEMOPS'))
    for (const code of ['RIB', 'TR01']) assert(m.sessions.some(s => s.client === code))
    const screens = new Set(m.sessions.flatMap(s => s.screens))
    assert.equal(screens.size, 16)
    assert(screens.has('Cash Positions') && screens.has('Amortization Report'))
    for (const s of m.sessions) {
        assert.match(s.distinct_id, /^C1DEV\|01\|[A-Z0-9]+\|[A-Z0-9]+$/)
        assert(s.events.every(e => e.properties.$session_id === s.session_id && e.distinct_id === s.distinct_id && !('client_id' in e.properties)))
        assert(s.rrweb.every((e,i) => i === 0 || e.timestamp >= s.rrweb[i-1].timestamp))
        assert(s.rrweb.some(e => e.type === 2))
        assert(s.rrweb.some(e => e.type === 3 && e.data.source === 0))
        assert(s.rrweb.some(e => e.type === 3 && e.data.source === 1))
        assert(s.rrweb.some(e => e.type === 3 && e.data.source === 2))
        assert(s.events.some(e => e.event === 'PageView' && e.properties.action === 'OPEN'))
    }
})

test('full snapshot contains screen title and valid unique DOM references', () => {
    const s = snapshot('Cash Positions', 1000)
    const ids = new Set<number>()
    const walk = (node: unknown) => {
        const n = node as { id: number; childNodes?: unknown[] }
        assert(!ids.has(n.id)); ids.add(n.id)
        n.childNodes?.forEach(walk)
    }
    walk(s.events[1].data.node)
    assert(ids.has(s.button) && ids.has(s.status) && ids.has(s.body))
    assert(JSON.stringify(s.events).includes('Cash Positions'))
})

test('readback accepts API tuples and rejects missing or duplicated events', () => {
    const expected = snapshot('Cash Positions',1000).events
    const text = JSON.stringify(['window', expected])+'\n'
    assert(complete(expected,decodeSnapshots(text)))
    assert(complete(expected,decodeSnapshots(JSON.stringify({data:expected}))))
    assert(!complete(expected,expected.slice(1)))
    assert(!complete(expected,[expected[0],expected[0]]))
    assert(!complete(expected,[...expected,...expected]))
})
