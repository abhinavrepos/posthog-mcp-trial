// The release dashboard's engine: Jira releases and their tickets, matched to PostHog usage.
//
//   sync     reads the last N released versions from Jira (default 12) and their tickets, links
//            each ticket to the part of the product it changed (a screen, and a PostHog event when
//            one fits), then computes each release's numbers from PostHog into release_snapshots.
//   view     turns stored numbers into scores, rankings and insights for a release, a quarter, a
//            custom group or all kept releases. Weights come from the caller, so changing them
//            needs no PostHog queries.
//
// How a ticket is linked (first match wins, and a person can always change it):
//   1. a link someone set on the dashboard
//   2. its Jira component, through the component map in the settings (or a screen of that name)
//   3. words in the ticket that name a screen
//   plus a PostHog event: one whose name shares words with the ticket title and that first
//   appeared within three weeks of the release. That is what a new feature looks like.
//
// What "after" means: from the release date to the next release, at most window_days. "Before"
// is the same number of days before the release. Errors, rage clicks and support tickets are
// counted per screen and given to the tickets that changed how that screen already worked
// (tickets linked to the screen without an event of their own); if every ticket on the screen
// added an event, they share it. A person can switch this per ticket.
import { adfToText } from '../jira/adf.ts'
import { getVersions, jqlString, searchIssues, type JiraIssue } from '../jira/client.ts'
import { SCREENS } from './catalog.ts'
import { all, getSetting, one, run, setSetting, tx } from './db.ts'
import { hogql, issueUrl } from './posthog.ts'
import { resolveScreen } from './resolve.ts'
import { stem, tokens } from './text.ts'

const DAY = 86_400_000

// ------------------------------------------------------------------ settings
export interface Weights {
    reach: number
    adoption: number
    fixes: number
    errors: number
    friction: number
    support: number
}

export interface ReleaseSettings {
    jira_project: string
    support_jql: string // the support tickets to count, e.g. RCI and MMT Risk
    keep: number // releases kept
    window_days: number // longest "after" window
    fiscal_start_month: number // 1 = calendar quarters
    ticket_types: string[] // types that are ranked
    client_property: string // the event property that names the client
    version_property: string // the event property with the release name, or '' to use dates only
    component_screens: Record<string, string> // Jira component → screen path
    screen_reach_factor: number // how much a whole-screen link counts for reach (0..1)
    weights: Weights
}

export const DEFAULT_SETTINGS: ReleaseSettings = {
    jira_project: process.env.RELEASES_JIRA_PROJECT || 'ACP',
    support_jql: process.env.RELEASES_SUPPORT_JQL || 'project = SUP AND issuetype in ("RCI", "MMT Risk")',
    keep: 12,
    window_days: 30,
    fiscal_start_month: 1,
    ticket_types: ['Story', 'Bug', 'Improvement'],
    client_property: 'client_id',
    version_property: 'app_version',
    component_screens: {},
    screen_reach_factor: 0.5,
    weights: { reach: 3, adoption: 2, fixes: 2, errors: 3, friction: 1, support: 2 },
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

export function releaseSettings(): ReleaseSettings {
    const s = { ...DEFAULT_SETTINGS, ...getSetting<Partial<ReleaseSettings>>('releases', {}) }
    s.weights = { ...DEFAULT_SETTINGS.weights, ...s.weights }
    return s
}

/** Checks and stores settings. Throws a message fit for the person on a bad value. */
export function saveReleaseSettings(change: Partial<ReleaseSettings>): ReleaseSettings {
    const s = { ...releaseSettings(), ...change }
    s.weights = { ...releaseSettings().weights, ...(change.weights || {}) }
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(s.jira_project)) throw new Error('The Jira project key looks wrong (for example ACP).')
    if (!Number.isInteger(s.keep) || s.keep < 1 || s.keep > 52) throw new Error('Keep between 1 and 52 releases.')
    if (!Number.isInteger(s.window_days) || s.window_days < 7 || s.window_days > 120) throw new Error('The window must be 7 to 120 days.')
    if (!Number.isInteger(s.fiscal_start_month) || s.fiscal_start_month < 1 || s.fiscal_start_month > 12) throw new Error('Pick a month for the year start.')
    if (!IDENT.test(s.client_property)) throw new Error('The client property must be a plain property name.')
    if (s.version_property && !IDENT.test(s.version_property)) throw new Error('The version property must be a plain property name, or empty.')
    if (!Array.isArray(s.ticket_types) || !s.ticket_types.length) throw new Error('Rank at least one ticket type.')
    if (!(s.screen_reach_factor >= 0 && s.screen_reach_factor <= 1)) throw new Error('Screen reach must be between 0 and 1.')
    for (const [k, v] of Object.entries(s.weights)) if (!(Number(v) >= 0 && Number(v) <= 10)) throw new Error(`The ${k} weight must be 0 to 10.`)
    for (const [k, v] of Object.entries(s.component_screens)) if (!k.trim() || !String(v).startsWith('/')) throw new Error('Map each component to a screen path that starts with /.')
    if (/;|\b(delete|update|insert)\b/i.test(s.support_jql)) throw new Error('The support JQL should only filter issues.')
    setSetting('releases', s)
    return s
}

// ------------------------------------------------------------------ linking tickets to PostHog
export interface Link {
    screen?: string
    event?: string
    risk?: boolean // count screen problems (errors, rage clicks, support tickets) for this ticket
}
export interface AutoLink extends Link {
    source: 'component' | 'text' | 'event' | 'none'
    confidence: number
    reason: string
}
export interface Areas {
    screens: { path: string; name: string; views: number }[]
    events: { name: string; first_seen: string; path: string; count: number }[]
}

const screenName = (path: string) => SCREENS.find((s) => s.path === path)?.name || path

/** Event name words, stemmed, e.g. invoice_bulk_sent → invoice, bulk, sent. */
const eventWords = (name: string) => (name.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2).map(stem)
/** Same word, allowing for endings: export/exported, approval/approved, customise/customized. */
export function sameWord(a: string, b: string): boolean {
    if (a === b) return true
    const short = Math.min(a.length, b.length)
    if (short < 4) return false
    let common = 0
    while (common < short && a[common] === b[common]) common++
    return common === short || common >= Math.max(5, short - 2)
}

/** Works out which screen and event a ticket changed. Pure, so it is unit-tested. */
export function autoLink(
    ticket: { summary: string; description?: string; components: string[]; labels?: string[]; type?: string },
    releaseDate: string,
    areas: Areas,
    componentScreens: Record<string, string> = {}
): AutoLink {
    const knownScreens = [...SCREENS, ...areas.screens.filter((a) => !SCREENS.some((s) => s.path === a.path)).map((a) => ({ path: a.path, name: a.name, aliases: [] }))]
    let link: AutoLink = { source: 'none', confidence: 0, reason: 'The ticket names no screen or event.' }

    for (const comp of ticket.components) {
        const mapped = componentScreens[comp] || resolveScreen(comp, knownScreens).find((m) => m.confidence >= 0.6)?.path
        if (mapped) {
            link = { screen: mapped, source: 'component', confidence: 0.9, reason: `Jira component "${comp}"` }
            break
        }
    }
    if (!link.screen) {
        const m = resolveScreen(`${ticket.summary}\n${ticket.description || ''}`, knownScreens)[0]
        if (m && m.confidence >= 0.6) link = { screen: m.path, source: 'text', confidence: Math.round(m.confidence * 0.85 * 100) / 100, reason: `the ticket mentions ${m.name}` }
    }

    const words = tokens(ticket.summary)
    const released = Date.parse(releaseDate)
    // Words that only name the screen ("revenue", "invoice") say little about which feature it is.
    const screenWords = new Set(knownScreens.flatMap((x) => tokens(`${x.name} ${x.path.replace(/\//g, ' ')}`)))
    // Bugs fix what is there and tasks are internal, so an event that is new with the release is
    // no evidence for them.
    const isNewWork = ticket.type !== 'Bug' && ticket.type !== 'Task'
    let best: { name: string; path: string; score: number; matched: string[]; days: number } | undefined
    for (const ev of areas.events) {
        const matched = eventWords(ev.name).filter((w) => words.some((t) => sameWord(t, w)))
        // At least one word must be about the feature, not just the screen it is on.
        if (!matched.some((w) => !screenWords.has(w))) continue
        const days = (Date.parse(ev.first_seen) - released) / DAY
        const near = days >= -3 && days <= 21
        const wordScore = matched.reduce((a, w) => a + (screenWords.has(w) ? 0.5 : 1), 0)
        const score = wordScore + (near && isNewWork ? 2 : days < -3 ? -1 : 0) + (link.screen && ev.path === link.screen ? 0.5 : 0)
        if (!best || score > best.score) best = { name: ev.name, path: ev.path, score, matched, days }
    }
    if (best && best.score >= 2.5) {
        const when = best.days < 0.5 ? 'on release day' : `${Math.round(best.days)} days after the release`
        link = {
            screen: link.screen || best.path,
            event: best.name,
            source: 'event',
            confidence: Math.min(1, Math.round((best.score / 4.5) * 100) / 100),
            reason: `event ${best.name} first appeared ${when} and matches "${best.matched.join('", "')}"${link.screen ? `; ${link.reason}` : ''}`,
        }
    }
    return link
}

// ------------------------------------------------------------------ PostHog reads
async function loadAreas(since: string): Promise<Areas> {
    const [screens, events] = await Promise.all([
        hogql(
            `SELECT toString(properties.$pathname) AS path, count() AS views FROM events
             WHERE event = '$pageview' AND timestamp > toDateTime({since}) AND notEmpty(path)
             GROUP BY path HAVING views >= 20 ORDER BY views DESC LIMIT 200`,
            { since }
        ),
        hogql(
            `SELECT event AS name, min(timestamp) AS first_seen, count() AS n, topK(1)(toString(properties.$pathname)) AS paths FROM events
             WHERE timestamp > toDateTime({since}) AND NOT startsWith(event, '$')
             GROUP BY name ORDER BY n DESC LIMIT 500`,
            { since }
        ),
    ])
    return {
        screens: screens.map((r) => ({ path: String(r.path), name: screenName(String(r.path)), views: Number(r.views) })),
        events: events.map((r) => ({ name: String(r.name), first_seen: new Date(String(r.first_seen).replace(' ', 'T') + (String(r.first_seen).endsWith('Z') ? '' : 'Z')).toISOString(), path: String((r.paths as string[])?.[0] || ''), count: Number(r.n) })),
    }
}

interface ErrorIssue {
    id: string
    type: string
    message: string
    first_seen: string
    occurrences: number
    clients: number
    path: string
    url?: string
}

const iso = (v: unknown) => {
    const s = String(v)
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z').toISOString()
}
const firstOf = (v: unknown): string => {
    try {
        const a = typeof v === 'string' ? JSON.parse(v) : v
        return Array.isArray(a) ? String(a[0] ?? '') : String(a ?? '')
    } catch {
        return String(v ?? '')
    }
}

async function loadErrors(since: string, cp: string): Promise<ErrorIssue[]> {
    const rows = await hogql(
        `SELECT coalesce(nullIf(toString(properties.$exception_issue_id), ''), concat(toString(properties.$exception_types), toString(properties.$exception_values))) AS id,
                any(toString(properties.$exception_types)) AS types, any(toString(properties.$exception_values)) AS vals,
                min(timestamp) AS first_seen, count() AS n, uniq(properties.${cp}) AS clients, topK(1)(toString(properties.$pathname)) AS paths
         FROM events WHERE event = '$exception' AND timestamp > toDateTime({since})
         GROUP BY id ORDER BY n DESC LIMIT 500`,
        { since }
    )
    return rows.map((r) => {
        const id = String(r.id)
        return {
            id,
            type: firstOf(r.types) || 'Error',
            message: firstOf(r.vals),
            first_seen: iso(r.first_seen),
            occurrences: Number(r.n),
            clients: Number(r.clients),
            path: String((r.paths as string[])?.[0] || ''),
            url: /^[0-9a-f-]{36}$/.test(id) ? issueUrl(id) : undefined,
        }
    })
}

interface SupportTicket {
    key: string
    type: string
    summary: string
    created: string
    screen?: string
}

async function loadSupport(jql: string, since: string): Promise<SupportTicket[]> {
    const issues = await searchIssues(`${jql} AND created >= ${jqlString(since.slice(0, 10))} ORDER BY created DESC`, ['summary', 'description', 'created', 'issuetype'], 2000)
    return issues.map((i) => {
        // The summary names the screen best; the description is a fallback, without the
        // "Client: …" line that would otherwise look like the Clients screen.
        const body = adfToText(i.fields.description as never).replace(/^\s*client\s*:.*$/gim, '')
        const m = [resolveScreen(i.fields.summary)[0], resolveScreen(body)[0]].find((x) => x && x.confidence >= 0.6)
        return { key: i.key, type: i.fields.issuetype?.name || '', summary: i.fields.summary, created: String(i.fields.created), screen: m && m.confidence >= 0.6 ? m.path : undefined }
    })
}

// ------------------------------------------------------------------ stored rows
interface ReleaseRow {
    name: string
    released_at: string
    description: string | null
    synced_at: string
}
interface TicketRow {
    key: string
    release: string
    type: string
    summary: string
    description: string | null
    status: string | null
    components: string
    labels: string
    auto_link: string | null
    link: string | null
    link_by: string | null
    link_at: string | null
    hidden: number
}

export const keptReleases = () => all<ReleaseRow>('SELECT * FROM releases ORDER BY released_at')
const ticketsOf = (release: string) => all<TicketRow>('SELECT * FROM release_tickets WHERE release = ? ORDER BY key', release)

// ------------------------------------------------------------------ snapshots
export interface Usage {
    after: number
    before: number
    users_after: number
    users_before: number
    clients_after: number
    clients_before: number
}
export interface ScreenStats {
    sessions_after: number
    sessions_before: number
    errors_after: number
    errors_before: number
    rage_after: number
    rage_before: number
    support: { key: string; summary: string; created: string; type: string }[]
}
export interface TicketStats {
    key: string
    type: string
    summary: string
    status: string | null
    components: string[]
    hidden: boolean
    link: Link | null
    link_source: 'person' | AutoLink['source']
    link_reason: string
    link_by?: string
    confidence: number
    risk_owner: boolean
    shares_screen_with: string[]
    usage: Usage | null
    weekly: { week: string; n: number; clients: number }[]
}
export interface Snapshot {
    release: string
    date: string
    description: string
    computed_at: string
    window: { before_start: string; after_start: string; after_end: string; days: number; open: boolean }
    totals: {
        clients_after: number
        clients_before: number
        users_after: number
        sessions_after: number
        sessions_before: number
        errors_after: number
        errors_before: number
        rage_after: number
        rage_before: number
        clients_on_version: number | null
    }
    adoption: { week: string; on: number; all: number }[]
    screens: Record<string, ScreenStats>
    new_errors: ErrorIssue[]
    tickets: TicketStats[]
}

const n = (v: unknown) => Number(v) || 0
const ts = (d: number) => new Date(d).toISOString().replace('T', ' ').slice(0, 19)

async function computeSnapshot(rel: ReleaseRow, next: ReleaseRow | undefined, ctx: { s: ReleaseSettings; errors: ErrorIssue[]; support: SupportTicket[] }): Promise<Snapshot> {
    const { s } = ctx
    const cp = `properties.${s.client_property}`
    const start = Date.parse(rel.released_at + 'T00:00:00Z')
    const now = Date.now()
    const end = Math.min(start + s.window_days * DAY, next ? Date.parse(next.released_at + 'T00:00:00Z') : Infinity, now)
    const days = Math.max(1, Math.round((end - start) / DAY))
    const before = start - (end - start)
    const values: Record<string, unknown> = { r: ts(start), b0: ts(before), a1: ts(end), name: rel.name }

    // Which tickets carry screen problems: by default the ones that changed a screen without
    // adding an event of their own; a link set by a person can say otherwise.
    const rows = ticketsOf(rel.name)
    const linked = rows.map((t) => {
        const auto = t.auto_link ? (JSON.parse(t.auto_link) as AutoLink) : undefined
        const own = t.link ? (JSON.parse(t.link) as Link) : undefined
        const link: Link | null = own || (auto && (auto.screen || auto.event) ? { screen: auto.screen, event: auto.event } : null)
        return { t, auto, own, link }
    })
    const ranked = (x: (typeof linked)[number]) => !x.t.hidden && s.ticket_types.includes(x.t.type)
    const owners = new Map<string, string[]>()
    for (const screen of new Set(linked.map((x) => x.link?.screen).filter(Boolean) as string[])) {
        const onScreen = linked.filter((x) => ranked(x) && x.link?.screen === screen)
        const explicit = onScreen.filter((x) => x.own?.risk !== undefined)
        const rest = onScreen.filter((x) => x.own?.risk === undefined)
        const changers = rest.filter((x) => !x.link?.event)
        const byDefault = changers.length ? changers : rest
        owners.set(screen, [...explicit.filter((x) => x.own!.risk).map((x) => x.t.key), ...byDefault.map((x) => x.t.key)])
    }

    const targets: Link[] = []
    const targetIndex = (l: Link) => {
        const i = targets.findIndex((x) => x.event === l.event && (l.event || x.screen === l.screen))
        if (i >= 0) return i
        targets.push(l)
        return targets.length - 1
    }
    for (const x of linked) if (x.link?.screen || x.link?.event) targetIndex(x.link)
    const screens = [...new Set(linked.map((x) => x.link?.screen).filter(Boolean) as string[])]

    const after = 'timestamp >= toDateTime({r})'
    const bef = 'timestamp < toDateTime({r})'
    const cols: string[] = [
        `uniqIf(${cp}, ${after}) AS clients_a`,
        `uniqIf(${cp}, ${bef}) AS clients_b`,
        `uniqIf(distinct_id, ${after}) AS users_a`,
        `uniqIf(properties.$session_id, ${after}) AS sessions_a`,
        `uniqIf(properties.$session_id, ${bef}) AS sessions_b`,
        `countIf(event = '$exception' AND ${after}) AS errors_a`,
        `countIf(event = '$exception' AND ${bef}) AS errors_b`,
        `countIf(event = '$rageclick' AND ${after}) AS rage_a`,
        `countIf(event = '$rageclick' AND ${bef}) AS rage_b`,
    ]
    if (s.version_property) cols.push(`uniqIf(${cp}, ${after} AND toString(properties.${s.version_property}) = {name}) AS on_version`)
    targets.forEach((tg, i) => {
        const c = tg.event ? `event = {e${i}}` : `(event = '$pageview' AND properties.$pathname = {p${i}})`
        if (tg.event) values[`e${i}`] = tg.event
        else values[`p${i}`] = tg.screen
        for (const [side, cond] of [['a', after], ['b', bef]] as const) {
            cols.push(`countIf(${c} AND ${cond}) AS t${i}_n_${side}`, `uniqIf(distinct_id, ${c} AND ${cond}) AS t${i}_u_${side}`, `uniqIf(${cp}, ${c} AND ${cond}) AS t${i}_c_${side}`)
        }
    })
    screens.forEach((path, j) => {
        values[`s${j}`] = path
        const on = `properties.$pathname = {s${j}}`
        for (const [side, cond] of [['a', after], ['b', bef]] as const) {
            cols.push(
                `uniqIf(properties.$session_id, event = '$pageview' AND ${on} AND ${cond}) AS s${j}_s_${side}`,
                `countIf(event = '$exception' AND ${on} AND ${cond}) AS s${j}_e_${side}`,
                `countIf(event = '$rageclick' AND ${on} AND ${cond}) AS s${j}_r_${side}`
            )
        }
    })
    const [agg] = await hogql(`SELECT ${cols.join(',\n')} FROM events WHERE timestamp >= toDateTime({b0}) AND timestamp < toDateTime({a1})`, values)

    // Weekly use of each target, over before and after.
    const weekly = new Map<number, { week: string; n: number; clients: number }[]>()
    if (targets.length) {
        const branches = targets.map((tg, i) => `${tg.event ? `event = {e${i}}` : `(event = '$pageview' AND properties.$pathname = {p${i}})`}, ${i}`).join(', ')
        const wrows = await hogql(
            `SELECT toStartOfWeek(timestamp, 1) AS week, multiIf(${branches}, -1) AS target, count() AS n, uniq(${cp}) AS clients FROM events
             WHERE timestamp >= toDateTime({b0}) AND timestamp < toDateTime({a1}) GROUP BY week, target HAVING target >= 0 ORDER BY week`,
            values
        )
        for (const r of wrows) {
            const i = n(r.target)
            if (!weekly.has(i)) weekly.set(i, [])
            weekly.get(i)!.push({ week: String(r.week).slice(0, 10), n: n(r.n), clients: n(r.clients) })
        }
    }

    // How many clients were on this release, week by week.
    let adoption: Snapshot['adoption'] = []
    if (s.version_property) {
        const arows = await hogql(
            `SELECT toStartOfWeek(timestamp, 1) AS week, uniqIf(${cp}, toString(properties.${s.version_property}) = {name}) AS on_v, uniq(${cp}) AS all_c FROM events
             WHERE timestamp >= toDateTime({r}) AND timestamp < toDateTime({a1}) GROUP BY week ORDER BY week`,
            values
        )
        adoption = arows.map((r) => ({ week: String(r.week).slice(0, 10), on: n(r.on_v), all: n(r.all_c) }))
    }

    const inWindow = (d: string) => Date.parse(d) >= start && Date.parse(d) < end
    const screenStats: Record<string, ScreenStats> = {}
    screens.forEach((path, j) => {
        screenStats[path] = {
            sessions_after: n(agg[`s${j}_s_a`]),
            sessions_before: n(agg[`s${j}_s_b`]),
            errors_after: n(agg[`s${j}_e_a`]),
            errors_before: n(agg[`s${j}_e_b`]),
            rage_after: n(agg[`s${j}_r_a`]),
            rage_before: n(agg[`s${j}_r_b`]),
            support: ctx.support.filter((x) => x.screen === path && inWindow(x.created)).map((x) => ({ key: x.key, summary: x.summary, created: x.created, type: x.type })),
        }
    })

    const tickets: TicketStats[] = linked.map(({ t, auto, own, link }) => {
        const i = link ? targets.findIndex((x) => x.event === link.event && (link.event || x.screen === link.screen)) : -1
        const owner = !!link?.screen && (owners.get(link.screen) || []).includes(t.key)
        return {
            key: t.key,
            type: t.type,
            summary: t.summary,
            status: t.status,
            components: JSON.parse(t.components) as string[],
            hidden: !!t.hidden,
            link,
            link_source: own ? 'person' : auto?.source || 'none',
            link_reason: own ? `set by ${t.link_by || 'someone'}` : auto?.reason || 'Not linked yet.',
            link_by: t.link_by || undefined,
            confidence: own ? 1 : auto?.confidence || 0,
            risk_owner: owner,
            shares_screen_with: owner && link?.screen ? (owners.get(link.screen) || []).filter((k) => k !== t.key) : [],
            usage:
                i >= 0
                    ? {
                          after: n(agg[`t${i}_n_a`]),
                          before: n(agg[`t${i}_n_b`]),
                          users_after: n(agg[`t${i}_u_a`]),
                          users_before: n(agg[`t${i}_u_b`]),
                          clients_after: n(agg[`t${i}_c_a`]),
                          clients_before: n(agg[`t${i}_c_b`]),
                      }
                    : null,
            weekly: i >= 0 ? weekly.get(i) || [] : [],
        }
    })

    return {
        release: rel.name,
        date: rel.released_at,
        description: rel.description || '',
        computed_at: new Date().toISOString(),
        window: { before_start: new Date(before).toISOString(), after_start: new Date(start).toISOString(), after_end: new Date(end).toISOString(), days, open: end >= now - 60_000 },
        totals: {
            clients_after: n(agg.clients_a),
            clients_before: n(agg.clients_b),
            users_after: n(agg.users_a),
            sessions_after: n(agg.sessions_a),
            sessions_before: n(agg.sessions_b),
            errors_after: n(agg.errors_a),
            errors_before: n(agg.errors_b),
            rage_after: n(agg.rage_a),
            rage_before: n(agg.rage_b),
            clients_on_version: s.version_property ? n(agg.on_version) : null,
        },
        adoption,
        screens: screenStats,
        new_errors: ctx.errors.filter((e) => inWindow(e.first_seen)),
        tickets,
    }
}

// ------------------------------------------------------------------ sync
let syncing: Promise<SyncResult> | undefined
export interface SyncResult {
    releases: string[]
    tickets: number
    dropped: string[]
    seconds: number
}
export const syncStatus = () => ({ running: !!syncing, ...getSetting<{ at?: string; error?: string; result?: SyncResult }>('releases.sync', {}) })

/** Reads Jira and PostHog and recomputes everything. One run at a time. */
export function syncReleases(): Promise<SyncResult> {
    if (!syncing) {
        syncing = doSync()
            .then((result) => {
                setSetting('releases.sync', { at: new Date().toISOString(), result })
                return result
            })
            .catch((e) => {
                setSetting('releases.sync', { ...getSetting('releases.sync', {}), error: (e as Error).message.slice(0, 300), failed_at: new Date().toISOString() })
                throw e
            })
            .finally(() => (syncing = undefined))
    }
    return syncing
}

async function doSync(): Promise<SyncResult> {
    const t0 = Date.now()
    const s = releaseSettings()
    const versions = (await getVersions(s.jira_project))
        .filter((v) => v.released && v.releaseDate && !v.archived)
        .sort((a, b) => a.releaseDate!.localeCompare(b.releaseDate!))
    const kept = versions.slice(-s.keep)
    if (!kept.length) throw new Error(`Jira project ${s.jira_project} has no released versions with a release date.`)

    const fields = ['summary', 'description', 'issuetype', 'status', 'components', 'labels', 'fixVersions']
    const issues = await searchIssues(`project = ${s.jira_project} AND fixVersion in (${kept.map((v) => jqlString(v.name)).join(', ')})`, fields, 5000)
    const since = new Date(Date.parse(kept[0].releaseDate!) - (s.window_days + 7) * DAY).toISOString()
    const cp = s.client_property
    const [areas, errors, support] = await Promise.all([loadAreas(since), loadErrors(since, cp), loadSupport(s.support_jql, since).catch(() => [] as SupportTicket[])])

    const now = new Date().toISOString()
    const releaseOf = (i: JiraIssue) => {
        const names = ((i.fields.fixVersions as { name: string }[]) || []).map((v) => v.name)
        // A ticket in several releases belongs to the first one it shipped in.
        return kept.find((v) => names.includes(v.name))
    }
    const keptNames = kept.map((v) => v.name)
    const dropped = all<{ name: string }>('SELECT name FROM releases').map((r) => r.name).filter((x) => !keptNames.includes(x))
    tx(() => {
        for (const v of kept) {
            run(
                `INSERT INTO releases (name, released_at, description, synced_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (name) DO UPDATE SET released_at = excluded.released_at, description = excluded.description, synced_at = excluded.synced_at`,
                v.name, v.releaseDate!, v.description || null, now
            )
        }
        for (const name of dropped) run('DELETE FROM releases WHERE name = ?', name) // tickets and snapshots go with it
        const seen: string[] = []
        for (const i of issues) {
            const v = releaseOf(i)
            if (!v) continue
            seen.push(i.key)
            const components = ((i.fields.components as { name: string }[]) || []).map((c) => c.name)
            const labels = (i.fields.labels as string[]) || []
            const description = adfToText(i.fields.description as never).slice(0, 4000)
            const auto = autoLink({ summary: i.fields.summary, description, components, labels, type: i.fields.issuetype?.name }, v.releaseDate!, areas, s.component_screens)
            run(
                `INSERT INTO release_tickets (key, release, type, summary, description, status, components, labels, auto_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (key) DO UPDATE SET release = excluded.release, type = excluded.type, summary = excluded.summary, description = excluded.description,
                   status = excluded.status, components = excluded.components, labels = excluded.labels, auto_link = excluded.auto_link`,
                i.key, v.name, i.fields.issuetype?.name || 'Task', i.fields.summary, description, (i.fields.status as { name?: string })?.name || null,
                JSON.stringify(components), JSON.stringify(labels), JSON.stringify(auto)
            )
        }
        for (const r of all<{ key: string }>('SELECT key FROM release_tickets')) if (!seen.includes(r.key)) run('DELETE FROM release_tickets WHERE key = ?', r.key)
        // Custom groups forget releases that are no longer kept.
        for (const g of all<{ id: number; releases: string }>('SELECT id, releases FROM release_groups')) {
            const left = (JSON.parse(g.releases) as string[]).filter((x) => keptNames.includes(x))
            run('UPDATE release_groups SET releases = ? WHERE id = ?', JSON.stringify(left), g.id)
        }
    })
    setSetting('releases.areas', areas)

    const rels = keptReleases()
    for (let i = 0; i < rels.length; i++) {
        const snap = await computeSnapshot(rels[i], rels[i + 1], { s, errors, support })
        run('INSERT INTO release_snapshots (release, computed_at, data) VALUES (?, ?, ?) ON CONFLICT (release) DO UPDATE SET computed_at = excluded.computed_at, data = excluded.data', rels[i].name, snap.computed_at, JSON.stringify(snap))
    }
    return { releases: keptNames, tickets: issues.length, dropped, seconds: Math.round((Date.now() - t0) / 100) / 10 }
}

/** Recomputes one release's numbers (after a link change), without reading Jira again. */
export async function recompute(release: string): Promise<void> {
    const s = releaseSettings()
    const rels = keptReleases()
    const i = rels.findIndex((r) => r.name === release)
    if (i < 0) return
    const since = new Date(Date.parse(rels[0].released_at) - (s.window_days + 7) * DAY).toISOString()
    const [errors, support] = await Promise.all([loadErrors(since, s.client_property), loadSupport(s.support_jql, since).catch(() => [] as SupportTicket[])])
    const snap = await computeSnapshot(rels[i], rels[i + 1], { s, errors, support })
    run('INSERT INTO release_snapshots (release, computed_at, data) VALUES (?, ?, ?) ON CONFLICT (release) DO UPDATE SET computed_at = excluded.computed_at, data = excluded.data', release, snap.computed_at, JSON.stringify(snap))
}

// ------------------------------------------------------------------ editing
export const areas = () => getSetting<Areas>('releases.areas', { screens: [], events: [] })

export function ticketRelease(key: string): string | undefined {
    return one<{ release: string }>('SELECT release FROM release_tickets WHERE key = ?', key)?.release
}
/** Sets (or, with null, clears) the link a person chose for a ticket. */
export function setLink(key: string, link: Link | null, by: string): void {
    run('UPDATE release_tickets SET link = ?, link_by = ?, link_at = ? WHERE key = ?', link ? JSON.stringify(link) : null, link ? by : null, link ? new Date().toISOString() : null, key)
}
export function setHidden(key: string, hidden: boolean): void {
    run('UPDATE release_tickets SET hidden = ? WHERE key = ?', hidden ? 1 : 0, key)
}

export interface Group {
    id: number
    name: string
    releases: string[]
    created_by: string
    created_at: string
}
export const groups = (): Group[] => all<Group & { releases: string }>('SELECT * FROM release_groups ORDER BY name').map((g) => ({ ...g, releases: JSON.parse(g.releases as unknown as string) }))
export function saveGroup(g: { id?: number; name: string; releases: string[] }, by: string): number {
    const names = keptReleases().map((r) => r.name)
    const releases = [...new Set(g.releases)].filter((r) => names.includes(r))
    if (!g.name.trim() || g.name.length > 60) throw new Error('Give the group a name (up to 60 characters).')
    if (!releases.length) throw new Error('Pick at least one release.')
    if (g.id) {
        run('UPDATE release_groups SET name = ?, releases = ? WHERE id = ?', g.name.trim(), JSON.stringify(releases), g.id)
        return g.id
    }
    return Number(run('INSERT INTO release_groups (name, releases, created_by, created_at) VALUES (?, ?, ?, ?)', g.name.trim(), JSON.stringify(releases), by, new Date().toISOString()).lastInsertRowid)
}
export const deleteGroup = (id: number) => run('DELETE FROM release_groups WHERE id = ?', id)

// ------------------------------------------------------------------ scopes and views
export function quarterOf(date: string, startMonth: number): { id: string; label: string } {
    const d = new Date(date + 'T00:00:00Z')
    const m = d.getUTCMonth() + 1
    const offset = (m - startMonth + 12) % 12
    const q = Math.floor(offset / 3) + 1
    if (startMonth === 1) return { id: `q:${d.getUTCFullYear()}-${q}`, label: `Q${q} ${d.getUTCFullYear()}` }
    const fy = m >= startMonth ? d.getUTCFullYear() + 1 : d.getUTCFullYear()
    return { id: `q:FY${fy}-${q}`, label: `FY${String(fy).slice(2)} Q${q}` }
}

export interface Scope {
    id: string // all | r:<release> | q:<quarter> | g:<group id>
    label: string
    kind: 'all' | 'release' | 'quarter' | 'group'
    releases: string[]
}

export function scopes(): Scope[] {
    const s = releaseSettings()
    const rels = keptReleases()
    const out: Scope[] = [{ id: 'all', label: `Last ${rels.length} releases`, kind: 'all', releases: rels.map((r) => r.name) }]
    const quarters = new Map<string, Scope>()
    for (const r of rels) {
        const q = quarterOf(r.released_at, s.fiscal_start_month)
        if (!quarters.has(q.id)) quarters.set(q.id, { id: q.id, label: q.label, kind: 'quarter', releases: [] })
        quarters.get(q.id)!.releases.push(r.name)
    }
    out.push(...[...quarters.values()].reverse())
    for (const g of groups()) out.push({ id: `g:${g.id}`, label: g.name, kind: 'group', releases: g.releases })
    out.push(...[...rels].reverse().map((r) => ({ id: `r:${r.name}`, label: r.name, kind: 'release' as const, releases: [r.name] })))
    return out
}

export interface Scores {
    reach: number
    adoption: number | null
    fixes: number | null
    errors: number | null
    friction: number | null
    support: number | null
    value: number
    risk: number
    impact: number
    direction: 'value' | 'risk'
}

const clamp = (x: number) => Math.max(0, Math.min(1, x))
const per100 = (count: number, sessions: number) => (sessions ? (count / sessions) * 100 : 0)

/** Scores a ticket from 0 to 1 on each signal, then value, risk and impact (0 to 100). */
export function scoreTicket(t: TicketStats, snap: Snapshot, w: Weights, screenReach: number): Scores {
    const active = Math.max(1, snap.totals.clients_after)
    const sc = t.link?.screen ? snap.screens[t.link.screen] : undefined
    const reachRaw = t.usage ? t.usage.clients_after / active : 0
    const reach = clamp(t.link?.event ? reachRaw : reachRaw * screenReach)
    // Adoption: how much use the ticket's event got, against the screen's sessions.
    const adoption = t.link?.event && t.usage && sc ? clamp(t.usage.after / Math.max(1, sc.sessions_after) / 0.4) : null
    let fixes: number | null = null
    let errors: number | null = null
    let friction: number | null = null
    let support: number | null = null
    if (t.risk_owner && sc) {
        const errDelta = per100(sc.errors_after, sc.sessions_after) - per100(sc.errors_before, sc.sessions_before)
        const rageDelta = per100(sc.rage_after, sc.sessions_after) - per100(sc.rage_before, sc.sessions_before)
        const newHere = snap.new_errors.some((e) => e.path === t.link!.screen && e.clients >= 2)
        errors = clamp(Math.max(errDelta / 5, newHere ? 0.5 : 0))
        friction = clamp(rageDelta / 8)
        support = clamp(sc.support.length / 4)
        // Only a ticket that changed how the screen already worked can be credited with a fix.
        const couldFix = !t.link?.event || t.type === 'Bug'
        const hadProblems = sc.errors_before + sc.rage_before > 0
        fixes = hadProblems && couldFix ? clamp(Math.max(-errDelta / 5, -rageDelta / 8)) : null
    }
    const avg = (parts: [number | null, number][]) => {
        const use = parts.filter(([v, wt]) => v !== null && wt > 0) as [number, number][]
        const total = use.reduce((a, [, wt]) => a + wt, 0)
        return total ? use.reduce((a, [v, wt]) => a + v * wt, 0) / total : 0
    }
    const value = avg([
        [reach, w.reach],
        [adoption, w.adoption],
        [fixes, w.fixes],
    ])
    const risk = avg([
        [errors, w.errors],
        [friction, w.friction],
        [support, w.support],
    ])
    return { reach, adoption, fixes, errors, friction, support, value, risk, impact: Math.round(100 * Math.max(value, risk)), direction: risk > value ? 'risk' : 'value' }
}

export interface ReleaseSummary {
    name: string
    date: string
    description: string
    days: number
    open: boolean
    tickets: number
    by_type: Record<string, number>
    clients_active: number
    clients_on_version: number | null
    adoption: { week: string; on: number; all: number }[]
    errors_per_1k: number
    errors_per_1k_before: number
    rage_per_1k: number
    rage_per_1k_before: number
    new_errors: ErrorIssue[]
    support: number
    health: 'Healthy' | 'Watch' | 'At risk'
    health_reasons: string[]
    top: string | null
}

function summarize(snap: Snapshot, ranked: (TicketStats & { scores: Scores })[]): ReleaseSummary {
    const t = snap.totals
    const e1 = per100(t.errors_after, t.sessions_after) * 10
    const e0 = per100(t.errors_before, t.sessions_before) * 10
    const r1 = per100(t.rage_after, t.sessions_after) * 10
    const r0 = per100(t.rage_before, t.sessions_before) * 10
    const support = new Set(Object.values(snap.screens).flatMap((x) => x.support.map((y) => y.key))).size
    const spread = snap.new_errors.filter((e) => e.clients >= 2)
    const reasons: string[] = []
    if (spread.length) reasons.push(`${spread.length} new error${spread.length > 1 ? 's' : ''} hitting 2+ clients`)
    if (e1 >= 2 && e1 >= 3 * Math.max(e0, 0.5)) reasons.push(`errors ${e0 ? `${Math.round(e1 / e0)}×` : 'up from none'}`)
    if (support >= 3) reasons.push(`${support} support tickets`)
    let health: ReleaseSummary['health'] = reasons.length ? 'At risk' : 'Healthy'
    if (health === 'Healthy') {
        if (e1 >= 1 && e1 >= 1.5 * Math.max(e0, 0.5)) reasons.push('errors up')
        if (r1 >= 2 && r1 >= 2 * Math.max(r0, 0.5)) reasons.push('rage clicks up')
        if (support >= 1) reasons.push(`${support} support ticket${support > 1 ? 's' : ''}`)
        if (reasons.length) health = 'Watch'
    }
    const by_type: Record<string, number> = {}
    for (const x of snap.tickets) by_type[x.type] = (by_type[x.type] || 0) + 1
    return {
        name: snap.release,
        date: snap.date,
        description: snap.description,
        days: snap.window.days,
        open: snap.window.open,
        tickets: snap.tickets.length,
        by_type,
        clients_active: t.clients_after,
        clients_on_version: t.clients_on_version,
        adoption: snap.adoption,
        errors_per_1k: Math.round(e1 * 10) / 10,
        errors_per_1k_before: Math.round(e0 * 10) / 10,
        rage_per_1k: Math.round(r1 * 10) / 10,
        rage_per_1k_before: Math.round(r0 * 10) / 10,
        new_errors: snap.new_errors,
        support,
        health,
        health_reasons: reasons,
        top: ranked.find((x) => x.scores.direction === 'value')?.key || null,
    }
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const nameOf = (path?: string) => (path ? screenName(path) : 'its screen')

/** Plain-language findings, strongest first. Only event numbers, never replay content. */
function insights(snaps: Snapshot[], ranked: (TicketStats & { scores: Scores; release: string })[], summaries: ReleaseSummary[]): { kind: 'win' | 'risk' | 'fix' | 'info'; text: string; ticket?: string }[] {
    const out: { kind: 'win' | 'risk' | 'fix' | 'info'; text: string; ticket?: string; weight: number }[] = []
    const snapOf = (r: string) => snaps.find((s) => s.release === r)!
    for (const x of ranked) {
        const snap = snapOf(x.release)
        const active = Math.max(1, snap.totals.clients_after)
        if (x.link?.event && x.usage && x.scores.reach >= 0.5) {
            out.push({ kind: 'win', ticket: x.key, weight: x.scores.value, text: `${x.key} "${x.summary}" (${x.release}) reached ${x.usage.clients_after} of ${active} clients (${pct(x.usage.clients_after / active)}) in ${snap.window.days} days.` })
        }
        if (x.link?.event && x.usage && x.usage.clients_after <= Math.max(2, active * 0.15) && !snap.window.open) {
            out.push({ kind: 'info', ticket: x.key, weight: 0.3, text: `Low uptake: ${x.key} "${x.summary}" (${x.release}) was used by ${x.usage.clients_after} client${x.usage.clients_after === 1 ? '' : 's'} in ${snap.window.days} days.` })
        }
        if (x.scores.fixes !== null && x.scores.fixes >= 0.3 && x.link?.screen) {
            const sc = snap.screens[x.link.screen]
            const what = sc.errors_before > sc.rage_before ? 'errors' : 'rage clicks'
            const [b, a] = what === 'errors' ? [sc.errors_before, sc.errors_after] : [sc.rage_before, sc.rage_after]
            out.push({ kind: 'fix', ticket: x.key, weight: 0.6 + x.scores.fixes / 4, text: `${x.key} "${x.summary}" (${x.release}) looks fixed: ${what} on ${nameOf(x.link.screen)} went from ${b} to ${a} in the same number of days.` })
        }
        if (x.scores.friction !== null && x.scores.friction >= 0.3 && x.link?.screen) {
            const sc = snap.screens[x.link.screen]
            out.push({ kind: 'risk', ticket: x.key, weight: 0.7 + x.scores.friction / 4, text: `Rage clicks on ${nameOf(x.link.screen)} went from ${sc.rage_before} to ${sc.rage_after} after ${x.release}. Likely cause: ${x.key} "${x.summary}".` })
        }
    }
    for (const sum of summaries) {
        const snap = snapOf(sum.name)
        for (const e of sum.new_errors.filter((e) => e.clients >= 2)) {
            const suspects = ranked.filter((x) => x.release === sum.name && x.risk_owner && x.link?.screen === e.path).map((x) => x.key)
            out.push({
                kind: 'risk',
                ticket: suspects[0],
                weight: 0.9 + Math.min(0.1, e.clients / 100),
                text: `New error after ${sum.name}: ${e.type}${e.message ? `: ${e.message}` : ''}. ${e.occurrences} times for ${e.clients} clients, mostly on ${nameOf(e.path)}.${suspects.length ? ` Likely cause: ${suspects.join(', ')}.` : ''}`,
            })
        }
        const supportByScreen = Object.entries(snap.screens).filter(([, v]) => v.support.length >= 2)
        for (const [path, v] of supportByScreen) {
            out.push({ kind: 'risk', weight: 0.75, text: `${v.support.length} support tickets about ${nameOf(path)} in the ${snap.window.days} days after ${sum.name} (${v.support.map((x) => x.key).join(', ')}).` })
        }
        if (sum.clients_on_version !== null && sum.clients_active && snaps.length === 1) {
            out.push({ kind: 'info', weight: 0.2, text: `${sum.clients_on_version} of ${sum.clients_active} active clients ran ${sum.name} in its first ${sum.days} days.` })
        }
    }
    return out
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 12)
        .map(({ weight: _w, ...rest }) => rest)
}

export interface View {
    scope: Scope
    weights: Weights
    settings: ReleaseSettings
    releases: ReleaseSummary[]
    tickets: (TicketStats & { release: string; scores: Scores })[]
    insights: ReturnType<typeof insights>
    screens: Record<string, Record<string, ScreenStats>> // release → screen → numbers
    kpis: { releases: number; tickets: number; ranked: number; clients_reached: number; new_errors: number; support: number; at_risk: number; avg_value: number; avg_risk: number }
    synced: ReturnType<typeof syncStatus>
}

export function snapshotsFor(names: string[]): Snapshot[] {
    return names.map((r) => one<{ data: string }>('SELECT data FROM release_snapshots WHERE release = ?', r)).filter(Boolean).map((x) => JSON.parse(x!.data) as Snapshot)
}

export function view(scopeId = 'all', weights?: Partial<Weights>): View {
    const s = releaseSettings()
    const w = { ...s.weights, ...(weights || {}) }
    const scope = scopes().find((x) => x.id === scopeId) || scopes()[0]
    const snaps = snapshotsFor(scope.releases)
    const tickets = snaps.flatMap((snap) => snap.tickets.map((t) => ({ ...t, release: snap.release, scores: scoreTicket(t, snap, w, s.screen_reach_factor) })))
    const rankedTickets = tickets.filter((t) => !t.hidden && s.ticket_types.includes(t.type) && t.link).sort((a, b) => b.scores.impact - a.scores.impact)
    const summaries = snaps.map((snap) => summarize(snap, rankedTickets.filter((t) => t.release === snap.release)))
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : 0)
    return {
        scope,
        weights: w,
        settings: s,
        releases: summaries,
        tickets: [...rankedTickets, ...tickets.filter((t) => !rankedTickets.includes(t))],
        insights: insights(snaps, rankedTickets, summaries),
        screens: Object.fromEntries(snaps.map((x) => [x.release, x.screens])),
        kpis: {
            releases: snaps.length,
            tickets: tickets.length,
            ranked: rankedTickets.length,
            clients_reached: Math.max(0, ...rankedTickets.filter((t) => t.link?.event).map((t) => t.usage?.clients_after || 0)),
            new_errors: summaries.reduce((a, x) => a + x.new_errors.length, 0),
            support: summaries.reduce((a, x) => a + x.support, 0),
            at_risk: summaries.filter((x) => x.health === 'At risk').length,
            avg_value: avg(rankedTickets.map((t) => t.scores.value)),
            avg_risk: avg(rankedTickets.map((t) => t.scores.risk)),
        },
        synced: syncStatus(),
    }
}

/** The view as markdown, for Claude (MCP) and anywhere text is easier than a page. */
export function viewMarkdown(v: View, top = 5): string {
    const lines = [`## ${v.scope.label}: release insights`]
    lines.push(`${v.kpis.releases} release${v.kpis.releases === 1 ? '' : 's'}, ${v.kpis.tickets} tickets (${v.kpis.ranked} ranked), ${v.kpis.new_errors} new errors, ${v.kpis.support} support tickets, ${v.kpis.at_risk} at risk.`)
    if (v.insights.length) lines.push('', '### Findings', ...v.insights.map((i) => `- ${i.text}`))
    const table = (title: string, xs: View['tickets']) => {
        if (!xs.length) return
        lines.push('', `### ${title}`, '| Ticket | Release | Linked to | Clients | Value | Risk | Impact |', '|---|---|---|---|---|---|---|')
        for (const t of xs) lines.push(`| ${t.key} ${t.summary} | ${t.release} | ${t.link?.event || nameOf(t.link?.screen)} | ${t.usage?.clients_after ?? '-'} | ${Math.round(t.scores.value * 100)} | ${Math.round(t.scores.risk * 100)} | ${t.scores.impact} |`)
    }
    const ranked = v.tickets.filter((t) => t.link && !t.hidden && v.settings.ticket_types.includes(t.type))
    table('Most impact', ranked.slice(0, top))
    table('Most risk', [...ranked].sort((a, b) => b.scores.risk - a.scores.risk).filter((t) => t.scores.risk > 0).slice(0, top))
    if (v.releases.length > 1) {
        lines.push('', '### Releases', '| Release | Date | Tickets | Errors per 1k sessions (before → after) | Support | Health |', '|---|---|---|---|---|---|')
        for (const r of v.releases) lines.push(`| ${r.name} | ${r.date} | ${r.tickets} | ${r.errors_per_1k_before} → ${r.errors_per_1k} | ${r.support} | ${r.health} |`)
    }
    lines.push('', '_Impact is the larger of value (reach, adoption, fixes) and risk (errors, rage clicks, support tickets). It shows activity where a ticket changed the product, not proof that the ticket caused it._')
    return lines.join('\n')
}
