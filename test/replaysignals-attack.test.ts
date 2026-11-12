import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeName, signalsFromReplay } from '../src/core/replaysignals.ts'

// Isolate consumer persistence from real databases, including when this file is run alone.
const dir = mkdtempSync(join(tmpdir(), 'replay-attack-'))
process.env.TRIAGE_DB = join(dir, 'lens.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.TRIAGE_ENV_FILE = join(dir, 'absent.env')
const { tasksDb } = await import('../src/core/tasks.ts')
const X = await import('../src/core/experience.ts')
after(() => { tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })
const el = (id: number, tagName = 'button', attributes: object = {}, childNodes: unknown[] = []) => ({ type: 2, id, tagName, attributes, childNodes })
const ev = (timestamp: number, type: number, data: unknown) => ['window', { timestamp, type, data }]
const inc = (t: number, source: number, data: object) => ev(t, 3, { source, ...data })
const full = (node: unknown) => ev(0, 2, { node })
const click = (t: number, id = 2) => inc(t, 2, { type: 2, id })
const tail = ev(10000, 4, { href: 'https://example.test/' })
const lines = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n')
const pack = (v: unknown) => gzipSync(JSON.stringify(v)).toString('latin1')
const compact = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{Cf}]/gu, '')
function absent(output: unknown, secrets: string[]) {
    const raw = JSON.stringify(output)
    const leaks = secrets.filter(s => raw.toLowerCase().includes(s.toLowerCase()) || compact(raw).includes(compact(s)))
    assert.deepEqual(leaks, [], `input=${JSON.stringify(secrets)}; output=${raw}`)
}
function attack(attrs: object = {}, tag = 'button') {
    return [full(el(1, 'form', {}, [el(2, tag, attrs), el(3, 'input', attrs)])),
        click(100), click(200), click(300), inc(400, 5, { id: 3, text: 'ignored' }), tail]
}
const canaries = ['notional-7314159', 'Zanthor Capital', 'TRD-90210-77', 'cad2718281', 'rate-4.6692',
    '7,314,159.26', 'CAD 2,718,281', 'private@example.com', '7 314 159,26', "7'314'159.26"]
const attrs = ['id', 'name', 'data-field', 'data-action', 'aria-label', 'role', 'type', 'data-testid', 'data-dialog']
for (const key of attrs) test(`attributes: ${key}, numeric/free-form canaries`, () => {
    for (const value of canaries) absent(signalsFromReplay(lines(attack({ [key]: value }))), [value])
})
for (const value of ['ZanthorCapital', 'zanthor_capital']) test(`counterparty identifier ${value}: all attribute paths`, () => {
    const outputs = attrs.map(key => signalsFromReplay(lines(attack({ [key]: value }))))
    absent(outputs, [value, 'Zanthor Capital'])
})
for (const value of ['ZanthorCapital', 'zanthor-capital', 'trade-１２３４５', 'trade-١٢٣٤٥']) test(`tag/custom element ${value}`, () => {
    absent(signalsFromReplay(lines(attack({}, value))), [value])
})
for (const value of ['trade-１２３４５', 'trade-١٢٣٤٥', 'rate-４．６６９２', 'Zan\u200bthorCapital']) test(`unicode attribute ${value}`, () => {
    absent(signalsFromReplay(lines(attack({ id: value }))), [value])
})
for (const value of ['7314159', '$cash', 'USDcash', 'eur', 'GBP', 'CAD', 'CHF', 'JPY', '€', '@private', '4.66', '1,23', 'x'.repeat(41)]) test(`safeName rejects ${value}`, () => {
    assert.equal(safeName(value), undefined)
})
// The spec says a *run* of 3+ digits, rather than any three digits anywhere.
test('safeName retains an ordinary short structural identifier', () => assert.equal(safeName('field_12'), 'field_12'))

test('text, typed values, forbidden attributes, adjacent text mutations', () => {
    for (const value of [...canaries, 'ZanthorCapital']) {
        const mid = Math.floor(value.length / 2)
        absent(signalsFromReplay(lines([full(el(1, 'form', {}, [el(2, 'button', { value, title: value, placeholder: value, style: value },
            [{ type: 3, id: 8, textContent: value }]), el(3, 'input')])),
            inc(10, 0, { texts: [{ id: 8, value: value.slice(0, mid) }] }),
            inc(20, 0, { texts: [{ id: 8, value: value.slice(mid) }] }),
            inc(30, 5, { id: 3, text: value }), click(100), click(200), click(300), tail])), [value])
    }
})
test('adjacent attribute mutations preserve sensitive fragments', () => {
    const events = [full(el(2)), inc(10, 0, { attributes: [{ id: 2, attributes: { id: 'Zanthor' } }] }),
        click(100), click(200), click(300), inc(400, 0, { attributes: [{ id: 2, attributes: { id: 'Capital' } }] }),
        click(1500), click(1600), click(1700), tail]
    absent(signalsFromReplay(lines(events)), ['Zanthor', 'Capital'])
})
test('ancestor resolution copies counterparty into child target', () => {
    absent(signalsFromReplay(lines([full(el(1, 'div', { id: 'ZanthorCapital' }, [el(2, 'span')])), click(100), click(200), click(300), tail])), ['ZanthorCapital'])
})
for (const value of [canaries[0], 'ZanthorCapital']) test(`gzip Latin-1 full snapshot ${value}`, () => {
    const events = attack({ id: value }); events[0] = ev(0, 2, pack({ node: el(1, 'div', {}, [el(2, 'button', { id: value })]) }))
    const s = signalsFromReplay(lines(events)); assert.equal(s.clicks, 3); assert.equal(s.rage_clicks.length, 1)
    absent(s, [value])
})
test('gzip Latin-1 mutation containers', () => {
    const value = 'ZanthorCapital'
    const s = signalsFromReplay(lines([full(el(1, 'div')), inc(10, 0, {
        adds: pack([{ parentId: 1, node: el(2) }]), attributes: pack([{ id: 2, attributes: { id: value } }]),
        texts: pack([{ id: 9, value }]), removes: pack([]),
    }), click(100), click(200), click(300), tail]))
    assert.equal(s.rage_clicks.length, 1); absent(s, [value])
})
test('base64 cv full snapshot envelope does not expose content (unsupported transport)', () => {
    const value = 'ZanthorCapital'
    const data = { cv: '2024-10', data: gzipSync(JSON.stringify({ node: el(2, value) })).toString('base64') }
    absent(signalsFromReplay(lines([ev(0, 2, data), click(100), tail])), [value])
})
test('base64 cv decoding coverage', { skip: 'Engine unpack only recognizes gzip magic in Latin-1 strings; no base64/cv decoder exists. The envelope non-disclosure check runs above.' }, () => {})

test('meta href query/fragment, network request names and console payloads', () => {
    for (const value of [...canaries, 'ZanthorCapital']) {
        const url = `https://example.test/${encodeURIComponent(value)}?counterparty=${encodeURIComponent(value)}#${value}`
        const s = signalsFromReplay(lines([full(el(2)), ev(10, 4, { href: url }),
            ev(20, 6, { plugin: 'rrweb/network@1', payload: { requests: [{ name: url, method: 'POST', startTime: 10, timeOrigin: 1, duration: 6000, status: 500, requestBody: value, responseBody: value }] } }),
            ev(30, 6, { plugin: 'rrweb/console@1', payload: { level: 'error', trace: [value], payload: [value, { email: value }] } }), tail]))
        assert.equal(s.console_errors, 1); assert.equal(s.network_errors, 1)
        absent(s, [value, encodeURIComponent(value)])
    }
})
test('very long attributes are discarded, including sensitive prefixes/suffixes', () => {
    for (const value of ['ZanthorCapital' + 'x'.repeat(1_000_000), 'x'.repeat(1_000_000) + 'ZanthorCapital']) {
        absent(signalsFromReplay(lines(attack(Object.fromEntries(attrs.map(k => [k, value]))))), ['ZanthorCapital'])
    }
})
for (const consumer of ['clientExperience', 'frictionHotspots'] as const) test(`consumer ${consumer}: persisted replay counterparty`, async () => {
    tasksDb.exec('DELETE FROM replay_signals')
    const now = Date.UTC(2026, 10, 12)
    const result = await X.processReplays(3, {
        candidates: async () => [0, 1, 2].map(i => ({ session_id: `attack-${i}`, client: 'ATTACK', user: 'synthetic', start: new Date(now).toISOString() })),
        jsonl: async () => lines(attack({ id: 'ZanthorCapital' })), durationMs: async () => 10000,
    })
    assert.equal(result.read, 3)
    const output = consumer === 'clientExperience' ? X.clientExperience('ATTACK', { now }) : X.frictionHotspots({ now })
    assert.ok(consumer === 'clientExperience' ? (output as import('../src/core/experience.ts').ClientExperience).hotspots.length : (output as unknown[]).length)
    absent(output, ['ZanthorCapital', 'Zanthor Capital'])
})
test('200,000-line replay: under 5 seconds and under 256 MiB RSS growth', () => {
    const fixture = lines([full(el(2)), ...Array.from({ length: 199999 }, (_, i) => inc(i + 1, 1, { positions: [{ x: i % 100, y: 0 }], text: 'ZanthorCapital' }))])
    const before = process.memoryUsage().rss, start = performance.now()
    const s = signalsFromReplay(fixture)
    const ms = performance.now() - start, growth = Math.max(0, process.memoryUsage().rss - before)
    console.log(`200,000 lines: ${ms.toFixed(1)} ms; RSS growth ${(growth / 1048576).toFixed(1)} MiB`)
    assert.equal(s.duration_ms, 199999); absent(s, ['ZanthorCapital'])
    assert.ok(ms < 5000, `${ms} ms`); assert.ok(growth < 256 * 1048576, `${growth} bytes`)
})
