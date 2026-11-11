// Dashboard pages use the task-history contract; no PostHog queries live here.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { taskMap, flowTime, findTasks, ingestStatus } from '../core/tasks.ts'
import type { FlowTime, FlowTimeParams, TaskMap, TaskMapParams, Window, Flag } from '../core/taskstypes.ts'
import { createDashboard, getDashboard, listDashboards, updateDashboard, deleteDashboard, shareDashboard, canOpen, canManage, knownPeople, KIND_TEXT, type Dashboard, type DashboardKind } from '../core/dashboards.ts'
import { can, canDashboard, canUseDashboards, type Viewer } from './access.ts'
import { PAGE_CSS, headerHtml, APP_NAME, PAGER_JS } from './replays.ts'

const ROOT = '/replays/dashboards'
const defaults = { taskMap, flowTime, findTasks, ingestStatus }
type Deps = typeof defaults
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const num = (n: number) => n.toLocaleString('en-US')
const duration = (n: number | null) => {
    if (n == null) return '–'
    const s = Math.round(n)
    return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${Math.floor(s / 3600)} h${Math.floor(s % 3600 / 60) ? ` ${Math.floor(s % 3600 / 60)} min` : ''}`
}
const pct = (n: number | null) => n == null ? '–' : `${Math.round(n * 100)}%`
const date = (s: string) => `<time datetime="${esc(s)}">${esc(s)}</time>`
const crumbs = (p: string[]) => p.map(esc).join(' <span aria-hidden="true">›</span> ')
class InputError extends Error {}
class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
const bad = (s: string): never => { throw new InputError(s) }
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : bad('Expected a JSON object.')
const integer = (x: unknown, min: number, max: number, label: string) => {
    if ((typeof x !== 'number' && typeof x !== 'string') || !String(x).trim() || !Number.isInteger(Number(x)) || Number(x) < min || Number(x) > max) bad(`${label} must be an integer from ${min} to ${max}.`)
    return Number(x)
}
const text = (x: unknown, label: string, max = 200) => typeof x === 'string' && x.trim() && x.length <= max ? x.trim() : bad(`Give a ${label} of 1–${max} characters.`)
const day = (x: unknown) => {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || !Number.isFinite(Date.parse(x)) || new Date(x).toISOString().slice(0, 10) !== x) bad('Dates must be valid YYYY-MM-DD dates.')
    return x as string
}
const shift = (s: string, n: number) => new Date(Date.parse(s) + n * 86400000).toISOString().slice(0, 10)
const length = (w: Window) => Math.round((Date.parse(w.to) - Date.parse(w.from)) / 86400000) + 1
function windowOf(x: unknown, relative = false): Window {
    const w = object(x)
    if ('last_days' in w) {
        if (!relative) bad('Use fixed dates for this request.')
        const n = integer(w.last_days, 1, 366, 'Last days'), to = shift(new Date().toISOString().slice(0, 10), -1)
        return { from: shift(to, 1 - n), to }
    }
    const out = { from: day(w.from), to: day(w.to) }
    if (length(out) < 1 || length(out) > 366) bad('Choose a period of 1–366 days, with from before to.')
    return out
}
function paramsOf(kind: DashboardKind, raw: unknown, relative = false): TaskMapParams | FlowTimeParams {
    const p = object(raw), out: TaskMapParams = { window: windowOf(p.window, relative) }
    if (p.client !== undefined && p.client !== '') out.client = text(p.client, 'client')
    if (p.task !== undefined && p.task !== '') out.task = text(p.task, 'task')
    if (kind === 'task_map') {
        if (p.baseline !== undefined) out.baseline = windowOf(p.baseline)
        else out.baseline = { from: shift(out.window.from, -length(out.window)), to: shift(out.window.from, -1) }
        if (p.min_attempts !== undefined) out.min_attempts = integer(p.min_attempts, 1, 100000, 'Minimum attempts')
        return out
    }
    if (!out.task) bad('Choose a task to see flow time.')
    if (p.granularity !== undefined && p.granularity !== 'day' && p.granularity !== 'week') bad('Granularity must be day or week.')
    return { window: out.window, task: out.task!, ...(out.client ? { client: out.client } : {}), granularity: p.granularity as 'day' | 'week' | undefined,
        ...(p.slowest_limit !== undefined ? { slowest_limit: integer(p.slowest_limit, 1, 100, 'Slowest limit') } : {}) }
}
function queryParams(kind: DashboardKind, q: URLSearchParams): TaskMapParams | FlowTimeParams {
    const p: Record<string, unknown> = {}
    p.window = q.has('from') || q.has('to') ? { from: q.get('from'), to: q.get('to') } : { last_days: integer(q.get('days') ?? '28', 1, 366, 'Days') }
    for (const k of ['client', 'task', 'granularity', 'min_attempts', 'slowest_limit']) if (q.has(k) && q.get(k) !== '') p[k] = q.get(k)
    if (kind === 'task_map') {
        const w = windowOf(p.window, true), compare = q.get('compare') || 'previous'
        if (!['previous', 'year', 'custom'].includes(compare)) bad('Comparison must be previous, year or custom.')
        if (compare === 'custom' || q.has('baseline_from') || q.has('baseline_to')) p.baseline = { from: q.get('baseline_from'), to: q.get('baseline_to') }
        else if (compare === 'year') {
            const year = (s: string) => { const d = new Date(s); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10) }
            p.baseline = { from: year(w.from), to: year(w.to) }
        }
    }
    return paramsOf(kind, p, true)
}
// Relative pins omit the automatic baseline so it follows the moving window.
function savedParams(kind: DashboardKind, raw: unknown) {
    const p = object(raw), checked = paramsOf(kind, p, true)
    if ('last_days' in object(p.window)) {
        const out = { ...checked, window: { last_days: integer(object(p.window).last_days, 1, 366, 'Last days') } }
        if (kind === 'task_map' && p.baseline === undefined) delete (out as { baseline?: Window }).baseline
        return out
    }
    return checked
}
async function readJson(req: IncomingMessage) {
    let raw = ''
    for await (const c of req) { raw += c; if (raw.length > 20000) bad('Request body is too large.') }
    try { return object(JSON.parse(raw)) } catch (e) { if (e instanceof InputError) throw e; return bad('Send valid JSON.') }
}
function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body))
}
function html(res: ServerResponse, status: number, v: Viewer, body: string) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dashboards · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${CSS}</style></head><body>${headerHtml(v, 'Dashboards')}<main class="wide"><div id="message" role="alert"></div><div id="action-status" role="status" aria-live="polite"></div>${body}</main><script>${PAGER_JS}
${CLIENT}</script></body></html>`)
}
export async function handleDashboards(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer, deps: Deps = defaults): Promise<boolean> {
    const api = url.pathname.startsWith(ROOT + '/api/'), path = url.pathname.slice((ROOT + '/api/').length), admin = can(v.role, 'admin'), share = admin || canDashboard(v.dashboards, 'share')
    try {
        if (!canUseDashboards(v)) throw new HttpError(403, 'Ask an admin for dashboard access')
        if (api) {
            const method = req.method || 'GET'
            if (method === 'GET') {
                if (path === 'task-map') { json(res, 200, await deps.taskMap(queryParams('task_map', url.searchParams) as TaskMapParams)); return true }
                if (path === 'flow-time') { json(res, 200, await deps.flowTime(queryParams('flow_time', url.searchParams) as FlowTimeParams)); return true }
                if (path === 'tasks') { const q = url.searchParams.get('q') || ''; if (q.length > 200) bad('Search is too long.'); json(res, 200, await deps.findTasks(q, 100)); return true }
                if (path === 'status') { json(res, 200, await deps.ingestStatus()); return true }
                if (path === 'people') { if (!share) throw new HttpError(403, 'Sharing needs the dashboard share role.'); json(res, 200, knownPeople()); return true }
                if (path === 'pins') { json(res, 200, listDashboards(v.email, admin)); return true }
            }
            const match = /^pins\/([0-9a-f]{12})(?:\/(share))?$/.exec(path)
            const pin = match ? getDashboard(match[1]) : undefined
            if (match && !pin) throw new HttpError(404, 'Dashboard not found.')
            if (pin && match && method === 'GET' && !match[2]) {
                if (!canOpen(pin, v.email, admin)) throw new HttpError(403, 'This dashboard has not been shared with you.')
                json(res, 200, pin); return true
            }
            if ((path === 'pins' && method === 'POST') || (match && ['PATCH', 'DELETE', 'POST'].includes(method))) {
                if (!share || (pin && !canManage(pin, v.email, admin))) throw new HttpError(403, 'Only the owner or an admin with dashboard share access can change this dashboard.')
                // PATCH is checked here too; the outer router guards POST and DELETE.
                if (req.headers['x-clip-page'] !== '1') throw new HttpError(403, 'A page request header is required.')
                if (path === 'pins') {
                    const b = await readJson(req)
                    if (b.kind !== 'task_map' && b.kind !== 'flow_time') bad('Kind must be task_map or flow_time.')
                    json(res, 201, createDashboard(v.email, { kind: b.kind, title: text(b.title, 'title', 120), params: savedParams(b.kind as DashboardKind, b.params), via: 'page' })); return true
                }
                if (pin && match) {
                    if (method === 'DELETE' && !match[2]) { deleteDashboard(pin.id, v.email, admin); json(res, 200, { ok: true }); return true }
                    if (method === 'PATCH' && !match[2]) {
                        const b = await readJson(req)
                        if (b.title === undefined && b.params === undefined) bad('Give a title or filters to update.')
                        json(res, 200, updateDashboard(pin.id, v.email, admin, { ...(b.title !== undefined ? { title: text(b.title, 'title', 120) } : {}), ...(b.params !== undefined ? { params: savedParams(pin.kind, b.params) } : {}) })); return true
                    }
                    if (method === 'POST' && match[2] === 'share') {
                        const b = await readJson(req)
                        if (!Array.isArray(b.emails) || b.emails.length > 200 || b.emails.some(e => typeof e !== 'string' || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))) bad('Give up to 200 valid email addresses.')
                        json(res, 200, shareDashboard(pin.id, v.email, admin, b.emails)); return true
                    }
                }
            }
            throw new HttpError(404, 'Not found.')
        }
        if (req.method !== 'GET') throw new HttpError(404, 'Not found.')
        const suffix = url.pathname.slice(ROOT.length).replace(/\/$/, ''), pin = suffix ? getDashboard(suffix.slice(1)) : undefined
        if (suffix && !pin) throw new HttpError(404, 'Dashboard not found.')
        if (pin && !canOpen(pin, v.email, admin)) throw new HttpError(403, 'This dashboard has not been shared with you.')
        const selected = url.searchParams.get('view') || pin?.kind || 'task_map'
        if (selected !== 'task_map' && selected !== 'flow_time') bad('View must be task_map or flow_time.')
        const kind: DashboardKind = pin?.kind || selected as DashboardKind
        const override = ['from', 'to', 'days', 'task', 'client', 'compare', 'granularity', 'min_attempts', 'slowest_limit'].some(k => url.searchParams.has(k))
        let params: TaskMapParams | FlowTimeParams | undefined
        if (pin) {
            const saved = paramsOf(kind, pin.params, true)
            params = saved
            if (override) {
                // A URL may change one filter while keeping the rest of the saved view.
                const q = new URLSearchParams(url.searchParams)
                const newPeriod = ['days', 'from', 'to'].some(k => q.has(k))
                if (!q.has('days')) {
                    if (!q.has('from')) q.set('from', saved.window.from)
                    if (!q.has('to')) q.set('to', saved.window.to)
                }
                for (const k of ['client', 'task', 'granularity', 'min_attempts', 'slowest_limit'] as const) {
                    const value = (saved as unknown as Record<string, unknown>)[k]
                    if (!q.has(k) && value !== undefined) q.set(k, String(value))
                }
                if (!newPeriod && !q.has('compare') && !q.has('baseline_from') && !q.has('baseline_to') && 'baseline' in saved && saved.baseline) {
                    q.set('compare', 'custom'); q.set('baseline_from', saved.baseline.from); q.set('baseline_to', saved.baseline.to)
                }
                params = queryParams(kind, q)
            }
        } else if (kind !== 'flow_time' || url.searchParams.get('task')) params = queryParams(kind, url.searchParams)
        const status = await deps.ingestStatus()
        const tasks = await deps.findTasks('', 100)
        let map: TaskMap | undefined, flow: FlowTime | undefined, coreError = ''
        try {
            if (params) {
                if (kind === 'task_map') map = await deps.taskMap(params as TaskMapParams)
                else flow = await deps.flowTime({ ...params as FlowTimeParams, slowest_limit: 100 })
            }
        } catch { coreError = '<div class="card" role="alert">Task history could not be loaded. Try again shortly or ask an admin to check history processing.</div>' }
        const filterParams = params || queryParams('task_map', url.searchParams)
        // The map supplies the client choices for Flow time as well.
        let clients = map?.clients || []
        if (kind === 'flow_time') {
            try { clients = (await deps.taskMap({ window: filterParams.window })).clients } catch { /* Keep the selected client available when the map cannot load. */ }
        }
        const through = map?.data_through || flow?.data_through || status.last_day
        const building = status.behind_days > 0 || !status.attempts || through == null
        const statusLine = building ? `<p class="history" role="status">Building history: ${esc(num(status.behind_days))} days to go — figures cover ${status.first_day ? date(status.first_day) : 'no processed days yet'} to ${through ? date(through) : 'not yet available'}.</p>` : ''
        const controls = share ? `<button type="button" data-open="pin-dialog">Pin</button>` : ''
        const manage = pin && share && canManage(pin, v.email, admin)
        const context = { kind, params: filterParams, id: pin?.id, relative: url.searchParams.has('days') ? length(filterParams.window) : url.searchParams.has('from') || url.searchParams.has('to') ? null : pin && 'last_days' in pin.params.window ? (pin.params.window as unknown as { last_days: number }).last_days : null, shares: pin?.shared_with || [] }
        const body = `<div id="dashboard-context" data-context="${esc(JSON.stringify(context))}"></div>
<nav class="tabs" aria-label="Dashboard views"><a href="${ROOT}?view=task_map" ${kind === 'task_map' ? 'aria-current="page"' : ''}>Client task map</a><a href="${ROOT}?view=flow_time" ${kind === 'flow_time' ? 'aria-current="page"' : ''}>Flow time</a><a href="#pinned">Pinned</a></nav>
<div class="tools"><h1>${esc(pin?.title || KIND_TEXT[kind])}</h1><div class="actions">${controls}${manage ? '<button type="button" id="save-filters">Save filters</button><button type="button" data-open="rename-dialog">Rename</button><button type="button" id="open-share">Share</button><button type="button" data-open="delete-dialog">Delete</button>' : ''}</div></div>
${pin ? `<p class="muted">Owner: ${esc(pin.owner)} · Shared with: ${pin.shared_with.map(esc).join(', ') || 'no one yet'}</p>` : ''}
${statusLine}${filters(kind, filterParams, url, tasks, clients, pin ? 'last_days' in pin.params.window : undefined)}${coreError}
${map ? mapHtml(map, url) : flow ? flowHtml(flow) : !params ? '<div class="card"><h2>Choose a task</h2><p>Search for a task above to see completion times, paths and replays. Tasks appear after users finish work in Reval and history is processed.</p></div>' : ''}
${map?.note || flow?.note ? `<p class="muted">${esc(map?.note || flow?.note)}</p>` : ''}
${pinsHtml(listDashboards(v.email, admin), v, admin)}${share ? dialogs(pin, !!manage, length(filterParams.window)) : ''}`
        html(res, 200, v, body)
    } catch (e) {
        const status = e instanceof HttpError ? e.status : e instanceof InputError ? 400 : 400
        const message = e instanceof HttpError || e instanceof InputError ? e.message : 'Dashboard history is unavailable. Try again shortly or ask an admin to check history processing.'
        if (api) json(res, status, { error: message })
        else html(res, status, v, `<h1>Dashboards</h1><div class="card" role="alert">${esc(message)}</div><a href="${ROOT}">Back to Dashboards</a>`)
    }
    return true
}

function filters(kind: DashboardKind, p: TaskMapParams | FlowTimeParams, url: URL, tasks: Awaited<ReturnType<Deps['findTasks']>>, clients: TaskMap['clients'], savedRelative?: boolean) {
    const q = url.searchParams, option = (value: string, label: string, current: string) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
    const selectedPeriod = q.get('period') || (q.has('days') ? q.get('days')! : q.has('from') || savedRelative === false ? 'custom' : ['7', '28', '90'].includes(String(length(p.window))) ? String(length(p.window)) : 'custom')
    const compare = q.get('compare') || ('baseline' in p && p.baseline && p.baseline.to !== shift(p.window.from, -1) ? 'custom' : 'previous')
    const baseline = 'baseline' in p ? p.baseline : undefined
    const chosen = tasks.some(t => t.task_id === p.task) ? '' : p.task ? option(p.task, p.task, p.task) : ''
    return `<form id="filters" class="card filters" method="get"><input type="hidden" name="view" value="${kind}">
<label>Period<select name="period" aria-label="Period" id="period">${['7', '28', '90'].map(n => option(n, `Last ${n} days`, selectedPeriod)).join('')}${option('custom', 'Custom dates', selectedPeriod)}</select></label>
<label>From<input type="date" name="from" aria-label="From date" value="${esc(p.window.from)}" required></label><label>To<input type="date" name="to" aria-label="To date" value="${esc(p.window.to)}" required></label>
${kind === 'task_map' ? `<label>Compared with<select name="compare" aria-label="Compared with" id="compare">${option('previous', 'Previous period', compare)}${option('year', 'Same period last year', compare)}${option('custom', 'Custom comparison', compare)}</select></label><label>Comparison from<input type="date" name="baseline_from" aria-label="Comparison start date" value="${esc(baseline?.from)}"></label><label>Comparison to<input type="date" name="baseline_to" aria-label="Comparison end date" value="${esc(baseline?.to)}"></label>` : ''}
<label>Find a client<input type="search" id="client-search" aria-label="Find a client" placeholder="Search clients" autocomplete="off"></label>
<label>Client<select name="client" aria-label="Client" id="client-picker"><option value="">All clients</option>${p.client && !clients.some(c => c.client === p.client) ? option(p.client, p.client, p.client) : ''}${clients.filter(c => c.client).map(c => option(c.client, c.client_name || c.client, p.client || '')).join('')}</select></label>
<label>Find a task<input type="search" id="task-search" aria-label="Find a task" placeholder="Search tasks" autocomplete="off" aria-describedby="search-status"></label><span id="search-status" class="muted" role="status" aria-live="polite"></span>
<label>Task<select name="task" aria-label="Task" id="task-picker"${kind === 'flow_time' ? ' required' : ''}><option value="">${kind === 'flow_time' ? 'Choose a task' : 'All tasks'}</option>${chosen}${tasks.map(t => option(t.task_id, t.name, p.task || '')).join('')}</select></label>
${kind === 'flow_time' ? `<label>Group by<select name="granularity" aria-label="Group by day or week">${option('day', 'Day', 'granularity' in p ? p.granularity || (length(p.window) > 31 ? 'week' : 'day') : 'day')}${option('week', 'Week', 'granularity' in p ? p.granularity || (length(p.window) > 31 ? 'week' : 'day') : 'day')}</select></label>` : `<label>Show<select name="attention" aria-label="Show tasks"><option value="1"${showAll(q) ? '' : ' selected'}>Only what needs attention</option><option value="0"${showAll(q) ? ' selected' : ''}>All tasks</option></select></label>`}
<button type="submit">Apply filters</button></form>`
}
const FLAG: Record<Flag, [string, string]> = {
    missing: ['Missing', 'did this before, not at all now'], dropped: ['Dropped', 'attempts are down by at least half'],
    slower: ['Slower', 'typical completion time is up at least 30% and 10 seconds'], failing: ['Failing', 'the share completed fell by at least 15 percentage points'], new: ['New', 'no attempts in the earlier period'],
}
function chips(flags: Flag[]) { return flags.map(f => `<span class="flag ${f === 'new' ? 'new' : 'attention'}" title="${esc(FLAG[f][1])}">${esc(FLAG[f][0])}<span class="sr-only">: ${esc(FLAG[f][1])}</span></span>`).join(' ') }
// "Only what needs attention" is the default; links from chat say only_flagged=false for all tasks.
function showAll(q: URLSearchParams) { return q.get('attention') === '0' || q.get('only_flagged') === 'false' }
// Clients that need attention first; with "only what needs attention", the rest fold away.
function clientList(map: TaskMap, link: (client: string) => string, attention: boolean): string {
    const item = (c: TaskMap['clients'][number]) => `<div class="client">${c.client ? `<a href="${esc(link(c.client))}">${esc(c.client_name || c.client)}</a>` : '<b>Unknown client</b>'}<div>${c.missing ? `<span class="flag attention">Missing ${esc(num(c.missing))}</span>` : ''} ${c.slower ? `<span class="flag attention">Slower ${esc(num(c.slower))}</span>` : ''} ${(['dropped', 'failing'] as Flag[]).map(flag => { const count = map.rows.filter(r => r.client === c.client && r.flags.includes(flag)).length; return count ? `<span class="flag attention">${esc(FLAG[flag][0])} ${esc(num(count))}</span>` : '' }).join(' ')}</div><small class="muted">${esc(num(c.attempts_now))} attempts now · ${esc(num(c.attempts_before))} before</small></div>`
    const sorted = map.clients.slice().sort((a, b) => b.score - a.score)
    const flagged = sorted.filter(c => c.score > 0), rest = sorted.filter(c => c.score <= 0)
    const group = (list: typeof sorted, id: string) => list.length ? `<div data-page-list="${id}" data-noun="clients">${list.map(item).join('')}</div><div id="${id}"></div>` : ''
    if (!attention || !flagged.length) return group(sorted, 'clients-pager')
    return group(flagged, 'clients-pager') + (rest.length ? `<details><summary class="muted">${esc(num(rest.length))} other client${rest.length === 1 ? '' : 's'}, nothing flagged</summary>${group(rest, 'other-clients-pager')}</details>` : '')
}
function mapHtml(map: TaskMap, url: URL) {
    const attention = !showAll(url.searchParams), needy = map.clients.filter(c => c.score > 0), missing = map.clients.filter(c => c.missing > 0).length, slower = map.clients.filter(c => c.slower > 0).length
    const rows = map.rows.filter(r => !attention || r.flags.some(f => f !== 'new'))
    const link = (client: string) => { const q = new URLSearchParams(url.search); q.set('from', map.params.window.from); q.set('to', map.params.window.to); q.delete('days'); if (map.params.task) q.set('task', map.params.task); q.set('baseline_from', map.params.baseline.from); q.set('baseline_to', map.params.baseline.to); q.set('compare', 'custom'); q.set('client', client); return `${url.pathname}?${q}` }
    const flowLink = (client: string, task: string) => `${ROOT}?${new URLSearchParams({ view: 'flow_time', client, task, from: map.params.window.from, to: map.params.window.to })}`
    // Days not processed yet are not missing work: say so instead of a headline, and show no flags.
    const cover = map.coverage?.complete === false ? `<div class="card" role="alert" style="border-left:4px solid var(--warn);background:var(--warn-bg,#fff4dd)"><h2>These dates are not fully processed yet</h2><p>${esc(map.coverage.text || '')}</p></div>` : ''
    return `<section aria-label="Client task map">${cover || `<h2>${esc(num(needy.length))} client${needy.length === 1 ? '' : 's'} need attention${needy.length ? `: ${esc(num(missing))} stopped doing tasks they did before, ${esc(num(slower))} ${slower === 1 ? 'is' : 'are'} slower` : ''}</h2>`}
<div class="layout"><aside class="card"><h2>Clients</h2><a href="${esc(link(''))}">All clients</a>${clientList(map, link, attention) || '<p>No clients yet. History will fill this list as Reval users complete tasks.</p>'}</aside>
<div class="card"><h2>Tasks${map.params.client ? ' for the selected client' : ' across clients'}</h2><div class="table-wrap"><table><thead><tr><th scope="col">Client / task</th><th scope="col">Attempts now / before</th><th scope="col">Done rate</th><th scope="col">Median now / before</th><th scope="col">Flags</th><th scope="col">Typical path</th></tr></thead><tbody data-page-list="tasks-pager" data-noun="tasks">${rows.map(r => `<tr><td><small>${esc(r.client_name || r.client)}</small><br><a href="${esc(flowLink(r.client, r.task_id))}">${esc(r.task_name)}</a></td><td>${esc(num(r.now.attempts))} / ${esc(num(r.before.attempts))} <span aria-label="${r.now.attempts > r.before.attempts ? 'increased' : r.now.attempts < r.before.attempts ? 'decreased' : 'unchanged'}">${r.now.attempts > r.before.attempts ? '↑' : r.now.attempts < r.before.attempts ? '↓' : '→'}</span></td><td>${esc(pct(r.now.attempts ? r.now.done / r.now.attempts : null))}</td><td>${esc(duration(r.now.median_s))} / ${esc(duration(r.before.median_s))}</td><td>${chips(r.flags)}</td><td>${crumbs(r.typical_path)}</td></tr>`).join('') || '<tr><td colspan="6">No tasks match these filters. Try a longer period, all clients, or turn off “only what needs attention”.</td></tr>'}</tbody></table><div id="tasks-pager"></div></div></div></div></section>`
}
function chart(flow: FlowTime) {
    const sets = [{ name: flow.client_name || 'Selected clients', points: flow.series, color: 'var(--accent)' }, ...(flow.series_all ? [{ name: 'All clients', points: flow.series_all, color: 'var(--muted)' }] : [])]
    const periods = [...new Set(sets.flatMap(s => s.points.map(p => p.period)))].sort()
    if (!periods.length) return '<p>No completed attempts in this period. Try a longer period or all clients.</p>'
    const max = Math.max(1, ...sets.flatMap(s => s.points.flatMap(p => [p.median_s || 0, p.p90_s || 0]))), x = (p: string) => 65 + 615 * periods.indexOf(p) / Math.max(1, periods.length - 1), y = (n: number) => 190 - 170 * n / max
    const grid = [0, max / 2, max].map(n => `<line x1="65" x2="680" y1="${y(n)}" y2="${y(n)}" stroke="var(--line)"/><text x="60" y="${y(n) + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${esc(duration(n))}</text>`).join('')
    const lines = sets.map(s => (['median_s', 'p90_s'] as const).map(key => {
        let pen = false
        const d = s.points.map(p => { if (p[key] == null) { pen = false; return '' } const part = `${pen ? 'L' : 'M'}${x(p.period)} ${y(p[key]!)}`; pen = true; return part }).join(' ')
        return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.name === 'All clients' ? 4 : 2}"${key === 'p90_s' ? ' stroke-dasharray="5 4"' : ''}/>${s.points.filter(p => p[key] != null).map(p => `<circle cx="${x(p.period)}" cy="${y(p[key]!)}" r="4" fill="${s.color}" data-tip="${esc(`${p.period} · ${s.name} · ${key === 'median_s' ? 'Median' : 'p90'} ${duration(p[key])}`)}"><title>${esc(`${p.period} · ${s.name} · ${key === 'median_s' ? 'Median' : 'p90'} ${duration(p[key])}`)}</title></circle>`).join('')}`
    }).join('')).join('')
    return `<div class="chart"><svg viewBox="0 0 710 225" role="img" aria-label="Median and p90 flow time by period for selected clients and all clients">${grid}${lines}<text data-chart-date="${esc(periods[0])}" x="65" y="217" font-size="11" fill="var(--muted)">${esc(periods[0])}</text><text data-chart-date="${esc(periods.at(-1))}" x="680" y="217" text-anchor="end" font-size="11" fill="var(--muted)">${esc(periods.at(-1))}</text></svg><div class="tip" hidden></div></div><p class="muted">${sets.map(s => `<span style="color:${s.color}"><span aria-hidden="true">●</span> ${esc(s.name)}</span>`).join(' · ')} · Solid: median · Dashed: p90${flow.series_all ? ' · Thick: all clients · Thin: selected clients' : ''}</p><details><summary>View completion times as a table</summary><div class="table-wrap"><table><caption>Completion times by period (p90: 90% finish within this time)</caption><thead><tr><th scope="col">Period</th><th scope="col">Clients</th><th scope="col">Median</th><th scope="col">p90</th></tr></thead><tbody data-page-list="chart-pager" data-noun="periods">${sets.flatMap(s => s.points.map(p => `<tr><td>${date(p.period)}</td><td>${esc(s.name)}</td><td>${esc(duration(p.median_s))}</td><td>${esc(duration(p.p90_s))}</td></tr>`)).join('')}</tbody></table><div id="chart-pager"></div></div></details>`
}
function flowHtml(f: FlowTime) {
    const tiles = [['Attempts', num(f.summary.attempts)], ['Done rate', pct(f.summary.done_rate)], ['Median', duration(f.summary.median_s)], ['p90', duration(f.summary.p90_s)], ['Users', num(f.summary.users)]]
    return `<section aria-label="Flow time"><h2>${esc(f.task.name)}</h2>${f.coverage?.complete === false ? `<div class="card" role="status" style="border-left:4px solid var(--warn);background:var(--warn-bg,#fff4dd)"><p>${esc(f.coverage.text || '')}</p></div>` : ''}<div class="tiles">${tiles.map(([name, value]) => `<div class="tile"><span>${esc(name)}</span><b>${esc(value)}</b>${name === 'Median' ? `<small>All clients: ${esc(duration(f.all_clients.median_s))}</small>` : ''}</div>`).join('')}</div>
<div class="card"><h2>Completion time</h2>${chart(f)}</div>
<div class="card"><h2>Paths they take</h2>${f.paths.map(p => `<div class="path"><div>${crumbs(p.labels.length ? p.labels : p.path)}</div><div class="share-bar" role="meter" aria-label="Share of attempts" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.max(0, Math.min(1, p.share)) * 100)}"><i style="width:${Math.max(0, Math.min(1, p.share)) * 100}%"></i></div><small>${esc(pct(p.share))} of attempts · ${esc(num(p.attempts))} attempts · ${esc(pct(p.done_rate))} done · median ${esc(duration(p.median_s))}</small></div>`).join('') || '<p>No paths yet. Choose a task with attempts or widen the period.</p>'}</div>
<div class="card"><h2>Slowest attempts</h2><div class="table-wrap"><table><thead><tr><th scope="col">User</th><th scope="col">When</th><th scope="col">Duration</th><th scope="col">Outcome</th><th scope="col">Path</th><th scope="col">First error</th><th scope="col">Replay</th></tr></thead><tbody data-page-list="slowest-pager" data-noun="attempts">${f.slowest.map(a => {
        const safe = /^https?:\/\//i.test(a.replay_url) || (a.replay_url.startsWith('/') && !a.replay_url.startsWith('//'))
        return `<tr><td>${esc(a.user)}</td><td>${date(a.started_at)}</td><td>${esc(duration(a.duration_s))}</td><td>${esc(a.outcome)}</td><td>${crumbs(a.labels || a.path)}</td><td>${esc(a.first_error || '–')}</td><td>${safe ? `<a href="${esc(a.replay_url)}" target="_blank" rel="noopener">Open replay<span class="sr-only"> (opens in a new tab)</span></a>` : 'Replay unavailable'}</td></tr>`
    }).join('') || '<tr><td colspan="7">No attempts in this period. Try all clients or a longer period.</td></tr>'}</tbody></table><div id="slowest-pager"></div></div></div>
<div class="card"><h2>Most common errors</h2>${f.top_errors.length ? `<ul>${f.top_errors.map(e => `<li>${esc(e.template)} · ${esc(num(e.count))}</li>`).join('')}</ul>` : '<p>No errors recorded in this period.</p>'}</div></section>`
}
function pinsHtml(pins: Dashboard[], v: Viewer, admin: boolean) {
    const groups = admin ? [['All', pins] as const] : [['Mine', pins.filter(d => d.owner === v.email.toLowerCase())] as const, ['Shared with me', pins.filter(d => d.owner !== v.email.toLowerCase())] as const]
    return `<section id="pinned" class="card"><h2>Pinned</h2>${groups.map(([name, list], index) => `<h3>${name}</h3>${list.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Title</th><th scope="col">Kind</th><th scope="col">Owner</th><th scope="col">Shared</th><th scope="col">Updated</th></tr></thead><tbody data-page-list="pins-${index}-pager" data-noun="dashboards">${list.map(d => `<tr><td><a href="${ROOT}/${esc(d.id)}">${esc(d.title)}</a></td><td>${esc(KIND_TEXT[d.kind])}</td><td>${esc(d.owner)}</td><td>${esc(num(d.shared_with.length))}</td><td>${date(d.updated_at)}</td></tr>`).join('')}</tbody></table><div id="pins-${index}-pager"></div></div>` : '<p class="muted">No pinned dashboards here yet. People with share access can pin a view and share it with you.</p>'}`).join('')}</section>`
}
function dialogs(pin: Dashboard | undefined, manage: boolean, days: number) {
    const close = '<button type="button" data-close>Cancel</button>'
    return `<dialog id="pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-heading"><form id="pin-form"><h2 id="pin-heading">Pin this view</h2><label>Title<input name="title" aria-label="Dashboard title" maxlength="120" required value="${esc(pin?.title || '')}"></label><label><input type="radio" name="dates" aria-label="Keep the dates fixed" value="fixed" checked>Keep the dates fixed</label><label><input type="radio" name="dates" aria-label="Use a moving period" value="relative">Use a moving period</label><label>Number of days<input name="days" type="number" min="1" max="366" value="${days}" aria-label="Number of days"></label><p class="muted">For a moving period, comparison follows the previous period of the same length.</p><div class="actions">${close}<button type="submit">Pin</button></div></form></dialog>
${manage ? `<dialog id="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-heading"><form id="rename-form"><h2 id="rename-heading">Rename dashboard</h2><label>Title<input name="title" aria-label="Dashboard title" maxlength="120" required value="${esc(pin?.title)}"></label><div class="actions">${close}<button type="submit">Save title</button></div></form></dialog>
<dialog id="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-heading"><form id="share-form"><h2 id="share-heading">Share dashboard</h2><p>Current shares: ${pin?.shared_with.map(esc).join(', ') || 'none'}</p><label>Find a person<input type="search" id="people-search" aria-label="Find a person"></label><div id="people"></div><div id="people-pager"></div><p id="people-status" role="status" aria-live="polite"></p><label>Other emails (comma separated)<input name="emails" aria-label="Other emails, separated by commas" placeholder="person@example.com"></label><div class="actions">${close}<button type="submit">Save sharing</button></div></form></dialog>
<dialog id="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-heading"><form id="delete-form"><h2 id="delete-heading">Delete this dashboard?</h2><p>The saved view and its shares will be removed.</p><div class="actions">${close}<button type="submit">Delete</button></div></form></dialog>` : ''}`
}
const CSS = `
:root{--good:var(--ok);--warn:#9a5b00;--down:var(--err)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#151922;--card:#1d2330;--ink:#e8ebf2;--muted:#acb5c6;--line:#374151;--accent:#8fb5ff;--accent-ink:#151922;--chip:#29354d;--good:#7ed5a0;--warn:#edbd70;--down:#ffa4a0}}
input[type=checkbox],input[type=radio]{width:auto;flex:none}button{width:auto}
main.wide{max-width:1280px;min-width:0}main *{box-sizing:border-box}.tools,.actions,.tabs{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.tools{justify-content:space-between}.tabs{margin-bottom:18px}.tabs a{padding:8px 10px;border-radius:6px}.tabs [aria-current]{background:var(--chip);font-weight:600}.filters{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.filters label{flex:1 1 155px;min-width:0}label{display:block;font-size:13px}label input:not([type=checkbox]):not([type=radio]),label select{display:block;width:100%;margin-top:5px}input,select,button{font:inherit;max-width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}button{cursor:pointer}.check{display:flex;align-items:center;gap:6px}.layout{display:grid;grid-template-columns:minmax(0,250px) minmax(0,1fr);gap:14px;align-items:start}.layout .card{min-width:0}.client{padding:12px 0;border-bottom:1px solid var(--line)}.flag{display:inline-block;padding:2px 6px;border-radius:5px;background:var(--chip);font-size:12px;margin:2px 0}.flag.attention{color:var(--warn)}.flag.new{color:var(--good)}.table-wrap{max-width:100%;overflow:auto}table{width:100%;font-size:13px}td,th{vertical-align:top;overflow-wrap:anywhere}td{min-width:75px}td:first-child{min-width:125px}.tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:14px 0}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.tile span,.tile small{display:block;color:var(--muted)}.tile b{font-size:23px}.chart{position:relative}.chart svg{display:block;width:100%;height:auto}.tip{white-space:pre-line;position:absolute;left:10%;top:10px;max-width:80%;background:var(--ink);color:var(--card);padding:6px 9px;border-radius:6px;font-size:12px;pointer-events:none}.path{padding:12px 0;border-bottom:1px solid var(--line)}.share-bar{height:8px;background:var(--chip);border-radius:5px;margin:8px 0;overflow:hidden}.share-bar i{display:block;height:100%;background:var(--accent)}.history{border-left:3px solid var(--warn);padding:10px}.card,main{overflow-wrap:anywhere}dialog{color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:12px;max-width:min(480px,calc(100vw - 24px));max-height:85vh;overflow:auto}dialog::backdrop{background:#0006}dialog label{margin:12px 0}#people{max-height:240px;overflow:auto}#people label{display:flex;gap:8px}#message:not(:empty){padding:12px;border:1px solid var(--warn);margin-bottom:12px;color:var(--ink)}@media(max-width:760px){.layout{grid-template-columns:minmax(0,1fr)}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.card{padding:12px}.filters label{flex-basis:130px}.tools h1{font-size:26px}main.wide{padding:16px 12px}.actions{gap:6px}.table-wrap{overflow-x:auto}.tiles .tile:last-child{grid-column:1/-1}}`

// Browser code stays in String.raw so escaping HTML never alters JavaScript quoting.
const CLIENT = String.raw`
(()=>{
const $=id=>document.getElementById(id)
const ctx=$('dashboard-context')?JSON.parse($('dashboard-context').dataset.context):null
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const message=e=>{const dialog=document.querySelector('dialog[open]');if(dialog){let alert=dialog.querySelector('[role=alert]');if(!alert){alert=document.createElement('p');alert.setAttribute('role','alert');dialog.prepend(alert)}alert.textContent=e.message||String(e)}else $('message').textContent=e.message||String(e)}
const api=async(path,method='GET',body)=>{const r=await fetch('/replays/dashboards/api/'+path,{method,headers:{'content-type':'application/json','x-clip-page':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})}).catch(()=>{throw new Error('Could not connect. Check your connection and try again.')});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed. Try again.');return d}
const run=fn=>async e=>{e.preventDefault();const target=e.currentTarget;if(target.dataset.busy)return;target.dataset.busy='1';const buttons=target.matches('button')?[target]:[...target.querySelectorAll('button[type=submit]')];const states=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);target.setAttribute('aria-busy','true');const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Working…';(target.closest('dialog')||$('action-status')).append(status);try{await fn(e)}catch(err){message(err)}finally{status.remove();delete target.dataset.busy;target.removeAttribute('aria-busy');buttons.forEach((b,i)=>b.disabled=states[i])}}
document.querySelectorAll('[data-chart-date]').forEach(t=>{t.textContent=new Date(t.dataset.chartDate).toLocaleDateString(undefined,{timeZone:'UTC'})})
document.querySelectorAll('time[datetime]').forEach(t=>{const s=t.getAttribute('datetime'),d=new Date(s);if(!isNaN(d))t.textContent=s.length===10?d.toLocaleDateString(undefined,{timeZone:'UTC'}):d.toLocaleString()})
const openDialog=(dialog,opener)=>{dialog.querySelectorAll('[role=alert]').forEach(a=>a.remove());dialog._opener=opener;dialog.showModal();(dialog.querySelector('input:not([type=radio]),[data-close]')||dialog).focus()}
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('close',()=>{if(d._opener)d._opener.focus()}))
document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDialog($(b.dataset.open),b))
document.querySelectorAll('[data-page-list]').forEach(list=>{const items=[...list.children];if(!items.length||items[0].querySelector('td[colspan]'))return;const pg=makePager({mount:$(list.dataset.pageList),noun:list.dataset.noun,size:25,draw:slice=>list.replaceChildren(...slice)});pg.set(items)})
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close())
const form=$('filters')
if(form){
 const update=()=>{const custom=$('period').value==='custom';for(const k of ['from','to'])form.elements[k].disabled=!custom;if($('compare'))for(const k of ['baseline_from','baseline_to'])form.elements[k].disabled=$('compare').value!=='custom'}
 $('period').onchange=update;if($('compare'))$('compare').onchange=update;update()
 form.onsubmit=e=>{e.preventDefault();const q=new URLSearchParams(new FormData(form));const period=q.get('period');q.delete('period');if(period!=='custom')q.set('days',period);location.search=q.toString()}
 const clients=[...$('client-picker').options].map(o=>({value:o.value,text:o.textContent}))
 $('client-search').oninput=()=>{const q=$('client-search').value.toLowerCase(),select=$('client-picker'),selected=select.value;select.innerHTML=clients.filter(o=>!o.value||o.value===selected||o.text.toLowerCase().includes(q)).map(o=>'<option value="'+esc(o.value)+'"'+(o.value===selected?' selected':'')+'>'+esc(o.text)+'</option>').join('')}
 let timer,request=0
 $('task-search').oninput=()=>{clearTimeout(timer);const version=++request;$('search-status').textContent='Loading…';timer=setTimeout(async()=>{try{const tasks=await api('tasks?q='+encodeURIComponent($('task-search').value));if(version!==request)return;const select=$('task-picker'),chosen=select.selectedOptions[0];select.innerHTML='<option value="">'+(ctx.kind==='flow_time'?'Choose a task':'All tasks')+'</option>'+tasks.map(t=>'<option value="'+esc(t.task_id)+'">'+esc(t.name)+'</option>').join('');if(chosen&&chosen.value){if(![...select.options].some(o=>o.value===chosen.value))select.append(chosen);select.value=chosen.value}$('search-status').textContent=tasks.length+' matching tasks'}catch(err){if(version===request){$('search-status').textContent='Search failed. Try again.';message(err)}}},250)}
}
const saveParams=(relative,days)=>{const p=structuredClone(ctx.params);if(relative){p.window={last_days:Number(days)};delete p.baseline}return p}
if($('pin-form'))$('pin-form').onsubmit=run(async e=>{const f=e.target;const d=await api('pins','POST',{kind:ctx.kind,title:f.elements.title.value,params:saveParams(f.elements.dates.value==='relative',f.elements.days.value)});location.href='/replays/dashboards/'+d.id})
if($('rename-form'))$('rename-form').onsubmit=run(async e=>{await api('pins/'+ctx.id,'PATCH',{title:e.target.elements.title.value});location.reload()})
if($('save-filters'))$('save-filters').onclick=run(async()=>{await api('pins/'+ctx.id,'PATCH',{params:saveParams(!!ctx.relative,Math.round((Date.parse(ctx.params.window.to)-Date.parse(ctx.params.window.from))/86400000)+1)});location.href=location.pathname})
if($('delete-form'))$('delete-form').onsubmit=run(async()=>{await api('pins/'+ctx.id,'DELETE');location.href='/replays/dashboards'})
if($('open-share')){
 const selected=new Set(ctx.shares);let people=[]
 const pg=makePager({mount:$('people-pager'),noun:'people',size:25,draw:slice=>{$('people').innerHTML=slice.map(p=>'<label><input type="checkbox" aria-label="'+esc(p)+'" value="'+esc(p)+'"'+(selected.has(p)?' checked':'')+'>'+esc(p)+'</label>').join('');$('people').querySelectorAll('input').forEach(c=>c.onchange=()=>c.checked?selected.add(c.value):selected.delete(c.value))}})
 const draw=()=>{const filtered=people.filter(p=>p.toLowerCase().includes($('people-search').value.toLowerCase()));pg.set(filtered);$('people-status').textContent=filtered.length?filtered.length+' people':'No people match. Try another name or add an email below.'}
 $('open-share').onclick=run(async()=>{people=[...new Set([...await api('people'),...ctx.shares])].sort();draw();openDialog($('share-dialog'),$('open-share'))})
 $('people-search').oninput=draw
 $('share-form').onsubmit=run(async e=>{const extra=e.target.elements.emails.value.split(/[,;\s]+/).filter(Boolean);await api('pins/'+ctx.id+'/share','POST',{emails:[...new Set([...selected,...extra])]});location.reload()})
}
document.querySelectorAll('.chart').forEach(box=>{const tip=box.querySelector('.tip');const localTip=text=>text.replace(/^\d{4}-\d{2}-\d{2}/,d=>new Date(d).toLocaleDateString(undefined,{timeZone:'UTC'}));const show=el=>{tip.textContent=localTip(el.dataset.tip);tip.hidden=false};box.querySelectorAll('[data-tip]').forEach(el=>{el.onmouseenter=()=>show(el);el.onfocus=()=>show(el);el.onblur=()=>tip.hidden=true});box.onmousemove=e=>{const svg=box.querySelector('svg'),r=svg.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*710;let best=null,dist=Infinity;box.querySelectorAll('[data-tip]').forEach(p=>{const d=Math.abs(Number(p.getAttribute('cx'))-x);if(d<dist){dist=d;best=p}});if(best){const cx=best.getAttribute('cx');tip.textContent=[...box.querySelectorAll('[data-tip]')].filter(p=>p.getAttribute('cx')===cx).map(p=>localTip(p.dataset.tip)).join('\n');tip.hidden=false}};box.onmouseleave=()=>tip.hidden=true})
})()
`
