import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// A throwaway database with two releases already counted, so the tools run without Jira or PostHog.
const dir = mkdtempSync(join(tmpdir(), 'triage-mcp-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const { db, run } = await import('../src/core/db.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

const survey = (o = {}) => ({ answers_before: 0, answers_after: 0, rating_before: null, rating_after: null, comments_after: [], ...o })
const screen = (o: Record<string, unknown> = {}) => ({ sessions_after: 400, sessions_before: 400, errors_after: 0, errors_before: 0, rage_after: 0, rage_before: 0, support: [], survey: survey(), ...o })
const ticket = (key: string, summary: string, link: object | null, usage: object, extra: object = {}) => ({
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
    usage: link ? { after: 0, before: 0, users_after: 0, users_before: 0, clients_after: 0, clients_before: 0, ...usage } : null,
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
        totals: { clients_after: 100, clients_before: 100, users_after: 700, sessions_after: 5000, sessions_before: 5000, errors_after: 60, errors_before: 0, rage_after: 0, rage_before: 0, clients_on_version: 50 },
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
        ticket('ACP-210', 'Bulk send invoices', { screen: '/invoices', event: 'invoice_bulk_sent' }, { after: 1600, clients_after: 86, users_after: 448 }),
        ticket('ACP-230', 'Totals in base currency', { screen: '/invoices' }, { after: 5000, clients_after: 100 }, { risk_owner: true, link_source: 'component' }),
        ticket('ACP-234', 'Upgrade a library', null, {}, { type: 'Task', link_source: 'none', link_reason: 'The ticket names no screen or event.' }),
    ],
    {
        '/invoices': screen({
            errors_after: 60,
            support: [{ key: 'SUP-1', summary: 'Export broken', text: 'We cannot send statements.', created: '2026-08-12', type: 'RCI' }],
            survey: survey({ answers_before: 30, answers_after: 32, rating_before: 4.2, rating_after: 2.9, comments_after: [{ rating: 1, comment: 'PDF export hangs', client: 'brightwater', at: '2026-08-13T10:00:00Z' }] }),
        }),
    },
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
    test('the tools and the review prompt are offered; only the writers are not read-only', async () => {
        const { tools } = await client.listTools()
        const ro = ['list_releases', 'release_outcomes', 'ticket_evidence', 'client_feedback']
        for (const n of ro) assert.equal(tools.find((x) => x.name === n)?.annotations?.readOnlyHint, true, n)
        for (const n of ['record_verdict', 'correct_ticket_link', 'refresh_releases']) assert.equal(tools.find((x) => x.name === n)?.annotations?.readOnlyHint, false, n)
        const { prompts } = await client.listPrompts()
        assert.ok(prompts.some((p) => p.name === 'review_release'))
        const p = await client.getPrompt({ name: 'review_release', arguments: { scope: '26.8.0' } })
        assert.match((p.messages[0].content as { text: string }).text, /release_outcomes with scope "26.8.0"/)
    })
    test('release_outcomes sorts tickets into groups with their numbers', async () => {
        const t = await call('release_outcomes', { scope: '26.8.0' })
        assert.match(t, /- \*\*More errors after the release\*\* \(1\): ACP-230\./)
        assert.match(t, /- \*\*Clients complained\*\* \(1\): ACP-230\./)
        assert.match(t, /- \*\*Adopted\*\* \(1\): ACP-210\./)
        assert.match(t, /- \*\*Can't measure\*\* \(1\): ACP-234\./)
        assert.match(t, /\*\*ACP-230\*\* Totals in base currency \(Story, 26\.8\.0\) \[more errors after the release, clients complained\]:.*survey rating 4.2 → 2.9/)
        assert.match(t, /\*\*ACP-210\*\*.*\[adopted\]:.*86 of 100 active clients.*problems on Invoices are counted for ACP-230/)
        assert.ok(t.indexOf('**ACP-230**') < t.indexOf('**ACP-210**'), 'problems first')
        assert.match(await call('release_outcomes', { scope: 'Q3 2026' }), /ACP-200/)
        assert.match(await call('release_outcomes', { scope: 'Q9 1999' }), /Nothing called "Q9 1999"\. Releases: 26\.7\.0, 26\.8\.0/)
    })
    test('client_feedback shows what clients said, worst first', async () => {
        const t = await call('client_feedback', { scope: 'all' })
        assert.match(t, /RCI SUP-1 .*"Export broken": We cannot send statements\./)
        assert.match(t, /Survey 1\/5 \(brightwater, 2026-08-13\): "PDF export hangs"/)
    })
    test('a saved verdict shows up in later outcomes and in the evidence', async () => {
        assert.match(await call('record_verdict', { key: 'acp-230', verdict: 'risky', reason: '10 clients cannot export; 2.9 rating', decided_by: 'Priya (PM)' }), /Saved: ACP-230 \(26\.8\.0\) is risky, by Priya \(PM\)/)
        assert.match(await call('release_outcomes', { scope: '26.8.0' }), /\*\*ACP-230\*\*.*verdict \*\*risky\*\* \(Priya \(PM\)/)
        assert.match(await call('ticket_evidence', { key: 'ACP-230' }), /### Verdicts\n- \d{4}-\d{2}-\d{2} Priya \(PM\): \*\*risky\*\*/)
        assert.match(await call('record_verdict', { key: 'ACP-999', verdict: 'fine', reason: 'nothing here', decided_by: 'x' }), /not in the kept releases/)
    })
})
