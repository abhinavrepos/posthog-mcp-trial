// Reads what people paste into the clip page: a PostHog replay link or a bare session id, and a
// start time like "1:23", "83" or "83s".

export interface ReplayInput {
    sessionId: string
    startS?: number // from ?t= in a replay link
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseReplayInput(raw: string): ReplayInput | undefined {
    const text = raw.trim()
    if (SESSION_ID.test(text)) return { sessionId: text.toLowerCase() }
    let url: URL
    try {
        url = new URL(text)
    } catch {
        return undefined
    }
    // /project/1/replay/<id>?t=12, or a playlist link with ?sessionRecordingId=<id>
    const fromPath = /\/replay\/([0-9a-f-]{36})(?:\/|$)/i.exec(url.pathname)?.[1]
    const fromQuery = url.searchParams.get('sessionRecordingId') || undefined
    const id = fromPath || fromQuery
    if (!id || !SESSION_ID.test(id)) return undefined
    const t = parseStartTime(url.searchParams.get('t') || '')
    return { sessionId: id.toLowerCase(), ...(t !== undefined ? { startS: t } : {}) }
}

/** "1:23" → 83, "1:02:03" → 3723, "83" / "83s" → 83. Undefined when it is not a time. */
export function parseStartTime(raw: string): number | undefined {
    const s = raw.trim().toLowerCase()
    if (!s) return undefined
    if (/^\d+(\.\d+)?s?$/.test(s)) return Math.floor(parseFloat(s))
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s)
    if (!m) return undefined
    const [h, mm, ss] = [Number(m[1] || 0), Number(m[2]), Number(m[3])]
    if (ss > 59 || (m[1] && mm > 59)) return undefined
    return h * 3600 + mm * 60 + ss
}

export function formatClock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds))
    const h = Math.floor(s / 3600)
    const mm = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

/** A download file name people can recognise: client, user, date and the clip's range. */
export function downloadName(c: { client?: string; user?: string; recordingStart?: string; startS: number; endS: number }): string {
    const part = (s?: string) => (s || '').toLowerCase().replace(/@.*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
    const day = (c.recordingStart || '').slice(0, 10)
    const range = `${formatClock(c.startS).replace(/:/g, 'm')}s-${formatClock(c.endS).replace(/:/g, 'm')}s`
    return ['replay', part(c.client), part(c.user), day, range].filter(Boolean).join('_') + '.mp4'
}

/** Sliding one-hour window per person. */
export class HourlyLimit {
    private hits = new Map<string, number[]>()
    constructor(private max: number) {}
    take(who: string, now = Date.now()): boolean {
        const recent = (this.hits.get(who) || []).filter((t) => now - t < 3_600_000)
        if (recent.length >= this.max) {
            this.hits.set(who, recent)
            return false
        }
        recent.push(now)
        this.hits.set(who, recent)
        return true
    }
}
