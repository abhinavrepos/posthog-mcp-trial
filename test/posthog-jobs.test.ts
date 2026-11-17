import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const dir = mkdtempSync(join(tmpdir(), 'posthog-jobs-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'm.db'), TASKS_DB: join(dir, 't.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', LENS_MCP_CALLS_PER_MINUTE: '60' }) // budget mechanics are tested at 60/min
const { wrapTools } = await import('../src/mcp/tools.ts')
const { installJobTools } = await import('../src/mcp/jobtools.ts')
const { JobRunner } = await import('../src/core/jobs.ts')
const { guardTransport } = await import('../src/mcp/anonymise.ts')
const { posthogExec } = await import('../src/mcp/posthog-proxy.ts')
const { isPosthogQuery, PosthogQueryGate } = await import('../src/mcp/posthog-query.ts')
const { setAnonymise } = await import('../src/core/anonymise.ts')
const { db, all } = await import('../src/core/db.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const opts = { url: 'http://127.0.0.1:8787/mcp', apiKey: 'secret', name: 'lens', timeoutMs: 2 }
const text = (v: unknown) => JSON.stringify(v)
const tick = () => new Promise<void>(r => setImmediate(r))
async function setup(who: string, budgetMs = 5, upstreamOptions = opts) {
    const store = new DatabaseSync(':memory:'), runner = new JobRunner(store, { concurrency: 1 })
    const server = new McpServer({ name: 'test', version: '1' })
    installJobTools(server, wrapTools(server, false, { who }, { runner, budgetMs }))
    server.registerTool('posthog_exec', { inputSchema: { command: z.string() } }, async ({ command }) => posthogExec(command, upstreamOptions))
    const client = new Client({ name: 'test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); guardTransport(a); await client.connect(b)
    return { client, runner, close: async () => { await client.close(); await server.close(); runner.close(); store.close() } }
}
const call = (c: Client, command: string) => c.callTool({ name: 'posthog_exec', arguments: { command } })
const poll = (c: Client, job_id: string) => c.callTool({ name: 'get_job_result', arguments: { job_id } })
const handle = (r: any) => JSON.parse(r.content[0].text).job_id as string
/** HTTP-shaped fake used by fetch fallback and by the real loopback server below. */
function fakeMcp(onCall: (body: any, signal?: AbortSignal | null) => Promise<Response>) {
    return async (body: any, signal?: AbortSignal | null): Promise<Response> => {
        if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'session' } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return onCall(body, signal)
    }
}
const answer = () => Response.json({ id: 2, result: { content: [{ type: 'text', text: 'person@example.com paid $123.45' }] } })

test('command classification keeps lookups and object reads synchronous', () => {
    for (const c of ['tools', 'help', 'search query-funnel', 'info query-trends', 'schema insight-get', 'call docs-search {}', 'call insights-list {}', 'call insight-get {"refresh":false}', 'call dashboard-get {}', 'call event-definitions-list {}']) assert.equal(isPosthogQuery(c), false, c)
    for (const c of ['call query-funnel {}', 'CALL --json POSTHOG:query-retention {}', 'call "query-paths" {}', 'call execute-sql {}', 'call insight-refresh {}', 'call dashboard-get {"refresh":true}', 'call insights-query {}']) assert.equal(isPosthogQuery(c), true, c)
})

test('slow query returns a handle, shares flight, uses long timeout, masks polling and audits', async t => {
    process.env.LENS_POSTHOG_QUERY_TIMEOUT_SECONDS = '600'
    let release!: () => void, queries = 0, deletes = 0
    const fake = fakeMcp(async (_body, signal) => { queries++; await new Promise<void>((r, j) => { release = r; signal?.addEventListener('abort', () => j(Error('aborted'))) }); return answer() })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { if (init.method === 'DELETE') { deletes++; return new Response(null, { status: 202 }) } return fake(JSON.parse(String(init.body)), init.signal) })
    const c = await setup('slow-posthog')
    try {
        const first = await call(c.client, 'call query-funnel {}'), id = handle(first)
        assert.match(id, /^[0-9a-f]{32}$/)
        assert.equal(handle(await call(c.client, 'call query-funnel {}')), id)
        await new Promise(r => setTimeout(r, 25)) // exceeds synchronous upstream's 2ms limit
        assert.equal(queries, 1)
        release(); await tick(); await tick()
        const result = await poll(c.client, id)
        assert.ok(!result.isError, text(result)); assert.doesNotMatch(text(result), /person@example.com|123\.45/)
        assert.equal(deletes, 1)
        const rows = all<any>('SELECT * FROM tool_audit WHERE user_email=? ORDER BY id', 'slow-posthog')
        assert.equal(rows.length, 3); assert.equal(rows[0].result_kind, 'job_started'); assert.equal(rows[2].result_kind, 'job_result'); assert.equal(rows[0].job_hash, rows[2].job_hash)
    } finally { await c.close() }
})

test('cheap commands remain synchronous; heavy calls cost five and all calls are audited', async t => {
    const fake = fakeMcp(async () => answer())
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => init.method === 'DELETE' ? new Response(null, { status: 202 }) : fake(JSON.parse(String(init.body)), init.signal))
    const c = await setup('posthog-weight', 1000)
    try {
        for (const command of ['tools', 'call docs-search {}']) { const r = await call(c.client, command); assert.ok(!r.isError); assert.doesNotMatch(text(r), /job_id/) }
        for (let i = 0; i < 11; i++) assert.ok(!(await call(c.client, 'call query-trends {}')).isError)
        assert.match(text(await call(c.client, 'call query-trends {}')), /Rate limit/)
        assert.equal(all<any>('SELECT * FROM tool_audit WHERE user_email=?', 'posthog-weight').length, 14)
    } finally { await c.close() }
})

test('global analytics gate caps at three and queues FIFO, rejecting overflow and removing cancelled waiters', async () => {
    const gate = new PosthogQueryGate(3, 1), controllers = Array.from({ length: 6 }, () => new AbortController())
    const starts: number[] = [], releases: (() => void)[] = []
    const run = (i: number) => gate.run(controllers[i].signal, async () => { starts.push(i); await new Promise<void>(r => { releases[i] = r }) })
    const jobs = [0, 1, 2, 3].map(run); await tick(); assert.deepEqual(starts, [0, 1, 2])
    await assert.rejects(run(4), /PostHog is busy. Retry later/)
    releases[1](); await tick(); assert.deepEqual(starts, [0, 1, 2, 3])
    const cancelled = run(5); controllers[5].abort(); await assert.rejects(cancelled, /cancelled/)
    releases[0](); releases[2](); releases[3](); await Promise.all(jobs)
})

for (const failure of ['memory', '429', 'timeout', '401', '503']) test(`upstream ${failure} has plain mapped errors with correlation ids`, async t => {
    const fake = fakeMcp(async (_body, signal) => {
        if (failure === 'memory') return Response.json({ id: 2, result: { isError: true, content: [{ type: 'text', text: 'Code: 241. DB::Exception: Memory limit exceeded SELECT secret' }] } })
        if (failure === 'timeout') return new Promise((_r, reject) => signal!.addEventListener('abort', () => reject(Error('SQL secret'))))
        return new Response('DB::Exception SELECT secret', { status: Number(failure), headers: { 'retry-after': '17' } })
    })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => init.method === 'DELETE' ? new Response(null, { status: 202 }) : fake(JSON.parse(String(init.body)), init.signal))
    const c = await setup(`error-${failure}`, 1000)
    try {
        // Cheap invocation exercises the short timeout; analytics error persistence is covered below.
        const r = await call(c.client, failure === 'timeout' ? 'tools' : 'call query-trends {}')
        assert.equal(r.isError, true); assert.match(text(r), /Correlation id:/); assert.doesNotMatch(text(r), /DB::Exception|Code: 241|SELECT|secret/)
        assert.match(text(r), failure === 'memory' ? /ran out of memory.*aggregate_events/ : failure === '429' ? /retry after 17 seconds/ : failure === 'timeout' ? /timed out.*continues as a job/ : failure === '401' ? /key's access/ : /Retry later/)
    } finally { await c.close() }
})

test('private SQL is refused before upstream; job cancellation aborts upstream and cleans session', async t => {
    let requests = 0, aborted = false
    const fake = fakeMcp(async (_body, signal) => new Promise((_r, j) => { signal!.addEventListener('abort', () => { aborted = true; j(Error('aborted')) }) }))
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests++; return init.method === 'DELETE' ? new Response(null, { status: 202 }) : fake(JSON.parse(String(init.body)), init.signal) })
    const c = await setup('private-posthog')
    try {
        setAnonymise({ mode: 'private', posthog: 'filter' })
        assert.match(text(await call(c.client, 'call execute-sql {"query":"select 1"}')), /Raw SQL/); assert.equal(requests, 0)
        setAnonymise({ mode: 'standard' })
        const id = handle(await call(c.client, 'call query-retention {}'))
        const stored = c.runner.db.prepare('SELECT revision FROM analysis_jobs WHERE id=?').get(id)!
        c.runner.cancel('private-posthog', id, String(stored.revision)); await tick()
        assert.equal(aborted, true); assert.match(text(await poll(c.client, id)), /Correlation id/)
        aborted = false
        const expired = handle(await call(c.client, 'call query-funnel {}'))
        c.runner.db.prepare('UPDATE analysis_jobs SET expires=? WHERE id=?').run(Date.now() - 1, expired)
        c.runner.prune(); await tick()
        assert.equal(aborted, true)
        assert.match(text(await poll(c.client, expired)), /Unknown or expired job id/)
    } finally { setAnonymise({ mode: 'standard' }); await c.close() }
})

test('fake upstream MCP HTTP server runs the job transport when loopback is available', async t => {
    const fake = fakeMcp(async () => { await new Promise(r => setTimeout(r, 25)); return answer() })
    const server = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const response = req.method === 'DELETE' ? new Response(null, { status: 202 }) : await fake(JSON.parse(raw)); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()) })
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('sandbox forbids loopback; identical fake MCP handler exercised through fetch above'); throw e }
    t.after(() => { server.closeAllConnections(); server.close() })
    const address = server.address() as { port: number }
    const c = await setup('loopback-posthog', 5, { ...opts, url: `http://127.0.0.1:${address.port}` })
    try {
        const id = handle(await call(c.client, 'call query-funnel {}'))
        await new Promise(r => setTimeout(r, 100))
        const r = await poll(c.client, id)
        assert.ok(!r.isError); assert.doesNotMatch(text(r), /person@example.com|123\.45/)
    } finally { await c.close() }
})

test('four analytics jobs across sessions share the global cap despite general worker concurrency one', async t => {
    let active = 0, peak = 0, calls = 0
    const release: (() => void)[] = []
    const fake = fakeMcp(async () => { const i = calls++; active++; peak = Math.max(peak, active); await new Promise<void>(r => { release[i] = r }); active--; return answer() })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => init.method === 'DELETE' ? new Response(null, { status: 202 }) : fake(JSON.parse(String(init.body)), init.signal))
    const clients = await Promise.all([0, 1, 2, 3].map(i => setup(`cap-${i}`)))
    try {
        const results = await Promise.all(clients.map(c => call(c.client, 'call query-funnel {}')))
        // Upstream calls start on later ticks: wait for each state (bounded) instead of assuming timing under load.
        const until = async (ok: () => boolean) => { const end = Date.now() + 5000; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 5)) }
        assert.ok(results.every(r => handle(r))); await until(() => calls === 3); assert.equal(calls, 3); assert.equal(peak, 3)
        release[0](); await until(() => calls === 4); assert.equal(calls, 4); assert.equal(peak, 3)
        release[1](); release[2](); release[3](); await tick(); await tick()
        for (let i = 0; i < clients.length; i++) assert.ok(!(await poll(clients[i].client, handle(results[i]))).isError)
    } finally { for (const c of clients) await c.close() }
})


test('static PostHog docs retain numeric examples and schemas through tool and transport boundaries', async t => {
    const docs = { content: [{ type: 'text', text: '"dateRange": {"date_from":"-180d"}, "minimum":-2147483648, "maximum":2147483647' }] }
    const fake = fakeMcp(async () => Response.json({ id: 2, result: docs }))
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => init.method === 'DELETE' ? new Response(null, { status: 202 }) : fake(JSON.parse(String(init.body)), init.signal))
    const c = await setup('static-docs', 1000)
    try {
        for (const command of ['tools', 'info query-lifecycle', 'schema query-paths']) assert.deepEqual(await call(c.client, command), docs)
        for (const command of ['call read-data-schema {}', 'info query-paths; call execute-sql {}', 'tools\ncall query-trends {}']) {
            const result = await call(c.client, command)
            assert.match(text(result), /<amount>/)
            assert.doesNotMatch(text(result), /2147483648/)
        }
    } finally { await c.close() }
})
