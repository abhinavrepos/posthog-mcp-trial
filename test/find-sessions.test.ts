import assert from 'node:assert/strict'
import { after, test, type TestContext } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const dir = mkdtempSync(join(tmpdir(), 'lens-find-sessions-'))
Object.assign(process.env, { TASKS_DB: join(dir, 'tasks.db'), TRIAGE_DB: join(dir, 'main.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_PROJECT_ID: 'test', POSTHOG_PERSONAL_API_KEY: 'test', PRIVACY_MODE: 'standard' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { db } = await import('../src/core/db.ts')
const { findSessions } = await import('../src/core/appevents.ts')
const { ToolInputError } = await import('../src/core/toolinputerror.ts')
const { jsonResult, safeResult } = await import('../src/mcp/result.ts')
const { registerTools, APP_EVENT_TOOLS, CACHED_TOOLS, WINDOW_DEFAULTS } = await import('../src/mcp/tools.ts')
const { conciseValue } = await import('../src/mcp/structured.ts')
const { HEAVY_TOOLS } = await import('../src/mcp/ratelimit.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
const from = new Date('2026-11-10T00:00:00Z'), to = new Date('2026-11-14T00:00:00Z')
const code = 'DlgAmort', name = 'Amortization Report'
const reply = (columns: string[], results: unknown[][]) => Response.json({ columns, results })
const all = [3, 2, 1].map(i => ({ sid: `s${i}`, first: '2026-11-13T12:00:00.000Z' }))
function mockQueries(t: TestContext, check?: (query: string, values: Record<string, unknown>) => void, errors = true) {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const { query, values } = JSON.parse(String(init.body)).query
        if (query.includes('topK(3)')) return reply(['dialog', 'names', 'opens', 'sessions', 'clients'], [[code, [name], 3, 3, 1], ['DlgAmortExport', ['Amortization Report Export'], 1, 1, 1]])
        if (query.includes('GROUP BY sid')) {
            check?.(query, values)
            const rows = all.filter(r => r.first >= values.from && r.first < values.to && (!values.cts || r.first < values.cts || (r.first === values.cts && r.sid < values.csid)))
            return reply(['sid', 'first'], rows.slice(0, Number(/LIMIT (\d+)/.exec(query)![1])).map(r => [r.sid, r.first]))
        }
        if (query.includes('raw_session_replay_events')) return reply(['session_id', 'start', 'end'], all.map(r => [r.sid, r.first, '2026-11-13T12:10:00.000Z']))
        if (query.includes('{sid}')) {
            check?.(query, values)
            return reply(['sid', 'ts', 'event', 'client', 'user', 'dialog', 'dialogName', 'action', 'button'], [
                [values.sid, all[0].first, 'PageView', 'SEMOPS', 'ENV|01|SEMOPS|alice', code, name, 'OPEN', ''],
                [values.sid, '2026-11-13T12:01:00.000Z', 'Event', 'SEMOPS', 'ENV|01|SEMOPS|alice', code, name, '', 'Run'],
                ...(errors ? [[values.sid, '2026-11-13T12:02:00.000Z', 'Event', 'SEMOPS', 'ENV|01|SEMOPS|alice', 'messagebox', '', '', '["Please provide a date range"]']] : []),
            ])
        }
        return reply([], [])
    })
}

test('dialog names resolve to every matching code and queries filter client, codes and optional email', async t => {
    let checked = false
    mockQueries(t, (query, values) => {
        assert.match(query, /toString\(properties\.client_id\) = \{client\}/)
        assert.equal(values.client, 'SEMOPS')
        assert.equal(values.email, 'alice@example.com')
        if (query.includes('GROUP BY sid')) {
            checked = true
            assert.match(query, /properties\.dialog_id\) IN \{dialogs\}/)
            assert.deepEqual(values.dialogs, [code, 'DlgAmortExport'])
            assert.match(query, /LIMIT 11\b/)
        }
    })
    const r = await findSessions({ clientId: 'SEMOPS', screen: 'amortization report', email: 'Alice@Example.com', from, to })
    assert.ok(checked)
    assert.deepEqual(r.dialogs.map(d => d.code), [code, 'DlgAmortExport'])
    assert.equal(r.sessions[0].dialogs[0].events, 2)
    assert.equal(r.sessions[0].error_count, 1)
    assert.equal(r.sessions[0].last_seen, '2026-11-13T12:01:00.000Z')
    assert.ok(r.sessions[0].replay_url)
})

test('exact code takes precedence and paging includes older sessions with equal timestamps', async t => {
    mockQueries(t)
    const first = await findSessions({ clientId: 'SEMOPS', screen: code, from, to, limit: 2 })
    assert.deepEqual(first.dialogs.map(d => d.code), [code])
    assert.deepEqual(first.sessions.map(s => s.session_id), ['s3', 's2'])
    assert.equal(first.next_cursor, `${all[0].first}|s2`)
    const older = await findSessions({ clientId: 'SEMOPS', screen: code, from, to, limit: 2, cursor: first.next_cursor })
    assert.deepEqual(older.sessions.map(s => s.session_id), ['s1'])
    assert.equal(older.next_cursor, undefined)
    await assert.rejects(findSessions({ clientId: 'SEMOPS', screen: code, from, to, cursor: 'yesterday' }), ToolInputError)
})

test('sessions without errors are returned and limit is capped at 30', async t => {
    mockQueries(t, (query) => {
        if (query.includes('GROUP BY sid')) assert.match(query, /LIMIT 31\b/)
    }, false)
    const r = await findSessions({ clientId: 'SEMOPS', screen: code, from, to, limit: 100 })
    assert.equal(r.sessions.length, 3)
    assert.ok(r.sessions.every(s => s.error_count === 0))
})

test('unknown screen raises ToolInputError with dialog candidates', async t => {
    mockQueries(t)
    await assert.rejects(findSessions({ clientId: 'SEMOPS', screen: 'amortiztion report', from, to }), e => e instanceof ToolInputError && /Candidates:.*DlgAmort.*Amortization Report/.test(e.message))
})

test('standard privacy masks the user through the normal result pass', async t => {
    mockQueries(t)
    const result = await findSessions({ clientId: 'SEMOPS', screen: code, from, to })
    assert.equal(result.sessions[0].user, 'ENV|01|SEMOPS|alice')
    const output = await safeResult(jsonResult('Sessions:', result))
    assert.doesNotMatch(JSON.stringify(output), /alice|ENV\|01/)
    assert.match(JSON.stringify(output), /\[person\]/)
})

test('tools/list advertises find_sessions with outputSchema, standard window inputs and readOnlyHint', async () => {
    const server = new McpServer({ name: 'test', version: '0' }), client = new Client({ name: 'test', version: '0' })
    registerTools(server)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
        const tool = (await client.listTools()).tools.find(t => t.name === 'find_sessions')!
        assert.ok(tool.outputSchema)
        assert.equal(tool.annotations?.readOnlyHint, true)
        assert.deepEqual(tool.inputSchema.required, ['client', 'screen'])
        for (const key of ['from', 'to', 'when', 'timezone', 'limit', 'cursor', 'email']) assert.ok(key in tool.inputSchema.properties!)
        assert.ok(APP_EVENT_TOOLS.includes(tool.name))
        assert.ok(CACHED_TOOLS.has(tool.name))
        assert.ok(HEAVY_TOOLS.has(tool.name))
        assert.equal(WINDOW_DEFAULTS[tool.name], 30)
    } finally { await client.close(); await server.close() }
})

test('concise output preserves the session page before its cursor', () => {
    const sessions = Array.from({ length: 30 }, (_, i) => ({ session_id: `s${i}` }))
    const value = conciseValue('find_sessions', { sessions, next_cursor: '2026-11-13T12:00:00Z|s29' })
    assert.deepEqual(value.sessions, sessions)
    assert.equal(value.next_cursor, '2026-11-13T12:00:00Z|s29')
})
