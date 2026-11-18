import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

const dir = mkdtempSync(join(tmpdir(), 'lens-mcp-posthog-blockers-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json' })
const { posthogExec, handlePosthogMcp } = await import('../src/mcp/posthog-proxy.ts')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

for (const stage of ['initialize', 'tools/call']) test(`posthog_exec consumes a complete ${stage} SSE reply without waiting for connection close`, async t => {
    let cancelled = false
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        if (init.method === 'DELETE') return new Response(null, { status: 202 })
        const body = JSON.parse(String(init.body))
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: 'Résumé 🦔' }] }
        if (body.method !== stage) return Response.json({ id: body.id, result })
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                // Progress and a pretty-printed SSE event, split through multibyte UTF-8 characters.
                const data = `: heartbeat\r\ndata: {"method":"notifications/progress","params":{}}\r\n\r\nevent: message\r\ndata: {"id":${body.id},\r\ndata: "result":${JSON.stringify(result)}}\r\n\r\n`
                const bytes = Buffer.from(data)
                for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3))
                init.signal!.addEventListener('abort', () => controller.error(Error('upstream deadline')), { once: true })
                // The upstream keeps the connection open after returning the complete reply.
            },
            cancel() { cancelled = true },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'session' } })
    })
    const result = await posthogExec('call docs-search {"query":"SDK"}', { url: 'http://127.0.0.1/mcp', apiKey: 'test', name: 'lens', timeoutMs: 100 })
    assert.equal(result.content[0].text, 'Résumé 🦔')
    assert.equal(cancelled, true, 'release the upstream stream as soon as the matching reply is read')
})

class Capture extends Writable {
    statusCode = 200
    headersSent = false
    headers = new Map<string, string>()
    chunks: Buffer[] = []
    setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value) }
    writeHead(status: number, headers: Record<string, string> = {}) {
        this.statusCode = status; this.headersSent = true
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
        return this
    }
    _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void) { this.chunks.push(Buffer.from(chunk)); cb() }
}

for (const sse of [false, true]) test(`proxy analytics batch retains successful replies when one member is rate limited upstream (${sse ? 'SSE' : 'JSON'})`, async t => {
    const seen: number[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)); seen.push(body.id)
        if (body.id === 2) return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '12' } })
        const reply = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `answer ${body.id}` }] } }
        if (!sse) return Response.json(reply)
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(Buffer.from(`data: ${JSON.stringify(reply)}\n\n`))
                init.signal!.addEventListener('abort', () => controller.error(Error('upstream deadline')), { once: true })
            },
        }), { headers: { 'content-type': 'text/event-stream' } })
    })
    const body = [1, 2, 3].map(id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'exec', arguments: { command: 'call query-trends {}' } } }))
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: '/posthog-mcp', headers: { authorization: 'Bearer local', 'content-type': 'application/json' } })
    const res = new Capture()
    await handlePosthogMcp(req as unknown as IncomingMessage, res as unknown as ServerResponse, {
        url: 'http://127.0.0.1/mcp', apiKey: 'test', name: 'lens', token: 'local', enabled: true,
    })
    assert.equal(res.statusCode, 200, 'an individual failure must remain attached to its own JSON-RPC request id')
    const replies = JSON.parse(Buffer.concat(res.chunks).toString()).sort((a: { id: number }, b: { id: number }) => a.id - b.id)
    assert.deepEqual(seen, [1, 2, 3])
    assert.deepEqual(replies.map((r: { id: number }) => r.id), [1, 2, 3])
    assert.equal(replies[0].result.content[0].text, 'answer 1')
    assert.match(JSON.stringify(replies[1]), /retry after 12 seconds/)
    assert.equal(replies[2].result.content[0].text, 'answer 3')
})
