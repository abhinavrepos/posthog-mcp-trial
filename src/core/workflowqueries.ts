// Bounded queries and settings for the pure workflow reader.
import { columns, dialogLabel, dialogNames, required, toRaw, toSteps, type AppEvents, type RawEvent } from './appevents.ts'
import { getSetting, setSetting, tx } from './db.ts'
import { recordingSpans } from './incidents.ts'
import { hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'
import { DIALOG_CODE, discoverWorkflowChains, validateWorkflow, workflowCompletion, type Workflow, type CompletionMetrics } from './workflows.ts'

export interface SavedWorkflow extends Workflow { saved_by: string; saved_at: string }
export function savedWorkflows(): SavedWorkflow[] { return getSetting<SavedWorkflow[]>('workflows', []) }
export function saveWorkflow(value: unknown, savedBy: string): SavedWorkflow {
    const w = validateWorkflow(value)
    const reg = required()
    if (w.dialogs.some((d) => [...reg.dialogs.menu, ...reg.dialogs.messages, ...reg.dialogs.notices].includes(d))) throw new Error('Use task dialogs, not menu, messagebox or toast.')
    if (typeof savedBy !== 'string' || !savedBy.trim() || savedBy.length > 200) throw new Error('saved_by must name the person who agreed (1–200 characters).')
    const saved = { ...w, saved_by: savedBy.trim(), saved_at: new Date().toISOString() }
    tx(() => setSetting('workflows', [...savedWorkflows().filter((s) => s.name.toLowerCase() !== w.name.toLowerCase()), saved]))
    return saved
}

type Window = { from: Date; to: Date; clientId?: string }
const prop = (reg: AppEvents, role: 'dialog' | 'action') => reg.properties[role] ? `toString(properties.${reg.properties[role]!.name})` : `''`
const BATCH = 50, ROW_LIMIT = 50_000

/** First select relevant sessions, then read all their events, including episode boundaries.
 * Full sessions let starts near the window edge finish afterwards. Limits are always disclosed.
 */
export async function workflowSessions(q: Window, dialogs?: string[]) {
    const reg = required()
    const values = { from: q.from.toISOString(), to: q.to.toISOString(), client: q.clientId || '', screen: reg.events.screen,
        open: reg.screenActions.open, events: [reg.events.screen, reg.events.interaction], dialogs: dialogs || [''], all: dialogs ? 0 : 1 }
    const ids = await hogql(
        `SELECT toString(properties.$session_id) AS sid, max(timestamp) AS last FROM events
         WHERE timestamp >= {from} AND timestamp < {to} AND event = {screen} AND ${prop(reg, 'action')} IN {open}
           AND ({all} = 1 OR ${prop(reg, 'dialog')} IN {dialogs})
           AND ({client} = '' OR toString(${P.client}) = {client}) AND notEmpty(toString(properties.$session_id))
         GROUP BY sid ORDER BY last DESC, sid LIMIT 2000`, values)
    let rowsRead = 0, truncated = ids.length >= 2000
    const by = new Map<string, RawEvent[]>()
    for (let i = 0; i < ids.length; i += BATCH) {
        const rows = await hogql(
            `SELECT ${columns(reg)} FROM events WHERE toString(properties.$session_id) IN {sids} AND event IN {events}
             AND ({client} = '' OR toString(${P.client}) = {client}) ORDER BY sid, ts LIMIT 50000`,
            { sids: ids.slice(i, i + BATCH).map((r) => String(r.sid)), events: values.events, client: values.client })
        rowsRead += rows.length
        if (rows.length >= ROW_LIMIT) truncated = true
        for (const row of rows) {
            const e = toRaw(row)
            if (!by.has(e.sid)) by.set(e.sid, [])
            by.get(e.sid)!.push(e)
        }
    }
    return { sessions: [...by.values()].map((ev) => toSteps(ev, reg)), sessions_selected: ids.length, rows_read: rowsRead, truncated }
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
    const data = await workflowSessions(q)
    return { window: { from: q.from.toISOString(), to: q.to.toISOString() }, client: q.clientId,
        discovered: discoverWorkflowChains(data.sessions, required(), { names: labels(data.sessions), window: q, limit: q.limit }), saved: savedWorkflows(),
        sessions_selected: data.sessions_selected, rows_read: data.rows_read, truncated: data.truncated,
        note: 'Chains of 2–4 contiguous dialog opens, consecutive repeats collapsed; search/menu navigation or 10 minutes idle starts a new episode. At least 2 distinct sessions; ranked by sessions × clients. Contained chains are removed when a longer chain has at least 80% of their session support. Outcomes count occurrences, separately completed and queued (accepted); either counts as done here. Durations end at the first matching outcome message. Full selected sessions are read; starts belong to this window. Limits: newest 2000 sessions, 50000 events per batch of 50. Truncated results are partial.' }
}

/** Resolve exact labels/aliases, rejecting ambiguous names instead of picking a dialog silently. */
export function resolveWorkflowDialogs(inputs: string[], reg: AppEvents, names: Map<string, { name?: string }>): string[] {
    return inputs.map((input) => {
        const want = input.trim().toLowerCase()
        const codes = new Set([...names.keys(), ...Object.keys(reg.aliases)])
        const exact = [...codes].find((d) => d.toLowerCase() === want)
        if (exact) return exact
        const matches = [...codes].filter((d) => dialogLabel(d, reg, { get: (code) => names.get(code)?.name }).toLowerCase() === want)
        if (matches.length > 1) throw new Error(`Ambiguous dialog name "${input}". Use a dialog code: ${matches.join(', ')}.`)
        if (matches.length) return matches[0]
        if (DIALOG_CODE.test(input.trim())) return input.trim()
        throw new Error(`No dialog matches "${input}". Use its code or exact dialog name from discover_workflows.`)
    })
}

export async function completionWorkflow(q: Window & { workflow?: string; dialogs?: string[] }) {
    if (!!q.workflow === !!q.dialogs) throw new Error('Give either a saved workflow name or dialogs, not both.')
    const reg = required()
    if (q.workflow) {
        const saved = savedWorkflows().find((w) => w.name.toLowerCase() === q.workflow!.trim().toLowerCase())
        if (!saved) throw new Error(`No saved workflow "${q.workflow}". discover_workflows lists saved workflows.`)
        return saved
    }
    if (!q.dialogs?.length || q.dialogs.length > 10) throw new Error('Give 1–10 dialogs.')
    // Codes need no name lookup; names use the vocabulary and observed titles.
    const names = q.dialogs.every((d) => /^Dlg[A-Za-z0-9_$]+$/.test(d) && !Object.values(reg.aliases).some((n) => n.toLowerCase() === d.toLowerCase()))
        ? new Map<string, { name?: string }>() : await dialogNames(q.from, q.to, q.clientId)
    const dialogs = resolveWorkflowDialogs(q.dialogs, reg, names)
    return validateWorkflow({ name: 'Ad hoc workflow', dialogs, done: { dialog: dialogs.at(-1)!, outcome: 'completed' } })
}

function trend(now: CompletionMetrics, before: CompletionMetrics) {
    return { started_change: now.started - before.started, done_change: now.done - before.done,
        abandoned_change: now.abandoned - before.abandoned, completion_rate_change: now.completion_rate - before.completion_rate,
        median_time_s_change: now.median_time_s === null || before.median_time_s === null ? null : now.median_time_s - before.median_time_s }
}

export async function workflowCompletionReport(q: Window & { definition: Workflow }) {
    const definition = validateWorkflow(q.definition)
    const previous = { from: new Date(+q.from - (+q.to - +q.from)), to: q.from }
    const data = await workflowSessions({ ...q, from: previous.from }, definition.dialogs)
    const reg = required(), names = labels(data.sessions)
    const now = workflowCompletion(data.sessions, definition, reg, q, names)
    const before = workflowCompletion(data.sessions, definition, reg, previous, names)
    const empty = workflowCompletion([], definition, reg, undefined, names).overall
    const clients = [...new Set([...now.clients, ...before.clients].map((c) => c.client))].sort().map((client) => {
        const n = now.clients.find((c) => c.client === client) || empty, b = before.clients.find((c) => c.client === client) || empty
        return { client, now: n, before: b, trend: trend(n, b) }
    })
    const metrics = [now.overall, before.overall, ...clients.flatMap((c) => [c.now, c.before])]
    const spans = await recordingSpans([...new Set(metrics.flatMap((m) => m.examples.map((e) => e.session_id)))]).catch(() => new Map())
    for (const m of metrics) for (const e of m.examples) {
        const span = spans.get(e.session_id)
        if (span) e.replay_url = replayUrl(e.session_id, Math.max(0, (Date.parse(e.at) - Date.parse(span.start)) / 1000 - 10))
    }
    return { workflow: definition, window: { from: q.from.toISOString(), to: q.to.toISOString() }, previous_window: { from: previous.from.toISOString(), to: previous.to.toISOString() },
        overall: { now: now.overall, before: before.overall, trend: trend(now.overall, before.overall) }, clients,
        sessions_selected: data.sessions_selected, rows_read: data.rows_read, truncated: data.truncated,
        note: 'One start per episode opening the first dialog in the window. Funnel requires dialog opens in order, allowing other dialogs between steps. Done requires all steps and a matching submit/outcome in that episode; queued is separate from completed. Ad hoc workflows require completed. Failures count error submits; retries repeat the same dialog/button within 5 minutes after an error, before done. Dropout is the last reached step among abandoned episodes. Durations end at the outcome message. Full selected sessions can finish after the window; abandonment means no observed done before the episode ended. Sessions still active may change. Previous window has equal length. Limits: newest 2000 sessions across both windows, 50000 events per batch of 50; truncated results are partial. Replay links are for the person only.' }
}
