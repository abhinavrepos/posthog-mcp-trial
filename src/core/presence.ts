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
import { hogql, isTruncated, markPartial, type Completeness, type Row } from './posthog.ts'

type Run = typeof hogql
import { P } from './props.ts'
import { userExpr } from './identity.ts'
import { appEvents } from './appevents.ts'

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
const USER = () => `coalesce(nullIf(toString(${P.email}), ''), ${userExpr()})`

/** Every action in the range, with the time until the next action in its session (`gap`, ms).
 * `detail` adds what each action was (event, screen, element), for one person's timeline. */
export function timedEvents(q: PresenceQuery, detail = false, options: { names?: boolean; users?: boolean; sessions?: boolean } = {}): string {
    const name = options.names === false ? '' : `, toString(${P.clientName}) AS client_name`
    const nameColumn = options.names === false ? '' : ', client_name'
    const more = detail ? ', event, etype, chain, screen' : ''
    const moreInner = detail
        ? `, event, toString(properties.$event_type) AS etype, if(event = '$autocapture', elements_chain, '') AS chain, coalesce(nullIf(toString(properties.${appEvents()?.properties.dialogName?.name || '$pathname'}), ''), toString(properties.$pathname)) AS screen`
        : ''
    // Earlier actions cannot affect a forward gap. Start at local midnight, keeping the original
    // following-day margin for the next action across midnight; the outer WHERE keeps the range.
    return `SELECT client${nameColumn}, user, sid, ts, day, hour, gap${more} FROM (
        SELECT toString(${P.client}) AS client${name}, ${USER()} AS user,
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
    truncated?: boolean // a query or a breakdown reached its row limit
    warning?: string
    totals: Time & { clients: number; people: number; sessions: number; actions: number }
    days: (Time & { day: string; clients: number; people: number; sessions: number })[]
    hours: (Time & { day: string; hour: number; people: number })[]
    clients: (Time & { client_id: string; client_name: string; people: number; sessions: number; first: string; last: string })[]
    people?: (Time & { user: string; sessions: number; first: string; last: string })[]
}

// All distinct counts and millisecond sums stay in PostHog. Each response is bounded below
// PostHog's 50,000-row cap; separate aggregates are supported by HogQL without CTE reuse.
// Longer than a week (including every year chunk): PostHog itself stops a query at 60 s, so a slow server
// must not be cut off earlier by our default 30 s.
const readOptions = (q: PresenceQuery) => (Date.parse(q.to) - Date.parse(q.from)) / DAY + 1 > 7 ? { timeoutMs: 300_000 } : {}
const counts = (r: Row) => ({ clients: Number(r.clients || 0), people: Number(r.people || 0), sessions: Number(r.sessions || 0) })

/** The client picker covers every client, even with filters. Round only after SQL sums. */
export async function presenceReport(q: PresenceQuery, settings = presenceSettings(), run: Run = hogql): Promise<PresenceReport> {
    return spanDays(q) > CHUNK_DAYS ? longReport(q, settings, run) : rangeReport(q, settings, run)
}

const CHUNK_DAYS = 31
// Finished chunks (ending before yesterday in UTC) do not change: keep them 6 h so a repeated year view
// only recomputes the current month and the distinct pass. Bounded to a few years of chunks.
const chunkCache = new Map<string, { at: number; value: Promise<PresenceReport> }>()
const CHUNK_TTL_MS = 6 * 3600_000
function cachedChunk(q: PresenceQuery, settings: PresenceSettings, run: Run): Promise<PresenceReport> {
    const done = q.to < new Date(Date.now() - DAY).toISOString().slice(0, 10)
    if (!done || run !== hogql) return rangeReport(q, settings, run)
    const key = JSON.stringify([q, settings.ignore_events])
    const hit = chunkCache.get(key)
    if (hit && Date.now() - hit.at < CHUNK_TTL_MS) return hit.value
    const value = rangeReport(q, settings, run)
    value.catch(() => chunkCache.delete(key))
    chunkCache.set(key, { at: Date.now(), value })
    if (chunkCache.size > 100) chunkCache.delete(chunkCache.keys().next().value!)
    return value
}
const spanDays = (q: PresenceQuery) => Math.round((Date.parse(q.to) - Date.parse(q.from)) / DAY) + 1
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10)

/** Long ranges: PostHog stops one query at 60 s and a memory limit, so a year runs as month-sized exact
 * chunks (time and actions add up exactly; days never overlap) plus one cheap distinct-count pass over the
 * whole range for sessions, people and clients, which cannot be added across chunks. */
async function longReport(q: PresenceQuery, settings: PresenceSettings, run: Run): Promise<PresenceReport> {
    const chunks: PresenceQuery[] = []
    for (let from = q.from; from <= q.to; from = addDays(from, CHUNK_DAYS)) {
        const to = addDays(from, CHUNK_DAYS - 1)
        chunks.push({ ...q, from, to: to < q.to ? to : q.to })
    }
    const parts: PresenceReport[] = new Array(chunks.length)
    let next = 0
    // Two at a time: PostHog refuses more concurrent heavy queries per project (429).
    await Promise.all([0, 1].map(async () => { while (next < chunks.length) { const i = next++; parts[i] = await cachedChunk(chunks[i]!, settings, run) } }))
    const v = values(q, settings)
    // Users come from the distinct id here: the person-email join makes a year-wide pass exceed PostHog's 60 s cap.
    const distinct = await run(
        `SELECT c, u, uniqExactIf(client, keep) AS clients, uniqExactIf(tuple(client, user), keep) AS people, uniqExactIf(sid, keep) AS sessions,
                uniqExact(tuple(client, user)) AS all_people, uniqExact(sid) AS all_sessions
         FROM (SELECT toString(${P.client}) AS client, ${userExpr()} AS user, toString(properties.$session_id) AS sid, client AS c, concat('u:', user) AS u,
                      ${q.client ? 'client = {client}' : '1'} AND ${q.user ? 'user = {user}' : '1'} AS keep
               FROM events
               WHERE timestamp >= toDateTime({from}, {tz}) AND timestamp < toDateTime({to}, {tz}) + toIntervalDay(1)
                 AND notEmpty(toString(${P.client})) AND notEmpty(toString(properties.$session_id)) AND event NOT IN {ignore})
         GROUP BY GROUPING SETS ((), (c), (u)) LIMIT 20000`, v, readOptions(q))
    const dTotal = distinct.find((r) => !r.c && !r.u) || {}
    const dClient = new Map(distinct.filter((r) => r.c).map((r) => [String(r.c), r]))
    const dUser = new Map(distinct.filter((r) => r.u).map((r) => [String(r.u).slice(2), r]))
    const sum = <T extends Time>(xs: T[]) => xs.reduce((a, x) => ({ open_s: a.open_s + x.open_s, active_s: a.active_s + x.active_s, idle_s: a.idle_s + x.idle_s }), { open_s: 0, active_s: 0, idle_s: 0 })
    const clients = new Map<string, PresenceReport['clients'][number]>()
    for (const c of parts.flatMap((p) => p.clients)) {
        const prev = clients.get(c.client_id)
        if (!prev) { clients.set(c.client_id, { ...c }); continue }
        Object.assign(prev, sum([prev, c]), { first: c.first < prev.first ? c.first : prev.first, last: c.last > prev.last ? c.last : prev.last, client_name: c.last > prev.last ? c.client_name : prev.client_name })
    }
    const people = new Map<string, NonNullable<PresenceReport['people']>[number]>()
    for (const u of parts.flatMap((p) => p.people || [])) {
        const prev = people.get(u.user)
        if (!prev) { people.set(u.user, { ...u }); continue }
        Object.assign(prev, sum([prev, u]), { first: u.first < prev.first ? u.first : prev.first, last: u.last > prev.last ? u.last : prev.last })
    }
    const byOpen = (a: Time, b: Time) => b.open_s - a.open_s
    return markPartial({
        query: q,
        totals: { clients: Number(dTotal.clients || 0), people: Number(dTotal.people || 0), sessions: Number(dTotal.sessions || 0),
            actions: parts.reduce((a, p) => a + p.totals.actions, 0), ...sum(parts.map((p) => p.totals)) },
        days: parts.flatMap((p) => p.days),
        hours: parts.flatMap((p) => p.hours),
        clients: [...clients.values()].map((c) => ({ ...c, people: Number(dClient.get(c.client_id)?.all_people || 0), sessions: Number(dClient.get(c.client_id)?.all_sessions || 0) })).sort(byOpen).slice(0, 2000),
        people: q.client ? [...people.values()].map((u) => ({ ...u, sessions: Number(dUser.get(u.user)?.sessions || 0) })).sort(byOpen).slice(0, 2000) : undefined,
    }, parts.some((p) => p.truncated) || isTruncated(distinct) || distinct.length >= 20000)
}

async function rangeReport(q: PresenceQuery, settings: PresenceSettings, run: Run): Promise<PresenceReport> {
    const v = values(q, settings), options = readOptions(q)
    // ONE pass over the range: GROUPING SETS give totals, days, day×hour, clients and (with a client) people.
    // Parallel per-breakdown queries each re-ran the window over a year and PostHog refused them (429).
    // Key columns are strings or hour+1, so an empty value means "not grouped by this key".
    // `keep` applies the client/user selection; the client picker (c rows) always covers every client.
    const sets = '(), (d), (d, h1), (c), (u)'
    const rows = await run(
        `SELECT d, h1, c, u,
                uniqExactIf(client, keep) AS clients, uniqExactIf(tuple(client, user), keep) AS people, uniqExactIf(sid, keep) AS sessions,
                countIf(keep) AS actions, sumIf(gap, keep) AS open_ms, sumIf(least(gap, {gap_ms}), keep) AS active_ms, minIf(ts, keep) AS first, maxIf(ts, keep) AS last,
                uniqExact(tuple(client, user)) AS all_people, uniqExact(sid) AS all_sessions, sum(gap) AS all_open_ms, sum(least(gap, {gap_ms})) AS all_active_ms,
                min(ts) AS all_first, max(ts) AS all_last, argMax(client_name, ts) AS client_name
         FROM (SELECT *, toString(day) AS d, hour + 1 AS h1, client AS c, concat('u:', user) AS u,
                      ${q.client ? 'client = {client}' : '1'} AND ${q.user ? 'user = {user}' : '1'} AS keep
               FROM (${timedEvents({ ...q, client: undefined, user: undefined })}))
         GROUP BY GROUPING SETS (${sets}) LIMIT 20000`, v, options)
    const key = (r: Row) => [r.d ? 'd' : '', Number(r.h1) ? 'h' : '', r.c ? 'c' : '', r.u ? 'u' : ''].join('')
    const of = (k: string) => rows.filter((r) => key(r) === k)
    const all = (r: Row) => ({ open_ms: r.all_open_ms, active_ms: r.all_active_ms })
    const total = of('')[0] || {}
    const days = of('d').filter((r) => Number(r.actions) > 0).sort((x, y) => String(x.d).localeCompare(String(y.d)))
    const hours = of('dh').filter((r) => Number(r.actions) > 0).sort((x, y) => String(x.d).localeCompare(String(y.d)) || Number(x.h1) - Number(y.h1))
    const clients = of('c').sort((x, y) => Number(y.all_open_ms) - Number(x.all_open_ms) || String(x.c).localeCompare(String(y.c))).slice(0, 2000)
    const people = of('u').filter((r) => Number(r.actions) > 0).sort((x, y) => Number(y.open_ms) - Number(x.open_ms) || String(x.u).localeCompare(String(y.u))).slice(0, 2000)
    return markPartial({
        query: q,
        totals: { ...counts(total), actions: Number(total.actions || 0), ...time(total) },
        days: days.map(r => ({ day: String(r.d), ...counts(r), ...time(r) })),
        hours: hours.map(r => ({ day: String(r.d), hour: Number(r.h1) - 1, people: Number(r.people || 0), ...time(r) })),
        clients: clients.map(r => ({ client_id: String(r.c), client_name: String(r.client_name || r.c),
            people: Number(r.all_people || 0), sessions: Number(r.all_sessions || 0), first: iso(r.all_first)!, last: iso(r.all_last)!, ...time(all(r)) })),
        people: q.client ? people.map(r => ({ user: String(r.u).slice(2), sessions: Number(r.sessions || 0), first: iso(r.first)!, last: iso(r.last)!, ...time(r) })) : undefined,
    }, isTruncated(rows) || rows.length >= 20000)
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
export async function presenceSessions(q: PresenceQuery, settings = presenceSettings(), limit = 1000, run: Run = hogql): Promise<SessionRow[] & Completeness> {
    const v = values(q, settings)
    // No display strings through the window sort; names are looked up for the few clients found.
    const rows = await run(
        `SELECT sid, any(user) AS user, any(client) AS client, min(ts) AS start, max(ts) AS end, count() AS actions, ${TIME}
         FROM (${timedEvents(q, false, { names: false })}) GROUP BY sid ORDER BY start DESC LIMIT {limit}`,
        { ...v, limit: limit + 1 }, readOptions(q)
    )
    const clientIds = [...new Set(rows.map((r) => String(r.client)))]
    const names = clientIds.length
        ? await run(
              `SELECT toString(${P.client}) AS client, argMax(toString(${P.clientName}), timestamp) AS client_name
               FROM events WHERE timestamp >= toDateTime({from}, {tz}) AND timestamp < toDateTime({to}, {tz}) + toIntervalDay(1)
                 AND client IN {clients} AND notEmpty(toString(properties.$session_id)) AND event NOT IN {ignore}
               GROUP BY client LIMIT 2000`,
              { ...v, clients: clientIds }, readOptions(q)
          )
        : []
    const nameOf = new Map(names.map((r) => [String(r.client), String(r.client_name || '')]))
    return markPartial(rows.slice(0, limit).map((r) => ({
        session_id: String(r.sid),
        user: String(r.user),
        client_id: String(r.client),
        client_name: nameOf.get(String(r.client)) || String(r.client),
        start: iso(r.start)!,
        end: iso(r.end)!,
        actions: Number(r.actions),
        ...time(r),
    })), isTruncated(rows) || isTruncated(names) || rows.length > limit)
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
        `SELECT toString(${P.client}) AS client, argMax(toString(${P.clientName}), timestamp) AS client_name, ${USER()} AS user,
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
    warning?: string
    truncated: boolean // action, session, or recording lookup reached a row limit
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
        ? await run(`SELECT ts, sid, client, event, etype, chain, screen, gap FROM (${timedEvents(q, true, { names: false, sessions: true })}) ORDER BY ts LIMIT {limit}`, { ...v, limit: limit + 1, sids: ids }, readOptions(q))
        : []
    const recs = ids.length
        ? await run(
              `SELECT session_id, min(min_first_timestamp) AS start FROM raw_session_replay_events
               WHERE session_id IN {ids} GROUP BY session_id LIMIT 1000`,
              { ids }, readOptions(q)
          )
        : []
    const recStart = new Map(recs.map((r) => [String(r.session_id), iso(r.start)!]))
    const truncated = rows.length > limit || isTruncated(rows) || !!sessions.truncated || isTruncated(recs)
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
        ...markPartial({}, truncated),
        truncated,
    }
}
