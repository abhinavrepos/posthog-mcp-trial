import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
const engine = createRequire(import.meta.url)('../deploy/posthog/survey-engine/engine.js')
const chain = { version: 3, id: 'feedback', steps: [{ event: 'Open' }, { event: 'Save' }],
    audience: { clients: ['ACME'], distinctIdPart: 1, separator: '|' }, ready: { maxWaitMs: 1000 } }
const survey = { id: 'survey-a', start_date: '2026-11-01T00:00:00Z', end_date: null, conditions: { lensChain: chain } }
const ev = (event: string) => ({ event, properties: {} })

test('archived surveys invalidate pending chains even when PostHog retains their start_date', () => {
    const m = engine.createMachine(); m.setSurveys([survey])
    m.consume(ev('Open'), 1, 'ACME|ann')
    const [completion] = m.consume(ev('Save'), 2, 'ACME|ann')
    assert.ok(completion)
    m.setSurveys([{ ...survey, archived: true }])
    assert.equal(m.pending(completion.id, completion.token), false)
    assert.equal(m.info(chain.id), null)
})

test('a different user cannot complete the previous user chain', () => {
    const m = engine.createMachine(); m.setSurveys([survey])
    m.consume(ev('Open'), 1, 'ACME|ann')
    assert.deepEqual(m.consume(ev('Save'), 2, 'ACME|bob'), [])
    m.consume(ev('Open'), 3, 'ACME|bob')
    assert.equal(m.consume(ev('Save'), 4, 'ACME|bob').length, 1)
})

function browser(t: TestContext, ready = 'complete', input = survey) {
    let who = 'ACME|ann', now = 1000000000
    let listener: (event: unknown) => void = () => {}
    const timers: { callback: () => void; ms: number }[] = [], captured: string[] = []
    const storage = new Map<string, string>()
    const root = { __PosthogExtensions__: { generateSurveys: (_instance: unknown) => {} }, document: { readyState: ready, querySelectorAll: () => [] },
        localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
        setTimeout: (callback: () => void, ms: number) => timers.push({ callback, ms }) }
    const instance = { on: (_name: string, callback: typeof listener) => { listener = callback },
        getSurveys: (callback: (s: unknown[]) => void) => callback([input]), get_distinct_id: () => who,
        capture: (name: string) => captured.push(name) }
    t.mock.method(Date, 'now', () => now)
    engine.install(root); root.__PosthogExtensions__.generateSurveys(instance)
    return { root, captured, emit: (event: string) => listener(ev(event)), identify: (id: string) => { who = id },
        tick: (ms: number) => { now += ms; const at = timers.findIndex(timer => timer.ms < 60000); assert.ok(at >= 0); timers.splice(at, 1)[0].callback() } }
}

test('a survey waiting for page readiness cannot fire after the browser changes to an excluded client', (t) => {
    const b = browser(t, 'loading')
    b.emit('Open'); b.emit('Save'); b.tick(0)
    b.identify('BETA|bob'); b.root.document.readyState = 'complete'; b.tick(100)
    assert.deepEqual(b.captured, [])
})

test('max_wait_seconds zero still shows a survey when the page is already ready', (t) => {
    const b = browser(t, 'complete', { ...survey, conditions: { lensChain: { ...chain, ready: { maxWaitMs: 0 } } } })
    b.emit('Open'); b.emit('Save'); b.tick(1)
    assert.deepEqual(b.captured, ['lens_chain:feedback'])
})
