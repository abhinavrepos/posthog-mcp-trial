import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { test } from 'node:test'
import { brotliCompress, brotliDecompressSync, constants, gzip, gunzipSync } from 'node:zlib'
import { stripTypeScriptTypes } from 'node:module'

// server.ts is the service entry point. Evaluate its actual adapter without starting workers/listeners.
const source = readFileSync('src/service/server.ts', 'utf8')
const adapter = source.slice(source.indexOf('export function compressResponse'), source.indexOf('const server = createServer'))
const compressResponse = new Function('brotliCompress', 'constants', 'gzip',
    stripTypeScriptTypes(adapter.replace('export function', 'function')) + '\nreturn compressResponse'
)(brotliCompress, constants, gzip) as (req: IncomingMessage, res: ServerResponse) => void

// No listening sockets needed: exercise the same adapter with Node's response contract.
class ResponseCapture {
    headers = new Map<string, string | number | string[]>()
    headersSent = false
    destroyed = false
    statusCode = 200
    statusMessage = ''
    chunks: Buffer[] = []
    resolve!: () => void
    finished = new Promise<void>(resolve => { this.resolve = resolve })
    setHeader(key: string, value: string | number | string[]) { this.headers.set(key.toLowerCase(), value); return this }
    getHeader(key: string) { return this.headers.get(key.toLowerCase()) }
    hasHeader(key: string) { return this.headers.has(key.toLowerCase()) }
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this }
    flushHeaders() { this.headersSent = true }
    write(chunk: string | Buffer) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); return true }
    end(chunk?: string | Buffer, callback?: () => void) {
        if (chunk) this.chunks.push(Buffer.from(chunk))
        this.headersSent = true
        callback?.()
        this.resolve()
        return this
    }
    get body() { return Buffer.concat(this.chunks) }
}
const html = '<html>' + 'Lens page content '.repeat(1000) + '</html>'
async function response(options: { accept?: string; type?: string; text?: string; headers?: Record<string, string | undefined>; method?: string; range?: string; status?: number; stream?: boolean } = {}) {
    const capture = new ResponseCapture()
    const req = { method: options.method || 'GET', headers: { 'accept-encoding': options.accept, range: options.range } } as IncomingMessage
    const res = capture as unknown as ServerResponse
    compressResponse(req, res)
    for (const [key, value] of Object.entries({ 'content-type': options.type || 'text/html; charset=utf-8', ...options.headers })) res.setHeader(key, value)
    res.writeHead(options.status || 200)
    if (options.stream) res.write('first chunk\n')
    res.end(options.text ?? html)
    await capture.finished
    return capture
}

test('HTML and JSON compress with Brotli/gzip and preserve body meaning', async () => {
    for (const [accept, encoding] of [['br, gzip', 'br'], ['gzip', 'gzip'], ['br;q=0.1, gzip;q=0.9', 'gzip']]) {
        for (const type of ['text/html', 'application/json', 'application/problem+json']) {
            const text = type === 'text/html' ? html : JSON.stringify({ content: html })
            const r = await response({ accept, type, text, headers: { vary: 'Origin', 'content-length': String(Buffer.byteLength(text)), etag: '"identity"' } })
            assert.equal(r.getHeader('content-encoding'), encoding)
            assert.equal((encoding === 'br' ? brotliDecompressSync(r.body) : gunzipSync(r.body)).toString(), text)
            assert.equal(Number(r.getHeader('content-length')), r.body.length)
            assert.equal(r.getHeader('vary'), 'Origin, Accept-Encoding')
            assert.equal(r.getHeader('etag'), 'W/"identity"')
        }
    }
})

test('no encoding, zero quality, small/oversized bodies and no-transform remain identity', async () => {
    for (const accept of [undefined, 'identity', 'br;q=0, gzip;q=0', '*;q=0', 'br;q=0, *;q=0.5']) {
        const r = await response({ accept })
        if (accept === 'br;q=0, *;q=0.5') assert.equal(r.getHeader('content-encoding'), 'gzip')
        else { assert.equal(r.getHeader('content-encoding'), undefined); assert.equal(r.body.toString(), html) }
    }
    for (const options of [{ text: 'small' }, { text: 'a'.repeat(4 * 1024 * 1024 + 1) }, { headers: { 'cache-control': 'private, no-transform' } }, { method: 'HEAD' }]) {
        const r = await response({ accept: 'br, gzip', ...options })
        assert.equal(r.getHeader('content-encoding'), undefined)
    }
})

test('compression can be disabled via the service environment', async () => {
    const saved = process.env.LENS_HTTP_COMPRESSION
    try {
        process.env.LENS_HTTP_COMPRESSION = 'off'
        const r = await response({ accept: 'br' })
        assert.equal(r.getHeader('content-encoding'), undefined)
        assert.equal(r.body.toString(), html)
    } finally {
        if (saved === undefined) delete process.env.LENS_HTTP_COMPRESSION
        else process.env.LENS_HTTP_COMPRESSION = saved
    }
})

test('SSE, flushed headers and incremental writes remain unbuffered', async () => {
    const r = await response({ accept: 'br', type: 'text/event-stream', text: `data: ${html}\n\n`, stream: true })
    assert.equal(r.getHeader('content-encoding'), undefined)
    assert.equal(r.body.toString(), `first chunk\ndata: ${html}\n\n`)
    const capture = new ResponseCapture()
    const res = capture as unknown as ServerResponse
    compressResponse({ method: 'GET', headers: { 'accept-encoding': 'gzip' } } as IncomingMessage, res)
    res.setHeader('content-type', 'application/json')
    res.writeHead(200)
    res.flushHeaders()
    assert.equal(capture.headersSent, true)
    res.end(html)
    await capture.finished
    assert.equal(capture.getHeader('content-encoding'), undefined)
    assert.equal(capture.body.toString(), html)
    const streamed = await response({ accept: 'gzip', type: 'application/json', stream: true })
    assert.equal(streamed.getHeader('content-encoding'), undefined)
})

test('clip ranges, media and existing content encodings remain byte-for-byte unchanged', async () => {
    for (const options of [
        { type: 'video/mp4' },
        { type: 'video/mp4', range: 'bytes=100-200', status: 206, headers: { 'content-range': 'bytes 100-200/999', 'content-length': String(Buffer.byteLength(html)) } },
        { status: 206, headers: { 'content-range': 'bytes 100-200/999' } },
        { headers: { 'content-encoding': 'gzip' } },
    ]) {
        const r = await response({ accept: 'br, gzip', ...options })
        assert.equal(r.body.toString(), html)
        assert.equal(r.getHeader('content-encoding'), options.headers?.['content-encoding'])
        if (options.range) {
            assert.equal(r.statusCode, 206)
            assert.equal(r.getHeader('content-range'), 'bytes 100-200/999')
            assert.equal(r.getHeader('content-length'), String(Buffer.byteLength(html)))
        }
    }
})

test('only fingerprinted PostHog static paths get immutable caching', () => {
    const caddy = readFileSync('deploy/posthog/tuning-static.caddy', 'utf8')
    assert.match(caddy, /max-age=31536000, immutable/)
    const pattern = caddy.split('\n').find(x => x.includes('path_regexp'))!.trim().split(' ').at(-1)!
    const match = new RegExp(pattern)
    // PostHog's build names files name-HASH.ext with an uppercase letters-and-digits hash.
    for (const hashed of ['/static/stylesEagerTailwind-YDFOWSD6.css', '/static/index-S63B2BAAB92.js', '/static/chunk-AB12CD34.js.map', '/static/main-AB12CD34.css.br'])
        assert.ok(match.test(hashed), hashed)
    for (const plain of ['/static/surveys.js', '/static/recorder.js', '/static/posthog-recorder.js', '/static/lazy-recorder.js', '/static/toolbar.js', '/static/array.full.js', '/api/projects/1/data-AB12CD34.js'])
        assert.ok(!match.test(plain), plain)
})

test('the adapter preserves native Node HTTP framing without a listening socket', async () => {
    for (const stream of [false, true]) {
        const chunks: Buffer[] = []
        const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
        const req = new IncomingMessage(socket as Socket)
        req.method = 'GET'
        req.headers = { 'accept-encoding': 'gzip' }
        const res = new ServerResponse(req)
        res.assignSocket(socket as Socket)
        compressResponse(req, res)
        const finished = new Promise<void>(resolve => res.on('finish', resolve))
        if (stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            assert.equal(res.headersSent, true)
            res.write('data: first\n\n')
            assert.equal(res.headersSent, true)
            res.end('data: last\n\n')
        } else {
            res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(Buffer.byteLength(html)) })
            res.end(html)
        }
        await finished
        const wire = Buffer.concat(chunks)
        const boundary = wire.indexOf('\r\n\r\n')
        assert.ok(boundary > 0)
        const head = wire.subarray(0, boundary).toString()
        if (stream) {
            assert.doesNotMatch(head, /content-encoding/i)
            assert.match(wire.toString(), /data: first/)
            assert.match(wire.toString(), /data: last/)
        } else {
            assert.match(head, /content-encoding: gzip/i)
            const body = wire.subarray(boundary + 4)
            assert.equal(gunzipSync(body).toString(), html)
            assert.match(head, new RegExp(`content-length: ${body.length}`, 'i'))
        }
        socket.destroy()
    }
})
