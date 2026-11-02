// Who is in the app right now, and how long each client spent in it: time in the app, split into
// active and idle, per day and per hour.
//
// How time is counted. Within each session (PostHog's $session_id, which ends after 30 minutes
// without any event), the time from one action to the next belongs to the first one:
//   - in the app: the whole gap
//   - active:     up to `gap_s` seconds of it (60 by default; the page can change it)
//   - idle:       the rest
// So a session runs from its first action to its last; time after the last action is not counted.
// A gap is credited to the hour and day it started in, in the viewer's timezone.
// Automatic events that are not a person doing something (LIVE_IGNORE_EVENTS) are left out.
//
// Every query has its own LIMIT: without one, PostHog's query API returns only the first 100 rows.
import { hogql, type Row } from './posthog.ts'

type Run = typeof hogql
import { P } from './props.ts'

const DAY = 86_400_000
const SESSION_TIMEOUT_MS = 30 * 60_000
export const GAP_CHOICES = [15, 30, 60, 120, 300, 600]
export const MAX_RANGE_DAYS = 92
const DEFAULT_IGNORE = '$feature_flag_called,$set,$groupidentify,$web_vitals,$opt_in,survey shown,survey dismissed'

const intEnv = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(process.env[k])
    return process.env[k] && Number.isInteger(v) && v >= lo && v <= hi ? v : d
}

export interface PresenceSettings {
    gap_s: number // default active time credited after each action
    live_minutes: number // "in the app now" = an action within this many minutes
    ignore_events: string[]
}

export function presenceSettings(): PresenceSettings {
    return {
        gap_s: intEnv('LIVE_ACTIVE_GAP_S', 60, 5, 1800),
        live_minutes: intEnv('LIVE_NOW_MINUTES', 5, 1, 60),
        ignore_events: (process.env.LIVE_IGNORE_EVENTS ?? DEFAULT_IGNORE)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    }
}

// ------------------------------------------------------------------ the request
export interface PresenceQuery {
    from: string // YYYY-MM-DD, in tz
    to: string // YYYY-MM-DD, in tz, inclusive
    tz: string
    gap_s: number
    client?: string
    user?: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** An IANA timezone name, aliases included (browsers send Asia/Kolkata or Asia/Calcutta). */
export function validTimeZone(tz: string): boolean {
    if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return false
    try {
        new Intl.DateTimeFormat('en', { timeZone: tz })
        return true
    } catch {
        return false
    }
}

/** Reads and checks the page's parameters. Returns the query, or the reason it is refused. */
export function parsePresenceQuery(q: URLSearchParams, settings = presenceSettings(), today = new Date()): PresenceQuery | { error: string } {
    const tz = q.get('tz') || 'UTC'
    if (!validTimeZone(tz)) return { error: `Unknown timezone: ${tz.slice(0, 60)}` }
    const local = dayIn(today, tz)
    const from = q.get('from') || local
    const to = q.get('to') || from
    if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return { error: 'Dates must look like 2026-11-02.' }
    if (to < from) return { error: 'The end date is before the start date.' }
    if ((Date.parse(to) - Date.parse(from)) / DAY + 1 > MAX_RANGE_DAYS) return { error: `Pick at most ${MAX_RANGE_DAYS} days.` }
    const gapRaw = q.get('gap')
    const gap = gapRaw === null || gapRaw === '' ? settings.gap_s : Number(gapRaw)
    if (!Number.isInteger(gap) || gap < 5 || gap > 1800) return { error: 'The active time per action must be 5 to 1800 seconds.' }
    const client = (q.get('client') || '').trim()
    const user = (q.get('user') || '').trim()
    if (client.length > 200 || user.length > 320) return { error: 'Client or person is too long.' }
    return { from, to, tz, gap_s: gap, ...(client ? { client } : {}), ...(user ? { user } : {}) }
}

/** The calendar day of `d` in `tz`, as YYYY-MM-DD. */
export function dayIn(d: Date, tz: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export const includesToday = (q: PresenceQuery, now = new Date()) => q.to >= dayIn(now, q.tz)

// ------------------------------------------------------------------ the queries
const USER = `coalesce(nullIf(toString(${P.email}), ''), distinct_id)`

/** Every action in the range, with the time until the next action in its session (`gap`, ms).
 * `detail` adds what each action was (event, screen, element), for one person's timeline. */
export function timedEvents(q: PresenceQuery, detail = false): string {
    const more = detail ? ', event, etype, chain, screen' : ''
    const moreInner = detail
        ? `, event, toString(properties.$event_type) AS etype, if(event = '$autocapture', elements_chain, '') AS chain, toString(properties.$pathname) AS screen`
        : ''
    // The window looks one day either side of the range, so gaps that cross midnight in any timezone
    // are found; the outer WHERE keeps only the days asked for.
    return `SELECT client, client_name, user, sid, ts, day, hour, gap${more} FROM (
        SELECT toString(${P.client}) AS client, toString(${P.clientName}) AS client_name, ${USER} AS user,
               toString(properties.$session_id) AS sid, timestamp AS ts${moreInner},
               toDate(toTimeZone(timestamp, {tz})) AS day, toHour(toTimeZone(timestamp, {tz})) AS hour,
               least(greatest(dateDiff('millisecond', timestamp,
                   leadInFrame(timestamp, 1, timestamp) OVER (PARTITION BY properties.$session_id ORDER BY timestamp ASC ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING)), 0), ${SESSION_TIMEOUT_MS}) AS gap
        FROM events
        WHERE timestamp >= toDateTime({from}) - toIntervalDay(1) AND timestamp < toDateTime({to}) + toIntervalDay(2)
          AND notEmpty(toString(${P.client})) AND notEmpty(toString(properties.$session_id))
          AND event NOT IN {ignore}
    ) WHERE day >= toDate({from}) AND day <= toDate({to})${q.client ? ' AND client = {client}' : ''}${q.user ? ' AND user = {user}' : ''}`
}

const TIME = `sum(gap) AS open_ms, sum(least(gap, {gap_ms})) AS active_ms`

function values(q: PresenceQuery, settings: PresenceSettings): Record<string, unknown> {
    return { from: q.from, to: q.to, tz: q.tz, gap_ms: q.gap_s * 1000, ignore: settings.ignore_events.length ? settings.ignore_events : ['-'], client: q.client ?? '', user: q.user ?? '' }
}

export interface Time {
    open_s: number // in the app
    active_s: number
    idle_s: number
}
const time = (r: Row): Time => {
    const open = Math.round(Number(r.open_ms || 0) / 1000)
    const active = Math.min(open, Math.round(Number(r.active_ms || 0) / 1000))
    return { open_s: open, active_s: active, idle_s: open - active }
}
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : undefined)

export interface PresenceReport {
    query: PresenceQuery
    totals: Time & { clients: number; people: number; sessions: number; actions: number }
    days: (Time & { day: string; clients: number; people: number; sessions: number })[]
    hours: (Time & { day: string; hour: number; people: number })[]
    clients: (Time & { client_id: string; client_name: string; people: number; sessions: number; first: string; last: string })[]
    people?: (Time & { user: string; sessions: number; first: string; last: string })[]
}

/** Totals, days, hours and clients for the range; plus the people when one client is picked. */
export async function presenceReport(q: PresenceQuery, settings = presenceSettings(), run: Run = hogql): Promise<PresenceReport> {
    const base = timedEvents(q)
    const v = values(q, settings)
    // The client list ignores the client and person filters, so the page can always offer every client.
    const all = timedEvents({ ...q, client: undefined, user: undefined })
    const [totals, days, hours, clients, people] = await Promise.all([
        run(`SELECT uniq(client) AS clients, uniq(user) AS people, uniq(sid) AS sessions, count() AS actions, ${TIME} FROM (${base}) LIMIT 1`, v),
        run(`SELECT toString(day) AS day, uniq(client) AS clients, uniq(user) AS people, uniq(sid) AS sessions, ${TIME} FROM (${base}) GROUP BY day ORDER BY day LIMIT 1000`, v),
        run(`SELECT toString(day) AS day, hour, uniq(user) AS people, ${TIME} FROM (${base}) GROUP BY day, hour ORDER BY day, hour LIMIT 10000`, v),
        run(
            `SELECT client, argMax(client_name, ts) AS client_name, uniq(user) AS people, uniq(sid) AS sessions, min(ts) AS first, max(ts) AS last, ${TIME}
             FROM (${all}) GROUP BY client ORDER BY open_ms DESC LIMIT 2000`,
            v
        ),
        q.client
            ? run(`SELECT user, uniq(sid) AS sessions, min(ts) AS first, max(ts) AS last, ${TIME} FROM (${base}) GROUP BY user ORDER BY open_ms DESC LIMIT 2000`, v)
            : Promise.resolve(undefined),
    ])
    const t = totals[0] || {}
    return {
        query: q,
        totals: { clients: Number(t.clients || 0), people: Number(t.people || 0), sessions: Number(t.sessions || 0), actions: Number(t.actions || 0), ...time(t) },
        days: days.map((r) => ({ day: String(r.day), clients: Number(r.clients), people: Number(r.people), sessions: Number(r.sessions), ...time(r) })),
        hours: hours.map((r) => ({ day: String(r.day), hour: Number(r.hour), people: Number(r.people), ...time(r) })),
        clients: clients.map((r) => ({
            client_id: String(r.client),
            client_name: String(r.client_name || r.client),
            people: Number(r.people),
            sessions: Number(r.sessions),
            first: iso(r.first)!,
            last: iso(r.last)!,
            ...time(r),
        })),
        people: people?.map((r) => ({ user: String(r.user), sessions: Number(r.sessions), first: iso(r.first)!, last: iso(r.last)!, ...time(r) })),
    }
}

export interface SessionRow extends Time {
    session_id: string
    user: string
    client_id: string
    client_name: string
    start: string
    end: string
    actions: number
}

/** The session log: every session in the range for one client (and optionally one person). */
export async function presenceSessions(q: PresenceQuery, settings = presenceSettings(), limit = 1000, run: Run = hogql): Promise<SessionRow[]> {
    const rows = await run(
        `SELECT sid, any(user) AS user, any(client) AS client, argMax(client_name, ts) AS client_name, min(ts) AS start, max(ts) AS end, count() AS actions, ${TIME}
         FROM (${timedEvents(q)}) GROUP BY sid ORDER BY start DESC LIMIT {limit}`,
        { ...values(q, settings), limit }
    )
    return rows.map((r) => ({
        session_id: String(r.sid),
        user: String(r.user),
        client_id: String(r.client),
        client_name: String(r.client_name || r.client),
        start: iso(r.start)!,
        end: iso(r.end)!,
        actions: Number(r.actions),
        ...time(r),
    }))
}

export interface LivePerson {
    client_id: string
    client_name: string
    user: string
    session_id: string
    last_seen: string
    session_start: string
    today: Time & { first: string }
}

/** People with an action in the last few minutes, with their time in the app today. */
export async function liveNow(tz: string, gap_s: number, settings = presenceSettings(), now = new Date(), run: Run = hogql): Promise<{ minutes: number; people: LivePerson[] }> {
    const minutes = settings.live_minutes
    const ignore = settings.ignore_events.length ? settings.ignore_events : ['-']
    const live = await run(
        `SELECT toString(${P.client}) AS client, argMax(toString(${P.clientName}), timestamp) AS client_name, ${USER} AS user,
                argMax(toString(properties.$session_id), timestamp) AS sid, max(timestamp) AS last_seen
         FROM events
         WHERE timestamp > now() - toIntervalMinute({minutes}) AND notEmpty(toString(${P.client})) AND event NOT IN {ignore}
         GROUP BY client, user ORDER BY last_seen DESC LIMIT 500`,
        { minutes, ignore }
    )
    if (!live.length) return { minutes, people: [] }
    const today = dayIn(now, tz)
    const users = live.map((r) => String(r.user))
    const sids = live.map((r) => String(r.sid)).filter(Boolean)
    const q: PresenceQuery = { from: today, to: today, tz, gap_s }
    const [todayRows, starts] = await Promise.all([
        run(`SELECT client, user, min(ts) AS first, ${TIME} FROM (${timedEvents(q)}) WHERE user IN {users} GROUP BY client, user LIMIT 1000`, { ...values(q, settings), users }),
        run(
            `SELECT toString(properties.$session_id) AS sid, min(timestamp) AS start FROM events
             WHERE timestamp > now() - toIntervalDay(1) AND toString(properties.$session_id) IN {sids} GROUP BY sid LIMIT 1000`,
            { sids: sids.length ? sids : ['-'] }
        ),
    ])
    const byUser = new Map(todayRows.map((r) => [`${r.client}\u0000${r.user}`, r]))
    const startOf = new Map(starts.map((r) => [String(r.sid), iso(r.start)!]))
    return {
        minutes,
        people: live.map((r) => {
            const t = byUser.get(`${r.client}\u0000${r.user}`) || {}
            const last = iso(r.last_seen)!
            return {
                client_id: String(r.client),
                client_name: String(r.client_name || r.client),
                user: String(r.user),
                session_id: String(r.sid),
                last_seen: last,
                session_start: startOf.get(String(r.sid)) || last,
                today: { first: iso(t.first) || last, ...time(t) },
            }
        }),
    }
}

// ------------------------------------------------------------------ one person's day
const NAMED: Record<string, string> = {
    $pageview: 'Opened a screen',
    $pageleave: 'Left the page',
    $rageclick: 'Clicked repeatedly',
    $dead_click: 'Clicked, nothing happened',
    $identify: 'Signed in',
    $exception: 'An error was shown',
    'survey sent': 'Answered a survey',
}

/** A short, readable name for an action: "Clicked "Approve"", "Opened /invoices", "Invoice searched". */
export function actionLabel(event: string, etype: string, chain: string, screen: string): string {
    if (event === '$pageview') return screen ? `Opened ${screen}` : NAMED.$pageview
    if (event === '$autocapture') {
        const verb = etype === 'change' ? 'Changed' : etype === 'submit' ? 'Submitted' : 'Clicked'
        const first = chain.split(';')[0] || ''
        let text = /(?:^|:)text="((?:[^"\\]|\\.)*)"/.exec(first)?.[1]?.replace(/\\"/g, '"').trim()
        if (text && text.length > 40) text = text.slice(0, 39) + '…'
        if (text) return `${verb} "${text}"`
        const tag = /^([a-z0-9]+)/i.exec(first)?.[1]?.toLowerCase()
        const what = tag === 'input' || tag === 'textarea' ? 'a field' : tag === 'select' ? 'a list' : tag === 'a' ? 'a link' : tag === 'button' ? 'a button' : 'something'
        return `${verb} ${what}`
    }
    if (NAMED[event]) return NAMED[event]
    const plain = event.replace(/^\$/, '').replace(/[_.-]+/g, ' ').trim()
    return plain ? plain[0].toUpperCase() + plain.slice(1) : event
}

export interface PersonAction {
    t: string
    label: string
    screen: string
    session_id: string
    gap_s: number // seconds until the next action in the same session, rounded
    last: boolean // the session's last action (a gap of 0 s can also be two actions in the same second)
}

export interface PersonDay {
    user: string
    client_id: string
    client_name: string
    day: string
    tz: string
    gap_s: number
    totals: Time & { sessions: number; actions: number; first?: string; last?: string; longest_pause_s: number }
    sessions: (SessionRow & { recording_start?: string })[]
    actions: PersonAction[]
    truncated: boolean // more actions than `limit`: the list and the ticks stop there, the totals do not
}

/** One person's day: their sessions with time in the app, active and idle, every action in order,
 * and when each session's recording starts (from the replay index: timestamps only), so a moment
 * can be turned into a clip. */
export async function personDay(q: PresenceQuery & { user: string }, settings = presenceSettings(), run: Run = hogql, limit = 5000): Promise<PersonDay> {
    const v = values(q, settings)
    const [rows, sessions] = await Promise.all([
        run(`SELECT ts, sid, client, client_name, event, etype, chain, screen, gap FROM (${timedEvents(q, true)}) ORDER BY ts LIMIT {limit}`, { ...v, limit: limit + 1 }),
        presenceSessions(q, settings, 1000, run),
    ])
    const ids = sessions.map((x) => x.session_id).filter(Boolean)
    const recs = ids.length
        ? await run(
              `SELECT session_id, min(min_first_timestamp) AS start FROM raw_session_replay_events
               WHERE session_id IN {ids} GROUP BY session_id LIMIT 1000`,
              { ids }
          )
        : []
    const recStart = new Map(recs.map((r) => [String(r.session_id), iso(r.start)!]))
    const truncated = rows.length > limit
    const endOf = new Map(sessions.map((x) => [x.session_id, x.end]))
    const actions: PersonAction[] = rows.slice(0, limit).map((r) => ({
        t: iso(r.ts)!,
        label: actionLabel(String(r.event), String(r.etype || ''), String(r.chain || ''), String(r.screen || '')),
        screen: String(r.screen || ''),
        session_id: String(r.sid),
        gap_s: Math.round(Number(r.gap || 0) / 1000),
        last: Number(r.gap || 0) === 0 && iso(r.ts) === endOf.get(String(r.sid)),
    }))
    const sum = (k: 'open_s' | 'active_s' | 'idle_s') => sessions.reduce((a, x) => a + x[k], 0)
    const ordered = [...sessions].sort((a, b) => a.start.localeCompare(b.start))
    const first = rows[0] || {}
    return {
        user: q.user,
        client_id: String(first.client || q.client || ordered[0]?.client_id || ''),
        client_name: String(first.client_name || ordered[0]?.client_name || q.client || ''),
        day: q.from,
        tz: q.tz,
        gap_s: q.gap_s,
        totals: {
            sessions: sessions.length,
            actions: sessions.reduce((a, x) => a + x.actions, 0),
            first: ordered[0]?.start,
            last: ordered.reduce<string | undefined>((a, x) => (!a || x.end > a ? x.end : a), undefined),
            longest_pause_s: actions.reduce((a, x) => Math.max(a, x.gap_s), 0),
            open_s: sum('open_s'),
            active_s: sum('active_s'),
            idle_s: sum('idle_s'),
        },
        sessions: ordered.map((x) => (recStart.has(x.session_id) ? { ...x, recording_start: recStart.get(x.session_id) } : x)),
        actions,
        truncated,
    }
}
