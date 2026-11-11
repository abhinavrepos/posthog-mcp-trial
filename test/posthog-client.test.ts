// The PostHog client over a REAL HTTP connection (a local server standing in for PostHog), not a stubbed
// fetch. Every other test stubs fetch, which once hid a bug where every real request failed: an Agent
// from the npm undici package was passed to Node's built-in fetch, whose undici version differs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'

const seen: { path: string; auth: string; body: any }[] = []
let active = 0, peak = 0
const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 40))
    active--
    seen.push({ path: req.url || '', auth: String(req.headers.authorization || ''), body: raw ? JSON.parse(raw) : undefined })
    const query = seen.at(-1)!.body?.query?.query || ''
    if (/boom/.test(query)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ detail: 'bad query' })) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ columns: ['x', 'q'], results: [[1, query.length]] }))
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
after(() => server.close())
const port = (server.address() as AddressInfo).port
Object.assign(process.env, { POSTHOG_HOST: `http://127.0.0.1:${port}`, POSTHOG_PERSONAL_API_KEY: 'phx_real_http_test', POSTHOG_PROJECT_ID: '7', POSTHOG_CONNECTIONS: '3' })
const { hogql } = await import('../src/core/posthog.ts')

test('a real HTTP request reaches PostHog and comes back as rows', async () => {
    const rows = await hogql('SELECT 1 AS x LIMIT 1')
    assert.deepEqual(rows, [{ x: 1, q: 'SELECT 1 AS x LIMIT 1'.length }])
    const last = seen.at(-1)!
    assert.equal(last.path, '/api/projects/7/query/')
    assert.equal(last.auth, 'Bearer phx_real_http_test')
    assert.equal(last.body.query.kind, 'HogQLQuery')
})

test('errors carry PostHog\'s message and status over a real connection', async () => {
    await assert.rejects(hogql('SELECT boom LIMIT 1'), (e: any) => e.status === 400 && /bad query/.test(e.message))
})

test('at most POSTHOG_CONNECTIONS queries run at once; the rest wait their turn', async () => {
    peak = 0
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => hogql(`SELECT ${i} AS x LIMIT 1`)))
    assert.equal(rows.length, 8)
    assert.ok(peak <= 3, `peak ${peak}`)
    assert.ok(peak >= 2, 'queries do run in parallel')
})
