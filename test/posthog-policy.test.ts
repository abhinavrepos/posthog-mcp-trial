import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { after, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const dir = mkdtempSync(join(tmpdir(), 'lens-policy-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const { config } = await import('../src/core/config.ts')
const { anonFor, setAnonymise } = await import('../src/core/anonymise.ts')
const { commandRefusal, replayRefusal, handlePosthogMcp, posthogExec, routingBlock, execRoutingLine } = await import('../src/mcp/posthog-proxy.ts')
const { registerTools, CACHED_TOOLS } = await import('../src/mcp/tools.ts')
const { serverInstructions } = await import('../src/mcp/instructions.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
const options = { url: 'http://localhost/mcp', apiKey: 'secret', name: 'lens', token: 'token', enabled: true }
const call = (command: string) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'exec', arguments: { command } } })
const families = [
    ['session-recording-get', 'get_replay_link'], ['session-recordings-list', 'session_story'], ['query-session-recordings-list', 'get_replay_link'], ['vision-analyze', 'session_story'],
    ['heatmaps-events', 'find_client_incidents'], ['logs-impact', 'find_silent_issues'],
    ['query-error-tracking-issue', 'error_blast_radius'], ['query-error-tracking-issue-events', 'error_blast_radius'], ['query-error-tracking-issues-list', 'find_client_incidents'],
    ['persons-list', 'resolve_client'], ['persons-delete', 'client_experience'], ['query-trends-actors', 'client_signals'],
    ['cohorts-add-persons-to-static-cohort', 'resolve_client'], ['cohorts-rm-person-from-static-cohort-bulk', 'resolve_client'],
    ['workflows-create', 'discover_workflows'], ['broadcasts-send', 'workflow_completion'], ['surveys-list', 'list_surveys'],
]
class Capture extends Writable {
    headersSent = false
    statusCode = 200
    chunks: Buffer[] = []
    setHeader() {}
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this }
    _write(chunk: Buffer, _: BufferEncoding, cb: () => void) { this.chunks.push(Buffer.from(chunk)); cb() }
    get text() { return Buffer.concat(this.chunks).toString() }
}
async function proxy(value: unknown) {
    const req = Object.assign(Readable.from([JSON.stringify(value)]), { method: 'POST', url: '/', headers: { authorization: 'Bearer token', 'content-type': 'application/json' } })
    const res = new Capture()
    await handlePosthogMcp(req as unknown as IncomingMessage, res as unknown as ServerResponse, options)
    return res.text
}

test('policy always refuses each family, including batches, chains and uppercase; lookups and other commands pass', async t => {
    assert.equal(anonFor('posthog'), false)
    assert.equal(replayRefusal, commandRefusal)
    assert.ok(commandRefusal(call('call --json --confirm persons-list')))
    assert.ok(commandRefusal(call('call --json vision-analyze')))
    const seen: unknown[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        seen.push(JSON.parse(String(init.body)))
        return Response.json({ jsonrpc: '2.0', id: 2, result: { content: [] } })
    })
    for (const [tool, lens] of families) {
        for (const command of [`call ${tool}`, ...['\n', ';', '&&', '||', '|'].map(sep => `call query-trends {}${sep} CALL ${tool.toUpperCase()} {}`)]) {
            const refusal = commandRefusal(call(command))!
            assert.ok(refusal.error.message.startsWith('PostHog command refused. '))
            assert.ok(refusal.error.message.includes(lens))
            assert.match(await proxy(call(command)), /PostHog command refused/)
            const batch = JSON.parse(await proxy([call(command), call('call query-trends')]))
            assert.equal(batch.length, 2)
            assert.ok(batch[1].error.message.includes(lens))
        }
    }
    assert.equal(seen.length, families.length * 6)
    for (const command of ['tools persons', 'help', 'help persons-list', 'schema vision-analyze', 'info surveys-list', 'search workflows', 'call query-trends', 'call execute-sql', 'call error-tracking-settings-get']) {
        assert.equal(commandRefusal(call(command)), undefined)
        const before = seen.length
        await proxy(call(command))
        assert.equal(seen.length, before + 1)
    }
    assert.equal(commandRefusal(call('call query-trends-actors-extra')), undefined)
})

const unsafe = { content: [{ type: 'text', text: JSON.stringify({ email: 'client@example.com', distinct_id: 'opaque-user', amount: 250000, count: 42 }) }] }
function assertClean(value: unknown) {
    const text = JSON.stringify(value)
    for (const secret of ['client@example.com', 'opaque-user', '250000']) assert.ok(!text.includes(secret), text)
    assert.ok(text.includes('[person]'))
    assert.ok(text.includes('<amount>'))
    assert.ok(text.includes('42'))
}
test('proxy masks JSON and SSE with anonymisation off', async t => {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ jsonrpc: '2.0', id: 2, result: unsafe }))
    const response = JSON.parse(await proxy(call('call query-trends')))
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(response.id, 2)
    assertClean(response)
    mock.mock.mockImplementation(async () => new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: unsafe })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
    assertClean(await proxy(call('call query-trends')))
})

async function connected() {
    const server = new McpServer({ name: 'test', version: '1' })
    registerTools(server)
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return { client, close: async () => { await client.close(); await server.close() } }
}

test('posthog_exec registration requires both availability and via Lens', async () => {
    const old = { ...config.posthog }, feature = config.features.posthogMcp
    try {
        for (const [via, active, url, key, want] of [[true, true, 'http://localhost', 'key', true], [false, true, 'http://localhost', 'key', false], [true, false, 'http://localhost', 'key', false], [true, true, '', 'key', false], [true, true, 'http://localhost', '', false]] as const) {
            Object.assign(config.posthog, { mcpViaLens: via, mcpUrl: url, mcpApiKey: key }); config.features.posthogMcp = active
            const c = await connected()
            try { assert.equal((await c.client.listTools()).tools.some(t => t.name === 'posthog_exec'), want) } finally { await c.close() }
        }
        assert.equal(CACHED_TOOLS.has('posthog_exec'), false)
    } finally { Object.assign(config.posthog, old); config.features.posthogMcp = feature }
})

test('posthog_exec uses JSON/SSE, wraps safety, refuses locally and deletes its private session', async t => {
    const old = { ...config.posthog }, feature = config.features.posthogMcp
    Object.assign(config.posthog, { mcpViaLens: true, mcpUrl: options.url, mcpApiKey: options.apiKey }); config.features.posthogMcp = true
    let sse = false
    const seen: { method: string; body: any; headers: Headers }[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        seen.push({ method: init.method!, body, headers: new Headers(init.headers) })
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer secret')
        if (init.method === 'DELETE' || body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        if (body.method === 'initialize') {
            assert.equal(new Headers(init.headers).get('mcp-session-id'), null)
            return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'private-session' } })
        }
        assert.equal(new Headers(init.headers).get('mcp-session-id'), 'private-session')
        const reply = { jsonrpc: '2.0', id: 2, result: unsafe }
        return sse ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(reply)
    })
    const c = await connected()
    try {
        for (const useSse of [false, true]) {
            sse = useSse
            assertClean(await c.client.callTool({ name: 'posthog_exec', arguments: { command: 'call query-trends {}' } }))
            assert.equal(seen.at(-1)!.method, 'DELETE')
            assert.equal(seen.at(-2)!.body.params.arguments.command, 'call query-trends {}')
        }
        const before = seen.length
        for (const [tool, lens] of families) {
            const result = await c.client.callTool({ name: 'posthog_exec', arguments: { command: `call ${tool}` } })
            assert.equal(result.isError, true)
            assert.ok(JSON.stringify(result).includes(lens))
        }
        assert.equal(seen.length, before)
    } finally { await c.close(); Object.assign(config.posthog, old); config.features.posthogMcp = feature }
})

test('posthog_exec forwards to a real loopback MCP upstream', async t => {
    const methods: string[] = []
    const server = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk
        const body = raw ? JSON.parse(raw) : {}
        methods.push(req.method === 'DELETE' ? 'DELETE' : body.method)
        assert.equal(req.headers.authorization, 'Bearer secret')
        if (req.method === 'DELETE' || body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'local-session' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: 'analytics answer' }] } }))
    })
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('sandbox forbids loopback listen; transport covered with fetch above'); throw e }
    try {
        const address = server.address(); assert.ok(address && typeof address === 'object')
        const result = await posthogExec('call query-trends', { ...options, url: `http://127.0.0.1:${address.port}` })
        assert.equal(result.content[0].text, 'analytics answer')
        assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call', 'DELETE'])
        await posthogExec('call persons-list', { ...options, url: `http://127.0.0.1:${address.port}` })
        assert.equal(methods.length, 4)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('routing keeps investigations, identities and messaging in Lens; Connect presents one server', () => {
    for (const text of [routingBlock('lens'), execRoutingLine('lens'), serverInstructions(true)]) {
        assert.match(text, /error investigation/)
        assert.match(text, /refused/)
        assert.ok(!text.includes('error issues') && !text.includes('error-tracking issue management'))
    }
    const page = readFileSync(new URL('../src/service/connect.ts', import.meta.url), 'utf8')
    assert.ok(page.includes('PostHog commands are included in this one Lens server.'))
    assert.ok(!page.includes('Server 2: PostHog'))
})

test('posthog_exec respects anonymisation block mode before contacting upstream', async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}) })
    try {
        setAnonymise({ mode: 'private', posthog: 'block' })
        const result = await posthogExec('call query-trends', options)
        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /switched off while client anonymisation is on/)
        assert.equal(calls, 0)
    } finally { setAnonymise({ mode: 'standard' }) }
})

test('posthog_exec times out and cleans up sessions on upstream errors', async t => {
    let deletes = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        if (init.method === 'DELETE') { deletes++; return new Response(null, { status: 202 }) }
        const body = JSON.parse(String(init.body))
        if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'failed-session' } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error('secret upstream detail')), { once: true }) })
    })
    await assert.rejects(posthogExec('call query-trends', { ...options, timeoutMs: 25 }), /PostHog query timed out:.*aggregate_events.*continues as a job/)
    assert.equal(deletes, 1)
})

test('namespaced or quoted command names are refused like plain ones', async () => {
    const { commandRefusal } = await import('../src/mcp/posthog-proxy.ts')
    const call = (command: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: { command } } })
    for (const command of ['call posthog:persons-list {}', 'call "persons-list" {}', 'CALL --json POSTHOG:session-recording-get {}', "call 'workflows-send-email-execute' {}"])
        assert.ok(commandRefusal(call(command)), command)
    assert.equal(commandRefusal(call('call posthog:query-trends {}')), undefined)
})
