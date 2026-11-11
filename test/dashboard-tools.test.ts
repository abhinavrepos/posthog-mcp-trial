import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DashboardRole } from '../src/service/access.ts'
import type { Task, TaskMapParams, FlowTimeParams } from '../src/core/taskstypes.ts'

const dir = mkdtempSync(join(tmpdir(), 'dashboard-tools-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'test.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_PROJECT_ID: '1', POSTHOG_SURVEY_API_KEY: 'test', FEATURE_SURVEYS: 'on' })
const { registerDashboardTools, dashboardToolNames, DASHBOARD_TOOLS } = await import('../src/mcp/dashboardtools.ts')
const { serverInstructions, INSTRUCTIONS_LIMIT } = await import('../src/mcp/instructions.ts')
const { config } = await import('../src/core/config.ts')
const core = await import('../src/core/dashboards.ts')
const access = await import('../src/service/access.ts')
const { handleAdmin } = await import('../src/service/admin.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

const task: Task = { task_id: 't_Hedge', name: 'Book a hedge', dialog: 'Hedge', attempts_90d: 100, clients_90d: 3 }
const counts = { attempts: 10, done: 8, failed: 1, abandoned: 1, users: 2, median_s: 60, p90_s: 100 }
const deps = {
    ingestStatus: () => ({ days_done: 28, first_day: '2026-01-01', last_day: '2026-02-01', behind_days: 2, attempts: 100, last_run: null, last_error: null, running: true }),
    findTasks: () => [task],
    resolveClient: async () => [{ id: 'ACME & Co', name: 'ACME', confidence: 1, via: 'name' as const, events_90d: 100 }],
    taskMap: async (p: TaskMapParams) => ({ coverage: { complete: true, unprocessed: [] }, params: { ...p, baseline: p.baseline! }, clients: [{ client: 'ACME & Co', client_name: 'ACME', attempts_now: 10, attempts_before: 20, tasks_now: 1, tasks_before: 1, missing: 0, slower: 1, score: 2 }], rows: [{ client: 'ACME & Co', client_name: 'ACME', task_id: task.task_id, task_name: task.name, now: counts, before: { ...counts, median_s: 30 }, flags: ['slower' as const], typical_path: ['Hedge'] }], data_through: '2026-02-01', note: 'History is catching up.' }),
    flowTime: async (p: FlowTimeParams) => ({ coverage: { complete: true, unprocessed: [] }, params: { ...p, granularity: 'week' as const }, task, summary: { ...counts, done_rate: .8 }, all_clients: { median_s: 30, p90_s: 70, done_rate: .9 }, series: [20, 30, 60, 80, 90, 100].map((n, i) => ({ period: `week ${i}`, attempts: 10, done: 8, median_s: n, p90_s: 120 })), paths: [{ path: ['Hedge'], labels: ['Hedge'], attempts: 10, share: 1, done_rate: .8, median_s: 60 }], slowest: [1, 2, 3, 4].map(n => ({ client: 'ACME', user: 'a', session_id: String(n), started_at: '2026-02-01', duration_s: 1000 - n, outcome: 'done' as const, path: ['Hedge'], replay_url: `https://lens/replay/${n}` })), top_errors: [{ template: 'Missing trade', count: 2 }], data_through: '2026-02-01', note: '' }),
}
type Deps = NonNullable<Parameters<typeof registerDashboardTools>[2]>
async function chat(role: DashboardRole, personal = true, overrides: Deps = {}) {
    const server = new McpServer({ name: 'test', version: '1' })
    registerDashboardTools(server, { who: 'pm@x.com', email: personal ? 'pm@x.com' : undefined, dashboardRole: role, admin: false }, { ...deps, ...overrides })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return { client, close: async () => { await client.close(); await server.close() } }
}
async function call(name: string, args: Record<string, unknown>, overrides: Deps = {}, personal = true) {
    const c = await chat('share', personal, overrides)
    try {
        const result = await c.client.callTool({ name, arguments: args })
        return (result.content as { text: string }[]).map(x => x.text).join('\n')
    } finally { await c.close() }
}

test('registered tools follow none, view and share roles', async () => {
    for (const role of ['none', 'view', 'share'] as const) {
        const c = await chat(role)
        try {
            if (role === 'none') {
                assert.equal(c.client.getServerCapabilities()?.tools, undefined)
                await assert.rejects(c.client.listTools(), /Method not found/)
            } else assert.deepEqual((await c.client.listTools()).tools.map(t => t.name).sort(), dashboardToolNames(role).sort())
        } finally { await c.close() }
    }
    assert.equal(dashboardToolNames('view').length, 5)
    assert.equal(dashboardToolNames('share').length, DASHBOARD_TOOLS.length)
})

test('the shared token cannot pin; relative pins stay current and share through the core', async () => {
    const args = { kind: 'task_map', title: 'ACME work', when: 'last 4 weeks', share_with: ['lead@x.com'] }
    assert.match(await call('pin_dashboard', args, {}, false), /own token from the Chat page/)
    const output = JSON.parse(await call('pin_dashboard', args))
    const saved = core.getDashboard(output.dashboard.id)!
    assert.deepEqual(saved.params.window, { last_days: 28 })
    assert.equal(saved.via, 'chat')
    assert.equal('baseline' in saved.params, false)
    assert.deepEqual(saved.shared_with, ['lead@x.com'])
    assert.equal(output.open, `${config.service.publicUrl}/replays/dashboards/${saved.id}`)
    const fixed = JSON.parse(await call('pin_dashboard', { ...args, keep_dates_fixed: true }))
    assert.match(fixed.dashboard.params.window.from, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(fixed.dashboard.params.baseline)
    assert.match(await call('list_dashboards', {}), new RegExp(saved.id))
    const actions = access.readAudit({ action: 'dashboard.', limit: 20 })
    assert.equal(actions.filter(x => x.action === 'dashboard.pinned').length, 2)
    assert.equal(actions.filter(x => x.action === 'dashboard.shared').length, 2)
})

test('only the owner or an admin can share; full email list replaces earlier sharing', async () => {
    const other = core.createDashboard('other@x.com', { kind: 'task_map', title: 'Other', params: { window: { last_days: 28 } } })
    assert.match(await call('share_dashboard', { dashboard: other.id, emails: ['a@x.com'] }), /Only the owner or an admin/)
    assert.deepEqual(core.getDashboard(other.id)?.shared_with, [])
    const mine = core.createDashboard('pm@x.com', { kind: 'task_map', title: 'Mine', params: { window: { last_days: 28 } } })
    const result = JSON.parse(await call('share_dashboard', { dashboard: `${config.service.publicUrl}/replays/dashboards/${mine.id}`, emails: ['a@x.com'] }))
    assert.deepEqual(result.dashboard.shared_with, ['a@x.com'])
    await call('share_dashboard', { dashboard: mine.id, emails: [] })
    assert.deepEqual(core.getDashboard(mine.id)?.shared_with, [])
})

test('ambiguous tasks and clients return candidates without running reports', async () => {
    const ambiguous = { findTasks: () => [task, { ...task, task_id: 't_Other' }], flowTime: async () => { throw new Error('should not run') } }
    const output = JSON.parse(await call('flow_time', { task: 'book a hedge' }, ambiguous))
    assert.equal(output.candidates.length, 2)
    const client = JSON.parse(await call('task_map', { client: 'acme' }, { resolveClient: async () => [{ id: '1', name: 'ACME A', confidence: .7, via: 'name', events_90d: 1 }, { id: '2', name: 'ACME B', confidence: .7, via: 'name', events_90d: 1 }] }))
    assert.equal(client.candidates.length, 2)
    assert.match(await call('find_task', { query: 'hedge' }), /attempts_90d/)
})

test('reports link to the same encoded filters; flow summary includes trend, paths and three replay links', async () => {
    const map = JSON.parse(await call('task_map', { client: 'ACME', when: 'last 4 weeks', task: 'hedge', compared_with: 'last 8 weeks' }))
    assert.equal(map.clients[0].tasks[0].flags[0], 'slower')
    assert.ok(map.open.includes('client=ACME+%26+Co'))
    const url = new URL(map.open, 'http://lens')
    assert.equal(url.searchParams.get('task'), 't_Hedge')
    assert.equal(url.searchParams.get('only_flagged'), 'true')
    assert.ok(url.searchParams.has('baseline_from'))
    const flow = JSON.parse(await call('flow_time', { task: 'hedge', client: 'ACME' }))
    assert.equal(flow.trend, 'slower')
    assert.equal(flow.slowest.length, 3)
    assert.equal(flow.slowest[0].replay_url, 'https://lens/replay/1')
    assert.equal(flow.paths[0].share, 1)
    assert.equal(flow.all_clients.done_rate, .9)
    assert.equal(new URL(flow.open, 'http://lens').searchParams.get('view'), 'flow_time')
})

test('unfinished history gives a friendly answer', async () => {
    assert.match(await call('task_map', {}, { ingestStatus: () => ({ ...deps.ingestStatus(), days_done: 0 }) }), /history is still being built/)
})

test('instructions fit for every survey and dashboard role, with and without PostHog', () => {
    for (const posthog of [true, false]) for (const survey of access.SURVEY_ROLES) for (const dashboard of access.DASHBOARD_ROLES) {
        const instructions = serverInstructions(posthog, survey, dashboard)
        assert.ok(instructions.length < INSTRUCTIONS_LIMIT, `${posthog}/${survey}/${dashboard}: ${instructions.length}`)
        for (const name of DASHBOARD_TOOLS) assert.equal(instructions.includes(name), dashboardToolNames(dashboard).includes(name))
    }
})

async function admin(path: string, body?: object) {
    let status = 0, output = ''
    const req = Object.assign((async function* () { if (body) yield JSON.stringify(body) })(), { method: body ? 'POST' : 'GET', headers: {} })
    const res = { writeHead: (code: number) => { status = code }, end: (data: string) => { output = data } }
    await handleAdmin(req as never, res as never, new URL('http://lens/replays/admin' + path), { email: 'admin@x.com', role: 'admin', posthog_admin: true, session: 's' } as never)
    return { status, output }
}
test('admin dashboard roles can be set and reset; defaults and shared tokens cannot share', async () => {
    assert.equal((await admin('/api/dashboard-role', { email: 'new@x.com', role: 'share' })).status, 200)
    assert.equal(access.dashboardRoleOf('new@x.com', 'none'), 'share')
    assert.equal((await admin('/api/dashboard-role', { email: 'new@x.com', role: 'default' })).status, 200)
    assert.equal(access.dashboardPeople().has('new@x.com'), false)
    assert.equal((await admin('/api/settings', { dashboard_default_role: 'view', dashboard_shared_token_role: 'none' })).status, 200)
    assert.equal(access.defaultDashboardRole(), 'view')
    assert.equal(access.sharedTokenDashboardRole(), 'none')
    for (const key of ['dashboard_default_role', 'dashboard_shared_token_role']) assert.equal((await admin('/api/settings', { [key]: 'share' })).status, 400)
    assert.equal((await admin('/api/dashboard-role', { email: 'bad', role: 'view' })).status, 400)
    const page = await admin('')
    for (const script of page.output.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script[1]))
    assert.match(page.output, /Dashboard role for other PostHog users/)
})


test('admin state includes dashboard roles and people known only through dashboard access', async () => {
    access.setDashboardRole('dashboard-only@x.com', 'share', 'admin@x.com')
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
        const path = String(input)
        const body = path.includes('/api/projects/') ? { organization: 'org' }
            : path.includes('/members/') ? { results: [] } : { organizations: [{ id: 'org', name: 'Org' }] }
        return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    try {
        const result = await admin('/api/state')
        assert.equal(result.status, 200)
        const state = JSON.parse(result.output)
        assert.equal(state.dashboard_default_role, 'view')
        assert.equal(state.dashboard_shared_token_role, 'none')
        assert.deepEqual(state.dashboard_roles.map((r: { id: string }) => r.id), ['none', 'view', 'share'])
        const person = state.people.find((p: { email: string }) => p.email === 'dashboard-only@x.com')
        assert.equal(person.dashboard_role, 'share')
        assert.equal(person.dashboard_role_set_here, 'share')
    } finally { globalThis.fetch = original }
})


test('date windows and defaults use complete UTC days and matching preceding periods', async () => {
    const map = new URL(JSON.parse(await call('task_map', {})).open, 'http://lens')
    const get = (key: string) => Date.parse(map.searchParams.get(key)!)
    assert.equal((get('to') - get('from')) / 86400000 + 1, 28)
    assert.equal(get('from') - get('baseline_to'), 86400000)
    assert.equal((get('baseline_to') - get('baseline_from')) / 86400000 + 1, 28)
    const flow = new URL(JSON.parse(await call('flow_time', { task: 'hedge' })).open, 'http://lens')
    assert.equal((Date.parse(flow.searchParams.get('to')!) - Date.parse(flow.searchParams.get('from')!)) / 86400000 + 1, 90)
    const fixed = new URL(JSON.parse(await call('task_map', { when: '2026-01-01 to 2026-01-28' })).open, 'http://lens')
    assert.equal(fixed.searchParams.get('from'), '2026-01-01')
    assert.equal(fixed.searchParams.get('to'), '2026-01-28')
    assert.match(await call('task_map', { when: 'not a date' }), /could not read those dates/)
})

test('rescue chat shows top three reasons, limits rows and descriptions, links dates, and audits status by local client name', async () => {
    const { storeAttempts } = await import('../src/core/tasks.ts')
    storeAttempts('2026-01-01', [{ day: '2026-01-01', client: 'rescue-client', user: 'person', session_id: 's', task_id: 't_Hedge', path: ['Hedge'], started_at: '2026-01-01', ended_at: '2026-01-01', duration_s: 10, outcome: 'done', errors: 0, offset_s: 0 }], { clientNames: new Map([['rescue-client', 'Rescue Company']]) })
    const output = JSON.parse(await call('set_rescue_status', { client: 'Rescue Company', owner: 'pm@x.com', status: 'contacted', note: 'Called', due: '2026-12-01' }))
    assert.equal(output.status, 'contacted'); assert.equal(output.updated_by, 'pm@x.com')
    assert.equal(access.readAudit({ action: 'rescue.updated' }).at(0)?.client, 'rescue-client')
    const c = await chat('view')
    try {
        const listed = (await c.client.listTools()).tools
        assert.equal(listed.some(t => t.name === 'set_rescue_status'), false)
        assert.ok(listed.find(t => t.name === 'rescue_queue')!.description!.length < 200)
        const forbidden = await c.client.callTool({ name: 'set_rescue_status', arguments: { client: 'rescue-client', status: 'resolved' } })
        assert.equal(forbidden.isError, true)
    } finally { await c.close() }
    const queue = { coverage: { complete: true, unprocessed: [] }, window: { from: '2026-01-01', to: '2026-01-28' }, baseline: { from: '2025-12-04', to: '2025-12-31' }, data_through: '2026-01-28', hidden_snoozed: 0, note: '', clients: Array.from({ length: 60 }, (_, i) => ({ client: String(i), client_name: String(i), score: 50, level: 'urgent' as const, trend: 'new' as const, reasons: Array.from({ length: 5 }, (_, n) => ({ kind: 'missing' as const, text: String(n), now: 0, before: 5 })), next_step: 'Call' })) }
    const result = JSON.parse(await call('rescue_queue', {}, { rescueQueue: async () => queue }))
    assert.equal(result.clients.length, 10); assert.equal(result.clients[0].reasons.length, 3)
    assert.equal(new URL(result.open).searchParams.get('view'), 'rescue')
    assert.equal(new URL(result.open).searchParams.get('from'), queue.window.from)
    const fifty = JSON.parse(await call('rescue_queue', { limit: 50 }, { rescueQueue: async () => queue })); assert.equal(fifty.clients.length, 50)
    assert.match(await call('set_rescue_status', { client: 'rescue-client', status: 'expected' }), /snooze date/)
})
