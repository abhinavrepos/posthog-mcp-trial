/**
 * B′ text stage: explain validated insights with an LLM, under the budget ledger, without ever
 * replacing code-computed facts. Off unless REPLAY_VISION_ALLOW_EXTERNAL=on and a provider is
 * configured. Deterministic insights stay intact whatever the provider does; a proposal is used
 * only if its cited events exist in the windows sent and the full rubric still passes with it.
 *
 *   prepareExplanations(): pick insights → windows → params → reserve → submit (job intent first)
 *   collectExplanations(): poll → record usage → reconcile once → validate → accept / reject
 */
import { all, one, run } from './db.ts'
import { reserveProvider, markSubmitted, markEnded, reconcileProvider, releaseProvider } from './replay-vision-budget.ts'
import { listInsights, type StoredInsight } from './replay-vision-insights.ts'
import { GENERIC, validateInsight, type InsightDraft } from './replay-vision-validator.ts'
import type { Candidate } from './replay-vision-detectors.ts'
import type { SanitizedWindow } from './replay-timeline.ts'
import { readProviderKey } from './replay-vision-secrets.ts'
import {
    AnthropicProvider, ExchangeProvider, buildExplanationParams, costMicros, customIdFor, estimateInputTokens, parseProviderMessage, sessionAlias, worstCaseMicros,
    DEFAULT_MODEL, LIMITS, PROMPT_VERSION, type Explanation, type InsightFacts, type ProviderWindow, type ReplayVisionProvider,
} from './replay-vision-provider.ts'

const on = (v: string | undefined) => ['on', 'true', '1'].includes(String(v ?? '').toLowerCase())
export const externalAnalysisAllowed = () => on(process.env.REPLAY_VISION_ALLOW_EXTERNAL) && !!selectProvider()

/** The configured provider, or undefined: `exchange` needs REPLAY_VISION_EXCHANGE_DIR; `anthropic` needs a key. */
export function selectProvider(batch = true): ReplayVisionProvider | undefined {
    if ((process.env.REPLAY_VISION_PROVIDER || '').toLowerCase() === 'exchange') {
        const dir = process.env.REPLAY_VISION_EXCHANGE_DIR
        return dir ? new ExchangeProvider(dir) : undefined
    }
    const key = readProviderKey()
    return key ? new AnthropicProvider(key, batch) : undefined
}
export function providerStatus(): { mode: string; detail: string } {
    const p = (process.env.REPLAY_VISION_PROVIDER || 'anthropic').toLowerCase()
    const configured = p === 'exchange' ? !!process.env.REPLAY_VISION_EXCHANGE_DIR : !!readProviderKey()
    const allowed = on(process.env.REPLAY_VISION_ALLOW_EXTERNAL)
    if (!allowed || !configured) return { mode: 'deterministic', detail: `${p} provider ${configured ? 'configured' : 'not configured'}; external analysis ${allowed ? 'allowed but no provider' : 'off'}: nothing leaves this server` }
    return { mode: 'text', detail: `${p} provider, model ${DEFAULT_MODEL}; external analysis on: sanitized ±20 s windows around detected moments (allowed screen/element names, timings, coarse pointer positions, error categories, coverage) and code-computed counts are sent; never typed values, page text, URLs, identities or raw recordings` }
}

export function insightFacts(i: StoredInsight): InsightFacts {
    return {
        insight_ref: i.id.slice(0, 8), screen: i.screen, element: i.element, step: i.step, signals: i.signals,
        users_affected: i.users_affected, users_reached: i.users_reached, sessions_affected: i.sessions_affected,
        behaviour: i.text.replace(/^\[\w+\] /, '').replace(/ Likely cause:.*$/, ''), outcome: i.text.match(/; ([^;]*?(?:abandon|lost)[^.]*)\./)?.[1] ?? '',
        median_lost_s: Math.round(i.time_lost_ms / 1000), severity: i.severity, coverage: i.limitations.slice(0, 6),
    }
}

export interface StageDeps {
    provider: ReplayVisionProvider
    /** Sanitized windows around the given offsets of one recording (worker thread over the cached snapshot). */
    windowsFor(sessionId: string, offsetsMs: number[]): Promise<SanitizedWindow[]>
    now?: () => number
    salt?: string
}
export interface StageReport { prepared: number; skipped: Record<string, number>; collected: number; accepted: number; rejected: number; insufficient: number; failed: number; expired: number }
const emptyReport = (): StageReport => ({ prepared: 0, skipped: {}, collected: 0, accepted: 0, rejected: 0, insufficient: 0, failed: 0, expired: 0 })
const bump = (r: StageReport, k: string) => { r.skipped[k] = (r.skipped[k] ?? 0) + 1 }

/** Prepare and submit explanation requests for the top `limit` insights of a scope that have none yet. */
export async function prepareExplanations(scopeKey: string, deps: StageDeps, limit = 5): Promise<StageReport> {
    const report = emptyReport()
    const now = deps.now ?? Date.now
    const salt = deps.salt ?? PROMPT_VERSION
    for (const ins of listInsights(scopeKey, limit)) {
        if (one(`SELECT 1 FROM rv_llm_explanation WHERE insight_id = ? AND state IN ('intent','submitted','accepted','insufficient')`, ins.id)) { bump(report, 'already_explained'); continue }
        // Up to three cited sessions, one window per session at its first cited moment.
        const bySession = new Map<string, number[]>()
        for (const c of ins.citations) if (bySession.size < 3 || bySession.has(c.session_id)) bySession.set(c.session_id, [...(bySession.get(c.session_id) ?? []), c.offset_ms])
        const windows: ProviderWindow[] = []
        for (const [sid, offsets] of bySession) {
            try { for (const w of (await deps.windowsFor(sid, offsets.slice(0, 1))).slice(0, 1)) windows.push({ session_alias: sessionAlias(sid, salt), window: w }) } catch { /* recording gone: explain from the remaining windows */ }
        }
        if (!windows.length) { bump(report, 'no_windows'); continue }
        const params = buildExplanationParams(insightFacts(ins), windows)
        if (estimateInputTokens(params) > LIMITS.maxInputTokens) { bump(report, 'input_cap'); continue }
        const customId = customIdFor(ins.id, params)
        const runId = one<{ id: number }>(`SELECT id FROM rv_run WHERE session_id = ? AND state IN ('complete','partial') ORDER BY id DESC LIMIT 1`, ins.citations[0]!.session_id)?.id
        if (runId === undefined) { bump(report, 'no_run'); continue }
        if (!reserveProvider(customId, runId, worstCaseMicros(params), deps.provider.name, 'global', now())) { bump(report, 'budget'); continue }
        const ts = new Date(now()).toISOString()
        run(`INSERT OR IGNORE INTO rv_llm_explanation(custom_id, insight_id, scope_key, run_id, provider, model, prompt_version, state, cited_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,'intent',?,?,?)`,
            customId, ins.id, scopeKey, runId, deps.provider.name, params.model, PROMPT_VERSION, JSON.stringify(windows.flatMap((w) => w.window.events.map((e) => `${w.session_alias}:${e.id}`)).slice(0, 2000)), ts, ts)
        try {
            const sub = await deps.provider.submit(customId, params)
            markSubmitted(customId, sub.batch_id, now())
            run(`UPDATE rv_llm_explanation SET state = 'submitted', updated_at = ? WHERE custom_id = ?`, ts, customId)
            if (sub.immediate !== undefined) await finish(customId, { state: 'complete', message: sub.immediate }, report, deps.provider.batch)
            report.prepared++
        } catch (e) {
            // A local write failure (exchange) never reached a provider: release. A network error on a real
            // provider is uncertain: the intent stays reserved and is never blindly resubmitted.
            if (deps.provider.name === 'exchange' || e instanceof TypeError) { releaseProvider(customId); run(`UPDATE rv_llm_explanation SET state = 'failed', error_code = 'submit_failed', updated_at = ? WHERE custom_id = ?`, ts, customId) }
            else run(`UPDATE rv_llm_explanation SET error_code = 'submit_uncertain', updated_at = ? WHERE custom_id = ?`, ts, customId)
            report.failed++
        }
    }
    return report
}

/** Poll submitted requests and settle each exactly once. */
export async function collectExplanations(deps: Pick<StageDeps, 'provider' | 'now'>): Promise<StageReport> {
    const report = emptyReport()
    for (const row of all<{ custom_id: string; batch_id: string | null; submitted_at: string | null }>(
        `SELECT e.custom_id, j.batch_id, j.submitted_at FROM rv_llm_explanation e JOIN rv_provider_job j ON j.custom_id = e.custom_id WHERE e.state = 'submitted' AND e.provider = ? LIMIT 50`, deps.provider.name)) {
        let p
        try { p = await deps.provider.poll(row.custom_id, row.batch_id, Date.parse(row.submitted_at ?? '') || Date.now()) } catch { continue } // provider down: try next tick
        if (p.state === 'pending') continue
        await finish(row.custom_id, p, report, deps.provider.batch)
    }
    return report
}

async function finish(customId: string, p: Awaited<ReturnType<ReplayVisionProvider['poll']>>, report: StageReport, batch: boolean) {
    const ts = new Date().toISOString()
    report.collected++
    if (p.state === 'expired') {
        releaseProvider(customId, 'provider_expired')
        run(`UPDATE rv_llm_explanation SET state = 'skipped_timeout', error_code = 'no_response_before_deadline', updated_at = ? WHERE custom_id = ?`, ts, customId)
        report.expired++
        return
    }
    if (p.state === 'failed' || p.state === 'pending') {
        markEnded(customId, null, p.state === 'failed' ? p.error : 'pending'); reconcileProvider(customId, 0)
        run(`UPDATE rv_llm_explanation SET state = 'failed', error_code = ?, updated_at = ? WHERE custom_id = ?`, p.state === 'failed' ? p.error : 'pending', ts, customId)
        report.failed++
        return
    }
    const parsed = parseProviderMessage(p.message)
    const cost = costMicros(parsed.input_tokens, parsed.output_tokens, batch)
    markEnded(customId, { input_tokens: parsed.input_tokens, output_tokens: parsed.output_tokens, cost_micros: cost })
    reconcileProvider(customId, cost, parsed.input_tokens, parsed.output_tokens)
    const base = [parsed.input_tokens, parsed.output_tokens, cost, ts, customId] as const
    if (!parsed.ok || !parsed.explanation) {
        run(`UPDATE rv_llm_explanation SET state = 'rejected', error_code = ?, input_tokens = ?, output_tokens = ?, cost_micros = ?, updated_at = ? WHERE custom_id = ?`, parsed.error ?? 'invalid', ...base)
        report.rejected++
        return
    }
    const row = one<{ insight_id: string; cited_json: string }>('SELECT insight_id, cited_json FROM rv_llm_explanation WHERE custom_id = ?', customId)!
    const verdict = checkExplanation(parsed.explanation, new Set<string>(JSON.parse(row.cited_json)), row.insight_id)
    run(`UPDATE rv_llm_explanation SET state = ?, decision = ?, cause = ?, fix = ?, confidence = ?, rubric_score = ?, error_code = ?, input_tokens = ?, output_tokens = ?, cost_micros = ?, updated_at = ? WHERE custom_id = ?`,
        verdict.state, parsed.explanation.decision, parsed.explanation.likely_cause.slice(0, 600), parsed.explanation.fix.slice(0, 600), parsed.explanation.confidence, verdict.score, verdict.reason ?? null, ...base)
    if (verdict.state === 'accepted') report.accepted++
    else if (verdict.state === 'insufficient') report.insufficient++
    else report.rejected++
}

/**
 * Guards from research §8: cited ids must exist in the windows sent (alias:event id), the cause and fix
 * keep their prefixes, name nothing generic or emotional, and the insight still passes the full rubric
 * with them. Code-computed counts are never taken from the model.
 */
export function checkExplanation(x: Explanation, sentIds: Set<string>, insightId: string): { state: 'accepted' | 'rejected' | 'insufficient'; score: number | null; reason?: string } {
    if (x.decision === 'insufficient_evidence') return { state: 'insufficient', score: null }
    if (!x.cited_event_ids.length) return { state: 'rejected', score: null, reason: 'no_citations' }
    const bad = x.cited_event_ids.filter((id) => !sentIds.has(id) && ![...sentIds].some((s) => s.endsWith(`:${id}`)))
    if (bad.length) return { state: 'rejected', score: null, reason: 'hallucinated_citation' }
    if (!/^Likely cause:/i.test(x.likely_cause) || !/^Fix:/i.test(x.fix)) return { state: 'rejected', score: null, reason: 'format' }
    if (GENERIC.test(x.likely_cause) || GENERIC.test(x.fix)) return { state: 'rejected', score: null, reason: 'generic_claim' }
    if (/@|https?:|\b\d{6,}\b/.test(x.likely_cause + x.fix)) return { state: 'rejected', score: null, reason: 'personal_or_url_text' }
    // A model-written fix must name the element or the screen (template fixes do by construction).
    const target = one<{ element_key: string; screen_key: string }>('SELECT element_key, screen_key FROM rv_insight WHERE id = ?', insightId)
    if (target && !x.fix.toLowerCase().includes(target.element_key.toLowerCase()) && !x.fix.toLowerCase().includes(target.screen_key.split(':')[0]!.toLowerCase())) return { state: 'rejected', score: null, reason: 'fix_not_specific' }
    const v = validateWithStored(insightId, x.likely_cause, x.fix)
    return v.valid ? { state: 'accepted', score: v.score } : { state: 'rejected', score: v.score, reason: `rubric:${v.reasons.join(',') || 'score'}` }
}

/** Re-run the rubric on the stored insight with a proposed cause/fix (evidence rebuilt from its member moments). */
export function validateWithStored(insightId: string, cause: string, fix: string) {
    const r = one<Record<string, unknown>>('SELECT * FROM rv_insight WHERE id = ?', insightId)
    if (!r) return { valid: false, score: 0, reasons: ['insight_gone'], criteria: {} }
    const b = JSON.parse(String(r.behaviour_json)), o = JSON.parse(String(r.outcome_json))
    const draft: InsightDraft = {
        screen: String(r.screen_key), element: String(r.element_key), behaviour: String(b.text), users_affected: Number(r.users_affected), users_reached: r.users_reached === null ? null : Number(r.users_reached),
        sessions_affected: Number(r.sessions_affected), citations: b.citations, outcome: String(o.outcome), time_lost_ms: Number(r.time_lost_ms), cause, fix, signals: b.signals,
        confidence: r.confidence as InsightDraft['confidence'], limitations: b.limitations, severity: r.severity as InsightDraft['severity'], single_session: !!b.single_session,
    }
    const evidence = all<{ session_id: string; detector_codes_json: string; strength: string; screen_key: string; element_key: string; step_key: string; start_ms: number; end_ms: number; evidence_json: string }>(
        `SELECT r.session_id, f.detector_codes_json, f.strength, f.screen_key, f.element_key, f.step_key, f.start_ms, f.end_ms, f.evidence_json FROM rv_insight_member m JOIN rv_finding f ON f.id = m.finding_id JOIN rv_run r ON r.id = f.run_id WHERE m.insight_id = ? LIMIT 500`, insightId)
        .map((f) => { const ev = JSON.parse(f.evidence_json); return { session_id: f.session_id, candidate: { kind: JSON.parse(f.detector_codes_json)[0], start_ms: f.start_ms, end_ms: f.end_ms, score: 1, screen: f.screen_key, element: f.element_key, step: f.step_key, event_ids: ev.event_ids ?? [], facts: ev.facts ?? {}, limitations: [], strength: f.strength } as Candidate } })
    return validateInsight(draft, evidence)
}

/** The accepted explanation for an insight, if any (used by refreshInsights and the MCP output). */
export function acceptedExplanation(insightId: string): { cause: string; fix: string; model: string; custom_id: string } | undefined {
    return one<{ cause: string; fix: string; model: string; custom_id: string }>(`SELECT cause, fix, model, custom_id FROM rv_llm_explanation WHERE insight_id = ? AND state = 'accepted' ORDER BY updated_at DESC LIMIT 1`, insightId)
}
