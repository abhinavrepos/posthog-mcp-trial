import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'lens-long-reads-'))
Object.assign(process.env, { TASKS_DB: join(dir, 'tasks.db'), TRIAGE_DB: join(dir, 'main.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_PROJECT_ID: 'test', POSTHOG_PERSONAL_API_KEY: 'test' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { newestSessions, slowAttempts } = await import('../src/core/appevents.ts')
after(() => { tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })
const DAY = 86400000
const reply = (columns: string[], rows: unknown[][]) => new Response(JSON.stringify({ columns, results: rows }))
const body = (init: RequestInit) => JSON.parse(String(init.body)).query as { query: string; values: Record<string, string> }

// find_trade and attempt_timings over three years ran one GROUP BY over every event of those years (122 s and
// ClickHouse's memory limit in the 389M-event lab; PostHog stops a query at 30 s). Slices from the end, at most
// 90 days each, return the same newest sessions with every query bounded.
test('newest sessions walk back in slices of at most 90 days and stop once enough are found', async (t) => {
    const to = new Date('2026-11-14T00:00:00Z'), from = new Date(+to - 3 * 365 * DAY)
    const slices: { from: string; to: string }[] = []
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
        const { values } = body(init)
        slices.push({ from: values.from, to: values.to })
        // One hit 200 days back, one 400 days back (also seen in the next slice with a later first), none else.
        const hits = [['old', new Date(+to - 400 * DAY).toISOString()], ['mid', new Date(+to - 200 * DAY).toISOString()]]
            .filter(([, t]) => t >= values.from && t < values.to)
        if (slices.length > 1 && values.to === slices[slices.length - 2].from && hits.some(([s]) => s === 'old')) hits.push(['old', new Date(+to - 399 * DAY).toISOString()])
        return reply(['sid', 'first'], hits)
    })
    const rows = await newestSessions('SELECT ... WHERE timestamp >= {from} AND timestamp < {to}', { id: '1003' }, from, to, 2, 'first')
    assert.deepEqual(rows.map((r) => r.sid), ['mid', 'old'])
    assert.ok(slices.every((s) => Date.parse(s.to) - Date.parse(s.from) <= 90 * DAY))
    for (let i = 1; i < slices.length; i++) assert.equal(slices[i].to, slices[i - 1].from)
    assert.equal(slices[0].to, to.toISOString())
    assert.ok(Date.parse(slices.at(-1)!.from) <= +to - 400 * DAY, 'stopped after the slice that held the second session')
    assert.ok(Date.parse(slices.at(-1)!.from) > +from, 'did not scan the rest of the window')
    // Too few in the whole window: every slice is read, down to the window start, and nothing more.
    slices.length = 0
    const all = await newestSessions('SELECT ...', {}, from, to, 30, 'first')
    assert.equal(all.length, 2)
    assert.equal(slices.at(-1)!.from, from.toISOString())
})

test('attempt timings read each session around its own last submit, not across the whole window', async (t) => {
    const to = new Date('2026-11-14T00:00:00Z'), from = new Date(+to - 3 * 365 * DAY), last = new Date(+to - 500 * DAY)
    const reads: Record<string, string>[] = []
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
        const { query, values } = body(init)
        if (query.includes('topK(3)')) return reply(['dialog', 'names', 'opens', 'sessions', 'clients'], [])
        if (query.includes('GROUP BY sid')) return reply(['sid', 'last'], values.from <= last.toISOString() && last.toISOString() < values.to ? [['s1', last.toISOString()]] : [])
        if (query.includes('raw_session_replay_events')) return reply(['session_id', 'start', 'end'], [['s1', last.toISOString(), last.toISOString()]])
        if (query.includes('{sid}')) { reads.push(values); return reply([], []) }
        return reply([], [])
    })
    await slowAttempts({ from, to }).catch(() => undefined)
    assert.equal(reads.length, 1)
    assert.equal(reads[0].from, new Date(+last - DAY).toISOString())
    assert.equal(reads[0].to, new Date(+last + DAY).toISOString())
})

test('an unknown screen names the screens there are and where app dialogs belong', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { registerTools } = await import('../src/mcp/tools.ts')
    const server = new McpServer({ name: 'test', version: '0' }), client = new Client({ name: 'test', version: '0' })
    registerTools(server)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await client.connect(b)
    const r = await client.callTool({ name: 'screen_usage', arguments: { screen: 'DlgTask01' } }) as { isError?: boolean; content: { text: string }[] }
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /Screens: Dashboard, Invoices/)
    assert.match(r.content[0].text, /dialog_friction or aggregate_events/)
    await client.close(); await server.close()
})

// find_silent_issues failed on every call against ClickHouse: the outer alias "max(n) AS n" made argMax(event, n)
// an aggregate inside an aggregate (ILLEGAL_AGGREGATION). The repeated action is read under its own alias.
test('silent issues count repeated actions without reusing the inner alias', async (t) => {
    const { struggleSessions } = await import('../src/core/silent.ts')
    const queries: string[] = []
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
        const { query } = body(init)
        queries.push(query)
        if (query.includes('argMax(event, n)')) return reply(['sid', 'event', 'top'], [['s1', 'RefreshReport', 6]])
        if (query.includes('raw_session_replay_events')) return reply(['session_id', 'start', 'end'], [])
        return reply(['sid', 'user', 'pathname', 'start', 'duration_s', 'rageclicks', 'dead_clicks', 'exceptions'], [['s1', 'u', '/x', '2026-11-10T10:00:00Z', 600, 0, 0, 0]])
    })
    const [s] = await struggleSessions({ clientId: 'C01', from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-14T00:00:00Z') })
    assert.deepEqual(s.repeated_action, { event: 'RefreshReport', count: 6 })
    const outer = queries.find((q) => q.includes('argMax(event, n)'))!
    assert.doesNotMatch(outer.split('FROM (')[0], /max\(n\) AS n\b/)
})

// find_trade showed the newest 10 sessions with nothing saying more exist; the agent told the PM the trade was
// never touched before the last day. One extra session is read, and the answer says when there are more.
test('find_trade says when older sessions mention the id than the ones shown', async (t) => {
    const { findTrade } = await import('../src/core/appevents.ts')
    let hits = 11
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
        const { query } = body(init)
        if (query.includes('GROUP BY sid ORDER BY first DESC')) {
            assert.match(query, /LIMIT 11\b/)
            return reply(['sid', 'first'], Array.from({ length: hits }, (_, i) => [`s${i}`, new Date(Date.parse('2026-11-13T12:00:00Z') - i * 60000).toISOString()]))
        }
        return reply([], [])
    })
    const to = new Date('2026-11-14T00:00:00Z'), from = new Date(+to - 3 * 365 * DAY)
    const r = await findTrade({ id: '1003', from, to })
    assert.equal(r.more_sessions, true)
    assert.match(r.limits!, /More sessions mention this id/)
    hits = 10
    const all = await findTrade({ id: '1003', from, to })
    assert.equal(all.more_sessions, undefined)
})
