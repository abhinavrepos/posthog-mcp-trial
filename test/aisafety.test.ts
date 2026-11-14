import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const dir = mkdtempSync(join(tmpdir(), 'lens-ai-safety-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.POSTHOG_PERSONAL_API_KEY ||= 'test'
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const { config } = await import('../src/core/config.ts')
const { safetyWith, aiSafety } = await import('../src/core/aisafety.ts')
const { maskAmounts } = await import('../src/core/appevents.ts')
const { replayUrl } = await import('../src/core/posthog.ts')
const { setAnonymise, anonSettings } = await import('../src/core/anonymise.ts')
const { jsonResult, reportResult, safeResult } = await import('../src/mcp/result.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('integer cash is masked while explicit ids and ordinary counts stay', () => {
    assert.equal(maskAmounts('Notional exceeds limit: 250000'), 'Notional exceeds limit: <amount>')
    for (const s of ['Trade Id 4348', 'Trade 123456', 'ID: 123456', 'No 123456', 'Number 123456', '#123456', 'Ref 123456', 'ABC123456', '42 users']) assert.equal(maskAmounts(s), s)
    assert.equal(maskAmounts('250000 42 users'), '<amount> 42 users')
    assert.equal(maskAmounts('Trade 250000 USD'), 'Trade <amount>')
})
test('identities, encoded links, roster names and survey keys are masked without withholding answers', () => {
    const id = ['ENV', '01', 'C01', 'opaque-user'].join(config.properties.distinctIdSeparator)
    const input = { user: 'unknown-id', user_id: 123, users: ['unknown-id'], text: `${id} Jane Smith’s notional is USD 250000; alice%40example.com`, distribution: { 'Jane Smith: 250000': 2 }, recent: [{ text: 'Jane Smith answered yes' }], cash: 22, count: 250000 }
    const out = safetyWith(input, ['Jane Smith'])
    assert.equal(out.user, '[person]'); assert.equal(out.user_id as unknown, '[person]')
    assert.deepEqual(out.users, ['[person]'])
    assert.equal(out.text, '[person] [person]’s notional is <amount>; [person]')
    assert.deepEqual(out.distribution, { '[person]: <amount>': 2 })
    assert.equal(out.recent[0].text, '[person] answered yes')
    assert.equal(out.cash as unknown, '<amount>'); assert.equal(out.count, 250000)
    assert.equal(safetyWith('https://hog.example/project/1/replay/alice%2540example.com', []), `${config.service.publicUrl}/replays`)
})
test('rescue notes are withheld and staff owners remain visible, with exact email membership', () => {
    const out = safetyWith({ action: { owner: 'pm@lens.example', status: 'open', note: 'New Person: new@example.com has 250000' }, message: 'outsider@lens.example and pm@lens.example', events: [{ kind: 'note', text: 'A new person unknown to history' }] }, [], new Set(['pm@lens.example']))
    assert.equal(out.action.note, '[withheld]'); assert.equal(out.action.owner, 'pm@lens.example')
    assert.equal(out.message, '[person] and pm@lens.example')
    assert.equal(out.events[0].text, '[withheld]')
})
test('replay URLs never contain identity-bearing session ids', () => {
    for (const id of ['alice@example.com', 'alice%40example.com', 'alice%2540example.com', ['ENV', '01', 'C01', 'user'].join(config.properties.distinctIdSeparator)]) assert.equal(replayUrl(id, 12), `${config.service.publicUrl}/replays`)
    assert.match(replayUrl('opaque-session', 12), /replay\/opaque-session\?t=12$/)
})
test('structured unknown clients fail closed before serialisation; privacy off still scrubs users', async () => {
    assert.equal(anonSettings().posthog, 'block')
    setAnonymise({ on: true, lens: true })
    const safe = await safeResult(jsonResult('Results', { client: 'Unlisted Company', client_id: 'UNLISTED', user: 'new-user', text: 'ben.okafor@brightwater.example has 250000' }))
    const encoded = JSON.stringify(safe)
    assert.ok(!/Unlisted Company|UNLISTED|new-user|ben.okafor|250000|_lensJson/.test(encoded))
    assert.match(encoded, /\[client\]/)
    setAnonymise({ on: false })
    const out = await aiSafety({ client: 'Unlisted Company', user: 'non-email-id', text: 'Ben Okafor owes 250000' })
    assert.equal(out.client, 'Unlisted Company'); assert.equal(out.user, '[person]'); assert.equal(out.text, '[person] owes <amount>')
})
test('registerTools guards every callback, text results, structured results and errors', async () => {
    const server = new McpServer({ name: 'privacy-test', version: '1' })
    registerTools(server)
    server.registerTool('privacy_probe', {}, async () => jsonResult('Probe', { user: 'non-email-id', text: 'new@example.com owes 250000' }))
    server.registerTool('privacy_text', {}, async () => ({ content: [{ type: 'text', text: 'alice%40example.com owes 250000' }] }))
    server.registerTool('privacy_error', {}, async () => { throw new Error('new@example.com owes 250000') })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await client.connect(b)
    try {
        for (const name of ['privacy_probe', 'privacy_text', 'privacy_error']) {
            const out = JSON.stringify(await client.callTool({ name, arguments: {} }))
            assert.ok(!/non-email-id|example.com|250000|_lensJson/.test(out), out)
        }
    } finally { await client.close(); await server.close() }
})

test('Claude ticket reading uses parsed facts without unrestricted identities or values', async () => {
    const { safeTicket } = await import('../src/core/triage.ts')
    const { parseTicket } = await import('../src/core/ticket.ts')
    const ticket = { key: 'SUP-1', kind: 'rci' as const, summary: 'Jane Smith at Known Bank cannot save', description: 'new@example.com has notional 250000. Trade 123456 failed.', reporter: { name: 'New Name', email: 'reporter@example.com' }, fields: { userEmail: 'unknown@example.com', client: 'C01', screen: '/invoices' } }
    const out = await aiSafety(safeTicket(ticket, parseTicket(ticket), [{ id: 'C01', name: 'Known Bank' }]), 'triage')
    const encoded = JSON.stringify(out)
    assert.ok(!/Jane Smith|New Name|example.com|250000/.test(encoded), encoded)
    assert.match(encoded, /Known Bank/); assert.match(encoded, /Trade 123456/)
})
test('PostHog JSON text results scrub non-email distinct ids and financial properties', () => {
    const out = safetyWith({ content: [{ type: 'text', text: JSON.stringify({ distinct_id: 'unknown-person', properties: { notional: 500, userId: 'other-person' }, count: 12 }) }] }, [])
    const text = out.content[0].text
    assert.ok(!/unknown-person|other-person|500/.test(text), text)
    assert.equal(JSON.parse(text).count, 12)
    assert.deepEqual(safetyWith({ columns: ['distinct_id', 'properties.notional', 'trade_id', 'count'], results: [['unknown-id', 42, 123456, 100]] }, []), { columns: ['distinct_id', 'properties.notional', 'trade_id', 'count'], results: [['[person]', '<amount>', 123456, 100]] })
    assert.equal(safetyWith('26.10.0', []), '26.10.0')
    assert.equal(safetyWith('1.000.000', []), '<amount>')
    assert.equal(safetyWith('https://lens/replays?client=ACME+%26+Co', []), 'https://lens/replays?client=ACME+%26+Co')
    assert.equal(safetyWith('[person]', ['person']), '[person]')
    assert.equal(safetyWith('|---|---|---|', []), '|---|---|---|')
    assert.deepEqual(safetyWith({ distribution: { 'Jane Smith': 2, 'Jane Smith 250000': 3 } }, ['Jane Smith', 'Jane Smith 250000']), { distribution: { '[person]': 5 } })
})

test('PostHog filter mode scrubs JSON and SSE analytics results while off mode stays explicit', async t => {
    const { Readable, Writable } = await import('node:stream')
    const { handlePosthogMcp } = await import('../src/mcp/posthog-proxy.ts')
    const payload = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ columns: ['distinct_id', 'notional'], results: [['not-in-history', 250000]] }) }] } }
    let sse = false
    t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).includes('/mcp')
        ? new Response(sse ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload), { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' } })
        : Response.json({ columns: ['id', 'name'], results: [] }))
    const invoke = async () => {
        const req = Object.assign(Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: { command: 'call execute-sql {}' } } })]), { method: 'POST', url: '/', headers: { authorization: 'Bearer test' } })
        let output = ''
        const res = Object.assign(new Writable({ write(chunk, _encoding, cb) { output += chunk.toString(); cb() } }), { writeHead() {}, setHeader() {} })
        await handlePosthogMcp(req as never, res as never, { url: 'https://hog.example/mcp', apiKey: 'test', token: 'test', name: 'lens', enabled: true })
        return output
    }
    try {
        setAnonymise({ on: true, posthog: 'filter' })
        for (sse of [false, true]) {
            const out = await invoke()
            assert.ok(!/not-in-history|250000/.test(out), out)
            assert.match(out, /\[person\]/)
        }
        setAnonymise({ on: true, posthog: 'off' })
        assert.match(await invoke(), /not-in-history/)
    } finally { setAnonymise({ on: false, posthog: 'block' }) }
})

test('raw exception reports keep their wording with amounts and user ids masked before Markdown rendering', async () => {
    const report = {
        ticket: { key: 'SUP-1', kind: 'rci', summary: 'Support ticket' },
        understood: { emails: [], window: { label: 'now' }, other_clients: [], ai_used: false },
        incident: { kind: 'exception', user: 'unlisted-user-id', timestamp: '2026-11-14T12:00:00Z', pathname: '/invoices', app_version: '26.10.0', error_type: 'LimitError', error_message: 'Notional 250000 exceeds limit on Trade Id 4348 for alice@client.example' },
        other_sessions: [], severity: { priority: 'P2', reasons: [] }, notes: [], elapsed_s: 1,
    }
    const safe = await safeResult(reportResult(report as never))
    const text = JSON.stringify(safe)
    assert.ok(!/250000|unlisted-user-id|alice@client|_lensReport/.test(text), text)
    assert.match(text, /exceeds limit on Trade Id 4348/)
    assert.match(text, /26\.10\.0/)                                   // a release version is not an amount
})

test('session stories and message examples keep their wording; amounts and known users are masked', () => {
    const out = safetyWith({ story: ['+00:12 ✘ ERROR: "Ben Okafor lost 250000; Trade 123456" (Dialog)'], errors: [{ text: 'Invalid date for USD 1,250.00; Trade Id 4348', dialog: 'Save' }], messages: [{ text: 'Counterparty not found', count: 2, outcome: 'error', example: 'Counterparty not found for ben.okafor@brightwater.example' }] }, ['Ben Okafor'])
    const json = JSON.stringify(out)
    assert.ok(!/Ben Okafor|250000|1,250|brightwater\.example/.test(json), json)
    assert.match(out.story[0], /Trade 123456/)
    assert.match(out.errors[0].text, /Invalid date for <amount>; Trade Id 4348/)
    assert.equal(out.messages[0].text, 'Counterparty not found')     // what PMs act on stays readable
})

test('session ids and replay links keep their digits; amounts next to them are still masked', () => {
    const sid = '019b55aa-8c82-7185-ba5a-123456789012'
    const out = safetyWith({ session_id: sid, replay_url: `https://posthog.test/project/1/replay/${sid}?t=40`, text: `Session ${sid} failed: balance 250000` }, [])
    assert.equal(out.session_id, sid)
    assert.equal(out.replay_url, `https://posthog.test/project/1/replay/${sid}?t=40`)
    assert.equal(out.text, `Session ${sid} failed: balance <amount>`)
})
