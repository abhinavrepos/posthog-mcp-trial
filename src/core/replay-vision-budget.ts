/**
 * Replay Vision budgets (architecture "Capacity and cost envelope", PhD review #8).
 *
 * Deterministic admission: per UTC day, global / per-watch / per-person session counts and the
 * download byte budget, checked and incremented in one transaction.
 *
 * Provider spend: a durable reservation per stable custom id, reserved BEFORE any network call
 * together with the job intent row, then submitted → ended → reconciled exactly once, or released.
 * Restart policy (startupReconcile):
 *   - reservation without any job row            → released (crash between reserve and intent)
 *   - job 'intent' (submit outcome uncertain)     → kept reserved and never resubmitted blindly; it
 *     expires after providerMaxAgeMs → provider_expired, reservation released
 *   - job 'submitted' older than providerMaxAgeMs → provider_expired, reservation released
 *   - job ended with recorded usage               → reconciled from that usage (exactly once)
 *   - job ended as a failed call                  → reconciled at zero cost: a failed call still uses its slot
 */
import { all, one, run, tx } from './db.ts'

export const BUDGET = Object.freeze({
    dailySessions: Number(process.env.REPLAY_VISION_DAILY_SESSIONS) || 1000,
    perWatchSessions: 200,
    perPersonOnDemand: 10,
    dailyDownloadBytes: Number(process.env.REPLAY_VISION_DAILY_DOWNLOAD_MB || 1024) * 1024 * 1024,
    dailyLlmCalls: Math.min(100, Number(process.env.REPLAY_VISION_DAILY_LLM_CALLS) || 100),
    dailyCostMicros: Math.min(10_000_000, Number(process.env.REPLAY_VISION_DAILY_COST_MICROS) || 10_000_000),
    callsPerSession: 2,
    providerMaxAgeMs: 24 * 3600_000,
})
export const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)
const ensure = (day: string, scope: string) => run('INSERT OR IGNORE INTO rv_budget(day_utc, scope) VALUES(?,?)', day, scope)
export interface BudgetRow { used_sessions: number; used_download_bytes: number; reserved_llm_calls: number; used_llm_calls: number; reserved_cost_micros: number; estimated_cost_micros: number; used_input_tokens: number; used_output_tokens: number }
export function budgetRow(day: string, scope = 'global'): BudgetRow {
    return one<BudgetRow>('SELECT used_sessions, used_download_bytes, reserved_llm_calls, used_llm_calls, reserved_cost_micros, estimated_cost_micros, used_input_tokens, used_output_tokens FROM rv_budget WHERE day_utc = ? AND scope = ?', day, scope)
        ?? { used_sessions: 0, used_download_bytes: 0, reserved_llm_calls: 0, used_llm_calls: 0, reserved_cost_micros: 0, estimated_cost_micros: 0, used_input_tokens: 0, used_output_tokens: 0 }
}

/** Admit one deterministic session against every scope's limit, all or nothing. Returns the scope that refused, or null. */
export function admitSession(scopes: { scope: string; limit: number }[], now = Date.now()): string | null {
    const day = dayOf(now)
    return tx(() => {
        if (budgetRow(day, 'global').used_download_bytes >= BUDGET.dailyDownloadBytes) return 'download_bytes'
        for (const s of scopes) if (budgetRow(day, s.scope).used_sessions >= s.limit) return s.scope
        for (const s of scopes) { ensure(day, s.scope); run('UPDATE rv_budget SET used_sessions = used_sessions + 1 WHERE day_utc = ? AND scope = ?', day, s.scope) }
        return null
    })
}
export function addDownloadBytes(bytes: number, now = Date.now()): void {
    const day = dayOf(now)
    ensure(day, 'global')
    run('UPDATE rv_budget SET used_download_bytes = used_download_bytes + ? WHERE day_utc = ? AND scope = ?', Math.max(0, Math.floor(bytes) || 0), day, 'global')
}

const ID = /^[A-Za-z0-9_-]{8,64}$/
/**
 * Reserve worst-case spend and persist the job intent in one transaction. Idempotent per customId:
 * a repeated call returns the earlier decision without reserving twice. Refuses beyond the daily
 * call or cost ceiling, the per-session call ceiling, or an unknown / invalid cost.
 */
export function reserveProvider(customId: string, runId: number, costMicros: number, provider = 'anthropic', scope = 'global', now = Date.now()): boolean {
    if (!ID.test(customId) || !Number.isSafeInteger(costMicros) || costMicros <= 0 || costMicros > BUDGET.dailyCostMicros) return false
    const day = dayOf(now)
    return tx(() => {
        const existing = one<{ state: string }>('SELECT state FROM rv_reservation WHERE custom_id = ?', customId)
        if (existing) return existing.state === 'reserved' || existing.state === 'reconciled'
        ensure(day, scope)
        const b = budgetRow(day, scope)
        if (b.reserved_llm_calls + b.used_llm_calls + 1 > BUDGET.dailyLlmCalls) return false
        if (b.reserved_cost_micros + b.estimated_cost_micros + costMicros > BUDGET.dailyCostMicros) return false
        if (one<{ n: number }>(`SELECT count(*) AS n FROM rv_reservation WHERE run_id = ? AND state <> 'released'`, runId)!.n >= BUDGET.callsPerSession) return false
        const ts = new Date(now).toISOString()
        run('INSERT INTO rv_reservation(custom_id, run_id, day_utc, scope, cost_micros, state, created_at) VALUES(?,?,?,?,?,?,?)', customId, runId, day, scope, costMicros, 'reserved', ts)
        run(`INSERT INTO rv_provider_job(run_id, provider, custom_id, state, attempts, next_poll_at) VALUES(?,?,?,'intent',0,?)`, runId, provider, customId, ts)
        run('UPDATE rv_budget SET reserved_llm_calls = reserved_llm_calls + 1, reserved_cost_micros = reserved_cost_micros + ? WHERE day_utc = ? AND scope = ?', costMicros, day, scope)
        return true
    })
}
export function markSubmitted(customId: string, batchId: string | null, now = Date.now()): void {
    run(`UPDATE rv_provider_job SET state = 'submitted', batch_id = ?, submitted_at = ?, next_poll_at = ? WHERE custom_id = ? AND state = 'intent'`, batchId, new Date(now).toISOString(), new Date(now + 60_000).toISOString(), customId)
}
/** Record the provider's final answer (usage) before reconciling, so a crash in between reconciles from it. */
export function markEnded(customId: string, usage: { input_tokens?: number; output_tokens?: number; cost_micros: number } | null, error?: string): void {
    run(`UPDATE rv_provider_job SET state = ?, last_error_code = ? WHERE custom_id = ? AND state IN ('intent','submitted')`, usage ? `ended:${JSON.stringify(usage)}` : 'ended_failed', error ?? null, customId)
}
export function jobState(customId: string): string | undefined {
    return one<{ state: string }>('SELECT state FROM rv_provider_job WHERE custom_id = ?', customId)?.state
}

/** Move the reservation into used spend exactly once. */
export function reconcileProvider(customId: string, actualMicros: number, inputTokens = 0, outputTokens = 0): boolean {
    return tx(() => {
        const r = one<{ day_utc: string; scope: string; cost_micros: number; state: string }>('SELECT day_utc, scope, cost_micros, state FROM rv_reservation WHERE custom_id = ?', customId)
        if (!r || r.state !== 'reserved') return false
        const actual = Math.min(BUDGET.dailyCostMicros, Math.max(0, Math.floor(actualMicros) || 0))
        run(`UPDATE rv_reservation SET state = 'reconciled' WHERE custom_id = ?`, customId)
        run(`UPDATE rv_provider_job SET state = 'reconciled' WHERE custom_id = ?`, customId)
        run(`UPDATE rv_budget SET reserved_llm_calls = MAX(0, reserved_llm_calls - 1), used_llm_calls = used_llm_calls + 1, reserved_cost_micros = MAX(0, reserved_cost_micros - ?),
             estimated_cost_micros = estimated_cost_micros + ?, used_input_tokens = used_input_tokens + ?, used_output_tokens = used_output_tokens + ? WHERE day_utc = ? AND scope = ?`,
            r.cost_micros, actual, Math.max(0, Math.floor(inputTokens) || 0), Math.max(0, Math.floor(outputTokens) || 0), r.day_utc, r.scope)
        return true
    })
}
/** Release an unused reservation (never submitted, expired or skipped). `state` becomes the job's final state. */
export function releaseProvider(customId: string, state = 'released'): boolean {
    return tx(() => {
        const r = one<{ day_utc: string; scope: string; cost_micros: number; state: string }>('SELECT day_utc, scope, cost_micros, state FROM rv_reservation WHERE custom_id = ?', customId)
        if (!r || r.state !== 'reserved') return false
        run(`UPDATE rv_reservation SET state = 'released' WHERE custom_id = ?`, customId)
        run(`UPDATE rv_provider_job SET state = ? WHERE custom_id = ? AND state <> 'reconciled'`, state, customId)
        run('UPDATE rv_budget SET reserved_llm_calls = MAX(0, reserved_llm_calls - 1), reserved_cost_micros = MAX(0, reserved_cost_micros - ?) WHERE day_utc = ? AND scope = ?', r.cost_micros, r.day_utc, r.scope)
        return true
    })
}

export interface ReconcileReport { released_orphans: number; expired: number; reconciled: number; uncertain: number }
/** Run at startup before any new provider work, and on every tick. */
export function startupReconcile(now = Date.now()): ReconcileReport {
    const out: ReconcileReport = { released_orphans: 0, expired: 0, reconciled: 0, uncertain: 0 }
    for (const r of all<{ custom_id: string }>(`SELECT custom_id FROM rv_reservation WHERE state = 'reserved' AND custom_id NOT IN (SELECT custom_id FROM rv_provider_job)`)) if (releaseProvider(r.custom_id)) out.released_orphans++
    const cutoff = new Date(now - BUDGET.providerMaxAgeMs).toISOString()
    for (const j of all<{ custom_id: string; state: string; submitted_at: string | null; created_at: string }>(
        `SELECT j.custom_id, j.state, j.submitted_at, r.created_at FROM rv_provider_job j JOIN rv_reservation r ON r.custom_id = j.custom_id WHERE r.state = 'reserved'`)) {
        if (j.state.startsWith('ended:')) {
            let u: { input_tokens?: number; output_tokens?: number; cost_micros?: number } = {}
            try { u = JSON.parse(j.state.slice(6)) } catch {}
            if (reconcileProvider(j.custom_id, u.cost_micros ?? 0, u.input_tokens, u.output_tokens)) out.reconciled++
        } else if (j.state === 'ended_failed') {
            if (reconcileProvider(j.custom_id, 0)) out.reconciled++
        } else if ((j.submitted_at ?? j.created_at) < cutoff) {
            if (releaseProvider(j.custom_id, 'provider_expired')) out.expired++
        } else if (j.state === 'intent') out.uncertain++
    }
    return out
}
