import { deleteReplayCache } from '../core/clip.ts'
// Rolling session-replay retention.
//
// An admin sets replay_retention_days on the admin page (off by default: nothing is ever deleted). Once a
// day the job deletes the PostHog recordings that started before the cutoff (UTC midnight today minus N
// days) through PostHog's own API (DELETE /api/projects/:id/session_recordings/:id/), in small batches and
// at most LENS_REPLAY_RETENTION_MAX_PER_RUN a run. Lens's clip cache follows the same cutoff: clips of those
// recordings are deleted unless someone saved them (saved clips stay until unsaved, as everywhere else).
//
// Safety: nothing is deleted while the setting is off, without LENS_REPLAY_RETENTION_API_KEY, or when that
// key cannot confirm it reaches the configured project. LENS_REPLAY_RETENTION_DRY_RUN=1 only logs. The first
// error stops a run; the next try waits (1 h, doubling, at most 24 h). Logs and audit rows hold counts and
// dates only, never session ids or content.
import { config } from '../core/config.ts'
import { getSetting, setSetting, tx } from '../core/db.ts'
import { hogql, type Row } from '../core/posthog.ts'
import { audit } from './access.ts'
import { deleteClip, listClips } from './replays.ts'

export const RETENTION_KEY = 'replay_retention_days'
const WATERMARK = 'replay_retention_watermark' // last recording handled: { start, id }
const RESCAN = 'replay_retention_rescan_at' // beginning of the last bounded full scan
const STATE = 'replay_retention_state' // { last_day, failures, retry_at, claim_at }
export const MIN_DAYS = 7
export const MAX_DAYS = 3650
const DAY = 86_400_000

// ------------------------------------------------------------------ the setting
/** off (null) or a whole number of days from 7 to 3650. Throws on anything else. */
export function parseRetentionDays(value: unknown): number | null {
    if (value === null || value === undefined || value === '' || value === 'off' || value === false) return null
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
    if (!/^\d+$/.test(text)) throw new Error(`Give "off" or a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}.`)
    const n = Number(text)
    if (n < MIN_DAYS || n > MAX_DAYS) throw new Error(`Give "off" or a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}.`)
    return n
}
export function retentionDays(): number | null {
    try { return parseRetentionDays(getSetting<unknown>(RETENTION_KEY, null)) } catch { return null }
}
export function setRetentionDays(value: unknown, by: string, preview?: Preview): { before: number | null; after: number | null } {
    const after = parseRetentionDays(value)
    return tx(() => {
        const before = retentionDays()
        if (before === after) return { before, after }
        setSetting(RETENTION_KEY, after)
        audit(by, 'replay_retention.set', {
            before: before ?? 'off', after: after ?? 'off',
            ...(preview ? { cutoff: preview.cutoff, would_delete: preview.count, clips_would_delete: preview.clips.delete } : {}),
        })
        return { before, after }
    })
}

/** UTC midnight today minus `days` days. Recordings that started before it are deleted. */
export function cutoffFor(days: number, now: Date = new Date()): Date {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    return new Date(midnight - days * DAY)
}

// ------------------------------------------------------------------ environment
export interface RetentionEnv { apiKey: string; dryRun: boolean; maxPerRun: number; batch: number }
export function retentionEnv(env: Record<string, string | undefined> = process.env): RetentionEnv {
    const int = (key: string, fallback: number, min: number, max: number) => {
        const v = String(env[key] ?? '').trim()
        const n = v === '' ? fallback : Number(v)
        return Number.isInteger(n) && n >= min && n <= max ? n : fallback
    }
    return {
        apiKey: String(env.LENS_REPLAY_RETENTION_API_KEY ?? '').trim(),
        dryRun: ['1', 'on', 'true', 'yes'].includes(String(env.LENS_REPLAY_RETENTION_DRY_RUN ?? '').trim().toLowerCase()),
        maxPerRun: int('LENS_REPLAY_RETENTION_MAX_PER_RUN', 2000, 1, 100_000),
        batch: int('LENS_REPLAY_RETENTION_BATCH', 100, 1, 500),
    }
}

// ------------------------------------------------------------------ PostHog
export interface Deps {
    query: (sql: string, values: Record<string, unknown>) => Promise<Row[]>
    fetch: typeof fetch
    now: () => Date
    sleep: (ms: number) => Promise<void>
    log: (msg: string, extra?: Record<string, unknown>) => void
    env: Record<string, string | undefined>
}
const defaults: Deps = {
    query: (sql, values) => hogql(sql, values, { timeoutMs: 120_000 }),
    fetch: (...a) => globalThis.fetch(...a),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra })),
    env: process.env,
}
const withDefaults = (d: Partial<Deps> = {}): Deps => ({ ...defaults, ...d })

interface Mark { start: string; id: string }
const NO_MARK: Mark = { start: '', id: '' }
const watermark = (): Mark => {
    const m = getSetting<Mark | null>(WATERMARK, null)
    return m && typeof m.start === 'string' && typeof m.id === 'string' ? m : NO_MARK
}
/** ClickHouse wants "YYYY-MM-DD HH:MM:SS" for a UTC DateTime literal. */
const chTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')

// One row per recording (session): when it started. The (start_key, session_id) keyset continues after the
// last recording handled, so a rerun never asks PostHog to delete the same recording again, and recordings
// PostHog keeps listing during its own grace period after a delete do not block progress.
const OLD_RECORDINGS = `FROM (
        SELECT session_id, min(min_first_timestamp) AS start FROM raw_session_replay_events
        WHERE min_first_timestamp < toDateTime({cutoff}, 'UTC')
        GROUP BY session_id
    )
    WHERE start < toDateTime({cutoff}, 'UTC')
      AND (toString(start) > {after_start} OR (toString(start) = {after_start} AND session_id > {after_id}))`

async function listOld(d: Deps, cutoff: Date, after: Mark, limit: number): Promise<{ id: string; start: string }[]> {
    const rows = await d.query(
        `SELECT session_id, toString(start) AS start_key ${OLD_RECORDINGS} ORDER BY start_key, session_id LIMIT {limit}`,
        { cutoff: chTime(cutoff), after_start: after.start, after_id: after.id, limit }
    )
    return rows.map((r) => ({ id: String(r.session_id), start: String(r.start_key) }))
}
async function countOld(d: Deps, cutoff: Date, after: Mark): Promise<{ count: number; oldest: string | null }> {
    const rows = await d.query(`SELECT count() AS n, min(start) AS oldest ${OLD_RECORDINGS}`, { cutoff: chTime(cutoff), after_start: after.start, after_id: after.id })
    const n = Number(rows[0]?.n ?? 0)
    const oldest = n > 0 && rows[0]?.oldest ? new Date(Date.parse(String(rows[0].oldest).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(rows[0].oldest)) ? '' : 'Z'))) : null
    return { count: n, oldest: oldest && Number.isFinite(oldest.getTime()) ? oldest.toISOString() : null }
}

/** The delete key must reach exactly the configured project (and its token, when one is configured). */
async function confirmProject(d: Deps, key: string): Promise<string | undefined> {
    const id = config.posthog.projectId
    if (!/^\d+$/.test(id)) return 'POSTHOG_PROJECT_ID is not set'
    if (!key) return 'LENS_REPLAY_RETENTION_API_KEY is not set'
    try {
        const res = await d.fetch(`${config.posthog.host}/api/projects/${id}/`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
        if (!res.ok) { await res.body?.cancel(); return `project check answered ${res.status}` }
        const p = (await res.json()) as { id?: unknown; api_token?: unknown }
        if (String(p.id) !== id) return 'the key reaches a different project'
        if (config.posthog.projectToken && p.api_token !== config.posthog.projectToken) return 'the project token does not match POSTHOG_PROJECT_TOKEN'
        return undefined
    } catch (e) {
        return `project check failed (${(e as Error).name})`
    }
}

type DeleteResult = 'deleted' | 'gone' | 'stopped' | { error: string }
const retryable = (status: number) => status === 429 || status >= 500
async function deleteRecording(d: Deps, key: string, sessionId: string, stopped: () => boolean): Promise<DeleteResult> {
    const url = `${config.posthog.host}/api/projects/${config.posthog.projectId}/session_recordings/${encodeURIComponent(sessionId)}/`
    let last = ''
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await d.sleep(1000 * 2 ** attempt)
        if (stopped()) return 'stopped'
        try {
            const res = await d.fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
            await res.body?.cancel()
            if (res.status === 204 || res.ok) return 'deleted'
            if (res.status === 404 || res.status === 410) return 'gone' // already deleted: a rerun is harmless
            last = `PostHog answered ${res.status}`
            if (!retryable(res.status)) break
        } catch (e) {
            last = `request failed (${(e as Error).name})` // never the URL: it holds the session id
        }
    }
    return { error: last }
}

// ------------------------------------------------------------------ clips
interface ClipPlan { delete: string[]; kept_saved: number }
/** Clips of recordings that started before the cutoff. A clip whose recording start is unknown counts as
 * older when the clip itself was made before the cutoff (a clip is made after its recording started). */
function clipPlan(cutoff: Date): ClipPlan {
    const plan: ClipPlan = { delete: [], kept_saved: 0 }
    for (const c of listClips({ limit: -1 })) {
        const start = Date.parse(c.recording_start || c.created_at)
        if (!Number.isFinite(start) || start >= cutoff.getTime()) continue
        if (c.saved_by.length) plan.kept_saved++
        else plan.delete.push(c.name)
    }
    return plan
}

// ------------------------------------------------------------------ preview
export interface Preview { days: number; cutoff: string; count: number | null; oldest: string | null; error?: string; clips: { delete: number; kept_saved: number } }
/** What `days` would delete now, without deleting anything. count is null when PostHog could not answer. */
export async function previewRetention(days: number, deps: Partial<Deps> = {}): Promise<Preview> {
    const d = withDefaults(deps)
    const cutoff = cutoffFor(days, d.now())
    const plan = clipPlan(cutoff)
    const clips = { delete: plan.delete.length, kept_saved: plan.kept_saved }
    try {
        const { count, oldest } = await countOld(d, cutoff, watermark())
        return { days, cutoff: cutoff.toISOString(), count, oldest, clips }
    } catch (e) {
        return { days, cutoff: cutoff.toISOString(), count: null, oldest: null, error: 'PostHog could not count the recordings: ' + ((e as { status?: number }).status ?? (e as Error).name), clips }
    }
}

// ------------------------------------------------------------------ the run
export interface RunResult {
    ran: boolean
    reason?: string
    days?: number
    cutoff?: string
    dry_run?: boolean
    deleted: number
    already_gone: number
    failed: number
    would_delete?: number
    clips_would_delete?: number
    capped?: boolean
    clips_deleted: number
    clips_kept_saved: number
    error?: string
}

let busy = false
/** One run. Safe to call again at any time: it continues after the last recording it handled. */
export async function runReplayRetention(deps: Partial<Deps> = {}): Promise<RunResult> {
    const d = withDefaults(deps)
    const empty: RunResult = { ran: false, deleted: 0, already_gone: 0, failed: 0, clips_deleted: 0, clips_kept_saved: 0 }
    const days = retentionDays()
    if (days === null) return { ...empty, reason: 'off' } // off: no PostHog calls at all
    if (busy) return { ...empty, reason: 'busy' }
    busy = true
    const env = retentionEnv(d.env)
    const cutoff = cutoffFor(days, d.now())
    const result: RunResult = { ...empty, ran: true, days, cutoff: cutoff.toISOString(), dry_run: env.dryRun }
    try {
        const problem = await confirmProject(d, env.apiKey)
        if (problem) {
            result.ran = false
            result.error = `not deleting: ${problem}`
            return result
        }
        const stopped = () => {
            const current = retentionDays()
            if (current === null) result.reason = 'retention disabled'
            else if (current > days) result.reason = 'retention days increased'
            return !!result.reason
        }
        let mark = watermark()
        const now = d.now().getTime()
        if (now - getSetting<number>(RESCAN, 0) >= 7 * DAY) {
            mark = NO_MARK
            if (!env.dryRun) { setSetting(WATERMARK, mark); setSetting(RESCAN, now) }
        }
        let handled = 0
        outer: while (handled < env.maxPerRun) {
            const want = Math.min(env.batch, env.maxPerRun - handled)
            let batch: { id: string; start: string }[]
            try { batch = await listOld(d, cutoff, mark, want) }
            catch (e) { result.error = `listing failed (${(e as { status?: number }).status ?? (e as Error).name})`; break }
            if (!batch.length) break
            for (const rec of batch) {
                if (stopped()) break outer
                handled++
                if (env.dryRun) { result.would_delete = (result.would_delete ?? 0) + 1; mark = rec; continue }
                const r = await deleteRecording(d, env.apiKey, rec.id, stopped)
                if (r === 'stopped') break outer
                if (typeof r === 'object') { result.failed++; result.error = r.error; break outer }
                if (r === 'deleted') result.deleted++
                else result.already_gone++
                deleteReplayCache(rec.id)
                mark = rec
                setSetting(WATERMARK, mark) // after every delete, so a crash loses nothing
            }
            if (batch.length < want) break // last page
            await d.sleep(250) // a breath between batches for PostHog
        }
        result.capped = !result.reason && !result.error && handled >= env.maxPerRun
        // The clip cache follows the same cutoff. Saved clips stay until someone unsaves them.
        if (stopped()) return result
        const plan = clipPlan(cutoff)
        result.clips_kept_saved = plan.kept_saved
        if (env.dryRun) { result.would_delete ??= 0; result.clips_would_delete = plan.delete.length }
        else if (!result.error) for (const name of plan.delete) {
            if (stopped()) break
            if (deleteClip(name)) result.clips_deleted++
        }
        return result
    } finally {
        busy = false
        const counts = { days, cutoff: result.cutoff, dry_run: result.dry_run, deleted: result.deleted, already_gone: result.already_gone, failed: result.failed,
            ...(env.dryRun ? { would_delete: result.would_delete ?? 0, clips_would_delete: result.clips_would_delete ?? 0 } : {}),
            capped: !!result.capped, clips_deleted: result.clips_deleted, clips_kept_saved: result.clips_kept_saved, ...(result.reason ? { reason: result.reason } : {}), ...(result.error ? { error: result.error } : {}) }
        audit('system', 'replay_retention.run', counts)
        d.log(env.dryRun ? 'replay retention dry run' : 'replay retention run', counts)
    }
}

// ------------------------------------------------------------------ daily schedule
interface State { last_day?: string; failures?: number; retry_at?: number; claim_at?: number; last?: RunResult & { at: string } }
export const retentionState = (): State => getSetting<State>(STATE, {})
const HOUR = 3_600_000
/** A tick: runs at most once per UTC day, and after a failure waits 1 h, 2 h, 4 h … (at most 24 h). */
export function createRetentionScheduler(deps: Partial<Deps> = {}) {
    const d = withDefaults(deps)
    return async function tick(): Promise<RunResult | undefined> {
        if (retentionDays() === null) return undefined
        const now = d.now(), day = now.toISOString().slice(0, 10)
        const claimed = tx(() => {
            const s = retentionState()
            if (s.last_day === day) return false
            if (s.retry_at && now.getTime() < s.retry_at) return false
            if (s.claim_at && now.getTime() - s.claim_at < 6 * HOUR) return false // another process is on it
            setSetting(STATE, { ...s, claim_at: now.getTime() })
            return true
        })
        if (!claimed) return undefined
        let r: RunResult
        try { r = await runReplayRetention(d) }
        catch (e) { r = { ran: false, deleted: 0, already_gone: 0, failed: 1, clips_deleted: 0, clips_kept_saved: 0, error: (e as Error).name } }
        const s = retentionState()
        const last = { ...r, at: now.toISOString() }
        if (r.error) {
            const failures = (s.failures ?? 0) + 1
            setSetting(STATE, { ...s, claim_at: undefined, failures, retry_at: now.getTime() + Math.min(24, 2 ** (failures - 1)) * HOUR, last })
        } else setSetting(STATE, { last_day: day, failures: 0, last })
        return r
    }
}
export function startReplayRetention(): () => void {
    const tick = createRetentionScheduler()
    const go = () => void tick().catch(() => {})
    const first = setTimeout(go, 60_000); first.unref()
    const timer = setInterval(go, HOUR); timer.unref()
    return () => { clearTimeout(first); clearInterval(timer) }
}

/** For the admin page: the setting, the switches and the last run. */
export function retentionStatus() {
    const env = retentionEnv()
    const days = retentionDays()
    const s = retentionState()
    return {
        days, min_days: MIN_DAYS, max_days: MAX_DAYS,
        cutoff: days === null ? null : cutoffFor(days).toISOString(),
        configured: !!env.apiKey, dry_run: env.dryRun, max_per_run: env.maxPerRun,
        last_run: s.last ?? null, retry_at: s.retry_at ? new Date(s.retry_at).toISOString() : null,
    }
}
