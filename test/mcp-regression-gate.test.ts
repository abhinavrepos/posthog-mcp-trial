// The MCP regression as a gate. Fast part (here, in npm test): the 100 questions are well formed, and the tool
// contract the real run depends on holds against a stand-in PostHog: the window argument (rolling default, one day,
// dates, clamped to now), the context every result starts with, recipes, and errors that carry a corrected call.
// The real run (Sonnet against a real PostHog, graded on ClickHouse) is tools/mcp-regression/nightly.sh.
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
const dir = mkdtempSync(join(tmpdir(), 'mcp-gate-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'main.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', CLIENT_FROM_DISTINCT_ID: '3', POSTHOG_HOST: 'http://fake-posthog', POSTHOG_PROJECT_ID: '7',
    POSTHOG_PERSONAL_API_KEY: 'test-key', POSTHOG_MCP_URL: 'http://fake-posthog-mcp/mcp', POSTHOG_MCP_API_KEY: 'mcp-key', POSTHOG_SURVEY_API_KEY: 'survey-key', FEATURE_SURVEYS: 'on', SERVICE_PUBLIC_URL: 'https://lens.example' })
const { config } = await import('../src/core/config.ts')
config.properties.clientName = ''
const { clearClientCache } = await import('../src/core/resolve.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

const DAY = 86_400_000
const questions = JSON.parse(readFileSync('tools/mcp-regression/questions.json', 'utf8')) as any[]
const CATEGORIES = ['client_lookup', 'counts', 'top_screens_buttons', 'exports', 'errors_messages', 'active_users', 'sessions', 'surveys', 'pinned', 'edge_cases']

test('the 100 regression questions are well formed and spread over every category', () => {
    assert.equal(questions.length, 100)
    assert.equal(new Set(questions.map((q) => q.id)).size, 100)
    for (const c of CATEGORIES) assert.ok(questions.filter((q) => q.category === c).length >= 5, c)
    for (const q of questions) {
        assert.ok(CATEGORIES.includes(q.category), q.id)
        if (q.kind === 'behaviour') assert.ok(q.expect && (q.expect.answer || q.expect.any_text || q.expect.tool), q.id)
        else assert.ok(q.sql || q.expected !== undefined || q.expect_text || q.expect_text_any, q.id)
        if (q.window_days) assert.match(q.sql, /\{from\}.*\{to\}/, `${q.id}: rolling ground truth is bounded by {from} and {to} (clamped to now)`)
        if (q.sql && !q.window_days && q.kind !== 'answer_sql') assert.doesNotMatch(q.sql, /\{from\}|\{to\}/, q.id)
    }
})

async function connect(t: import('node:test').TestContext, rows: (query: string, values: Record<string, unknown>) => Record<string, unknown>[]) {
    const seen: { query: string; values: Record<string, unknown> }[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const q = JSON.parse(String(init.body)).query as { query: string; values: Record<string, unknown> }
        seen.push(q)
        const out = rows(q.query, q.values || {}), columns = Object.keys(out[0] || {})
        return Response.json({ columns, results: out.map((r) => columns.map((k) => r[k])) })
    })
    clearClientCache()
    const server = new McpServer({ name: 'gate', version: '1' }); registerTools(server, undefined, { who: 'pm@example.com', email: 'pm@example.com', surveyRole: 'launch' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a)
    const client = new Client({ name: 'gate', version: '1' }); await client.connect(b)
    t.after(() => client.close())
    return { client, seen }
}
const roster = (q: string) => /GROUP BY id/.test(q) ? [{ id: 'C08', name: 'C08', events: 123398, last_seen: '2026-11-25T10:00:00Z', users: ['U1688'], emails: [], distinct_ids: ['PROD|01|C08|U1688'], user_event_counts: [] }] : []
const sc = (r: any) => r.structuredContent as Record<string, any>

test('window: rolling {last}, one {day}, {from,to} dates and the legacy period all resolve, end at the latest at now, and are reported in context', async (t) => {
    const { client, seen } = await connect(t, roster)
    const before = Date.now()
    for (const [window, kind, span] of [[{ last: '7d' }, 'rolling', 7 * DAY], [{ last: '24h' }, 'rolling', DAY], ['30d', 'rolling', 30 * DAY]] as const) {
        const r = await client.callTool({ name: 'resolve_client', arguments: { query: 'C08', window } })
        assert.ok(!r.isError, JSON.stringify(r))
        const w = sc(r).context.window
        assert.equal(w.kind, kind); assert.ok(Math.abs(Date.parse(w.to) - Date.parse(w.from) - span) < 5000, JSON.stringify(w))
        assert.ok(Date.parse(w.to) >= before && Date.parse(w.to) <= Date.now() + 1000)
        assert.match((r.content as any)[0].text, /"context":\{"tool":"resolve_client"/)
    }
    const day = await client.callTool({ name: 'resolve_client', arguments: { query: 'C08', window: { day: '2026-11-20' } } })
    assert.deepEqual([sc(day).context.window.from, sc(day).context.window.to, sc(day).context.window.kind], ['2026-11-20T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'day'])
    const range = await client.callTool({ name: 'resolve_client', arguments: { query: 'C08', window: { from: '2026-11-01', to: '2026-11-24' } } })
    assert.equal(sc(range).context.window.to, '2026-11-25T00:00:00.000Z')
    // Today and the legacy period both stop at now: rows stamped later (clock skew, test loads) are never counted.
    const today = new Date().toISOString().slice(0, 10)
    for (const args of [{ window: { day: today } }, { period: 'today' }, { period: 'this_month' }, { window: { from: '2026-11-01', to: today } }]) {
        const r = await client.callTool({ name: 'resolve_client', arguments: { query: 'C08', ...args } })
        assert.ok(!r.isError, JSON.stringify(r)); assert.ok(Date.parse(sc(r).context.window.to) <= Date.now(), JSON.stringify(args))
        if (!('period' in args && args.period === 'this_month')) assert.equal(sc(r).context.window.clamped_to_now, true, JSON.stringify(args))
    }
    const last = seen.filter((q) => /GROUP BY id/.test(q.query)).at(-1)!
    assert.ok(Date.parse(String(last.values.to)) <= Date.now(), 'the query itself is bounded by now')
    const old = await client.callTool({ name: 'resolve_client', arguments: { query: 'C08', period: 'last_7_days' } })
    assert.equal(sc(old).context.window.kind, 'named')
})

test('time errors and missing arguments carry a corrected example call', async (t) => {
    const { client } = await connect(t, roster)
    const both = await client.callTool({ name: 'resolve_client', arguments: { query: 'C08', window: { last: '7d' }, period: 'last_7_days' } })
    assert.ok(both.isError); assert.match((both.content as any)[0].text, /Example: \{"query":"C08","window":\{"last":"7d"\}\}/)
    const bad = await client.callTool({ name: 'resolve_client', arguments: { query: 'C08', window: { last: 'seven days' } } })
    assert.ok(bad.isError); assert.match((bad.content as any)[0].text, /"last":"7d"|e\.g\. "24h"/)
    const missing = await client.callTool({ name: 'resolve_client', arguments: {} })
    assert.ok(missing.isError); assert.match((missing.content as any)[0].text, /\{"query":"C08"/)
    const year = await client.callTool({ name: 'find_sessions', arguments: { client: 'C08', window: { from: '2024-01-01', to: '2025-11-30' } } })
    assert.ok(year.isError); assert.match((year.content as any)[0].text, /at most one year.*Example: \{"client":"C08"/)
})

test('recipes run through posthog_exec with the window, filters and HogQL in the result', async (t) => {
    const { client, seen } = await connect(t, (q) => /GROUP BY id/.test(q) ? roster(q) : /AS label/.test(q) ? [{ label: 'CSV Export', presses: 34671 }, { label: 'Export', presses: 34287 }] : [])
    const list = await client.callTool({ name: 'posthog_exec', arguments: { command: 'recipe' } })
    assert.ok(!list.isError); assert.deepEqual(sc(list).recipes.map((r: any) => r.name), ['events_per_client', 'top_screens', 'top_buttons', 'exports_by_label', 'messages', 'error_rate', 'active_users'])
    const r = await client.callTool({ name: 'posthog_exec', arguments: { command: 'recipe exports_by_label {"client":"C08","window":{"last":"30d"}}' } })
    assert.ok(!r.isError, JSON.stringify(r))
    assert.equal(sc(r).context.recipe, 'exports_by_label'); assert.equal(sc(r).context.window.kind, 'rolling'); assert.equal(sc(r).client, 'C08')
    assert.deepEqual(sc(r).rows.map((x: any) => x.label), ['CSV Export', 'Export'])
    const q = seen.find((x) => /AS label/.test(x.query))!
    assert.match(q.query, /timestamp < \{to\}/); assert.equal(q.values.client, 'C08'); assert.ok(Date.parse(String(q.values.to)) <= Date.now())
    const wrong = await client.callTool({ name: 'posthog_exec', arguments: { command: 'recipe top_screns {}' } })
    assert.ok(wrong.isError); assert.match((wrong.content as any)[0].text, /Unknown recipe top_screns.*Example: recipe top_screens/)
    const badArgs = await client.callTool({ name: 'posthog_exec', arguments: { command: 'recipe top_screens {"client":"C08","days":7}' } })
    assert.ok(badArgs.isError); assert.match((badArgs.content as any)[0].text, /Example: recipe top_screens \{"client":"C08","window":\{"last":"30d"\}/)
})

test('every tool description names what it answers, an example call, and limits', async (t) => {
    const { client } = await connect(t, roster)
    const tools = (await client.listTools()).tools
    for (const tool of tools) {
        assert.match(tool.description!, /Example|e\.g\./, `${tool.name} has an example`)
        assert.ok(tool.description!.length < 2048, tool.name)
    }
    const d = Object.fromEntries(tools.map((x) => [x.name, x.description!]))
    assert.match(d.posthog_exec, /500 rows/); assert.match(d.posthog_exec, /recipe/); assert.match(d.find_sessions, /19 KB/); assert.match(d.find_sessions, /one year/)
    assert.match(d.resolve_client, /posthog_exec recipes or execute-sql/); assert.match(d.resolve_client, /45 seconds/)
    for (const name of ['resolve_client', 'find_sessions']) assert.ok((tools.find((x) => x.name === name)!.inputSchema.properties as any).window, `${name} takes window`)
})

test('design_survey: a reach estimate that fails is a "check skipped" warning, never a failed check of a valid survey', async (t) => {
    const seen: string[] = []
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit = {}) => {
        if (String(url).includes('/surveys')) return Response.json({ results: [], next: null })
        const q = JSON.parse(String(init.body || '{}')).query?.query as string || ''
        seen.push(q)
        if (q.includes('uniq(person) AS users')) return new Response('Query has hit the max execution time', { status: 500 })
        if (q.includes('AS opens')) return Response.json({ columns: ['id', 'name', 'opens', 'closes', 'n'], results: [['LinkListReqv', 'Hedge Designation', 20, 0, 20]] })
        if (q.includes('AS v, count() AS n')) return Response.json({ columns: ['v', 'n'], results: [['Export', 50]] })
        if (q.includes('count() AS n')) return Response.json({ columns: ['n', 'carried', 'chosen'], results: [[1000, 1000, 100]] })
        return Response.json({ columns: ['id'], results: [] })
    })
    clearClientCache()
    const server = new McpServer({ name: 'gate', version: '1' }); registerTools(server, undefined, { who: 'pm@example.com', email: 'pm@example.com', surveyRole: 'launch' })
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a)
    const client = new Client({ name: 'gate', version: '1' }); await client.connect(b); t.after(() => client.close())
    const r = await client.callTool({ name: 'design_survey', arguments: { name: 'Hedge export', questions: [{ type: 'rating', text: 'How easy was the export?' }], steps: [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }] } })
    assert.ok(!r.isError, JSON.stringify(r).slice(0, 500))
    const out = sc(r)
    assert.ok(seen.some((q) => q.includes('uniq(person) AS users')), 'the reach estimate was attempted')
    assert.equal(out.reach.skipped, 'PostHog did not answer in time')
    assert.ok(out.problems.some((p: any) => p.where === 'reach' && /^Check skipped/.test(p.text)))
    assert.ok(!out.problems.some((p: any) => p.level === 'error'))
    assert.match((r.content as any)[0].text, /checks out/)
})
