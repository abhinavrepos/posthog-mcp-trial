// Replay insights (how clients' people work, from session replays) are only for admins and the people an
// admin turned them on for: on the Client story page and in chat (tools listed, callable, named in the
// instructions). The shared chat token never gets them; no role change grants them.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const dir = mkdtempSync(join(tmpdir(), 'insights-access-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
after(() => rmSync(dir, { recursive: true, force: true }))
const access = await import('../src/service/access.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
const { serverInstructions } = await import('../src/mcp/instructions.ts')
const { handleDashboards } = await import('../src/service/dashboards.ts')
const { registryOf, guardTransport } = await import('../src/mcp/anonymise.ts')
const INSIGHTS = ['client_experience', 'friction_hotspots']

test('grant: admins always; others only when an admin turns it on; audited; roles never grant it', () => {
    access.setPerson('pm@x.com', 'download', 'admin@x.com')
    access.setDashboardRole('pm@x.com', 'share', 'admin@x.com')
    assert.equal(access.hasInsightGrant('pm@x.com'), false, 'the highest roles below admin do not include it')
    access.setInsightAccess('PM@x.com', true, 'admin@x.com')
    assert.equal(access.hasInsightGrant('pm@x.com'), true)
    access.setPerson('pm@x.com', 'watch', 'admin@x.com')
    assert.equal(access.hasInsightGrant('pm@x.com'), true, 'a role change does not remove it either')
    access.setInsightAccess('pm@x.com', false, 'admin@x.com')
    assert.equal(access.hasInsightGrant('pm@x.com'), false)
    assert.equal(access.canSeeReplayInsights({ role: 'admin' }), true)
    assert.equal(access.canSeeReplayInsights({ role: 'download', insights: false }), false)
    const log = access.readAudit({ action: 'access.insights_set' })
    assert.deepEqual(log.map((r) => r.insights), [false, true])
})

test('chat callers: personal token follows the grant, admin always, shared token never', () => {
    const { token } = access.createMcpToken({ email: 'pm@x.com', posthog_admin: false }, 'Copilot')
    assert.equal(access.chatCaller(token, 'shared-secret')?.insights, false)
    access.setInsightAccess('pm@x.com', true, 'admin@x.com')
    assert.equal(access.chatCaller(token, 'shared-secret')?.insights, true)
    access.setPerson('boss@x.com', 'admin', 'admin@x.com')
    const boss = access.createMcpToken({ email: 'boss@x.com', posthog_admin: false }, 'Copilot')
    assert.equal(access.chatCaller(boss.token, 'shared-secret')?.insights, true)
    assert.equal(access.chatCaller('shared-secret', 'shared-secret')?.insights, false)
    access.setInsightAccess('pm@x.com', false, 'admin@x.com')
    assert.equal(access.chatCaller(token, 'shared-secret')?.insights, false, 'turning it off takes effect on the next request')
})

async function chat(caller: Parameters<typeof registerTools>[2]) {
    const server = new McpServer({ name: 't', version: '1' })
    registerTools(server, undefined, caller)
    const client = new Client({ name: 't', version: '0' }); const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); guardTransport(a, registryOf(server))
    await client.connect(b)
    return { client, close: async () => { await client.close(); await server.close() } }
}

test('MCP: without the grant the tools are not listed and a direct call is refused; with it they work', async () => {
    const pm = { who: 'pm@x.com', email: 'pm@x.com', surveyRole: 'none' as const, dashboardRole: 'share' as const, admin: false }
    for (const caller of [pm, { ...pm, insights: false }, { ...pm, who: 'mcp (shared token)', email: undefined, dashboardRole: 'view' as const, insights: false }]) {
        const { client, close } = await chat(caller)
        const names = (await client.listTools()).tools.map((t) => t.name)
        assert.ok(names.includes('client_story'), 'dashboards still work')
        for (const t of INSIGHTS) {
            assert.ok(!names.includes(t), t + ' hidden')
            const r = await client.callTool({ name: t, arguments: { client: 'acme' } }).then((x) => JSON.stringify(x), (e) => String(e))
            assert.doesNotMatch(r, /verdict|\\"hotspots\\"|replays_read|SMOOTH|STRUGGLING/, r)
            assert.match(r, /unknown|not found|not available|error/i, r)
        }
        await close()
    }
    for (const caller of [{ ...pm, insights: true }, { ...pm, dashboardRole: 'none' as const, admin: true }]) {
        const { client, close } = await chat(caller)
        const names = (await client.listTools()).tools.map((t) => t.name)
        for (const t of INSIGHTS) assert.ok(names.includes(t), t + ' listed')
        const hot = await client.callTool({ name: 'friction_hotspots', arguments: {} })
        assert.match(JSON.stringify(hot), /replays_read/)
        await close()
    }
    // Dashboard access is still needed: the grant alone does not open dashboards.
    const { client, close } = await chat({ ...pm, dashboardRole: 'none', insights: true })
    assert.ok(!(await client.listTools()).tools.some((t) => INSIGHTS.includes(t.name)))
    await close()
})

test('instructions only name the tools when the caller has them', () => {
    const without = serverInstructions(false, 'none', 'view', false), withIt = serverInstructions(false, 'none', 'view', true)
    for (const t of INSIGHTS) { assert.ok(!without.includes(t), t); assert.ok(withIt.includes(t), t) }
    assert.match(without, /client_story, handover_pack/)
})

test('Client story page: the replay section only for admins and people with the grant', async () => {
    const story = { client: 'acme', client_name: 'Acme', coverage: { complete: true, unprocessed: [] }, weeks: [], events: [], surveys: [], summary: '', unknown: 'Unknown' }
    const deps = { clientStory: async () => story, handoverPack: async () => '# Handover' }
    const page = async (v: Record<string, unknown>) => {
        let body = ''
        const req = Object.assign((async function* () {})(), { method: 'GET', headers: { 'x-clip-page': '1' } })
        await handleDashboards(req as never, { writeHead() {}, end(s: string) { body = s } } as never, new URL('http://t/replays/dashboards?view=story&client=acme'), { email: 'pm@x.com', name: 'PM', role: 'watch', dashboards: 'view', posthog_admin: false, in_replay_project: true, session: 's', ...v } as never, deps as never)
        return body
    }
    const locked = await page({})
    assert.doesNotMatch(locked, /What is read from a replay|From \d+ replay/); assert.match(locked, /not turned on for you/)
    assert.match(await page({ insights: true }), /What is read from a replay/)
    assert.match(await page({ role: 'admin' }), /What is read from a replay/)
})
