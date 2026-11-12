// The triage pipeline both entry points share: Jira webhooks and the MCP tools.
import { clientOfCodename, codenameOf, countBlock, hideClientsDeep, namesForCodenames, anonFor, syncClients } from './anonymise.ts'
import { SCREENS } from './catalog.ts'
import { renderClip, type Clip } from './clip.ts'
import { errorImpact, topErrorsOnScreen, type ErrorImpact } from './impact.ts'
import { bestPerSession, findIncidents, type Incident } from './incidents.ts'
import { clipUrl } from './links.ts'
import { replayUrl } from './posthog.ts'
import { resolveClient, type ClientMatch } from './resolve.ts'
import { isRising, suggestSeverity, type Severity } from './severity.ts'
import { struggleSessions, type StruggleSession } from './silent.ts'
import { parseTicket, type ParsedTicket, type Ticket } from './ticket.ts'
import { widen, type TimeWindow } from './timewindow.ts'
import { screenUsage, type ScreenUsage } from './usage.ts'

export interface ClipRef extends Clip {
    url: string
    replay_url: string
}

export interface TriageReport {
    ticket: { key: string; kind: Ticket['kind']; summary: string }
    understood: {
        client?: ClientMatch
        other_clients: ClientMatch[]
        screen?: { path: string; name: string }
        emails: string[]
        window: TimeWindow
        sources: ParsedTicket['sources']
        ai_used: boolean
    }
    search?: { step: string; window: TimeWindow }
    incident?: Incident
    other_sessions: Incident[]
    struggle?: StruggleSession
    clip?: ClipRef
    clip_error?: string
    impact?: ErrorImpact
    usage?: ScreenUsage
    // Risk reviews only: several replays across clients.
    risk?: { sessions: Incident[]; clips: ClipRef[] }
    severity: Severity
    hypothesis?: string
    notes: string[]
    elapsed_s: number
}

/** Optional AI helpers (src/core/ai.ts). Triage works without them. */
export interface TriageAi {
    readTicket?(t: Ticket, ctx: { clients: { id: string; name: string }[]; screens: { path: string; name: string }[] }): Promise<Partial<ParsedTicket> & { clientId?: string }>
    hypothesis?(r: TriageReport, frames: Buffer[]): Promise<string | undefined>
}

export interface TriageOptions {
    now?: Date
    ai?: TriageAi
    clip?: boolean // default true
    clipLengthS?: number // default 30
}

const screenName = (path?: string) => SCREENS.find((s) => s.path === path)?.name || path

async function clipFor(sessionId: string, offsetS: number, recordingLengthS: number, lengthS: number): Promise<ClipRef> {
    // Start a little before the moment so the clip shows what led up to it.
    const lead = Math.min(10, lengthS / 3)
    const start = Math.max(0, Math.min(offsetS - lead, recordingLengthS - lengthS))
    const duration = Math.max(5, Math.min(lengthS, recordingLengthS - start))
    const clip = await renderClip({ sessionId, startOffsetS: start, durationS: duration })
    return { ...clip, url: clipUrl(clip.name), replay_url: replayUrl(sessionId, start) }
}

/** A short, readable reason for a failed clip. The full error goes to the service log. */
function clipFailure(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'clip render failed', error: msg.slice(0, 2000) }))
    if (/No usable sandbox|Failed to launch the browser/.test(msg)) return 'The video clip could not be made: the clip renderer is not set up on this server yet. The replay link still works.'
    if (/no stored snapshots/i.test(msg)) return 'The video clip could not be made: the recording is still being saved. Try again in a minute. The replay link works.'
    return `The video clip could not be made (${msg.split('\n')[0].slice(0, 120)}). The replay link still works.`
}

const lengthOf = (r?: { start: string; end: string }) => (r ? (Date.parse(r.end) - Date.parse(r.start)) / 1000 : 0)

export async function triage(ticket: Ticket, opts: TriageOptions = {}): Promise<TriageReport> {
    const t0 = Date.now()
    const now = opts.now || new Date()
    const notes: string[] = []
    const parsed = parseTicket(ticket, now)
    let aiUsed = false
    let aiClientId: string | undefined

    if (opts.ai?.readTicket) {
        try {
            const { knownClients } = await import('./resolve.ts')
            const clients = (await knownClients()).map(({ id, name }) => ({ id, name }))
            // Client anonymisation (Admin → Client privacy for AI): Claude sees codenames only, and its answer
            // (a codename) is turned back into the client here.
            const anon = anonFor('triage')
            if (anon) syncClients(clients)
            const shown = anon ? clients.map((c) => { const code = codenameOf(c.id) || c.id; return { id: code, name: code } }) : clients
            const read = await opts.ai.readTicket(anon ? hideTicket(ticket) : ticket, { clients: shown, screens: SCREENS.map(({ path, name }) => ({ path, name })) })
            if (anon && read.clientId) read.clientId = clientOfCodename(read.clientId) || undefined
            aiUsed = true
            // Structured Jira fields stay on top; Claude's reading beats the keyword heuristics.
            if (read.clientId && parsed.sources.client !== 'field') {
                aiClientId = read.clientId
                parsed.sources.client = 'ai'
            }
            if (read.emails?.length && parsed.sources.email !== 'field') {
                parsed.emails = read.emails
                parsed.sources.email = 'ai'
            }
            if (read.screenPath && parsed.sources.screen !== 'field') {
                parsed.screenPath = read.screenPath
                parsed.sources.screen = 'ai'
            }
            if (read.window && parsed.sources.time !== 'field') {
                parsed.window = read.window
                parsed.sources.time = 'ai'
            }
        } catch (e) {
            notes.push(`Claude could not read the ticket, so keyword matching was used instead (${(e as Error).message}).`)
        }
    }

    const matches = await resolveClient({ text: parsed.screenText, emails: parsed.emails, clientHint: aiClientId || parsed.clientHint })
    const client = aiClientId ? matches.find((m) => m.id === aiClientId) || matches[0] : matches[0]
    const others = matches.filter((m) => m !== client).slice(0, 3)
    if (!client && ticket.kind === 'rci') notes.push('No client could be identified from the ticket. Add the client name or a user email.')
    if (client && client.confidence < 0.8) notes.push(`The client match is uncertain (${client.name}, ${Math.round(client.confidence * 100)}%). Check it.`)
    if (!parsed.screenPath) notes.push('The ticket does not say which screen. Results cover the whole app.')
    if (parsed.window.precision === 'none') notes.push('The ticket gives no time, so the last 7 days were searched.')

    const report: TriageReport = {
        ticket: { key: ticket.key, kind: ticket.kind, summary: ticket.summary },
        understood: {
            client,
            other_clients: others,
            screen: parsed.screenPath ? { path: parsed.screenPath, name: screenName(parsed.screenPath)! } : undefined,
            emails: parsed.emails,
            window: parsed.window,
            sources: parsed.sources,
            ai_used: aiUsed,
        },
        other_sessions: [],
        severity: { priority: 'P4', score: 0, reasons: [] },
        notes,
        elapsed_s: 0,
    }

    if (ticket.kind === 'risk') await riskReview(report, parsed, opts)
    else if (client) await clientIncident(report, parsed, client, now, opts)

    if (opts.ai?.hypothesis && (report.incident || report.struggle)) {
        try {
            // Event and error data only: replay frames never go to Claude.
            if (anonFor('triage')) {
                const h = hideClientsDeep(report)
                if (h.n) countBlock('triage_cleaned')
                const said = await opts.ai.hypothesis(h.value, [])
                // People read the hypothesis: codenames become the real names again.
                report.hypothesis = said && namesForCodenames(said)
            } else report.hypothesis = await opts.ai.hypothesis(report, [])
        } catch (e) {
            notes.push(`Claude could not suggest a cause (${(e as Error).message}).`)
        }
    }

    report.elapsed_s = (Date.now() - t0) / 1000
    return report
}

async function clientIncident(report: TriageReport, parsed: ParsedTicket, client: ClientMatch, now: Date, opts: TriageOptions) {
    const email = parsed.emails[0]
    // Widen step by step: the ticket's time, then ±12 h, then the week; filters drop last.
    const attempts: { window: TimeWindow; step: string; pathname?: string; email?: string }[] = []
    for (const w of widen(parsed.window, now)) attempts.push({ ...w, pathname: parsed.screenPath, email })
    if (parsed.screenPath || email) {
        const week = widen(parsed.window, now).at(-1)!
        attempts.push({ window: week.window, step: `${week.step}, any screen and user at ${client.name}` })
    }
    let found: Incident[] = []
    for (const a of attempts) {
        found = await findIncidents({ clientId: client.id, from: a.window.from, to: a.window.to, pathname: a.pathname, email: a.email, limit: 100 })
        if (found.length) {
            report.search = { step: a.step, window: a.window }
            break
        }
    }

    const ranked = bestPerSession(found)
    report.incident = ranked[0]
    report.other_sessions = ranked.slice(1, 5)
    const pathname = parsed.screenPath || report.incident?.pathname

    if (!report.incident) {
        // Nothing crashed. Look for a session where the user struggled.
        const w = widen(parsed.window, now).at(-1)!.window
        const struggles = await struggleSessions({ clientId: client.id, pathname, from: w.from, to: w.to })
        const preferred = struggles.find((s) => !email || s.user.toLowerCase() === email.toLowerCase()) || struggles[0]
        if (preferred) {
            report.struggle = preferred
            report.search = { step: 'sessions with struggle signals and no error', window: w }
        } else {
            report.notes.push(`No error, rage click or struggle signal was found for ${client.name} in the last 7 days.`)
        }
    }

    const recording = report.incident?.recording || report.struggle?.recording
    const sessionId = report.incident?.session_id || report.struggle?.session_id
    if (opts.clip !== false && recording && sessionId) {
        try {
            report.clip = await clipFor(sessionId, recording.offset_s, lengthOf(recording), opts.clipLengthS ?? 30)
        } catch (e) {
            report.clip_error = clipFailure(e)
            report.notes.push(report.clip_error)
        }
    } else if ((report.incident || report.struggle) && !recording) {
        report.notes.push('The matching session has no recording (recording may have been off, or it was sampled out).')
    }

    const [impact, usage] = await Promise.all([
        report.incident?.kind === 'exception'
            ? errorImpact({ issue_id: report.incident.issue_id, error_type: report.incident.error_type, error_message: report.incident.error_message }, { days: 30, pathname })
            : Promise.resolve(undefined),
        pathname ? screenUsage(pathname, { clientId: client.id, days: 30 }) : Promise.resolve(undefined),
    ])
    report.impact = impact
    report.usage = usage

    // A rage click right after the error in the same session means the user was stuck.
    const blocks = !!report.incident && found.some((i) => i.session_id === report.incident!.session_id && i.kind === 'rageclick')
    report.severity = suggestSeverity({
        hasError: report.incident?.kind === 'exception',
        clientsAffected: impact?.clients.length ?? (report.incident || report.struggle ? 1 : 0),
        usersAffected: impact?.users ?? (report.incident || report.struggle ? 1 : 0),
        occurrences: impact?.occurrences ?? 0,
        clientsUsingScreen: usage?.clients_using ?? 0,
        versionSpecific: impact && impact.by_version.length === 1 && impact.occurrences >= 3 ? impact.by_version[0].app_version : undefined,
        blocksTask: blocks || (report.struggle?.rageclicks ?? 0) > 0,
        rising: impact ? isRising(impact.daily) : false,
        enterpriseAffected: impact ? impact.clients.some((c) => c.plan === 'enterprise') : false,
        silent: !report.incident && !!report.struggle,
    })
}

async function riskReview(report: TriageReport, parsed: ParsedTicket, opts: TriageOptions) {
    const pathname = parsed.screenPath
    if (!pathname) {
        report.notes.push('A risk review needs a screen. Say which screen or feature the risk is about.')
        return
    }
    const errors = await topErrorsOnScreen(pathname, 14)
    const top = errors[0]
    const [impact, usage] = await Promise.all([
        top ? errorImpact(top, { days: 30, pathname }) : Promise.resolve(undefined),
        screenUsage(pathname, { days: 30 }),
    ])
    report.impact = impact
    report.usage = usage
    if (!top) report.notes.push(`No errors were recorded on ${screenName(pathname)} in the last 14 days.`)

    // One replay per affected client, most recent first.
    const sessions: Incident[] = []
    for (const c of impact?.clients.slice(0, 4) || []) {
        const inc = await findIncidents({ clientId: c.client_id, from: new Date(Date.now() - 14 * 86_400_000), to: new Date(), pathname, kinds: ['exception'], limit: 5 })
        const best = bestPerSession(inc).find((i) => i.recording)
        if (best) sessions.push(best)
    }
    const clips: ClipRef[] = []
    if (opts.clip !== false && sessions[0]?.recording) {
        try {
            clips.push(await clipFor(sessions[0].session_id, sessions[0].recording.offset_s, lengthOf(sessions[0].recording), opts.clipLengthS ?? 30))
        } catch (e) {
            report.notes.push(clipFailure(e))
        }
    }
    report.risk = { sessions, clips }
    report.incident = sessions[0]
    report.clip = clips[0]
    report.severity = suggestSeverity({
        hasError: !!top,
        clientsAffected: impact?.clients.length ?? 0,
        usersAffected: impact?.users ?? 0,
        occurrences: impact?.occurrences ?? 0,
        clientsUsingScreen: usage.clients_using,
        versionSpecific: impact && impact.by_version.length === 1 && impact.occurrences >= 3 ? impact.by_version[0].app_version : undefined,
        blocksTask: false,
        rising: impact ? isRising(impact.daily) : false,
        enterpriseAffected: impact ? impact.clients.some((c) => c.plan === 'enterprise') : false,
        silent: false,
    })
}

/** A ticket with every client name and code replaced by its codename (for Claude). */
function hideTicket(t: Ticket): Ticket {
    const h = hideClientsDeep(t)
    if (h.n) countBlock('triage_cleaned')
    return h.value
}
