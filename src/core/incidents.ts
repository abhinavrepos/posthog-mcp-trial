// "When did this client hit this?" Trouble moments (exceptions, rage clicks, dead clicks, and the app's own
// error messages) for a client, each linked to the session recording and the offset into it.
import { hogql, replayUrl } from './posthog.ts'
import { appEvents, generalise } from './appevents.ts'
import { clockShift } from './replaynet.ts'
import { P } from './props.ts'

export type IncidentKind = 'exception' | 'rageclick' | 'dead_click' | 'app_error'

export interface Incident {
    kind: IncidentKind
    timestamp: string // ISO, UTC
    client_id: string
    client_name: string
    user: string // email, or distinct id if no email
    pathname: string
    app_version: string
    session_id: string
    // exceptions
    error_type?: string
    error_message?: string
    issue_id?: string
    // clicks
    element?: string
    // filled from the recording, when there is one
    recording?: { start: string; end: string; offset_s: number; url: string }
}

export interface IncidentQuery {
    clientId: string
    from: Date
    to: Date
    pathname?: string
    email?: string
    kinds?: IncidentKind[]
    limit?: number
}

const EVENT_FOR: Record<Exclude<IncidentKind, 'app_error'>, string> = {
    exception: '$exception',
    rageclick: '$rageclick',
    dead_click: '$dead_click',
}
/** The app's own error messages (Reval: an interaction event in a messagebox dialog, the text in the button
 * property). PostHog's trouble events alone missed them: a client who saw "Invalid trade" four times had
 * "0 trouble events" (replay check, 2026-11-17). Property names are validated identifiers (parseAppEvents). */
function appErrorSql(): { where: string; text: string } | undefined {
    const reg = appEvents(), dialog = reg?.properties.dialog?.name, button = reg?.properties.button?.name
    if (!reg || !dialog || !reg.dialogs.messages.length) return
    const b = button ? `toString(properties.${button})` : `''`
    return { where: `(event = {app_event} AND toString(properties.${dialog}) IN {app_dialogs})`,
        text: `coalesce(nullIf(JSONExtractString(${b}, 1), ''), ${b})` }
}

/** Picks a readable label for a clicked element: its text, then data-attr, then id, then tag. */
export function elementLabel(chain: string): string | undefined {
    if (!chain) return undefined
    const first = chain.split(';')[0]
    const text = /(?:^|:)text="((?:[^"\\]|\\.)*)"/.exec(first)?.[1]
    if (text?.trim()) return `"${text.trim()}"`
    const attr = /attr__data-attr="([^"]*)"/.exec(first)?.[1]
    if (attr) return `[data-attr=${attr}]`
    const id = /attr__id="([^"]*)"/.exec(first)?.[1]
    if (id) return `#${id}`
    const tag = /^([a-z0-9]+)/i.exec(first)?.[1]
    return tag ? `<${tag}>` : undefined
}

export async function findIncidents(q: IncidentQuery): Promise<Incident[]> {
    const app = appErrorSql()
    const kinds = q.kinds?.length ? q.kinds : ([...Object.keys(EVENT_FOR), ...(app ? ['app_error'] : [])] as IncidentKind[])
    const posthogKinds = kinds.filter((k): k is Exclude<IncidentKind, 'app_error'> => k !== 'app_error')
    const withApp = !!app && kinds.includes('app_error')
    const appMessage = withApp ? app!.text : `''`, appWhere = withApp ? ` OR ${app!.where}` : ''
    const rows = await hogql(
        `SELECT event, timestamp, toFloat(properties.$time) AS ctime, toString(${P.client}) AS client_id, toString(${P.clientName}) AS client_name,
                coalesce(nullIf(toString(${P.email}), ''), distinct_id) AS user,
                toString(properties.$pathname) AS pathname, toString(${P.version}) AS app_version,
                toString(properties.$session_id) AS session_id,
                toString(properties.$exception_types[1]) AS error_type,
                toString(properties.$exception_values[1]) AS error_message,
                toString(properties.$exception_issue_id) AS issue_id,
                ${appMessage} AS app_message,
                elements_chain
         FROM events
         WHERE (event IN {events}${appWhere})
           AND toString(${P.client}) = {client}
           AND timestamp >= {from} AND timestamp < {to}
           AND ({pathname} = '' OR toString(properties.$pathname) = {pathname})
           AND ({email} = '' OR lower(toString(${P.email})) = {email})
         ORDER BY timestamp DESC
         LIMIT {limit}`,
        {
            events: posthogKinds.length ? posthogKinds.map((k) => EVENT_FOR[k]) : ['$none'],
            app_event: appEvents()?.events.interaction ?? '',
            app_dialogs: appEvents()?.dialogs.messages.length ? appEvents()!.dialogs.messages : [''],
            client: q.clientId,
            from: q.from.toISOString(),
            to: q.to.toISOString(),
            pathname: q.pathname || '',
            email: (q.email || '').toLowerCase(),
            limit: q.limit ?? 50,
        }
    )
    const incidents: Incident[] = rows.map((r) => {
        const kind = ((Object.keys(EVENT_FOR) as (keyof typeof EVENT_FOR)[]).find((k) => EVENT_FOR[k] === r.event) ?? 'app_error') as IncidentKind
        if (kind === 'app_error') {
            const reg = appEvents()!
            return { kind, timestamp: new Date(String(r.timestamp)).toISOString(), client_id: String(r.client_id), client_name: String(r.client_name),
                user: String(r.user), pathname: String(r.pathname), app_version: String(r.app_version), session_id: String(r.session_id),
                // The template, never the raw text: messages carry trade ids, amounts and counterparties.
                error_message: generalise(String(r.app_message || ''), reg) || undefined }
        }
        return {
            kind,
            timestamp: new Date(String(r.timestamp)).toISOString(),
            client_id: String(r.client_id),
            client_name: String(r.client_name),
            user: String(r.user),
            pathname: String(r.pathname),
            app_version: String(r.app_version),
            session_id: String(r.session_id),
            ...(kind === 'exception'
                ? { error_type: String(r.error_type) || undefined, error_message: String(r.error_message) || undefined, issue_id: String(r.issue_id) || undefined }
                : { element: elementLabel(String(r.elements_chain || '')) }),
        }
    })
    const shifts = new Map<string, number>()
    for (const id of new Set(incidents.map(i => i.session_id))) shifts.set(id, clockShift(rows.filter(r => String(r.session_id) === id).map(r => ({ ts: String(r.timestamp), ctime: Number(r.ctime) * 1000 }))))
    // The browser-vs-server clock gap is measured over the session's ordinary events, not the trouble rows alone:
    // $rageclick is sent when the burst ends, so its own clock pair put a rage click 5 s into a recording where it
    // happened at 1.7 s (replay check 2026-11-17).
    for (const [id, shift] of await sessionShifts([...shifts.keys()], q.from, q.to)) shifts.set(id, shift)
    await attachRecordings(incidents, shifts)
    return incidents
}

async function sessionShifts(ids: string[], from: Date, to: Date): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!ids.length) return out
    try {
        const rows = await hogql(
            `SELECT toString(properties.$session_id) AS sid, quantileExact(0.5)(toFloat(properties.$time) * 1000 - toUnixTimestamp64Milli(timestamp)) AS shift, count() AS n
             FROM events
             WHERE toString(properties.$session_id) IN {ids} AND timestamp >= {from} AND timestamp < {to}
               AND toFloat(properties.$time) > 1000000000 AND event NOT IN ('$rageclick', '$dead_click', '$exception')
             GROUP BY sid`,
            { ids, from: new Date(+from - 3_600_000).toISOString(), to: new Date(+to + 3_600_000).toISOString() })
        for (const r of rows) if (Number(r.n) >= 3 && Number.isFinite(Number(r.shift))) out.set(String(r.sid), Number(r.shift))
    } catch { /* the per-row estimate stays */ }
    return out
}

export interface RecordingSpan {
    session_id: string
    start: string
    end: string
}

// Query audit exception: replay metadata keyed by explicit session ids, not an events scan.
// No event timestamp column/window applies; replay start/end are what this lookup discovers.
export async function recordingSpans(sessionIds: string[], query: typeof hogql = hogql): Promise<Map<string, RecordingSpan>> {
    const ids = [...new Set(sessionIds.filter(Boolean))]
    if (!ids.length) return new Map()
    const spans = new Map<string, RecordingSpan>()
    // Task ingestion admits up to 100,000 sessions; each metadata query returns at most 50,000.
    for (let i = 0; i < ids.length; i += 50000) {
        const rows = await query(
            `SELECT session_id, min(min_first_timestamp) AS start, max(max_last_timestamp) AS end
             FROM raw_session_replay_events
             WHERE session_id IN {ids}
             GROUP BY session_id
             LIMIT 50000`,
            { ids: ids.slice(i, i + 50000) }
        )
        for (const r of rows) spans.set(String(r.session_id), { session_id: String(r.session_id), start: new Date(String(r.start)).toISOString(), end: new Date(String(r.end)).toISOString() })
    }
    return spans
}

async function attachRecordings(incidents: Incident[], shifts: Map<string, number>): Promise<void> {
    const spans = await recordingSpans(incidents.map((i) => i.session_id))
    for (const i of incidents) {
        const span = spans.get(i.session_id)
        if (!span) continue
        const offset = (Date.parse(i.timestamp) + (shifts.get(i.session_id) || 0) - Date.parse(span.start)) / 1000
        i.recording = { start: span.start, end: span.end, offset_s: Math.max(0, offset), url: replayUrl(i.session_id, Math.max(0, offset - 5)) }
    }
}

/**
 * Collapses incidents to one per session (keeping the first exception, else the first
 * frustration signal) and ranks sessions with a recording first.
 */
export function bestPerSession(incidents: Incident[]): Incident[] {
    const rank = (i: Incident) => (i.kind === 'exception' || i.kind === 'app_error' ? 0 : i.kind === 'rageclick' ? 1 : 2)
    const bySession = new Map<string, Incident>()
    for (const i of [...incidents].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
        const prev = bySession.get(i.session_id)
        if (!prev || rank(i) < rank(prev)) bySession.set(i.session_id, i)
    }
    return [...bySession.values()].sort(
        (a, b) => Number(!!b.recording) - Number(!!a.recording) || Date.parse(b.timestamp) - Date.parse(a.timestamp)
    )
}
