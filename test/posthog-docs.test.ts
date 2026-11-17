import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactInfo, compactTools, infoSchema, metadataCommand, PosthogDocsCache } from '../src/mcp/posthog-docs.ts'
import { annotatePosthogBuckets } from '../src/mcp/posthog-buckets.ts'

import { posthogDocFixtures as fixtures, fixtureInfoText } from './fixtures/posthog-docs.ts'
const schema = async (tool: string, path: string) => {
    const text = fixtures[`schema ${tool} ${path}`]?.content[0].text
    return text ? JSON.parse(text.replace(/(:)-?<amount>(?=[,}])/g, '$10')).schema : undefined
}
test('real static documents shrink without losing top-level or supplied nested fields and enums', async () => {
    for (const tool of ['execute-sql', 'query-trends', 'query-paths', 'query-funnel']) {
        const raw = fixtureInfoText(`info ${tool}`)
        const output = await compactInfo(raw, tool, path => schema(tool, path))
        assert.ok(output.length < 6000, `${tool}: ${output.length}`)
        assert.ok(output.length < raw.length / 2)
        for (const [name, field] of Object.entries(infoSchema(raw)!.properties) as [string, any][]) {
            assert.ok(output.includes(name), name)
            for (const value of field.enum || []) assert.ok(output.includes(JSON.stringify(value)), value)
            const full = await schema(tool, name)
            for (const child of Object.keys(full?.properties || {})) assert.ok(output.includes(child), child)
        }
        assert.ok(output.includes(`info ${tool} full`))
    }
})
test('outline keeps refs, nullable objects, required union members, constraints and enum counts', async () => {
    const input = { type: 'object', required: ['series'], $defs: { node: { type: 'object', required: ['event'], properties: { event: { type: 'string' }, kind: { const: 'EventsNode' }, math: { type: 'string', enum: ['total', 'dau'] } } } }, properties: {
        series: { type: 'array', items: { $ref: '#/$defs/node' }, minItems: 1 },
        dateRange: { anyOf: [{ type: 'null' }, { type: 'object', required: ['date_from'], properties: { date_from: { type: 'string' } } }] },
        dependency: { type: 'boolean', description: 'Send the raw query. Requires connectionId. Long examples are omitted.' },
        many: { type: 'string', enum: Array.from({ length: 20 }, (_, i) => `enum${i}`) },
    } }
    const raw = `name: query-trends\ndescription: |-\n  Short description.\ninputSchema: ${JSON.stringify(JSON.stringify(input))}`
    const output = await compactInfo(raw, 'query-trends', async () => undefined)
    assert.match(output, /series\*: array minItems=1/)
    assert.match(output, /event\*: string/)
    assert.match(output, /kind: any enum="EventsNode"/)
    assert.match(output, /math: string enum="total"\|"dau"/)
    assert.match(output, /dateRange: null\|object/)
    assert.match(output, /date_from\*: string/)
    assert.match(output, /20 values/)
    assert.match(output, /dependency: boolean — Requires connectionId\./)
})
test('tool catalog preserves every real tool name grouped by prefix, and shortens descriptions', () => {
    const raw = fixtures.tools.content[0].text
    const output = compactTools(raw)
    for (const name of JSON.parse(raw)) assert.ok(output.split('\n').includes(name), name)
    assert.match(output, /\[query\]/)
    const described = compactTools(JSON.stringify([{ name: 'query-trends', description: 'First sentence. ' + 'Long prose '.repeat(100) }]))
    assert.equal(described, '[query]\nquery-trends: First sentence')
    assert.equal(compactTools('unknown document format'), 'unknown document format')
})
test('metadata syntax distinguishes full info from schema and never treats data chains as docs', () => {
    assert.deepEqual(metadataCommand('info posthog:query-trends full'), { raw: 'info query-trends', tool: 'query-trends', compact: false })
    assert.equal(metadataCommand('schema query-trends series.properties')?.raw, 'schema query-trends series.properties')
    for (const command of ['tools; call query-trends {}', 'tools\ncall query-trends {}', 'call query-trends {}', 'info query-trends unknown']) assert.equal(metadataCommand(command), undefined)
})
test('metadata cache shares pending work, expires after one hour and isolates servers', async () => {
    const cache = new PosthogDocsCache()
    let calls = 0
    const fetch = async () => { calls++; return calls }
    const results = await Promise.all([cache.get('a', 'tools', fetch, 0), cache.get('a', 'tools', fetch, 1)])
    assert.deepEqual(results, [1, 1]); assert.equal(calls, 1)
    assert.equal(await cache.get('a', 'tools', fetch, 3599999), 1)
    assert.equal(await cache.get('a', 'tools', fetch, 3600000), 2)
    assert.equal(await cache.get('b', 'tools', fetch, 3600000), 3)
    cache.invalidate('a'); assert.equal(await cache.get('a', 'tools', fetch), 4)
    await assert.rejects(cache.get('a', 'info query-trends', async () => { throw new Error('unavailable') }))
    assert.equal(await cache.get('a', 'tools', fetch), 5)
})
test('invalidation fences late pending completions', async () => {
    const cache = new PosthogDocsCache()
    let resolve!: (value: number) => void
    const old = cache.get('a', 'tools', () => new Promise<number>(r => { resolve = r }))
    await Promise.resolve(); cache.invalidate('a')
    assert.equal(await cache.get('a', 'tools', async () => 2), 2)
    resolve(1); assert.equal(await old, 1)
    assert.equal(await cache.get('a', 'tools', async () => 3), 2)
})

const table = (dates: string[]) => ({ content: [{ type: 'text', text: 'Date|Count\n' + dates.map(d => `${d}|123`).join('\n') }] })
const command = (kind = 'trends', extra = {}) => `call query-${kind} ${JSON.stringify({ interval: 'week', dateRange: { date_from: '2026-09-29', date_to: '2026-10-15' }, ...extra })}`
test('bucket note derives Sunday or Monday from dates and flags clipped boundaries without changing data', () => {
    for (const [dates, weekday] of [
        [['2026-09-27', '2026-10-04', '2026-10-11'], 'Sunday'],
        [['2026-09-28', '2026-10-05', '2026-10-12'], 'Monday'],
        [['2026-09-29', '2026-10-04', '2026-10-11'], 'Sunday'],
    ] as const) for (const kind of ['trends', 'lifecycle', 'retention']) {
        const original = table([...dates]), output = annotatePosthogBuckets(command(kind), original)
        assert.deepEqual(output.content[0], original.content[0]); assert.equal(original.content.length, 1)
        assert.equal(output.content[1].text, `Buckets: interval=week; week start=${weekday}; partial: first, last (requested range).`)
    }
})
test('complete buckets, daily and monthly intervals are annotated; ambiguous or relative ranges are untouched', () => {
    const original = table(['2026-09-27', '2026-10-04', '2026-10-11'])
    const complete = command('trends', { dateRange: { date_from: '2026-09-27', date_to: '2026-10-17' } })
    assert.match(annotatePosthogBuckets(complete, original).content[1].text, /partial: none/)
    for (const [interval, dates, range] of [
        ['day', ['2026-10-01', '2026-10-02', '2026-10-03'], { date_from: '2026-10-01', date_to: '2026-10-03' }],
        ['month', ['2026-08-01', '2026-09-01', '2026-10-01'], { date_from: '2026-08-02', date_to: '2026-10-15' }],
    ] as const) assert.match(annotatePosthogBuckets(command('trends', { interval, dateRange: range }), table([...dates])).content[1].text, /week start=n\/a/)
    for (const cmd of [command('funnel'), command('trends', { dateRange: { date_from: '-30d' } }), command('trends', { interval: 'guess' }), 'call query-trends {"value":"private"}']) assert.equal(annotatePosthogBuckets(cmd, original), original)
    for (const dates of [['2026-09-27'], ['2026-09-27', '2026-10-03', '2026-10-11'], ['2026-10-04', '2026-10-11', '2026-10-18']]) {
        const data = table(dates); assert.equal(annotatePosthogBuckets(command(), data), data)
    }
})

test('docs are refreshed ahead of expiry: callers keep the old value and never wait for the rebuild', async () => {
    const { PosthogDocsCache } = await import('../src/mcp/posthog-docs.ts')
    const cache = new PosthogDocsCache(); let fetches = 0
    const slow = () => new Promise<string>(r => { fetches++; setTimeout(() => r('v' + fetches), 20) })
    const t0 = Date.now()
    assert.equal(await cache.get('s', 'info x', slow, t0), 'v1')
    const late = t0 + 55 * 60_000 // inside the last 10 minutes of the hour
    assert.equal(await cache.get('s', 'info x', slow, late), 'v1') // answered at once from the old value
    await new Promise(r => setTimeout(r, 40))
    assert.equal(fetches, 2)
    assert.equal(await cache.get('s', 'info x', slow, late), 'v2')
})
