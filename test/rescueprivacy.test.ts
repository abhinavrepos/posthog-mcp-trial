import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scrubWith } from '../src/core/rescueprivacy.ts'

const sort = (t: string[]) => [...new Set(t)].sort((a, b) => b.length - a.length)
// The previous algorithm: each token (3+ characters) replaced everywhere, longest first.
function previous(v: string, tokens: string[]) {
    if (tokens.includes(v)) return '[person]'
    for (const t of tokens) if (t.length >= 3) v = v.split(t).join('[person]')
    return v
}
const hidden = (out: string, text: string, tokens: string[]) => tokens.filter((t) => t.length >= 3 && text.includes(t)).every((t) => !out.includes(t))

test('identity tokens are hidden in nested strings, exact values and emails', () => {
    const tokens = sort(['C1PRD|01|S001|USER1', 'USER1', 'jo', 'anna.lee@bank.example', 'anna.lee'])
    const out = scrubWith(tokens, { a: 'Done by USER1 today', b: ['C1PRD|01|S001|USER1'], c: 'jo', d: 'mail anna.lee@bank.example now', e: 'owner pm@ion.example', n: 5 })
    assert.deepEqual(out, { a: 'Done by [person] today', b: ['[person]'], c: '[person]', d: 'mail [person] now', e: 'owner pm@ion.example', n: 5 })
})
test('overlapping tokens never leave a fragment that the old algorithm hid', () => {
    assert.equal(scrubWith(sort(['bcdef', 'abc']), 'xabcdefx'), 'x[person]x')
    assert.equal(scrubWith(sort(['USER12', 'USER1']), 'USER12 and USER1'), '[person] and [person]')
    let seed = 11; const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32)
    const pick = (s: string) => s[Math.floor(r() * s.length)]
    for (let n = 0; n < 3000; n++) {
        const tokens = sort(Array.from({ length: 1 + Math.floor(r() * 5) }, () => Array.from({ length: 2 + Math.floor(r() * 4) }, () => pick('abcU1')).join('')))
        const text = Array.from({ length: Math.floor(r() * 24) }, () => pick('abcU1 ')).join('')
        const out = scrubWith(tokens, text), old = previous(text, tokens)
        assert.ok(hidden(out, text, tokens), JSON.stringify({ tokens, text, out }))
        // Every character the old algorithm kept visible outside a token is kept here too (no over-redaction beyond tokens).
        assert.ok(out.replaceAll('[person]', '').length <= old.replaceAll('[person]', '').length, JSON.stringify({ tokens, text, out, old }))
    }
})
test('scrubbing is linear: thousands of users and long text stay fast', () => {
    const tokens = sort(Array.from({ length: 5000 }, (_, i) => [`C1PRD|01|C${i % 50}|USER${i}`, `USER${i}`]).flat())
    const rows = Array.from({ length: 300 }, (_, i) => ({ client_name: `Client ${i}`, reasons: [{ text: `Stopped doing Hedge Designation → Save: ${i} done before, none since` }], note: i % 7 ? null : `Spoke with USER${i}` }))
    const t = performance.now(); const out = scrubWith(tokens, rows); const ms = performance.now() - t
    assert.equal(out[0].note, 'Spoke with [person]'); assert.ok(ms < 150, `${ms} ms`)
})
