// The privacy filter against realistic leaks, and the readability it must keep (counts, rates, ids, links).
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.TRIAGE_DB = join(mkdtempSync(join(tmpdir(), 'lens-privacy-')), 'p.db')
const { safetyWith } = await import('../src/core/aisafety.ts')
const clean = (v: unknown) => JSON.stringify(safetyWith(v, [], new Set()))

test('amounts in every common written form are masked', () => {
    const cases: [unknown, RegExp][] = [
        ['Notional 250000 exceeds limit', /250000/], ['Cash USD250000 moved', /250000/], ['Balance 250k', /250k/],
        ['exposure 2.5m', /2\.5/], ['book 1.2bn', /1\.2/], ['limit 1e6 reached', /1e6/],
        ['Amount 250 000 due', /250.000/], ['Amount 250 000 due', /250.000/], ['Amount 250 000,00 due', /000/],
        ["Amount 1'250'000 due", /250/], ['Amount ２５００００ due', /２５|250000/], ['Amount ٢٥٠٠٠٠ due', /٢|250000/],
        ['https://app/trade?notional=250000&ccy=USD', /250000/], [{ amount: '250k' }, /250k/],
        [{ amount: { major: 250, zeros: 3 } }, /250/], ['P&L (12,500.00)', /12,500/],
        [{ columns: ['distinct_id', 'amount'], results: [['ENV|01|C01|bob@c.example', 99000]] }, /bob|99000/],
    ]
    for (const [input, leak] of cases) assert.doesNotMatch(clean(input), leak, JSON.stringify(input))
})

test('identities are masked, encoded or not', () => {
    for (const [input, leak] of [['Owner alice.smith@client.example failed', /alice/], ['https://app/x?u=alice%40client.example', /alice/],
        ['ENV|01|C01|alice@client.example', /alice/], ['ALICE+ops@Client.Example', /alice/i]] as const)
        assert.doesNotMatch(clean(input), leak, input)
})

test('counts, rates, durations, ids, links, versions and dates stay readable', () => {
    for (const [input, keep] of [
        ['1,358 attempts by 42 users', /1,358 attempts/], ['Completion 87.5% this week', /87\.5%/],
        ['Median 12.5 s, p90 3.2 min', /12\.5 s.*3\.2 min/], ['12,400 sessions across 37 clients', /12,400 sessions/],
        ['Trade Id 4348 Updated', /4348/], ['Trade 123456 saved', /123456/],
        ['session 019b55aa-8c82-7185-ba5a-123456789012', /123456789012/],
        ['https://ph.example/project/1/replay/019b55aa-8c82-7185-ba5a-123456789012?t=40', /\?t=40/],
        ['Release 26.10.0 shipped', /26\.10\.0/], ['At 2026-11-14 12:30 UTC', /2026-11-14 12:30/],
    ] as const) assert.match(clean(input), keep, input)
    assert.match(clean({ property: 'browser', value: 'Chrome 120' }), /Chrome 120/)
})

test('raw SQL is refused while client anonymisation is on, in filter mode as in block mode', async () => {
    const { anonRefusal } = await import('../src/mcp/posthog-proxy.ts')
    const { setAnonymise } = await import('../src/core/anonymise.ts')
    setAnonymise({ mode: 'private', posthog: 'filter' })
    const call = (command: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: { command } } })
    for (const command of ['call execute-sql {"query":"SELECT 1"}', 'call --json posthog:execute-sql {}'])
        assert.ok(anonRefusal(call(command), 'lens', 'filter').refusal, command)
    assert.equal(anonRefusal(call('call query-trends {}'), 'lens', 'filter').refusal, undefined)
    setAnonymise({ mode: 'standard' })
})

test('regressions found in review: count words, leading dots, qualified fields, identities under money', () => {
    for (const input of ['notional 250000 attempts', 'notional .250000', '250000 x', 'exposure 1.5m users'])
        assert.doesNotMatch(clean(input), /250000|1\.5/, input)
    assert.doesNotMatch(clean({ columns: ['properties.value'], results: [['12.50']] }), /12\.50/)
    assert.doesNotMatch(clean({ columns: ['person.properties.amount'], results: [[250000]] }), /250000/)
    const nested = clean({ amount: { user_id: 'opaque-user', users: ['opaque-user'], major: 250 } })
    assert.doesNotMatch(nested, /opaque-user|250/, nested)
    assert.match(clean('1,358 attempts; 42 users; 87.5% done'), /1,358 attempts; 42 users; 87\.5% done/)
})

test('long hostile inputs are cleaned in linear time (no quadratic regex)', () => {
    for (const s of ['9'.repeat(200_000) + 'x', '1,'.repeat(100_000), 'a@'.repeat(100_000), 'a'.repeat(200_000) + '@b', '123 '.repeat(50_000)]) {
        const t = performance.now()
        safetyWith(s, ['alice'], new Set())
        assert.ok(performance.now() - t < 3000, `${s.slice(0, 10)}… took ${Math.round(performance.now() - t)} ms`)
    }
})

test('ids and timestamps are not read as amounts', () => {
    for (const keep of ['12e45fa0b1c2', 'ce21cbbe4ba5', '2026-11-15T02:06:09.123Z', 'at 12:30:45.123 UTC', 'Feed USD-LIBOR3M failed'])
        assert.equal(JSON.parse(clean(keep)), keep, keep)
    assert.doesNotMatch(clean('Notional 250000 exceeds limit at 12:30:45'), /250000/)
})

test('emails outside the BMP are masked; placeholders cannot be forged', () => {
    for (const leak of ['𐐀@x.com', 'a𐐀@x.com', 'mail 𐐀𐐁@client.example now']) assert.doesNotMatch(clean(leak), /@/, leak)
    assert.equal(JSON.parse(clean('0 12:30:45')), '0 12:30:45')
    assert.equal(JSON.parse(clean('v0 Release 26.10.0')), 'v0 Release 26.10.0')
})

test('a tool answer as sent (heading + fenced JSON) keeps counts; only money fields and amounts in text are masked', async () => {
    const { safetyWith } = await import('../src/core/aisafety.ts')
    const msg = 'Reval event counts (last 4 years):\n\n```json\n' + JSON.stringify({ totals: { events: 10941928, sessions: 345000 }, seconds: 87.3,
        rows: [{ events: 4002949, notional: 250000, note: 'limit 250000 USD for jane.doe@client07.example' }] }) + '\n```'
    const out = safetyWith(msg, ['jane.doe@client07.example'])
    assert.match(out, /"events":10941928/); assert.match(out, /"sessions":345000/); assert.match(out, /"seconds":87\.3/); assert.match(out, /"events":4002949/)
    assert.match(out, /"notional":"<amount>"/); assert.doesNotMatch(out, /250000/); assert.doesNotMatch(out, /jane\.doe/)
    assert.ok(out.startsWith('Reval event counts (last 4 years):'))
})
