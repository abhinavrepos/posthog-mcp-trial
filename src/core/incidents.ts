// "When did this client hit this?" Trouble moments (exceptions, rage clicks, dead clicks) for a
// client, each linked to the session recording and the offset into it.
import { hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'

export type IncidentKind = 'exception' | 'rageclick' | 'dead_click'

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

const EVENT_FOR: Record<IncidentKind, string> = {
    exception: '$exception',
    rageclick: '$rageclick',
    dead_click: '$dead_click',
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
    const kinds = q.kinds?.length ? q.kinds : (Object.keys(EVENT_FOR) as IncidentKind[])
    const rows = await hogql(
        `SELECT event, timestamp, toString(${P.client}) AS client_id, toString(${P.clientName}) AS client_name,
                coalesce(nullIf(toString(${P.email}), ''), distinct_id) AS user,
                toString(properties.$pathname) AS pathname, toString(${P.version}) AS app_version,
                $session_id AS session_id,
                toString(properties.$exception_types[1]) AS error_type,
                toString(properties.$exception_values[1]) AS error_message,
                toString(properties.$exception_issue_id) AS issue_id,
                elements_chain
         FROM events
         WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events} AND uuid IN (
             SELECT uuid FROM events WHERE event IN {events}
               AND timestamp >= {from} AND timestamp < {to}
               AND toString(${P.client}) = {client}
               AND ({pathname} = '' OR toString(properties.$pathname) = {pathname})
               AND ({email} = '' OR lower(toString(${P.email})) = {email})
             ORDER BY timestamp DESC, uuid LIMIT {limit}
         ) LIMIT {limit}`,
        {
            events: kinds.map((k) => EVENT_FOR[k]),
            client: q.clientId,
            from: q.from.toISOString(),
            to: q.to.toISOString(),
            pathname: q.pathname || '',
            email: (q.email || '').toLowerCase(),
            limit: q.limit ?? 50,
        }, { cache: true }
    )
    // The wide fetch is unsorted; restore the public newest-first order locally.
    rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    const incidents: Incident[] = rows.map((r) => {
        const kind = (Object.keys(EVENT_FOR) as IncidentKind[]).find((k) => EVENT_FOR[k] === r.event)!
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
    await attachRecordings(incidents)
    return incidents
}

export interface RecordingSpan {
    session_id: string
    start: string
    end: string
}

export async function recordingSpans(sessionIds: string[]): Promise<Map<string, RecordingSpan>> {
    const ids = [...new Set(sessionIds.filter(Boolean))].sort()
    if (!ids.length) return new Map()
    const rows = await hogql(
        `SELECT session_id, min(min_first_timestamp) AS start, max(max_last_timestamp) AS end
         FROM raw_session_replay_events
         WHERE session_id IN {ids}
         GROUP BY session_id
         LIMIT 50000`,
        { ids }, { cache: true, ttlMs: 60_000 }
    )
    return new Map(
        rows.map((r) => [
            String(r.session_id),
            { session_id: String(r.session_id), start: new Date(String(r.start)).toISOString(), end: new Date(String(r.end)).toISOString() },
        ])
    )
}

async function attachRecordings(incidents: Incident[]): Promise<void> {
    const spans = await recordingSpans(incidents.map((i) => i.session_id))
    for (const i of incidents) {
        const span = spans.get(i.session_id)
        if (!span) continue
        const offset = (Date.parse(i.timestamp) - Date.parse(span.start)) / 1000
        i.recording = { start: span.start, end: span.end, offset_s: Math.max(0, offset), url: replayUrl(i.session_id, Math.max(0, offset - 5)) }
    }
}

/**
 * Collapses incidents to one per session (keeping the first exception, else the first
 * frustration signal) and ranks sessions with a recording first.
 */
export function bestPerSession(incidents: Incident[]): Incident[] {
    const rank = (i: Incident) => (i.kind === 'exception' ? 0 : i.kind === 'rageclick' ? 1 : 2)
    const bySession = new Map<string, Incident>()
    for (const i of [...incidents].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
        const prev = bySession.get(i.session_id)
        if (!prev || rank(i) < rank(prev)) bySession.set(i.session_id, i)
    }
    return [...bySession.values()].sort(
        (a, b) => Number(!!b.recording) - Number(!!a.recording) || Date.parse(b.timestamp) - Date.parse(a.timestamp)
    )
}
