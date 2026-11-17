import { historyLimits } from './historycoverage.ts'
import { ToolInputError } from './toolinputerror.ts'
import { comparisonWindow, type ComparisonOptions } from './comparison.ts'
// Bounded queries for the pure workflow reader. PMs do not configure definitions.
import { dialogLabel, dialogNames, required, type AppEvents, type RawEvent } from './appevents.ts'
import { recordingSpans } from './incidents.ts'
import { hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'
import { DIALOG_CODE, discoverWorkflowChains, validateWorkflow, workflowCompletion, workflowDialogsFromId, type Workflow, type CompletionMetrics } from './workflows.ts'

type Window = { from: Date; to: Date; clientId?: string }
const prop = (reg: AppEvents, role: 'dialog' | 'action') => reg.properties[role] ? `toString(properties.${reg.properties[role]!.name})` : `''`
const BATCH = 50

/** Page every matching session, then page its events inside a bounded one-day edge margin. */
export async function workflowSessions(q: Window, dialogs?: string[]) {
    const reg = required()
    const values = { from: q.from.toISOString(), to: q.to.toISOString(), client: q.clientId || '', screen: reg.events.screen,
        open: reg.screenActions.open, events: [reg.events.screen, reg.events.interaction], dialogs: dialogs || [''], all: dialogs ? 0 : 1 }
    // Session-by-session reads are not counted per batch: check the whole window (with its edge days) first,
    // or a year-long live window runs for half an hour (seen in the 100M-event lab).
    const { assertLiveWindow } = await import('./liveevents.ts')
    await assertLiveWindow({ ...q, from: new Date(+q.from - 86400000), to: new Date(+q.to + 86400000) })
    const ids: string[] = []
    let cursor = ''
    while (true) {
        const page = await hogql(`SELECT toString(properties.$session_id) AS sid FROM events
            WHERE timestamp >= {from} AND timestamp < {to} AND event = {screen} AND ${prop(reg, 'action')} IN {open}
              AND ({all} = 1 OR ${prop(reg, 'dialog')} IN {dialogs})
              AND ({client} = '' OR toString(${P.client}) = {client})
              AND toString(properties.$session_id) > {cursor}
            GROUP BY sid ORDER BY sid LIMIT 2000`, { ...values, cursor })
        ids.push(...page.map((r) => String(r.sid)))
        if (page.length < 2000) break
        const next = String(page.at(-1)!.sid)
        if (next <= cursor) throw new Error('Session pagination did not advance; no partial answer returned.')
        cursor = next
    }
    const { liveEvents, eventSessions } = await import('./liveevents.ts')
    const rows: RawEvent[] = []
    for (let i = 0; i < ids.length; i += BATCH) rows.push(...await liveEvents({ ...q,
        from: new Date(+q.from - 86400000), to: new Date(+q.to + 86400000) }, ids.slice(i, i + BATCH)))
    return { sessions: eventSessions(rows), sessions_selected: ids.length, rows_read: rows.length, truncated: false }
}

function labels(sessions: Awaited<ReturnType<typeof workflowSessions>>['sessions']) {
    const counts = new Map<string, Map<string, number>>()
    for (const session of sessions) for (const s of session) if (s.kind === 'open' && s.name && s.name.toUpperCase() !== 'UNKNOWN') {
        if (!counts.has(s.dialog)) counts.set(s.dialog, new Map())
        const c = counts.get(s.dialog)!
        c.set(s.name, (c.get(s.name) || 0) + 1)
    }
    const names = new Map([...counts].map(([d, c]) => [d, [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]]))
    return names
}

export async function discoverWorkflows(q: Window & { limit?: number }) {
    const { historyDiscovery, analysisMeta } = await import('./analysishistory.ts')
    const historical = historyDiscovery(q, Number.MAX_SAFE_INTEGER)
    const data = historical ? { sessions: [], sessions_selected: 0, rows_read: 0, truncated: false } : await workflowSessions(q)
    // Count eligible ranked chains before applying the response limit.
    const ranked = historical ?? discoverWorkflowChains(data.sessions, required(), { names: labels(data.sessions), window: q, limit: Number.MAX_SAFE_INTEGER })
    const discovered = ranked.slice(0, q.limit ?? 15)
    return { window: { from: q.from.toISOString(), to: q.to.toISOString() }, client: q.clientId,
        ...analysisMeta(q, true),
        discovered, total_workflows: ranked.length, limits: historyLimits(discovered.length, ranked.length - discovered.length),
        sessions_selected: data.sessions_selected, rows_read: data.rows_read, truncated: data.truncated || discovered.length < ranked.length,
        note: 'Names use dialog titles and the most common confirmed submit/success-message template; ids encode only the ordered dialog codes. No setup needed. Chains of 2–4 contiguous dialog opens, consecutive repeats collapsed; search/menu navigation or 10 minutes idle starts a new episode. At least 2 distinct sessions; ranked by sessions × clients. Contained chains are removed when a longer chain has at least 80% of their session support. Outcomes count occurrences, separately completed and queued (accepted); either counts as done here. Durations end at the first matching outcome message. History combines unpruned daily candidates with exact distinct identities and exact duration distributions; sessions_selected and rows_read describe live reads (zero for history). Live reads page every selected session and event, bounded to the window plus one day on either side. Starts belong to this window. Longer sessions can be partial.' }
}

/** Resolve exact labels/aliases, rejecting ambiguous names instead of picking a dialog silently. */
export function resolveWorkflowDialogs(inputs: string[], reg: AppEvents, names: Map<string, { name?: string }>): string[] {
    return inputs.map((input) => {
        const want = input.trim().toLowerCase()
        const codes = new Set([...names.keys(), ...Object.keys(reg.aliases)])
        const exact = [...codes].find((d) => d.toLowerCase() === want)
        if (exact) return exact
        const matches = [...codes].filter((d) => dialogLabel(d, reg, { get: (code) => names.get(code)?.name }).toLowerCase() === want)
        if (matches.length > 1) throw new ToolInputError('Ambiguous dialog name. Use a dialog code from discover_workflows.')
        if (matches.length) return matches[0]
        if (DIALOG_CODE.test(input.trim())) return input.trim()
        throw new ToolInputError('No dialog matches. Use its code or exact dialog name from discover_workflows.')
    })
}

export async function completionWorkflow(q: Window & { workflow?: string; dialogs?: string[] }) {
    if (q.workflow !== undefined && q.dialogs !== undefined) throw new ToolInputError('Give either a discovered workflow id/name or dialogs, not both.')
    if (q.workflow === undefined && q.dialogs === undefined) throw new ToolInputError('Say which workflow: a workflow id or name from discover_workflows (for the same window), or its dialogs in order.')
    const reg = required()
    if (q.workflow !== undefined) {
        const input = q.workflow.trim()
        if (!input) throw new ToolInputError('Give a discovered workflow id or name.')
        if (input.startsWith('wf_')) {
            const dialogs = workflowDialogsFromId(input)
            if (dialogs.some((d) => [...reg.dialogs.menu, ...reg.dialogs.messages, ...reg.dialogs.notices].includes(d)))
                throw new ToolInputError('Use task dialogs, not menu, messagebox or toast.')
            return validateWorkflow({ name: dialogs.map((d) => dialogLabel(d, reg)).join(' → '), dialogs,
                done: { dialog: dialogs.at(-1)!, outcome: 'either' } })
        }
        const matches = (await discoverWorkflows({ ...q, limit: Number.MAX_SAFE_INTEGER })).discovered
            .filter((w) => w.name.toLowerCase() === input.toLowerCase())
        if (matches.length > 1) throw new ToolInputError('Ambiguous workflow name. Use its discovered id.')
        if (!matches.length) throw new ToolInputError('No discovered workflow in this window. Use discover_workflows, a discovered id or dialogs.')
        const w = matches[0]
        return validateWorkflow({ name: w.name, dialogs: w.dialogs, done: { dialog: w.dialogs.at(-1)!, outcome: 'either' } })
    }
    if (!q.dialogs?.length || q.dialogs.length > 10) throw new ToolInputError('Give 1–10 dialogs.')
    // Codes need no name lookup; names use the vocabulary and observed titles.
    const { historyDialogNames } = await import('./analysishistory.ts')
    const names = historyDialogNames(q) ?? (q.dialogs.every((d) => /^Dlg[A-Za-z0-9_$]+$/.test(d) && !Object.values(reg.aliases).some((n) => n.toLowerCase() === d.toLowerCase()))
        ? new Map<string, { name?: string }>() : await dialogNames(q.from, q.to, q.clientId))
    const dialogs = resolveWorkflowDialogs(q.dialogs, reg, names)
    const excluded = [...reg.dialogs.menu, ...reg.dialogs.messages, ...reg.dialogs.notices]
    if (dialogs.some((d) => excluded.includes(d))) throw new ToolInputError('Use task dialogs, not menu, messagebox or toast.')
    return validateWorkflow({ name: dialogs.map((d) => dialogLabel(d, reg, { get: (code) => names.get(code)?.name })).join(' → '), dialogs,
        done: { dialog: dialogs.at(-1)!, outcome: 'completed' } })
}

function trend(now: CompletionMetrics, before: CompletionMetrics) {
    return { started_change: now.started - before.started, done_change: now.done - before.done,
        abandoned_change: now.abandoned - before.abandoned, completion_rate_change: now.completion_rate - before.completion_rate,
        median_time_s_change: now.median_time_s === null || before.median_time_s === null ? null : now.median_time_s - before.median_time_s }
}

export async function workflowCompletionReport(q: Window & { definition: Workflow } & ComparisonOptions) {
    const definition = validateWorkflow(q.definition)
    const requestedBaseline=comparisonWindow(q)
    const previous = requestedBaseline || {from:q.from,to:q.to}
    const { historyCompletion, analysisMeta, analysisCoverage } = await import('./analysishistory.ts')
    const comparable=!!requestedBaseline && analysisCoverage(q).complete && analysisCoverage(previous).complete
    const historyNow = historyCompletion(q, definition), historyBefore = comparable ? historyCompletion({ ...q, ...previous }, definition) : historyCompletion({...q,from:q.from,to:q.from},definition)
    const historical = !!historyNow
    const data = historical ? { sessions: [], sessions_selected: 0, rows_read: 0, truncated: false } : await workflowSessions(q, definition.dialogs)
    const reg = required(), names = labels(data.sessions)
    const now = historical ? historyNow! : workflowCompletion(data.sessions, definition, reg, q, names)
    const before = historyBefore || workflowCompletion([],definition,reg,previous,names)
    const empty = workflowCompletion([], definition, reg, undefined, names).overall
    const allClients = [...new Set([...now.clients, ...before.clients].map((c) => c.client))].sort().map((client) => {
        const n = now.clients.find((c) => c.client === client) || empty, b = before.clients.find((c) => c.client === client) || empty
        return { client, now: n, before: b, trend: comparable ? trend(n, b) : null }
    })
    allClients.sort((a, b) => b.now.started + b.before.started - a.now.started - a.before.started || a.client.localeCompare(b.client))
    const clients = allClients.slice(0, 8)
    while (clients.length && JSON.stringify(clients).length > 20000) clients.pop()
    const rest = () => {
        const omitted = allClients.slice(clients.length)
        const totals = (period: 'now' | 'before') => Object.fromEntries(
            (['started', 'done', 'completed', 'accepted', 'failed_attempts', 'retries', 'abandoned'] as const)
                .map((key) => [key, omitted.reduce((n, c) => n + c[period][key], 0)]))
        return { clients: omitted.length, now: totals('now'), before: totals('before') }
    }
    const metrics = [now.overall, before.overall, ...clients.flatMap((c) => [c.now, c.before])]
    const spans = await recordingSpans([...new Set(metrics.flatMap((m) => m.examples.map((e) => e.session_id)))]).catch(() => new Map())
    for (const m of metrics) for (const e of m.examples) {
        const span = spans.get(e.session_id)
        if (span) e.replay_url = replayUrl(e.session_id, Math.max(0, (Date.parse(e.at) - Date.parse(span.start)) / 1000 - 10))
    }
    const comparisonNote = !requestedBaseline ? 'Comparison disabled.' : +previous.to - +previous.from === +q.to - +q.from ? 'Previous window has equal length.' : `Previous window spans ${(+previous.to - +previous.from) / 86400000} days; current window spans ${(+q.to - +q.from) / 86400000} days.`
    const result = { workflow: definition, window: { from: q.from.toISOString(), to: q.to.toISOString() }, previous_window: { from: previous.from.toISOString(), to: previous.to.toISOString() },
        ...analysisMeta(q, true), comparison:{requested:requestedBaseline,status:q.compare==='none'?'none':comparable?'complete':'unavailable',reason:comparable?'Complete periods':'Baseline or current history incomplete; comparison omitted; no live baseline read'},
        overall: { now: now.overall, before: before.overall, trend: comparable ? trend(now.overall, before.overall) : null }, clients, clients_rest: rest(),
        sessions_selected: data.sessions_selected, rows_read: data.rows_read, truncated: data.truncated,
        note: 'One start per episode opening the first dialog in the window. Funnel requires dialog opens in order, allowing other dialogs between steps. Done requires all steps and a matching submit/outcome in that episode; queued is separate from completed. Ad hoc workflows require completed. Failures count error submits; retries repeat the same dialog/button within 5 minutes after an error, before done. Dropout is the last reached step among abandoned episodes. Durations end at the outcome message. Full selected sessions can finish after the window; abandonment means no observed done before the episode ended. Sessions still active may change. ' + comparisonNote + ' History evaluates compact daily episode statistics, combining all attempts with exact durations; sessions_selected and rows_read describe live reads (zero for history). Live reads page all selected sessions and events with a one-day margin at both window edges; longer sessions may be partial. Client rows show at most eight clients ranked by attempts across both periods; clients_rest contains totals for the rest. Replay links are for the person only.' }
    while (clients.length && JSON.stringify(result).length >= 29500) { clients.pop(); result.clients_rest = rest() }
    return result

}
