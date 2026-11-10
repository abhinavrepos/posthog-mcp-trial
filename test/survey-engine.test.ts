// The Lens survey engine (deploy/posthog/survey-engine): the chain state machine that runs in Reval's
// browser, and the build that patches PostHog's survey renderer. Browser behaviour is covered by the
// stress test (deploy/posthog/survey-engine/stress).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

const dir = 'deploy/posthog/survey-engine'
const engine = createRequire(import.meta.url)(`../${dir}/engine.js`)
const ex = (...values: string[]) => ({ operator: 'exact', values })
const open = (d: string) => ({ event: 'PageView', properties: { dialog_id: ex(d), action: ex('OPEN') } })
const save = (d: string) => ({ event: 'Event', properties: { dialog_id: ex(d), action_name: ex('Save') } })
const chain = (id: string, steps: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, id, steps, ...extra })
const survey = (lensChain: unknown, extra: Record<string, unknown> = {}) => ({ start_date: '2026-11-10T00:00:00Z', end_date: null, conditions: { lensChain }, ...extra })
const ev = (event: string, properties: Record<string, unknown>) => ({ event, properties })

function machine(...surveys: unknown[]) {
    const m = engine.createMachine()
    m.setSurveys(surveys)
    return m
}
const ids = (done: { id: string }[]) => done.map((d) => d.id)

describe('chains', () => {
    const three = chain('acme-3step', [open('DlgA'), save('DlgA'), open('DlgZ')], { resetOn: [{ event: 'PageView', properties: { dialog_id: ex('DlgA'), action: ex('CLOSE') } }] })
    test('in order completes, once', () => {
        const m = machine(survey(three))
        assert.deepEqual(ids(m.consume(ev('PageView', { dialog_id: 'DlgA', action: 'OPEN' }), 1)), [])
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgN', action: 'Trade Date' }), 2)), [], 'other events in between are fine')
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgA', action_name: 'Save' }), 3)), [])
        const done = m.consume(ev('PageView', { dialog_id: 'DlgZ', action: 'OPEN' }), 4)
        assert.deepEqual(ids(done), ['acme-3step'])
        assert.equal(m.pending('acme-3step', done[0].token), true)
        assert.equal(m.finish('acme-3step', done[0].token), true)
        assert.equal(m.finish('acme-3step', done[0].token), false, 'finishing twice does nothing')
    })
    test('out of order does not complete', () => {
        const m = machine(survey(three))
        m.consume(ev('PageView', { dialog_id: 'DlgA', action: 'OPEN' }), 1)
        m.consume(ev('PageView', { dialog_id: 'DlgZ', action: 'OPEN' }), 2)
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgA', action_name: 'Save' }), 3)), [])
    })
    test('resetOn starts over', () => {
        const m = machine(survey(three))
        m.consume(ev('PageView', { dialog_id: 'DlgA', action: 'OPEN' }), 1)
        m.consume(ev('Event', { dialog_id: 'DlgA', action_name: 'Save' }), 2)
        m.consume(ev('PageView', { dialog_id: 'DlgA', action: 'CLOSE' }), 3)
        assert.deepEqual(ids(m.consume(ev('PageView', { dialog_id: 'DlgZ', action: 'OPEN' }), 4)), [])
    })
    test('withinSeconds expires a slow chain', () => {
        const m = machine(survey(chain('timed', [open('DlgB'), { event: 'Event', properties: { dialog_id: ex('DlgB'), action_name: ex('Run') } }], { withinSeconds: 8 })))
        m.consume(ev('PageView', { dialog_id: 'DlgB', action: 'OPEN' }), 0)
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgB', action_name: 'Run' }), 9000)), [])
        m.consume(ev('PageView', { dialog_id: 'DlgB', action: 'OPEN' }), 10000)
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgB', action_name: 'Run' }), 12000)), ['timed'])
    })
    test('a pending chain ignores further events until finished', () => {
        const m = machine(survey(chain('one', [save('DlgC')])))
        const first = m.consume(ev('Event', { dialog_id: 'DlgC', action_name: 'Save' }), 1)
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgC', action_name: 'Save' }), 2)), [])
        m.finish('one', first[0].token)
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgC', action_name: 'Save' }), 3)), ['one'])
    })
    test('two surveys sharing a chain emit once', () => {
        const m = machine(survey(chain('shared', [save('DlgC')])), survey(chain('shared', [save('DlgC')])))
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgC', action_name: 'Save' }), 1)), ['shared'])
    })
    test('several chains advance independently', () => {
        const m = machine(survey(chain('a', [open('DlgA'), save('DlgA')])), survey(chain('b', [save('DlgA')])))
        m.consume(ev('PageView', { dialog_id: 'DlgA', action: 'OPEN' }), 1)
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgA', action_name: 'Save' }), 2)).sort(), ['a', 'b'])
    })
    test('stopped, unlaunched and invalid surveys are ignored', () => {
        const m = machine(
            survey(chain('stopped', [save('DlgC')]), { end_date: '2026-11-10T00:00:00Z' }),
            survey(chain('draft', [save('DlgC')]), { start_date: null }),
            survey(chain('BAD ID', [save('DlgC')])),
            survey(chain('nosteps', [])),
            survey({ version: 4, id: 'v4', steps: [save('DlgC')] }),
            survey(chain('badop', [{ event: 'Event', properties: { dialog_id: { operator: 'gt', values: ['1'] } } }]))
        )
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgC', action_name: 'Save' }), 1)), [])
    })
})

describe('matching', () => {
    test('messages arrive as arrays: regex matches the text', () => {
        const m = machine(survey(chain('msg', [{ event: 'Event', properties: { dialog_id: ex('toast'), action_name: { operator: 'regex', values: ['^Link Id [0-9]+ Added$'] } } }])))
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'toast', action_name: ['Trade Id 4348 Updated'] }), 1)), [])
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'toast', action_name: ['Link Id 3508 Added'] }), 2)), ['msg'])
    })
    test('is_not, icontains and not_icontains', () => {
        const m = machine(
            survey(chain('isnot', [{ event: 'Event', properties: { dialog_id: { operator: 'is_not', values: ['DlgX'] } } }])),
            survey(chain('contains', [{ event: 'Event', properties: { action_name: { operator: 'icontains', values: ['export'] } } }])),
            survey(chain('notcontains', [{ event: 'Event', properties: { action_name: { operator: 'not_icontains', values: ['xls'] } } }]))
        )
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgX', action_name: 'XLS Export' }), 1)), ['contains'])
    })
    test('risky regular expressions are refused, not run', () => {
        assert.equal(engine.normalizeChain(chain('evil', [{ event: 'Event', properties: { a: { operator: 'regex', values: ['(a+)+$'] } } }])), null)
        assert.equal(engine.normalizeChain(chain('evil2', [{ event: 'Event', properties: { a: { operator: 'regex', values: ['a*b*c*'] } } }])), null)
    })
    test('garbage never throws', () => {
        const m = machine(survey(chain('g', [save('DlgC')])), null, 42, 'x', { conditions: null }, { start_date: 'x', end_date: null, conditions: { lensChain: { version: 1, id: 'h', steps: [null] } } })
        for (const e of [null, undefined, 1, 'x', [], {}, { event: 5 }, { event: 'Event', properties: null }, { event: 'Event', properties: { dialog_id: { deep: [1, { x: 2 }] } } },
            { event: 'Event', properties: { dialog_id: 'x'.repeat(100000), action_name: 'Save' } }, { event: 'Event', properties: { dialog_id: ['DlgC'], action_name: ['Save'] } }])
            assert.doesNotThrow(() => m.consume(e, 1))
        assert.doesNotThrow(() => m.setSurveys('nonsense'))
        assert.doesNotThrow(() => engine.createMachine().consume({ event: 'Event' }, NaN))
    })
    test('audience from the user id: only the listed clients, without case', () => {
        const m = machine(survey(chain('acme-only', [save('DlgC')], { audience: { clients: ['ACME'], distinctIdPart: 3, separator: '|' } })))
        const e = ev('Event', { dialog_id: 'DlgC', action_name: 'Save' })
        assert.deepEqual(ids(m.consume(e, 1, 'C1|01|BETA|bob')), [])
        assert.deepEqual(ids(m.consume(e, 2, undefined)), [])
        assert.deepEqual(ids(m.consume(e, 3, 'C1|01|acme|ann')), ['acme-only'])
    })
    test('audience from an event property', () => {
        const m = machine(survey(chain('prop', [save('DlgC')], { audience: { clients: ['42'], eventProperty: 'client_id' } })))
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgC', action_name: 'Save', client_id: 7 }), 1)), [])
        assert.deepEqual(ids(m.consume(ev('Event', { dialog_id: 'DlgC', action_name: 'Save', client_id: 42 }), 2)), ['prop'])
    })
    test('an invalid audience refuses the chain', () => {
        for (const audience of [{}, { clients: [] }, { clients: ['A'] }, { clients: ['A'], distinctIdPart: 0 }, { clients: ['A'], distinctIdPart: 3, separator: '||' }, { clients: [{}], eventProperty: 'x' }])
            assert.equal(engine.normalizeChain(chain('x', [save('DlgC')], { audience })), null, JSON.stringify(audience))
    })
    test('sample: a fixed share of users, the same users every time', () => {
        const m = machine(survey(chain('third', [save('DlgC')], { version: 3, audience: { sample: 33 } })))
        const e = ev('Event', { dialog_id: 'DlgC', action_name: 'Save' })
        const ids_ = Array.from({ length: 3000 }, (_, i) => `C1|01|ACME|u${i}`)
        const fire = (mm: typeof m, u: string, i: number) => { const d = mm.consume(e, i, u); d.forEach((x: { id: string; token: number }) => mm.finish(x.id, x.token)); return d.length > 0 }
        const hit = ids_.filter((u, i) => fire(m, u, i))
        assert.ok(hit.length > 850 && hit.length < 1150, `${hit.length} of 3000`)
        const again = engine.createMachine()
        again.setSurveys([survey(chain('third', [save('DlgC')], { version: 3, audience: { sample: 33 } }))])
        assert.deepEqual(ids_.filter((u, i) => fire(again, u, i)), hit, 'stable per user')
        assert.equal(engine.normalizeChain(chain('x', [save('DlgC')], { audience: { sample: 33 } })), null, 'sample needs version 3')
    })
    test('one survey at a time: the earlier launched survey keeps its users until they finish it', () => {
        const one = (id: string, start: string, audience?: unknown) => survey(chain(id, [save('DlgC')], { version: 3, oneAtATime: true, ...(audience ? { audience } : {}) }), { id: `s-${id}`, start_date: start })
        const m = machine(one('first', '2026-11-01T00:00:00Z', { clients: ['ACME'], distinctIdPart: 3 }), one('second', '2026-11-05T00:00:00Z'))
        const e = ev('Event', { dialog_id: 'DlgC', action_name: 'Save' })
        const done = (d: { id: string; token: number }[]) => (d.forEach((x) => m.finish(x.id, x.token)), ids(d))
        // ACME users belong to "first": "second" skips them; BETA users get "second".
        assert.deepEqual(done(m.consume(e, 1, 'C1|01|ACME|ann', () => false)), ['first'])
        assert.deepEqual(done(m.consume(e, 2, 'C1|01|BETA|bob', () => false)), ['second'])
        // Once ann answered or dismissed "first", she is free for "second".
        // ("first" completes too, but PostHog does not show a survey she has already seen.)
        assert.deepEqual(done(m.consume(e, 3, 'C1|01|ACME|ann', (id: string) => id === 's-first')).sort(), ['first', 'second'])
    })
    test('at most two surveys per user: a third waits until the user finishes one, then comes back', () => {
        const lim = (id: string, start: string) => survey(chain(id, [save('DlgC')], { version: 3, maxPerUser: 2 }), { id: `s-${id}`, start_date: start })
        const m = machine(lim('a', '2026-11-01T00:00:00Z'), lim('b', '2026-11-02T00:00:00Z'), lim('c', '2026-11-03T00:00:00Z'))
        const e = ev('Event', { dialog_id: 'DlgC', action_name: 'Save' })
        const go = (seen: string[]) => { const d = m.consume(e, 1, 'C1|01|ACME|ann', (id: string) => seen.includes(id)); d.forEach((x: { id: string; token: number }) => m.finish(x.id, x.token)); return ids(d).sort() }
        assert.deepEqual(go([]), ['a', 'b'], 'c waits: ann already has a and b')
        assert.deepEqual(go(['s-a']), ['a', 'b', 'c'], 'after finishing a, c comes back for her')
        assert.equal(engine.normalizeChain(chain('x', [save('DlgC')], { version: 3, maxPerUser: 0 })), null)
        assert.equal(engine.normalizeChain(chain('x', [save('DlgC')], { version: 2, maxPerUser: 2 })), null)
    })
    test('its own events and PostHog events are ignored', () => {
        const m = machine(survey(chain('own', [{ event: 'lens_chain:own' }])))
        assert.deepEqual(ids(m.consume(ev('lens_chain:own', {}), 1)), [])
    })
})

describe('build', () => {
    const out = mkdtempSync(join(tmpdir(), 'lens-engine-'))
    after(() => rmSync(out, { recursive: true, force: true }))
    const original = `${dir}/fixtures/surveys-1.443.0.original.js`
    test('patches the footer, appends the engine, keeps the licence and writes matching compressed copies', () => {
        execFileSync('node', [`${dir}/build.mjs`, original, out, 'Survey by ION'], { stdio: 'pipe' })
        const js = readFileSync(join(out, 'surveys.js'))
        const text = js.toString()
        assert.match(text, /^\/\*! Survey renderer from posthog-js \(Copyright PostHog Inc\., Apache License 2\.0/)
        assert.match(text, /Modified by ION for Reval/)
        assert.ok(text.includes('children:"Survey by ION"'))
        assert.ok(!text.includes('posthog.com/surveys'))
        assert.ok(text.includes('Lens survey chains'))
        assert.ok(brotliDecompressSync(readFileSync(join(out, 'surveys.js.br'))).equals(js))
        assert.ok(gunzipSync(readFileSync(join(out, 'surveys.js.gz'))).equals(js))
        assert.doesNotThrow(() => new Function(text))
        const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
        assert.equal(manifest.brand, 'Survey by ION')
    })
    test('refuses a file it does not recognise, and an already patched one', () => {
        assert.throws(() => execFileSync('node', [`${dir}/build.mjs`, `${dir}/engine.js`, out], { stdio: 'pipe' }))
        assert.throws(() => execFileSync('node', [`${dir}/build.mjs`, join(out, 'surveys.js'), join(out, 'again')], { stdio: 'pipe' }))
    })
})
