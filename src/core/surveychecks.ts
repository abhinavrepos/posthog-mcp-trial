// Checks a Lens survey against what the app really sent in the last days, so a survey that can never show is
// visible before launch instead of silently showing to no one (production, 2026-11):
//
// - A step names a dialog id, button or field nobody used. Reports open with dialog_id = their menu id
//   ("LinkListReqv" for Hedge Designation), not the dialog's own name (DlgHedgeDesigListReport) and not its
//   title, and the browser compares exactly, so such an "opens" step never matches. Close matches are suggested
//   from the ids, titles and labels that were seen.
// - The audience reads the client from an event property the app's events do not carry. Reval's client is part of
//   its user id (ENV|SITE|CLIENT|USER), not on its events, so with CLIENT_FROM_DISTINCT_ID=0 a survey limited to
//   clients matches nobody. The fix is suggested from the app event file's distinctIdParts.
//
// Everything here only adds warnings: nothing is refused, no survey or engine behaviour changes. Suggestions are
// the app's own vocabulary (dialog ids, titles, button labels); message texts and typed values are never read.
import type { AppEvents } from './appevents.ts'
import { appEvents } from './appevents.ts'
import { config } from './config.ts'
import { plainReason } from './jobhealth.ts'
import type { Row } from './posthog.ts'
import { stepSpecOf, surveyQuery, type LensChain, type Problem } from './surveys.ts'

export type EvidenceQuery = (query: string, values?: Record<string, unknown>) => Promise<Row[]>
export const EVIDENCE_DAYS = 30
const SINCE = 'timestamp > now() - toIntervalDay({days})' // surveyQuery turns this into the history window

interface Wanted { where: string; kind: 'opens' | 'closes' | 'button' | 'field' | 'dialog' | 'event'; value: string }

const n = (v: unknown) => Number(v) || 0
const fmt = (v: number) => v.toLocaleString('en-US')
// What may be quoted back: printable, bounded.
const shown = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80)
const quote = (s: string) => `"${shown(s)}"`

function tokens(s: string): string[] {
    return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase()
        .split(/[^a-z0-9]+/).filter((t) => t && t !== 'dlg')
}
function distance(a: string, b: string): number {
    a = a.slice(0, 64); b = b.slice(0, 64)
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
        const cur = [i]
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = cur
    }
    return prev[b.length]
}
/** 1 for the same text in another case; otherwise the better of spelling distance and shared words. */
export function similarity(want: string, candidate: string): number {
    const a = want.toLowerCase(), b = candidate.toLowerCase()
    if (!a || !b) return 0
    if (a === b) return 1
    const spelling = 1 - distance(a, b) / Math.max(a.length, b.length)
    const ta = tokens(want), tb = tokens(candidate)
    const hits = ta.filter((t) => tb.some((u) => u === t || (Math.min(t.length, u.length) >= 4 && (u.startsWith(t) || t.startsWith(u))))).length
    return Math.max(spelling, ta.length && tb.length ? hits / Math.max(ta.length, tb.length) : 0)
}
function closest(want: string, candidates: { label: string; keys: string[]; weight: number }[], max = 3): string[] {
    return candidates.map((c) => ({ c, score: Math.max(...c.keys.map((k) => similarity(want, k))) }))
        .filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score || b.c.weight - a.c.weight).slice(0, max).map((x) => x.c.label)
}
const didYouMean = (list: string[]) => (list.length ? ` Did you mean: ${list.join(', ')}?` : '')

function wantedOf(chain: LensChain, reg: AppEvents): Wanted[] {
    const out: Wanted[] = []
    const add = (steps: LensChain['steps'] | undefined, prefix: string) => (steps || []).forEach((st, i) => {
        const s = stepSpecOf(st, reg), where = `${prefix}[${i}]`
        if (s.opens) out.push({ where, kind: 'opens', value: s.opens })
        else if (s.closes) out.push({ where, kind: 'closes', value: s.closes })
        else if (s.button || s.field) {
            out.push({ where, kind: s.button ? 'button' : 'field', value: (s.button || s.field)! })
            if (s.dialog) out.push({ where, kind: 'dialog', value: s.dialog })
        } else if (s.event && s.event !== reg.events.screen && s.event !== reg.events.interaction) out.push({ where, kind: 'event', value: s.event })
    })
    add(chain.steps, 'steps')
    add(chain.resetOn, 'reset_on')
    return out
}

/** At least one warning says a step or the audience would not match (not only that the check was skipped). */
export const foundMismatch = (problems: Problem[]): boolean => problems.some((p) => !/^Lens could not check|so the steps could not be checked/.test(p.text))

/** Warnings for steps and an audience that recent events say can never match. Never throws: when PostHog cannot
 * answer, one warning says the check was skipped. */
export async function surveyEvidence(chain: LensChain, opts: { reg?: AppEvents | null; days?: number; query?: EvidenceQuery; timeoutMs?: number } = {}): Promise<Problem[]> {
    const reg = opts.reg === undefined ? appEvents() : opts.reg
    if (!reg || !chain || !Array.isArray(chain.steps)) return []
    const days = opts.days ?? EVIDENCE_DAYS
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            check(chain, reg, days, opts.query ?? surveyQuery),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), opts.timeoutMs ?? 20_000); timer.unref?.() }),
        ])
    } catch (e) {
        return [{ level: 'warning', where: 'steps', text: `Lens could not check the steps and audience against recent events (${plainReason(e)}). Check the dialog ids and button labels with describe_app_events.` }]
    } finally { clearTimeout(timer) }
}

async function check(chain: LensChain, reg: AppEvents, days: number, query: EvidenceQuery): Promise<Problem[]> {
    const problems: Problem[] = []
    const warn = (where: string, text: string) => problems.push({ level: 'warning', where, text })
    const P = (role: string) => reg.properties[role as keyof AppEvents['properties']]?.name
    const D = P('dialog'), N = P('dialogName'), A = P('action'), B = P('button')
    const wanted = wantedOf(chain, reg)
    const app = reg.app || 'the app'
    const msg = [...reg.dialogs.messages, ...reg.dialogs.notices]
    const since = `${days} days`

    const audience = chain.audience
    const clients = Array.isArray(audience?.clients) ? audience!.clients.filter((c) => typeof c === 'string').slice(0, 500) : []
    let total = -1
    if (clients.length) {
        let carried: string, client: string
        const sep = audience?.separator ?? '|', part = Number(audience?.distinctIdPart)
        if (typeof audience?.eventProperty === 'string' && /^[A-Za-z_$][\w$]{0,99}$/.test(audience.eventProperty)) {
            client = `toString(properties.${audience.eventProperty})`
            carried = `countIf(${client} != '')`
        } else if (Number.isInteger(part) && part >= 1 && part <= 9 && sep.length === 1 && !/['"\\\s]/.test(sep)) {
            client = `splitByChar('${sep}', toString(distinct_id))[${part}]`
            carried = `countIf(length(splitByChar('${sep}', toString(distinct_id))) >= ${part})`
        } else client = carried = ''
        if (client) {
            const [row] = await query(`SELECT count() AS n, ${carried} AS carried, countIf(lower(${client}) IN {clients}) AS chosen
                FROM events WHERE ${SINCE} AND event IN {events}`, { days, events: [reg.events.screen, reg.events.interaction], clients: clients.map((c) => c.toLowerCase()) })
            total = n(row?.n)
            const has = n(row?.carried), chosen = n(row?.chosen)
            if (total > 0 && audience?.eventProperty && has === 0) {
                const parts = reg.distinctIdParts || [], at = parts.indexOf('{client}')
                const fix = at >= 0
                    ? `${app}'s user ids carry the client as part ${at + 1} (${parts.join(config.properties.distinctIdSeparator)}): a Lens administrator should set CLIENT_FROM_DISTINCT_ID=${at + 1} in Lens's settings, then save this survey again so it reads the client from there.`
                    : 'A Lens administrator should set PROP_CLIENT_ID to the event property that carries the client, or CLIENT_FROM_DISTINCT_ID to the part of the user id that does, then save this survey again.'
                warn('clients', `The audience reads the client from the event property ${quote(audience.eventProperty)}, but none of ${app}'s ${fmt(total)} events in the last ${since} carry it, so this survey would show to no one. ${fix}`)
            } else if (total > 0 && audience?.eventProperty && has / total < 0.05) {
                warn('clients', `Only ${Math.max(1, Math.round((100 * has) / total))}% of ${app}'s events in the last ${since} carry the client property ${quote(audience.eventProperty)}; users whose events lack it never see this survey.`)
            } else if (total > 0 && !audience?.eventProperty && has === 0) {
                warn('clients', `None of the user ids in the last ${since} have a part ${part} when split on "${sep}", so this survey would show to no one. A Lens administrator should check CLIENT_FROM_DISTINCT_ID and DISTINCT_ID_SEPARATOR, then save this survey again.`)
            } else if (total > 0 && chosen === 0) {
                warn('clients', `None of the chosen clients had any ${app} events in the last ${since}, so nobody would see this survey now. Check the client ids with resolve_client.`)
            }
        }
    }
    if (!wanted.length) return problems
    if (total < 0) total = n((await query(`SELECT count() AS n FROM events WHERE ${SINCE} AND event IN {events}`, { days, events: [reg.events.screen, reg.events.interaction] }))[0]?.n)
    if (total === 0) {
        // Nothing arrived at all: the check cannot tell a wrong id from a quiet app (or events that stopped).
        warn('steps', `No ${app} events arrived in the last ${since}, so the steps could not be checked against real use.`)
        return problems
    }

    const dialogsWanted = wanted.filter((w) => w.kind === 'opens' || w.kind === 'closes' || w.kind === 'dialog')
    const open = reg.screenActions.open, close = reg.screenActions.close
    const seenDialogs = new Map<string, { names: Set<string>; opens: number; closes: number; n: number }>()
    if (dialogsWanted.length && D) {
        const rows = await query(`SELECT toString(properties.${D}) AS id, ${N ? `toString(properties.${N})` : "''"} AS name,
                ${A && open.length ? `countIf(toString(properties.${A}) IN {open})` : '0'} AS opens, ${A && close.length ? `countIf(toString(properties.${A}) IN {close})` : '0'} AS closes, count() AS n
            FROM events WHERE ${SINCE} AND event = {screen} GROUP BY id, name ORDER BY n DESC LIMIT 10000`, { days, screen: reg.events.screen, open, close })
        for (const r of rows) {
            const id = String(r.id ?? ''); if (!id) continue
            const d = seenDialogs.get(id) ?? { names: new Set<string>(), opens: 0, closes: 0, n: 0 }
            const name = String(r.name ?? '')
            if (name && name !== id && !/^unknown$/i.test(name)) d.names.add(name)
            d.opens += n(r.opens); d.closes += n(r.closes); d.n += n(r.n)
            seenDialogs.set(id, d)
        }
    }
    const missingDialogs = [...new Set(dialogsWanted.filter((w) => {
        const d = seenDialogs.get(w.value)
        return !d || (w.kind === 'opens' && !d.opens) || (w.kind === 'closes' && !d.closes)
    }).map((w) => w.value))]
    const workedIn = new Map<string, number>()
    if (missingDialogs.length && D) {
        for (const r of await query(`SELECT toString(properties.${D}) AS id, count() AS n FROM events WHERE ${SINCE} AND event = {interaction} AND toString(properties.${D}) IN {ids} GROUP BY id LIMIT 100`,
            { days, interaction: reg.events.interaction, ids: missingDialogs })) workedIn.set(String(r.id), n(r.n))
    }
    const dialogCandidates = (need: 'opens' | 'closes' | 'any') => [...seenDialogs].filter(([, d]) => need === 'any' || d[need] > 0)
        .map(([id, d]) => ({ label: `${shown(id)}${d.names.size ? ` (${[...d.names].slice(0, 2).map(quote).join(', ')})` : ''}`, keys: [id, ...d.names], weight: d.n }))

    const buttonsWanted = wanted.filter((w) => w.kind === 'button')
    let buttons: Map<string, number> | undefined
    if (buttonsWanted.length && B) {
        buttons = new Map()
        const skip = D && msg.length ? `AND toString(properties.${D}) NOT IN {msg}` : ''
        for (const r of await query(`SELECT toString(properties.${B}) AS v, count() AS n FROM events WHERE ${SINCE} AND event = {interaction} ${skip} GROUP BY v ORDER BY n DESC LIMIT 5000`,
            { days, interaction: reg.events.interaction, msg })) if (r.v) buttons.set(String(r.v), n(r.n))
    }
    // Fields (the action property) and event names also hold typed search text: only the exact values asked for are read.
    const exact = async (kind: 'field' | 'event') => {
        const list = [...new Set(wanted.filter((w) => w.kind === kind).map((w) => w.value.toLowerCase()))]
        const seen = new Map<string, number>()
        if (!list.length || (kind === 'field' && !A)) return seen
        const col = kind === 'field' ? `toString(properties.${A})` : 'event'
        for (const r of await query(`SELECT ${col} AS v, count() AS n FROM events WHERE ${SINCE} ${kind === 'field' ? 'AND event = {interaction}' : ''} AND lower(${col}) IN {list} GROUP BY v ORDER BY n DESC LIMIT 200`,
            { days, interaction: reg.events.interaction, list })) seen.set(String(r.v), n(r.n))
        return seen
    }
    const fields = await exact('field'), events = await exact('event')
    const otherCase = (want: string, seen: Map<string, number>) => [...seen.keys()].filter((v) => v !== want && v.toLowerCase() === want.toLowerCase()).slice(0, 3).map(quote)

    const said = new Set<string>()
    for (const w of wanted) {
        const key = `${w.where}|${w.kind}|${w.value}`
        if (said.has(key)) continue
        said.add(key)
        const d = seenDialogs.get(w.value)
        if (w.kind === 'opens' || w.kind === 'closes') {
            const verb = w.kind === 'opens' ? 'opened' : 'closed'
            if (d && (w.kind === 'opens' ? d.opens : d.closes)) continue
            const suggestions = closest(w.value, dialogCandidates(w.kind))
            if (workedIn.get(w.value) || d)
                warn(w.where, `Nobody ${verb} a dialog with the id ${quote(w.value)} in the last ${since}, although people work in it, so this step would never match. Reports and some lists open under their menu id (the ${D} on the ${reg.events.screen} event), not the dialog's own name or its title.${didYouMean(suggestions)}`)
            else
                warn(w.where, `Nobody ${verb} a dialog with the id ${quote(w.value)} in the last ${since}, so this step would never match. Steps need the dialog id (${D}), not its title; reports open under their menu id.${didYouMean(suggestions)}`)
        } else if (w.kind === 'dialog') {
            if (d || workedIn.get(w.value)) continue
            warn(w.where, `No events in a dialog with the id ${quote(w.value)} in the last ${since}, so this step would never match. Use the dialog id (${D}), not its title.${didYouMean(closest(w.value, dialogCandidates('any')))}`)
        } else if (w.kind === 'button' && buttons) {
            if (buttons.has(w.value)) continue
            const list = closest(w.value, [...buttons].map(([v, c]) => ({ label: quote(v), keys: [v], weight: c })))
            warn(w.where, `Nobody pressed a button labelled ${quote(w.value)} in the last ${since} (labels must match exactly, including case), so this step would never match.${didYouMean(list)}`)
        } else if (w.kind === 'field') {
            if (fields.has(w.value)) continue
            warn(w.where, `Nobody used a field labelled ${quote(w.value)} in the last ${since} (labels must match exactly, including case), so this step would never match.${didYouMean(otherCase(w.value, fields))}`)
        } else if (w.kind === 'event') {
            if (events.has(w.value)) continue
            warn(w.where, `No ${quote(w.value)} events arrived in the last ${since}, so this step would never match.${didYouMean(otherCase(w.value, events))}`)
        }
    }
    return problems
}
