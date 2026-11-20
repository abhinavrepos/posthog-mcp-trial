// Thin PostHog API client: HogQL queries, recordings and their snapshots.
//
// Every HogQL query takes its values as {placeholders} bound through `values`. Ticket text is
// untrusted, so nothing from a ticket is ever concatenated into a query string.
import { open } from 'node:fs/promises'
import { setImmediate as yieldTurn } from 'node:timers/promises'

import { config, requirePosthog } from './config.ts'

// How many HogQL queries Lens runs at once (POSTHOG_CONNECTIONS, 1-16, default 4): ClickHouse on a small box
// cannot run many heavy reads together, but MCP tools and pages share these. Connections
// are reused by Node's own fetch (keep-alive). Do not pass an Agent from the npm undici package to the
// built-in fetch: their versions differ and every request then fails ("fetch failed").
const MAX_READS = Math.min(16, Math.max(1, Math.floor(Number(process.env.POSTHOG_CONNECTIONS) || 4)))

export class PostHogError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message)
    }
}

// When PostHog stops answering, every call waited its full timeout (and retried), holding the few read slots
// for minutes and stalling every PM (outage drill 2026-11-17: one question took 6 minutes to fail). After
// three timeouts in a row with no answer in between, fail fast for 30 s, then let calls probe again.
// Any answer, even an error status, resets the count, so one heavy query timing out does not trip it.
const BREAKER_TIMEOUTS = 3, BREAKER_OPEN_MS = 30_000
let consecutiveTimeouts = 0, breakerOpenUntil = 0
export function resetPosthogBreaker(): void { consecutiveTimeouts = 0; breakerOpenUntil = 0 }
async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    requirePosthog()
    if (Date.now() < breakerOpenUntil) throw new PostHogError('PostHog is not answering: Lens paused calls to it for 30 s', 503)
    let res: Response, responseText: string
    const signal = AbortSignal.timeout(timeoutMs)
    try {
        res = await fetch(`${config.posthog.host}${path}`, {
            ...init,
            headers: {
                authorization: `Bearer ${config.posthog.personalApiKey}`,
                'content-type': 'application/json',
                ...init.headers,
            },
            signal,
        } as RequestInit)
        // Consume the body under the same deadline, before counting this as an answer.
        responseText = await res.text()
    } catch (error) {
        if (((error as { name?: string })?.name === 'TimeoutError' || (signal.aborted && signal.reason?.name === 'TimeoutError')) && ++consecutiveTimeouts >= BREAKER_TIMEOUTS) breakerOpenUntil = Date.now() + BREAKER_OPEN_MS
        throw error
    }
    resetPosthogBreaker()
    if (!res.ok) {
        const body = responseText
        let detail = body.slice(0, 300)
        try {
            detail = JSON.parse(body).detail ?? detail
        } catch {}
        throw new PostHogError(`PostHog ${init.method || 'GET'} ${path.split('?')[0]} → ${res.status}: ${detail}`, res.status)
    }
    const text = responseText
    try { return JSON.parse(text) as T }
    catch { throw new PostHogError(`PostHog ${init.method || 'GET'} ${path.split('?')[0]} → ${res.status}: unreadable answer (not JSON)`, 502) }
}

const projectPath = (p: string) => `/api/projects/${config.posthog.projectId}${p}`

export type Row = Record<string, unknown>

export const POSTHOG_ROW_CAP = 50_000
export interface Completeness { truncated?: boolean; warning?: string }
export const PARTIAL_WARNING = 'Results are partial because a row limit was reached. Pick a shorter range or narrower filters.'
/** Array metadata preserves existing callers; JSON endpoints must copy it onto their response. */
export function isTruncated(rows: unknown[] & Completeness): boolean {
    return rows.truncated === true || rows.length >= POSTHOG_ROW_CAP
}
export function markPartial<T extends object>(value: T, partial: boolean): T & Completeness {
    return partial ? Object.assign(value, { truncated: true, warning: PARTIAL_WARNING }) : value
}

/** Runs a HogQL query and returns rows as objects keyed by column name. Give every query that can
 * return more than 100 rows its own LIMIT: without one, PostHog returns only the first 100. */
export interface HogqlOptions {
    /** Opt in to identical-read single-flight and a bounded cache; fresh remains the default. */
    cache?: boolean
    ttlMs?: number
    timeoutMs?: number
    /** Tasks may set zero when already wrapped by patiently(). */
    retries?: number
}

// Shared by report caches and opt-in HogQL reads. Never cache credentials in a key exposed to users.
const answers = new Map<string, { value: unknown; at: number; bytes: number; retryAt?: number }>()
const flights = new Map<string, Promise<{ value: unknown; cachedAt: number; stale: boolean }>>()
let cacheBytes = 0, cacheGeneration = 0
const MAX_BYTES = 8 * 1024 * 1024, MAX_ENTRIES = 64
export function clearPosthogCache(): void { answers.clear(); flights.clear(); cacheBytes = 0; cacheGeneration++ }
export function readCacheKey(kind: string, args: unknown): string {
    return JSON.stringify([config.posthog.host, config.posthog.projectId, config.posthog.personalApiKey, kind, canonical(args)])
}
function canonical(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
    return value
}

/** Stale fallback is explicit, so a report can label it. Rejections are never cached. */
export async function cachedPosthogRead<T>(key: string, work: () => Promise<T>, options: { ttlMs?: number; staleMs?: number; staleWhileRevalidate?: boolean; degraded?: (value: T) => boolean } = {}): Promise<{ value: T; cachedAt: number; stale: boolean }> {
    const ttl = options.ttlMs ?? 30_000, now = Date.now(), entry = answers.get(key)
    if (entry && now - entry.at < ttl) {
        answers.delete(key); answers.set(key, entry)
        return { value: structuredClone(entry.value) as T, cachedAt: entry.at, stale: false }
    }
    const pending = flights.get(key)
    const serveStale = entry && options.staleWhileRevalidate && options.staleMs && now - entry.at < options.staleMs
    if (serveStale && entry.retryAt && now < entry.retryAt)
        return { value: structuredClone(entry.value) as T, cachedAt: entry.at, stale: true }
    if (pending) {
        if (serveStale) return { value: structuredClone(entry.value) as T, cachedAt: entry.at, stale: true }
        return structuredClone(await pending) as { value: T; cachedAt: number; stale: boolean }
    }
    const generation = cacheGeneration
    const run = (async () => {
        try {
            const value = await work(), at = Date.now()
            const degraded = options.degraded?.(value)
            if (degraded && entry && options.staleMs && at - entry.at < options.staleMs) {
                entry.retryAt = at + 5_000
                return { value: structuredClone(entry.value) as T, cachedAt: entry.at, stale: true }
            }
            const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value, (_key, v) => v instanceof Map ? [...v] : v) ?? '')
            if (generation === cacheGeneration && !degraded && bytes <= MAX_BYTES / 4 && ttl > 0) {
                if (answers.has(key)) { cacheBytes -= answers.get(key)!.bytes; answers.delete(key) }
                answers.set(key, { value: structuredClone(value), at, bytes }); cacheBytes += bytes
                while (answers.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) {
                    const oldest = answers.keys().next().value!
                    cacheBytes -= answers.get(oldest)!.bytes; answers.delete(oldest)
                }
            }
            return { value, cachedAt: at, stale: false }
        } catch (error) {
            if (entry && options.staleMs && Date.now() - entry.at < options.staleMs && retryable(error)) {
                entry.retryAt = Date.now() + 5_000
                return { value: structuredClone(entry.value) as T, cachedAt: entry.at, stale: true }
            }
            throw error
        }
    })()
    // Bound single-flight bookkeeping as well as stored answers.
    if (flights.size < MAX_ENTRIES) flights.set(key, run)
    if (serveStale) {
        void run.catch(() => undefined).finally(() => { if (flights.get(key) === run) flights.delete(key) })
        return { value: structuredClone(entry.value) as T, cachedAt: entry.at, stale: true }
    }
    try { return structuredClone(await run) }
    finally { if (flights.get(key) === run) flights.delete(key) }
}
function retryable(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const e = error as { status?: number; name?: string }
    return e.name === 'TimeoutError' || e.status === 429 || (e.status !== undefined && e.status >= 500 && e.status < 600)
}
let activeReads = 0
const readers: (() => void)[] = []
async function readSlot<T>(work: () => Promise<T>): Promise<T> {
    if (activeReads >= MAX_READS) {
        if (readers.length >= 64) throw new PostHogError('PostHog read queue is busy', 503)
        await new Promise<void>((resolve) => readers.push(resolve))
    } else activeReads++
    try { return await work() }
    finally { const next = readers.shift(); if (next) next(); else activeReads-- }
}
export async function hogql(query: string, values: Record<string, unknown> = {}, options: HogqlOptions = {}): Promise<Row[] & Completeness> {
    const read = async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await readSlot(async () => {
                    const out = await api<{ columns: string[]; results: unknown[][]; hasMore?: boolean; has_more?: boolean; limit?: number; row_limit?: number }>(projectPath('/query/'), {
                        method: 'POST',
                        body: JSON.stringify({ query: { kind: 'HogQLQuery', query, values }, refresh: 'force_blocking' }),
                    }, options.timeoutMs ?? 30_000)
                    const rows = out.results.map((r) => Object.fromEntries(out.columns.map((c, i) => [c, r[i]])))
                    const limit = out.limit ?? out.row_limit
                    return markPartial(rows, rows.length >= POSTHOG_ROW_CAP || out.hasMore === true || out.has_more === true || (typeof limit === 'number' && limit > 0 && rows.length >= limit))
                })
            } catch (error) {
                if (attempt >= (options.retries ?? 1) || !retryable(error)) throw error
                await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 100))
            }
        }
    }
    if (!options.cache) return read()
    return (await cachedPosthogRead(readCacheKey('hogql', { query, values, timeoutMs: options.timeoutMs, retries: options.retries }), read, { ttlMs: options.ttlMs })).value
}

/** Aggregate query nodes use the same read key, queue, timeout and circuit breaker as HogQL. */
export async function posthogQuery(query: Record<string, unknown>): Promise<unknown> {
    return readSlot(() => api(projectPath('/query/'), {
        method: 'POST', body: JSON.stringify({ query, refresh: 'blocking' }),
    }))
}

/** The event property names PostHog has seen (needs the property_definition:read scope). */
export async function propertyDefinitions(): Promise<string[]> {
    const out = await api<{ results: { name: string }[] }>(projectPath('/property_definitions/?type=event&limit=1000'))
    return out.results.map((r) => r.name)
}

export interface RecordingMeta {
    id: string
    start_time: string
    end_time: string
    recording_duration: number
    distinct_id: string
}

export async function getRecording(sessionId: string): Promise<RecordingMeta> {
    return api<RecordingMeta>(projectPath(`/session_recordings/${encodeURIComponent(sessionId)}/`))
}

interface SnapshotSource {
    source: string
    blob_key?: string
    start_blob_key?: string
    end_blob_key?: string
    start_timestamp?: string
}

/**
 * Downloads a recording's snapshots as JSONL lines of `[windowId, event]`, the format the
 * rasterizer reads.
 */
const snapshotLimit = () => Math.max(1, Number(process.env.REPLAY_MAX_MB) || 200) * 1024 * 1024
const snapshotChunks = () => Math.max(1, Math.floor(Number(process.env.REPLAY_MAX_CHUNKS) || 1000))
const tooLarge = () => new PostHogError('Recording too large by snapshot policy', 413)

export async function getSnapshotsJsonl(sessionId: string, file?: string): Promise<string> {
    const base = projectPath(`/session_recordings/${encodeURIComponent(sessionId)}/snapshots`)
    const { sources } = await api<{ sources: SnapshotSource[] }>(`${base}?blob_v2=true`)
    const blobs = sources.filter((s) => s.source === 'blob_v2')
    if (!blobs.length) throw new PostHogError(`Recording ${sessionId} has no stored snapshots yet`)
    const keys = blobs.map((s) => Number(s.blob_key)).filter((n) => Number.isSafeInteger(n) && n >= 0)
    if (!keys.length) throw new PostHogError('Recording has invalid blob keys')
    const first = keys.reduce((a, b) => Math.min(a, b)), last = keys.reduce((a, b) => Math.max(a, b))
    // Bound both sparse blob ranges and decompressed response bodies, not just Content-Length.
    if (Math.ceil((last - first + 1) / 21) > snapshotChunks()) throw tooLarge()
    const output = file ? await open(file, 'w', 0o600) : undefined
    const parts: string[] = []
    let bytes = 0, normalizedBytes = 0
    const emit = async (line: string) => {
        if (!line.trim()) return
        for (const normalized of snapshotLines(line)) {
            normalizedBytes += Buffer.byteLength(normalized) + 1
            if (normalizedBytes > snapshotLimit()) throw tooLarge()
            if (output) await output.write(normalized + '\n')
            else parts.push(normalized + '\n')
            await yieldTurn()
        }
    }
    try {
        for (let start = first; start <= last; start += 21) {
            const end = Math.min(last, start + 20)
            const res = await fetch(`${config.posthog.host}${base}?source=blob_v2&start_blob_key=${start}&end_blob_key=${end}`, {
                headers: { authorization: `Bearer ${config.posthog.personalApiKey}` },
                signal: AbortSignal.timeout(60_000),
            })
            if (!res.ok) { await res.body?.cancel(); throw new PostHogError(`Snapshot download for ${sessionId} → ${res.status}`, res.status) }
            const reader = res.body?.getReader()
            if (!reader) continue
            const decoder = new TextDecoder()
            let pending = ''
            try {
                for (;;) {
                    const { value, done } = await reader.read()
                    if (value) bytes += value.byteLength
                    if (bytes > snapshotLimit()) throw tooLarge()
                    pending += decoder.decode(value, { stream: !done })
                    let offset = 0, end: number
                    while ((end = pending.indexOf('\n', offset)) >= 0) {
                        if (end - offset > 4 * 1024 * 1024) throw tooLarge()
                        await emit(pending.slice(offset, end))
                        offset = end + 1
                    }
                    pending = pending.slice(offset)
                    // A single JSON value must also be bounded before synchronous parsing.
                    if (pending.length > 4 * 1024 * 1024) throw tooLarge()
                    if (done) { await emit(pending); break }
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        }
        return file ? '' : parts.join('') || '\n'
    } finally { await output?.close() }
}

/** Accepts either `[windowId, event]` lines or `{window_id, data}` lines and emits the former. */
function* snapshotLines(text: string): Generator<string> {
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line)
        if (Array.isArray(parsed)) {
            yield JSON.stringify(parsed)
        } else if (parsed && typeof parsed === 'object') {
            const windowId = parsed.window_id ?? parsed.windowId ?? ''
            const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data ?? parsed]
            for (const ev of events) yield JSON.stringify([windowId, ev])
        }
    }
}

export function normalizeSnapshotLines(text: string): string {
    const out: string[] = []
    let bytes = 0
    for (const line of snapshotLines(text)) {
        bytes += Buffer.byteLength(line) + 1
        if (bytes > snapshotLimit()) throw tooLarge()
        out.push(line)
    }
    return out.join('\n') + '\n'
}

export function replayUrl(sessionId: string, offsetSeconds = 0): string {
    let decoded = sessionId
    for (let i = 0; i < 3; i++) decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    if (decoded.includes('@') || decoded.includes(config.properties.distinctIdSeparator)) return `${config.service.publicUrl}/replays`
    const t = Math.max(0, Math.floor(offsetSeconds))
    return `${config.posthog.publicHost}/project/${config.posthog.projectId}/replay/${encodeURIComponent(sessionId)}${t ? `?t=${t}` : ''}`
}

export function issueUrl(issueId: string): string {
    return `${config.posthog.publicHost}/project/${config.posthog.projectId}/error_tracking/${encodeURIComponent(issueId)}`
}
