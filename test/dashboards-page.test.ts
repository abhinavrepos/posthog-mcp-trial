import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Viewer } from '../src/service/access.ts'
import type { FlowTime, FlowTimeParams, TaskMap, TaskMapParams, IngestStatus } from '../src/core/taskstypes.ts'

const dir = mkdtempSync(join(tmpdir(), 'dashboards-page-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
after(() => rmSync(dir, { recursive: true, force: true }))
const { handleDashboards } = await import('../src/service/dashboards.ts')
const store = await import('../src/core/dashboards.ts')
const access = await import('../src/service/access.ts')
const ROOT = '/replays/dashboards'
const window = { from: '2026-01-01', to: '2026-01-28' }
const clientName = '<img src=x onerror=1>'
const stat = { attempts: 10, done: 8, failed: 1, abandoned: 1, users: 3, median_s: 200, p90_s: 800 }
const history: IngestStatus = { days_done: 20, first_day: '2025-12-01', last_day: '2026-01-28', behind_days: 8, attempts: 10, last_run: null, last_error: null, running: true }
let mapParams: TaskMapParams | undefined, flowParams: FlowTimeParams | undefined, search = ''
const deps = {
    async taskMap(p: TaskMapParams): Promise<TaskMap> {
        mapParams = p
        return { coverage: { complete: true, unprocessed: [] }, params: { ...p, baseline: p.baseline || { from: '2025-12-04', to: '2025-12-31' } }, clients: [{ client: 'acme', client_name: clientName, attempts_now: 10, attempts_before: 20, tasks_now: 1, tasks_before: 2, missing: 1, slower: 1, score: 4 }], rows: [{ client: 'acme', client_name: clientName, task_id: 't_save', task_name: 'Save <trade>', now: stat, before: { ...stat, attempts: 20, median_s: 45 }, flags: ['missing', 'slower', 'failing', 'new', 'dropped'], typical_path: ['Open <trade>', 'Save'] }], data_through: '2026-01-28', note: 'Test <note>' }
    },
    async flowTime(p: FlowTimeParams): Promise<FlowTime> {
        flowParams = p
        return { coverage: { complete: true, unprocessed: [] }, params: { ...p, granularity: p.granularity || 'day' }, task: { task_id: p.task, name: 'Save <trade>', dialog: 'DlgTrade' }, client_name: clientName,
            summary: { attempts: 10, done: 8, done_rate: .8, median_s: 200, p90_s: 3900, users: 3 }, all_clients: { median_s: 120, p90_s: 500, done_rate: .9 },
            series: [{ period: '2026-01-01', attempts: 5, done: 4, median_s: 180, p90_s: 600 }, { period: '2026-01-02', attempts: 5, done: 4, median_s: 210, p90_s: 900 }],
            series_all: [{ period: '2026-01-01', attempts: 50, done: 45, median_s: 120, p90_s: 500 }],
            paths: [{ path: ['DlgOpen', 'DlgTrade'], labels: ['Open', 'Save <trade>'], attempts: 10, share: 1, done_rate: .8, median_s: 200 }],
            slowest: [{ client: 'acme', user: '<user>', session_id: 's1', started_at: '2026-01-01T12:00:00Z', duration_s: 3900, outcome: 'failed', path: ['Open', 'Save'], first_error: '<error>', replay_url: 'https://example.com/replay?a=1&b=2' }], top_errors: [{ template: 'Bad <trade>', count: 2 }], data_through: '2026-01-28', note: 'Flow note' }
    },
    findTasks(q: string) { search = q; return [{ task_id: 't_save', dialog: 'DlgTrade', name: 'Save <trade>', attempts_90d: 1000, clients_90d: 3 }] },
    ingestStatus() { return history },
}
const viewer = (dashboards: Viewer['dashboards'] = 'view', email = 'pm@example.com', admin = false): Viewer => ({ email, role: admin ? 'admin' : 'none', dashboards, name: 'PM', posthog_admin: admin, in_replay_project: true, session: 's' })
type Response = { status: number; body: string; data: any }
async function request(path = '', v = viewer(), method = 'GET', body?: unknown, injected: NonNullable<Parameters<typeof handleDashboards>[4]> = deps, header = '1'): Promise<Response> {
    let status = 0, output = ''
    const req = Object.assign((async function* () { if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body) })(), { method, headers: { 'x-clip-page': header } })
    const res = { writeHead(s: number) { status = s }, end(s: string) { output = s } }
    await handleDashboards(req as never, res as never, new URL('http://test' + ROOT + path), v, injected)
    let data: any
    try { data = JSON.parse(output) } catch { data = undefined }
    return { status, body: output, data }
}
function scriptsParse(html: string) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    assert.ok(scripts.length >= 2)
    for (const [, script] of scripts) assert.doesNotThrow(() => new Function(script))
}

test('access: none is refused in HTML and API; view can use both live views', async () => {
    for (const path of ['', '/api/status', '/api/task-map']) {
        const r = await request(path, viewer('none'))
        assert.equal(r.status, 403)
        assert.match(r.body, /Ask an admin for dashboard access/)
        if (!path) scriptsParse(r.body)
    }
    for (const path of ['', '?view=task_map', '?view=flow_time', '?view=flow_time&task=t_save&client=acme']) {
        const r = await request(path)
        assert.equal(r.status, 200, r.body)
        assert.match(r.body, /Client task map/)
        assert.match(r.body, /Flow time/)
        assert.doesNotMatch(r.body, /data-open="pin-dialog"/)
        scriptsParse(r.body)
    }
    assert.equal((await request('/api/pins', viewer(), 'POST', {})).status, 403)
    assert.equal((await request('/api/people')).status, 403)
})

test('realistic map and flow render escaped data, flags, charts, paths, errors and replay links', async () => {
    const map = await request('?view=task_map&from=2026-01-01&to=2026-01-28', viewer('share'))
    assert.equal(map.status, 200)
    assert.match(map.body, /&lt;img src=x onerror=1&gt;/)
    assert.doesNotMatch(map.body, /<img src=x/)
    assert.match(map.body, /did this before, not at all now/)
    assert.match(map.body, /3 min 20 s/)
    assert.match(map.body, /45 s/)
    assert.match(map.body, /Building history: 8 days to go/)
    assert.match(map.body, /view=flow_time/)
    assert.match(map.body, /data-open="pin-dialog"/)
    scriptsParse(map.body)
    const flow = await request('?view=flow_time&task=t_save&client=acme', viewer('share'))
    assert.equal(flow.status, 200)
    for (const label of ['Paths they take', 'Slowest attempts', 'Most common errors', 'All clients: 2 min', '1 h 5 min', 'Bad &lt;trade&gt;', 'target="_blank" rel="noopener"', 'aria-label="Median and p90']) assert.ok(flow.body.includes(label), label)
    assert.doesNotMatch(flow.body, /<user>|<error>|<trade>/)
    scriptsParse(flow.body)
})

test('flow page renders 100 attempts for the shared 25-row pager', async () => {
    const many = { ...deps, async flowTime(p: FlowTimeParams) {
        const result = await deps.flowTime(p)
        result.slowest = Array.from({ length: p.slowest_limit ?? 10 }, (_, i) => ({ ...result.slowest[0], session_id: `attempt-${i}`, user: `person-${i}` }))
        return result
    } }
    const page = await request('?view=flow_time&task=t_save', viewer(), 'GET', undefined, many)
    assert.equal(flowParams?.slowest_limit, 100)
    const rows = page.body.match(/<tbody data-page-list="slowest-pager"[^>]*>([\s\S]*?)<\/tbody>/)![1]
    assert.equal([...rows.matchAll(/<tr>/g)].length, 100)
    assert.match(page.body, /size:25/)
    scriptsParse(page.body)
    const api = await request('/api/flow-time?task=t_save&slowest_limit=100')
    assert.equal(api.status, 200)
    assert.equal(flowParams?.slowest_limit, 100)
    assert.equal((await request('/api/flow-time?task=t_save&slowest_limit=101')).status, 400)
})

test('query params reach the core with previous, year and custom comparisons', async () => {
    assert.equal((await request('/api/task-map?from=2026-01-01&to=2026-01-28&client=acme&task=t_save&min_attempts=8')).status, 200)
    assert.deepEqual(mapParams, { window, client: 'acme', task: 't_save', min_attempts: 8, baseline: { from: '2025-12-04', to: '2025-12-31' } })
    await request('/api/task-map?from=2026-01-01&to=2026-01-28&compare=year')
    assert.deepEqual(mapParams?.baseline, { from: '2025-01-01', to: '2025-01-28' })
    await request('/api/task-map?from=2026-01-01&to=2026-01-28&compare=custom&baseline_from=2025-10-01&baseline_to=2025-10-28')
    assert.deepEqual(mapParams?.baseline, { from: '2025-10-01', to: '2025-10-28' })
    await request('/api/flow-time?task=t_save&from=2026-01-01&to=2026-01-28&client=acme&granularity=week')
    assert.deepEqual(flowParams, { task: 't_save', window, client: 'acme', granularity: 'week' })
    await request('/api/tasks?q=hedge%20save')
    assert.equal(search, 'hedge save')
    assert.deepEqual((await request('/api/status')).data, history)
    const r = await request('/api/task-map?days=7')
    const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    assert.equal(r.data.params.window.to, end)
    assert.equal((Date.parse(end) - Date.parse(r.data.params.window.from)) / 86400000, 6)
})

test('pin lifecycle: shares, ownership, view restrictions and administrator override', async () => {
    const owner = viewer('share', 'owner@example.com'), outsider = viewer('share', 'other@example.com'), admin = viewer('none', 'admin@example.com', true)
    const created = await request('/api/pins', owner, 'POST', { kind: 'task_map', title: 'Client <map>', params: { window: { last_days: 7 } } })
    assert.equal(created.status, 201, created.body)
    const id = created.data.id, path = '/api/pins/' + id
    assert.deepEqual(created.data.params.window, { last_days: 7 })
    assert.equal(created.data.params.baseline, undefined)
    assert.equal((await request(path, outsider)).status, 403)
    assert.equal((await request('/' + id, outsider)).status, 403)
    for (const method of ['PATCH', 'DELETE']) assert.equal((await request(path, outsider, method, { title: 'No' })).status, 403)
    assert.equal((await request(path + '/share', outsider, 'POST', { emails: [] })).status, 403)
    assert.equal((await request(path + '/share', owner, 'POST', { emails: ['pm@example.com'] })).status, 200)
    assert.equal((await request(path)).status, 200)
    assert.ok((await request('/api/pins')).data.some((d: { id: string }) => d.id === id))
    const page = await request('/' + id)
    assert.equal(page.status, 200)
    assert.match(page.body, /Client &lt;map&gt;/)
    assert.doesNotMatch(page.body, /id="save-filters"/)
    scriptsParse(page.body)
    assert.equal((Date.parse(mapParams!.window.to) - Date.parse(mapParams!.window.from)) / 86400000, 6)
    assert.equal(mapParams!.baseline!.to, new Date(Date.parse(mapParams!.window.from) - 86400000).toISOString().slice(0, 10))
    assert.equal((await request(path, viewer(), 'PATCH', { title: 'No' })).status, 403)
    assert.equal((await request(path + '/share', viewer(), 'POST', { emails: [] })).status, 403)
    const managed = await request('/' + id, owner)
    assert.match(managed.body, /id="save-filters"/)
    assert.match(managed.body, /id="share-dialog"/)
    scriptsParse(managed.body)
    assert.equal((await request(path, owner, 'PATCH', { title: 'Renamed' })).data.title, 'Renamed')
    assert.equal((await request(path, owner, 'PATCH', { params: { window, task: 't_save', client: 'acme' } })).status, 200)
    assert.equal((await request(path, admin, 'PATCH', { title: 'Admin renamed' })).status, 200)
    assert.equal((await request(path + '/share', admin, 'POST', { emails: ['other@example.com'] })).status, 200)
    assert.equal((await request('/' + id, admin)).status, 200)
    assert.ok((await request('/api/pins', admin)).data.some((d: { id: string }) => d.id === id))
    assert.equal((await request(path, admin, 'DELETE')).status, 200)
    assert.equal((await request(path, owner)).status, 404)
    const own = await request('/api/pins', owner, 'POST', { kind: 'flow_time', title: 'Flow', params: { task: 't_save', window: { last_days: 28 } } })
    assert.equal(own.status, 201)
    const flowPage = await request('/' + own.data.id, owner)
    assert.equal(flowPage.status, 200)
    assert.equal(flowParams?.task, 't_save')
    assert.equal(flowParams?.slowest_limit, 100, 'old pins request the full page limit')
    const changedClient = await request('/' + own.data.id + '?client=another', owner)
    assert.equal(changedClient.status, 200)
    assert.equal(flowParams?.task, 't_save')
    assert.equal(flowParams?.client, 'another')
    assert.equal((Date.parse(flowParams!.window.to) - Date.parse(flowParams!.window.from)) / 86400000, 27)
    const customDates = await request('/' + own.data.id + '?from=2026-01-01&to=2026-01-28', owner)
    assert.equal(customDates.status, 200)
    const context = JSON.parse(customDates.body.match(/data-context="([^"]+)"/)![1].replace(/&quot;/g, '"'))
    assert.equal(context.relative, null, 'saving custom dates keeps dates fixed')
    scriptsParse(flowPage.body)
    assert.equal((await request('/api/pins/' + own.data.id, owner, 'DELETE')).status, 200)
})

test('lists expose only mine/shared pins; admins see all and can create with no explicit dashboard grant', async () => {
    store.createDashboard('private@example.com', { kind: 'task_map', title: 'Private pin', params: { window } })
    const sharedPin = store.createDashboard('private@example.com', { kind: 'task_map', title: 'Shared pin', params: { window } })
    store.shareDashboard(sharedPin.id, 'private@example.com', false, ['pm@example.com'])
    access.setDashboardRole('friend@example.com', 'view', 'admin@example.com')
    const page = await request('')
    assert.match(page.body, /Shared pin/)
    assert.doesNotMatch(page.body, /Private pin/)
    assert.match(page.body, /Shared with me/)
    const admin = viewer('none', 'admin@example.com', true)
    assert.match((await request('', admin)).body, /Private pin/)
    assert.ok((await request('/api/people', admin)).data.includes('friend@example.com'))
    const pin = await request('/api/pins', admin, 'POST', { kind: 'task_map', title: 'Admin pin', params: { window } })
    assert.equal(pin.status, 201)
    assert.equal((await request('/api/pins/' + pin.data.id, admin, 'DELETE')).status, 200)
})

test('validation refuses invalid dates, ranges, fields, JSON and pin changes', async () => {
    for (const query of ['from=oops&to=2026-01-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-01-02&to=2026-01-01', 'from=2020-01-01&to=2026-01-01', 'from=2026-01-01', 'days=0', 'days=no', 'days=7.5', 'min_attempts=-1', 'compare=unknown', 'compare=custom']) assert.equal((await request('/api/task-map?' + query)).status, 400, query)
    for (const query of ['', 'task=t_save&granularity=month']) assert.equal((await request('/api/flow-time?' + query)).status, 400)
    assert.equal((await request('/api/tasks?q=' + 'x'.repeat(201))).status, 400)
    assert.equal((await request('?view=oops')).status, 400)
    const v = viewer('share'), valid = { kind: 'task_map', title: 'Valid', params: { window } }
    for (const body of ['{', 'null', '[]', { ...valid, kind: 'unknown' }, { ...valid, title: '' }, { ...valid, params: { window: { last_days: 0 } } }, { ...valid, params: { window: { last_days: 367 } } }, { ...valid, kind: 'flow_time' }, { ...valid, params: null }]) assert.equal((await request('/api/pins', v, 'POST', body)).status, 400, JSON.stringify(body))
    assert.equal((await request('/api/pins', v, 'POST', valid, deps, '')).status, 403)
    const id = (await request('/api/pins', v, 'POST', valid)).data.id
    for (const body of [{}, { title: 'x'.repeat(121) }, { params: [] }, { params: { window: { from: 'not-date', to: 'x' } } }]) assert.equal((await request('/api/pins/' + id, v, 'PATCH', body)).status, 400)
    assert.equal((await request('/api/pins/' + id, v, 'PATCH', { title: 'CSRF' }, deps, '')).status, 403)
    for (const emails of [['bad'], ['a@example.com', 2], 'a@example.com', Array(201).fill('a@example.com')]) assert.equal((await request('/api/pins/' + id + '/share', v, 'POST', { emails })).status, 400)
    assert.equal((await request('/api/pins/000000000000')).status, 404)
    assert.equal((await request('/api/nothing')).status, 404)
    assert.equal((await request('/missing')).status, 404)
})

test('empty states and core failures produce useful pages and sanitized JSON', async () => {
    const empty = { ...deps, async taskMap(p: TaskMapParams) { const m = await deps.taskMap(p); return { ...m, clients: [], rows: [], data_through: null } }, ingestStatus() { return { ...history, first_day: null, last_day: null, attempts: 0, behind_days: 0 } } }
    const r = await request('?view=task_map', viewer(), 'GET', undefined, empty)
    assert.equal(r.status, 200)
    assert.match(r.body, /Building history/)
    assert.match(r.body, /No tasks match these filters/)
    scriptsParse(r.body)
    const broken = { ...deps, async taskMap(): Promise<TaskMap> { throw new Error('secret SQL query and stack') }, async flowTime(): Promise<FlowTime> { throw new Error('secret SQL query and stack') } }
    for (const path of ['?view=task_map', '?view=flow_time&task=t_save', '/api/task-map', '/api/flow-time?task=t_save']) {
        const r = await request(path, viewer(), 'GET', undefined, broken)
        assert.doesNotMatch(r.body, /secret SQL|stack/)
        assert.match(r.body, /history/i)
        if (!path.includes('/api/')) scriptsParse(r.body)
    }
    const danger = { ...deps, async flowTime(p: FlowTimeParams) { const f = await deps.flowTime(p); f.slowest[0].replay_url = 'javascript:alert(1)'; return f } }
    assert.doesNotMatch((await request('?view=flow_time&task=t_save', viewer(), 'GET', undefined, danger)).body, /href="javascript:/)
})

test('events without a client: listed as "Unknown client", never selected in the client filter', async () => {
    const unknown = { client: '', client_name: '', attempts_now: 7278, attempts_before: 0, tasks_now: 3, tasks_before: 0, missing: 0, slower: 0, score: 0 }
    const withUnknown = { ...deps, async taskMap(p: TaskMapParams) { const m = await deps.taskMap(p); return { ...m, clients: [unknown, ...m.clients] } } }
    const r = await request('?view=task_map&from=2026-01-01&to=2026-01-28&attention=0', viewer('share'), 'GET', undefined, withUnknown)
    assert.equal(r.status, 200)
    const select = /<select name="client"[^]*?<\/select>/.exec(r.body)![0]
    assert.equal([...select.matchAll(/<option value=""/g)].length, 1, 'only "All clients" has the empty value')
    assert.match(select, /<option value="" ?(selected)?>All clients|<option value="">All clients/)
    assert.doesNotMatch(select, /Unknown client/)
    assert.doesNotMatch(select, /value="" selected[^>]*>(?!All clients)/)
    assert.match(r.body, /<b>Unknown client<\/b>/)
})

test('rescue is the second tab; role forms, top three reasons, filters, coverage and pager', async () => {
    const rescue = { coverage: { complete: true, unprocessed: [] as string[] }, window, baseline: window, data_through: window.to, hidden_snoozed: 2, note: 'Local history', clients: [{ client: 'acme', client_name: clientName, level: 'urgent' as const, trend: 'worse' as const, score: 50, reasons: ['First', 'Second', 'Third', 'Fourth'].map(text => ({ kind: 'missing' as const, text, now: 0, before: 5 })), critical_task: { task_id: 't_save', task_name: 'Save' }, next_step: 'Ask the team', action: { owner: 'pm@example.com', status: 'contacted' as const, due: null, note: '<note>', snooze_until: null, score_at_snooze: null, updated_by: 'pm@example.com', updated_at: '2026-01-01' } }] }
    const injected = { ...deps, rescueQueue: async () => rescue }
    for (const v of [viewer(), viewer('share'), viewer('none', 'admin@example.com', true)]) {
        const r = await request('?view=rescue', v, 'GET', undefined, injected)
        assert.equal(r.status, 200); assert.match(r.body, /1 client needs someone/)
        assert.ok(r.body.indexOf('>Rescue queue</a>') < r.body.indexOf('>Client task map</a>'))
        assert.match(r.body, /&lt;img src=x onerror=1&gt;/); assert.doesNotMatch(r.body, /<img|<note>|<li>Fourth/)
        assert.match(r.body, /data-page-list="rescue-pager"/); assert.match(r.body, /Open task map for this client/)
        assert.equal(r.body.includes('<form class="rescue-action"'), v.role === 'admin' || v.dashboards === 'share')
        assert.match(r.body, /role="status" aria-live="polite"/); scriptsParse(r.body)
    }
    assert.doesNotMatch((await request('?view=rescue&level=watch', viewer(), 'GET', undefined, injected)).body, /<li>First/)
    assert.doesNotMatch((await request('?view=rescue&status=unassigned', viewer(), 'GET', undefined, injected)).body, /<li>First/)
    assert.match((await request('?view=rescue&status=mine', viewer(), 'GET', undefined, injected)).body, /<li>First/)
    assert.equal((await request('?view=rescue&level=invalid', viewer(), 'GET', undefined, injected)).status, 400)
    const incomplete = { ...injected, rescueQueue: async () => ({ ...rescue, clients: [], coverage: { complete: false, unprocessed: ['2026-01-02'], text: 'Not processed yet' } }) }
    const page = await request('?view=rescue', viewer(), 'GET', undefined, incomplete)
    assert.match(page.body, /Not processed yet/); assert.match(page.body, /Unprocessed days/); assert.doesNotMatch(page.body, /rescue-level urgent/)
})

test('rescue API enforces read/write roles, page header, validates changes and audits', async () => {
    for (const v of [viewer('none'), viewer(), viewer('share'), viewer('none', 'admin@example.com', true)]) {
        assert.equal((await request('/api/rescue', v)).status, v.dashboards === 'none' && v.role !== 'admin' ? 403 : 200)
        assert.equal((await request('/api/rescue/acme', v, 'POST', { status: 'contacted' })).status, v.dashboards === 'share' || v.role === 'admin' ? 200 : 403)
    }
    assert.equal((await request('/api/rescue/acme', viewer('share'), 'POST', { status: 'open' }, deps, '')).status, 403)
    for (const change of [{ owner: 'bad' }, { status: 'bad' }, { note: 'x'.repeat(501) }, { due: '2026-02-30' }, { status: 'expected' }, []]) {
        assert.equal((await request('/api/rescue/acme', viewer('share'), 'POST', change)).status, 400)
    }
    for (const q of ['from=bad&to=2026-01-01', 'min_attempts=0', 'include_snoozed=maybe', 'baseline_from=2026-01-01']) assert.equal((await request('/api/rescue?' + q)).status, 400)
    assert.ok(access.readAudit({ action: 'rescue.updated' }).length >= 2)
    const row = await request('/api/rescue/acme', viewer('share'), 'POST', { owner: 'pm@example.com', status: 'in_progress', note: 'Called', due: '2026-12-01' })
    assert.equal(row.data.status, 'in_progress'); assert.equal(row.data.updated_by, 'pm@example.com')
})


test('rescue failures keep internal details out of pages and JSON', async () => {
    const broken = { ...deps, rescueQueue: async (): Promise<never> => { throw new Error('secret SQL and stack') }, setRescueAction: async (): Promise<never> => { throw new Error('secret SQL and stack') } }
    for (const path of ['', '/api/rescue']) {
        const r = await request(path, viewer(), 'GET', undefined, broken)
        assert.doesNotMatch(r.body, /secret SQL|stack/); assert.match(r.body, /history/)
        if (!path) scriptsParse(r.body)
    }
    const r = await request('/api/rescue/acme', viewer('share'), 'POST', { status: 'contacted' }, broken)
    assert.doesNotMatch(r.body, /secret SQL|stack/)
})

test('rescue period: a chosen period replaces explicit dates, custom keeps them, forms collapse to a summary', async () => {
    let seen: any
    const spy = { ...deps, rescueQueue: async (p: any) => { seen = p; return { coverage: { complete: true, unprocessed: [] }, window: p.window || { from: '2026-01-01', to: '2026-01-28' }, baseline: { from: '2025-12-04', to: '2025-12-31' }, data_through: '2026-01-28', hidden_snoozed: 0, note: 'n',
        clients: [{ client: 'acme', client_name: 'Acme', level: 'urgent', score: 9, trend: 'new', reasons: [{ kind: 'missing', text: 'Stopped doing X', now: 0, before: 9 }], next_step: 'Ask', action: { owner: 'pm@example.com', status: 'contacted', note: null, due: null, snooze_until: null, score_at_snooze: null, updated_by: 'a', updated_at: 'b' } }] } as any } }
    await request('?view=rescue&from=2026-01-01&to=2026-01-10&baseline_from=2025-12-01&baseline_to=2025-12-10&days=14', viewer('share'), 'GET', undefined, spy as any)
    assert.equal(Math.round((Date.parse(seen.window.to) - Date.parse(seen.window.from)) / 86400000) + 1, 14, 'the chosen period wins')
    assert.equal(seen.baseline, undefined, 'and the explicit comparison is dropped with it')
    // With today read (but never complete) and the last complete day three days ago, the period ends there.
    const { storeAttempts, dataThrough } = await import('../src/core/tasks.ts')
    const dayAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
    storeAttempts(dayAgo(3), []); storeAttempts(dayAgo(0), [])
    await request('?view=rescue&days=14', viewer('share'), 'GET', undefined, spy as any)
    assert.equal(dataThrough(), dayAgo(3))
    assert.equal(seen.window.to, dayAgo(3), 'ends at the last fully processed day, never today')
    const custom = await request('?view=rescue&from=2026-01-01&to=2026-01-10&days=custom', viewer('share'), 'GET', undefined, spy as any)
    assert.deepEqual(seen.window, { from: '2026-01-01', to: '2026-01-10' })
    assert.match(custom.body, /<option value="custom" selected>2026-01-01 to 2026-01-10<\/option>/)
    assert.match(custom.body, /<summary>Owner: pm@example\.com · Status: contacted · <span class="linkish">Update<\/span><\/summary>/)
    assert.doesNotMatch(custom.body, /snoozed client/, 'no snoozed line when none are hidden')
})

test('briefing is the first and default view for all dashboard roles; API access and review controls', async () => {
    const brief = {generated_at:'2026-06-16',period:window,headline:'Two clients need help.',sections:{new_or_worse:[],close_soon:[],overdue:[],recovered:[],quiet_review:{client:'acme',client_name:clientName,text:'silence is not satisfaction',open:ROOT+'?view=rescue&client=acme'}},counts:{queue:2},queue_scores:{},verified_recoveries:[]}
    const injected = {...deps,mondayBrief:async()=>brief}
    for(const v of [viewer(),viewer('share'),viewer('none','admin@example.com',true)]) {
        const r = await request('',v,'GET',undefined,injected)
        assert.equal(r.status,200); assert.match(r.body,/<h1>Monday briefing/)
        assert.ok(r.body.indexOf('>Briefing</a>')<r.body.indexOf('>Rescue queue</a>'))
        assert.match(r.body,/silence is not satisfaction/); assert.doesNotMatch(r.body,/<img/)
        assert.equal(r.body.includes('data-review-client='),v.dashboards==='share'||v.role==='admin'); scriptsParse(r.body)
        assert.deepEqual((await request('/api/briefing',v,'GET',undefined,injected)).data,brief)
    }
    assert.equal((await request('/api/briefing',viewer('none'))).status,403)
    const review = await request('/api/rescue/acme',viewer('share'),'POST',{note:'Quiet review completed'})
    assert.equal(review.status,200); assert.equal(review.data.note,'Quiet review completed')
})
test('Ask them API needs survey edit access and the page header, and never needs dashboard share', async () => {
    let calls=0
    const injected = {...deps,surveysActive:()=>true,draftRescueSurvey:async(client: string,_by: string)=>{calls++; assert.equal(client,'acme'); return {survey_id:'draft',open:'/replays/surveys',message:'Draft created — review and launch it on the Surveys page'}}}
    for(const role of ['none','view','edit','launch'] as const) {
        const v={...viewer('view'),surveys:role}
        assert.equal((await request('/api/rescue/acme/ask',v,'POST',{},injected)).status,['edit','launch'].includes(role)?201:403)
    }
    assert.equal(calls,2)
    assert.equal((await request('/api/rescue/acme/ask',{...viewer(),surveys:'edit'},'POST',{},injected,'')).status,403)
    assert.equal((await request('/api/rescue/acme/ask',{...viewer(),surveys:'edit'},'POST',{}, {...injected,surveysActive:()=>false})).status,503)
    assert.equal(calls,2)
})

test('Ask them page creates a draft through injected saveSurvey and shows the button only to survey editors', async () => {
    let saved: any
    const rescue = {coverage:{complete:true,unprocessed:[]},window,baseline:window,data_through:window.to,hidden_snoozed:0,note:'',clients:[{client:'acme',client_name:'Acme',score:3,level:'watch' as const,trend:'new' as const,next_step:'Ask',reasons:[{kind:'work_moving_out' as const,text:'Exports grew',now:0,before:0}]}]}
    const injected = {...deps,surveysActive:()=>true,rescueQueue:async()=>rescue,saveSurvey:async(spec: any)=>{saved=spec;return {survey:{id:'draft-export'} as any,compiled:{problems:[]} as any}},setRescueAction:async()=>({} as any)}
    for(const role of ['none','view','edit','launch'] as const) {
        const v={...viewer('view'),surveys:role}
        const page=await request('?view=rescue',v,'GET',undefined,injected)
        assert.equal(page.body.includes('data-ask-client='),['edit','launch'].includes(role)); scriptsParse(page.body)
    }
    const result=await request('/api/rescue/acme/ask',{...viewer(),surveys:'edit'},'POST',{},injected)
    assert.equal(result.status,201); assert.equal(result.data.survey_id,'draft-export')
    assert.deepEqual(saved.clients,['acme']); assert.equal(saved.questions[0].type,'single')
    assert.match(result.data.message,/Draft created — review and launch/)
})

test('client story and handover APIs follow dashboard view roles; accessible chart, timeline, fallback and scripts render',async()=>{
    const story={client:'acme',client_name:clientName,coverage:{complete:true,unprocessed:[]},weeks:[{week_start:'2026-06-01',attempts:10,done:8,users:2,errors:3,unrecovered:1,exports:4,productive_done:5}],events:[{date:'2026-06-05',kind:'note' as const,text:'<private> note'}],surveys:[],summary:'Work changed. Action open. Cause unknown.',unknown:'Unknown'}
    const injected={...deps,clientStory:async()=>story,handoverPack:async()=> '# Handover\n\n<escaped> pack'}
    for(const v of [viewer('none'),viewer(),viewer('share'),viewer('none','admin@example.com',true)]) {
        const allowed=v.role==='admin'||v.dashboards!=='none'
        for(const path of ['?view=story&client=acme','/api/story?client=acme','/api/handover-pack?client=acme']) {
            const r=await request(path,v,'GET',undefined,injected)
            assert.equal(r.status,allowed?200:403)
            if(!path.startsWith('/api/')&&allowed) {
                assert.match(r.body,/<h1>&lt;img src=x onerror=1&gt;<\/h1>/)
                assert.match(r.body,/Weekly work counts \(chart alternative\)/);assert.match(r.body,/<svg[^>]+role="img"/)
                assert.match(r.body,/<th scope="col">users<\/th>/);assert.match(r.body,/&lt;private&gt; note/)
                assert.match(r.body,/Copy handover pack/);assert.match(r.body,/<pre id="handover-pack"/);assert.match(r.body,/&lt;escaped&gt; pack/)
                assert.doesNotMatch(r.body,/<img|<private>|<escaped>/);scriptsParse(r.body)
            }
        }
    }
    for(const path of ['?view=story','/api/story?client=acme&weeks=53','/api/story?client=acme&weeks=1.5','/api/handover-pack']) assert.equal((await request(path)).status,400)
    assert.match((await request('?view=task_map')).body,/view=story/)
})
test('briefing grid renders all eight columns, explanatory labels, story links and standard pagination',async()=>{
    const grid=[{client:'acme',client_name:'ACME',score:50,open:ROOT+'?view=story&client=acme',cells:['missing','users_lost','failing','slower','work_moving_out','recurring_close_error','giving_up','trend'].map(column=>({column,mark:column==='missing'?'●':'–',label:column==='missing'?'Yes: Hedge Designation stopped':column+': not flagged'}))}]
    const brief={generated_at:'2026-06-16',period:window,headline:'Review clients',sections:{new_or_worse:[],close_soon:[],overdue:[],recovered:[],quiet_review:null},counts:{},queue_scores:{},verified_recoveries:[],grid}
    const r=await request('',viewer(),'GET',undefined,{...deps,mondayBrief:async()=>brief})
    assert.equal(r.status,200)
    for(const name of ['Stopped task','Users stopped','Failing','Slower','Exports','Close errors','Giving up','Trend']) assert.ok(r.body.includes('<th scope="col">'+name+'</th>'))
    assert.match(r.body,/aria-label="Yes: Hedge Designation stopped"/)
    assert.match(r.body,/data-page-list="portfolio-pager"/);assert.match(r.body,/view=story/);scriptsParse(r.body)
})
