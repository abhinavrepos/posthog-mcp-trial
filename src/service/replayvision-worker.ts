/**
 * Replay Vision Monitor scheduler (architecture "Monitor, persistence, and permissions").
 *
 * One in-process timer; parsing and detectors run in a resource-limited worker thread
 * (core/replay-vision.ts analyzeFile). Durable state lives in SQLite: unique run keys, leases,
 * attempts, budget rows and a discovery cursor make every step idempotent and restart-safe.
 * Off unless FEATURE_REPLAY_VISION=on; with no enabled watch it does no PostHog work at all.
 *
 * Run states: pending → stable_wait → (running) → complete | partial | oversize
 *             retry (backoff) · skipped_budget · unavailable · too_large · failed_permanent · superseded
 */
import { stat } from 'node:fs/promises'
import { config } from '../core/config.ts'
import { all, one, run, tx } from '../core/db.ts'
import { clipFrames, renderClip, withSnapshotsFile } from '../core/clip.ts'
import { getRecording, PostHogError } from '../core/posthog.ts'
import { analyzeFile, analysisVersion, replayAppEvents, type AnalysisResult } from '../core/replay-vision.ts'
import { discoverFinishedRecordings, type Discovered } from '../core/replay-vision-discovery.ts'
import { baselineContext, loadBaselines, recomputeBaselines, runMetrics } from '../core/replay-vision-baseline.ts'
import { addDownloadBytes, admitSession, BUDGET, startupReconcile } from '../core/replay-vision-budget.ts'
import { deleteSessionData, refreshInsights, screenReach, storeFindings } from '../core/replay-vision-insights.ts'
import type { DetectorContext } from '../core/replay-vision-detectors.ts'
import type { AppEventInput, SanitizedWindow } from '../core/replay-timeline.ts'
import { collectExplanations, externalAnalysisAllowed, prepareExplanations, selectProvider } from '../core/replay-vision-llm.ts'
import { collectWatchFully, prepareWatchFully, watchFullyAvailability, type WatchFrame } from '../core/replay-vision-watch.ts'
import { WATCH_LIMITS, type WatchPlan } from '../core/replay-vision-watch-plan.ts'

const DAY = 86_400_000
export const MONITOR = Object.freeze({
    maxAttempts: 3,
    quietMs: 10 * 60_000,
    stableRecheckMs: 5 * 60_000,
    pollMs: 5 * 60_000,
    leaseMs: 120_000,
    analysisTimeoutMs: 60_000,
    discoveryWindowMs: DAY,
    discoveryPagesPerTick: 5,
    runsPerTick: 2,
    retentionDays: Math.min(90, Math.max(1, Number(process.env.REPLAY_VISION_RETENTION_DAYS) || 30)),
})
export const replayVisionEnabled = () => ['on', 'true', '1'].includes(String(process.env.FEATURE_REPLAY_VISION || 'off').toLowerCase())

export interface VisionDeps {
    now(): number
    discover(input: { from: Date; to: Date; cursor?: { end: string; session_id: string }; limit?: number }): Promise<{ rows: Discovered[]; next?: { end: string; session_id: string }; partial: boolean }>
    getRecording(sessionId: string): Promise<{ start_time: string; end_time: string; distinct_id?: string }>
    appEvents(sessionId: string): Promise<AppEventInput[]>
    withSnapshots<T>(sessionId: string, use: (file: string) => Promise<T>): Promise<T>
    analyze(file: string, metadata: { start_time: string; app_events?: { timestamp: string; event: string; path?: string }[] }, timeoutMs: number, ctx: DetectorContext): Promise<AnalysisResult>
    fileSize(file: string): Promise<number>
    reach(scope: { client?: string | null; user?: string | null }, from: Date, to: Date): Promise<Map<string, { users: number; source: string; lower_bound?: boolean }>>
    /** Sanitized ±20 s windows around offsets of one recording, for the B′ text stage. */
    windowsFor(sessionId: string, offsetsMs: number[]): Promise<SanitizedWindow[]>
    /** Watch fully: frame plan + sanitized timeline (worker), and the planned frames rendered by the clip renderer. Absent = stage off. */
    watchPlanFor?(sessionId: string): Promise<WatchPlan>
    renderWatchFrames?(sessionId: string, plan: WatchPlan): Promise<WatchFrame[]>
}
export const realDeps: VisionDeps = {
    now: () => Date.now(),
    discover: discoverFinishedRecordings,
    getRecording: (id) => getRecording(id),
    appEvents: replayAppEvents,
    withSnapshots: withSnapshotsFile,
    analyze: analyzeFile,
    fileSize: async (f) => (await stat(f)).size,
    reach: (scope, from, to) => screenReach(from, to, scope),
    windowsFor: async (sessionId, offsets) => {
        const meta = await getRecording(sessionId)
        const r = await withSnapshotsFile(sessionId, (file) => analyzeFile(file, { start_time: meta.start_time }, MONITOR.analysisTimeoutMs, {}, offsets))
        return r.windows ?? []
    },
    watchPlanFor: async (sessionId) => {
        const meta = await getRecording(sessionId)
        const r = await withSnapshotsFile(sessionId, (file) => analyzeFile(file, { start_time: meta.start_time }, MONITOR.analysisTimeoutMs, {}, undefined, true))
        if (!r.watch) throw new Error(`watch_plan_failed:${r.coverage.reasons.join(',')}`)
        return r.watch
    },
    // The existing clip renderer (PostHog rasterizer, sandboxed Chrome as the service's non-root user), one clip per
    // planned range, then one PNG per planned frame scaled to WATCH_LIMITS.frameWidth. Missing frames are skipped.
    renderWatchFrames: async (sessionId, plan) => {
        const out: WatchFrame[] = []
        for (const range of plan.ranges) {
            const clip = await renderClip({ sessionId, startOffsetS: range.start_s, durationS: range.duration_s }, 'replay-vision:watch-fully')
            const frames = plan.frames.filter((f) => f.t_ms / 1000 >= clip.start_offset_s && f.t_ms / 1000 <= clip.end_offset_s)
            const pngs = await clipFrames(clip.file, frames.map((f) => Math.max(0, f.t_ms / 1000 - clip.start_offset_s)), WATCH_LIMITS.frameWidth)
            pngs.forEach((png, i) => { if (frames[i]) out.push({ png, frame: frames[i]! }) })
        }
        return out
    },
}

export interface VisionRun { id: number; session_id: string; recording_end: string; state: string; attempts: number; client_id: string | null; distinct_id: string | null; requested_by: string | null }
interface Watch { id: number; kind: 'client'|'distinct_id'; value: string; enabled: number; max_sessions_per_day: number }
const status = { lastOk: null as string | null, lastError: null as string | null, lastScan: null as string | null, unmatched: 0, discovered: 0 }
const iso = (ms: number) => new Date(ms).toISOString()

/** Queue (or find) the run for one recording end version. A different end supersedes older versions. Idempotent. */
export function queueReplayVision(sessionId: string, recordingEnd: string, clientId: string | null, distinctId: string | null, watchIds: number[] = [], requestedBy: string | null = null): number {
    if (!/^[\w-]{8,120}$/.test(sessionId) || !Number.isFinite(Date.parse(recordingEnd))) throw new Error('invalid_recording')
    return tx(() => {
        run(`UPDATE rv_run SET state = 'superseded', lease_until = NULL WHERE project_id = ? AND session_id = ? AND recording_end <> ? AND state <> 'superseded'`, config.posthog.projectId, sessionId, recordingEnd)
        run(`DELETE FROM rv_finding WHERE run_id IN (SELECT id FROM rv_run WHERE project_id = ? AND session_id = ? AND state = 'superseded')`, config.posthog.projectId, sessionId)
        run(`INSERT INTO rv_run(project_id, session_id, recording_end, analysis_version, mode, client_id, distinct_id, state, requested_by) VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT DO NOTHING`,
            config.posthog.projectId, sessionId, recordingEnd, analysisVersion, 'deterministic', clientId, distinctId, requestedBy)
        const id = one<{ id: number }>(`SELECT id FROM rv_run WHERE project_id = ? AND session_id = ? AND recording_end = ? AND analysis_version = ? AND mode = 'deterministic'`, config.posthog.projectId, sessionId, recordingEnd, analysisVersion)!.id
        for (const w of watchIds) run('INSERT OR IGNORE INTO rv_run_watch(run_id, watch_id) VALUES(?,?)', id, w)
        return id
    })
}

/** Admin "force": recompute an existing run in place (no duplicate row). */
export function forceRerun(runId: number): boolean {
    return Number(run(`UPDATE rv_run SET state = 'pending', attempts = 0, next_attempt_at = NULL, lease_until = NULL, error_code = NULL WHERE id = ? AND state <> 'superseded'`, runId).changes) > 0
}

/** Atomically claim the next due run (or a run whose lease expired after a crash). */
export function claimNext(now: number): VisionRun | undefined {
    return tx(() => {
        const r = one<VisionRun & { lease_until: string | null }>(`SELECT id, session_id, recording_end, state, attempts, client_id, distinct_id, requested_by, lease_until FROM rv_run
            WHERE (state IN ('pending','stable_wait','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (state = 'running' AND lease_until < ?)
            ORDER BY CASE WHEN requested_by IS NULL THEN 1 ELSE 0 END, recording_end DESC, id LIMIT 1`, iso(now), iso(now))
        if (!r) return undefined
        // A crashed run (expired lease) counts as an attempt; a poison session ends failed_permanent.
        const prior = r.state === 'running' ? 'retry' : r.state
        if (r.state === 'running' && r.attempts >= MONITOR.maxAttempts) {
            run(`UPDATE rv_run SET state = 'failed_permanent', error_code = 'crash_or_timeout', lease_until = NULL WHERE id = ?`, r.id)
            return undefined
        }
        run(`UPDATE rv_run SET state = 'running', lease_until = ?, started_at = COALESCE(started_at, ?), error_code = CASE WHEN ? = 'retry' AND error_code IS NULL THEN 'lease_expired' ELSE error_code END WHERE id = ?`, iso(now + MONITOR.leaseMs), iso(now), prior, r.id)
        return { ...r, state: prior }
    })
}

function retryLater(id: number, now: number, code: string, consumeAttempt: boolean, attempts: number) {
    const permanent = consumeAttempt && attempts >= MONITOR.maxAttempts
    run(`UPDATE rv_run SET state = ?, error_code = ?, lease_until = NULL, next_attempt_at = ? WHERE id = ?`,
        permanent ? 'failed_permanent' : 'retry', code, permanent ? null : iso(now + Math.min(3600_000, 60_000 * 2 ** Math.max(1, attempts))), id)
}

/** Process one claimed run. Never throws. */
export async function processRun(r: VisionRun, deps: VisionDeps = realDeps): Promise<string> {
    const now = deps.now()
    let counted = false
    try {
        const meta = await deps.getRecording(r.session_id)
        if (!Number.isFinite(Date.parse(meta.end_time))) throw new PostHogError('no stored snapshots yet', 404)
        if (meta.end_time !== r.recording_end) {
            // Late blobs: the recording grew. Supersede and analyse the new end version once.
            run(`UPDATE rv_run SET state = 'superseded', lease_until = NULL WHERE id = ?`, r.id)
            const links = all<{ watch_id: number }>('SELECT watch_id FROM rv_run_watch WHERE run_id = ?', r.id).map((x) => x.watch_id)
            queueReplayVision(r.session_id, meta.end_time, r.client_id, r.distinct_id, links, r.requested_by)
            return 'superseded'
        }
        if (r.state === 'pending' && !r.requested_by) {
            // Quiet period passed at discovery; confirm the end is stable on the next poll before analysing.
            run(`UPDATE rv_run SET state = 'stable_wait', lease_until = NULL, next_attempt_at = ? WHERE id = ?`, iso(now + MONITOR.stableRecheckMs), r.id)
            return 'stable_wait'
        }
        const watches = all<{ id: number; max_sessions_per_day: number }>('SELECT w.id, w.max_sessions_per_day FROM rv_run_watch l JOIN rv_watch w ON w.id = l.watch_id WHERE l.run_id = ?', r.id)
        const scopes = [{ scope: 'global', limit: BUDGET.dailySessions }, ...watches.map((w) => ({ scope: `watch:${w.id}`, limit: Math.min(BUDGET.perWatchSessions, w.max_sessions_per_day) }))]
        if (r.requested_by) scopes.push({ scope: `person:${r.requested_by}`, limit: BUDGET.perPersonOnDemand })
        if (r.attempts === 0) {
            const refused = admitSession(scopes, now)
            if (refused) {
                run(`UPDATE rv_run SET state = 'skipped_budget', error_code = ?, lease_until = NULL WHERE id = ?`, `cap:${refused}`, r.id)
                return 'skipped_budget'
            }
        }
        run('UPDATE rv_run SET attempts = attempts + 1 WHERE id = ?', r.id)
        counted = true
        const attempts = r.attempts + 1
        const ctx = baselineContext(loadBaselines())
        const app_events = await deps.appEvents(r.session_id)
        const { data, bytes } = await deps.withSnapshots(r.session_id, async (file) => ({ bytes: await deps.fileSize(file), data: await deps.analyze(file, { start_time: meta.start_time, app_events }, MONITOR.analysisTimeoutMs, ctx) }))
        addDownloadBytes(bytes, now)
        const reasons = data.coverage.reasons ?? []
        if (reasons.some((x) => x === 'timeout' || x === 'worker_crash' || x === 'worker_exit' || x === 'worker_error')) {
            retryLater(r.id, now, reasons.find((x) => x.startsWith('worker') || x === 'timeout')!, true, attempts)
            return attempts >= MONITOR.maxAttempts ? 'failed_permanent' : 'retry'
        }
        const state = data.coverage.state === 'complete' ? 'complete' : data.coverage.state === 'oversize' ? 'oversize' : 'partial'
        // Findings first (idempotent), then the run state: a crash in between leaves the run leased and it is redone.
        storeFindings(r.id, r.session_id, data.candidates)
        run(`UPDATE rv_run SET state = ?, lease_until = NULL, completed_at = ?, coverage_json = ?, metrics_json = ?, error_code = NULL, next_attempt_at = NULL WHERE id = ?`,
            state === 'oversize' ? 'partial' : state, iso(deps.now()), JSON.stringify({ ...data.coverage, run_state: state }), JSON.stringify(runMetrics(data.screens, data.candidates, data.events, bytes, data.metrics)), r.id)
        // The baseline used for later comparisons excludes the run being evaluated.
        recomputeBaselines(r.id, new Date(deps.now()))
        await refreshScopes(r, deps)
        status.lastOk = iso(deps.now())
        return state
    } catch (e) {
        const st = e instanceof PostHogError ? e.status : undefined
        const msg = e instanceof Error ? e.message : ''
        if (st === 404 && /no stored snapshots yet/i.test(msg)) { run('UPDATE rv_run SET attempts = MAX(0, attempts - ?) WHERE id = ?', counted ? 1 : 0, r.id); retryLater(r.id, now, 'snapshots_pending', false, r.attempts); return 'retry' }
        if (st === 404) { run(`UPDATE rv_run SET state = 'unavailable', error_code = 'not_found', lease_until = NULL WHERE id = ?`, r.id); return 'unavailable' }
        if (st === 413 || /too large|REPLAY_MAX/i.test(msg)) { run(`UPDATE rv_run SET state = 'too_large', error_code = 'too_large', lease_until = NULL WHERE id = ?`, r.id); return 'too_large' }
        // PostHog down, rate limited, a network failure or a recording-API outage is infrastructure: it never uses the session's attempts.
        const network = !(e instanceof PostHogError) && (e instanceof TypeError && /fetch/i.test(msg) || /ECONN|ETIMEDOUT|EAI_AGAIN|socket|aborted|timeout/i.test(msg) || (e as { name?: string })?.name === 'AbortError')
        if (!(e instanceof PostHogError) && !network) {
            // A bug or unexpected data: counts as an attempt, so a poison session ends failed_permanent instead of looping.
            console.error('replay vision run failed:', msg.slice(0, 200))
            if (!counted) run('UPDATE rv_run SET attempts = attempts + 1 WHERE id = ?', r.id)
            retryLater(r.id, now, 'analysis_error', true, r.attempts + 1)
            return r.attempts + 1 >= MONITOR.maxAttempts ? 'failed_permanent' : 'retry'
        }
        if (network || st === undefined || st === 429 || st >= 500) {
            status.lastError = st === 429 ? 'rate_limited' : st === 500 ? 'recording_api_failure' : 'posthog_unavailable'
            run(`UPDATE rv_run SET state = 'retry', error_code = ?, lease_until = NULL, next_attempt_at = ?, attempts = MAX(0, attempts - ?) WHERE id = ?`, status.lastError, iso(now + 10 * 60_000), counted ? 1 : 0, r.id)
            return 'retry'
        }
        retryLater(r.id, now, `http_${st}`, true, r.attempts + 1)
        return 'retry'
    }
}

async function refreshScopes(r: VisionRun, deps: VisionDeps) {
    const to = new Date(deps.now()), from = new Date(+to - 30 * DAY)
    for (const scope of [r.client_id ? { client: r.client_id } : null, r.distinct_id ? { user: r.distinct_id } : null]) {
        if (!scope) continue
        let reach
        try { reach = await deps.reach(scope, from, to) } catch { reach = undefined } // falls back to analysed recordings (labelled lower bound)
        refreshInsights(scope, { now: to, reach })
    }
}

/** Discover finished recordings of watched clients/users and queue them. Bounded pages per tick; resumes from a keyset cursor. */
export async function discover(deps: VisionDeps = realDeps): Promise<number> {
    const watches = all<Watch>('SELECT id, kind, value, enabled, max_sessions_per_day FROM rv_watch WHERE enabled = 1 LIMIT 200')
    if (!watches.length) return 0
    const now = deps.now()
    const saved = one<{ keyset_json: string }>(`SELECT keyset_json FROM rv_cursor WHERE project_id = ? AND scope = 'discovery'`, config.posthog.projectId)
    let cursor: { end: string; session_id: string } | undefined
    try { const k = JSON.parse(saved?.keyset_json || '{}'); if (k.end && k.session_id) cursor = k } catch {}
    let queued = 0
    for (let page = 0; page < MONITOR.discoveryPagesPerTick; page++) {
        const res = await deps.discover({ from: new Date(now - MONITOR.discoveryWindowMs), to: new Date(now - MONITOR.quietMs), cursor, limit: 100 })
        for (const row of res.rows) {
            status.discovered++
            if (!row.client_id && !row.distinct_id) { status.unmatched++; continue } // no trustworthy identity: re-seen next pass via the rolling window
            const matching = watches.filter((w) => (w.kind === 'client' ? w.value === row.client_id : w.value === row.distinct_id))
            if (!matching.length) continue
            const existing = one<{ id: number }>(`SELECT id FROM rv_run WHERE project_id = ? AND session_id = ? AND recording_end = ? AND analysis_version = ?`, config.posthog.projectId, row.session_id, row.end, analysisVersion)
            queueReplayVision(row.session_id, row.end, row.client_id, row.distinct_id, matching.map((w) => w.id))
            if (!existing) queued++
        }
        cursor = res.next
        if (!cursor) break
    }
    // A finished pass resets the cursor so the next tick rescans the rolling window (unique run keys absorb repeats and late rows).
    run(`INSERT INTO rv_cursor(project_id, scope, keyset_json, last_success_at) VALUES(?, 'discovery', ?, ?) ON CONFLICT(project_id, scope) DO UPDATE SET keyset_json = excluded.keyset_json, last_success_at = excluded.last_success_at, last_error_code = NULL`,
        config.posthog.projectId, JSON.stringify(cursor ?? {}), iso(now))
    status.lastScan = iso(now)
    return queued
}

/** Retention: replay-derived data never outlives MONITOR.retentionDays; runs no watch references (and not on-demand) are dropped. */
export function pruneVision(now = Date.now()): number {
    const cutoff = iso(now - MONITOR.retentionDays * DAY)
    return tx(() => {
        const old = Number(run(`DELETE FROM rv_run WHERE COALESCE(completed_at, started_at, recording_end) < ?`, cutoff).changes)
        const orphans = Number(run(`DELETE FROM rv_run WHERE requested_by IS NULL AND id NOT IN (SELECT run_id FROM rv_run_watch) AND state NOT IN ('running')`).changes)
        run('DELETE FROM rv_insight WHERE id NOT IN (SELECT insight_id FROM rv_insight_member)')
        run(`DELETE FROM rv_budget WHERE day_utc < ?`, cutoff.slice(0, 10))
        return old + orphans
    })
}

/** B′: explain the top insights of each scope (off unless external analysis is allowed and a provider is configured). */
export async function textStage(deps: VisionDeps = realDeps): Promise<void> {
    if (!externalAnalysisAllowed()) return
    const provider = selectProvider(true)
    if (!provider) return
    await collectExplanations({ provider, now: deps.now })
    for (const s of all<{ scope_key: string }>(`SELECT DISTINCT scope_key FROM rv_insight WHERE dismissed_at IS NULL LIMIT 20`)) {
        if (stopping) break
        await prepareExplanations(s.scope_key, { provider, windowsFor: deps.windowsFor, now: deps.now }, 5)
    }
}

/** Last Watch-fully capability check, for the status page (never assumed available). */
export const watchStatus: { available: boolean | null; reason: string; checked_at: string | null } = { available: null, reason: 'not checked yet', checked_at: null }
/** Watch fully: collect answers, then send at most one session per tick (render cost is real). Off unless every gate passes. */
export async function watchStage(deps: VisionDeps = realDeps): Promise<void> {
    if (!deps.watchPlanFor || !deps.renderWatchFrames) return
    if (!externalAnalysisAllowed()) return
    const provider = selectProvider(true)
    if (!provider) return
    const a = await watchFullyAvailability(provider)
    Object.assign(watchStatus, { available: a.available, reason: a.reason, checked_at: new Date(deps.now()).toISOString() })
    const since = new Date(deps.now() - 1000).toISOString()
    const got = await collectWatchFully({ provider })
    if (got.accepted_findings) for (const r of all<{ client_id: string | null; distinct_id: string | null }>(`SELECT DISTINCT r.client_id, r.distinct_id FROM rv_watch_fully_job j JOIN rv_run r ON r.id = j.run_id WHERE j.state = 'complete' AND j.updated_at >= ? LIMIT 20`, since)) {
        for (const scope of [r.client_id ? { client: r.client_id } : null, r.distinct_id ? { user: r.distinct_id } : null]) if (scope) refreshInsights(scope, { now: new Date(deps.now()) })
    }
    if (stopping || !a.available) return
    await prepareWatchFully({ provider, planFor: deps.watchPlanFor, render: deps.renderWatchFrames, externalAllowed: true, enabled: replayVisionEnabled(), now: deps.now }, 1)
}

let timer: NodeJS.Timeout | undefined, busy = false, stopping = false
export async function replayVisionTick(deps: VisionDeps = realDeps): Promise<void> {
    if (!replayVisionEnabled() || busy || stopping) return
    busy = true
    try {
        startupReconcile(deps.now())
        try { await discover(deps) } catch (e) {
            status.lastError = e instanceof Error && /timeout/i.test(e.message) ? 'posthog_timeout' : 'posthog_unavailable'
            run(`INSERT INTO rv_cursor(project_id, scope, last_error_code) VALUES(?, 'discovery', ?) ON CONFLICT(project_id, scope) DO UPDATE SET last_error_code = excluded.last_error_code`, config.posthog.projectId, status.lastError)
        }
        for (let i = 0; i < MONITOR.runsPerTick && !stopping; i++) {
            const r = claimNext(deps.now())
            if (!r) break
            await processRun(r, deps)
        }
        await textStage(deps)
        await watchStage(deps)
        pruneVision(deps.now())
    } catch (e) {
        status.lastError = 'internal_error'
        console.error('replay vision tick failed:', e instanceof Error ? e.message : 'error')
    } finally { busy = false }
}
export function startReplayVision(deps: VisionDeps = realDeps): void {
    if (!replayVisionEnabled() || timer) return
    stopping = false
    startupReconcile(deps.now())
    const loop = () => { timer = setTimeout(() => { void replayVisionTick(deps).finally(() => { if (!stopping) loop() }) }, MONITOR.pollMs + Math.floor(Math.random() * 30_000)); timer.unref() }
    void replayVisionTick(deps).finally(loop)
}
export function stopReplayVision(): void { stopping = true; if (timer) clearTimeout(timer); timer = undefined }

export function replayVisionCounts(): Record<string, number> {
    return Object.fromEntries(all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM rv_run GROUP BY state LIMIT 30').map((c) => [c.state, c.n]))
}
export function replayVisionJobState() {
    const counts = replayVisionCounts()
    const on = replayVisionEnabled()
    return {
        key: 'replay_vision', label: 'Replay Vision', level: !on ? 'waiting' : status.lastError ? 'warn' : 'ok',
        detail: !on ? 'off' : status.lastError || `Runs: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none yet'}`,
        last_ok_at: status.lastOk, last_scan_at: status.lastScan, unmatched_recordings: status.unmatched, counts,
    }
}
/** Called when PostHog deletes a recording (replayretention.ts): replay-derived data never outlives its source. */
export function deleteVisionSession(sessionId: string): void { deleteSessionData(sessionId) }
