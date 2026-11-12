// Client anonymisation for AI: the matcher, the MCP guard on both servers, triage, and the web side.
// Canary clients have names no other text contains, so any trace of them in an AI-bound payload is a leak.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { after, describe, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const dir = mkdtempSync(join(tmpdir(), 'anon-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.POSTHOG_PERSONAL_API_KEY ||= 'phx_test'
const { db } = await import('../src/core/db.ts')
const A = await import('../src/core/anonymise.ts')
const { refreshRoster } = await import('../src/core/anonroster.ts')
const { guardRequest, guardResponse, guardTransport, revealArgs } = await import('../src/mcp/anonymise.ts')
const { handlePosthogMcp, anonRefusal } = await import('../src/mcp/posthog-proxy.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const CLIENTS = [
    { id: 'QZX901', name: 'Zorblax Treasury' },
    { id: 'KWAMBE', name: 'Kwambe Fintrust Holdings' },
    { id: 'VLT', name: 'Voltrino Bank' },
    { id: 'BETA', name: 'Betamax Capital' }, // a code that is also a word: matched only as written
]
const NEEDLES = ['QZX901', 'qzx901', 'Zorblax', 'zorblax', 'KWAMBE', 'Kwambe', 'Fintrust', 'Voltrino']
const leaks = (payload: unknown) => { const s = JSON.stringify(payload).toLowerCase(); return NEEDLES.filter((n) => s.includes(n.toLowerCase())).concat(/\bVLT\b/.test(JSON.stringify(payload)) ? ['VLT'] : []) }
A.syncClients(CLIENTS)
const cn = (id: string) => A.codenameOf(id)!

describe('codenames', () => {
    test('every client gets a stable, unique two-word codename that shares no word with any client', () => {
        const all = A.listCodenames()
        assert.equal(all.length, 4)
        assert.equal(new Set(all.map((c) => c.codename.toLowerCase())).size, 4)
        for (const c of all) {
            assert.match(c.codename, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
            for (const other of CLIENTS) for (const w of `${other.id} ${other.name}`.toLowerCase().split(/\W+/)) assert.ok(!c.codename.toLowerCase().split(' ').includes(w))
        }
        const before = cn('QZX901')
        A.syncClients([{ id: 'QZX901', name: 'Zorblax Treasury' }])
        assert.equal(cn('QZX901'), before, 'stays the same')
    })
    test('the list: 10,000 short codenames, unique, two words of 3 to 5 letters; new clients get one from it', async () => {
        const { CODENAMES, CODENAME_ADJECTIVES, CODENAME_ANIMALS } = await import('../src/core/codenames.ts')
        assert.equal(CODENAMES.length, 10_000)
        assert.equal(new Set(CODENAMES.map((c) => c.toLowerCase())).size, 10_000)
        assert.ok(CODENAMES.every((c) => /^[A-Z][a-z]{2,4} [A-Z][a-z]{2,4}$/.test(c) && c.length <= 11))
        const words = new Set([...CODENAME_ADJECTIVES, ...CODENAME_ANIMALS].map((w) => w.toLowerCase()))
        assert.equal(words.size, 200, 'no word in both lists')
        for (const w of ['gold', 'royal', 'bank', 'trust', 'capital', 'north', 'global', 'first', 'union', 'beta', 'delta']) assert.ok(!words.has(w), w)
        const list = new Set(CODENAMES)
        for (const c of A.listCodenames()) assert.ok(list.has(c.codename), c.codename)
        A.syncClients(Array.from({ length: 60 }, (_, i) => ({ id: `BULK${i}`, name: `Bulkco Number ${i}` })))
        const bulk = A.listCodenames().filter((c) => c.client.startsWith('BULK'))
        assert.equal(bulk.length, 60); assert.ok(bulk.every((c) => list.has(c.codename)))
    })
    test('admins rename, add other names, or draw a new codename; clashes and bad names are refused', () => {
        const r = A.setCodename('KWAMBE', { codename: 'Quiet Otter', aliases: 'KFH, Kwambe FT' }, 'admin@x')
        assert.equal(r.codename, 'Quiet Otter'); assert.deepEqual(r.aliases, ['KFH', 'Kwambe FT'])
        assert.throws(() => A.setCodename('QZX901', { codename: 'quiet otter' }, 'a'), /Another client/)
        assert.throws(() => A.setCodename('QZX901', { codename: 'Zorblax Fox' }, 'a'), /shares a word/)
        assert.throws(() => A.setCodename('QZX901', { codename: 'Voltrino Fox' }, 'a'), /another client/)
        assert.throws(() => A.setCodename('QZX901', { codename: '<b>x' }, 'a'), /letters/)
        assert.throws(() => A.setCodename('nope', { codename: 'Calm Owl' }, 'a'), /Unknown client/)
        const g = A.setCodename('QZX901', { regenerate: true }, 'a')
        assert.notEqual(g.codename.toLowerCase(), 'quiet otter')
    })
    test('legal and industry endings give automatic other names', () => {
        assert.deepEqual(A.autoAliases('Kwambe Fintrust Holdings'), ['Kwambe Fintrust'])
        assert.deepEqual(A.autoAliases('Northwind Treasury'), ['Northwind'])
        assert.deepEqual(A.autoAliases('Acme Corp Ltd'), ['Acme Corp', 'Acme'])
        assert.deepEqual(A.autoAliases('Ab Bank'), [], 'too short to be safe')
    })
})

describe('the matcher', () => {
    test('names in any case and spelling, codes, other names; trade ids and ordinary words stay', () => {
        const z = cn('QZX901'), k = cn('KWAMBE'), v = cn('VLT')
        const cases: [string, string][] = [
            ['Zorblax Treasury reported it', `${z} reported it`],
            ['ZORBLAX   treasury, zorblax_treasury, zorblax-treasury, Zorblax.Treasury', `${z}, ${z}, ${z}, ${z}`],
            ['Zorblax alone', `${z} alone`],
            ['client QZX901 and qzx901', `client ${z} and ${z}`],
            ['KFH and Kwambe FT and Kwambe Fintrust', `${k} and ${k} and ${k}`],
            ['VLT and vlt', `${v} and ${v}`],
            ['BETA is a client, beta is a word', `${cn('BETA')} is a client, beta is a word`],
            ['inside ids: QZX901-2026-001 and VLT_77; trade 4348 stays', `inside ids: ${z}-2026-001 and ${v}_77; trade 4348 stays`],
            ['Zorblaxian is another word', 'Zorblaxian is another word'],
            ['look-alikes: ＺＯＲＢＬＡＸ, Zor\u200Bblax, Zоrblax (Cyrillic o)', `look-alikes: ${z}, ${z}, ${z} (Cyrillic o)`],
            ['mail pat@zorblax-tr.com and pm@ion.example', 'mail [email hidden] and [email hidden]'],
        ]
        for (const [input, want] of cases) assert.equal(A.hideClients(input).text, want, input)
    })
    test('in links the codename slug goes where the client was, and URL-encoded names are found', () => {
        const slug = A.slug(cn('QZX901'))
        assert.equal(A.hideClients('Open /replays/dashboards?view=rescue&client=QZX901 now').text, `Open /replays/dashboards?view=rescue&client=${slug} now`)
        assert.equal(A.hideClients('https://lens.x/replays?q=Zorblax%20Treasury').text, `https://lens.x/replays?q=${slug}`)
        assert.equal(A.clientOfCodename(slug), 'QZX901')
        assert.equal(A.clientOfCodename(cn('QZX901').toUpperCase()), 'QZX901')
    })
    test('a renamed client: the new name and the old one are both hidden', () => {
        A.syncClients([{ id: 'VLT', name: 'Voltrino Neo Bank' }])
        assert.equal(A.hideClients('Voltrino Neo Bank was Voltrino Bank').text, `${cn('VLT')} was ${cn('VLT')}`)
    })
    test('a field that holds a client, with a client Lens has not listed yet, is masked', () => {
        const h = A.hideClientsDeep({ client: 'NEW777', client_name: 'Brand New Co', clients: ['QZX901', 'NEW777'], note: 'NEW777 is new' })
        assert.deepEqual(h.value, { client: '[client]', client_name: '[client]', clients: [cn('QZX901'), '[client]'], note: 'NEW777 is new' })
    })
    test('deep: keys, nested values and arrays', () => {
        const h = A.hideClientsDeep({ QZX901: { name: 'Zorblax Treasury', list: ['Voltrino Bank', 7, null] } })
        assert.deepEqual(leaks(h.value), [])
        assert.equal(h.n, 3)
    })
    test('codenames back into codes (for queries) and names (for people)', () => {
        assert.equal(A.revealCodenames(`where client = '${cn('QZX901')}' or '${A.slug(cn('VLT'))}'`), `where client = 'QZX901' or 'VLT'`)
        assert.equal(A.namesForCodenames(`${cn('KWAMBE')} is slower`), 'Kwambe Fintrust Holdings is slower')
    })
})

describe('the guard: requests', () => {
    const on = () => A.setAnonymise({ on: true })
    test('off: everything passes as it is', () => {
        A.setAnonymise({ on: false })
        const m = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'client_story', arguments: { client: 'QZX901' } } }
        assert.deepEqual(guardRequest(m).msg, m)
        assert.deepEqual(guardResponse({ text: 'Zorblax' }), { text: 'Zorblax' })
    })
    test('on: a codename becomes the client code; a real name or code anywhere is refused the same way as an unknown name', () => {
        on()
        const call = (name: string, args: unknown) => guardRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })
        assert.equal(call('client_story', { client: cn('QZX901') }).msg!.params.arguments.client, 'QZX901')
        assert.equal(call('client_story', { client: A.slug(cn('QZX901')) }).msg!.params.arguments.client, 'QZX901')
        assert.deepEqual(call('save_survey', { clients: [cn('VLT'), cn('KWAMBE')] }).msg!.params.arguments.clients, ['VLT', 'KWAMBE'])
        const refusals = [
            call('client_story', { client: 'QZX901' }), call('client_story', { client: 'Contoso' }),
            call('reval_brief', { question: 'how is zorblax doing?' }), call('save_survey', { clients: ['VLT'] }),
            call('x', { nested: { deep: ['Kwambe Fintrust'] } }), call('x', { 'Zorblax Treasury': 1 }),
            call('resolve_client', { query: 'Zorblax' }), call('resolve_client', { query: 'Contoso Ltd' }),
        ]
        for (const r of refusals) { assert.ok(r.answer, JSON.stringify(r)); assert.equal(r.answer!.result.content[0].text, A.REFUSAL) }
        assert.equal(call('resolve_client', { query: cn('KWAMBE') }).msg!.params.arguments.query, 'KWAMBE')
        assert.ok(call('resolve_client', { query: 'pat@example.com' }).answer, 'an email links a company domain to its codename')
        assert.ok(call('find_client_incidents', { client: cn('QZX901'), email: 'pat@zorblax.com' }).answer)
        assert.equal(call('reval_brief', { question: 'where do clients struggle?' }).msg!.params.arguments.question, 'where do clients struggle?')
        const prompt = guardRequest({ jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'where_clients_struggle', arguments: { client: 'Voltrino' } } })
        assert.equal(prompt.answer!.error.message, A.REFUSAL)
        const res = guardRequest({ jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'lens://client/QZX901' } })
        assert.equal(res.answer!.error.message, 'Not available while client anonymisation is on.', 'one fixed answer, whatever the address names')
        assert.throws(() => revealArgs('client_story', { client: 'QZX901' }))
        // With the server's registry: unknown tools get one fixed answer (never the name back), extra arguments go.
        const reg = { tools: () => new Map<string, string[] | null>([['screen_usage', ['screen', 'days']]]), prompts: () => new Map<string, string[] | null>() }
        for (const name of ['QZX901', 'qzx901', 'Contoso', 'nope']) assert.deepEqual(guardRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, 'lens_refused', reg).answer!.error, { code: -32602, message: 'Unknown tool.' })
        const probe = (v: string) => guardRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screen_usage', arguments: { screen: '/', unused: v } } }, 'lens_refused', reg)
        assert.deepEqual(probe('QZX901').msg!.params.arguments, { screen: '/' }, 'an argument the tool does not take is dropped, not matched')
        assert.deepEqual(probe('Contoso').msg!.params.arguments, { screen: '/' })
        const media = guardResponse({ result: { content: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'x://a', blob: 'AAAA' } }] } }) as any
        assert.match(media.result.content[0].text, /withheld/); assert.match(media.result.content[1].resource.text, /withheld/)
    })
})

describe('Lens MCP server, end to end through the guard', () => {
    test('tool lists, results, errors and prompts never carry a client; codenames reach the tools as codes', async () => {
        A.setAnonymise({ on: true })
        const seen: unknown[] = []
        const server = new McpServer({ name: 'lens', version: '1' }, { instructions: 'Clients like Zorblax Treasury (QZX901) are examples.' })
        server.registerTool('client_story', { description: 'Story of a client, e.g. Voltrino Bank', inputSchema: { client: z.string() } }, async ({ client }) => {
            seen.push(client)
            return { content: [{ type: 'text', text: `Client ${client}: Zorblax Treasury dropped. Open /replays/dashboards?client=${client}` }], structuredContent: undefined }
        })
        server.registerTool('boom', { description: 'fails', inputSchema: {} }, async () => { throw new Error('PostHog said: no rows for Kwambe Fintrust Holdings (KWAMBE)') })
        server.registerPrompt('where_clients_struggle', { argsSchema: { client: z.string() } }, ({ client }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Look at ${client} (Zorblax Treasury)` } }] }))
        const client = new Client({ name: 't', version: '0' })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await server.connect(a); guardTransport(a); await client.connect(b)
        const out: unknown[] = [client.getInstructions(), await client.listTools(), await client.listPrompts()]
        const story = await client.callTool({ name: 'client_story', arguments: { client: cn('QZX901') } })
        out.push(story, await client.callTool({ name: 'boom', arguments: {} }), await client.getPrompt({ name: 'where_clients_struggle', arguments: { client: cn('VLT') } }))
        const refused = await client.callTool({ name: 'client_story', arguments: { client: 'QZX901' } })
        out.push(refused)
        assert.deepEqual(seen, ['QZX901'], 'the tool got the real code; the refused call never ran')
        assert.deepEqual(leaks(out), [], JSON.stringify(out).slice(0, 600))
        assert.match(JSON.stringify(story), new RegExp(`client=${A.slug(cn('QZX901'))}`))
        assert.equal((refused as any).content[0].text, A.REFUSAL)
        await client.close(); await server.close()
    })
})

describe('PostHog MCP proxy', () => {
    class Capture extends Writable {
        statusCode = 200; headersSent = false; headers = new Map<string, string>(); chunks: Buffer[] = []
        setHeader(n: string, v: string) { this.headers.set(n.toLowerCase(), v) }
        writeHead(s: number, h: Record<string, string> = {}) { this.statusCode = s; this.headersSent = true; for (const [n, v] of Object.entries(h)) this.setHeader(n, v); return this }
        _write(c: Buffer, _e: BufferEncoding, cb: () => void) { this.chunks.push(Buffer.from(c)); cb() }
        get text() { return Buffer.concat(this.chunks).toString('utf8') }
    }
    const options = { url: 'http://127.0.0.1:8787/mcp', apiKey: 'k', token: 't', name: 'reval-lens', enabled: true }
    const exec = (command: string, id = 3) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'exec', arguments: { command } } })
    async function invoke(body: unknown) {
        const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: '/posthog-mcp', headers: { authorization: 'Bearer t', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })
        const res = new Capture()
        await handlePosthogMcp(req as unknown as IncomingMessage, res as unknown as ServerResponse, options)
        return res
    }
    test('block mode: only tool lookup and docs search; every data command is refused, however it is written', () => {
        A.setAnonymise({ on: true, posthog: 'block' })
        for (const ok of ['tools', 'help call', 'search insight', 'info execute-sql', 'schema execute-sql query', 'call docs-search {"query":"flags"}', 'call --json docs-search {}'])
            assert.ok(anonRefusal(exec(ok)).value, ok)
        for (const bad of ['call execute-sql {"query":"select 1"}', 'CALL   query-trends {}', 'tools\ncall insights-list {}', 'tools; call persons-list {}', 'tools && call x {}', 'call --json execute-sql {}', 'run execute-sql', 'call docs-search {"q":"Zorblax"}'])
            assert.ok(anonRefusal(exec(bad)).refusal, bad)
    })
    test('filter mode: codenames become codes in the query, names are refused, every answer is cleaned (JSON and SSE)', async (t) => {
        A.setAnonymise({ on: true, posthog: 'filter' })
        await refreshRoster(0, { knownClients: async () => [] })
        assert.equal((anonRefusal(exec(`call execute-sql {"query":"select * from events where client='${cn('QZX901')}'"}`)).value as any).params.arguments.command, `call execute-sql {"query":"select * from events where client='QZX901'"}`)
        assert.ok(anonRefusal(exec(`call execute-sql {"query":"select 'Zorblax'"}`)).refusal)
        const rows = { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify({ results: [['QZX901', 'Zorblax Treasury', 12], ['VLT', 'VOLTRINO BANK', 3]], columns: ['client_id', 'client_name', 'n'] }) }] } }
        const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } }))
        const res = await invoke(exec('call execute-sql {"query":"select 1"}'))
        assert.deepEqual(leaks(res.text), [], res.text)
        fetchMock.mock.mockImplementation(async () => new Response(`event: message\ndata: ${JSON.stringify(rows)}\n\ndata: not json Kwambe Fintrust\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
        const sse = await invoke(exec('call execute-sql {"query":"select 1"}'))
        assert.deepEqual(leaks(sse.text), [], sse.text)
        fetchMock.mock.mockImplementation(async () => new Response('upstream error for Zorblax Treasury', { status: 500, headers: { 'content-type': 'text/plain' } }))
        assert.deepEqual(leaks((await invoke(exec('call execute-sql {}'))).text), [])
        A.setAnonymise({ posthog: 'block' })
        const blocked = await invoke(exec('call execute-sql {}'))
        assert.match(blocked.text, /switched off while client anonymisation is on/)
    })
    test('off: the proxy passes data as before', async (t) => {
        A.setAnonymise({ on: false })
        t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Zorblax Treasury' }] } }), { headers: { 'content-type': 'application/json' } }))
        assert.match((await invoke(exec('call execute-sql {}'))).text, /Zorblax Treasury/)
    })
})

describe('Claude triage', () => {
    test('the ticket, the client list and the hypothesis input carry codenames; the answer comes back as the client', async (t) => {
        A.setAnonymise({ on: true })
        // A PostHog that knows the canary clients and has no events.
        t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
            const q = String(init?.body || '')
            const results = /GROUP BY id/.test(q) ? CLIENTS.map((c) => [c.id, c.name, 10]) : []
            return new Response(JSON.stringify({ columns: /GROUP BY id/.test(q) ? ['id', 'name', 'events'] : [], results }), { headers: { 'content-type': 'application/json' } })
        })
        const { triage } = await import('../src/core/triage.ts')
        const sent: unknown[] = []
        const ai = {
            async readTicket(t: unknown, ctx: { clients: { id: string; name: string }[] }) { sent.push(t, ctx); return { clientId: cn('QZX901') } },
            async hypothesis(r: unknown) { sent.push(r); return `${cn('QZX901')} probably hit the new validation` },
        }
        const ticket = { key: 'REV-1', summary: 'Zorblax Treasury cannot save hedges', description: 'Since Monday QZX901 users at Zorblax see an error. Also Voltrino Bank.', reporter: { email: 'pm@ion.example' } }
        const report = await triage(ticket as never, { ai: ai as never, now: new Date('2026-11-01T00:00:00Z') }).catch((e) => ({ error: String(e) }))
        assert.ok(sent.length >= 2, JSON.stringify(report).slice(0, 300))
        assert.deepEqual(leaks(sent), [], JSON.stringify(sent).slice(0, 600))
        A.setAnonymise({ on: false })
    })
})

describe('web links', () => {
    test('a codename slug in ?client= opens the real client for signed-in people', async () => {
        const { codenameRedirect } = await import('../src/service/privacy.ts')
        let location = ''
        const res = { writeHead: (_s: number, h: Record<string, string>) => { location = h.location }, end() {} }
        const url = new URL(`http://x/replays/dashboards?view=rescue&client=${A.slug(cn('VLT'))}`)
        assert.ok(codenameRedirect({ method: 'GET' } as never, res as never, url))
        assert.equal(location, '/replays/dashboards?view=rescue&client=VLT')
        assert.ok(!codenameRedirect({ method: 'GET' } as never, res as never, new URL('http://x/replays/dashboards?client=VLT')))
    })
})
