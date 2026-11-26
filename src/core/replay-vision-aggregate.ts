/**
 * Cross-session aggregation (architecture "Cross-session aggregation and insight validator").
 *
 * Groups moments by canonical screen + visible element + workflow step + compatible behaviour
 * family, computes U (distinct affected users), N (users who reached the screen), sessions,
 * T (median time lost per affected user), A (abandoned users), severity and 2–5 citations in code.
 * The text is a deterministic template filled with those numbers; an LLM may later propose a
 * cause/fix, which goes through the same validator. Only validated drafts are returned.
 */
import { createHash } from 'node:crypto'
import { replayUrl } from './posthog.ts'
import type { Candidate, DetectorCode } from './replay-vision-detectors.ts'
import { BINARY_CODES, metricValue } from './replay-vision-metrics.ts'
import { binaryAnomaly, classifyMetric, classifySeverity, type Baseline, type Severity } from './replay-vision-severity.ts'
import { validateInsight, type InsightDraft, type Validation } from './replay-vision-validator.ts'

export interface Moment { session_id: string; user_id: string; candidate: Candidate; time_lost_ms: number; abandoned: boolean }
export interface Aggregate { id: string; draft: InsightDraft; rubric: Validation; members: Moment[]; severity_reason: string; family: string; signal: DetectorCode; text: string; reach_source: string; abandoned_users: number; calibrated: boolean; strength: number }
export interface Reach { users: number; sessions?: number; source: string; lower_bound?: boolean }
export interface AggregateOptions {
    /** Latest baselines keyed `${detector}|${screen}`; anomaly filtering applies only to calibrated rows. */
    baselines?: Map<string, Baseline & { rate?: number }>
    /** All-screen affected-session rate per binary detector, for the Wilson comparison. */
    allScreenRate?: Record<string, number>
    /** Analysed sessions that reached each screen in the window (Wilson denominator). */
    sessionsReached?: Map<string, number>
    scopeKey?: string
    version?: string
}

export const FAMILY: Record<DetectorCode, string> = {
    D4: 'validation', D7: 'field-returns', D3: 'error', D1: 'rage', D2: 'dead', D14: 'repeat', D10: 'wait', D5: 'abandon',
    D6: 'hesitation', D8: 'hesitation', D12: 'hesitation', D9: 'cursor', R1: 'loop', R2: 'reopen', S1: 'scroll', S2: 'scroll', S3: 'scroll', D15: 'idle',
}
/** §7 weights: candidate ordering hints within a severity band only. D14 has no weight until calibrated. */
export const WEIGHT: Record<DetectorCode, number> = { D5: 5, D4: 4, D3: 4, D10: 3, D1: 3, D2: 2, R1: 2, R2: 2, S3: 2, D6: 1, D7: 1, D12: 1, S1: 0.5, D8: 0.5, D9: 0.5, S2: 0, D14: 0, D15: 0 }
const WEAK = new Set<DetectorCode>(['D8', 'D9', 'S2', 'D15'])
/** Detectors whose single strong moment in one user may publish as a Low, one-citation insight. */
export const SINGLE_MOMENT_KINDS = new Set<DetectorCode>(['D1', 'D3', 'D4', 'D5'])
const sevRank: Record<Severity, number> = { High: 2, Medium: 1, Low: 0 }

export function humanScreen(key: string): string {
    if (key.startsWith('/')) return `page "${key}"`
    const [doc, kind, sub] = key.split(':')
    if (!kind) return key
    const name = (doc ?? '').replace(/\b\w/g, (c) => c.toUpperCase())
    return `${name} (${kind === 'new' ? 'new' : kind === 'form' ? 'saved form' : kind}${sub ? ', ' + sub : ''})`
}
const s = (ms: number) => (Math.abs(ms) < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`)
const range = (xs: number[], f: (x: number) => string = String) => { const v = xs.filter(Number.isFinite); if (!v.length) return '?'; const lo = f(Math.min(...v)), hi = f(Math.max(...v)); return lo === hi ? lo : `${lo}–${hi}` }
function median(values: number[]): number { const v = values.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return 0; const m = v.length >> 1; return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2 }
const num = (m: Moment, k: string) => Number(m.candidate.facts[k])

/** Behaviour / likely cause / fix for one family, from code-computed numbers only. */
function describe(family: string, g: Moment[], screen: string, el: string, U: number, sessions: number): { behaviour: string; cause: string; fix: string } {
    const where = humanScreen(screen)
    const users = `${U} user${U === 1 ? '' : 's'}`
    switch (family) {
        case 'validation': return {
            behaviour: `${users} clicked ${el} and got a visible validation error ${range(g.map((m) => num(m, 'cycles')))} times in a row, editing fields between attempts (${sessions} sessions, ${range(g.map((m) => num(m, 'span_ms')), s)} per loop)`,
            cause: `Likely cause: the requirement behind the validation error shown after ${el} is not visible before clicking, so the edits users make between attempts do not resolve it.`,
            fix: `Fix: on ${where}, validate the fields ${el} depends on inline as they are filled, and name the failing field next to ${el} instead of only in the error message.`,
        }
        case 'field-returns': return {
            behaviour: `${users} returned to the ${el} field ${range(g.map((m) => num(m, 'returns')))} times within one form attempt (${sessions} sessions)`,
            cause: `Likely cause: the value ${el} expects is unclear; users re-focused it ${range(g.map((m) => num(m, 'returns')))} times before moving on.`,
            fix: `Fix: show the expected format and an example directly under ${el} on ${where}, and validate ${el} on blur.`,
        }
        case 'error': {
            const kinds = [...new Set(g.map((m) => String(m.candidate.facts.error_kind)))].join('/')
            const visible = g.filter((m) => m.candidate.facts.visible_error === true).length
            return {
                behaviour: `${users} clicked ${el} and a ${kinds === 'network' ? 'failed request' : kinds === 'console' ? 'script error' : kinds + ' error'} followed within ${range(g.map((m) => num(m, 'delay_ms')), (x) => `${x} ms`)} (${sessions} sessions; visible error shown in ${visible})`,
                cause: `Likely cause: the action behind ${el} fails (${kinds} error recorded within 1 s of the click${visible ? ', with a visible error on screen' : ''}).`,
                fix: `Fix: trace the request ${el} sends on ${where}, fix the failure, and show a recoverable message at ${el} instead of failing silently.`,
            }
        }
        case 'rage': return {
            behaviour: `${users} clicked ${el} ${range(g.map((m) => num(m, 'clicks')))} times within ${range(g.map((m) => num(m, 'span_ms')), (x) => `${(x / 1000).toFixed(1)} s`)} at the same spot (${sessions} sessions)`,
            cause: `Likely cause: ${el} gives no immediate visible feedback, so users click it again (${range(g.map((m) => num(m, 'clicks')))} clicks, each within 1 s and 30 px of the last).`,
            fix: `Fix: give ${el} on ${where} an immediate pressed/disabled state and a progress indicator while its action runs.`,
        }
        case 'dead': return {
            behaviour: `${users} clicked ${el} and nothing on screen changed for 2.5 s (${g.length} clicks in ${sessions} sessions)`,
            cause: `Likely cause: ${el} looks clickable but does nothing in this state (no DOM change, scroll or navigation within 2.5 s of the click).`,
            fix: `Fix: either make ${el} act on ${where}, or disable it with a tooltip explaining what must happen first.`,
        }
        case 'repeat': return {
            behaviour: `${users} repeated ${el} ${g.length} times 1–10 s apart with no visible state change (${sessions} sessions)`,
            cause: `Likely cause: the first ${el} gave no visible confirmation, so users repeated it.`,
            fix: `Fix: confirm ${el} on ${where} with a visible state change or message.`,
        }
        case 'wait': return {
            behaviour: `${users} waited ${range(g.map((m) => num(m, 'wait_ms')), s)} (median ${s(median(g.map((m) => num(m, 'wait_ms'))))}) after ${el} before the screen responded (${sessions} sessions; ${g.reduce((a, m) => a + (num(m, 'inputs_during_wait') || 0), 0)} clicks/keys during the waits)`,
            cause: `Likely cause: the response to ${el} is slow (${[...new Set(g.map((m) => m.candidate.facts.signal === 'overlay' ? 'loading overlay stayed visible' : 'saved record appeared late'))].join('; ')} for ${range(g.map((m) => num(m, 'wait_ms')), s)}).`,
            fix: `Fix: profile the request behind ${el} on ${where}, bring it under 3 s, and show progress with an estimated time while it runs.`,
        }
        case 'abandon': {
            const after = g.filter((m) => m.candidate.facts.after_friction === true || m.candidate.facts.last_error === true).length
            return {
                behaviour: `${users} left the form after editing ${range(g.map((m) => num(m, 'edits')))} fields without saving; last field edited: ${el} (${sessions} sessions${after ? `, ${after} right after a validation error, error click or slow save` : ''})`,
                cause: after ? `Likely cause: friction on this form (visible validation error, error click or slow save recorded before leaving) stopped ${after} of ${g.length} attempts.` : `Likely cause: no friction signal was recorded before users left; the reason is not observable in the replay.`,
                fix: `Fix: on ${where}, keep a recoverable draft of the form and surface what blocks saving next to ${el}.`,
            }
        }
        case 'hesitation': {
            const help = g.filter((m) => m.candidate.kind === 'D12').length
            return {
                behaviour: `${users} paused ${range(g.filter((m) => m.candidate.kind === 'D6').map((m) => num(m, 'hesitation_ms')), s)} on ${el} before typing${help ? `, then opened Help/Search in ${help} cases` : ''} (${sessions} sessions)`,
                cause: `Likely cause: the label ${el} does not tell users what to enter; first input came ${range(g.filter((m) => m.candidate.kind === 'D6').map((m) => num(m, 'hesitation_ms')), s)} after focus.`,
                fix: `Fix: rename ${el} on ${where} to the term users expect and add a one-line description with an example under it.`,
            }
        }
        case 'loop': {
            const via = String(g[0]!.candidate.facts.via)
            return {
                behaviour: `${users} went from ${where} to ${humanScreen(via)} and straight back ${range(g.map((m) => num(m, 'loops')))} times in one task, staying ${range(g.map((m) => num(m, 'dwell_b_ms')), s)} on ${humanScreen(via)} (${sessions} sessions)`,
                cause: `Likely cause: information needed to finish ${where} is only shown on ${humanScreen(via)}, so users leave to look it up (${range(g.map((m) => num(m, 'loops')))} round trips per task).`,
                fix: `Fix: show the needed ${humanScreen(via)} details on ${where}, e.g. as a preview next to the linked field, so users need not leave the form.`,
            }
        }
        case 'reopen': return {
            behaviour: `${users} re-opened ${where} ${range(g.map((m) => num(m, 'reopens')))} times within one task (${sessions} sessions)`,
            cause: `Likely cause: ${where} does not keep what users need in view, so they reopen it ${range(g.map((m) => num(m, 'reopens')))} times.`,
            fix: `Fix: keep the state users return for visible on ${where} (pinned filters, recent records) instead of requiring a reopen.`,
        }
        case 'scroll': {
            const s3 = g.filter((m) => m.candidate.kind === 'S3')
            return {
                behaviour: `${users} scrolled ${range(g.map((m) => num(m, 'd_over_h')), (x) => x.toFixed(1))}× the visible height in ${el} with ${range(g.map((m) => num(m, 'reversals')))} direction reversals${s3.length ? ', without clicking or typing between reversals' : ''} (${sessions} sessions; page extent ≥ ${range(g.map((m) => num(m, 'page_lower_bound_px')), (x) => `${x} px`)})`,
                cause: `Likely cause: the target in ${el} on ${where} is hard to find by scrolling (${range(g.map((m) => num(m, 'reversals')))} up/down reversals of at least a quarter screen each, no search or filter used).`,
                fix: `Fix: on ${where}, put search/filter above ${el}, sort the most likely target first, and keep the list short by default.`,
            }
        }
        default: return { behaviour: `${users} had ${g.length} ${g[0]!.candidate.kind} moments at ${el}`, cause: '', fix: '' }
    }
}

/** Is a moment's metric anomalous against its calibrated per-screen baseline? Cold or binary metrics pass on their §7 floors. */
function anomalous(m: Moment, baselines: AggregateOptions['baselines']): { counted: boolean; band: string } {
    const c = m.candidate
    if (BINARY_CODES.has(c.kind)) return { counted: true, band: 'binary' }
    const b = baselines?.get(`${c.kind}|${c.screen}`)
    const r = b ? classifyMetric(metricValue(c), b, 0) : { band: 'anomalous', method: 'cold' as const, value: 0 }
    return { counted: r.band === 'anomalous', band: `${r.method}:${r.band}` }
}

export function aggregateInsights(moments: Moment[], reach: Map<string, Reach | { users: number; source: string }>, calibrated: Map<string, boolean>, opts: AggregateOptions = {}): Aggregate[] {
    const groups = new Map<string, Moment[]>()
    for (const m of moments) {
        const c = m.candidate
        if (c.screen === 'unknown_screen' || c.element === 'unknown_element' || c.step === 'unknown_step' || c.kind === 'D9') continue
        if (!anomalous(m, opts.baselines).counted) continue
        const key = [FAMILY[c.kind], c.screen, c.element, c.step].join('|')
        groups.set(key, [...(groups.get(key) ?? []), m])
    }
    const out: Aggregate[] = []
    for (const [key, group] of groups) {
        const kinds = new Set(group.map((m) => m.candidate.kind))
        if ([...kinds].every((k) => WEAK.has(k))) continue // supporting-only signals never publish alone
        if (kinds.has('S1') && !kinds.has('S3') && !(calibrated.get(group[0]!.candidate.screen) ?? false)) continue // S1 needs S3 or a calibrated anomaly
        const c = group[0]!.candidate, family = FAMILY[c.kind]
        const users = new Set(group.map((m) => m.user_id)), U = users.size
        const sessions = new Set(group.map((m) => m.session_id))
        // Single user: needs two moments in the session, or (orchestrator decision 2) one STRONG D1/D3/D4/D5 moment,
        // which may publish as Low with one citation. Weak/medium single moments stay unpublished.
        const singleMoment = U === 1 && sessions.size === 1 && new Set(group.map((m) => m.candidate.start_ms)).size === 1
        const strongSingle = singleMoment && group.some((m) => SINGLE_MOMENT_KINDS.has(m.candidate.kind) && m.candidate.strength === 'strong')
        if (U < 2 && (sessions.size !== 1 || (singleMoment && !strongSingle))) continue
        const r = reach.get(c.screen)
        const N = r && Number.isFinite(r.users) && r.users >= U ? r.users : null
        // Binary detectors: a calibrated screen must show a rate increase (Wilson lower bound above both comparison rates).
        const isCal = calibrated.get(c.screen) ?? false
        const bin = [...kinds].find((k) => BINARY_CODES.has(k))
        let rateNote = ''
        if (bin && isCal && opts.baselines && opts.sessionsReached) {
            const b = opts.baselines.get(`${bin}|${c.screen}`), total = opts.sessionsReached.get(c.screen) ?? 0
            if (b && total > 0) {
                const ok = binaryAnomaly(sessions.size, total, b.rate ?? 0, opts.allScreenRate?.[bin] ?? 0)
                rateNote = `; rate ${sessions.size}/${total} vs prior ${(100 * (b.rate ?? 0)).toFixed(0)}%: ${ok ? 'increase' : 'no increase'}`
                if (!ok) continue
            }
        }
        // T: per affected user, the sum of measured lost time; reported as the median over users.
        const lostByUser = new Map<string, number>()
        for (const m of group) lostByUser.set(m.user_id, (lostByUser.get(m.user_id) ?? 0) + Math.max(0, m.time_lost_ms))
        const T = median([...lostByUser.values()])
        const abandonedUsers = new Set(group.filter((m) => m.abandoned).map((m) => m.user_id)).size
        const signal = (['D5', 'D4', 'D3', 'R1', 'D10', 'D1', 'S3', 'D2', 'R2', 'D6', 'D7', 'D12', 'S1', 'D14', 'D8', 'S2', 'D15'] as DetectorCode[]).find((k) => kinds.has(k)) ?? c.kind
        const severity = classifySeverity({
            kind: signal, users_affected: U, users_reached: N, median_lost_ms: T, abandoned_users: abandonedUsers, calibrated: isCal,
            cycles: Math.max(0, ...group.map((m) => num(m, 'cycles') || 0)),
            loops: Math.max(0, ...group.map((m) => num(m, 'loops') || 0)),
            observed_rate_lower_bound: !!(r as Reach | undefined)?.lower_bound,
            corroborated: kinds.has('S3'),
            strong_error: group.some((m) => m.candidate.kind === 'D3' && (m.candidate.facts.visible_error === true || m.candidate.facts.first_of_kind === true)),
            weak_only: [...kinds].every((k) => WEAK.has(k)),
        })
        // Citations: one per session first (earliest), then extra moments, 2–5 in total.
        const ordered = [...group].sort((a, b) => a.candidate.start_ms - b.candidate.start_ms || a.session_id.localeCompare(b.session_id))
        // One citation per distinct (session, moment start): co-starting signals (e.g. S1/S2/S3) are one moment.
        const selected: Moment[] = [], used = new Set<string>(), at = new Set<string>()
        const citeKey = (m: Moment) => `${m.session_id}|${Math.floor(m.candidate.start_ms / 1000)}`
        for (const m of ordered) { if (selected.length === 5) break; if (!used.has(m.session_id) && !at.has(citeKey(m))) { selected.push(m); used.add(m.session_id); at.add(citeKey(m)) } }
        for (const m of ordered) { if (selected.length === 5) break; if (!at.has(citeKey(m))) { selected.push(m); at.add(citeKey(m)) } }
        const citations = selected.map((m) => ({ session_id: m.session_id, offset_ms: m.candidate.start_ms, event_ids: [m.candidate.event_ids[0]!], url: replayUrl(m.session_id, Math.floor(m.candidate.start_ms / 1000)), signal: m.candidate.kind }))
        const text = describe(family, group, c.screen, c.element, U, sessions.size)
        const limitations = [...new Set(group.flatMap((m) => m.candidate.limitations))].slice(0, 8)
        const strongShare = group.filter((m) => m.candidate.strength === 'strong').length / group.length
        const confidence: InsightDraft['confidence'] = U >= 3 && strongShare >= 0.5 && !limitations.length ? 'high' : U >= 2 ? 'med' : 'low'
        const lostText = T > 0 ? `median ${s(T)} lost per affected user` : 'no measurable time lost'
        const outcome = abandonedUsers ? `${abandonedUsers} of ${U} affected users abandoned the form without saving; ${lostText}` : `No abandonment observed; ${lostText}`
        const draft: InsightDraft = {
            screen: c.screen, element: c.element, behaviour: text.behaviour, users_affected: U, users_reached: N, sessions_affected: sessions.size, citations,
            outcome, time_lost_ms: T, cause: text.cause, fix: text.fix, signals: [...kinds].sort(), confidence, limitations, severity: severity.severity, single_session: U === 1, ...(strongSingle ? { single_moment: true } : {}),
        }
        const rubric = validateInsight(draft, group.map((m) => ({ session_id: m.session_id, candidate: m.candidate })))
        if (!rubric.valid) continue
        const id = createHash('sha256').update([opts.scopeKey ?? '', key, opts.version ?? ''].join('|')).digest('hex').slice(0, 24)
        const reachSource = r ? `${r.source}${(r as Reach).lower_bound ? ' (observed lower bound)' : ''}` : 'unknown'
        out.push({
            id, draft, rubric, members: group, family, signal, reach_source: reachSource, abandoned_users: abandonedUsers, calibrated: isCal,
            severity_reason: `${severity.reason}${rateNote}`, strength: Math.max(...[...kinds].map((k) => WEIGHT[k])),
            text: formatInsight(draft),
        })
    }
    // Rank: multi-user before single-session, then severity, users, abandonment, strength.
    return out.sort((a, b) => Number(a.draft.single_session) - Number(b.draft.single_session) || sevRank[b.draft.severity] - sevRank[a.draft.severity]
        || b.draft.users_affected - a.draft.users_affected || b.abandoned_users - a.abandoned_users || b.strength - a.strength || a.id.localeCompare(b.id))
}

/** The insight template: `[Screen] › [Element]: [n of N users / s sessions] [behaviour]; [outcome]. Likely cause … Fix … Evidence … Signals …` */
export function formatInsight(d: InsightDraft, formatUrl: (c: InsightDraft['citations'][number]) => string = (c) => c.url): string {
    const reach = d.single_session ? 'single session' : `${d.users_affected} of ${d.users_reached ?? 'unknown'} users / ${d.sessions_affected} sessions`
    const t = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
    const evidence = d.citations.map((c) => `${formatUrl(c)} @${t(c.offset_ms)}`).join(', ')
    return `[${d.severity}] ${humanScreen(d.screen)} › ${d.element}: ${reach}: ${d.behaviour.replace(/^\d+ users? /, '')}; ${d.outcome}. ${d.cause} ${d.fix} Evidence: ${evidence}. Signals: ${d.signals.join('+')}, confidence ${d.confidence}.`
}
