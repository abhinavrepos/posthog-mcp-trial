import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { startEgress } from '../src/core/egress.ts'

test('egress tunnels allowed hosts case-insensitively and refuses other names, literal IPs and HTTP targets', async () => {
    const echo = createServer(socket => socket.pipe(socket))
    echo.listen(0, '127.0.0.1')
    await once(echo, 'listening')
    const port = (echo.address() as { port: number }).port
    const proxy = await startEgress([`LOCALHOST:${port}`])               // a named port: only that port
    async function request(target: string, method = 'CONNECT') {
        const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1')
        await once(socket, 'connect')
        socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
        const [chunk] = await once(socket, 'data') as [Buffer]
        return { socket, response: chunk.toString() }
    }
    try {
        const allowed = await request('localhost:' + port)
        assert.match(allowed.response, /200 Connection Established/)
        allowed.socket.write('tunnel-data')
        assert.equal(String((await once(allowed.socket, 'data'))[0]), 'tunnel-data')
        allowed.socket.destroy()
        for (const [target, method] of [['denied.example:443', 'CONNECT'], ['127.0.0.1:' + port, 'CONNECT'], ['169.254.169.254:80', 'CONNECT'], ['http://10.0.0.1/private', 'GET']]) {
            const result = await request(target!, method)
            assert.match(result.response, /403/)
            result.socket.destroy()
        }
    } finally { await proxy.close(); await new Promise<void>(resolve => echo.close(() => resolve())) }
})

test('Chrome can reach the egress proxy: its address is excluded from the catch-all DNS rule', async () => {
    // Chrome applies --host-resolver-rules to the proxy address too; "MAP * ~NOTFOUND" alone made every
    // clip fail with ERR_PROXY_CONNECTION_FAILED (checked with the real chrome-headless-shell).
    const { hostResolverRules } = await import('../src/core/clip.ts')
    const rules = hostResolverRules().split(', ')
    assert.equal(rules[0], 'MAP * ~NOTFOUND')
    assert.ok(rules.includes('EXCLUDE 127.0.0.1'))
})

test('an allowed name opens ports 80 and 443 only, unless an entry names its port', async () => {
    const proxy = await startEgress(['localhost', 'app.internal:8443'])
    async function connectTo(target: string) {
        const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1')
        await once(socket, 'connect')
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
        const [chunk] = await once(socket, 'data') as [Buffer]
        socket.destroy()
        return chunk.toString().split('\r\n')[0]
    }
    try {
        for (const target of ['localhost:5432', 'localhost:8123', 'localhost:8080', 'app.internal:443']) assert.match(await connectTo(target), /403/, target)
    } finally { await proxy.close() }
})

test('a port written out, even a default one, opens only that port; a scheme alone opens its own port', async () => {
    const proxy = await startEgress(['localhost:80', 'https://secure.internal', '[::1]:8080'])
    async function connectTo(target: string) {
        const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1')
        await once(socket, 'connect')
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
        const [chunk] = await once(socket, 'data') as [Buffer]
        socket.destroy()
        return chunk.toString().split('\r\n')[0]
    }
    try {
        for (const target of ['localhost:443', 'secure.internal:80', '[::1]:443']) assert.match(await connectTo(target), /403/, target)
    } finally { await proxy.close() }
})
