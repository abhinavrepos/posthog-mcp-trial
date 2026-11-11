// "How many clients use this screen, and when?" Usage of one screen over a period.
import { appAnswer, appQuery as hogql } from './appevents.ts'
import { P } from './props.ts'

export interface ScreenUsage {
    pathname: string
    days: number
    clients_using: number
    clients_total: number
    users: number
    sessions: number
    pageviews: number
    by_weekday: { weekday: string; pageviews: number }[] // Monday first
    busiest_days: { day: string; pageviews: number }[]
    top_clients: { client_id: string; client_name: string; pageviews: number; users: number }[]
    client?: { client_id: string; pageviews: number; users: number; rank: number; last_seen?: string }
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export async function screenUsage(pathname: string, opts: { days?: number; clientId?: string } = {}): Promise<ScreenUsage> {
    return appAnswer('screenUsage', [pathname, opts], () => computeScreenUsage(pathname, opts), 60_000)
}

async function computeScreenUsage(pathname: string, opts: { days?: number; clientId?: string } = {}): Promise<ScreenUsage> {
    const days = opts.days ?? 30
    const values = { path: pathname, days }
    const scope = `event = '$pageview' AND timestamp > now() - toIntervalDay({days}) AND notEmpty(toString(${P.client}))`

    const [totals, weekday, busiest, top] = await Promise.all([
        hogql(
            // Count the screen and the client denominator together, preserving exact distincts.
            `SELECT count(DISTINCT toString(${P.client})) AS clients_total,
                    count(DISTINCT if(toString(properties.$pathname) = {path}, toString(${P.client}), NULL)) AS clients,
                    count(DISTINCT if(toString(properties.$pathname) = {path}, person_id, NULL)) AS users,
                    count(DISTINCT if(toString(properties.$pathname) = {path}, toString($session_id), NULL)) AS sessions,
                    countIf(toString(properties.$pathname) = {path}) AS pageviews
             FROM events WHERE ${scope} LIMIT 1`,
            values
        ),
        hogql(
            `SELECT toDayOfWeek(timestamp) AS dow, count() AS pageviews
             FROM events WHERE ${scope} AND toString(properties.$pathname) = {path}
             GROUP BY dow ORDER BY dow LIMIT 7`,
            values
        ),
        hogql(
            `SELECT toString(toDate(timestamp)) AS day, count() AS pageviews
             FROM events WHERE ${scope} AND toString(properties.$pathname) = {path}
             GROUP BY day ORDER BY pageviews DESC LIMIT 5`,
            values
        ),
        hogql(
            `SELECT toString(${P.client}) AS client_id, any(toString(${P.clientName})) AS client_name,
                    count() AS pageviews, count(DISTINCT person_id) AS users, max(timestamp) AS last_seen
             FROM events WHERE ${scope} AND toString(properties.$pathname) = {path}
             GROUP BY client_id ORDER BY pageviews DESC LIMIT 100`,
            values
        ),
    ])

    const t = totals[0] || {}
    const ranked = top.map((r, i) => ({
        client_id: String(r.client_id),
        client_name: String(r.client_name),
        pageviews: Number(r.pageviews),
        users: Number(r.users),
        last_seen: r.last_seen ? new Date(String(r.last_seen)).toISOString() : undefined,
        rank: i + 1,
    }))
    const mine = opts.clientId ? ranked.find((r) => r.client_id === opts.clientId) : undefined
    const dow = new Map(weekday.map((r) => [Number(r.dow), Number(r.pageviews)]))
    return {
        pathname,
        days,
        clients_using: Number(t.clients || 0),
        clients_total: Number(t.clients_total || 0),
        users: Number(t.users || 0),
        sessions: Number(t.sessions || 0),
        pageviews: Number(t.pageviews || 0),
        by_weekday: WEEKDAYS.map((weekday, i) => ({ weekday, pageviews: dow.get(i + 1) || 0 })),
        busiest_days: busiest.map((r) => ({ day: String(r.day), pageviews: Number(r.pageviews) })),
        top_clients: ranked.slice(0, 5).map(({ client_id, client_name, pageviews, users }) => ({ client_id, client_name, pageviews, users })),
        client: opts.clientId
            ? mine
                ? { client_id: mine.client_id, pageviews: mine.pageviews, users: mine.users, rank: mine.rank, last_seen: mine.last_seen }
                : { client_id: opts.clientId, pageviews: 0, users: 0, rank: 0 }
            : undefined,
    }
}
