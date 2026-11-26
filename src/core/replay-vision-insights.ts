/**
 * Persistence of Replay Vision results: moments (rv_finding) per run, and validated aggregate
 * insights (rv_insight + rv_insight_member) per scope. No raw replay, DOM, prompt or timeline is
 * stored; evidence_json holds event ids and numeric facts only.
 */
import { createHash } from 'node:crypto'
import { all, run, tx } from './db.ts'
import { hogql, isTruncated } from './posthog.ts'
import { P } from './props.ts'
import { screenKey } from './replay-timeline.ts'
import { aggregateInsights, type Aggregate, type Moment, type Reach } from './replay-vision-aggregate.ts'
import { isCalibrated, loadBaselines, type RunMetrics } from './replay-vision-baseline.ts'
import { DETECTOR_CONFIG, type Candidate, type DetectorCode } from './replay-vision-detectors.ts'
import { BINARY_CODES } from './replay-vision-metrics.ts'
import { SEVERITY_CONFIG } from './replay-vision-severity.ts'

export const INSIGHT_VERSION = `${DETECTOR_CONFIG.version}+${SEVERITY_CONFIG.version}`
const DAY = 86_400_000

export function fingerprint(sessionId: string, c: Pick<Candidate, 'kind'|'element'|'start_ms'>): string {
    return createHash('sha256').update([sessionId, DETECTOR_CONFIG.version, c.kind, c.element, Math.floor(c.start_ms / 1000)].join('|')).digest('hex').slice(0, 24)
}

/** Replace a run's moments. Idempotent: re-running the same analysis rewrites identical rows. New moments start Low (single-session cap). */
export function storeFindings(runId: number, sessionId: string, candidates: Candidate[]): number {
    const now = new Date().toISOString()
    let n = 0
    tx(() => {
        run('DELETE FROM rv_finding WHERE run_id = ?', runId)
        for (const c of candidates.slice(0, 2000)) {
            const r = run(`INSERT OR IGNORE INTO rv_finding(run_id,fingerprint,detector_codes_json,strength,severity,severity_reason_json,screen_key,element_key,step_key,start_ms,end_ms,evidence_json,coverage_json,confidence,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                runId, fingerprint(sessionId, c), JSON.stringify([c.kind]), c.strength, 'Low', JSON.stringify({ rule: 'single session moment: capped Low until cross-user evidence' }),
                c.screen.slice(0, 200), c.element.slice(0, 120), c.step.slice(0, 120), Math.max(0, Math.floor(c.start_ms)), Math.max(0, Math.floor(c.end_ms)),
                JSON.stringify({ event_ids: c.event_ids.slice(0, 8), facts: c.facts, score: c.score }), JSON.stringify(c.limitations.slice(0, 8)), 'low', now)
            n += Number(r.changes)
        }
    })
    return n
}

interface RunRow { id: number; session_id: string; distinct_id: string | null; client_id: string | null; metrics_json: string }
interface FindingRow { id: number; run_id: number; detector_codes_json: string; strength: string; screen_key: string; element_key: string; step_key: string; start_ms: number; end_ms: number; evidence_json: string; coverage_json: string }

export function scopeKeyOf(scope: { client?: string | null; user?: string | null }): string {
    return scope.user ? `user:${scope.user}` : scope.client ? `client:${scope.client}` : 'all'
}

/** Users who reached each screen, from $pageview events in the window (HogQL), deduplicated in Node by screenKey. */
export async function screenReach(from: Date, to: Date, scope: { client?: string | null; user?: string | null } = {}): Promise<Map<string, Reach>> {
    const where = [`event = '$pageview'`, 'timestamp >= {from}', 'timestamp < {to}']
    if (scope.client) where.push(`toString(${P.client}) = {client}`)
    if (scope.user) where.push('distinct_id = {user}')
    const rows = await hogql(`SELECT DISTINCT toString(distinct_id) AS did, toString(properties.$pathname) AS path FROM events WHERE ${where.join(' AND ')} LIMIT 20000`,
        { from: from.toISOString(), to: to.toISOString(), client: scope.client ?? '', user: scope.user ?? '' }, { timeoutMs: 15_000, retries: 0 })
    const users = new Map<string, Set<string>>()
    for (const r of rows) { const k = screenKey(String(r.path || '/')); const set = users.get(k) ?? new Set<string>(); set.add(String(r.did)); users.set(k, set) }
    const lower = isTruncated(rows)
    return new Map([...users].map(([k, v]) => [k, { users: v.size, source: '$pageview events (HogQL)', lower_bound: lower }]))
}

/** Fallback N: distinct users among analysed recordings that visited the screen; labelled as a lower bound. */
function analysedReach(runs: RunRow[]): { reach: Map<string, Reach>; sessions: Map<string, number> } {
    const users = new Map<string, Set<string>>(), sessions = new Map<string, number>()
    for (const r of runs) {
        let m: RunMetrics
        try { m = JSON.parse(r.metrics_json) } catch { continue }
        for (const screen of new Set(Array.isArray(m.screens) ? m.screens : [])) {
            if (typeof screen !== 'string') continue
            const set = users.get(screen) ?? new Set<string>(); set.add(r.distinct_id ?? `run:${r.id}`); users.set(screen, set)
            sessions.set(screen, (sessions.get(screen) ?? 0) + 1)
        }
    }
    return { reach: new Map([...users].map(([k, v]) => [k, { users: v.size, source: 'analysed recordings', lower_bound: true }])), sessions }
}

export interface RefreshResult { scope_key: string; runs: number; moments: number; insights: Aggregate[]; rejected: number }

/**
 * Recompute the validated insights of one scope from stored moments of the last 30 days.
 * `reach` (screen → users who reached it) should come from screenReach(); without it the analysed
 * recordings are used and labelled as an observed lower bound.
 */
export function refreshInsights(scope: { client?: string | null; user?: string | null }, opts: { now?: Date; reach?: Map<string, Reach> } = {}): RefreshResult {
    const now = opts.now ?? new Date()
    const scopeKey = scopeKeyOf(scope)
    const from = new Date(+now - SEVERITY_CONFIG.windowDays * DAY).toISOString()
    const filter = scope.user ? 'AND distinct_id = ?' : scope.client ? 'AND client_id = ?' : ''
    const params = scope.user ? [scope.user] : scope.client ? [scope.client] : []
    const runs = all<RunRow>(`SELECT id, session_id, distinct_id, client_id, metrics_json FROM rv_run WHERE state IN ('complete','partial') AND mode = 'deterministic' AND completed_at >= ? ${filter} ORDER BY completed_at DESC LIMIT 2000`, from, ...params)
    const byRun = new Map(runs.map((r) => [r.id, r]))
    const findings = runs.length ? all<FindingRow>(`SELECT id, run_id, detector_codes_json, strength, screen_key, element_key, step_key, start_ms, end_ms, evidence_json, coverage_json FROM rv_finding WHERE run_id IN (${runs.map(() => '?').join(',')}) LIMIT 50000`, ...runs.map((r) => r.id)) : []
    const momentFinding = new Map<Moment, number>()
    const moments: Moment[] = []
    for (const f of findings) {
        const r = byRun.get(f.run_id)!
        let kinds: string[] = [], ev: { event_ids?: string[]; facts?: Candidate['facts']; score?: number } = {}, lim: string[] = []
        try { kinds = JSON.parse(f.detector_codes_json); ev = JSON.parse(f.evidence_json); lim = JSON.parse(f.coverage_json) } catch { continue }
        const candidate: Candidate = { kind: kinds[0] as DetectorCode, start_ms: f.start_ms, end_ms: f.end_ms, score: ev.score ?? 1, screen: f.screen_key, element: f.element_key, step: f.step_key, event_ids: ev.event_ids ?? [], facts: ev.facts ?? {}, limitations: Array.isArray(lim) ? lim : [], strength: f.strength as Candidate['strength'] }
        const m: Moment = { session_id: r.session_id, user_id: r.distinct_id ?? `run:${r.id}`, candidate, time_lost_ms: Math.max(0, Number(candidate.facts.lost_ms) || 0), abandoned: false }
        moments.push(m); momentFinding.set(m, f.id)
    }
    // Abandonment: the session left that screen's new form (D5) after this moment.
    const d5 = moments.filter((m) => m.candidate.kind === 'D5')
    for (const m of moments) m.abandoned = d5.some((a) => a.session_id === m.session_id && a.candidate.screen === m.candidate.screen && a.candidate.end_ms >= m.candidate.start_ms)
    const baselines = loadBaselines()
    const calibrated = new Map<string, boolean>()
    for (const [key, b] of baselines) { const screen = key.split('|')[1]!; if (key.startsWith('DWELL|') || !calibrated.has(screen)) calibrated.set(screen, isCalibrated(b)) }
    const fallback = analysedReach(runs)
    const reach = opts.reach && opts.reach.size ? opts.reach : fallback.reach
    const allScreenRate: Record<string, number> = {}
    for (const code of BINARY_CODES) {
        const rows = [...baselines].filter(([k]) => k.startsWith(code + '|'))
        const n = rows.reduce((a, [, b]) => a + b.n_sessions, 0)
        allScreenRate[code] = n ? rows.reduce((a, [, b]) => a + b.rate * b.n_sessions, 0) / n : 0
    }
    const insights = aggregateInsights(moments, reach, calibrated, { baselines, allScreenRate, sessionsReached: fallback.sessions, scopeKey, version: INSIGHT_VERSION })
    const ts = now.toISOString()
    tx(() => {
        const dismissed = new Map(all<{ id: string; dismissed_at: string; dismissed_by: string }>('SELECT id, dismissed_at, dismissed_by FROM rv_insight WHERE scope_key = ? AND dismissed_at IS NOT NULL', scopeKey).map((r) => [r.id, r]))
        run('DELETE FROM rv_insight WHERE scope_key = ?', scopeKey)
        for (const a of insights) {
            const d = a.draft
            const prior = dismissed.get(a.id)
            run(`INSERT INTO rv_insight(id,scope_key,screen_key,element_key,step_key,root_cause_key,first_at,last_at,users_affected,users_reached,sessions_affected,sessions_reached,severity,severity_reason_json,time_lost_ms,abandoned_users,calibrated,baseline_version,baseline_sample_json,reach_source,behaviour_json,outcome_json,cause,fix,impact,confidence,rubric_json,analysis_version,created_at,updated_at,dismissed_at,dismissed_by)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                a.id, scopeKey, d.screen, d.element, a.members[0]!.candidate.step, a.family, ts, ts, d.users_affected, d.users_reached, d.sessions_affected, fallback.sessions.get(d.screen) ?? null,
                d.severity, JSON.stringify({ reason: a.severity_reason, U: d.users_affected, N: d.users_reached, T_ms: d.time_lost_ms, A: a.abandoned_users, calibrated: a.calibrated, reach_source: a.reach_source }),
                Math.round(d.time_lost_ms), a.abandoned_users, a.calibrated ? 1 : 0, SEVERITY_CONFIG.version,
                JSON.stringify({ selection: 'all admitted deterministic runs in the last 30 days', sessions_in_scope: runs.length }), a.reach_source,
                JSON.stringify({ text: d.behaviour, signals: d.signals, citations: d.citations, limitations: d.limitations, single_session: !!d.single_session, display: a.text }),
                JSON.stringify({ outcome: d.outcome }), d.cause, d.fix, `${d.severity}; ${d.users_affected} users; strength ${a.strength}`, d.confidence, JSON.stringify(a.rubric), INSIGHT_VERSION, ts, ts,
                prior?.dismissed_at ?? null, prior?.dismissed_by ?? null)
            for (const m of a.members) {
                const fid = momentFinding.get(m)
                if (fid === undefined) continue
                run('INSERT OR IGNORE INTO rv_insight_member(insight_id, finding_id) VALUES(?,?)', a.id, fid)
                run('UPDATE rv_finding SET severity = ?, severity_reason_json = ?, confidence = ? WHERE id = ?', d.severity, JSON.stringify({ rule: a.severity_reason, insight: a.id }), d.confidence, fid)
            }
        }
    })
    return { scope_key: scopeKey, runs: runs.length, moments: moments.length, insights, rejected: 0 }
}

export interface StoredInsight { id: string; severity: string; text: string; cause_source: string; screen: string; element: string; step: string; users_affected: number; users_reached: number | null; sessions_affected: number; time_lost_ms: number; abandoned_users: number; calibrated: boolean; reach_source: string | null; severity_reason: string; cause: string; fix: string; confidence: string; rubric_score: number; citations: { session_id: string; offset_ms: number; url: string }[]; signals: string[]; limitations: string[]; dismissed: boolean; updated_at: string }

/** Ranked validated insights of a scope: multi-user before single-session, then severity, users, abandonment. */
export function listInsights(scopeKey: string, limit = 20, offset = 0, includeDismissed = false): StoredInsight[] {
    const rows = all<Record<string, unknown>>(`SELECT * FROM rv_insight WHERE scope_key = ? ${includeDismissed ? '' : 'AND dismissed_at IS NULL'}
        ORDER BY json_extract(behaviour_json,'$.single_session') ASC, CASE severity WHEN 'High' THEN 2 WHEN 'Medium' THEN 1 ELSE 0 END DESC, users_affected DESC, abandoned_users DESC, id LIMIT ? OFFSET ?`,
        scopeKey, Math.min(200, Math.max(1, limit)), Math.max(0, offset))
    return rows.map((r) => {
        const b = JSON.parse(String(r.behaviour_json)), sev = JSON.parse(String(r.severity_reason_json)), rub = JSON.parse(String(r.rubric_json))
        // An LLM cause/fix is shown only after it passed citation and rubric checks (replay-vision-llm.ts); otherwise the template.
        const llm = all<{ cause: string; fix: string; model: string }>(`SELECT cause, fix, model FROM rv_llm_explanation WHERE insight_id = ? AND state = 'accepted' ORDER BY updated_at DESC LIMIT 1`, String(r.id))[0]
        const cause = llm?.cause ?? String(r.cause), fix = llm?.fix ?? String(r.fix)
        const text = llm ? String(b.display ?? '').replace(String(r.cause), cause).replace(String(r.fix), fix) : String(b.display ?? '')
        return {
            id: String(r.id), severity: String(r.severity), text, cause_source: llm ? `llm:${llm.model} (validated)` : 'template', screen: String(r.screen_key), element: String(r.element_key), step: String(r.step_key),
            users_affected: Number(r.users_affected), users_reached: r.users_reached === null ? null : Number(r.users_reached), sessions_affected: Number(r.sessions_affected),
            time_lost_ms: Number(r.time_lost_ms), abandoned_users: Number(r.abandoned_users), calibrated: !!r.calibrated, reach_source: r.reach_source as string | null,
            severity_reason: String(sev.reason ?? ''), cause, fix, confidence: String(r.confidence), rubric_score: Number(rub.score),
            citations: (b.citations ?? []).map((c: { session_id: string; offset_ms: number; url: string }) => ({ session_id: c.session_id, offset_ms: c.offset_ms, url: c.url })),
            signals: b.signals ?? [], limitations: b.limitations ?? [], dismissed: !!r.dismissed_at, updated_at: String(r.updated_at),
        }
    })
}

export function dismissInsight(id: string, by: string): boolean {
    return Number(run('UPDATE rv_insight SET dismissed_at = ?, dismissed_by = ? WHERE id = ? AND dismissed_at IS NULL', new Date().toISOString(), by.slice(0, 200), id).changes) > 0
}

/** On recording deletion: remove its runs (cascades moments and memberships) and drop insights that lost all members. */
export function deleteSessionData(sessionId: string): number {
    return tx(() => {
        const n = Number(run('DELETE FROM rv_run WHERE session_id = ?', sessionId).changes)
        run('DELETE FROM rv_insight WHERE id NOT IN (SELECT insight_id FROM rv_insight_member)')
        return n
    })
}

