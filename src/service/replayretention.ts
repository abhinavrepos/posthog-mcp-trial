import { deleteReplayCache } from '../core/clip.ts'
// Rolling session-replay retention.
//
// An admin sets replay_retention_days on the admin page (off by default: nothing is ever deleted). Once a
// day the job deletes the PostHog recordings that started before the cutoff (UTC midnight today minus N
// days) through PostHog's own API (DELETE /api/projects/:id/session_recordings/:id/), in small batches and
// at most LENS_REPLAY_RETENTION_MAX_PER_RUN a run. Signal's clip cache follows the same cutoff: clips of those
// recordings are deleted unless someone saved them (saved clips stay until unsaved, as everywhere else).
//
// Safety: nothing is deleted while the setting is off, without LENS_REPLAY_RETENTION_API_KEY, or when that
// key cannot confirm it reaches the configured project. LENS_REPLAY_RETENTION_DRY_RUN=1 only logs. The first
// error stops a run; the next try waits (1 h, doubling, at most 24 h). Logs and audit rows hold counts and
// dates only, never session ids or content.
import type { JobState } from '../core/jobhealth.ts'
import { config } from '../core/config.ts'
import { getSetting, setSetting, tx } from '../core/db.ts'
import { hogql, type Row } from '../core/posthog.ts'
import { audit } from './access.ts'
import { deleteClip, getClip, listClips } from './replays.ts'

export const RETENTION_KEY = 'replay_retention_days'
const WATERMARK = 'replay_retention_watermark' // last recording handled: { start, id }
const SCAN_COMPLETE = 'replay_retention_scan_complete'
const RESCAN = 'replay_retention_rescan_at' // beginning of the last bounded full scan
const STATE = 'replay_retention_state' // { last_day, failures, retry_at, claim_at }
export const MIN_DAYS = 7
export const MAX_DAYS = 3650
const DAY = 86_400_000
const HOUR = 3_600_000
const CLAIM_TTL = 6 * HOUR
const RUN_LIMIT = HOUR
const POLICY = 'replay_retention_policy'
interface Policy { revision?: number; hold?: { until: number; previous: number } }
const policy = () => getSetting<Policy>(POLICY, {})

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
export function setRetentionDays(value: unknown, by: string, preview?: Preview, now = new Date()): { before: number | null; after: number | null } {
    const after = parseRetentionDays(value)
    return tx(() => {
        const before = retentionDays()
        if (before === after) return { before, after }
        const previous = policy()
        const hold = after !== null && before !== null && after < before
            ? { until: now.getTime() + DAY, previous: previous.hold && previous.hold.until > now.getTime() ? previous.hold.previous : before }
            : undefined
        setSetting(RETENTION_KEY, after)
        setSetting(POLICY, { revision: (previous.revision ?? 0) + 1, hold })
        setSetting(STATE, { ...retentionState(), remaining: preview?.count ?? null, retry_at: undefined, failures: 0 })
        audit(by, 'replay_retention.set', {
            before: before ?? 'off', after: after ?? 'off',
            ...(preview ? { cutoff: preview.cutoff, would_delete: preview.count, clips_would_delete: preview.clips.delete } : {}),
        })
        return { before, after }
    })
}

export function cancelRetentionDecrease(by: string, now = new Date()): boolean {
    return tx(() => {
        const p = policy()
        if (!p.hold || p.hold.until <= now.getTime()) return false
        const before = retentionDays()
        setSetting(RETENTION_KEY, p.hold.previous)
        setSetting(POLICY, { revision: (p.revision ?? 0) + 1 })
        setSetting(STATE, { ...retentionState(), remaining: null })
        audit(by, 'replay_retention.cancel_decrease', { before, after: p.hold.previous })
        return true
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
const rescanDue = (now: number) => {
    const last = getSetting<number>(RESCAN, 0)
    return !last || (getSetting(SCAN_COMPLETE, false) && now - last >= 7 * DAY)
}
/** ClickHouse wants "YYYY-MM-DD HH:MM:SS" for a UTC DateTime literal. */
const chTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')

// One row per recording (session): when it started. The (start_key, session_id) keyset continues after the
// last recording handled, so a rerun never asks PostHog to delete the same recording again, and recordings
// PostHog keeps listing during its own grace period after a delete do not block progress.
const OLD_RECORDINGS = `FROM (
        SELECT session_id, min(min_first_timestamp) AS start FROM raw_session_replay_events
        WHERE min_first_timestamp < toDateTime({cutoff}, 'UTC') OR is_deleted = 1
        GROUP BY session_id
        HAVING max(is_deleted) = 0
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
    const n = Number(rows[0]?.n ?? NaN)
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid recording count')
    const oldest = n > 0 && rows[0]?.oldest ? new Date(Date.parse(String(rows[0].oldest).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(rows[0].oldest)) ? '' : 'Z'))) : null
    return { count: n, oldest: oldest && Number.isFinite(oldest.getTime()) ? oldest.toISOString() : null }
}

const POSTHOG_PERIODS = { '30d': 30, '90d': 90, '1y': 365, '5y': 1825 } as const
type Period = keyof typeof POSTHOG_PERIODS
const periods = Object.keys(POSTHOG_PERIODS) as Period[]
const asPeriod = (value: unknown) => periods.find((period) => period === value)

async function posthogProject(d: Deps, key: string, period?: Period): Promise<{ period?: Period; error?: string }> {
    const id = config.posthog.projectId
    if (!/^\d+$/.test(id)) return { error: 'POSTHOG_PROJECT_ID is not set' }
    if (!key) return { error: 'LENS_REPLAY_RETENTION_API_KEY is not set' }
    const action = period ? 'PostHog retention update' : 'PostHog project check'
    try {
        const res = await d.fetch(`${config.posthog.host}/api/projects/${id}/`, {
            headers: { authorization: `Bearer ${key}`, ...(period ? { 'content-type': 'application/json' } : {}) },
            signal: AbortSignal.timeout(30_000), redirect: 'error',
            ...(period ? { method: 'PATCH', body: JSON.stringify({ session_recording_retention_period: period }) } : {}),
        })
        if (!res.ok) {
            await res.body?.cancel()
            if (period && (res.status === 401 || res.status === 403)) {
                return { error: `PostHog refused the retention change (HTTP ${res.status}). Check project write access and the PostHog plan.` }
            }
            return { error: `${action} returned HTTP ${res.status}` }
        }
        const p = (await res.json()) as { id?: unknown; api_token?: unknown; session_recording_retention_period?: unknown }
        if (String(p.id) !== id) return { error: 'the key reaches a different project' }
        if (config.posthog.projectToken && p.api_token !== config.posthog.projectToken) return { error: 'the project token does not match POSTHOG_PROJECT_TOKEN' }
        return { period: asPeriod(p.session_recording_retention_period) }
    } catch (e) {
        return { error: `${action} failed (${(e as Error).name})` }
    }
}

async function readPosthogRetention(d: Deps, days: number) {
    const key = retentionEnv(d.env).apiKey
    let project = await posthogProject(d, key || config.posthog.personalApiKey)
    if (project.error && key && config.posthog.personalApiKey && key !== config.posthog.personalApiKey) {
        project = await posthogProject(d, config.posthog.personalApiKey)
    }
    const { period, error } = project
    if (!period) return { warning: error ?? 'PostHog did not report a recognized replay retention period.' }
    const currentDays = POSTHOG_PERIODS[period]
    if (currentDays >= days) return { period }
    const offer = key ? periods.find((p) => POSTHOG_PERIODS[p] >= days) : undefined
    const warning = `PostHog keeps new recordings for ${currentDays} days. They can expire before the ${days} days set in Signal.`
    return { period, offer, warning: days > POSTHOG_PERIODS['5y'] ? warning + ' PostHog supports at most 1,825 days.' : warning }
}

export async function posthogRetentionStatus(days: number) {
    return readPosthogRetention(defaults, days)
}

let updatingPosthog = false
export async function raisePosthogRetention(days: number, requested: unknown, deps: Partial<Deps> = {}): Promise<string | undefined> {
    if (updatingPosthog) return 'A PostHog retention update is already in progress.'
    updatingPosthog = true
    try {
        const d = withDefaults(deps)
        const expected = periods.find((p) => POSTHOG_PERIODS[p] >= days)
        const key = retentionEnv(d.env).apiKey
        if (!key || !expected || requested !== expected) return 'Preview the PostHog retention change again.'
        const current = await posthogProject(d, key)
        if (current.error) return current.error
        if (!current.period) return 'PostHog did not report a recognized replay retention period.'
        if (POSTHOG_PERIODS[current.period] >= days) return undefined
        if (retentionDays() !== days) return 'Signal retention changed. Reload and try again.'
        const updated = await posthogProject(d, key, expected)
        return updated.error ?? (updated.period === expected ? undefined : 'PostHog did not confirm the new retention period.')
    } finally { updatingPosthog = false }
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
export interface Preview {
    days: number; cutoff: string; count: number | null; oldest: string | null; error?: string
    clips: { delete: number; kept_saved: number }
    requires_confirm: boolean; revision: number
    posthog?: Awaited<ReturnType<typeof readPosthogRetention>>
}
/** What `days` would delete now, without deleting anything. */
export async function previewRetention(days: number, deps: Partial<Deps> = {}, checkPosthog = true): Promise<Preview> {
    const d = withDefaults(deps)
    const now = d.now()
    const cutoff = cutoffFor(days, now)
    const current = retentionDays()
    const revision = policy().revision ?? 0
    const plan = clipPlan(cutoff)
    const clips = { delete: plan.delete.length, kept_saved: plan.kept_saved }
    const requires_confirm = current === null || days < current
    const [result, posthog] = await Promise.all([
        countOld(d, cutoff, rescanDue(now.getTime()) ? NO_MARK : watermark()).catch((e: unknown) => ({
            count: null, oldest: null,
            error: 'PostHog could not count the recordings: ' + ((e as { status?: number }).status ?? (e as Error).name),
        })),
        checkPosthog ? readPosthogRetention(d, days) : undefined,
    ])
    return { days, cutoff: cutoff.toISOString(), ...result, clips, requires_confirm, revision, posthog }
}

/** Bind confirmation to the cutoff and counts shown to the admin. */
export const previewKey = (p: Preview) => JSON.stringify([p.days, p.cutoff, p.count, p.clips.delete, p.revision])
export const retentionRevision = () => policy().revision ?? 0

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
    const startPolicy = policy()
    if ((startPolicy.hold?.until ?? 0) > d.now().getTime()) return { ...empty, reason: 'decrease on hold' }
    if (busy) return { ...empty, reason: 'busy' }
    busy = true
    const env = retentionEnv(d.env)
    const now = d.now().getTime()
    const cutoff = cutoffFor(days, new Date(now))
    const result: RunResult = { ...empty, ran: true, days, cutoff: cutoff.toISOString(), dry_run: env.dryRun }
    try {
        const { error: problem } = await posthogProject(d, env.apiKey)
        if (problem) {
            result.ran = false
            result.error = `not deleting: ${problem}`
            return result
        }
        const stopped = () => {
            const current = retentionDays()
            if (current === null) result.reason = 'retention disabled'
            else if (current > days) result.reason = 'retention days increased'
            else if (current !== days || retentionRevision() !== (startPolicy.revision ?? 0)) result.reason = 'retention policy changed'
            return !!result.reason
        }
        if (stopped()) return result
        const outOfTime = () => d.now().getTime() - now >= RUN_LIMIT
        let mark = watermark()
        if (rescanDue(now)) {
            mark = NO_MARK
            if (!env.dryRun) tx(() => {
                setSetting(WATERMARK, mark)
                setSetting(RESCAN, now)
                setSetting(SCAN_COMPLETE, false)
            })
        }
        let handled = 0
        outer: while (handled < env.maxPerRun) {
            const want = Math.min(env.batch, env.maxPerRun - handled)
            let batch: { id: string; start: string }[]
            if (stopped() || outOfTime()) break
            try { batch = await listOld(d, cutoff, mark, want) }
            catch (e) { result.error = `listing failed (${(e as { status?: number }).status ?? (e as Error).name})`; break }
            if (!batch.length) break
            for (const rec of batch) {
                if (stopped() || outOfTime()) break outer
                handled++
                if (env.dryRun) { result.would_delete = (result.would_delete ?? 0) + 1; mark = rec; continue }
                const r = await deleteRecording(d, env.apiKey, rec.id, () => stopped() || outOfTime())
                if (r === 'stopped') break outer
                if (typeof r === 'object') { result.failed++; result.error = r.error; break outer }
                if (r === 'deleted') result.deleted++
                else result.already_gone++
                mark = rec
                tx(() => {
                    setSetting(WATERMARK, mark)
                    const state = retentionState()
                    const remaining = stopped() ? state.remaining : state.remaining == null ? null : Math.max(0, state.remaining - 1)
                    setSetting(STATE, { ...state, remaining, deleted_total: (state.deleted_total ?? 0) + Number(r === 'deleted') })
                })
                deleteReplayCache(rec.id)
            }
            if (batch.length < want) break // last page
            await d.sleep(250) // a breath between batches for PostHog
        }
        result.capped = !result.reason && !result.error && (handled >= env.maxPerRun || outOfTime())
        if (!env.dryRun && !stopped() && !result.error) setSetting(SCAN_COMPLETE, !result.capped)
        // The clip cache follows the same cutoff. Saved clips stay until someone unsaves them.
        if (stopped()) return result
        const plan = clipPlan(cutoff)
        result.clips_kept_saved = plan.kept_saved
        if (env.dryRun) { result.would_delete ??= 0; result.clips_would_delete = plan.delete.length }
        else if (!result.error) for (const name of plan.delete) {
            if (stopped() || outOfTime()) break
            if (tx(() => !stopped() && getClip(name)?.saved_by.length === 0 && deleteClip(name))) result.clips_deleted++
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
interface State {
    last_day?: string; failures?: number; retry_at?: number; claim_at?: number; last?: RunResult & { at: string }
    last_error?: { at: string; message: string }; last_ok_at?: string; deleted_total?: number; remaining?: number | null
}
export const retentionState = (): State => getSetting<State>(STATE, {})
/** A tick: runs at most once per UTC day, and after a failure waits 1 h, 2 h, 4 h … (at most 24 h). */
export function createRetentionScheduler(deps: Partial<Deps> = {}) {
    const d = withDefaults(deps)
    return async function tick(): Promise<RunResult | undefined> {
        if (retentionDays() === null) return undefined
        const now = d.now(), day = now.toISOString().slice(0, 10)
        const revision = retentionRevision()
        const claimed = tx(() => {
            const s = retentionState()
            if ((policy().hold?.until ?? 0) > now.getTime() || s.last_day === day) return false
            if (s.retry_at && now.getTime() < s.retry_at) return false
            if (s.claim_at && now.getTime() - s.claim_at < CLAIM_TTL) return false // another process is on it
            setSetting(STATE, { ...s, claim_at: now.getTime() })
            return true
        })
        if (!claimed) return undefined
        let r: RunResult
        try { r = await runReplayRetention(d) }
        catch (e) { r = { ran: false, deleted: 0, already_gone: 0, failed: 1, clips_deleted: 0, clips_kept_saved: 0, error: (e as Error).name } }
        let remaining: number | null = null
        if (!r.reason && !r.error && r.days !== undefined && revision === retentionRevision()) {
            try { remaining = (await countOld(d, cutoffFor(r.days, now), watermark())).count }
            catch { /* The run still succeeded. The remaining count is unavailable. */ }
        }
        tx(() => {
            const s = retentionState()
            const last = { ...r, at: now.toISOString() }
            const state = { ...s, claim_at: undefined, last }
            if (r.reason || revision !== retentionRevision()) {
                setSetting(STATE, state)
            } else if (r.error) {
                const failures = (s.failures ?? 0) + 1
                setSetting(STATE, { ...state, failures, retry_at: now.getTime() + Math.min(24, 2 ** (failures - 1)) * HOUR,
                    last_error: { at: last.at, message: r.error } })
            } else {
                setSetting(STATE, { ...state, remaining, last_day: day, last_ok_at: last.at, failures: 0, retry_at: undefined })
            }
        })
        return r
    }
}
let nextTickAt: number | undefined
export function startReplayRetention(): () => void {
    const tick = createRetentionScheduler()
    const go = () => {
        nextTickAt = Date.now() + HOUR
        void tick().catch((e) => defaults.log('replay retention scheduler failed', { error: (e as Error).name }))
    }
    nextTickAt = Date.now() + 60_000
    let timer: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(() => {
        go()
        timer = setInterval(go, HOUR)
        timer.unref()
    }, 60_000)
    first.unref()
    return () => { clearTimeout(first); clearInterval(timer); nextTickAt = undefined }
}

/** Shared by Admin and System so progress survives restarts. */
export function retentionStatus(now = new Date()) {
    const env = retentionEnv()
    const days = retentionDays()
    const s = retentionState()
    const hold = policy().hold
    const pending = hold && hold.until > now.getTime() ? hold : undefined
    const day = now.toISOString().slice(0, 10)
    const daily = s.last_day === day ? Date.parse(day) + DAY : now.getTime()
    const running = !!s.claim_at && now.getTime() - s.claim_at < CLAIM_TTL
    const eligible = Math.max(daily, s.retry_at ?? 0, pending?.until ?? 0)
    const next = days === null ? null : new Date(nextTickAt
        ? nextTickAt + Math.max(0, Math.ceil((eligible - nextTickAt) / HOUR)) * HOUR
        : eligible).toISOString()
    return {
        days, min_days: MIN_DAYS, max_days: MAX_DAYS,
        cutoff: days === null ? null : cutoffFor(days, now).toISOString(),
        configured: !!env.apiKey, dry_run: env.dryRun, max_per_run: env.maxPerRun,
        last_run: s.last ?? null, last_error: s.last_error ?? (s.last?.error ? { at: s.last.at, message: s.last.error } : null), deleted_total: s.deleted_total ?? 0,
        remaining: days === null ? null : s.remaining ?? null, running,
        next_run: next, hold: pending ? { until: new Date(pending.until).toISOString(), previous: pending.previous } : null,
    }
}

export function retentionJobState(now = new Date()): JobState {
    const s = retentionState()
    const status = retentionStatus(now)
    const failures = status.days === null ? 0 : s.failures ?? 0
    const lastOk = s.last_ok_at ?? (s.last && !s.last.error && s.last.ran ? s.last.at : null)
    const level = failures >= 3 ? 'down' : failures ? 'warn' : status.days === null || lastOk && !status.hold ? 'ok' : 'waiting'
    const detail = [
        status.days === null ? 'Off' : status.hold ? 'Decrease on hold' : status.running ? 'Running' : status.dry_run ? 'Dry run' : 'On',
        status.last_run ? `Last run ${status.last_run.at}` : 'No runs yet',
        `${status.deleted_total} deleted total`,
        status.remaining === null ? 'Remaining unknown' : `${status.remaining} remaining as of last count`,
        status.next_run ? `Next run at or after ${status.next_run}` : 'No run scheduled',
        status.last_error ? `Last error ${status.last_error.at} ${status.last_error.message}` : 'No errors',
    ].join(' · ')
    return { key: 'replay_retention', label: 'Replay retention', level, reason: null, detail,
        last_ok_at: lastOk, last_error_at: status.last_error?.at ?? null,
        since: status.last_run?.at ?? now.toISOString() }
}
