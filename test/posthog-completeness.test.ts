import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { config } = await import('../src/core/config.ts')
Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: '7', personalApiKey: 'test' })
const { hogql, isTruncated, clearPosthogCache, resetPosthogBreaker } = await import('../src/core/posthog.ts')
const { presenceReport, personDay } = await import('../src/core/presence.ts')
const { handleLive } = await import('../src/service/live.ts')
const { findSessions } = await import('../src/core/appevents.ts')
const { resolveClient, clearClientCache } = await import('../src/core/resolve.ts')
const q = { from: '2026-01-01', to: '2026-12-31', tz: 'UTC', gap_s: 60, client: 'acme' }
const response = (rows: Record<string, unknown>[], metadata = {}) => {
    const columns = Object.keys(rows[0] || {})
    return Response.json({ columns, results: rows.map(r => columns.map(k => r[k])), ...metadata })
}
const session = { sid: 's1', client: 'acme', user: 'a', start: '2026-01-01', end: '2026-01-01', actions: 1 }

test('HogQL exposes exactly 50,000 rows and all supported limit metadata, including cached reads', async t => {
    clearPosthogCache()
    let answer = response(Array(50_000).fill({ n: 1 }))
    t.mock.method(globalThis, 'fetch', async () => answer)
    assert.equal(isTruncated(await hogql('SELECT n LIMIT 200000')), true)
    for (const metadata of [{ hasMore: true }, { has_more: true }, { limit: 1 }, { row_limit: 1 }]) {
        answer = response([{ n: 1 }], metadata)
        const rows = await hogql('SELECT n LIMIT 100')
        assert.equal(isTruncated(rows), true)
        assert.match((rows as { warning?: string }).warning!, /partial/)
    }
    answer = response([{ n: 2 }], { hasMore: true })
    const first = await hogql('cached', {}, { cache: true })
    assert.equal(isTruncated(first), true)
    assert.equal(isTruncated(await hogql('cached', {}, { cache: true })), true)
    answer = response([{ n: 1 }], { hasMore: false, limit: 100 })
    assert.deepEqual(await hogql('complete'), [{ n: 1 }])
})

test('report reads aggregate in SQL, preserve millisecond rounding and pass 300s for a year', async t => {
    const deadlines: number[] = [], queries: string[] = []
    const timeout = AbortSignal.timeout
    t.mock.method(AbortSignal, 'timeout', (ms: number) => { deadlines.push(ms); return timeout(ms) })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const sql = JSON.parse(String(init.body)).query.query
        queries.push(sql)
        assert.match(sql, /uniqExact/)
        if (sql.includes('leadInFrame')) assert.match(sql, /sumIf\(gap, keep\) AS open_ms/)
        assert.doesNotMatch(sql, /GROUP BY client, user, sid/)
        return response([{ d: '', h1: 0, c: '', u: '', clients: 3, people: 4, sessions: 2_762_793, actions: 97_000_000, open_ms: 1400, active_ms: 600 }])
    })
    const report = await presenceReport(q)
    assert.deepEqual(report.totals, { clients: 3, people: 4, sessions: 2_762_793, actions: 12 * 97_000_000, open_s: 12, active_s: 12, idle_s: 0 })
    assert.equal(queries.length, 13)
    assert.equal(deadlines.length, 13)
    assert.equal(deadlines.at(-1), 300_000)
    // Selections happen after the window, so they cannot alter a session's forward gap.
    const totals = queries[0]
    assert.match(totals, /client = \{client\} AND 1 AS keep/)
    assert.doesNotMatch(totals.slice(totals.indexOf('FROM events')), /AND client = \{client\}/)
})

test('report and personDay propagate server truncation metadata with a plain warning', async t => {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const sql = JSON.parse(String(init.body)).query.query
        return /GROUP BY sid/.test(sql) ? response([session], { hasMore: true }) : response([])
    })
    const report = await presenceReport(q)
    assert.equal(report.truncated, undefined)
    const day = await personDay({ ...q, to: q.from, user: 'a' })
    assert.equal(day.truncated, true)
    assert.match(day.warning!, /partial/)
    t.mock.method(globalThis, 'fetch', async () => response([], { hasMore: true }))
    const partial = await presenceReport(q)
    assert.equal(partial.truncated, true)
    assert.match(partial.warning!, /partial/)
})

test('Live sessions API serializes the warning instead of losing array metadata', async t => {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const sql = JSON.parse(String(init.body)).query.query
        return /GROUP BY sid/.test(sql) ? response([session], { hasMore: true }) : response([])
    })
    let body = ''
    const res = { writeHead() {}, end(value: string) { body = value } } as unknown as ServerResponse
    await handleLive({ method: 'GET' } as IncomingMessage, res, new URL('https://lens.test/replays/live/api/sessions?from=2026-01-01&to=2026-01-02&client=acme'), {} as never)
    const result = JSON.parse(body)
    assert.equal(result.sessions.length, 1)
    assert.equal(result.truncated, true)
    assert.match(result.warning, /partial/)
})

test('findSessions and resolve expose capped details and incomplete client totals', async t => {
    clearClientCache()
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const sql = JSON.parse(String(init.body)).query.query
        if (/GROUP BY id, user, did/.test(sql)) return response([{ id: 'acme', user: 'a', did: 'a', n: 10, last_seen: '2026-01-01' }], { hasMore: true })
        if (/GROUP BY sid HAVING/.test(sql)) return response([{ sid: 's1', last: '2026-01-01', first_match: '2026-01-01' }])
        if (/LIMIT 5000/.test(sql)) return response([{ ts: '2026-01-01', user: 'a' }], { hasMore: true })
        return response([])
    })
    const matches = await resolveClient({ text: 'acme' })
    assert.equal(matches.truncated, true)
    assert.equal(matches[0].truncated, true)
    assert.match(matches[0].warning!, /partial/)
    const result = await findSessions({ clientId: 'acme', from: new Date(q.from), to: new Date(q.to) })
    assert.equal(result.truncated, true)
    assert.match(result.warning!, /partial/)
    assert.equal(result.sessions[0].truncated, true)
})

test('successful 56-second Live reads reset timeout history and leave other tools usable', async t => {
    resetPosthogBreaker()
    t.after(resetPosthogBreaker)
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    let failing = true
    t.mock.method(globalThis, 'fetch', async () => {
        if (failing) throw new DOMException('timed out', 'TimeoutError')
        t.mock.timers.tick(56_000)
        return response([{ n: 1 }])
    })
    for (let i = 0; i < 2; i++) await assert.rejects(hogql('timeout', {}, { retries: 0 }))
    failing = false
    for (let i = 0; i < 3; i++) assert.deepEqual(await hogql('Live', {}, { timeoutMs: 300_000, retries: 0 }), [{ n: 1 }])
    assert.deepEqual(await hogql('other tool', {}, { retries: 0 }), [{ n: 1 }])
})

test('PostHog input rejections keep PostHog\'s own one-line reason so the agent can fix the call', async () => {
    const { posthogUsageMessage, posthogPublicMessage } = await import('../src/mcp/posthog-error.ts')
    const msg = posthogUsageMessage('Invalid input for "subscriptions-retrieve": missing required parameter: id (A unique integer value identifying this subscription.)')!
    assert.match(msg, /missing required parameter: id/)
    assert.equal(posthogPublicMessage(msg), msg)
    const long = posthogUsageMessage(JSON.stringify({ text: 'Invalid input for "query-trends": parameter "series" must be of type array\n\n' + 'x'.repeat(2000) }))!
    assert.match(long, /parameter "series" must be of type array/); assert.ok(long.length < 600); assert.equal(posthogPublicMessage(long), long)
})
