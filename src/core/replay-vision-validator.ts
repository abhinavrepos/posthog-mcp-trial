/**
 * Insight rubric (research §9, applied literally): C1–C9 scored 0–2; valid only with ≥14/18, no 0
 * on C1–C4, valid citations and no generic or unsupported text. Code fills counts and links; this
 * checks every cited event id, offset, detector, screen and element against stored evidence, so a
 * template or an LLM proposal can never publish an invented moment.
 */
import type { Candidate, DetectorCode } from './replay-vision-detectors.ts'
import type { Severity } from './replay-vision-severity.ts'

export interface Citation { session_id: string; offset_ms: number; event_ids: string[]; url: string; signal?: string }
export interface InsightDraft {
    screen: string; element: string; behaviour: string; users_affected: number; users_reached: number | null; sessions_affected: number
    citations: Citation[]; outcome: string; time_lost_ms: number; cause: string; fix: string; signals: string[]
    confidence: 'high'|'med'|'low'; limitations: string[]; severity: Severity; single_session?: boolean
    /** One strong D1/D3/D4/D5 moment in one session: the only case where one citation suffices, and only at Low. */
    single_moment?: boolean
}
export interface Validation { valid: boolean; score: number; criteria: Record<string, number>; reasons: string[] }
export interface ScopedEvidence { session_id: string; candidate: Candidate }

/** Generic or emotional claims that fail the rubric whatever else is present. */
export const GENERIC = /\b(users? (?:were|are|was|felt|feel|seemed|seem|experienced|experience|got) (?:frustrat\w*|confus\w*|annoy\w*|lost|stuck)|frustrat(?:ed|ion)|confus(?:ed|ion)|struggl\w*|improve (?:the )?(?:ux|user experience|usability)|make (?:it|this|things) (?:clearer|easier|better)|better ux|a (?:field|button)\b|some users|many users|various)\b/i
/** Facts that ground a "likely cause" for each detector (C7). */
const GROUNDED: Partial<Record<DetectorCode, (f: Candidate['facts']) => boolean>> = {
    D1: (f) => Number(f.clicks) >= 3,
    D2: (f) => Number(f.response_window_ms) >= 2500,
    D3: (f) => typeof f.error_kind === 'string' && (f.visible_error === true || f.first_of_kind === true),
    D4: (f) => Number(f.cycles) >= 2,
    D5: (f) => f.after_friction === true || f.last_error === true,
    D6: (f) => Number(f.hesitation_ms) >= 3000,
    D7: (f) => Number(f.returns) >= 3,
    D10: (f) => Number(f.wait_ms) > 3000,
    D12: (f) => typeof f.after === 'string',
    R1: (f) => Number(f.loops) >= 1 && typeof f.via === 'string',
    R2: (f) => Number(f.reopens) >= 3,
    S3: (f) => Number(f.reversals) >= 3 || Number(f.d_over_p_before_click) >= 2,
    D14: (f) => typeof f.pattern === 'string',
}
const GENERATED_ID = /^\d+$|^ext-|^ext-comp|^[a-f0-9]{8,}$|^:|^#/i

export function validateInsight(d: InsightDraft, evidence: Candidate[] | ScopedEvidence[]): Validation {
    const c: Record<string, number> = {}, reasons: string[] = []
    const list: ScopedEvidence[] = (evidence as (Candidate | ScopedEvidence)[]).map((x) => ('candidate' in x ? x : { session_id: '', candidate: x }))
    const scoped = list.some((x) => x.session_id !== '')
    const byId = new Map<string, Candidate[]>()
    for (const x of list) for (const id of x.candidate.event_ids) { const k = `${scoped ? x.session_id : ''}|${id}`; byId.set(k, [...(byId.get(k) ?? []), x.candidate]) }
    const oneCitationAllowed = d.single_moment === true && d.single_session === true && d.users_affected === 1 && d.severity === 'Low' && d.signals.every((k) => ['D1', 'D3', 'D4', 'D5'].includes(k))
    const minCitations = oneCitationAllowed ? 1 : 2
    const citationOk = d.citations.length >= minCitations && d.citations.length <= 5 && d.citations.every((x) => {
        let urlOk = false
        try { const url = new URL(x.url); urlOk = (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname.includes(encodeURIComponent(x.session_id)) && url.searchParams.get('t') === String(Math.floor(x.offset_ms / 1000)) } catch {}
        return urlOk && x.event_ids.length > 0 && x.event_ids.every((id) => (byId.get(`${scoped ? x.session_id : ''}|${id}`) ?? []).some((ev) =>
            ev.screen === d.screen && ev.element === d.element && d.signals.includes(ev.kind) && (!x.signal || x.signal === ev.kind) && x.offset_ms >= ev.start_ms - 1000 && x.offset_ms <= ev.end_ms + 1000))
    })
    const distinct = new Set(d.citations.map((x) => `${x.session_id}|${x.offset_ms}`)).size
    const text = `${d.behaviour} ${d.cause} ${d.fix} ${d.outcome}`
    c.C1 = d.screen && d.screen !== 'unknown_screen' ? 2 : 0
    c.C2 = d.element && d.element !== 'unknown_element' && !GENERATED_ID.test(d.element) ? 2 : 0
    c.C3 = /\d/.test(d.behaviour) && d.behaviour.includes(d.element) && !GENERIC.test(d.behaviour) ? 2 : /\d/.test(d.behaviour) && !GENERIC.test(d.behaviour) ? 1 : 0
    c.C4 = d.users_affected >= 1 && d.sessions_affected >= 1 && ((d.users_reached !== null && d.users_reached >= d.users_affected) || (d.single_session === true && d.users_affected === 1)) ? 2 : d.users_affected >= 2 ? 1 : 0
    c.C5 = citationOk && distinct >= minCitations && (!d.single_session || new Set(d.citations.map((x) => x.session_id)).size === 1) && (d.single_session || d.users_affected < 2 || new Set(d.citations.map((x) => x.session_id)).size >= 2) ? 2 : 0
    c.C6 = d.outcome && Number.isFinite(d.time_lost_ms) && /\d|No abandonment/.test(d.outcome) ? 2 : d.outcome ? 1 : 0
    const grounded = list.some((x) => d.signals.includes(x.candidate.kind) && (GROUNDED[x.candidate.kind]?.(x.candidate.facts) ?? false))
    c.C7 = /^Likely cause:/i.test(d.cause) && !GENERIC.test(d.cause) && grounded && /\d|visible|overlay|error|only shown/i.test(d.cause) ? 2 : /^Likely cause:/i.test(d.cause) && !GENERIC.test(d.cause) ? 1 : 0
    c.C8 = /^Fix:/i.test(d.fix) && d.fix.includes(d.element) && !GENERIC.test(d.fix) ? 2 : /^Fix:/i.test(d.fix) && !GENERIC.test(d.fix) ? 1 : 0
    c.C9 = d.signals.length > 0 && ['high', 'med', 'low'].includes(d.confidence) && Array.isArray(d.limitations) ? 2 : 0
    if (!citationOk) reasons.push('invalid_citation')
    if (GENERIC.test(text)) reasons.push('generic_claim')
    if (/@|https?:\/\/(?!\S*\/replay\/)/.test(`${d.behaviour} ${d.cause} ${d.fix}`)) reasons.push('personal_or_url_text')
    const score = Object.values(c).reduce((a, b) => a + b, 0)
    return { valid: score >= 14 && ['C1', 'C2', 'C3', 'C4'].every((x) => c[x]! > 0) && !reasons.length, score, criteria: c, reasons }
}
