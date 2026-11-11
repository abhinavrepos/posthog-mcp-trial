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
export function timedEvents(q: PresenceQuery, detail = false, options: { names?: boolean; users?: boolean; sessions?: boolean } = {}): string {
    const name = options.names === false ? '' : `, toString(${P.clientName}) AS client_name`
    const nameColumn = options.names === false ? '' : ', client_name'
    const more = detail ? ', event, etype, chain, screen' : ''
    const moreInner = detail
        ? `, event, toString(properties.$event_type) AS etype, if(event = '$autocapture', elements_chain, '') AS chain, toString(properties.$pathname) AS screen`
        : ''
    // Earlier actions cannot affect a forward gap. Start at local midnight, keeping the original
    // following-day margin for the next action across midnight; the outer WHERE keeps the range.
    return `SELECT client${nameColumn}, user, sid, ts, day, hour, gap${more} FROM (
        SELECT toString(${P.client}) AS client${name}, ${USER} AS user,
               toString(properties.$session_id) AS sid, timestamp AS ts${moreInner},
               toDate(toTimeZone(timestamp, {tz})) AS day, toHour(toTimeZone(timestamp, {tz})) AS hour,
               least(greatest(dateDiff('millisecond', timestamp,
                   leadInFrame(timestamp, 1, timestamp) OVER (PARTITION BY properties.$session_id ORDER BY timestamp ASC ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING)), 0), ${SESSION_TIMEOUT_MS}) AS gap
        FROM events
        WHERE timestamp >= toDateTime({from}, {tz}) AND timestamp < toDateTime({to}) + toIntervalDay(2)
          AND notEmpty(toString(${P.client})) AND notEmpty(toString(properties.$session_id))
          AND event NOT IN {ignore}${q.client ? ' AND client = {client}' : ''}${q.user ? ' AND user = {user}' : ''}${options.users ? ' AND user IN {users}' : ''}${options.sessions ? ' AND toString(properties.$session_id) IN {sids}' : ''}
    ) WHERE day >= toDate({from}) AND day <= toDate({to})`
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
    truncated?: boolean // the report covers only the first grouped rows when the safety limit is reached
    warning?: string
    totals: Time & { clients: number; people: number; sessions: number; actions: number }
    days: (Time & { day: string; clients: number; people: number; sessions: number })[]
    hours: (Time & { day: string; hour: number; people: number })[]
    clients: (Time & { client_id: string; client_name: string; people: number; sessions: number; first: string; last: string })[]
    people?: (Time & { user: string; sessions: number; first: string; last: string })[]
}

// One row per session/hour keeps exact distinct counts without returning individual actions.
const REPORT_ROW_LIMIT = 200_000

type Bucket = {
    open_ms: number; active_ms: number; actions: number
    clients: Set<string>; people: Set<string>; sessions: Set<string>
    first: string; last: string
}
const bucket = (): Bucket => ({ open_ms: 0, active_ms: 0, actions: 0, clients: new Set(), people: new Set(), sessions: new Set(), first: '', last: '' })
function add(b: Bucket, r: Row) {
    b.open_ms += Number(r.open_ms || 0)
    b.active_ms += Number(r.active_ms || 0)
    b.actions += Number(r.actions || 0)
    b.clients.add(String(r.client))
    b.people.add(String(r.user))
    b.sessions.add(String(r.sid))
    const first = iso(r.first)!, last = iso(r.last)!
    if (!b.first || first < b.first) b.first = first
    if (!b.last || last > b.last) b.last = last
}
function at(map: Map<string, Bucket>, key: string): Bucket {
    let b = map.get(key)
    if (!b) map.set(key, b = bucket())
    return b
}

/** One window for the whole range. The client picker covers every client, even with filters. */
export async function presenceReport(q: PresenceQuery, settings = presenceSettings(), run: Run = hogql): Promise<PresenceReport> {
    const v = values(q, settings)
    const all = timedEvents({ ...q, client: undefined, user: undefined }, false, { names: false })
    const rows = await run(
        `SELECT client, user, sid, toString(day) AS day, hour, count() AS actions, min(ts) AS first, max(ts) AS last, ${TIME}
         FROM (${all}) GROUP BY client, user, sid, day, hour ORDER BY day, hour, client, user, sid LIMIT ${REPORT_ROW_LIMIT + 1}`, v)
    // Look up names after aggregation: no display strings pass through the window sort.
    const clientIds = [...new Set(rows.slice(0, REPORT_ROW_LIMIT).map((r) => String(r.client)))]
    const names = clientIds.length ? await run(
        `SELECT toString(${P.client}) AS client, argMax(toString(${P.clientName}), timestamp) AS client_name
         FROM events WHERE timestamp >= toDateTime({from}, {tz})
           AND timestamp < toDateTime({to}, {tz}) + toIntervalDay(1)
           AND client IN {clients} AND notEmpty(toString(properties.$session_id)) AND event NOT IN {ignore}
         GROUP BY client LIMIT ${REPORT_ROW_LIMIT}`, { ...v, clients: clientIds }) : []
    const nameOf = new Map(names.map((r) => [String(r.client), String(r.client_name || r.client)]))
    const total = bucket()
    const days = new Map<string, Bucket>(), hours = new Map<string, Bucket>()
    const clients = new Map<string, Bucket>(), people = new Map<string, Bucket>()
    for (const r of rows.slice(0, REPORT_ROW_LIMIT)) {
        add(at(clients, String(r.client)), r)
        if ((q.client && r.client !== q.client) || (q.user && r.user !== q.user)) continue
        add(total, r)
        add(at(days, String(r.day)), r)
        add(at(hours, JSON.stringify([String(r.day), Number(r.hour)])), r)
        if (q.client) add(at(people, String(r.user)), r)
    }
    const counts = (b: Bucket) => ({ clients: b.clients.size, people: b.people.size, sessions: b.sessions.size })
    // Round only after summing milliseconds, matching the former SQL aggregates.
    const duration = (b: Bucket) => time({ open_ms: b.open_ms, active_ms: b.active_ms })
    const byTime = ([, a]: [string, Bucket], [, b]: [string, Bucket]) => b.open_ms - a.open_ms
    return {
        query: q,
        ...(rows.length > REPORT_ROW_LIMIT ? { truncated: true, warning: 'Report is partial. Pick a shorter date range.' } : {}),
        totals: { ...counts(total), actions: total.actions, ...duration(total) },
        days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => ({ day, ...counts(b), ...duration(b) })),
        hours: [...hours].map(([key, b]) => {
            const [day, hour] = JSON.parse(key) as [string, number]
            return { day, hour, people: b.people.size, ...duration(b) }
        }).sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour),
        clients: [...clients].sort(byTime).slice(0, 2000).map(([client, b]) => ({
            client_id: client, client_name: nameOf.get(client) || client, people: b.people.size,
            sessions: b.sessions.size, first: b.first, last: b.last, ...duration(b),
        })),
        people: q.client ? [...people].sort(byTime).slice(0, 2000).map(([user, b]) => ({
            user, sessions: b.sessions.size, first: b.first, last: b.last, ...duration(b),
        })) : undefined,
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
    const v = values(q, settings)
    // No display strings through the window sort; names are looked up for the few clients found.
    const rows = await run(
        `SELECT sid, any(user) AS user, any(client) AS client, min(ts) AS start, max(ts) AS end, count() AS actions, ${TIME}
         FROM (${timedEvents(q, false, { names: false })}) GROUP BY sid ORDER BY start DESC LIMIT {limit}`,
        { ...v, limit }
    )
    const clientIds = [...new Set(rows.map((r) => String(r.client)))]
    const names = clientIds.length
        ? await run(
              `SELECT toString(${P.client}) AS client, argMax(toString(${P.clientName}), timestamp) AS client_name
               FROM events WHERE timestamp >= toDateTime({from}, {tz}) AND timestamp < toDateTime({to}, {tz}) + toIntervalDay(1)
                 AND client IN {clients} AND notEmpty(toString(properties.$session_id)) AND event NOT IN {ignore}
               GROUP BY client LIMIT 2000`,
              { ...v, clients: clientIds }
          )
        : []
    const nameOf = new Map(names.map((r) => [String(r.client), String(r.client_name || '')]))
    return rows.map((r) => ({
        session_id: String(r.sid),
        user: String(r.user),
        client_id: String(r.client),
        client_name: nameOf.get(String(r.client)) || String(r.client),
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
        run(`SELECT client, user, min(ts) AS first, ${TIME} FROM (${timedEvents(q, false, { names: false, users: true })}) GROUP BY client, user LIMIT 1000`, { ...values(q, settings), users }),
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
    // Sessions first (light), then the actions of only those sessions, one query at a time: the
    // detailed columns (element chains) never pass through the window for anyone else.
    const sessions = await presenceSessions(q, settings, 1000, run)
    const ids = sessions.map((x) => x.session_id).filter(Boolean)
    const rows = ids.length
        ? await run(`SELECT ts, sid, client, event, etype, chain, screen, gap FROM (${timedEvents(q, true, { names: false, sessions: true })}) ORDER BY ts LIMIT {limit}`, { ...v, limit: limit + 1, sids: ids })
        : []
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
        client_name: String(ordered[0]?.client_name || q.client || ''),
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
