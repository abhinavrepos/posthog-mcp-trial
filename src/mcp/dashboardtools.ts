import { scorecard } from '../core/scorecard.ts'
import { rescuePrivacy } from '../core/rescueprivacy.ts'
import { clientStory, handoverPack } from '../core/story.ts'
// Chat views and pinned dashboards use the same filters as the Dashboards page.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { appEvents } from '../core/appevents.ts'
import { clientExperience, frictionHotspots, replayCoverage } from '../core/experience.ts'
import { config } from '../core/config.ts'
import { mondayBrief } from '../core/briefing.ts'
import { draftRescueSurvey } from '../core/rescuesurveys.ts'
import { saveSurvey } from '../core/surveys.ts'
import { surveysActive } from '../core/config.ts'
import { canSurvey, type SurveyRole } from '../service/access.ts'
import { rescueQueue, setRescueAction, rescueClients, RESCUE_STATUSES } from '../core/rescue.ts'
import { taskMap, flowTime, findTasks, ingestStatus } from '../core/tasks.ts'
import { createDashboard, shareDashboard, listDashboards, getDashboard, canManage } from '../core/dashboards.ts'
import { resolveClient } from '../core/resolve.ts'
import { parseTimeWindow } from '../core/timewindow.ts'
import type { FlowTimeParams, TaskMapParams, Window } from '../core/taskstypes.ts'
import type { ChatCaller, DashboardRole } from '../service/access.ts'

export const DASHBOARD_TOOLS = ['client_experience', 'friction_hotspots', 'signal_scorecard', 'client_story', 'handover_pack', 'monday_brief', 'draft_rescue_survey', 'rescue_queue', 'set_rescue_status', 'find_task', 'task_map', 'flow_time', 'list_dashboards', 'pin_dashboard', 'share_dashboard']
export const dashboardToolNames = (role: DashboardRole = 'share', surveyRole: SurveyRole = 'launch'): string[] =>
    !appEvents() || role === 'none' ? [] : DASHBOARD_TOOLS.filter(t => (t !== 'draft_rescue_survey' || surveysActive() && canSurvey(surveyRole, 'edit')) && (role === 'share' || !['pin_dashboard', 'share_dashboard', 'set_rescue_status'].includes(t)))
const realDeps = { scorecard, clientStory, handoverPack, mondayBrief, draftRescueSurvey, saveSurvey, surveysActive, rescueQueue, setRescueAction, rescueClients, taskMap, flowTime, findTasks, ingestStatus, createDashboard, shareDashboard, listDashboards, getDashboard, canManage, resolveClient }
type Caller = Pick<ChatCaller, 'who' | 'email' | 'dashboardRole' | 'admin'> & { surveyRole?: SurveyRole }
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
const page = (id?: string) => `${config.service.publicUrl.replace(/\/$/, '')}/replays/dashboards${id ? '/' + id : ''}`
const DAY = 86400000
const day = (date: Date) => date.toISOString().slice(0, 10)
const days = (w: Window) => Math.round((Date.parse(w.to) - Date.parse(w.from)) / DAY) + 1

function windowFor(input: string | undefined, fallback: number): Window {
    const value = (input?.trim() || `last ${fallback} days`).replace(/^(last|past) (a |one )?(week|month)$/i, '$1 1 $3')
    const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/g)
    if (dates?.length === 2) {
        const window = { from: day(parseTimeWindow(dates[0], new Date(), 'UTC').from), to: day(parseTimeWindow(dates[1], new Date(), 'UTC').from) }
        if (days(window) < 1 || days(window) > 366) throw new Error('Choose dates in order, at most 366 days apart.')
        return window
    }
    const relative = /^(?:last|past)\s+(\d+)\s+(days?|weeks?|months?)$/i.exec(value)
    // The shared parser understands days and calendar dates; expand weeks and months first.
    const count = relative ? Number(relative[1]) * (/week/i.test(relative[2]) ? 7 : /month/i.test(relative[2]) ? 30 : 1) : undefined
    const parsed = parseTimeWindow(count ? `last ${Math.min(count, 99)} days` : value, new Date(), 'UTC')
    if (parsed.precision === 'none' || count === 0 || (count !== undefined && count > 366)) throw new Error('I could not read those dates. Try "last 4 weeks", "yesterday", or "2026-10-01".')
    if (count) {
        const end = new Date(Date.parse(day(parsed.to)) - DAY)
        return { from: day(new Date(end.getTime() - (count - 1) * DAY)), to: day(end) }
    }
    return { from: day(parsed.from), to: day(new Date(Math.max(parsed.from.getTime(), parsed.to.getTime() - 1))) }
}
const previous = (w: Window): Window => ({ from: day(new Date(Date.parse(w.from) - days(w) * DAY)), to: day(new Date(Date.parse(w.from) - DAY)) })
const filters = {
    client: z.string().optional().describe('Client name, id or user email; omit for all clients.'),
    when: z.string().optional().describe('Plain words such as last 4 weeks or yesterday; default last 28 days for a task map, 90 days for flow time.'),
    task: z.string().optional().describe('Task words or task id. Required for flow time.'),
    compared_with: z.string().optional().describe('Comparison dates in plain words; omit for the preceding period.'),
    only_flagged: z.boolean().default(true).describe('Only tasks needing attention in the task map.'),
}

export function registerDashboardTools(server: McpServer, caller: Caller = { who: 'mcp', dashboardRole: 'share', surveyRole: 'launch', admin: false }, deps: Partial<typeof realDeps> = {}): void {
    const d = { ...realDeps, ...deps }
    const allowed = new Set(dashboardToolNames(caller.admin ? 'share' : caller.dashboardRole, caller.admin ? 'launch' : caller.surveyRole || 'none'))
    const reg = ((name: string, ...rest: unknown[]) => allowed.has(name) ? (server.registerTool as (...a: unknown[]) => unknown)(name, ...rest) : undefined) as typeof server.registerTool
    const safe = <T>(fn: (input: T) => Promise<ReturnType<typeof text>>) => async (input: T) => {
        try { return await fn(input) } catch (e) { return text((e as Error).message) }
    }
    const ready = () => {
        const status = d.ingestStatus()
        if (!status.days_done) throw new Error('Task history is still being built. Please try again shortly; the Dashboards page shows progress.')
        return status
    }
    const resolve = async (input: { client?: string; task?: string }, required = false) => {
        let client: string | undefined, task: string | undefined
        if (input.client) {
            const matches = await d.resolveClient({ text: input.client, clientHint: input.client, emails: input.client.match(/[^\s<>]+@[^\s<>]+/g) || [] })
            const exact = matches.filter(c => c.id.toLowerCase() === input.client!.trim().toLowerCase() || c.name.toLowerCase() === input.client!.trim().toLowerCase())
            const chosen = exact.length === 1 ? exact[0] : matches.length === 1 && matches[0].confidence >= .8 ? matches[0] : undefined
            if (!chosen) return { reply: json({ message: 'Which client did you mean? Choose a client id.', candidates: matches }) }
            client = chosen.id
        }
        if (input.task) {
            const matches = await d.findTasks(input.task)
            const exact = matches.filter(t => t.task_id === input.task)
            const chosen = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined
            if (!chosen) return { reply: json({ message: 'Which task did you mean? Choose a task id.', candidates: matches }) }
            task = chosen.task_id
        } else if (required) return { reply: json({ message: 'Which task? Give task words or choose an id.', candidates: await d.findTasks('') }) }
        return { client, task }
    }
    const open = (kind: string, p: TaskMapParams | FlowTimeParams, flagged?: boolean) => {
        const q = new URLSearchParams({ view: kind, from: p.window.from, to: p.window.to })
        if (p.client) q.set('client', p.client)
        if (p.task) q.set('task', p.task)
        if ('baseline' in p && p.baseline) { q.set('baseline_from', p.baseline.from); q.set('baseline_to', p.baseline.to) }
        if (flagged !== undefined) q.set('only_flagged', String(flagged))
        return `${page()}?${q}`
    }
    reg('signal_scorecard', {
        description: 'How did client flags compare with recorded outcomes? Weekly historical sanity check with hits, misses and lead days; never a probability.',
        inputSchema: { weeks: z.number().int().min(1).max(52).optional() }, annotations: { readOnlyHint: true },
    }, safe(async input => json(await d.scorecard(input))))
    reg('client_experience', {
        title: 'How is this client doing?',
        description: 'How a client is doing: their usage and how their people actually work, from replays. Use it first for "how is <client> doing / are they using it / do they struggle": usage (sessions, people, completed work against the period before) and, from session replays, (hesitation, cursor circling, scrolling to find things, clicks that do nothing, rage clicks, error loops, idle time, failed calls), compared with other clients, with plain findings, where it happens, next steps and replay links for the person. Replays are read as structure only: no values or text.',
        inputSchema: { client: z.string().describe('Client name or id'), days: z.number().int().min(7).max(90).default(28) }, annotations: { readOnlyHint: true },
    }, safe(async ({ client, days }) => {
        const matches = d.rescueClients(client)
        if (matches.length !== 1) return json(await rescuePrivacy({ message: 'Choose a client id.', candidates: matches }))
        const x = clientExperience(matches[0].id, { days })
        const name = matches[0].name || matches[0].id
        const lines = [`${name}: ${x.verdict.toUpperCase()}. ${x.summary}`, `Usage: ${x.usage.text}`,
            ...x.findings.map((f) => `- ${f.severity === 'high' ? 'High' : 'Medium'}: ${f.text}${f.where.length ? ` Where: ${f.where.join(', ')}.` : ''}${f.replays[0] ? ` Watch: ${f.replays[0].url}` : ''}`),
            ...(x.next_steps.length ? ['Next steps:', ...x.next_steps.map((n) => `- ${n}`)] : []), x.note, `Open in Lens: ${page()}?${new URLSearchParams({ view: 'story', client: matches[0].id })}`]
        return text(lines.join('\n') + '\n\n```json\n' + JSON.stringify(await rescuePrivacy({ ...x, client_name: name }), null, 2) + '\n```')
    }))
    reg('friction_hotspots', {
        title: 'Where do clients struggle on screen?',
        description: 'Where on screen clients struggle most, across all clients. From session replays: the buttons and fields where friction gathers (rage clicks, clicks that do nothing, error loops, heavy re-editing), by how many clients hit them. Use it for "what should we fix first".',
        inputSchema: { days: z.number().int().min(7).max(90).default(28) }, annotations: { readOnlyHint: true },
    }, safe(async ({ days }) => {
        const h = frictionHotspots({ days }), c = replayCoverage()
        return json({ hotspots: h, replays_read: c.sessions, clients: c.clients, note: h.length ? 'Ranked by how many clients hit each place, then by how often.' : 'No friction found yet in the replays read so far.' })
    }))
    reg('client_story', {
        description: 'One client story: weekly work counts, changes, signals, actions, surveys and unknowns from local Lens history only.',
        inputSchema: { client: z.string(), weeks: z.number().int().min(1).max(52).optional() }, annotations: { readOnlyHint: true },
    }, safe(async ({ client, weeks }) => {
        const matches = d.rescueClients(client)
        if (matches.length !== 1) return json(await rescuePrivacy({ message: 'Choose a client id.', candidates: matches }))
        return json(await rescuePrivacy({ ...await d.clientStory({ client: matches[0].id, weeks }), open: page() + '?' + new URLSearchParams({ view: 'story', client: matches[0].id }) }))
    }))
    reg('handover_pack', {
        description: 'Copyable Markdown handover for a client: established tasks, recent changes, actions and owners, surveys, replay links and unknowns. No user identities.',
        inputSchema: { client: z.string() }, annotations: { readOnlyHint: true },
    }, safe(async ({ client }) => {
        const matches = d.rescueClients(client)
        if (matches.length !== 1) return json(await rescuePrivacy({ message: 'Choose a client id.', candidates: matches }))
        return text(await d.handoverPack(matches[0].id))
    }))
    reg('monday_brief', {
        description: 'What changed at my clients since last week, and what needs me today? A saved weekly briefing with actions and verified recoveries.', inputSchema: {},
    }, safe(async () => json({ ...await d.mondayBrief({ by: caller.email || caller.who }), open: page() + '?view=briefing' })))
    reg('draft_rescue_survey', {
        description: 'Ask an affected client a short in-app question by creating a targeted draft to review and launch on the Surveys page.', inputSchema: { client: z.string() },
    }, safe(async ({ client }) => {
        const matches = d.rescueClients(client)
        if (matches.length !== 1) return json({ message: 'Choose a client id.', candidates: matches })
        return json(await d.draftRescueSurvey(matches[0].id, caller.email || caller.who, d))
    }))
    reg('rescue_queue', {
        description: 'Which clients need someone this week, and why? Ranked rescue queue with evidence, next steps, owner and status from processed Lens history.',
        inputSchema: { when: filters.when, compared_with: filters.compared_with, min_attempts: z.number().int().min(1).max(100000).optional(), include_snoozed: z.boolean().optional(), limit: z.number().int().min(1).max(50).default(10) },
        annotations: { readOnlyHint: true },
    }, safe(async input => {
        const result = await d.rescueQueue({ ...(input.when ? { window: windowFor(input.when, 28) } : {}), ...(input.compared_with ? { baseline: windowFor(input.compared_with, 28) } : {}), min_attempts: input.min_attempts, include_snoozed: input.include_snoozed })
        const q = new URLSearchParams({ view: 'rescue', from: result.window.from, to: result.window.to, baseline_from: result.baseline.from, baseline_to: result.baseline.to })
        if (input.include_snoozed) q.set('include_snoozed', 'true')
        if (input.min_attempts) q.set('min_attempts', String(input.min_attempts))
        return json({ ...result, headline: result.coverage.complete ? `${result.clients.length} clients need someone this week` : result.coverage.text,
            clients: result.clients.slice(0, input.limit).map(c => ({ ...c, reasons: c.reasons.slice(0, 3) })), open: `${page()}?${q}` })
    }))
    reg('set_rescue_status', {
        description: 'Set the owner, status, note, due date or expected-decline snooze for a client in the rescue queue.',
        inputSchema: { client: z.string(), owner: z.string().optional(), status: z.enum(RESCUE_STATUSES).optional(), note: z.string().max(500).optional(), due: z.string().optional(), snooze_until: z.string().optional(), when: filters.when, compared_with: filters.compared_with },
    }, safe(async ({ client, when, compared_with, ...change }) => {
        const matches = await d.rescueClients(client)
        if (matches.length !== 1) return json({ message: 'Which client did you mean? Choose a client id.', candidates: matches })
        // The period being discussed, so a snooze keeps the score the person saw (as on the page).
        const view = { ...(when ? { window: windowFor(when, 28) } : {}), ...(compared_with ? { baseline: windowFor(compared_with, 28) } : {}) }
        return json(await d.setRescueAction(matches[0].id, Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)), caller.email || caller.who, view))
    }))
    reg('find_task', {
        description: `Which ${appEvents()?.app || 'app'} task does someone mean? Matches their own words ("book a hedge", "run the FX report") to task ids and names, with use over the last 90 days. Call it before flow_time when a task is named loosely.`,
        inputSchema: { query: z.string().describe('Task in the person’s own words, or its id.') },
        annotations: { readOnlyHint: true },
    }, safe(async ({ query }) => {
        ready()
        return json({ candidates: await d.findTasks(query) })
    }))
    reg('task_map', {
        description: `Which ${appEvents()?.app || 'app'} clients stopped doing tasks they used to do, do them less, take longer or fail more? Client task map: a recent period against the one before, per client and task (missing work, dropped, slower, failing, new). For "is ACME still booking hedges?", "which clients are drifting away?". Returns flags with numbers and a link to the live Lens dashboard.`,
        inputSchema: filters,
        annotations: { readOnlyHint: true }
    }, safe(async input => {
        const status = ready(), r = await resolve(input)
        if (r.reply) return r.reply
        const window = windowFor(input.when, 28)
        const p: TaskMapParams = { window, baseline: input.compared_with ? windowFor(input.compared_with, 28) : previous(window), client: r.client, task: r.task }
        const result = await d.taskMap(p)
        // Same rule as the page: "new" (a task a client just started) is not a problem to look at.
        const needs = (row: (typeof result.rows)[number]) => row.flags.some(f => f !== 'new')
        const rows = result.rows.filter(row => !input.only_flagged || needs(row))
        const attention = new Set(result.rows.filter(needs).map(row => row.client)).size
        const clients = result.clients.filter(c => rows.some(row => row.client === c.client)).map(c => ({
            ...c,
            tasks: rows.filter(row => row.client === c.client).map(({ task_id, task_name, flags, now, before }) => ({ task_id, task_name, flags, now, before })),
        }))
        return json({
            headline: result.coverage?.complete === false ? result.coverage.text : `${attention} client${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} attention.`, clients,
            data_through: result.data_through, note: result.note, history_behind_days: status.behind_days,
            open: open('task_map', p, input.only_flagged),
        })
    }))
    reg('flow_time', {
        description: `How long does a ${appEvents()?.app || 'app'} client take to finish a task, and which path do they take? Flow time for a task such as booking a hedge designation: median and p90 over time against all clients, paths with their share and time, slowest attempts with replay links (for the person; never view replays) and common errors. Returns a link to the live Lens dashboard.`,
        inputSchema: { client: filters.client, task: z.string(), when: filters.when },
        annotations: { readOnlyHint: true }
    }, safe(async input => {
        ready()
        const r = await resolve(input, true)
        if (r.reply) return r.reply
        const p: FlowTimeParams = { window: windowFor(input.when, 90), task: r.task!, client: r.client, slowest_limit: 10 }
        const result = await d.flowTime(p)
        const points = result.series.filter(point => point.median_s !== null)
        const third = Math.max(1, Math.floor(points.length / 3))
        const mean = (xs: typeof points) => xs.reduce((sum, x) => sum + x.median_s!, 0) / xs.length
        const first = mean(points.slice(0, third)), last = mean(points.slice(-third))
        const trend = points.length < 3 ? 'not enough history' : last > first * 1.1 ? 'slower' : last < first * .9 ? 'faster' : 'steady'
        return json({
            ...(result.coverage?.complete === false ? { not_processed_yet: result.coverage.text } : {}),
            task: result.task, summary: result.summary, all_clients: result.all_clients, trend,
            paths: result.paths, slowest: result.slowest.slice(0, 3), top_errors: result.top_errors,
            data_through: result.data_through, note: result.note, open: open('flow_time', p),
        })
    }))
    reg('list_dashboards', {
        description: 'List your pinned dashboards and those shared with you, with links to open them.',
        inputSchema: {},
        annotations: { readOnlyHint: true }
    }, safe(async () => {
        if (!caller.email) return text('To list your dashboards, use your own token from the Chat page in Lens.')
        return json((await d.listDashboards(caller.email, caller.admin)).map(({ id, title, kind, owner, shared_with }) => ({ id, title, kind, owner, shared_with, open: page(id) })))
    }))
    const emails = z.array(z.string().trim().email()).max(200)
    reg('pin_dashboard', {
        description: 'Keeps a task map or flow time view as a Lens dashboard to come back to. It stays current (the last N days) unless keep_dates_fixed, and can be shared by email. Use when they ask to keep, save, pin or share a view; needs their own chat token.',
        inputSchema: {
            ...filters, kind: z.enum(['task_map', 'flow_time']), title: z.string().trim().min(1).max(120),
            keep_dates_fixed: z.boolean().default(false).describe('False keeps the last N days current; true saves the exact dates.'),
            share_with: emails.optional(),
        },
    }, safe(async input => {
        if (!caller.email) return text('Pinning needs your own token from the Chat page in Lens.')
        ready()
        const r = await resolve(input, input.kind === 'flow_time')
        if (r.reply) return r.reply
        const window = windowFor(input.when, input.kind === 'flow_time' ? 90 : 28)
        const baseline = input.compared_with ? windowFor(input.compared_with, 28) : input.keep_dates_fixed ? previous(window) : undefined
        const params = {
            window: input.keep_dates_fixed ? window : { last_days: days(window) }, client: r.client, task: r.task,
            ...(input.kind === 'task_map' ? { only_flagged: input.only_flagged, ...(baseline ? { baseline } : {}) } : {}),
        }
        let dashboard = await d.createDashboard(caller.email, { kind: input.kind, title: input.title, params, via: 'chat' })
        if (input.share_with) dashboard = await d.shareDashboard(dashboard.id, caller.email, caller.admin, input.share_with)
        return json({ dashboard, open: page(dashboard.id) })
    }))
    reg('share_dashboard', {
        description: 'Replace the full list of people a dashboard is shared with; only its owner or an admin may do this.',
        inputSchema: { dashboard: z.string().describe('Dashboard id or its Lens link.'), emails: emails.describe('Full new list of email addresses; an empty list stops sharing.') }
    }, safe(async input => {
        if (!caller.email) return text('Sharing needs your own token from the Chat page in Lens.')
        const id = /(?:^|\/)([0-9a-f]{12})(?:[?#].*)?$/.exec(input.dashboard.trim())?.[1]
        const dashboard = id ? await d.getDashboard(id) : undefined
        if (!dashboard || !d.canManage(dashboard, caller.email, caller.admin)) return text('No such dashboard, or it is not yours to share. Only the owner or an admin can share it.')
        return json({ dashboard: await d.shareDashboard(dashboard.id, caller.email, caller.admin, input.emails), open: page(dashboard.id) })
    }))
}
