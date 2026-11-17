import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'

// Exercise the shared signed-link, captioned-download and clip-page streamer without a socket.
const text = readFileSync('src/service/replays.ts', 'utf8')
const source = stripTypeScriptTypes(text.slice(text.indexOf('export function streamMp4'), text.indexOf('\nconst SAFE_NAME')).replace('export ', ''))
function fixture(options: { statError?: string; streamError?: string; afterData?: boolean } = {}) {
    const headers = new Map<string, string>()
    let status = 0, sent = false, body = '', opened = 0
    const res = Object.assign(new Writable({ write(chunk, _encoding, done) { sent = true; body += chunk; done() } }), {
        get headersSent() { return sent },
        writeHead(code: number, values: Record<string, string>) { status = code; for (const [k, v] of Object.entries(values)) headers.set(k, v); return this },
        removeHeader(name: string) { headers.delete(name) },
    })
    Object.defineProperty(res, 'headersSent', { get: () => sent })
    const streamMp4 = new Function('statSync', 'createReadStream', `${source};return streamMp4`)(
        () => { if (options.statError) throw Object.assign(Error('stat failed'), { code: options.statError }); return { size: 10 } },
        () => {
            opened++
            const stream = new Readable({ read() {} })
            setImmediate(() => {
                if (options.afterData) { stream.emit('open', 1); stream.push('video') }
                if (options.streamError) stream.destroy(Object.assign(Error('read failed'), { code: options.streamError }))
                else { stream.emit('open', 1); stream.push('video'); stream.push(null) }
            })
            return stream
        }
    ) as (req: IncomingMessage, res: ServerResponse, file: string) => void
    const call = (range?: string) => streamMp4({ headers: { range } } as IncomingMessage, res as unknown as ServerResponse, '/synthetic.mp4')
    return { call, res, headers, status: () => status, body: () => body, opened: () => opened }
}
for (const range of [undefined, 'bytes=0-4']) for (const code of ['ENOENT', 'EIO']) test(`MP4 open error ${code}, range ${range ?? 'full'}, returns a clean response`, async () => {
    const f = fixture({ streamError: code }); f.call(range)
    await new Promise<void>(resolve => f.res.on('finish', resolve))
    assert.equal(f.status(), code === 'ENOENT' ? 404 : 500)
    assert.equal(f.headers.has('content-length'), false); assert.equal(f.headers.has('content-range'), false)
    assert.match(f.body(), /Clip (not found|unavailable)/)
})
test('MP4 missing before stat returns 404 without opening a stream', () => {
    const f = fixture({ statError: 'ENOENT' }); f.call()
    assert.equal(f.status(), 404); assert.equal(f.opened(), 0)
})
test('MP4 read failure after headers destroys the response and is observed', async () => {
    const f = fixture({ streamError: 'EIO', afterData: true }); f.call()
    await new Promise<void>(resolve => f.res.on('close', resolve))
    assert.equal(f.res.destroyed, true); assert.equal(f.status(), 200)
})
test('MP4 successful ranges and invalid ranges keep their status and byte bounds', async () => {
    const f = fixture(); f.call('bytes=2-5')
    await new Promise<void>(resolve => f.res.on('finish', resolve))
    assert.equal(f.status(), 206); assert.equal(f.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(f.headers.get('content-length'), '4')
    const bad = fixture(); bad.call('bytes=20-')
    assert.equal(bad.status(), 416); assert.equal(bad.opened(), 0)
})
