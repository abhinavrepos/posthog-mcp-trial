import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Viewer, DashboardRole } from '../src/service/access.ts'

const dir = mkdtempSync(join(tmpdir(), 'posthog-charts-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'lens.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_HOST: 'https://posthog.test', POSTHOG_PROJECT_ID: '17', POSTHOG_PERSONAL_API_KEY: 'read-key' })
const charts = await import('../src/core/posthogchart.ts')
const store = await import('../src/core/dashboards.ts')
const { setAnonymise, syncClients } = await import('../src/core/anonymise.ts')
const { clearPosthogCache, resetPosthogBreaker } = await import('../src/core/posthog.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const { registerDashboardTools, dashboardToolNames } = await import('../src/mcp/dashboardtools.ts')
const { wrapTools } = await import('../src/mcp/tools.ts')
const { handleDashboards } = await import('../src/service/dashboards.ts')
const { posthogChartHtml, POSTHOG_CHART_CLIENT } = await import('../src/service/posthogchart.ts')
const { config } = await import('../src/core/config.ts')
const { setDashboardRole } = await import('../src/service/access.ts')
for (const email of ['chart@example.com', 'friend@example.com']) setDashboardRole(email, 'view', 'test')
tasksDb.prepare('INSERT OR IGNORE INTO known_users(user) VALUES (?)').run('Jane Chartperson')
const originalFetch = globalThis.fetch
const originalNow = Date.now
let calls: { url: string; init?: RequestInit; body: any }[] = []
let answer: unknown = { results: [{ label: 'Events', data: [2, 4], days: ['2026-01-01', '2026-01-02'] }] }
beforeEach(() => {
    Date.now = originalNow
    setAnonymise({ mode: 'standard', posthog: 'filter', round: false })
    clearPosthogCache(); resetPosthogBreaker(); calls = []
    answer = { results: [{ label: 'Events', data: [2, 4], days: ['2026-01-01', '2026-01-02'] }] }
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return Response.json(answer)
    }
})
after(() => { globalThis.fetch = originalFetch; Date.now = originalNow; rmSync(dir, { recursive: true, force: true }) })
const query = (kind: typeof charts.CHART_QUERY_KINDS[number] = 'TrendsQuery') => kind === 'HogQLQuery' ? { kind, query: 'SELECT count() AS events FROM events' } : { kind, series: [{ kind: 'EventsNode', event: '$pageview' }], dateRange: { date_from: '-30d', date_to: null } }
const viewer = (dashboards: DashboardRole = 'view', email = 'chart@example.com', admin = false): Viewer => ({ dashboards, email, role: admin ? 'admin' : 'none', name: 'Chart', posthog_admin: admin, in_replay_project: true, session: 's' })
async function request(path: string, v = viewer(), method = 'GET', body?: unknown, header = '1') {
    let status = 0, output = ''
    const req = Object.assign((async function* () { if (body !== undefined) yield JSON.stringify(body) })(), { method, headers: { 'x-clip-page': header } })
    const res = { writeHead(s: number) { status = s }, end(s: string) { output = s } }
    await handleDashboards(req as never, res as never, new URL('http://lens/replays/dashboards' + path), v)
    let data: any; try { data = JSON.parse(output) } catch {}
    return { status, body: output, data }
}
async function chat(role: DashboardRole = 'view', personal = true, admin = false) {
    const server = new McpServer({ name: 'test', version: '1' })
    wrapTools(server, false, undefined, { work: (_n, _a, _w, execute) => ({ promise: execute() }) })
    registerDashboardTools(server, { who: 'chart', email: personal ? 'chart@example.com' : undefined, dashboardRole: role, admin }, { ingestStatus: () => ({ days_done: 1, first_day: null, last_day: null, behind_days: 0, attempts: 1, last_run: null, last_error: null, running: false }) })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return { client, close: async () => { await client.close(); await server.close() } }
}
const read = (result: unknown): any => JSON.parse((result as { content: { text: string }[] }).content[0].text)

test('chart validation allows seven aggregate kinds and rejects oversized, nested, replay and identity queries', () => {
    assert.doesNotThrow(() => charts.prepareChartParams({ ...query(), breakdownFilter: { breakdown_type: 'person', breakdown: 'name' } }))
    for (const kind of charts.CHART_QUERY_KINDS) assert.equal(charts.prepareChartParams(query(kind)).query.kind, kind)
    for (const bad of [null, [], {}, { kind: 'PersonsQuery' }, { kind: 'DataTableNode', source: query() }, { ...query(), extra: 'x'.repeat(20_001) }, { ...query(), extra: '€'.repeat(7000) }, { ...query(), source: { kind: 'HogQLQuery', query: 'SELECT 1' } }, { ...query(), source: { kind: 'PersonsNode' } }, { kind: 'HogQLQuery', query: 'SELECT * FROM session_replay_events' }, { kind: 'HogQLQuery', query: 'SELECT email FROM persons' }, { kind: 'HogQLQuery', query: 'SELECT properties.email FROM events' }, { kind: 'HogQLQuery', query: 'SELECT * FROM session_/**/replay_events' }]) assert.throws(() => charts.prepareChartParams(bad))
    assert.throws(() => charts.prepareChartParams(query(), 'pie' as never), /line, bar or table/)
    assert.throws(() => store.createDashboard('chart@example.com', { kind: 'posthog_chart', title: 'Unsafe', params: { query: { kind: 'SessionRecordingsQuery' } } }))
})

test('private mode refuses HogQL and respects PostHog block/filter policy and codenames', () => {
    const sql = charts.prepareChartParams(query('HogQLQuery'))
    setAnonymise({ mode: 'private', posthog: 'block' })
    assert.throws(() => charts.prepareChartParams(query('HogQLQuery')), /SQL is refused in private mode/)
    assert.throws(() => charts.resolveChartQuery(sql), /SQL is refused in private mode/)
    assert.throws(() => charts.prepareChartParams(query()), /switched off/)
    syncClients([{ id: 'chart-client', name: 'Chart Company' }])
    setAnonymise({ mode: 'private', posthog: 'filter' })
    assert.throws(() => charts.prepareChartParams({ ...query(), properties: [{ value: 'Chart Company' }] }), /Private mode/)
    assert.equal(charts.prepareChartParams(query()).query.kind, 'TrendsQuery')
})

test('rolling and fixed aggregate windows and SQL dates resolve as time moves without changing the input', () => {
    const q = { ...query(), dateRange: { date_from: '2026-01-01', date_to: '2026-01-30' } }
    const moving = charts.prepareChartParams(q)
    assert.deepEqual(moving.query.dateRange, { date_from: '-30d', date_to: null })
    assert.deepEqual(charts.prepareChartParams(q, 'bar', true).query, q)
    assert.deepEqual(q.dateRange, { date_from: '2026-01-01', date_to: '2026-01-30' })
    const sql = { kind: 'HogQLQuery', query: "SELECT count() FROM events WHERE timestamp >= '2026-01-01' AND timestamp < '2026-01-31'" }
    const p = charts.prepareChartParams(sql)
    assert.ok(p.rolling); assert.match(String(p.query.query), /\{lens_chart_date_0\}/)
    const first = charts.resolveChartQuery(p, new Date('2026-03-31T10:00:00Z'))
    const next = charts.resolveChartQuery(p, new Date('2026-04-01T10:00:00Z'))
    assert.deepEqual(first.values, { lens_chart_date_0: '2026-03-01', lens_chart_date_1: '2026-03-31' })
    assert.deepEqual(next.values, { lens_chart_date_0: '2026-03-02', lens_chart_date_1: '2026-04-01' })
    assert.deepEqual(charts.resolveChartQuery(charts.prepareChartParams(sql, undefined, true)), sql)
    const single = charts.prepareChartParams({ kind: 'HogQLQuery', query: "SELECT count() FROM events WHERE timestamp >= '2026-01-01'" }, undefined, false, new Date('2026-01-31T12:00:00Z'))
    assert.deepEqual(charts.resolveChartQuery(single, new Date('2026-03-31T15:00:00Z')).values, { lens_chart_date_0: '2026-03-01' })
    const bound = charts.prepareChartParams({ kind: 'HogQLQuery', query: 'SELECT count() FROM events WHERE timestamp >= {from} AND timestamp < {to}', values: { from: '2026-01-01', to: '2026-01-31' } })
    assert.deepEqual(bound.query.values, {})
    assert.deepEqual(charts.resolveChartQuery(bound, new Date('2026-03-31T10:00:00Z')).values, first.values)
    const timed = charts.prepareChartParams({ kind: 'HogQLQuery', query: "SELECT count() FROM events WHERE timestamp >= '2026-01-01T00:00:00+00:00' AND timestamp < '2026-01-31T00:00:00+00:00'" })
    assert.equal(timed.rolling?.dates.length, 2)
    assert.throws(() => charts.validateChartParams({ query: sql, rolling: { dates: [{ key: 'unsafe', offset_ms: 0, date_only: true }] } }))
    assert.throws(() => charts.prepareChartParams({ ...query(), dateRange: { date_from: 'bad' } }))
})

test('server query uses project query API/read key and a five minute cache with concurrent single-flight', async () => {
    Date.now = () => 1_800_000_000_000
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(String(init?.body)) }); await gate; return Response.json(answer) }
    const p = charts.prepareChartParams(query())
    const a = charts.readPosthogChart(p), b = charts.readPosthogChart(p)
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1)
    release(); const [first, second] = await Promise.all([a, b]); assert.deepEqual(first, second)
    assert.equal(calls[0].url, `${config.posthog.host}/api/projects/17/query/`)
    assert.equal(calls[0].init?.method, 'POST'); assert.equal((calls[0].init?.headers as any).authorization, 'Bearer read-key')
    assert.deepEqual(calls[0].body, { query: p.query, refresh: 'blocking' })
    await charts.readPosthogChart(p); assert.equal(calls.length, 1)
    Date.now = () => 1_800_000_000_000 + charts.CHART_TTL + 1
    await charts.readPosthogChart(p); assert.equal(calls.length, 2)
    await charts.readPosthogChart(charts.prepareChartParams({ ...query(), interval: 'week' })); assert.equal(calls.length, 3)
})

test('privacy masks person names and amounts in breakdowns and SQL cells, including after an open cache hit', async () => {
    answer = { results: [{ label: 'Jane Chartperson $250000', breakdown_value: 'Jane Chartperson $250000', data: [250000], days: ['2026-01-01'] }] }
    setAnonymise({ mode: 'open' })
    const p = charts.prepareChartParams(query())
    assert.match(JSON.stringify(await charts.readPosthogChart(p)), /Jane Chartperson/)
    setAnonymise({ mode: 'standard' })
    const data = await charts.readPosthogChart(p)
    assert.equal(calls.length, 1)
    assert.doesNotMatch(JSON.stringify(data), /Jane Chartperson|\$250000/)
    assert.match(JSON.stringify(data), /\[person\]|<amount>/)
    assert.match(posthogChartHtml(p, data.result, data.updated_at), /250000/ /* counts remain counts */)
    assert.doesNotMatch(posthogChartHtml(p, data.result, data.updated_at), /Jane Chartperson|\$250000/)
    answer = { columns: ['email', 'amount', 'events'], results: [['jane@example.com', 250000, 250000]] }
    const sql = await charts.readPosthogChart(charts.prepareChartParams(query('HogQLQuery')))
    assert.deepEqual(sql.result, { columns: ['email', 'amount', 'events'], results: [['[person]', '<amount>', 250000]] })
    clearPosthogCache(); answer = { results: [{ label: 'Amount', breakdown_value: 250000, data: [3] }] }
    assert.match(JSON.stringify(await charts.readPosthogChart(p)), /<amount>/)
    answer = { results: [{ source: 'A', target: 'B', value: 250000 }] }
    const path = await charts.readPosthogChart(charts.prepareChartParams(query('PathsQuery')))
    assert.match(posthogChartHtml(charts.prepareChartParams(query('PathsQuery')), path.result, ''), /250000/)
    const sqlPin = store.createDashboard('chart@example.com', { kind: 'posthog_chart', title: 'SQL', params: charts.prepareChartParams(query('HogQLQuery')) })
    setAnonymise({ mode: 'private', posthog: 'filter' })
    assert.equal(store.updateDashboard(sqlPin.id, sqlPin.owner, false, { title: 'Renamed privately' }).title, 'Renamed privately')
    await assert.rejects(charts.readPosthogChart(sqlPin.params as import('../src/core/posthogchart.ts').PosthogChartParams), /private mode/)

})

test('pin_chart checks the real query before saving; personal view role pins but cannot share either kind', async () => {
    const c = await chat()
    try {
        const listed = (await c.client.listTools()).tools
        assert.ok(listed.some(t => t.name === 'pin_chart')); assert.ok(listed.some(t => t.name === 'pin_dashboard')); assert.ok(!listed.some(t => t.name === 'share_dashboard'))
        const description = listed.find(t => t.name === 'pin_chart')!.description!
        assert.match(description, /same query JSON/); assert.match(description, /Dates move/)
        const out = read(await c.client.callTool({ name: 'pin_chart', arguments: { title: 'Views', query: query(), share_with: ['friend@example.com'] } }))
        assert.equal(calls.length, 1); assert.equal(out.dashboard.owner, 'chart@example.com'); assert.equal(out.dashboard.kind, 'posthog_chart')
        assert.equal(store.getDashboard(out.dashboard.id)?.shared_with.length, 0); assert.match(out.message, /without sharing/)
        assert.equal(out.open, `${config.service.publicUrl}/replays/dashboards/${out.dashboard.id}`)
        const dated = { ...query(), dateRange: { date_from: '2026-01-01', date_to: '2026-01-30' } }
        const fixed = read(await c.client.callTool({ name: 'pin_chart', arguments: { title: 'Fixed', query: dated, keep_dates_fixed: true } }))
        assert.deepEqual(fixed.dashboard.params.query.dateRange, dated.dateRange)
        const moving = read(await c.client.callTool({ name: 'pin_chart', arguments: { title: 'Moving', query: dated } }))
        assert.deepEqual(moving.dashboard.params.query.dateRange, { date_from: '-30d', date_to: null })
        const old = read(await c.client.callTool({ name: 'pin_dashboard', arguments: { kind: 'task_map', title: 'Tasks', share_with: ['friend@example.com'] } }))
        assert.deepEqual(old.dashboard.shared_with, []); assert.match(old.message, /share role/)
    } finally { await c.close() }
    const shared = await chat('share')
    try {
        const out = read(await shared.client.callTool({ name: 'pin_chart', arguments: { title: 'Shared', query: query(), share_with: ['friend@example.com'] } }))
        assert.deepEqual(out.dashboard.shared_with, ['friend@example.com'])
    } finally { await shared.close() }
    const team = await chat('view', false)
    try { assert.match(JSON.stringify(await team.client.callTool({ name: 'pin_chart', arguments: { title: 'No', query: query() } })), /own token/) } finally { await team.close() }
    const admin = await chat('none', true, true)
    try {
        const out = read(await admin.client.callTool({ name: 'pin_chart', arguments: { title: 'Admin', query: query(), share_with: ['friend@example.com'] } }))
        assert.deepEqual(out.dashboard.shared_with, ['friend@example.com'])
    } finally { await admin.close() }
    assert.ok(dashboardToolNames('view').includes('pin_chart'))
})

test('failed pin queries return plain PostHog guidance and save nothing; failures are not cached', async () => {
    const before = store.listDashboards('chart@example.com', false).length
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Unknown field 'secret person'" }), { status: 400 })
    const c = await chat()
    try {
        const out = await c.client.callTool({ name: 'pin_chart', arguments: { title: 'Broken', query: query() } })
        assert.equal(out.isError, true); assert.match(JSON.stringify(out), /PostHog could not run the SQL/); assert.doesNotMatch(JSON.stringify(out), /secret person|stack|POST .*api/)
        assert.equal(store.listDashboards('chart@example.com', false).length, before)
    } finally { await c.close() }
    globalThis.fetch = async () => Response.json(answer)
    await charts.readPosthogChart(charts.prepareChartParams(query()))
})

test('every chart kind renders an accessible table, handles empty results, escapes labels and caps data', () => {
    const fixtures: Record<string, unknown> = {
        TrendsQuery: { results: [{ label: '<img src=x>', data: [4, 8], days: ['Jan 1', 'Jan 2'] }] },
        LifecycleQuery: { results: [{ label: 'New', data: [4, 8] }, { label: 'Dormant', data: [-2, -1] }] },
        StickinessQuery: { results: [{ label: 'Active', data: [1, 2], labels: ['1 day', '2 days'] }] },
        FunnelsQuery: { results: [[{ name: 'Start', count: 100, breakdown_value: 'Chrome' }, { name: 'Done', count: 40, breakdown_value: 'Chrome' }]] },
        RetentionQuery: { results: [{ label: 'Jan 1', values: [{ count: 100 }, { count: 20 }] }] },
        PathsQuery: { results: [{ source: 'A', target: 'B', count: 3 }, { source: 'B', target: 'C', count: 8 }] },
        HogQLQuery: { columns: ['Route', 'Count'], results: [['Home', 4]] },
    }
    for (const kind of charts.CHART_QUERY_KINDS) {
        const params = charts.prepareChartParams(query(kind))
        const html = posthogChartHtml(params, fixtures[kind], '2026-01-01T00:00:00Z')
        assert.match(html, /<table>/); assert.match(html, /scope="col"/); assert.match(html, /chart alternative/); assert.match(html, /Updated <time/); assert.match(html, /refreshes every 5 minutes/)
        assert.doesNotMatch(html, /<img|NaN|undefined/)
        assert.match(posthogChartHtml(params, { results: [] }, ''), /No results/)
        if (['TrendsQuery', 'LifecycleQuery', 'StickinessQuery'].includes(kind)) assert.match(html, /<svg.*role="img"/)
        if (kind === 'FunnelsQuery') assert.match(html, /40% conversion/)
        if (kind === 'RetentionQuery') assert.match(html, /20 \(20%\)/)
    }
    const many = { results: Array.from({ length: 12 }, (_, i) => ({ label: `Series ${i}`, data: [i + 1], days: ['Jan 1'] })) }
    const html = posthogChartHtml(charts.prepareChartParams(query()), many, '')
    assert.match(html, /top 10 series/); assert.equal([...html.matchAll(/<path d=/g)].length, 10)
    assert.match(posthogChartHtml(charts.prepareChartParams(query(), 'bar'), many, ''), /<rect /)
    assert.doesNotMatch(posthogChartHtml(charts.prepareChartParams(query(), 'table'), many, ''), /<svg/)
    const rows = { columns: ['Count'], results: Array.from({ length: 250 }, (_, i) => [i]) }
    assert.match(posthogChartHtml(charts.prepareChartParams(query('HogQLQuery')), rows, ''), /first 200 rows/)
})

test('chart page and JSON data endpoint enforce access, mask data and report errors without a stack', async () => {
    answer = { results: [{ label: 'Jane Chartperson $250000', data: [7], days: ['2026-01-01'] }] }
    const pin = store.createDashboard('chart@example.com', { kind: 'posthog_chart', title: 'My chart', params: charts.prepareChartParams(query()) })
    for (const path of [`/${pin.id}`, `/api/${pin.id}/data`]) {
        const own = await request(path); assert.equal(own.status, 200, own.body); assert.doesNotMatch(own.body, /Jane Chartperson|\$250000/)
        assert.equal((await request(path, viewer('none'))).status, 403)
        assert.equal((await request(path, viewer('view', 'other@example.com'))).status, 403)
        assert.equal((await request(path, viewer('none', 'admin@example.com', true))).status, 200)
    }
    const html = (await request('/' + pin.id)).body
    assert.match(html, /posthog-chart/); assert.match(html, /rename-dialog/); assert.match(html, /delete-dialog/); assert.doesNotMatch(html, /id="share-dialog"|id="open-share"/)
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script))
    assert.match((await request('?view=pinned')).body, /PostHog chart/)
    store.shareDashboard(pin.id, pin.owner, false, ['friend@example.com'])
    assert.equal((await request(`/api/${pin.id}/data`, viewer('view', 'friend@example.com'))).status, 200)
    clearPosthogCache(); globalThis.fetch = async () => { throw new Error('secret SQL and stack') }
    const failed = await request(`/api/${pin.id}/data`); assert.equal(failed.status, 502); assert.match(failed.data.error, /PostHog is unavailable/); assert.doesNotMatch(failed.body, /secret SQL|stack/)
    const page = await request('/' + pin.id); assert.equal(page.status, 200); assert.match(page.body, /PostHog is unavailable/)
    assert.equal((await request('/api/000000000000/data')).status, 404)
})

test('page view role pins and manages own dashboards; only share role shares; non-owners cannot mutate', async () => {
    for (const kind of ['task_map', 'posthog_chart']) {
        const params = kind === 'task_map' ? { window: { last_days: 7 } } : { query: query() }
        const created = await request('/api/pins', viewer(), 'POST', { kind, title: 'Page pin', params })
        assert.equal(created.status, 201, created.body)
        const path = '/api/pins/' + created.data.id
        assert.equal((await request(path, viewer(), 'PATCH', { title: 'Renamed' })).status, 200)
        assert.equal((await request(path + '/share', viewer(), 'POST', { emails: [] })).status, 403)
        assert.equal((await request(path + '/share', viewer('share'), 'POST', { emails: ['friend@example.com'] })).status, 200)
        assert.equal((await request(path, viewer('share', 'other@example.com'), 'PATCH', { title: 'No' })).status, 403)
        assert.equal((await request(path, viewer('share', 'other@example.com'), 'DELETE')).status, 403)
        assert.equal((await request(path + '/share', viewer('share', 'other@example.com'), 'POST', { emails: [] })).status, 403)
        assert.equal((await request(path, viewer(), 'PATCH', { title: 'No' }, '')).status, 403)
        assert.equal((await request(path, viewer(), 'DELETE')).status, 200)
    }
})

test('auto-refresh skips hidden tabs, redraws on success, and keeps the old chart and time after failure', async () => {
    const box = { dataset: { id: 'abcdef123456' }, innerHTML: 'Old chart · Updated yesterday' }, notice = { textContent: '' }
    let tick!: () => Promise<void>, visibility!: () => void, requests = 0, fail = true, interval = 0
    const document = { hidden: true, getElementById: (id: string) => id === 'posthog-chart' ? box : notice, addEventListener: (_n: string, cb: () => void) => { visibility = cb } }
    runInNewContext(POSTHOG_CHART_CLIENT, { document, Date, setInterval: (fn: typeof tick, ms: number) => { tick = fn; interval = ms }, fetch: async () => { requests++; if (fail) throw new Error('offline'); return { ok: true, json: async () => ({ html: 'New chart · Updated now' }) } } })
    assert.equal(interval, 300000)
    await tick(); assert.equal(requests, 0)
    document.hidden = false; await tick(); assert.equal(requests, 1); assert.equal(box.innerHTML, 'Old chart · Updated yesterday'); assert.match(notice.textContent, /last update/)
    fail = false; await tick(); assert.equal(box.innerHTML, 'New chart · Updated now'); assert.equal(notice.textContent, '')
    assert.equal(typeof visibility, 'function')
})

test('the chart script is appended safely after the dashboards script (an IIFE after it broke every Dashboards page)', async () => {
    const { POSTHOG_CHART_CLIENT } = await import('../src/service/posthogchart.ts')
    assert.match(POSTHOG_CHART_CLIENT.trimStart(), /^;/)
    // A script ending in an expression, then the chart script: must not call the first one's value.
    let calledAsFunction = false
    const fn = new Function('mark', 'document', `const x = (mark)\n${POSTHOG_CHART_CLIENT}`)
    assert.doesNotThrow(() => fn(() => { calledAsFunction = true }, { getElementById: () => null }))
    assert.equal(calledAsFunction, false)
})

test('chart labels read as people expect: no PostHog placeholders, funnel steps named from the query', async () => {
    const { posthogChartHtml } = await import('../src/service/posthogchart.ts')
    const trend = posthogChartHtml({ query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: 'PageView' }] } as never }, { results: [
        { label: '$$_posthog_breakdown_other_$$', breakdown_value: ['$$_posthog_breakdown_other_$$'], data: [5], days: ['2026-11-01'] },
        { label: 'C01', breakdown_value: ['C01'], data: [3], days: ['2026-11-01'] }] }, '2026-11-18T00:00:00Z')
    assert.doesNotMatch(trend, /\$\$_posthog|\[&quot;/)
    assert.match(trend, /<td>Other<\/td>/); assert.match(trend, /<td>C01<\/td>/)
    const funnel = posthogChartHtml({ query: { kind: 'FunnelsQuery', series: [
        { kind: 'EventsNode', event: 'PageView', properties: [{ key: 'dialog_id', value: ['DlgList'], operator: 'exact' }] },
        { kind: 'EventsNode', event: 'PageView', properties: [{ key: 'dialog_id', value: ['DlgTask05'], operator: 'exact' }] }] } as never },
        { results: [{ name: 'PageView', order: 0, count: 10 }, { name: 'PageView', order: 1, count: 7 }] }, '2026-11-18T00:00:00Z')
    assert.match(funnel, /PageView · dialog_id = DlgList/); assert.match(funnel, /PageView · dialog_id = DlgTask05/)
    assert.doesNotMatch(funnel, /<b>All · /)
})
