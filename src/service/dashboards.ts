import { scorecard } from '../core/scorecard.ts'
import { clientStory, handoverPack, type ClientStory } from '../core/story.ts'
// Dashboard pages use the task-history contract; no PostHog queries live here.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mondayBrief, GRID_COLUMNS, type MondayBrief } from '../core/briefing.ts'
import { draftRescueSurvey } from '../core/rescuesurveys.ts'
import { saveSurvey } from '../core/surveys.ts'
import { surveysActive } from '../core/config.ts'
import { rescueQueue, setRescueAction, RescueInputError, RESCUE_STATUSES, type RescueQueue, type RescueParams } from '../core/rescue.ts'
import { taskMap, flowTime, findTasks, ingestStatus, dataThrough } from '../core/tasks.ts'
import type { FlowTime, FlowTimeParams, TaskMap, TaskMapParams, Window, Flag, Coverage } from '../core/taskstypes.ts'
import { createDashboard, getDashboard, listDashboards, updateDashboard, deleteDashboard, shareDashboard, canOpen, canManage, knownPeople, KIND_TEXT, type Dashboard, type DashboardKind } from '../core/dashboards.ts'
import { can, canSurvey, canDashboard, canUseDashboards, type Viewer } from './access.ts'
import { PAGE_CSS, headerHtml, APP_NAME, PAGER_JS } from './replays.ts'

const ROOT = '/replays/dashboards'
const defaults = { scorecard, clientStory, handoverPack, mondayBrief, draftRescueSurvey, saveSurvey, surveysActive, rescueQueue, setRescueAction, taskMap, flowTime, findTasks, ingestStatus }
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
export async function handleDashboards(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer, injected: Partial<Deps> = defaults): Promise<boolean> {
    const deps = { ...defaults, ...injected }
    const api = url.pathname.startsWith(ROOT + '/api/'), path = url.pathname.slice((ROOT + '/api/').length), admin = can(v.role, 'admin'), share = admin || canDashboard(v.dashboards, 'share')
    try {
        if (!canUseDashboards(v)) throw new HttpError(403, 'Ask an admin for dashboard access')
        if (api) {
            const method = req.method || 'GET'
            if (method === 'GET') {
                if (path === 'story' || path === 'handover-pack') {
                    const client = text(url.searchParams.get('client'), 'client', 256)
                    json(res, 200, path === 'story' ? await deps.clientStory({ client, weeks: integer(url.searchParams.get('weeks') ?? '26', 1, 52, 'Weeks') }) : { markdown: await deps.handoverPack(client) }); return true
                }
                if (path === 'scorecard') { json(res,200,await deps.scorecard({weeks:integer(url.searchParams.get('weeks') ?? '52',1,52,'Weeks')})); return true }
                if (path === 'briefing') { json(res, 200, await deps.mondayBrief({ by: v.email })); return true }
                if (path === 'rescue') { json(res, 200, await deps.rescueQueue(rescueParams(url.searchParams))); return true }
                if (path === 'task-map') { json(res, 200, await deps.taskMap(queryParams('task_map', url.searchParams) as TaskMapParams)); return true }
                if (path === 'flow-time') { json(res, 200, await deps.flowTime(queryParams('flow_time', url.searchParams) as FlowTimeParams)); return true }
                if (path === 'tasks') { const q = url.searchParams.get('q') || ''; if (q.length > 200) bad('Search is too long.'); json(res, 200, await deps.findTasks(q, 100)); return true }
                if (path === 'status') { json(res, 200, await deps.ingestStatus()); return true }
                if (path === 'people') { if (!share) throw new HttpError(403, 'Sharing needs the dashboard share role.'); json(res, 200, knownPeople()); return true }
                if (path === 'pins') { json(res, 200, listDashboards(v.email, admin)); return true }
            }
            if (path.startsWith('rescue/') && method === 'POST') {
                const ask = /^rescue\/(.+)\/ask$/.exec(path)
                if (ask) {
                    if (!(admin || canSurvey(v.surveys, 'edit'))) throw new HttpError(403, 'Asking clients needs the survey edit role.')
                    if (req.headers['x-clip-page'] !== '1') throw new HttpError(403, 'A page request header is required.')
                    if (!deps.surveysActive()) throw new HttpError(503, 'Surveys are switched off or not configured.')
                    const { include_snoozed: _, ...view } = rescueParams(url.searchParams)
                    json(res, 201, await deps.draftRescueSurvey(decodeURIComponent(ask[1]), v.email, deps, view)); return true
                }
                if (!share) throw new HttpError(403, 'Rescue changes need the dashboard share role.')
                if (req.headers['x-clip-page'] !== '1') throw new HttpError(403, 'A page request header is required.')
                const change = await readJson(req)
                const { include_snoozed: _, ...view } = rescueParams(url.searchParams)
                try { json(res, 200, await deps.setRescueAction(decodeURIComponent(path.slice(7)), change, v.email, view)) }
                catch (e) { if (e instanceof RescueInputError) bad(e.message); throw e }
                return true
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
        const selected = url.searchParams.get('view') || pin?.kind || 'briefing'
        if (selected === 'scorecard' && !pin) {
            const weeks = integer(url.searchParams.get('weeks') ?? '52',1,52,'Weeks')
            html(res,200,v,rescueNav('scorecard') + `<h1>Signal scorecard</h1><p>Weekly flags compared with recorded client decisions. Counts are a sanity check; first flags are weekly observations.</p><div id="scorecard" data-weeks="${weeks}" role="status" aria-live="polite">Computing scorecard…</div>`)
            return true
        }
        if (selected === 'story' && !pin) {
            const client = text(url.searchParams.get('client'), 'client', 256)
            const story = await deps.clientStory({ client, weeks: integer(url.searchParams.get('weeks') ?? '26', 1, 52, 'Weeks') })
            html(res, 200, v, rescueNav('story', client) + storyHtml(story, await deps.handoverPack(client)))
            return true
        }
        if (url.searchParams.get('view') === 'pinned' && !pin) {
            html(res, 200, v, `${rescueNav('pinned')}<h1>Pinned</h1>${pinsHtml(listDashboards(v.email, admin), v, admin)}`)
            return true
        }
        if (selected === 'briefing' && !pin) {
            const brief = await deps.mondayBrief({ by: v.email })
            html(res, 200, v, `${rescueNav('briefing')}<h1>Monday briefing</h1>${briefingHtml(brief, share)}`)
            return true
        }
        if (selected === 'rescue' && !pin) {
            let body: string
            try { body = rescueHtml(await deps.rescueQueue(rescueParams(url.searchParams)), url, v, share, deps.surveysActive()) }
            catch (e) { if (e instanceof InputError) throw e; body = '<div class="card" role="alert">Dashboard history is unavailable. Try again shortly.</div>' }
            html(res, 200, v, `${rescueNav('rescue')}<h1>${url.searchParams.get('history') === '1' ? 'Rescue history' : 'Rescue queue'}</h1>${body}`)
            return true
        }
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
        const controls = share ? `<button class="ghost" type="button" data-open="pin-dialog">Pin</button>` : ''
        const manage = pin && share && canManage(pin, v.email, admin)
        const context = { kind, params: filterParams, id: pin?.id, relative: url.searchParams.has('days') ? length(filterParams.window) : url.searchParams.has('from') || url.searchParams.has('to') ? null : pin && 'last_days' in pin.params.window ? (pin.params.window as unknown as { last_days: number }).last_days : null, shares: pin?.shared_with || [] }
        const body = `<div id="dashboard-context" data-context="${esc(JSON.stringify(context))}"></div>
<nav class="tabs" aria-label="Dashboard views"><a href="${ROOT}?view=briefing" ${selected === 'briefing' ? 'aria-current="page"' : ''}>Briefing</a><a href="${ROOT}?view=rescue">Rescue queue</a><a href="${ROOT}?view=task_map" ${kind === 'task_map' ? 'aria-current="page"' : ''}>Client task map</a><a href="${ROOT}?view=flow_time" ${kind === 'flow_time' ? 'aria-current="page"' : ''}>Flow time</a><a href="${ROOT}?view=scorecard" ${selected === 'scorecard' ? 'aria-current="page"' : ''}>Scorecard</a><a href="${ROOT}?view=pinned" ${selected === 'pinned' ? 'aria-current="page"' : ''}>Pinned</a></nav>
<div class="tools"><h1>${esc(pin?.title || KIND_TEXT[kind])}</h1><div class="actions">${controls}${manage ? '<details class="dashboard-settings"><summary>Settings</summary><div class="actions"><button class="ghost" type="button" id="save-filters">Save filters</button><button class="ghost" type="button" data-open="rename-dialog">Rename</button><button class="ghost" type="button" id="open-share">Share</button><button class="ghost" type="button" data-open="delete-dialog">Delete</button></div></details>' : ''}</div></div>
${pin ? `<details class="ownership"><summary>Owner: ${esc(pin.owner)} · Shared with ${num(pin.shared_with.length)}</summary><p>${pin.shared_with.map(esc).join(', ') || 'No one else has access.'}</p></details>` : ''}
${statusLine}${filters(kind, filterParams, url, tasks, clients, pin ? 'last_days' in pin.params.window : undefined)}${coreError}
${map ? mapHtml(map, url) : flow ? flowHtml(flow) : !params ? '<div class="card"><h2>Choose a task</h2><p>Choose a task above to see completion times and replays.</p></div>' : ''}
${countingHelp(map?.note || flow?.note)}
${pin ? '' : ''}${share ? dialogs(pin, !!manage, length(filterParams.window)) : ''}`
        html(res, 200, v, body)
    } catch (e) {
        const known = e instanceof HttpError || e instanceof InputError || e instanceof RescueInputError
        if (!known) console.error('dashboards:', url.pathname, e)
        const status = e instanceof HttpError ? e.status : 400
        const message = known ? (e as Error).message : 'Dashboard history is unavailable. Try again shortly or ask an admin to check history processing.'
        if (api) json(res, status, { error: message })
        else html(res, status, v, `<h1>Dashboards</h1><div class="card" role="alert">${esc(message)}</div><a href="${ROOT}">Back to Dashboards</a>`)
    }
    return true
}

function rescueParams(q: URLSearchParams): RescueParams {
    const p: RescueParams = {}
    // A chosen period (days) replaces explicit dates; "custom" keeps them.
    const days = q.get('days'), period = !!days && days !== 'custom'
    if (!period && (q.has('from') || q.has('to'))) p.window = windowOf({ from: q.get('from'), to: q.get('to') })
    else if (period) {
        // End at the last fully processed day (today is still being read), as the default view does.
        const to = dataThrough() || shift(new Date().toISOString().slice(0, 10), -1)
        p.window = { from: shift(to, 1 - integer(q.get('days'), 1, 366, 'Days')), to }
    }
    if (!period && (q.has('baseline_from') || q.has('baseline_to'))) p.baseline = windowOf({ from: q.get('baseline_from'), to: q.get('baseline_to') })
    if (q.has('min_attempts')) p.min_attempts = integer(q.get('min_attempts'), 1, 100000, 'Minimum attempts')
    if (q.has('include_snoozed')) {
        if (!['true', 'false', '1', '0'].includes(q.get('include_snoozed')!)) bad('Show snoozed must be true or false.')
        p.include_snoozed = ['true', '1'].includes(q.get('include_snoozed')!)
    }
    return p
}
const rescueNav = (selected: string, client?: string) => `<nav class="tabs" aria-label="Dashboard views"><a href="${ROOT}?view=briefing" ${selected === 'briefing' ? 'aria-current="page"' : ''}>Briefing</a><a href="${ROOT}?view=rescue" ${selected === 'rescue' ? 'aria-current="page"' : ''}>Rescue queue</a><a href="${ROOT}?view=task_map">Client task map</a><a href="${ROOT}?view=flow_time">Flow time</a>${client ? `<a href="${esc(storyLink(client))}" aria-current="page">Client story</a>` : ''}<a href="${ROOT}?view=scorecard" ${selected === 'scorecard' ? 'aria-current="page"' : ''}>Scorecard</a><a href="${ROOT}?view=pinned" ${selected === 'pinned' ? 'aria-current="page"' : ''}>Pinned</a></nav>`
function rescueHtml(r: RescueQueue, url: URL, v: Viewer, share: boolean, surveysOn: boolean): string {
    const q = url.searchParams, level = q.get('level') || 'all', status = q.get('status') || 'any'
    if (!['all', 'urgent', 'watch'].includes(level)) bad('Invalid level.')
    if (!['any', 'unassigned', 'mine', ...RESCUE_STATUSES].includes(status)) bad('Invalid status.')
    const clients = (q.get('history') === '1' ? [...r.clients, ...(r.recovered || [])] : r.clients).filter(c => (!q.get('client') || c.client === q.get('client')) && (level === 'all' || c.level === level) && (status === 'any' || status === 'unassigned' && !c.action?.owner || status === 'mine' && c.action?.owner === v.email.toLowerCase() || (c.action?.status || 'open') === status))
    const options = (values: readonly string[], selected: string) => values.map(x => `<option value="${esc(x)}" ${x === selected ? 'selected' : ''}>${esc(x.replaceAll('_', ' '))}</option>`).join('')
    const urgent = r.clients.filter(c => c.level === 'urgent').length
    const today = new Date().toISOString().slice(0, 10)
    const filtered = (extra: Record<string, string>) => `${ROOT}?${new URLSearchParams({ view: 'rescue', ...Object.fromEntries([...q].filter(([k]) => !['level', 'status', 'view'].includes(k))), ...extra })}`
    const tiles = r.coverage.complete ? kpis([
        { label: 'Need someone', value: r.clients.length, sub: 'clients on the queue', href: filtered({}) },
        { label: 'Urgent', value: urgent, tone: 'crit', sub: 'act this week', href: filtered({ level: 'urgent' }) },
        { label: 'Watch', value: r.clients.length - urgent, sub: 'keep an eye on', href: filtered({ level: 'watch' }) },
        { label: 'Unassigned', value: r.clients.filter(c => !c.action?.owner).length, tone: 'warn', sub: 'no owner yet', href: filtered({ status: 'unassigned' }) },
        { label: 'Overdue', value: r.clients.filter(c => c.action?.due && c.action.due < today && c.action.status !== 'resolved').length, tone: 'crit', sub: 'follow-up date passed' },
    ]) : ''
    return `<p class="sub-line muted">${r.coverage.complete ? `<span class="sr-only">${r.clients.length} client${r.clients.length === 1 ? ' needs' : 's need'} someone. </span>` : '<b>Waiting for processed history.</b> '}${esc(r.window.from)} to ${esc(r.window.to)}, compared with ${esc(r.baseline.from)} to ${esc(r.baseline.to)} · data through ${esc(r.data_through || 'not yet available')}</p>${tiles}
${!r.coverage.complete ? `<div class="card" role="status">${esc(r.coverage.text)}<details><summary>Unprocessed days</summary>${r.coverage.unprocessed.map(esc).join(', ')}</details></div>` : ''}
<form class="filter-bar rescue-filters" method="get" data-auto><input type="hidden" name="view" value="rescue">
${['from', 'to', 'baseline_from', 'baseline_to', 'min_attempts'].filter(k => q.has(k)).map(k => `<input type="hidden" name="${k}" value="${esc(q.get(k))}">`).join('')}
<label>Period <select name="days">${(() => {
    // Explicit dates (e.g. from a chat link) show as "custom"; choosing a period replaces them.
    const len = Math.round((Date.parse(r.window.to) - Date.parse(r.window.from)) / 86400000) + 1
    const custom = q.has('from') && !/^[0-9]+$/.test(q.get('days') || '')
    return (custom ? `<option value="custom" selected>${esc(r.window.from)} to ${esc(r.window.to)}</option>` : '') + [14, 28, 56].map(d => `<option value="${d}" ${!custom && d === len ? 'selected' : ''}>Last ${d} days</option>`).join('')
})()}</select></label>
<label>Level <select name="level">${options(['all', 'urgent', 'watch'], level)}</select></label>
<label>Status <select name="status">${options(['any', 'unassigned', 'mine', ...RESCUE_STATUSES], status)}</select></label>
<label class="check"><input type="checkbox" name="include_snoozed" value="true" ${q.get('include_snoozed') === 'true' || q.get('include_snoozed') === '1' ? 'checked' : ''}> Snoozed${r.hidden_snoozed ? ` (${r.hidden_snoozed})` : ''}</label></form>
${share ? `<datalist id="rescue-people">${knownPeople().map(e => `<option value="${esc(e)}"></option>`).join('')}</datalist>` : ''}
<div class="rq card"><div class="rq-head" aria-hidden="true"><span>Client</span><span>Main reason</span><span>Owner</span><span>Status</span></div>
<div data-page-list="rescue-pager" data-noun="clients">${clients.map(c => {
    const a = c.action, link = new URLSearchParams({ view: 'task_map', client: c.client, from: r.window.from, to: r.window.to, baseline_from: r.baseline.from, baseline_to: r.baseline.to })
    const flow = new URLSearchParams({ view: 'flow_time', client: c.client, task: c.critical_task?.task_id || '', from: r.window.from, to: r.window.to })
    const statusText = (a?.status || 'open').replaceAll('_', ' ')
    return `<details class="rescue-client rq-row"><summary><span class="rq-client"><b>${esc(c.client_name)}</b> <span class="rescue-level ${c.level}">${c.level}</span><span class="small rq-trend trend-${esc(c.trend.replace(/\s+/g, '-'))}">${esc(c.trend)}</span></span><span class="rq-reason">${esc(c.reasons[0]?.text || '')}${c.reasons.length > 1 ? ` <span class="muted small">· ${c.reasons.length - 1} more</span>` : ''}</span><span class="rq-owner${a?.owner ? '' : ' muted'}">${esc(a?.owner || 'Unassigned')}</span><span class="rq-status"><span class="badge${statusText === 'open' ? '' : ' info'}">${esc(statusText)}</span>${a?.due ? `<span class="muted small"> due ${esc(a.due)}</span>` : ''}</span></summary>
<div class="rq-body"><ul>${c.reasons.slice(0, 3).map(reason => `<li>${esc(reason.text)}</li>`).join('')}</ul><p><b>Next step:</b> ${esc(c.next_step)}</p>${c.recovery_text ? `<p class="muted">${esc(c.recovery_text)}</p>` : ''}
<p class="rq-links"><a href="${esc(storyLink(c.client))}">Client story</a><a href="${ROOT}?${esc(link)}">Task map</a>${c.critical_task ? `<a href="${ROOT}?${esc(flow)}">Flow time</a>` : ''}${(can(v.role, 'admin') || canSurvey(v.surveys, 'edit')) && surveysOn ? `<button type="button" class="secondary" data-ask-client="${esc(c.client)}">Ask them</button>` : ''}</p>
${share ? `<form class="rescue-action" data-client="${esc(c.client)}">
<label>Owner <input type="email" name="owner" list="rescue-people" value="${esc(a?.owner)}" placeholder="Email"></label>
<label>Status <select name="status">${options(RESCUE_STATUSES, a?.status || 'open')}</select></label>
<label>Due <input type="date" name="due" value="${esc(a?.due)}"></label>
<label class="wide">Note <textarea name="note" maxlength="500" rows="2">${esc(a?.note)}</textarea></label>
<label class="snooze-field" ${a?.status !== 'expected' ? 'hidden' : ''}>Snooze until <input type="date" name="snooze_until" value="${esc(a?.snooze_until)}"></label>
<div><button type="submit">Save</button> <span role="status" aria-live="polite"></span></div></form>` : `${a?.note ? `<p>${esc(a.note)}</p>` : ''}`}</div></details>`
}).join('') || `<p class="rq-empty">${!r.coverage.complete ? 'Flags appear once both periods are processed.' : r.clients.length ? 'No clients match these filters.' : 'No client needs someone in this period. A shorter period shows recent changes sooner.'}</p>`}</div></div><div id="rescue-pager"></div><p class="muted small">${esc(r.note)}</p>`
}

/** A row of KPI tiles: a quiet label, the number, one line of context; a tile can link to the filtered view. */
type Kpi = { label: string; value: number | string; sub?: string; tone?: 'crit' | 'warn'; href?: string }
const kpis = (items: Kpi[]) => `<div class="kpis">${items.map(k => { const inner = `<span class="l">${k.tone ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(k.label)}</span><span class="v">${esc(typeof k.value === 'number' ? num(k.value) : k.value)}</span>${k.sub ? `<span class="s">${esc(k.sub)}</span>` : ''}`; return k.href ? `<a class="kpi${k.tone && Number(k.value) ? ' ' + k.tone : ''}" href="${esc(k.href)}">${inner}</a>` : `<div class="kpi${k.tone && Number(k.value) ? ' ' + k.tone : ''}">${inner}</div>` }).join('')}</div>`
const storyLink = (client: string) => ROOT + '?' + new URLSearchParams({ view: 'story', client })
function gridHtml(b: MondayBrief): string {
    return `<section><p class="muted small">Last 28 days. ● marks a warning sign (hover or focus for the reason). Trend compares with the 28 days before. A row without marks is not proof that all is well.</p><div class="table-wrap"><table><caption class="sr-only">Clients and their warning signs</caption><thead><tr><th scope="col">Client</th>${GRID_COLUMNS.map(([,label]) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-page-list="portfolio-pager" data-noun="clients">${(b.grid || []).map(r => `<tr><th scope="row"><a href="${esc(r.open)}">${esc(r.client_name)}</a>${r.level === 'urgent' ? ' <span class="rescue-level urgent">urgent</span>' : ''}</th>${r.cells.map(c => `<td><span role="img" aria-label="${esc(c.label)}" title="${esc(c.label)}">${esc(c.mark)}</span></td>`).join('')}</tr>`).join('') || `<tr><td colspan="${GRID_COLUMNS.length + 1}">No clients flagged in processed history.</td></tr>`}</tbody></table><div id="portfolio-pager"></div></div></section>`
}
function storyHtml(s: ClientStory, pack: string): string {
    const columns = ['attempts', 'done', 'users', 'errors', 'exports'] as const
    const max = Math.max(1, ...s.weeks.flatMap(w => columns.map(k => w[k])))
    const colours = ['#536b84','#28705b','#856233','#a54938','#755d8a']
    return `<h1>${esc(s.client_name)}</h1><p>${esc(s.summary)}</p>${coverageHtml(s.coverage, false)}
<section class="card"><h2>Weekly work</h2><p class="muted">UTC calendar weeks; the last week may be partial. Missing history can lower counts. Lines: attempts, done, users, errors, exports; exact counts in the table below.</p>
<div class="actions">${columns.map((k,i) => `<span><svg width="24" height="12" aria-hidden="true"><line x1="0" y1="6" x2="24" y2="6" stroke="${colours[i]}" stroke-width="2" stroke-dasharray="${i ? `${i*3} 3` : 'none'}"/></svg> ${k}</span>`).join('')}</div>
<svg viewBox="0 0 720 180" role="img" aria-labelledby="story-chart-title" style="width:100%;max-height:220px"><title id="story-chart-title">Weekly attempts, done, distinct users, error chains and export submits; see table for values</title><text x="20" y="14" font-size="11">${max}</text><text x="20" y="178" font-size="11">${esc(s.weeks[0]?.week_start)}</text><text x="700" y="178" text-anchor="end" font-size="11">${esc(s.weeks.at(-1)?.week_start)}</text>${columns.map((k,i) => `<polyline fill="none" stroke="${colours[i]}" stroke-width="2" stroke-dasharray="${i ? `${i*3} 3` : 'none'}" points="${s.weeks.map((w,n) => `${20+n*680/Math.max(1,s.weeks.length-1)},${160-w[k]*140/max}`).join(' ')}"/>`).join('')}</svg>
<details><summary>Weekly counts table</summary><div class="table-wrap"><table><caption>Weekly work counts (chart alternative)</caption><thead><tr><th scope="col">Week start</th>${[...columns,'unrecovered','productive_done'].map(k => `<th scope="col">${esc(k.replaceAll('_',' '))}</th>`).join('')}</tr></thead><tbody>${s.weeks.map(w => `<tr><th scope="row">${esc(w.week_start)}</th>${[...columns,'unrecovered','productive_done'].map(k => `<td>${esc(w[k as keyof typeof w])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></section>
<section class="card"><h2>Compared with other clients</h2><p class="muted">${esc(s.peer_note || 'At least five other clients with five done each; equal weight per client. Trailing 28 days.')}</p><ul>${(s.peers || []).map(p=>`<li>${esc(p.text)}</li>`).join('') || '<li>No qualifying peer gaps in processed history.</li>'}</ul></section>
<section class="card"><h2>Timeline</h2><p class="muted">Weekly reviews compare trailing 28-day rescue periods. First observed does not establish when a change began; a cleared flag does not establish recovery.</p><ol data-page-list="story-pager" data-noun="events">${s.events.map(e => `<li>${date(e.date)} — ${esc(e.text)}</li>`).join('') || '<li>No events recorded in this period.</li>'}</ol><div id="story-pager"></div></section>
<section class="card"><h2>Handover pack</h2><button type="button" id="copy-handover">Copy handover pack</button><p id="copy-status" role="status" aria-live="polite"></p><pre id="handover-pack" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(pack)}</pre></section>`
}

function briefingHtml(b: MondayBrief, share: boolean): string {
    const card = (item: NonNullable<MondayBrief['sections']['quiet_review']>) => `<article class="card"><h3><a href="${esc(item.open)}">${esc(item.client_name)}</a> · <a href="${esc(storyLink(item.client))}">Client story</a></h3><p>${esc(item.text)}</p></article>`
    const titles = { new_or_worse: 'Changed since your last briefing', close_soon: 'Month-end close coming up', overdue: 'Overdue follow-ups', recovered: 'Recovered' }
    // Empty sections become one quiet line at the end instead of a card each.
    const empty: string[] = []
    const section = (k: keyof typeof titles) => (b.sections[k] || []).length ? `<section class="card"><h2>${titles[k]}</h2>${(b.sections[k] || []).map(card).join('')}</section>` : (empty.push(titles[k]), '')
    // New clients are a short list, one line each; the client story has the detail.
    const fresh = b.sections.new_clients || []
    const newClients = `<section class="card"><h2>New clients</h2>${fresh.length ? `<ul class="compact">${fresh.map(i => `<li><a href="${esc(i.open)}">${esc(i.client_name)}</a>: ${esc(i.text.replace(/^[^(]*\(/, '(').replace(/^\(([^)]*)\):\s*/, '$1 · '))}</li>`).join('')}</ul>` : '<p class="muted">No new clients in the last 90 days.</p>'}</section>`
    return `<p class="sub-line muted">Week ${esc(b.period.from)} to ${esc(b.period.to)} · <span class="lead">${esc(b.headline)}</span></p>${kpis([
        { label: 'Need someone', value: b.counts.queue ?? 0, sub: 'on the rescue queue', href: `${ROOT}?view=rescue` },
        { label: 'Urgent', value: b.counts.urgent ?? 0, tone: 'crit', sub: 'act this week', href: `${ROOT}?view=rescue&level=urgent` },
        { label: 'New or worse', value: b.counts.new_or_worse ?? 0, tone: 'warn', sub: 'since your last briefing' },
        { label: 'Overdue follow-ups', value: b.counts.overdue ?? 0, tone: 'crit', sub: 'date passed' },
        { label: 'Recovered', value: b.counts.recovered ?? 0, sub: 'verified this week' },
    ])}${section('new_or_worse')}${section('close_soon')}${section('overdue')}${section('recovered')}<section class="card"><h2>Quiet account to check</h2>${b.sections.quiet_review ? card(b.sections.quiet_review) + (share ? `<button type="button" data-review-client="${esc(b.sections.quiet_review.client)}">Mark reviewed</button>` : '') : '<p class="muted">No steady low-use client to review.</p>'}</section>${newClients}${empty.length ? `<p class="muted small">Nothing this week: ${empty.map(esc).join(' · ')}.</p>` : ''}<details class="card fold"><summary><h2>All clients at a glance</h2><span class="muted small">${esc(num(b.grid?.length ?? 0))} clients · warning signs, last 28 days</span></summary>${gridHtml(b)}</details>`
}

function filters(kind: DashboardKind, p: TaskMapParams | FlowTimeParams, url: URL, tasks: Awaited<ReturnType<Deps['findTasks']>>, clients: TaskMap['clients'], savedRelative?: boolean) {
    const q = url.searchParams, option = (value: string, label: string, current: string) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
    const selectedPeriod = q.get('period') || (q.has('days') ? q.get('days')! : q.has('from') || savedRelative === false ? 'custom' : ['7', '28', '90'].includes(String(length(p.window))) ? String(length(p.window)) : 'custom')
    const compare = q.get('compare') || ('baseline' in p && p.baseline && p.baseline.to !== shift(p.window.from, -1) ? 'custom' : 'previous')
    const baseline = 'baseline' in p ? p.baseline : undefined
    const chosen = tasks.some(t => t.task_id === p.task) ? '' : p.task ? option(p.task, p.task, p.task) : ''
    const taskControls = `<div class="task-choice"><label>Find a task<input type="search" id="task-search" aria-label="Find a task" placeholder="Search tasks" autocomplete="off" aria-describedby="search-status"></label><span id="search-status" class="muted" role="status" aria-live="polite"></span>
<label>Task<select name="task" aria-label="Task" id="task-picker"${kind === 'flow_time' ? ' required' : ''}><option value="">${kind === 'flow_time' ? 'Choose a task' : 'All tasks'}</option>${chosen}${tasks.map(t => option(t.task_id, t.name, p.task || '')).join('')}</select></label></div>`
    return `<form id="filters" class="card filters" method="get"><input type="hidden" name="view" value="${kind}">
<div class="filter-main"><label>Period<select name="period" aria-label="Period" id="period">${['7', '28', '90'].map(n => option(n, `Last ${n} days`, selectedPeriod)).join('')}${option('custom', 'Custom dates', selectedPeriod)}</select></label>
<div class="date-fields" id="period-dates"${selectedPeriod === 'custom' ? '' : ' hidden'}><label>From<input type="date" name="from" aria-label="From date" value="${esc(p.window.from)}" required></label><label>To<input type="date" name="to" aria-label="To date" value="${esc(p.window.to)}" required></label></div>
<label>Client<select name="client" aria-label="Client" id="client-picker"><option value="">All clients</option>${p.client && !clients.some(c => c.client === p.client) ? option(p.client, p.client, p.client) : ''}${clients.filter(c => c.client).map(c => option(c.client, c.client_name || c.client, p.client || '')).join('')}</select></label>
${kind === 'flow_time' ? taskControls : `<label>Show<select name="attention" aria-label="Show tasks"><option value="1"${showAll(q) ? '' : ' selected'}>Only what needs attention</option><option value="0"${showAll(q) ? ' selected' : ''}>All tasks</option></select></label>`}
</div>
<details class="more-filters"><summary>More filters${kind === 'task_map' && p.task ? ' · Task selected' : ''}${kind === 'task_map' && compare === 'year' ? ' · Last year' : compare === 'custom' ? ' · Custom comparison' : ''}</summary><div class="filter-extra">
<label>Find a client<input type="search" id="client-search" aria-label="Find a client" placeholder="Search clients" autocomplete="off"></label>
${kind === 'task_map' ? `${taskControls}<label>Compared with<select name="compare" aria-label="Compared with" id="compare">${option('previous', 'Previous period', compare)}${option('year', 'Same period last year', compare)}${option('custom', 'Custom comparison', compare)}</select></label><div class="date-fields" id="comparison-dates"${compare === 'custom' ? '' : ' hidden'}><label>Comparison from<input type="date" name="baseline_from" aria-label="Comparison start date" value="${esc(baseline?.from)}"></label><label>Comparison to<input type="date" name="baseline_to" aria-label="Comparison end date" value="${esc(baseline?.to)}"></label></div><label>Minimum attempts<input name="min_attempts" aria-label="Minimum attempts" type="number" min="1" max="100000" value="${esc('min_attempts' in p ? p.min_attempts ?? 5 : 5)}"></label>` : `<label>Group by<select name="granularity" aria-label="Group by day or week">${option('day', 'Day', 'granularity' in p ? p.granularity || (length(p.window) > 31 ? 'week' : 'day') : 'day')}${option('week', 'Week', 'granularity' in p ? p.granularity || (length(p.window) > 31 ? 'week' : 'day') : 'day')}</select></label>`}
</div></details></form>`
}
function countingHelp(note?: string) {
    if (!note) return ''
    const warnings = note.split('. ').filter(s => s.includes('not fully processed') || s.includes('results are truncated'))
    return `${warnings.length ? `<p class="history" role="status">${esc(warnings.join('. '))}</p>` : ''}<details class="counting-help"><summary>How this is counted</summary><p class="muted">${esc(note)}</p></details>`
}
function coverageHtml(coverage: Coverage | undefined, flags: boolean) {
    if (coverage?.complete !== false) return ''
    const days = coverage.unprocessed
    return `<div class="history" role="${flags ? 'alert' : 'status'}"><p>${flags ? 'These dates are not processed yet; flags will appear when both periods are complete.' : 'These dates are not processed yet; completion times are partial.'}</p>${days.length ? `<p class="coverage-dates">${num(days.length)} day${days.length === 1 ? '' : 's'}: ${date(days[0])}${days.length > 1 ? ` – ${date(days.at(-1)!)}` : ''}</p>` : ''}${coverage.text ? `<details><summary>Processing details</summary><p>${esc(coverage.text)}</p></details>` : ''}</div>`
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
    const item = (c: TaskMap['clients'][number]) => `<div class="client">${c.client ? `<a href="${esc(link(c.client))}">${esc(c.client_name || c.client)}</a> · <a href="${esc(storyLink(c.client))}">Story</a>` : '<b>Unknown client</b>'}<div>${c.missing ? `<span class="flag attention">Missing ${esc(num(c.missing))}</span>` : ''} ${c.slower ? `<span class="flag attention">Slower ${esc(num(c.slower))}</span>` : ''} ${(['dropped', 'failing'] as Flag[]).map(flag => { const count = map.rows.filter(r => r.client === c.client && r.flags.includes(flag)).length; return count ? `<span class="flag attention">${esc(FLAG[flag][0])} ${esc(num(count))}</span>` : '' }).join(' ')}</div><small class="muted">${esc(num(c.attempts_now))} attempts now · ${esc(num(c.attempts_before))} before</small></div>`
    const sorted = map.clients.slice().sort((a, b) => b.score - a.score)
    const flagged = sorted.filter(c => c.score > 0), rest = sorted.filter(c => c.score <= 0)
    const group = (list: typeof sorted, id: string) => list.length ? `<div data-page-list="${id}" data-noun="clients">${list.map(item).join('')}</div><div id="${id}"></div>` : ''
    if (!attention || !flagged.length) return group(sorted, 'clients-pager')
    return group(flagged, 'clients-pager') + (rest.length ? `<details><summary class="muted">${esc(num(rest.length))} other client${rest.length === 1 ? '' : 's'}, nothing flagged</summary>${group(rest, 'other-clients-pager')}</details>` : '')
}
/** Clients per kind of flag, naming only the kinds present, e.g. "1 failing · 1 dropped". */
function flagSummary(map: TaskMap): string {
    const words: [Flag, string][] = [['missing', 'stopped a task'], ['dropped', 'dropped'], ['failing', 'failing'], ['slower', 'slower']]
    const parts = words.map(([f, w]) => [new Set(map.rows.filter(r => r.flags.includes(f)).map(r => r.client)).size, w] as const).filter(([n]) => n)
    return parts.map(([n, w]) => `${num(n)} ${w}`).join(' · ') || 'Flagged by overall use'
}
function mapHtml(map: TaskMap, url: URL) {
    const attention = !showAll(url.searchParams), needy = map.clients.filter(c => c.score > 0)
    const rows = map.rows.filter(r => !attention || r.flags.some(f => f !== 'new'))
    const link = (client: string) => { const q = new URLSearchParams(url.search); q.set('from', map.params.window.from); q.set('to', map.params.window.to); q.delete('days'); if (map.params.task) q.set('task', map.params.task); q.set('baseline_from', map.params.baseline.from); q.set('baseline_to', map.params.baseline.to); q.set('compare', 'custom'); q.set('client', client); return `${url.pathname}?${q}` }
    const flowLink = (client: string, task: string) => `${ROOT}?${new URLSearchParams({ view: 'flow_time', client, task, from: map.params.window.from, to: map.params.window.to })}`
    // Days not processed yet are not missing work: say so instead of a headline, and show no flags.
    const cover = coverageHtml(map.coverage, true)
    const flagged = (f: Flag) => new Set(map.rows.filter(r => r.flags.includes(f)).map(r => r.client)).size
    const tiles = cover ? '' : kpis([
        { label: 'Clients needing attention', value: needy.length, sub: needy.length ? flagSummary(map) : 'nothing flagged', tone: 'warn' },
        { label: 'Failing', value: flagged('failing'), sub: 'done rate fell', tone: 'crit' },
        { label: 'Dropped', value: flagged('dropped'), sub: 'far fewer attempts', tone: 'warn' },
        { label: 'Stopped a task', value: flagged('missing'), sub: 'no attempts now', tone: 'crit' },
        { label: 'Slower', value: flagged('slower'), sub: 'median time up' },
    ])
    return `<section aria-label="Client task map">${cover || `${tiles}<h2 class="sr-only">${esc(num(needy.length))} client${needy.length === 1 ? ' needs' : 's need'} attention</h2>`}
<div class="layout"><aside class="card"><h2>Clients</h2><a href="${esc(link(''))}">All clients</a>${clientList(map, link, attention) || '<p>No clients yet. Check again after history is processed.</p>'}</aside>
<div class="card"><h2>Tasks${map.params.client ? ' for the selected client' : ' across clients'}</h2><div class="table-wrap"><table><thead><tr><th scope="col">Client / task</th><th scope="col">Attempts now / before</th><th scope="col">Done rate</th><th scope="col">Median now / before</th><th scope="col">Flags</th><th scope="col">Typical path</th></tr></thead><tbody data-page-list="tasks-pager" data-noun="tasks">${rows.map(r => `<tr><td><small>${esc(r.client_name || r.client)}</small><br><a href="${esc(flowLink(r.client, r.task_id))}">${esc(r.task_name)}</a></td><td>${esc(num(r.now.attempts))} / ${esc(num(r.before.attempts))} <span aria-label="${r.now.attempts > r.before.attempts ? 'increased' : r.now.attempts < r.before.attempts ? 'decreased' : 'unchanged'}">${r.now.attempts > r.before.attempts ? '↑' : r.now.attempts < r.before.attempts ? '↓' : '→'}</span></td><td>${esc(pct(r.now.attempts ? r.now.done / r.now.attempts : null))}</td><td>${esc(duration(r.now.median_s))} / ${esc(duration(r.before.median_s))}</td><td>${chips(r.flags)}</td><td>${crumbs(r.typical_path)}</td></tr>`).join('') || '<tr><td colspan="6">No tasks match these filters. Try a longer period, all clients, or turn off “only what needs attention”.</td></tr>'}</tbody></table><div id="tasks-pager"></div></div></div></div></section>`
}
function chart(flow: FlowTime) {
    const sets = [{ name: flow.client_name || 'Selected clients', points: flow.series, color: 'var(--ink)' }, ...(flow.series_all ? [{ name: 'All clients', points: flow.series_all, color: 'var(--muted)' }] : [])]
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
    const tiles = [['Attempts', num(f.summary.attempts)], ['Done rate', pct(f.summary.done_rate)], ['Median', duration(f.summary.median_s)], ['90% finish within', duration(f.summary.p90_s)], ['Users', num(f.summary.users)]]
    return `<section aria-label="Flow time"><h2>${esc(f.task.name)}</h2>${coverageHtml(f.coverage, false)}<div class="tiles">${tiles.map(([name, value]) => `<div class="tile"><span>${esc(name)}</span><b>${esc(value)}</b>${name === 'Median' ? `<small>All clients: ${esc(duration(f.all_clients.median_s))}</small>` : ''}</div>`).join('')}</div>
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
    return `<section id="pinned" class="card"><h2>Pinned</h2>${groups.map(([name, list], index) => `<h3>${name}</h3>${list.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Title</th><th scope="col">Kind</th><th scope="col">Owner</th><th scope="col">Shared</th><th scope="col">Updated</th></tr></thead><tbody data-page-list="pins-${index}-pager" data-noun="dashboards">${list.map(d => `<tr><td><a href="${ROOT}/${esc(d.id)}">${esc(d.title)}</a></td><td>${esc(KIND_TEXT[d.kind])}</td><td>${esc(d.owner)}</td><td>${esc(num(d.shared_with.length))}</td><td>${date(d.updated_at)}</td></tr>`).join('')}</tbody></table><div id="pins-${index}-pager"></div></div>` : '<p class="muted">No pinned dashboards here yet. Ask someone with share access to pin a view.</p>'}`).join('')}</section>`
}
function dialogs(pin: Dashboard | undefined, manage: boolean, days: number) {
    const close = '<button class="ghost" type="button" data-close>Cancel</button>'
    return `<dialog id="pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-heading"><form id="pin-form"><h2 id="pin-heading">Pin this view</h2><label>Title<input name="title" aria-label="Dashboard title" maxlength="120" required value="${esc(pin?.title || '')}"></label><label><input type="radio" name="dates" aria-label="Keep the dates fixed" value="fixed" checked>Keep the dates fixed</label><label><input type="radio" name="dates" aria-label="Use a moving period" value="relative">Use a moving period</label><div id="moving-period" hidden><label>Number of days<input name="days" type="number" min="1" max="366" value="${days}" aria-label="Number of days"></label><p class="muted">Compares with the previous period of the same length.</p></div><div class="actions">${close}<button class="primary" type="submit">Pin</button></div></form></dialog>
${manage ? `<dialog id="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-heading"><form id="rename-form"><h2 id="rename-heading">Rename dashboard</h2><label>Title<input name="title" aria-label="Dashboard title" maxlength="120" required value="${esc(pin?.title)}"></label><div class="actions">${close}<button class="primary" type="submit">Save title</button></div></form></dialog>
<dialog id="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-heading"><form id="share-form"><h2 id="share-heading">Share dashboard</h2><p class="muted">${num(pin?.shared_with.length || 0)} people have access.</p><label>Find a person<input type="search" id="people-search" aria-label="Find a person"></label><div id="people"></div><div id="people-pager"></div><p id="people-status" role="status" aria-live="polite"></p><details><summary>Add people by email</summary><label>Emails (comma separated)<input name="emails" aria-label="Other emails, separated by commas" placeholder="person@example.com"></label></details><div class="actions">${close}<button class="primary" type="submit">Save sharing</button></div></form></dialog>
<dialog id="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-heading"><form id="delete-form"><h2 id="delete-heading">Delete this dashboard?</h2><p>The saved view and its shares will be removed.</p><div class="actions">${close}<button class="primary" type="submit">Delete</button></div></form></dialog>` : ''}`
}
const CSS = `
.rescue-client{overflow-wrap:anywhere;min-width:0}.rescue-client h2{font-size:1.1rem}.rescue-level{font-size:.8rem;padding:3px 8px;border-radius:12px}.rescue-level.urgent{background:#fce4dc;color:#832e17}.rescue-level.watch{background:#fff0cb;color:#735315}.rescue-filters,.rescue-action{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.rescue-action label,.rescue-filters label{display:flex;flex-direction:column;gap:4px;max-width:100%;min-width:0}.rescue-action input,.rescue-action textarea,.rescue-action select{width:100%;max-width:100%;box-sizing:border-box}.rescue-action [hidden]{display:none}.rescue-action textarea{min-height:60px}.rescue-action label{flex:1 1 160px}.rescue-filters input[type=checkbox]{width:auto}.tabs{flex-wrap:wrap}
.lead{font-size:1.1rem;font-weight:600}ul.compact{padding-left:20px;margin:0}ul.compact li{margin:6px 0}th[scope=row] .rescue-level{font-weight:400;margin-left:4px}

:root{--good:var(--ok);--warn:#9a5b00;--down:var(--err)}
@media(prefers-color-scheme:dark){:root{--good:#7ed5a0;--warn:#edbd70;--down:#ffa4a0}}
main.wide{min-width:0}main *{box-sizing:border-box}main [hidden]{display:none!important}
main .card{margin:0 0 20px}main h1{margin:0 0 4px}main h2{font-size:16px;line-height:24px;margin:0 0 12px}main h3{font-size:15px;margin:24px 0 12px}main p{line-height:1.5}
.tools,.actions,.tabs{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.tools{justify-content:space-between;align-items:start;margin:24px 0 12px}.tabs{margin-bottom:24px;border-bottom:1px solid var(--line)}.tabs a{padding:10px 0;margin-right:16px;text-decoration:none;color:var(--muted)}.tabs [aria-current]{border-bottom:2px solid var(--accent);color:var(--accent);font-weight:600}
label{display:block;font-size:13px;min-width:0}label input:not([type=checkbox]):not([type=radio]),label select{display:block;width:100%;margin-top:6px}main input,main select,main button{font:inherit;max-width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);min-height:40px}main input[type=checkbox],main input[type=radio]{width:auto;min-height:0;flex:none}main button{width:auto;cursor:pointer}main button.ghost{border-color:transparent;background:transparent;color:var(--ink);font-weight:500}main button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.filter-main,.filter-extra,.date-fields{display:flex;align-items:end;gap:16px;flex-wrap:wrap}.filter-main>label{flex:1 1 180px}.filter-main>button{flex:0 0 auto}.date-fields{flex:1 1 300px}.date-fields label{flex:1 1 130px}.filter-extra>label,.filter-extra>.task-choice{flex:1 1 190px}.task-choice{min-width:0;flex:1 1 230px}.task-choice label+label{margin-top:12px}#search-status:empty{display:none}#search-status{display:block;font-size:12px;margin-top:4px}.more-filters{margin-top:16px}.filter-extra{padding-top:16px}.counting-help,.ownership{margin:16px 0 24px}summary{cursor:pointer;width:fit-content;max-width:100%;padding:6px 0;font-size:13px}.dashboard-settings .actions{margin-top:8px}.dashboard-settings summary{min-height:40px;padding:10px}.ownership summary{color:var(--muted)}
.layout{display:grid;grid-template-columns:minmax(0,230px) minmax(0,1fr);gap:32px;align-items:start}.layout .card{min-width:0;margin-top:16px}.client{padding:14px 0;border-bottom:1px solid var(--line)}.client small{line-height:1.6}.flag{white-space:nowrap;display:inline-block;font-size:12px;margin:3px 6px 3px 0}.flag.attention{color:var(--warn)}.flag.new{color:var(--good)}
.table-wrap{max-width:100%;overflow:auto}@media(max-width:600px){.table-wrap>table{min-width:560px}}table{width:100%;font-size:13px;border-collapse:collapse}td,th{vertical-align:top;overflow-wrap:anywhere;padding:12px 10px;border-bottom:1px solid var(--line)}th{font-weight:500;color:var(--muted);text-align:left}td{min-width:75px}td:first-child{min-width:125px}
.tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:20px;margin:24px 0 36px}.tile{padding:0}.tile span,.tile small{display:block;color:var(--muted)}.tile b{display:block;font-size:26px;font-weight:600;margin:6px 0}.tile small{font-size:12px}
.chart{position:relative}.chart svg{display:block;width:100%;height:auto}.tip{white-space:pre-line;position:absolute;left:10%;top:10px;max-width:80%;background:var(--ink);color:var(--card);padding:6px 9px;border-radius:6px;font-size:12px;pointer-events:none}.path{padding:16px 0;border-bottom:1px solid var(--line)}.share-bar{height:5px;background:var(--line);margin:10px 0;overflow:hidden}.share-bar i{display:block;height:100%;background:var(--muted)}.history{border-left:3px solid var(--warn);padding:2px 14px;margin:20px 0;color:var(--ink)}.history p{margin:6px 0}.coverage-dates{font-size:13px;color:var(--muted)}
.card,main{overflow-wrap:anywhere}dialog{color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;width:480px;max-width:calc(100vw - 24px);max-height:85vh;overflow:auto;padding:24px}dialog::backdrop{background:#0006}dialog label{margin:16px 0}dialog .actions{justify-content:flex-end;margin-top:24px}#people{max-height:240px;overflow:auto}#people label{display:flex;gap:10px;align-items:center}#message:not(:empty){padding:12px;border-left:3px solid var(--warn);margin-bottom:12px;color:var(--ink)}
@media(max-width:760px){.layout{grid-template-columns:minmax(0,1fr);gap:12px}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.filter-main>label{flex-basis:140px}.filter-main>button{width:100%}.filter-main>.task-choice{flex-basis:100%}.tools h1{font-size:26px}main.wide{padding:20px 12px}.actions{gap:6px}.tabs{gap:14px}.tabs a{margin-right:0}.tiles .tile:last-child{grid-column:1/-1}dialog{padding:20px}.layout aside.card{margin-bottom:0}}

.task-choice{display:flex;gap:12px 16px;align-items:end;flex-wrap:wrap;flex:2 1 380px}.task-choice>label{flex:1 1 180px}.task-choice label+label{margin-top:0}#search-status{flex-basis:100%;order:3}#search-status:empty{display:none}
@media(max-width:760px){.filter-main>.task-choice{flex-basis:100%}}
.sub-line{margin:6px 0 16px}.rescue-level{font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap}
.filter-bar{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:0 0 16px}.filter-bar>label{flex:0 1 190px;margin:0}.filter-bar label.check{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding-bottom:9px;color:var(--ink)}.filter-bar label.check input{min-height:0;margin:0;display:inline-block;width:auto}
.filters.card{padding:16px 20px}.filters .more-filters{margin-top:10px}
.rq{padding:0;overflow:hidden}.rq-head,.rq-row>summary{display:grid;grid-template-columns:22% minmax(0,1fr) 17% 14%;gap:16px;align-items:center;padding:12px 20px}
.rq-head{font-size:12px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line)}.rq-row{border-bottom:1px solid var(--line)}.rq-row:last-child{border-bottom:0}
.rq-row>summary{width:100%;list-style:none;cursor:pointer;color:var(--ink);font-size:13.5px;margin:0}.rq-row>summary::-webkit-details-marker{display:none}.rq-row>summary:hover{background:var(--chip)}.rq-row[open]>summary{background:var(--accent-soft);margin:0}
.rq-client{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap}.rq-client>b{flex-basis:100%}.rq-trend{display:inline}.rq-reason{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.rq-owner{overflow-wrap:anywhere}
.rq-body{padding:6px 20px 18px}.rq-body ul{margin:8px 0;padding-left:20px}.rq-links{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.rescue-action{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:end;border-top:1px solid var(--line);padding-top:14px;margin-top:8px}.rescue-action .wide{grid-column:1/-1}.rescue-action label{margin:0}
.rq-empty{padding:16px 20px;margin:0;color:var(--muted)}
main th[scope=row]{white-space:nowrap}main .tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;gap:4px}main .tabs a{flex:none;padding:10px 12px;margin:0;border-radius:0;background:transparent;border-bottom:2px solid transparent;font-weight:500}main .tabs a:hover{color:var(--ink);text-decoration:none}main .tabs a[aria-current]{background:transparent}
details.fold>summary{list-style:none;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;color:var(--ink)}details.fold>summary::-webkit-details-marker{display:none}details.fold>summary h2{margin:0;font-size:16px}details.fold>summary::after{content:'Show';margin-left:auto;color:var(--accent);font-size:13px;font-weight:500}details.fold[open]>summary::after{content:'Hide'}
.trend-worse{color:var(--err)}.trend-new{color:var(--accent)}.trend-same,.trend-quiet-review{color:var(--faint)}.trend-better{color:var(--ok)}
.sub-line .lead{font-weight:500;color:var(--ink);font-size:inherit}section.card>article.card{padding:12px 0 0;margin:12px 0 0;border-top:1px solid var(--line);border-radius:0}section.card>article.card:first-of-type{border-top:0;margin-top:0;padding-top:0}section.card>article.card h3{margin:0 0 4px}section.card>article.card p{margin:0}
@media(max-width:760px){.rq-head{display:none}.rq-row>summary{grid-template-columns:1fr;gap:4px}.rescue-action{grid-template-columns:1fr}.filter-bar>label{flex:1 1 140px}}`

// Browser code stays in String.raw so escaping HTML never alters JavaScript quoting.
const CLIENT = String.raw`
(()=>{
const $=id=>document.getElementById(id)
const ctx=$('dashboard-context')?JSON.parse($('dashboard-context').dataset.context):null
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const message=e=>{const dialog=document.querySelector('dialog[open]');if(dialog){let alert=dialog.querySelector('[role=alert]');if(!alert){alert=document.createElement('p');alert.setAttribute('role','alert');dialog.prepend(alert)}alert.textContent=e.message||String(e)}else $('message').textContent=e.message||String(e)}
const api=async(path,method='GET',body)=>{const r=await fetch('/replays/dashboards/api/'+path,{method,headers:{'content-type':'application/json','x-clip-page':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})}).catch(()=>{throw new Error('Could not connect. Check your connection and try again.')});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed. Try again.');return d}
if($('scorecard'))api('scorecard?weeks='+$('scorecard').dataset.weeks).then(s=>{
const lead=n=>n==null?'–':esc(n)+' days'
$('scorecard').innerHTML='<p>'+esc(s.explanation)+'</p><p class="muted">'+esc(s.coverage.text)+'</p><div class="table-wrap"><table><caption>Client signals and outcomes</caption><thead><tr><th scope="col">Warning sign</th><th scope="col">Clients flagged in the year</th><th scope="col">Hits: left / contracted</th><th scope="col">Median lead</th><th scope="col">Misses: left / contracted</th><th scope="col">Possible false alarms: renewed / stayed</th></tr></thead><tbody>'+s.rows.map(r=>'<tr><th scope="row">'+esc(r.label||r.kind.replaceAll('_',' '))+'</th><td>'+esc(r.flagged_clients)+'</td><td>'+esc(r.hits)+'</td><td>'+lead(r.median_lead_days)+'</td><td>'+esc(r.misses)+'</td><td>'+esc(r.possible_false_alarms)+'</td></tr>').join('')+'</tbody></table></div><p class="muted">'+esc(s.note)+'</p>'
}).catch(e=>{$('scorecard').textContent='Scorecard unavailable: '+e.message})
const run=fn=>async e=>{e.preventDefault();const target=e.currentTarget;if(target.dataset.busy)return;target.dataset.busy='1';const buttons=target.matches('button')?[target]:[...target.querySelectorAll('button[type=submit]')];const states=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);target.setAttribute('aria-busy','true');const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Working…';(target.closest('dialog')||$('action-status')).append(status);try{await fn(e)}catch(err){message(err)}finally{status.remove();delete target.dataset.busy;target.removeAttribute('aria-busy');buttons.forEach((b,i)=>b.disabled=states[i])}}
document.querySelectorAll('[data-chart-date]').forEach(t=>{t.textContent=new Date(t.dataset.chartDate).toLocaleDateString(undefined,{timeZone:'UTC'})})
document.querySelectorAll('time[datetime]').forEach(t=>{const s=t.getAttribute('datetime'),d=new Date(s);if(!isNaN(d))t.textContent=s.length===10?d.toLocaleDateString(undefined,{timeZone:'UTC'}):d.toLocaleString()})
const openDialog=(dialog,opener)=>{dialog.querySelectorAll('[role=alert]').forEach(a=>a.remove());dialog._opener=opener;dialog.showModal();(dialog.querySelector('input:not([type=radio]),[data-close]')||dialog).focus()}
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('close',()=>{if(d._opener)d._opener.focus()}))
document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDialog($(b.dataset.open),b))
document.querySelectorAll('[data-page-list]').forEach(list=>{const items=[...list.children];if(!items.length||items[0].querySelector('td[colspan]'))return;const pg=makePager({mount:$(list.dataset.pageList),noun:list.dataset.noun,size:25,draw:slice=>list.replaceChildren(...slice)});pg.set(items)})
if($('copy-handover'))$('copy-handover').onclick=async()=>{try{await navigator.clipboard.writeText($('handover-pack').textContent);$('copy-status').textContent='Copied'}catch{$('copy-status').textContent='Copy the text below to share the handover pack.'}}
document.querySelectorAll('.rescue-action').forEach(form=>{const update=()=>{form.querySelector('.snooze-field').hidden=form.elements.status.value!=='expected';form.elements.snooze_until.required=form.elements.status.value==='expected'};form.elements.status.onchange=update;update();form.onsubmit=run(async()=>{const body=Object.fromEntries(new FormData(form));await api('rescue/'+encodeURIComponent(form.dataset.client)+location.search,'POST',body);form.querySelector('[role=status]').textContent='Saved'})})
document.querySelectorAll('[data-ask-client]').forEach(b=>b.onclick=run(async()=>{const d=await api('rescue/'+encodeURIComponent(b.dataset.askClient)+'/ask'+location.search,'POST',{});$('message').textContent=d.message+' ';const a=document.createElement('a');a.href=d.open;a.textContent='Open the draft';$('message').append(a)}))
document.querySelectorAll('[data-review-client]').forEach(b=>b.onclick=run(async()=>{await api('rescue/'+encodeURIComponent(b.dataset.reviewClient),'POST',{note:'Quiet review completed: checked whether their work is going well.'});b.textContent='Reviewed'}))
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close())
// Filters apply as soon as they change (no Apply button). Custom dates wait until both are valid.
document.querySelectorAll('form[data-auto]').forEach(f=>f.addEventListener('change',()=>f.requestSubmit()))
const form=$('filters')
if(form)form.addEventListener('change',e=>{const t=e.target;if(t.type==='search'||(t.id==='period'||t.id==='compare')&&t.value==='custom')return;if(t.type==='date'&&![...form.querySelectorAll('input[type=date]:not(:disabled)')].every(x=>x.value&&x.checkValidity()))return;if(form.checkValidity())form.requestSubmit()})
if(form){
 const update=()=>{const custom=$('period').value==='custom';$('period-dates').hidden=!custom;for(const k of ['from','to'])form.elements[k].disabled=!custom;if($('compare')){const customComparison=$('compare').value==='custom';$('comparison-dates').hidden=!customComparison;for(const k of ['baseline_from','baseline_to'])form.elements[k].disabled=!customComparison}}
 $('period').onchange=update;if($('compare'))$('compare').onchange=update;update()
 form.onsubmit=e=>{e.preventDefault();const q=new URLSearchParams(new FormData(form));const period=q.get('period');q.delete('period');if(period!=='custom')q.set('days',period);location.search=q.toString()}
 const clients=[...$('client-picker').options].map(o=>({value:o.value,text:o.textContent}))
 $('client-search').oninput=()=>{const q=$('client-search').value.toLowerCase(),select=$('client-picker'),selected=select.value;select.innerHTML=clients.filter(o=>!o.value||o.value===selected||o.text.toLowerCase().includes(q)).map(o=>'<option value="'+esc(o.value)+'"'+(o.value===selected?' selected':'')+'>'+esc(o.text)+'</option>').join('')}
 let timer,request=0
 $('task-search').oninput=()=>{clearTimeout(timer);const version=++request;$('search-status').textContent='Loading…';timer=setTimeout(async()=>{try{const tasks=await api('tasks?q='+encodeURIComponent($('task-search').value));if(version!==request)return;const select=$('task-picker'),chosen=select.selectedOptions[0];select.innerHTML='<option value="">'+(ctx.kind==='flow_time'?'Choose a task':'All tasks')+'</option>'+tasks.map(t=>'<option value="'+esc(t.task_id)+'">'+esc(t.name)+'</option>').join('');if(chosen&&chosen.value){if(![...select.options].some(o=>o.value===chosen.value))select.append(chosen);select.value=chosen.value}$('search-status').textContent=tasks.length+' matching tasks'}catch(err){if(version===request){$('search-status').textContent='Search failed. Try again.';message(err)}}},250)}
}
if($('pin-form')){
 const pinForm=$('pin-form'),updateDates=()=>{const moving=pinForm.elements.dates.value==='relative';$('moving-period').hidden=!moving;pinForm.elements.days.disabled=!moving}
 pinForm.querySelectorAll('[name=dates]').forEach(r=>r.onchange=updateDates);updateDates()
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
