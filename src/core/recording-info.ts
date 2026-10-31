// What the clip page shows before rendering: who and when, how long, and the moments worth
// clipping. All of it comes from event data; nothing is read from the recording itself.
import { elementLabel } from './incidents.ts'
import { getRecording, hogql } from './posthog.ts'

export interface Moment {
    offset_s: number
    kind: 'error' | 'rage click' | 'dead click' | 'page'
    label: string
}

export interface RecordingInfo {
    session_id: string
    start: string
    end: string
    duration_s: number
    user?: string
    client?: string
    app_version?: string
    pages: string[]
    moments: Moment[]
}

export async function recordingInfo(sessionId: string): Promise<RecordingInfo> {
    const meta = await getRecording(sessionId)
    const start = Date.parse(meta.start_time)
    const rows = await hogql(
        `SELECT event, timestamp, toString(properties.$pathname) AS path,
                coalesce(nullIf(toString(person.properties.email), ''), distinct_id) AS user,
                toString(properties.client_name) AS client, toString(properties.app_version) AS version,
                toString(properties.$exception_types[1]) AS etype, toString(properties.$exception_values[1]) AS evalue,
                elements_chain
         FROM events
         WHERE toString(properties.$session_id) = {sid}
           AND event IN ('$pageview', '$exception', '$rageclick', '$dead_click')
           AND timestamp >= {from} AND timestamp <= {to}
         ORDER BY timestamp
         LIMIT 500`,
        {
            sid: sessionId,
            from: new Date(start - 60_000).toISOString(),
            to: new Date(Date.parse(meta.end_time) + 60_000).toISOString(),
        }
    )
    const moments: Moment[] = []
    const pages: string[] = []
    for (const r of rows) {
        const offset = Math.max(0, (Date.parse(String(r.timestamp)) - start) / 1000)
        const path = String(r.path || '')
        if (r.event === '$pageview') {
            if (path && pages.at(-1) !== path) pages.push(path)
            moments.push({ offset_s: offset, kind: 'page', label: path })
        } else if (r.event === '$exception') {
            moments.push({ offset_s: offset, kind: 'error', label: `${r.etype || 'Error'}: ${String(r.evalue || '').slice(0, 120)}` })
        } else {
            const what = elementLabel(String(r.elements_chain || '')) || 'an element'
            moments.push({ offset_s: offset, kind: r.event === '$rageclick' ? 'rage click' : 'dead click', label: `on ${what}` })
        }
    }
    const first = rows[0]
    return {
        session_id: sessionId,
        start: new Date(start).toISOString(),
        end: new Date(Date.parse(meta.end_time)).toISOString(),
        duration_s: Number(meta.recording_duration) || (Date.parse(meta.end_time) - start) / 1000,
        user: first ? String(first.user) : meta.distinct_id,
        client: first?.client ? String(first.client) : undefined,
        app_version: first?.version ? String(first.version) : undefined,
        pages,
        moments,
    }
}
