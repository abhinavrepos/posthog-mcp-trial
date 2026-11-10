import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { describe, test } from 'node:test'
import { handlePosthogMcp, replayRefusal, rewriteResponse, rewriteSseLine, type ProxyOptions } from '../src/mcp/posthog-proxy.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/posthog-mcp.json', import.meta.url), 'utf8'))
const options: ProxyOptions = { url: 'http://127.0.0.1:8787/mcp', apiKey: 'upstream-secret', token: 'lens-secret', name: 'reval-lens', enabled: true }
const call = (command: string, id = 3) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'exec', arguments: { command } } })

describe('PostHog routing rewrites', () => {
    test('prepends initialize instructions from the live fixture without changing the original', () => {
        const result = rewriteResponse(fixture.initialize, options.name) as typeof fixture.initialize
        assert.ok(result.result.instructions.startsWith('Replays are private'))
        assert.match(result.result.instructions, /Lens server \(reval-lens\)/)
        assert.ok(result.result.instructions.endsWith(fixture.initialize.result.instructions))
        assert.deepEqual(result.result.serverInfo, fixture.initialize.result.serverInfo)
        assert.ok(!fixture.initialize.result.instructions.includes('Lens server'))
    })
    test('exec leads with the configured Lens server and preserves its schema and description', () => {
        const result = rewriteResponse(fixture.tools_list, options.name, { app: 'Reval', tools: ['resolve_client', 'find_client_incidents', 'get_replay_link'] }) as typeof fixture.tools_list
        const tool = result.result.tools[0]
        assert.equal(tool.name, 'exec')
        assert.match(tool.description.split('\n')[0], /use the reval-lens server's tools \(resolve_client, find_client_incidents, get_replay_link/)
        assert.ok(tool.description.endsWith(fixture.tools_list.result.tools[0].description))
        assert.deepEqual(tool.inputSchema, fixture.tools_list.result.tools[0].inputSchema)
    })
    test('SSE rewrites data JSON and leaves other lines and invalid JSON alone', () => {
        for (const line of [': keepalive', 'event: message', 'id: 123', '', 'data: [DONE]', 'data: not JSON']) assert.equal(rewriteSseLine(line), line)
        for (const response of [fixture.initialize, fixture.tools_list]) {
            const input = `data: ${JSON.stringify(response)}\r`
            assert.equal(rewriteSseLine(input, options.name), `data: ${JSON.stringify(rewriteResponse(response, options.name))}\r`)
        }
    })
    test('rewrites batches and leaves errors, notifications and call results intact', () => {
        const error = { jsonrpc: '2.0', id: 9, error: { code: -1, message: 'failed' } }
        const result = { jsonrpc: '2.0', id: 10, result: { content: [{ type: 'text', text: 'hi' }] } }
        const batch = [fixture.initialize, fixture.tools_list, error, result, null]
        assert.deepEqual(rewriteResponse(batch), [rewriteResponse(fixture.initialize), rewriteResponse(fixture.tools_list), error, result, null])
        assert.equal(rewriteSseLine(`data: ${JSON.stringify(batch)}`), `data: ${JSON.stringify(rewriteResponse(batch))}`)
    })
    test('refuses replay commands, including multiple calls, never ordinary PostHog commands', () => {
        for (const tool of ['session-recording-get', 'session-recordings-list', 'query-session-recordings-list', 'vision-query', 'vision-analyze']) {
            const refusal = replayRefusal(call(`call insight-get {}\ncall ${tool} {}`), options.name)!
            assert.equal(refusal.id, 3)
            assert.equal(refusal.error.code, -32602)
            assert.match(refusal.error.message, /reval-lens server's get_replay_link/)
        }
        for (const command of ['call query-trends {}', 'call execute-sql {"query":"select 1"}', 'call error-tracking-issues-list {}']) assert.equal(replayRefusal(call(command)), undefined)
        assert.equal(replayRefusal({ ...call('call vision-query {}'), params: { name: 'other' } }), undefined)
    })
})

// Exercise the adapter without sockets too: managed sandboxes may forbid all listen() calls.
class Capture extends Writable {
    statusCode = 200
    headersSent = false
    headers = new Map<string, string>()
    chunks: Buffer[] = []
    setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value) }
    writeHead(status: number, headers: Record<string, string> = {}) {
        this.statusCode = status
        this.headersSent = true
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
        return this
    }
    _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void) { this.chunks.push(Buffer.from(chunk)); cb() }
    get text() { return Buffer.concat(this.chunks).toString('utf8') }
}
async function invoke(body: unknown, headers: Record<string, string> = {}, method = 'POST', opts = options) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
        method, url: '/posthog-mcp?cursor=123', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    })
    const res = new Capture()
    await handlePosthogMcp(req as unknown as IncomingMessage, res as unknown as ServerResponse, opts)
    return res
}

describe('PostHog proxy adapter', () => {
    test('requires the Lens bearer, fails closed when disabled and only allows MCP methods', async () => {
        for (const authorization of ['', 'Bearer wrong', 'Basic lens-secret']) assert.equal((await invoke({}, { authorization })).statusCode, 401)
        assert.equal((await invoke({}, {}, 'POST', { ...options, token: '' })).statusCode, 401)
        assert.equal((await invoke({}, {}, 'POST', { ...options, enabled: false })).statusCode, 503)
        assert.equal((await invoke(undefined, {}, 'PUT')).statusCode, 405)
        assert.equal((await invoke(call('call vision-query {}'))).statusCode, 200)
    })
    test('passes methods, sessions, protocol and content negotiation, replacing authorization', async (t) => {
        const seen: { url: string; init: RequestInit }[] = []
        t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
            seen.push({ url: url.toString(), init })
            return new Response(JSON.stringify(fixture.initialize), { status: 201, headers: {
                'content-type': 'application/json', 'mcp-session-id': 'upstream-session', 'mcp-protocol-version': '2025-06-18', accept: 'application/json',
            } })
        })
        for (const method of ['POST', 'GET', 'DELETE']) {
            const res = await invoke(method === 'POST' ? { method: 'initialize' } : undefined, { 'mcp-session-id': 'client-session', 'mcp-protocol-version': '2025-06-18' }, method)
            assert.equal(res.statusCode, 201)
            for (const [name, value] of [['content-type', 'application/json'], ['mcp-session-id', 'upstream-session'], ['mcp-protocol-version', '2025-06-18'], ['accept', 'application/json']]) assert.equal(res.headers.get(name), value)
            assert.match(JSON.parse(res.text).result.instructions, /Lens server \(reval-lens\)/)
            const request = seen.at(-1)!
            assert.equal(request.url, options.url + '?cursor=123')
            assert.equal(request.init.method, method)
            const headers = new Headers(request.init.headers)
            assert.equal(headers.get('authorization'), 'Bearer upstream-secret')
            assert.equal(headers.get('mcp-session-id'), 'client-session')
            assert.equal(headers.get('mcp-protocol-version'), '2025-06-18')
            assert.equal(headers.get('accept'), 'application/json, text/event-stream')
            assert.equal(headers.get('content-type'), 'application/json')
        }
    })
    test('streams chunked UTF-8 SSE, preserving comments, ids, event lines and CRLF', async (t) => {
        const data = `: keepalive\r\nid: résumé\r\nevent: message\r\ndata: ${JSON.stringify(fixture.initialize)}\r\n\ndata: ${JSON.stringify(fixture.tools_list)}\n\n`
        const bytes = Buffer.from(data)
        t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
            for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.subarray(i, i + 17))
            controller.close()
        } }), { headers: { 'content-type': 'text/event-stream' } }))
        const res = await invoke({ method: 'initialize' })
        assert.equal(res.text, data.split('\n').map((line) => rewriteSseLine(line, options.name)).join('\n'))
    })
    test('mixed batches refuse replays locally and forward only permitted requests', async (t) => {
        t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
            assert.deepEqual(JSON.parse(String(init.body)), [call('call query-trends {}', 4)])
            return new Response(JSON.stringify([{ jsonrpc: '2.0', id: 4, result: { content: [] } }]), { headers: { 'content-type': 'application/json' } })
        })
        const res = await invoke([call('call vision-query {}'), call('call query-trends {}', 4)])
        const batch = JSON.parse(res.text)
        assert.equal(batch.length, 2)
        assert.equal(batch[0].id, 4)
        assert.equal(batch[1].id, 3)
        assert.equal(batch[1].error.code, -32602)
    })
    test('limits request and response bodies and hides upstream error details', async (t) => {
        const opts = { ...options, maxBodyBytes: 100 }
        assert.equal((await invoke({ padding: 'x'.repeat(101) }, {}, 'POST', opts)).statusCode, 413)
        // One mock, changed in place: mocking fetch twice in a test leaves the first mock installed afterwards.
        const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(101)))
        assert.equal((await invoke({}, {}, 'POST', opts)).statusCode, 413)
        fetchMock.mock.mockImplementation(async () => { throw new Error(options.apiKey) })
        const res = await invoke({})
        assert.equal(res.statusCode, 502)
        assert.ok(!res.text.includes(options.apiKey))
    })
    test('times out upstream calls', async (t) => {
        t.mock.method(globalThis, 'fetch', (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }))
        assert.equal((await invoke({}, {}, 'POST', { ...options, timeoutMs: 10 })).statusCode, 504)
    })
})

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
}

test('HTTP proxy against a real loopback upstream: auth, sessions, status, methods and replay refusal', async (t) => {
    const seen: { method?: string; headers: IncomingMessage['headers']; body: string }[] = []
    const upstream = createServer(async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        seen.push({ method: req.method, headers: req.headers, body })
        res.writeHead(req.method === 'POST' ? 200 : 202, { 'content-type': 'application/json', 'mcp-session-id': 'real-session', 'mcp-protocol-version': '2025-06-18' })
        res.end(JSON.stringify(fixture.initialize))
    })
    let url: string
    try { url = await listen(upstream) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('sandbox forbids 127.0.0.1 listen; adapter coverage runs without sockets above')
        throw error
    }
    const proxy = createServer((req, res) => void handlePosthogMcp(req, res, { ...options, url }))
    t.after(async () => { await close(proxy); await close(upstream) })
    const endpoint = await listen(proxy)
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401)
    assert.equal(seen.length, 0)
    for (const method of ['POST', 'GET', 'DELETE']) {
        const res = await fetch(endpoint, { method, headers: { authorization: 'Bearer lens-secret', 'mcp-session-id': 'sent-session', 'mcp-protocol-version': '2025-06-18', accept: 'application/json', 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ method: 'initialize' }) : undefined })
        assert.equal(res.status, method === 'POST' ? 200 : 202)
        assert.equal(res.headers.get('mcp-session-id'), 'real-session')
        assert.equal(res.headers.get('mcp-protocol-version'), '2025-06-18')
        assert.match((await res.json() as typeof fixture.initialize).result.instructions, /Lens server \(reval-lens\)/)
        assert.equal(seen.at(-1)!.method, method)
        assert.equal(seen.at(-1)!.headers.authorization, 'Bearer upstream-secret')
        assert.equal(seen.at(-1)!.headers['mcp-session-id'], 'sent-session')
        assert.equal(seen.at(-1)!.headers['mcp-protocol-version'], '2025-06-18')
    }
    const res = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer lens-secret' }, body: JSON.stringify(call('call session-recording-get {}')) })
    assert.match(JSON.stringify(await res.json()), /get_replay_link/)
    assert.equal(seen.length, 3)
})
