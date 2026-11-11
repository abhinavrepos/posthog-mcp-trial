// One deterministic PM entry point. Queries stay here; composeBrief only reads supplied results.
import {
    appEvents, clientSignalsReport, columns, dialogFriction, dialogNames, findTrade,
    sessionStory, slowAttempts, toRaw, toSteps, topPains,
    type ClientSignalsResult, type FrictionResult, type PainsReport, type SessionStoryResult, type Step,
} from './appevents.ts'
import { hogql, replayUrl } from './posthog.ts'
import { recordingSpans } from './incidents.ts'
import { P } from './props.ts'
import { resolveClient, type ClientMatch } from './resolve.ts'
import { emailsIn } from './text.ts'
import { parseTimeWindow } from './timewindow.ts'

export interface BriefInput {
    question?: string
    client?: string
    dialog?: string
    trade?: string
    when?: string
    timezone?: string
}
export type BriefKind = 'trade' | 'client' | 'dialog' | 'general'
export interface BriefRoute { kind: BriefKind; target?: string; clientId?: string }
type Names = ReadonlyMap<string, { name?: string }>
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const whole = (text: string, phrase: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(phrase)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)

/** Require a full name/id (>= .95), with a .10 lead over the runner up; no arbitrary tie breaks. */
export function confidentClient(matches: ClientMatch[]): ClientMatch | undefined {
    const sorted = [...matches].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    return sorted[0]?.confidence >= 0.95 && (!sorted[1] || sorted[0].confidence - sorted[1].confidence >= 0.10 - 1e-9) ? sorted[0] : undefined
}

/** Trade > client > dialog > general. Longest whole dialog name wins, then code for stability. */
export function detectBriefKind(input: BriefInput, clients: ClientMatch[] = [], names: Names = new Map()): BriefRoute {
    const question = input.question || ''
    const trade = input.trade?.trim() || /\b(?:trade|link|id)\s*(?:id\s*)?[:#]?\s*(\d{3,15})\b/i.exec(question)?.[1]
    const client = confidentClient(clients)
    const clientId = client?.id
    if (trade) return { kind: 'trade', target: trade, clientId }
    if (input.client?.trim() || client) return { kind: 'client', target: client?.name || input.client!.trim(), clientId }
    if (input.dialog?.trim()) return { kind: 'dialog', target: input.dialog.trim() }
    const dialogs = [...names].flatMap(([code, v]) => [code, v.name].filter((v): v is string => !!v).map((label) => ({ code, label })))
        .filter(({ label }) => whole(question, label))
        .sort((a, b) => b.label.length - a.label.length || a.code.localeCompare(b.code))
    return dialogs[0] ? { kind: 'dialog', target: dialogs[0].code } : { kind: 'general' }
}

export function briefWindow(input: BriefInput, kind: BriefKind, now = new Date()) {
    const parsed = parseTimeWindow(input.when || input.question || '', now, input.timezone)
    return parsed.precision !== 'none' && parsed.to > parsed.from ? parsed :
        parseTimeWindow(`last ${kind === 'trade' ? 30 : 14} days`, now, input.timezone)
}

export interface Contribution { total: number; largest: number; users: number; blocked_users: number }
/** Count failed attempts, not raw clicks. Unknown identities never become a supposed single user. */
export function briefContributions(sessions: Step[][]): Record<string, Contribution> {
    const dialogs = new Map<string, { users: Map<string, number>; unknown: number; blocked: Set<string> }>()
    for (const steps of sessions) {
        const lastCompleted = new Map<string, number>()
        for (const s of steps) if (s.outcome === 'completed') lastCompleted.set(s.dialog, s.i)
        for (const s of steps.filter((s) => s.kind === 'submit' && s.outcome === 'error')) {
            let d = dialogs.get(s.dialog)
            if (!d) dialogs.set(s.dialog, d = { users: new Map(), unknown: 0, blocked: new Set() })
            const user = s.raw.user
            if (user) d.users.set(user, (d.users.get(user) || 0) + 1)
            else d.unknown++
            if (user && (lastCompleted.get(s.dialog) ?? -1) < s.i) d.blocked.add(user)
        }
    }
    return Object.fromEntries([...dialogs].map(([dialog, d]) => [dialog, {
        total: [...d.users.values()].reduce((a, b) => a + b, d.unknown),
        largest: Math.max(0, ...d.users.values()), users: d.users.size, blocked_users: d.blocked.size,
    }]))
}
export const oneUserDominates = (c?: Contribution) => !!c && c.total > 0 && c.largest > c.total / 2

export interface BriefResults {
    route: BriefRoute
    window: { from: string; to: string; label: string }
    question?: string
    pains?: PainsReport
    signals?: ClientSignalsResult
    friction?: FrictionResult
    previous?: FrictionResult
    timings?: Awaited<ReturnType<typeof slowAttempts>>
    trade?: Awaited<ReturnType<typeof findTrade>>
    stories?: SessionStoryResult[]
    contributions?: Record<string, Contribution>
    clientContributions?: Record<string, Contribution>
    links?: Record<string, string>
    limits?: string[]
}
export interface BriefFinding {
    kind: string
    title: string
    numbers: Record<string, number | null>
    clients: string[]
    evidence: { id: string; url?: string }[]
    detail: string
    next: string
    dialog?: string
    storyDialog?: string
    errorText?: string
    dominanceUnit?: string
    blocked: number
    repeats: number
    dominance?: Contribution
}
const short = (s: string, max = 130) => s.length > max ? s.slice(0, max - 1) + '…' : s
// Keep tool-provided text on one line and unable to create Markdown structure or terminate the data fence.
const plain = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/[\\`*_[\]<>#]/g, '').trim()
const uniq = (items: string[]) => [...new Set(items.filter(Boolean))].sort()

/** Breadth first, then independent blocked users, then repeats bounded per user. */
export function rankBriefFindings(findings: BriefFinding[]): BriefFinding[] {
    const blocked = (f: BriefFinding) => f.dominance ? f.dominance.blocked_users : Math.min(1, f.blocked)
    const repeats = (f: BriefFinding) => f.dominance ? Math.min(f.repeats, 3 * f.dominance.users) : Math.min(f.repeats, 3)
    return [...findings].sort((a, b) => b.clients.length - a.clients.length || blocked(b) - blocked(a) ||
        Number(oneUserDominates(a.dominance)) - Number(oneUserDominates(b.dominance)) || repeats(b) - repeats(a) || a.title.localeCompare(b.title))
}

/** First lines around the relevant error, never the full story or replay content. */
export function exampleSummary(story: SessionStoryResult, dialog?: string, errorText?: string): string {
    const error = story.errors.find((e) => errorText && e.text === errorText) || story.errors.find((e) => !dialog || e.dialog === dialog) || story.errors[0]
    const i = error ? story.story.findIndex((line) => line.includes(error.text)) : -1
    return (i >= 0 ? story.story.slice(Math.max(0, i - 1), i + 2) : [story.summary]).map((s) => short(plain(s), 140)).join(' / ')
}

export function briefFindings(r: BriefResults): BriefFinding[] {
    const base = (kind: string, title: string): BriefFinding => ({ kind, title: short(plain(title)), numbers: {}, clients: [], evidence: [], detail: '', next: '', blocked: 0, repeats: 0 })
    const days = (Date.parse(r.window.to) - Date.parse(r.window.from)) / 86_400_000
    const period = Number.isInteger(days) ? `the ${days} days before` : 'the equal-length period before'
    const comparison = (failed: number | null, attempts: number | null) => failed === null || attempts === null ? 'previous-period counts unavailable' : `against ${failed} of ${attempts} in ${period}`
    const pains = r.pains?.pains.map((p) => ({
        dialog: p.dialog, name: p.name, clients: p.clients_hit, failed: p.failed_attempts, attempts: p.attempts,
        before: p.before, blocked: p.stuck_sessions, repeats: p.retry_loops,
        error: p.main_error, sid: p.example?.session_id, url: p.replay_url,
    })) || r.friction?.dialogs.map((d) => {
        const b = r.previous?.dialogs.find((v) => v.dialog === d.dialog)
        const missing = !r.previous || r.previous.truncated
        return { dialog: d.dialog, name: d.name, clients: d.clients_with_errors, failed: d.outcomes.error, attempts: d.attempts,
            before: { failed_attempts: b?.outcomes.error ?? (missing ? null : 0), attempts: b?.attempts ?? (missing ? null : 0) },
            blocked: d.stuck_sessions, repeats: d.retry_loops, error: d.errors[0]?.text, sid: d.errors[0]?.example.session_id, url: undefined }
    }) || []
    let findings = rankBriefFindings(pains.filter((p) => p.failed || p.error || r.route.kind === 'dialog').map((p) => {
        const f = base('dialog', `${p.name}: ${p.failed ? 'failed attempts need attention' : p.error ? 'error messages need attention' : 'observed attempts'}.`)
        Object.assign(f, { dialog: p.dialog, storyDialog: p.name, errorText: p.error, clients: p.clients, blocked: p.blocked, repeats: p.repeats, dominance: r.contributions?.[p.dialog] })
        f.numbers = { failed: p.failed, attempts: p.attempts, before_failed: p.before.failed_attempts, before_attempts: p.before.attempts, stuck_sessions: p.blocked, retries: p.repeats }
        f.detail = `${p.failed} of ${p.attempts} attempts failed, ${comparison(p.before.failed_attempts, p.before.attempts)}. ${p.blocked} sessions had an error without later success or acceptance; ${p.repeats} retries.`
        if (p.error) f.detail += ` Message: “${short(plain(p.error), 130)}”.`
        if (p.sid) f.evidence = [{ id: p.sid, url: p.url || r.links?.[p.sid] }]
        f.next = p.error && /designate a risk/i.test(p.error) ? 'Check whether “Please designate a risk” names the field people actually change.' :
            p.sid ? `Look at session ${plain(p.sid)} with session_story to check what prevented completion.` : `Check the outcome messages in ${short(plain(p.name), 60)}.`
        return f
    })).slice(0, 3)

    const signals = r.signals?.clients.filter((c) => c.signals.length || r.route.kind === 'client').slice(0, 3) || []
    if (signals.length) {
        const f = base('client', signals.length === 1 ? `${signals[0].client}: ${signals[0].signals.length ? 'usage or error signals need a check' : 'no configured warning signal'}.` : 'Clients with warning signals need a check.')
        f.clients = signals.map((c) => c.client)
        f.detail = signals.map((c, i) => {
            for (const [k, v] of Object.entries({ sessions: c.now.sessions, before_sessions: c.before.sessions, errors: c.now.errors, attempts: c.now.attempts, before_errors: c.before.errors, before_attempts: c.before.attempts })) f.numbers[`${i}_${k}`] = v
            const users = r.clientContributions?.[c.client]
            if (users) {
                f.numbers[`${i}_largest_user_sessions`] = users.largest
                f.numbers[`${i}_sampled_sessions`] = users.total
            }
            const concentrated = oneUserDominates(users) ? ` One user accounts for ${users!.largest} of ${users!.total} sampled sessions.` :
                c.now.users.length === 1 && c.now.sessions ? ` One user accounts for all ${c.now.sessions} current sessions.` : ''
            const reason = c.signals[0]?.includes('attempt') ? 'Error messages per attempt crossed a warning threshold' : c.signals[0] || 'No warning threshold crossed'
            return `${short(plain(c.client), 40)}: ${c.now.sessions} sessions against ${c.before.sessions} in ${period}; ${c.now.errors} error messages in ${c.now.attempts} attempts, against ${c.before.errors} in ${c.before.attempts}. ${short(plain(reason), 95)}.${concentrated}`
        }).join(' ')
        f.next = `Check with ${short(plain(f.clients[0]), 60)} whether their workload or access changed.`
        f.evidence = findings.filter((d) => d.clients.some((c) => f.clients.includes(c))).flatMap((d) => d.evidence).slice(0, 1)
        // Preserve one signal finding even when three dialogs need attention.
        findings = [...findings.slice(0, 2), f]
    }
    if (r.timings?.attempts.length) {
        const t = r.timings.attempts[0]
        const f = base('timing', `${t.name}: sampled ${t.button} server waits.`)
        f.numbers = { http_errors: t.http_errors, attempts: t.attempts, median_wait_s: t.median_wait_s, p90_wait_s: t.p90_wait_s, sessions_read: r.timings.sessions_read }
        f.clients = t.clients
        f.detail = `${t.http_errors} of ${t.attempts} sampled attempts had HTTP errors; median wait ${t.median_wait_s}s, p90 ${t.p90_wait_s}s. Read ${r.timings.sessions_read} recorded sessions in this window; previous timing comparison unavailable.`
        if (t.example) f.evidence = [{ id: t.example.session_id, url: t.example.replay_url }]
        f.next = `Inspect the calls behind ${short(plain(t.button), 35)} with attempt_timings.`
        findings = [...findings.slice(0, 2), f]
    }
    if (r.trade) {
        const hits = r.trade.sessions
        const attempts = hits.flatMap((h) => h.attempts_after)
        const failed = attempts.filter((a) => a.outcome === 'error').length
        const completed = attempts.filter((a) => a.outcome === 'completed').length
        const queued = attempts.filter((a) => a.outcome === 'accepted').length
        const f = base('trade', `Trade/link ${r.trade.id}: ${hits.length ? 'recorded activity found' : 'no matching session found'}.`)
        f.numbers = { sessions: hits.length, failed, attempts: attempts.length, completed, queued }
        f.clients = uniq(hits.map((h) => h.client))
        const users = new Map<string, number>()
        for (const h of hits) if (h.user) users.set(h.user, (users.get(h.user) || 0) + 1)
        f.dominance = { total: hits.length, largest: Math.max(0, ...users.values()), users: users.size, blocked_users: 0 }
        f.dominanceUnit = 'returned sessions'
        f.evidence = [...hits].sort((a, b) => Number(!!b.errors_after.length) - Number(!!a.errors_after.length)).slice(0, 2).map((h) => ({ id: h.session_id, url: h.replay_url }))
        f.detail = `${failed} of ${attempts.length} returned attempts failed; ${completed} completed and ${queued} queued across ${hits.length} returned sessions. Previous period not queried.`
        const error = hits.flatMap((h) => h.errors_after)[0]
        if (error) f.detail += ` Message: “${short(plain(error.text))}”.`
        f.next = f.evidence[0] ? `Look at session ${plain(f.evidence[0].id)} with session_story.` : 'Check the trade/link id and ask about a wider time window.'
        findings = [f]
    }
    return findings
}

/** Pure tool-result -> Markdown, with the same selected findings in a machine-readable block. */
export function composeBrief(r: BriefResults): string {
    const findings = briefFindings(r)
    const limits = [...(r.limits || [])]
    if (r.friction?.truncated || r.previous?.truncated) limits.push('The event row cap was reached; counts may be incomplete.')
    if (!findings.length) limits.push('No matching findings returned; that does not prove there were no problems.')
    if (findings.some((f) => Object.entries(f.numbers).some(([key, value]) => /^(?:\d+_)?(?:before_)?(?:attempts|sessions)$/.test(key) && value !== null && value < 5))) limits.push('Little data: fewer than 5 attempts or sessions in a finding; changes can swing.')
    if (findings.some((f) => f.evidence.some((e) => !e.url)) || !findings.some((f) => f.evidence.length)) limits.push('Some evidence has no recording or session link available.')
    if (r.timings && !r.timings.attempts.length) limits.push('No usable recording timings; speed could not be checked.')
    if (r.timings?.attempts.length) limits.push('Timings sample at most 6 recent recordings; a nearby server call is not proven to have been started by the button.')
    if (r.route.kind !== 'trade') limits.push('Per-user concentration is based on a capped event read; missing identities cannot establish breadth.')
    if (r.route.kind === 'trade') limits.push('Returned trade sessions/attempts are capped; unnamed errors are associated with this trade, not proven to concern it.')
    limits.push('A queued report is not a finished one. No message is not a failure.')
    if (r.signals) limits.push('Less use is a warning sign, not proof a client will leave. Client error messages are not necessarily failed attempts.')
    if (/\brelease|\bship|\bdeploy|\bversion/i.test(r.question || '')) limits.push('A change after a release is associated, not proven caused; this brief does not isolate a release effect.')
    const followups = r.route.kind === 'trade' ? ['Did this trade eventually save?', 'What happened in the example session?'] :
        r.route.kind === 'client' ? ['Where is this client getting stuck?', 'Is it the same people each time?'] :
        r.route.kind === 'dialog' ? ['Which clients get stuck here?', 'What do people change after the error?'] :
        ['Which client needs a check first?', 'What do people change after the main error?', 'Is this happening more often?']
    const title = `# Reval brief${r.route.target ? `: ${short(plain(r.route.target), 80)}` : ''} — ${short(plain(r.window.label), 65)}`
    const render = (selected: BriefFinding[], compact: boolean) => {
        const cards = selected.map((f, i) => {
            const story = r.stories?.find((s) => f.evidence.some((e) => e.id === s.session_id))
            const dominance = oneUserDominates(f.dominance) ? ` One user accounts for ${f.dominance!.largest} of ${f.dominance!.total} ${f.dominanceUnit || 'failed attempts'}; this is concentrated.` : ''
            const evidence = f.evidence.map((e) => e.url && /^https?:\/\//.test(e.url) ? `[${plain(e.id)}](${e.url.replace(/[\s()<>]/g, (v) => encodeURIComponent(v))})` : plain(e.id)).join(', ') || 'no example session returned'
            return `${i + 1}. ${f.title}\n   ${f.detail}${dominance}\n   Clients hit: ${f.clients.slice(0, 6).map((c) => short(plain(c), 40)).join(', ') || 'none identified'}${f.clients.length > 6 ? ` (of ${f.clients.length}; rest in data)` : ''}.\n   Evidence: ${evidence}.${story && (!compact || i === 0) ? ` Example: ${short(exampleSummary(story, f.storyDialog, f.errorText), compact ? 220 : 430)}.` : ''}\n   Next step: ${f.next}`
        })
        const data = selected.map(({ kind, title, numbers, clients, evidence, dominance }) => ({ kind, title, numbers, clients, evidence_ids: evidence.map((e) => e.id), ...(oneUserDominates(dominance) ? { one_user: { count: dominance!.largest, total: dominance!.total } } : {}) }))
        // Escape < so event text cannot spoof the marker; valid JSON remains valid.
        const json = JSON.stringify({ kind: r.route.kind, window: r.window, findings: data }).replace(/</g, '\\u003c')
        return `${title}\n\n## What needs attention\n\n${cards.join('\n\n') || 'No finding to rank.'}\n\n## What I could not tell\n\n${uniq(limits).join(' ')}\n\nAsk next: ${followups.map((q) => `“${q}”`).join(' ')}\n\n<!-- data -->\n\`\`\`json\n${json}\n\`\`\``
    }
    let selected = findings
    let output = render(selected, false)
    if (output.length <= 4000) return output
    output = render(selected, true)
    // Remove whole low-priority cards and their data together; never cut JSON or counts mid-line.
    while (output.length > 4000 && selected.length > 1) {
        if (selected.length === findings.length) limits.push('Fewer findings shown to fit; ask for the underlying reports for more.')
        selected = selected.length === 3 ? [selected[0], selected[2]] : selected.slice(0, -1)
        output = render(selected, true)
    }
    // Pathological identifiers/URLs/client lists: retain counts and one evidence id; say what was cut.
    if (output.length > 4000) {
        limits.push('Long evidence/client lists were shortened to fit; ask for the underlying report.')
        selected = selected.map((f) => ({ ...f, title: short(f.title, 90), detail: short(f.detail, 550), next: short(f.next, 120), clients: f.clients.filter((c) => c.length <= 100).slice(0, 1), evidence: f.evidence.filter((e) => e.id.length <= 100).slice(0, 1).map((e) => ({ id: e.id })) }))
        output = render(selected, true)
    }
    return output
}

/** Bounded event-only read for concentration. Uses exactly the event vocabulary's safe columns. */
async function contributions(from: Date, to: Date, clientId?: string) {
    const reg = appEvents()!
    const rows = await hogql(`SELECT ${columns(reg)} FROM events
        WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}
        AND ({client} = '' OR toString(${P.client}) = {client})
        AND notEmpty(toString(properties.$session_id))
        ORDER BY sid, ts LIMIT 50000`, {
        from: from.toISOString(), to: to.toISOString(), events: [reg.events.screen, reg.events.interaction], client: clientId || '',
    })
    const sessions = new Map<string, ReturnType<typeof toRaw>[]>()
    for (const row of rows) {
        const raw = toRaw(row)
        if (!sessions.has(raw.sid)) sessions.set(raw.sid, [])
        sessions.get(raw.sid)!.push(raw)
    }
    const clients = new Map<string, Map<string, Set<string>>>()
    for (const [sid, events] of sessions) {
        for (const e of events) {
            if (!e.client) continue
            if (!clients.has(e.client)) clients.set(e.client, new Map())
            const users = clients.get(e.client)!
            if (!users.has(e.user || '')) users.set(e.user || '', new Set())
            users.get(e.user || '')!.add(sid)
        }
    }
    const clientCounts = Object.fromEntries([...clients].map(([client, users]) => [client, {
        total: new Set([...users.values()].flatMap((sids) => [...sids])).size,
        largest: Math.max(0, ...[...users].filter(([user]) => !!user).map(([, sids]) => sids.size)),
        users: [...users.keys()].filter(Boolean).length, blocked_users: 0,
    }]))
    return { counts: briefContributions([...sessions.values()].map((s) => toSteps(s, reg))), clientCounts, truncated: rows.length >= 50000 }
}

// Injectable data functions let orchestration be tested without a PostHog or a recording.
export const briefSources = { resolveClient, dialogNames, topPains, clientSignalsReport, dialogFriction, slowAttempts, findTrade, sessionStory, recordingSpans, contributions }
export async function revalBrief(input: BriefInput, sources = briefSources, now = new Date()): Promise<string> {
    const limits: string[] = []
    const optional = async <T>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
        try { return await work() } catch { limits.push(`${label} unavailable.`); return undefined }
    }
    const provisional = detectBriefKind(input)
    const win = briefWindow(input, provisional.kind, now)
    const matches = input.client || input.question ? await optional('Client resolution', () => sources.resolveClient({ text: input.client || input.question || '', clientHint: input.client, emails: emailsIn(input.client || input.question || '') })) : []
    // An explicit client must never silently become an all-client query.
    if (input.client && !confidentClient(matches || [])) throw new Error(`No unambiguous client matches “${input.client}”. Use its full name or id.`)
    const names = provisional.kind !== 'trade' && !input.client && !confidentClient(matches || []) ?
        await optional('Dialog names', () => sources.dialogNames(win.from, win.to)) : undefined
    const route = detectBriefKind(input, matches, names)
    if (matches?.length && !confidentClient(matches)) limits.push('Client name matches were uncertain; no client filter was applied.')
    const r: BriefResults = { route, question: input.question, window: { from: win.from.toISOString(), to: win.to.toISOString(), label: win.label }, limits }
    const q = { from: win.from, to: win.to, clientId: route.clientId }
    if (route.kind === 'trade') {
        r.trade = await optional('Trade lookup', () => sources.findTrade({ ...q, id: route.target!, limit: 10 }))
    } else {
        const previousFrom = new Date(win.from.getTime() - (win.to.getTime() - win.from.getTime()))
        const reports = await Promise.all([
            route.kind === 'general' ? optional('Top pains', () => sources.topPains({ ...q, max: 3 })) : Promise.resolve(undefined),
            route.kind !== 'dialog' ? optional('Client signals', () => sources.clientSignalsReport({ ...q, limit: 100 })) : Promise.resolve(undefined),
            route.kind !== 'general' ? optional('Dialog friction', () => sources.dialogFriction({ ...q, dialog: route.kind === 'dialog' ? route.target : undefined, limit: 200 })) : Promise.resolve(undefined),
            route.kind !== 'general' ? optional('Previous dialog friction', () => sources.dialogFriction({ ...q, from: previousFrom, to: win.from, dialog: route.kind === 'dialog' ? route.target : undefined, limit: 200 })) : Promise.resolve(undefined),
            optional('Per-user counts', () => sources.contributions(q.from, q.to, q.clientId)),
            route.kind === 'dialog' ? optional('Attempt timings', () => sources.slowAttempts({ ...q, dialog: route.target, sessions: 6 })) : Promise.resolve(undefined),
        ])
        const [pains, signals, friction, previous, users, timings] = reports
        Object.assign(r, { pains, signals, friction, previous, contributions: users?.counts, clientContributions: users?.clientCounts, timings })
        if (users?.truncated) limits.push('Per-user event read reached 50,000 rows; concentration and counts may be incomplete.')
        if (route.kind === 'general') limits.push('Top-pain event reads are capped at 50,000 rows per period; completeness is not exposed by top_pains.')
    }
    const findings = briefFindings(r)
    const evidence = findings.flatMap((f) => f.evidence)
    const spans = evidence.length ? await optional('Recording links', () => sources.recordingSpans(uniq(evidence.map((e) => e.id)))) : undefined
    r.links = Object.fromEntries(evidence.flatMap((e) => spans?.has(e.id) ? [[e.id, replayUrl(e.id, 0)]] : []))
    const sid = evidence[0]?.id
    if (sid) {
        // Read up to the core's 5,000-event cap so late errors can be excerpted; return only a few lines.
        const story = await optional('Example session', () => sources.sessionStory(sid, { maxLines: 5000 }))
        if (story) r.stories = [story]
    }
    return composeBrief(r)
}
