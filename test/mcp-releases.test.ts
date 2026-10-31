import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// A throwaway database with two releases already synced, so the tools run without Jira or PostHog.
const dir = mkdtempSync(join(tmpdir(), 'triage-mcp-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const { db, run } = await import('../src/core/db.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

const screen = (o: Partial<Record<string, unknown>> = {}) => ({ sessions_after: 400, sessions_before: 400, errors_after: 0, errors_before: 0, rage_after: 0, rage_before: 0, support: [], ...o })
const ticket = (key: string, summary: string, link: object, usage: object, extra: object = {}) => ({
    key,
    type: 'Story',
    summary,
    status: 'Done',
    components: [],
    hidden: false,
    link,
    link_source: 'event',
    link_reason: 'test',
    confidence: 1,
    risk_owner: false,
    shares_screen_with: [],
    usage: { after: 0, before: 0, users_after: 0, users_before: 0, clients_after: 0, clients_before: 0, ...usage },
    weekly: [],
    ...extra,
})
function addRelease(name: string, date: string, tickets: object[], screens: object, newErrors: object[] = []) {
    run('INSERT INTO releases (name, released_at, description, synced_at) VALUES (?, ?, ?, ?)', name, date, '', new Date().toISOString())
    for (const t of tickets as { key: string; summary: string }[]) run("INSERT INTO release_tickets (key, release, type, summary, components, labels) VALUES (?, ?, 'Story', ?, '[]', '[]')", t.key, name, t.summary)
    const snap = {
        release: name,
        date,
        description: '',
        computed_at: new Date().toISOString(),
        window: { before_start: date, after_start: date, after_end: date, days: 30, open: false },
        totals: { clients_after: 100, clients_before: 100, users_after: 700, sessions_after: 5000, sessions_before: 5000, errors_after: 10, errors_before: 0, rage_after: 0, rage_before: 0, clients_on_version: 100 },
        adoption: [],
        screens,
        new_errors: newErrors,
        tickets,
    }
    run('INSERT INTO release_snapshots (release, computed_at, data) VALUES (?, ?, ?)', name, snap.computed_at, JSON.stringify(snap))
}
addRelease('26.7.0', '2026-07-13', [ticket('ACP-200', 'Redesigned client list filters', { screen: '/clients', event: 'client_filter_applied' }, { after: 900, clients_after: 88 })], { '/clients': screen() })
addRelease(
    '26.8.0',
    '2026-08-10',
    [
        ticket('ACP-210', 'Bulk send invoices', { screen: '/invoices', event: 'invoice_bulk_sent' }, { after: 1600, clients_after: 97, users_after: 610 }),
        ticket('ACP-230', 'Totals in base currency', { screen: '/invoices' }, { after: 5000, clients_after: 100 }, { risk_owner: true, link_source: 'component' }),
    ],
    { '/invoices': screen({ errors_after: 60, support: [{ key: 'SUP-1', summary: 'Export broken', created: '2026-08-12', type: 'RCI' }] }) },
    [{ id: 'x', type: 'TypeError', message: 'toFixed', first_seen: '2026-08-11', occurrences: 60, clients: 10, path: '/invoices' }]
)

const server = new McpServer({ name: 'test', version: '0' })
registerTools(server)
const client = new Client({ name: 'test', version: '0' })
const [a, b] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(a), client.connect(b)])
const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }
    return r.content[0].text
}

describe('release MCP tools', () => {
    test('all five are offered, read-only', async () => {
        const { tools } = await client.listTools()
        for (const n of ['release_insights', 'list_releases', 'release_tickets', 'ticket_impact', 'compare_releases']) {
            const t = tools.find((x) => x.name === n)
            assert.ok(t, n)
            assert.equal(t!.annotations?.readOnlyHint, true)
        }
    })
    test('list_releases shows each release and the quarters', async () => {
        const t = await call('list_releases')
        assert.match(t, /\| 26\.8\.0 \| 2026-08-10/)
        assert.match(t, /Q3 2026 \(26\.7\.0, 26\.8\.0\)/)
    })
    test('release_tickets ranks by risk and filters', async () => {
        const t = await call('release_tickets', { scope: 'Q3 2026', sort: 'risk', limit: 1 })
        assert.match(t, /ACP-230/)
        assert.doesNotMatch(t, /ACP-210/)
        assert.match(await call('release_tickets', { search: 'bulk' }), /ACP-210/)
    })
    test('ticket_impact explains one ticket with its screen problems', async () => {
        const t = await call('ticket_impact', { key: 'acp-230' })
        assert.match(t, /Screen problems count for this ticket: yes/)
        assert.match(t, /SUP-1 "Export broken"/)
        assert.match(t, /TypeError: toFixed \(60 times, 10 clients\)/)
    })
    test('compare_releases puts two scopes side by side', async () => {
        const t = await call('compare_releases', { a: '26.8.0', b: '26.7.0' })
        assert.match(t, /\| Tickets shipped \| 2 \| 1 \|/)
        assert.match(t, /Top tickets: 26\.8\.0/)
    })
    test('an unknown scope lists the options', async () => {
        assert.match(await call('release_insights', { scope: 'Q9 1999' }), /Options: .*Q3 2026/)
    })
})
