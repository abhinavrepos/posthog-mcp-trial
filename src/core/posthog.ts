// Thin PostHog API client: HogQL queries, recordings and their snapshots.
//
// Every HogQL query takes its values as {placeholders} bound through `values`. Ticket text is
// untrusted, so nothing from a ticket is ever concatenated into a query string.
import { config, requirePosthog } from './config.ts'

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
        headers: {
            authorization: `Bearer ${config.posthog.personalApiKey}`,
            'content-type': 'application/json',
            ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
    })
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

/** Runs a HogQL query and returns rows as objects keyed by column name. */
export async function hogql(query: string, values: Record<string, unknown> = {}): Promise<Row[]> {
    const out = await api<{ columns: string[]; results: unknown[][] }>(projectPath('/query/'), {
        method: 'POST',
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query, values }, refresh: 'force_blocking' }),
    })
    return out.results.map((r) => Object.fromEntries(out.columns.map((c, i) => [c, r[i]])))
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
