// Thin PostHog API client: HogQL queries, recordings and their snapshots.
//
// Every HogQL query takes its values as {placeholders} bound through `values`. Ticket text is
// untrusted, so nothing from a ticket is ever concatenated into a query string.
import { config, requirePosthog } from './config.ts'
import { Agent } from 'undici'

// A small reused pool (keep-alive): ClickHouse on a small box cannot run many heavy reads together, but
// two was too few once recording downloads, the history build and chat share it. POSTHOG_CONNECTIONS: 1-16.
const POOL = Math.min(16, Math.max(1, Math.floor(Number(process.env.POSTHOG_CONNECTIONS) || 4)))
const dispatcher = new Agent({ connections: POOL, pipelining: 1, keepAliveTimeout: 30_000 })

export class PostHogError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message)
    }
}

async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    requirePosthog()
    const res = await fetch(`${config.posthog.host}${path}`, {
        ...init,
        dispatcher,
        headers: {
            authorization: `Bearer ${config.posthog.personalApiKey}`,
            'content-type': 'application/json',
            ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit)
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        let detail = body.slice(0, 300)
        try {
            detail = JSON.parse(body).detail ?? detail
        } catch {}
        throw new PostHogError(`PostHog ${init.method || 'GET'} ${path.split('?')[0]} → ${res.status}: ${detail}`, res.status)
    }
    return (await res.json()) as T
}

const projectPath = (p: string) => `/api/projects/${config.posthog.projectId}${p}`

export type Row = Record<string, unknown>

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
    if (activeReads >= 2) {
        if (readers.length >= 64) throw new PostHogError('PostHog read queue is busy', 503)
        await new Promise<void>((resolve) => readers.push(resolve))
    } else activeReads++
    try { return await work() }
    finally { const next = readers.shift(); if (next) next(); else activeReads-- }
}
export async function hogql(query: string, values: Record<string, unknown> = {}, options: HogqlOptions = {}): Promise<Row[]> {
    const read = async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await readSlot(async () => {
                    const out = await api<{ columns: string[]; results: unknown[][] }>(projectPath('/query/'), {
                        method: 'POST',
                        body: JSON.stringify({ query: { kind: 'HogQLQuery', query, values }, refresh: 'force_blocking' }),
                    }, options.timeoutMs ?? 30_000)
                    return out.results.map((r) => Object.fromEntries(out.columns.map((c, i) => [c, r[i]])))
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
export async function getSnapshotsJsonl(sessionId: string): Promise<string> {
    const base = projectPath(`/session_recordings/${encodeURIComponent(sessionId)}/snapshots`)
    const { sources } = await api<{ sources: SnapshotSource[] }>(`${base}?blob_v2=true`)
    const blobs = sources.filter((s) => s.source === 'blob_v2')
    if (!blobs.length) throw new PostHogError(`Recording ${sessionId} has no stored snapshots yet`)
    const keys = blobs.map((s) => Number(s.blob_key)).filter((n) => Number.isFinite(n))
    const first = Math.min(...keys)
    const last = Math.max(...keys)
    // A personal API key may span at most 20 blob keys per request (end - start <= 20).
    const CHUNK = 20
    let text = ''
    for (let start = first; start <= last; start += CHUNK + 1) {
        const end = Math.min(last, start + CHUNK)
        const res = await fetch(`${config.posthog.host}${base}?source=blob_v2&start_blob_key=${start}&end_blob_key=${end}`, {
            headers: { authorization: `Bearer ${config.posthog.personalApiKey}` },
            signal: AbortSignal.timeout(60_000),
        })
        if (!res.ok) throw new PostHogError(`Snapshot download for ${sessionId} → ${res.status}`, res.status)
        text += (await res.text()) + '\n'
    }
    return normalizeSnapshotLines(text)
}

/** Accepts either `[windowId, event]` lines or `{window_id, data}` lines and emits the former. */
export function normalizeSnapshotLines(text: string): string {
    const out: string[] = []
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line)
        if (Array.isArray(parsed)) {
            out.push(JSON.stringify(parsed))
        } else if (parsed && typeof parsed === 'object') {
            const windowId = parsed.window_id ?? parsed.windowId ?? ''
            const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data ?? parsed]
            for (const ev of events) out.push(JSON.stringify([windowId, ev]))
        }
    }
    return out.join('\n') + '\n'
}

export function replayUrl(sessionId: string, offsetSeconds = 0): string {
    const t = Math.max(0, Math.floor(offsetSeconds))
    return `${config.posthog.publicHost}/project/${config.posthog.projectId}/replay/${encodeURIComponent(sessionId)}${t ? `?t=${t}` : ''}`
}

export function issueUrl(issueId: string): string {
    return `${config.posthog.publicHost}/project/${config.posthog.projectId}/error_tracking/${encodeURIComponent(issueId)}`
}
