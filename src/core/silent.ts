// "Nothing crashed, but something is wrong." Sessions where a client struggled on a screen without
// any exception: rage clicks, dead clicks, the same action repeated, or a long stay.
import { hogql, replayUrl } from './posthog.ts'
import { recordingSpans } from './incidents.ts'

export interface StruggleSession {
    session_id: string
    user: string
    pathname: string
    start: string
    duration_s: number
    rageclicks: number
    dead_clicks: number
    repeated_action?: { event: string; count: number }
    exceptions: number
    score: number
    signals: string[]
    recording?: { start: string; end: string; url: string; offset_s: number }
}

/** Ranks a session's signals. Pure, so it is unit-tested. */
export function struggleScore(s: Pick<StruggleSession, 'rageclicks' | 'dead_clicks' | 'repeated_action' | 'duration_s'>): { score: number; signals: string[] } {
    const signals: string[] = []
    let score = 0
    if (s.rageclicks) {
        score += 3 * s.rageclicks
        signals.push(`${s.rageclicks} rage click${s.rageclicks > 1 ? 's' : ''}`)
    }
    if (s.dead_clicks) {
        score += Math.min(4, s.dead_clicks)
        signals.push(`${s.dead_clicks} dead click${s.dead_clicks > 1 ? 's' : ''}`)
    }
    if (s.repeated_action && s.repeated_action.count >= 3) {
        score += s.repeated_action.count
        signals.push(`repeated "${s.repeated_action.event}" ${s.repeated_action.count}×`)
    }
    if (s.duration_s >= 120) {
        score += 1
        signals.push(`${Math.round(s.duration_s / 60)} min on the screen`)
    }
    return { score, signals }
}

export async function struggleSessions(q: { clientId: string; pathname?: string; from: Date; to: Date; limit?: number }): Promise<StruggleSession[]> {
    const rows = await hogql(
        `SELECT toString(properties.$session_id) AS sid,
                any(coalesce(nullIf(toString(person.properties.email), ''), distinct_id)) AS user,
                any(toString(properties.$pathname)) AS pathname,
                min(timestamp) AS start, dateDiff('second', min(timestamp), max(timestamp)) AS duration_s,
                countIf(event = '$rageclick') AS rageclicks, countIf(event = '$dead_click') AS dead_clicks,
                countIf(event = '$exception') AS exceptions
         FROM events
         WHERE toString(properties.client_id) = {client}
           AND timestamp >= {from} AND timestamp < {to}
           AND notEmpty(toString(properties.$session_id))
           AND ({path} = '' OR toString(properties.$pathname) = {path})
         GROUP BY sid
         HAVING exceptions = 0
         ORDER BY start DESC
         LIMIT 200`,
        { client: q.clientId, from: q.from.toISOString(), to: q.to.toISOString(), path: q.pathname || '' }
    )
    // The app's own events (no "$" prefix) repeated in one session, e.g. a report refreshed 5 times.
    const repeated = new Map<string, { event: string; count: number }>()
    if (rows.length) {
        const counts = await hogql(
            `SELECT toString(properties.$session_id) AS sid, event, count() AS n
             FROM events
             WHERE toString(properties.$session_id) IN {ids} AND NOT startsWith(event, '$')
               AND timestamp >= {from} AND timestamp < {to}
             GROUP BY sid, event`,
            { ids: rows.map((r) => String(r.sid)), from: q.from.toISOString(), to: q.to.toISOString() }
        )
        for (const c of counts) {
            const prev = repeated.get(String(c.sid))
            if (!prev || Number(c.n) > prev.count) repeated.set(String(c.sid), { event: String(c.event), count: Number(c.n) })
        }
    }
    const sessions: StruggleSession[] = rows.map((r) => {
        const base = {
            session_id: String(r.sid),
            user: String(r.user),
            pathname: String(r.pathname),
            start: new Date(String(r.start)).toISOString(),
            duration_s: Number(r.duration_s),
            rageclicks: Number(r.rageclicks),
            dead_clicks: Number(r.dead_clicks),
            exceptions: Number(r.exceptions),
            repeated_action: repeated.get(String(r.sid)),
        }
        return { ...base, ...struggleScore(base) }
    })
    const spans = await recordingSpans(sessions.map((s) => s.session_id))
    for (const s of sessions) {
        const span = spans.get(s.session_id)
        if (span) {
            const offset = Math.max(0, (Date.parse(s.start) - Date.parse(span.start)) / 1000)
            s.recording = { start: span.start, end: span.end, offset_s: offset, url: replayUrl(s.session_id, offset) }
        }
    }
    return sessions
        .filter((s) => s.score > 0)
        .sort((a, b) => Number(!!b.recording) - Number(!!a.recording) || b.score - a.score)
        .slice(0, q.limit ?? 10)
}
