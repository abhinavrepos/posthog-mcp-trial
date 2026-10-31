// "Is it just them?" Blast radius of one error: who else hit it, since when, and on which release.
import { hogql, issueUrl } from './posthog.ts'

export interface ErrorImpact {
    issue_id?: string
    issue_url?: string
    error_type: string
    error_message: string
    days: number
    occurrences: number
    clients: { client_id: string; client_name: string; plan: string; occurrences: number; users: number; last_seen: string }[]
    users: number
    sessions: number
    first_seen?: string
    last_seen?: string
    by_version: { app_version: string; occurrences: number; clients: number }[]
    daily: { day: string; occurrences: number }[]
    // Of sessions that visited the screen, how many hit this error, per release.
    failure_rate?: { pathname: string; by_version: { app_version: string; sessions: number; failed: number; rate: number }[] }
}

/** Matches by PostHog's grouped issue id when known, else by exception type and message. */
function errorFilter(e: { issue_id?: string; error_type?: string; error_message?: string }) {
    if (e.issue_id) return { where: `toString(properties.$exception_issue_id) = {issue}`, values: { issue: e.issue_id } }
    return {
        where: `toString(properties.$exception_types[1]) = {etype} AND toString(properties.$exception_values[1]) = {evalue}`,
        values: { etype: e.error_type || '', evalue: e.error_message || '' },
    }
}

export async function errorImpact(
    e: { issue_id?: string; error_type?: string; error_message?: string },
    opts: { days?: number; pathname?: string } = {}
): Promise<ErrorImpact> {
    const days = opts.days ?? 30
    const f = errorFilter(e)
    const values = { ...f.values, days }
    const base = `event = '$exception' AND timestamp > now() - toIntervalDay({days}) AND ${f.where}`

    const [summary, clients, versions, daily] = await Promise.all([
        hogql(
            `SELECT count() AS n, count(DISTINCT person_id) AS users, count(DISTINCT toString(properties.$session_id)) AS sessions,
                    min(timestamp) AS first_seen, max(timestamp) AS last_seen,
                    any(toString(properties.$exception_types[1])) AS etype, any(toString(properties.$exception_values[1])) AS evalue,
                    any(toString(properties.$exception_issue_id)) AS issue
             FROM events WHERE ${base}`,
            values
        ),
        hogql(
            `SELECT toString(properties.client_id) AS client_id, any(toString(properties.client_name)) AS client_name,
                    any(toString(properties.client_plan)) AS plan,
                    count() AS n, count(DISTINCT person_id) AS users, max(timestamp) AS last_seen
             FROM events WHERE ${base} GROUP BY client_id ORDER BY n DESC LIMIT 50`,
            values
        ),
        hogql(
            `SELECT toString(properties.app_version) AS v, count() AS n, count(DISTINCT toString(properties.client_id)) AS clients
             FROM events WHERE ${base} GROUP BY v ORDER BY n DESC`,
            values
        ),
        hogql(
            `SELECT toString(toDate(timestamp)) AS day, count() AS n FROM events WHERE ${base} GROUP BY day ORDER BY day`,
            values
        ),
    ])

    const s = summary[0] || {}
    const issueId = e.issue_id || String(s.issue || '') || undefined
    const impact: ErrorImpact = {
        issue_id: issueId,
        issue_url: issueId ? issueUrl(issueId) : undefined,
        error_type: e.error_type || String(s.etype || ''),
        error_message: e.error_message || String(s.evalue || ''),
        days,
        occurrences: Number(s.n || 0),
        users: Number(s.users || 0),
        sessions: Number(s.sessions || 0),
        first_seen: Number(s.n) ? new Date(String(s.first_seen)).toISOString() : undefined,
        last_seen: Number(s.n) ? new Date(String(s.last_seen)).toISOString() : undefined,
        clients: clients.map((r) => ({
            client_id: String(r.client_id),
            client_name: String(r.client_name),
            plan: String(r.plan || ''),
            occurrences: Number(r.n),
            users: Number(r.users),
            last_seen: new Date(String(r.last_seen)).toISOString(),
        })),
        by_version: versions.map((r) => ({ app_version: String(r.v), occurrences: Number(r.n), clients: Number(r.clients) })),
        daily: fillDays(
            daily.map((r) => ({ day: String(r.day), occurrences: Number(r.n) })),
            Math.min(days, 14)
        ),
    }

    if (opts.pathname) {
        const rows = await hogql(
            `SELECT v, count() AS sessions, countIf(failed) AS failed FROM (
                 SELECT toString(properties.$session_id) AS sid, any(toString(properties.app_version)) AS v,
                        countIf(event = '$exception' AND ${f.where}) > 0 AS failed
                 FROM events
                 WHERE timestamp > now() - toIntervalDay({days})
                   AND notEmpty(toString(properties.$session_id))
                   AND (toString(properties.$pathname) = {path} OR event = '$exception')
                 GROUP BY sid
                 HAVING countIf(event = '$pageview' AND toString(properties.$pathname) = {path}) > 0
             ) GROUP BY v ORDER BY v`,
            { ...values, path: opts.pathname }
        )
        impact.failure_rate = {
            pathname: opts.pathname,
            by_version: rows.map((r) => {
                const sessions = Number(r.sessions)
                const failed = Number(r.failed)
                return { app_version: String(r.v), sessions, failed, rate: sessions ? failed / sessions : 0 }
            }),
        }
    }
    return impact
}

/** The most frequent errors on a screen, for risk reviews that name a screen but not an error. */
export async function topErrorsOnScreen(pathname: string, days = 14, limit = 3): Promise<{ issue_id: string; error_type: string; error_message: string; occurrences: number; clients: number }[]> {
    const rows = await hogql(
        `SELECT toString(properties.$exception_issue_id) AS issue, any(toString(properties.$exception_types[1])) AS etype,
                any(toString(properties.$exception_values[1])) AS evalue, count() AS n, count(DISTINCT toString(properties.client_id)) AS clients
         FROM events
         WHERE event = '$exception' AND timestamp > now() - toIntervalDay({days}) AND toString(properties.$pathname) = {path}
         GROUP BY issue ORDER BY n DESC LIMIT {limit}`,
        { path: pathname, days, limit }
    )
    return rows.map((r) => ({ issue_id: String(r.issue), error_type: String(r.etype), error_message: String(r.evalue), occurrences: Number(r.n), clients: Number(r.clients) }))
}

/** Fills missing days with zeros so a trend shows quiet days too. */
export function fillDays(rows: { day: string; occurrences: number }[], lastNDays: number, today = new Date()): { day: string; occurrences: number }[] {
    const by = new Map(rows.map((r) => [r.day, r.occurrences]))
    const out: { day: string; occurrences: number }[] = []
    for (let i = lastNDays - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10)
        out.push({ day: d, occurrences: by.get(d) || 0 })
    }
    return out
}
