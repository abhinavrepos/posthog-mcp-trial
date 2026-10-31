// Release outcomes: Jira releases and their tickets, matched to what happened in PostHog.
// It only gathers facts. Judging whether a ticket is risky is left to a model (Claude, through the
// MCP tools in src/mcp/tools.ts) and to people, whose verdicts are saved here.
//
//   sync       reads the last N released versions from Jira (default 12), their tickets and the
//              support tickets; links each ticket to the screen it changed (and the PostHog event
//              it added, when one fits); then counts use, errors, rage clicks and survey answers
//              before and after each release into release_snapshots. Every 6 hours, or on request.
//   outcomes   sorts a release's tickets into groups by what happened (adopted, more errors,
//              clients complained, ...). The rules are plain thresholds, listed in OUTCOMES.
//   verdicts   "risky", "watch" or "fine" with a reason, from Claude or a person.
//
// How a ticket is linked (first match wins, and a person can always change it):
//   1. a link someone set
//   2. its Jira component, through RELEASES_COMPONENT_SCREENS (or a screen of that name)
//   3. words in the ticket that name a screen
//   plus a PostHog event: one whose name shares a feature word with the ticket title and that
//   first appeared within three weeks of the release. That is what a new feature looks like.
//
// "After" runs from the release date to the next release, at most RELEASES_WINDOW_DAYS. "Before"
// is the same number of days before the release. Errors, rage clicks and complaints are counted per
// screen and given to the tickets that changed how that screen already worked (linked to it without
// an event of their own); if every ticket on the screen added an event, they share them.
import { adfToText } from '../jira/adf.ts'
import { getVersions, jqlString, searchIssues, type JiraIssue } from '../jira/client.ts'
import { SCREENS } from './catalog.ts'
import { config } from './config.ts'
import { all, getSetting, one, run, setSetting, tx } from './db.ts'
import { hogql, issueUrl } from './posthog.ts'
import { resolveScreen } from './resolve.ts'
import { stem, tokens } from './text.ts'

const DAY = 86_400_000

// ------------------------------------------------------------------ settings (environment)
export interface ReleaseSettings {
    jira_project: string
    support_jql: string // the support tickets to count, e.g. RCI and MMT Risk
    keep: number // releases kept
    window_days: number // longest "after" window
    fiscal_start_month: number // 1 = calendar quarters
    client_property: string // the event property that names the client
    version_property: string // the event property with the release name, or '' to use dates only
    component_screens: Record<string, string> // Jira component → screen path
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
const intEnv = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(process.env[k])
    return process.env[k] && Number.isInteger(v) && v >= lo && v <= hi ? v : d
}

export function releaseSettings(): ReleaseSettings {
    const prop = (k: string, d: string) => {
        const v = process.env[k] ?? d
        return v === '' || IDENT.test(v) ? v : d // property names go into HogQL, so only plain names
    }
    let component_screens: Record<string, string> = {}
    try {
        component_screens = JSON.parse(process.env.RELEASES_COMPONENT_SCREENS || '{}')
    } catch {}
    return {
        jira_project: /^[A-Z][A-Z0-9_]{0,19}$/.test(process.env.RELEASES_JIRA_PROJECT || '') ? process.env.RELEASES_JIRA_PROJECT! : 'ACP',
        support_jql: process.env.RELEASES_SUPPORT_JQL || 'project = SUP AND issuetype in ("RCI", "MMT Risk")',
        keep: intEnv('RELEASES_KEEP', 12, 1, 52),
        window_days: intEnv('RELEASES_WINDOW_DAYS', 30, 7, 120),
        fiscal_start_month: intEnv('RELEASES_FISCAL_START_MONTH', 1, 1, 12),
        // PROP_CLIENT_ID and PROP_APP_VERSION; the RELEASES_* names still work.
        client_property: prop('RELEASES_CLIENT_PROPERTY', config.properties.client) || config.properties.client,
        version_property: prop('RELEASES_VERSION_PROPERTY', config.properties.version),
        component_screens,
    }
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
    text: string // the start of the description: what the client said
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
        return {
            key: i.key,
            type: i.fields.issuetype?.name || '',
            summary: i.fields.summary,
            text: body.replace(/\s+/g, ' ').trim().slice(0, 300),
            created: String(i.fields.created),
            screen: m && m.confidence >= 0.6 ? m.path : undefined,
        }
    })
}

export interface SurveyAnswer {
    at: string
    path: string
    rating: number | null // 1 to 5 when the first question is a rating
    comment: string
    client: string
}

/** PostHog survey answers ("survey sent" events): what users told you in the product. */
async function loadSurveys(since: string, cp: string): Promise<SurveyAnswer[]> {
    const rows = await hogql(
        `SELECT timestamp AS at, toString(properties.$pathname) AS path, toString(properties.$survey_response) AS r0,
                toString(properties.$survey_response_1) AS r1, toString(properties.${cp}) AS client
         FROM events WHERE event = 'survey sent' AND timestamp > toDateTime({since}) ORDER BY timestamp LIMIT 20000`,
        { since }
    )
    return rows.map((r) => {
        const rating = Number(r.r0)
        const isRating = String(r.r0 ?? '').trim() !== '' && Number.isFinite(rating) && rating >= 1 && rating <= 10
        return { at: iso(r.at), path: String(r.path || ''), rating: isRating ? rating : null, comment: String((isRating ? r.r1 : r.r0) || '').trim().slice(0, 400), client: String(r.client || '') }
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
    support: { key: string; summary: string; text: string; created: string; type: string }[]
    survey: {
        answers_before: number
        answers_after: number
        rating_before: number | null // average, 1 to 5
        rating_after: number | null
        comments_after: { rating: number | null; comment: string; client: string; at: string }[]
    }
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

async function computeSnapshot(rel: ReleaseRow, next: ReleaseRow | undefined, ctx: { s: ReleaseSettings; errors: ErrorIssue[]; support: SupportTicket[]; surveys: SurveyAnswer[] }): Promise<Snapshot> {
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
    const ranked = (x: (typeof linked)[number]) => !x.t.hidden && x.t.type !== 'Task'
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
    const inBefore = (d: string) => Date.parse(d) >= before && Date.parse(d) < start
    const avg = (xs: (number | null)[]) => {
        const ys = xs.filter((x): x is number => x !== null)
        return ys.length ? Math.round((ys.reduce((a, b) => a + b, 0) / ys.length) * 10) / 10 : null
    }
    const surveyStats = (answers: SurveyAnswer[]): ScreenStats['survey'] => {
        const b = answers.filter((a) => inBefore(a.at))
        const a = answers.filter((x) => inWindow(x.at))
        return {
            answers_before: b.length,
            answers_after: a.length,
            rating_before: avg(b.map((x) => x.rating)),
            rating_after: avg(a.map((x) => x.rating)),
            // The lowest-rated comments first: they say what went wrong.
            comments_after: a
                .filter((x) => x.comment)
                .sort((x, y) => (x.rating ?? 9) - (y.rating ?? 9))
                .slice(0, 12)
                .map((x) => ({ rating: x.rating, comment: x.comment, client: x.client, at: x.at })),
        }
    }
    const screenStats: Record<string, ScreenStats> = {}
    screens.forEach((path, j) => {
        screenStats[path] = {
            sessions_after: n(agg[`s${j}_s_a`]),
            sessions_before: n(agg[`s${j}_s_b`]),
            errors_after: n(agg[`s${j}_e_a`]),
            errors_before: n(agg[`s${j}_e_b`]),
            rage_after: n(agg[`s${j}_r_a`]),
            rage_before: n(agg[`s${j}_r_b`]),
            support: ctx.support.filter((x) => x.screen === path && inWindow(x.created)).map((x) => ({ key: x.key, summary: x.summary, text: x.text, created: x.created, type: x.type })),
            survey: surveyStats(ctx.surveys.filter((a) => a.path === path)),
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
    const [areas, errors, support, surveys] = await Promise.all([
        loadAreas(since),
        loadErrors(since, cp),
        loadSupport(s.support_jql, since).catch(() => [] as SupportTicket[]),
        loadSurveys(since, cp).catch(() => [] as SurveyAnswer[]),
    ])

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
        for (const name of dropped) {
            run('DELETE FROM releases WHERE name = ?', name) // tickets and snapshots go with it
            run('DELETE FROM release_verdicts WHERE release = ?', name)
        }
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
    })
    setSetting('releases.areas', areas)

    const rels = keptReleases()
    for (let i = 0; i < rels.length; i++) {
        const snap = await computeSnapshot(rels[i], rels[i + 1], { s, errors, support, surveys })
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
    const [errors, support, surveys] = await Promise.all([
        loadErrors(since, s.client_property),
        loadSupport(s.support_jql, since).catch(() => [] as SupportTicket[]),
        loadSurveys(since, s.client_property).catch(() => [] as SurveyAnswer[]),
    ])
    const snap = await computeSnapshot(rels[i], rels[i + 1], { s, errors, support, surveys })
    run('INSERT INTO release_snapshots (release, computed_at, data) VALUES (?, ?, ?) ON CONFLICT (release) DO UPDATE SET computed_at = excluded.computed_at, data = excluded.data', release, snap.computed_at, JSON.stringify(snap))
}

// ------------------------------------------------------------------ links and verdicts
export const areas = () => getSetting<Areas>('releases.areas', { screens: [], events: [] })

export function ticketRelease(key: string): string | undefined {
    return one<{ release: string }>('SELECT release FROM release_tickets WHERE key = ?', key)?.release
}
/** Sets (or, with null, clears) the link a person chose for a ticket. */
export function setLink(key: string, link: Link | null, by: string): void {
    run('UPDATE release_tickets SET link = ?, link_by = ?, link_at = ? WHERE key = ?', link ? JSON.stringify(link) : null, link ? by : null, link ? new Date().toISOString() : null, key)
}

export type Verdict = 'risky' | 'watch' | 'fine'
export interface VerdictRow {
    ticket: string
    release: string
    verdict: Verdict
    reason: string
    source: string // a person's name or email, or "claude"
    at: string
}

/** Saves a verdict on a ticket. Earlier ones are kept as history; the newest counts. */
export function recordVerdict(ticket: string, verdict: Verdict, reason: string, source: string): VerdictRow {
    const release = ticketRelease(ticket)
    if (!release) throw new Error(`${ticket} is not in the kept releases.`)
    const row: VerdictRow = { ticket, release, verdict, reason: reason.trim().slice(0, 2000), source: source.trim().slice(0, 120) || 'unknown', at: new Date().toISOString() }
    run('INSERT INTO release_verdicts (ticket, release, verdict, reason, source, at) VALUES (?, ?, ?, ?, ?, ?)', row.ticket, row.release, row.verdict, row.reason, row.source, row.at)
    return row
}
export const verdictHistory = (ticket: string) => all<VerdictRow>('SELECT ticket, release, verdict, reason, source, at FROM release_verdicts WHERE ticket = ? ORDER BY id DESC', ticket)
function latestVerdicts(): Map<string, VerdictRow> {
    const out = new Map<string, VerdictRow>()
    for (const v of all<VerdictRow>('SELECT ticket, release, verdict, reason, source, at FROM release_verdicts ORDER BY id')) out.set(v.ticket, v)
    return out
}

// ------------------------------------------------------------------ scopes
export function quarterOf(date: string, startMonth: number): string {
    const d = new Date(date + 'T00:00:00Z')
    const m = d.getUTCMonth() + 1
    const q = Math.floor(((m - startMonth + 12) % 12) / 3) + 1
    if (startMonth === 1) return `Q${q} ${d.getUTCFullYear()}`
    const fy = m >= startMonth ? d.getUTCFullYear() + 1 : d.getUTCFullYear()
    return `FY${String(fy).slice(2)} Q${q}`
}

export interface Scope {
    label: string
    releases: string[]
}

export const keptNames = () => keptReleases().map((r) => r.name)

/** Quarters that have kept releases, newest first. */
export function quarters(): Scope[] {
    const start = releaseSettings().fiscal_start_month
    const out = new Map<string, string[]>()
    for (const r of keptReleases()) {
        const q = quarterOf(r.released_at, start)
        out.set(q, [...(out.get(q) || []), r.name])
    }
    return [...out].reverse().map(([label, releases]) => ({ label, releases }))
}

/** Reads what someone asked for: "all", "26.10.0", "Q3 2026", "FY27 Q1", "last 3",
 * "26.5.0..26.8.0" or "2026-01-01..2026-06-30". */
export function resolveScope(text?: string): Scope | undefined {
    const rels = keptReleases()
    const q = (text || 'all').trim()
    if (!q || /^all$/i.test(q)) return { label: `Last ${rels.length} releases`, releases: rels.map((r) => r.name) }
    const exact = rels.find((r) => r.name === q.replace(/^v/i, ''))
    if (exact) return { label: exact.name, releases: [exact.name] }
    const quarter = quarters().find((x) => x.label.toLowerCase() === q.toLowerCase())
    if (quarter) return quarter
    const last = /^last\s+(\d+)$/i.exec(q)
    if (last) {
        const picked = rels.slice(-Number(last[1]))
        return { label: `Last ${picked.length} releases`, releases: picked.map((r) => r.name) }
    }
    const range = /^(.+?)\s*\.\.\s*(.+)$/.exec(q)
    if (range) {
        const at = (x: string) => rels.find((r) => r.name === x)?.released_at || (/^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined)
        const [from, to] = [at(range[1]), at(range[2])]
        if (from && to) {
            const picked = rels.filter((r) => r.released_at >= from && r.released_at <= to)
            if (picked.length) return { label: `${range[1]} to ${range[2]}`, releases: picked.map((r) => r.name) }
        }
    }
    return undefined
}

export function snapshotsFor(names: string[]): Snapshot[] {
    return names.map((r) => one<{ data: string }>('SELECT data FROM release_snapshots WHERE release = ?', r)).filter(Boolean).map((x) => JSON.parse(x!.data) as Snapshot)
}

// ------------------------------------------------------------------ outcomes
/** Thresholds for the outcome groups. Plain numbers on purpose: anyone can read and argue them. */
export const THRESHOLDS = {
    adopted: 0.3, // share of active clients that used a new feature's event
    low_uptake: 0.1, // below this share, once the window has closed
    error_rise: 1, // more errors per 100 sessions on the screen
    rage_rise: 2, // more rage clicks per 100 sessions on the screen (and at least 5)
    fixed_drop: 0.5, // errors or rage clicks per 100 sessions fell by half (from at least 1)
    rating_drop: 0.8, // survey rating fell by this much (10 answers or more on each side)
    too_new_days: 14,
}

export const OUTCOMES = [
    { id: 'errors', title: 'More errors after the release', rule: `errors on its screen rose by ${THRESHOLDS.error_rise}+ per 100 sessions, or a new error type hit 2+ clients` },
    { id: 'rage', title: 'More rage clicks', rule: `rage clicks on its screen rose by ${THRESHOLDS.rage_rise}+ per 100 sessions` },
    { id: 'complaints', title: 'Clients complained', rule: `support tickets about its screen after the release, or the survey rating fell by ${THRESHOLDS.rating_drop}+` },
    { id: 'fixed', title: 'Fixed something', rule: 'errors or rage clicks on its screen fell by half or more (bug fixes and changes to existing screens only)' },
    { id: 'adopted', title: 'Adopted', rule: `the new event was used by ${THRESHOLDS.adopted * 100}%+ of active clients` },
    { id: 'low_uptake', title: 'Low uptake', rule: `the new event was used by under ${THRESHOLDS.low_uptake * 100}% of active clients` },
    { id: 'too_new', title: 'Too new to tell', rule: `released under ${THRESHOLDS.too_new_days} days ago, nothing stands out yet` },
    { id: 'no_change', title: 'No clear change', rule: 'linked, but none of the above' },
    { id: 'unmeasured', title: "Can't measure", rule: 'no screen or event to measure (often tasks)' },
] as const
export type OutcomeId = (typeof OUTCOMES)[number]['id']

const per100 = (count: number, sessions: number) => (sessions ? Math.round((count / sessions) * 1000) / 10 : 0)
const nameOf = (path?: string) => (path ? screenName(path) : 'its screen')
const pct = (x: number) => `${Math.round(x * 100)}%`
const day = (iso: string) => iso.slice(0, 10)

export interface TicketOutcome extends TicketStats {
    release: string
    groups: OutcomeId[]
    facts: string[] // short sentences with the numbers
    verdict?: VerdictRow
}

export function classify(t: TicketStats, snap: Snapshot, verdict?: VerdictRow): TicketOutcome {
    const groups: OutcomeId[] = []
    const facts: string[] = []
    const active = Math.max(1, snap.totals.clients_after)
    const screen = t.link?.screen
    const sc = screen ? snap.screens[screen] : undefined
    if (!t.link) {
        groups.push('unmeasured')
        facts.push(`not linked: ${t.link_reason}`)
    } else {
        if (t.usage) {
            const share = t.usage.clients_after / active
            facts.push(
                t.link.event
                    ? `${t.link.event} happened ${t.usage.after} times (${t.usage.before} before), by ${t.usage.users_after} people at ${t.usage.clients_after} of ${active} active clients (${pct(share)})`
                    : `${nameOf(screen)} page views ${t.usage.before} → ${t.usage.after}, ${t.usage.clients_after} of ${active} clients`
            )
            if (t.link.event) {
                if (share >= THRESHOLDS.adopted) groups.push('adopted')
                else if (share < THRESHOLDS.low_uptake && !snap.window.open) groups.push('low_uptake')
            }
        }
        if (sc && t.risk_owner) {
            const [e0, e1] = [per100(sc.errors_before, sc.sessions_before), per100(sc.errors_after, sc.sessions_after)]
            const [r0, r1] = [per100(sc.rage_before, sc.sessions_before), per100(sc.rage_after, sc.sessions_after)]
            const newErrors = snap.new_errors.filter((e) => e.path === screen && e.clients >= 2)
            if (sc.errors_before + sc.errors_after) facts.push(`errors on ${nameOf(screen)} ${e0} → ${e1} per 100 sessions`)
            for (const e of newErrors) facts.push(`new ${e.type}: ${e.message} (${e.occurrences} times, ${e.clients} clients)`)
            if (sc.rage_before + sc.rage_after) facts.push(`rage clicks ${r0} → ${r1} per 100 sessions`)
            if (sc.support.length) facts.push(`${sc.support.length} support ticket${sc.support.length > 1 ? 's' : ''} (${sc.support.map((x) => x.key).join(', ')})`)
            const sv = sc.survey
            if (sv.rating_after !== null) facts.push(`survey rating ${sv.rating_before ?? '–'} → ${sv.rating_after} (${sv.answers_after} answers)`)
            if (e1 - e0 >= THRESHOLDS.error_rise || newErrors.length) groups.push('errors')
            if (r1 - r0 >= THRESHOLDS.rage_rise && sc.rage_after >= 5) groups.push('rage')
            const ratingFell = sv.rating_before !== null && sv.rating_after !== null && sv.answers_before >= 10 && sv.answers_after >= 10 && sv.rating_before - sv.rating_after >= THRESHOLDS.rating_drop
            if (sc.support.length || ratingFell) groups.push('complaints')
            const couldFix = !t.link.event || t.type === 'Bug'
            const fell = (b: number, a: number) => b >= 1 && a <= b * (1 - THRESHOLDS.fixed_drop)
            if (couldFix && (fell(e0, e1) || fell(r0, r1))) groups.push('fixed')
            if (t.shares_screen_with.length) facts.push(`shares ${nameOf(screen)}'s numbers with ${t.shares_screen_with.join(', ')}`)
        } else if (sc) {
            const owners = snap.tickets.filter((x) => x.risk_owner && x.link?.screen === screen).map((x) => x.key)
            if (owners.length) facts.push(`problems on ${nameOf(screen)} are counted for ${owners.join(', ')}`)
        }
        if (!groups.length) groups.push(snap.window.open && snap.window.days < THRESHOLDS.too_new_days ? 'too_new' : 'no_change')
    }
    return { ...t, release: snap.release, groups, facts, verdict }
}

export interface ReleaseFacts {
    name: string
    date: string
    days: number
    open: boolean
    tickets: number
    clients_active: number
    clients_on_version: number | null
    errors_per_1k: [number, number]
    rage_per_1k: [number, number]
    support: number
    survey: { rating_before: number | null; rating_after: number | null; answers_after: number }
    new_errors: ErrorIssue[]
}

function releaseFacts(snap: Snapshot): ReleaseFacts {
    const t = snap.totals
    const svs = Object.values(snap.screens).map((x) => x.survey)
    const weighted = (key: 'rating_before' | 'rating_after', n: 'answers_before' | 'answers_after') => {
        const total = svs.reduce((a, x) => a + (x[key] !== null ? x[n] : 0), 0)
        return total ? Math.round((svs.reduce((a, x) => a + (x[key] ?? 0) * (x[key] !== null ? x[n] : 0), 0) / total) * 10) / 10 : null
    }
    return {
        name: snap.release,
        date: snap.date,
        days: snap.window.days,
        open: snap.window.open,
        tickets: snap.tickets.length,
        clients_active: t.clients_after,
        clients_on_version: t.clients_on_version,
        errors_per_1k: [per100(t.errors_before, t.sessions_before) * 10, per100(t.errors_after, t.sessions_after) * 10],
        rage_per_1k: [per100(t.rage_before, t.sessions_before) * 10, per100(t.rage_after, t.sessions_after) * 10],
        support: new Set(Object.values(snap.screens).flatMap((x) => x.support.map((y) => y.key))).size,
        survey: { rating_before: weighted('rating_before', 'answers_before'), rating_after: weighted('rating_after', 'answers_after'), answers_after: svs.reduce((a, x) => a + x.answers_after, 0) },
        new_errors: snap.new_errors,
    }
}

export function outcomes(scope: Scope): { scope: Scope; releases: ReleaseFacts[]; tickets: TicketOutcome[] } {
    const snaps = snapshotsFor(scope.releases)
    const verdicts = latestVerdicts()
    return {
        scope,
        releases: snaps.map(releaseFacts),
        tickets: snaps.flatMap((snap) => snap.tickets.filter((t) => !t.hidden).map((t) => classify(t, snap, verdicts.get(t.key)))),
    }
}

// ------------------------------------------------------------------ text for the MCP tools
const jiraBase = () => (process.env.JIRA_PUBLIC_URL || config.jira.baseUrl.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, `//${new URL(config.service.publicUrl).hostname}`)).replace(/\/+$/, '')
export const jiraUrl = (key: string) => `${jiraBase()}/browse/${encodeURIComponent(key)}`
const verdictText = (v?: VerdictRow) => (v ? `verdict **${v.verdict}** (${v.source}, ${day(v.at)}): ${v.reason}` : '')

function releaseTable(rels: ReleaseFacts[]): string[] {
    const lines = ['| Release | Date | Measured | Clients on it | Errors / 1k sessions | Rage / 1k | Support tickets | Survey rating |', '|---|---|---|---|---|---|---|---|']
    for (const r of rels) {
        lines.push(
            `| ${r.name} | ${r.date} | ${r.days} days${r.open ? ', still counting' : ''} | ${r.clients_on_version ?? '–'} of ${r.clients_active} | ${r.errors_per_1k[0]} → ${r.errors_per_1k[1]} | ${r.rage_per_1k[0]} → ${r.rage_per_1k[1]} | ${r.support} | ${r.survey.rating_before ?? '–'} → ${r.survey.rating_after ?? '–'} |`
        )
    }
    return lines
}

export function releasesMarkdown(): string {
    const rels = snapshotsFor(keptNames()).map(releaseFacts)
    if (!rels.length) return 'No releases yet. Run refresh_releases first.'
    const st = getSetting<{ at?: string }>('releases.sync', {})
    return [
        `## Kept releases (${rels.length}, Jira project ${releaseSettings().jira_project})`,
        ...releaseTable([...rels].reverse()),
        '',
        `Quarters: ${quarters().map((q) => `${q.label} (${q.releases.join(', ')})`).join('; ')}.`,
        `You can also ask for "all", "last 3", or a range like "26.5.0..26.8.0". Last refreshed ${st.at ? day(st.at) + ' ' + st.at.slice(11, 16) + ' UTC' : 'never'}.`,
    ].join('\n')
}

export function outcomesMarkdown(scope: Scope): string {
    const o = outcomes(scope)
    const lines = [`## Outcomes: ${scope.label} (${scope.releases.join(', ')})`]
    lines.push('Facts from Jira and PostHog, sorted by what happened after each release. A ticket can be in more than one group. Use client_feedback for what clients said and ticket_evidence for one ticket in full.')
    lines.push('', '### Releases', ...releaseTable(o.releases))
    lines.push('', '### Groups')
    for (const g of OUTCOMES) {
        const ts = o.tickets.filter((t) => t.groups.includes(g.id))
        if (ts.length) lines.push(`- **${g.title}** (${ts.length}): ${ts.map((t) => t.key).join(', ')}. _Rule: ${g.rule}._`)
    }
    // Each ticket once, problems first, in the order of the groups above.
    const rank = (t: TicketOutcome) => Math.min(...t.groups.map((g) => OUTCOMES.findIndex((x) => x.id === g)))
    lines.push('', '### Tickets')
    for (const t of [...o.tickets].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))) {
        const tags = t.groups.map((g) => OUTCOMES.find((x) => x.id === g)!.title.toLowerCase()).join(', ')
        lines.push(`- **${t.key}** ${t.summary} (${t.type}, ${t.release}) [${tags}]: ${t.facts.map((f) => f.replace(/\.+$/, '')).join('; ')}.${t.verdict ? ` ${verdictText(t.verdict)}` : ''}`)
    }
    return lines.join('\n')
}

export function evidenceMarkdown(key: string): string | undefined {
    const release = ticketRelease(key)
    if (!release) return undefined
    const snap = snapshotsFor([release])[0]
    const raw = snap?.tickets.find((t) => t.key === key)
    if (!snap || !raw) return undefined
    const t = classify(raw, snap, latestVerdicts().get(key))
    const sc = t.link?.screen ? snap.screens[t.link.screen] : undefined
    const lines = [`## ${t.key}: ${t.summary}`, `${t.type} in release ${t.release} (${snap.date}). Measured ${snap.window.days} days before and after${snap.window.open ? ', still counting' : ''}. Jira: ${jiraUrl(t.key)}`]
    lines.push(`- **Groups:** ${t.groups.map((g) => OUTCOMES.find((x) => x.id === g)!.title).join(', ')}`)
    lines.push(`- **Linked to:** ${t.link ? `${nameOf(t.link.screen)}${t.link.event ? `, event ${t.link.event}` : ''}` : 'nothing'} (${t.link_source === 'person' ? `set by ${t.link_by}` : t.link_reason}).`)
    for (const f of t.facts) lines.push(`- ${f}`)
    if (t.weekly.length) lines.push(`- **Week by week:** ${t.weekly.map((w) => `${w.week}: ${w.n}`).join(', ')}`)
    if (sc && t.risk_owner) {
        for (const x of sc.support) lines.push(`- **${x.type} ${x.key}** (${day(x.created)}) "${x.summary}": ${x.text}`)
        for (const c of sc.survey.comments_after.slice(0, 8)) lines.push(`- **Survey** (${c.rating ?? 'no rating'}/5, ${c.client}, ${day(c.at)}): "${c.comment}"`)
    }
    for (const e of snap.new_errors.filter((e) => e.path === t.link?.screen)) lines.push(`- **New error** ${e.type}: ${e.message}. ${e.occurrences} times, ${e.clients} clients, first seen ${day(e.first_seen)}.${e.url ? ` ${e.url}` : ''}`)
    const history = verdictHistory(key)
    if (history.length) lines.push('', '### Verdicts', ...history.map((v) => `- ${day(v.at)} ${v.source}: **${v.verdict}**: ${v.reason}`))
    return lines.join('\n')
}

export function feedbackMarkdown(scope: Scope, screen?: string): string {
    const lines = [`## Client feedback: ${scope.label}${screen ? `, ${nameOf(screen)}` : ''}`, 'Support tickets and in-product survey answers in the days after each release, by screen.']
    for (const snap of snapshotsFor(scope.releases)) {
        const screens = Object.entries(snap.screens).filter(([p, v]) => (!screen || p === screen) && (v.support.length || v.survey.answers_after))
        if (!screens.length) continue
        lines.push('', `### ${snap.release} (${snap.date}, ${snap.window.days} days)`)
        for (const [p, v] of screens) {
            const sv = v.survey
            lines.push(`**${nameOf(p)}**: ${v.support.length} support tickets; survey rating ${sv.rating_before ?? '–'} → ${sv.rating_after ?? '–'} from ${sv.answers_after} answers (${sv.answers_before} before).`)
            for (const x of v.support) lines.push(`- ${x.type} ${x.key} (${day(x.created)}) "${x.summary}": ${x.text}`)
            for (const c of sv.comments_after) lines.push(`- Survey ${c.rating ?? '–'}/5 (${c.client}, ${day(c.at)}): "${c.comment}"`)
        }
    }
    if (lines.length === 2) lines.push('', 'No support tickets or survey answers in this scope.')
    return lines.join('\n')
}
