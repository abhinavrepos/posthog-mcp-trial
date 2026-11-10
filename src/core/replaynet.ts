// What the replay knows that the events do not: the server calls behind each attempt. PostHog's
// recorder (network timing on) puts the page's requests into the recording as rrweb plugin events
// ("rrweb/network@1"). This reads them on the server, with no AI and nothing sent anywhere, and ties
// them to the attempts (Save, Run...) from appevents.ts: "Run → 18 s on /report/run → HTTP 500".
//
// Only the method, the path (ids and query left out), the status and the timing are kept. Request and
// response bodies, even when recorded, are never read.
import { readFileSync } from 'node:fs'

import type { Step } from './appevents.ts'

export interface Request {
    path: string // origin, query and ids left out: /reval/api/trade/:id
    method: string
    status?: number // undefined: not known (0 or missing in the recording)
    start: number // epoch ms, the browser's clock
    ms: number // duration
}

const STATIC = new Set(['script', 'link', 'css', 'img', 'image', 'font', 'icon', 'beacon', 'video', 'audio', 'track'])

/** A URL as a path with ids and query left out, so calls group and nothing private is kept. */
export function pathTemplate(url: string): string {
    let p = url
    try {
        p = new URL(url, 'http://x').pathname
    } catch {}
    return (
        p
            .split('/')
            .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /\d{3,}/.test(seg) || /^\d+$/.test(seg) || (seg.length >= 5 && /\d/.test(seg) && /[a-z]/i.test(seg)) || seg.length > 40 ? ':id' : seg))
            .join('/')
            .slice(0, 120) || '/'
    )
}

/** The page's own calls (fetch, XHR, navigation) from a recording's JSONL ([windowId, event] lines). */
export function parseNetwork(jsonl: string): Request[] {
    const out: Request[] = []
    for (const line of jsonl.split('\n')) {
        if (!line.includes('rrweb/network@1')) continue
        let ev: any
        try {
            const parsed = JSON.parse(line)
            ev = Array.isArray(parsed) ? parsed[1] : parsed
        } catch {
            continue
        }
        if (ev?.type !== 6 || ev.data?.plugin !== 'rrweb/network@1') continue
        for (const r of ev.data?.payload?.requests || []) {
            if (!r || typeof r.name !== 'string') continue
            const kind = String(r.initiatorType || r.entryType || '').toLowerCase()
            if (STATIC.has(kind) || /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(r.name)) continue
            if (/\/(e|i\/v0\/e|s|batch|flags|decide|engage|capture)\/?(\?|$)/.test(r.name)) continue // PostHog's own calls
            const origin = Number(r.timeOrigin) || 0
            const startTime = Number(r.startTime)
            const start = Number.isFinite(Number(r.timestamp)) && Number(r.timestamp) > 1e12 ? Number(r.timestamp) : origin && Number.isFinite(startTime) ? origin + startTime : Number(ev.timestamp)
            const ms = Number.isFinite(Number(r.endTime)) && Number.isFinite(startTime) && Number(r.endTime) >= startTime ? Number(r.endTime) - startTime : Number(r.duration) || 0
            const status = Number(r.responseStatus ?? r.status)
            out.push({ path: pathTemplate(r.name), method: String(r.method || 'GET').toUpperCase(), status: status > 0 ? status : undefined, start, ms: Math.round(ms) })
        }
    }
    // The recorder can report a request twice (performance entry and fetch wrapper): keep one.
    const seen = new Set<string>()
    return out
        .sort((a, b) => a.start - b.start)
        .filter((r) => {
            const k = `${r.method} ${r.path} ${Math.round(r.start / 50)}`
            if (seen.has(k)) return false
            seen.add(k)
            return true
        })
}

export function networkFromFile(file: string): Request[] {
    return parseNetwork(readFileSync(file, 'utf8'))
}

export interface AttemptTiming {
    step: number // the submit's index in the steps
    wait_ms: number // from the press until the last call it started had answered
    calls: number
    slowest?: { call: string; ms: number; status?: number }
    http_errors: { call: string; status: number }[]
}

/**
 * The calls each attempt started: those beginning between just before the press and a few seconds
 * after it (before the next action). `clockShiftMs` moves event times onto the browser's clock.
 */
export function attemptTimings(steps: Step[], requests: Request[], clockShiftMs = 0, opts: { startWindowMs?: number } = {}): AttemptTiming[] {
    const window = opts.startWindowMs ?? 3000
    const out: AttemptTiming[] = []
    const acts = steps.filter((s) => s.kind !== 'message' && s.kind !== 'notice' && s.kind !== 'other')
    for (const s of steps) {
        if (s.kind !== 'submit') continue
        const t = Date.parse(s.ts) + clockShiftMs
        const next = acts.find((a) => a.i > s.i)
        const until = Math.min(t + window, next ? Date.parse(next.ts) + clockShiftMs : Infinity)
        const calls = requests.filter((r) => r.start >= t - 500 && r.start <= until)
        if (!calls.length) continue
        const slow = calls.reduce((a, b) => (b.ms > a.ms ? b : a))
        out.push({
            step: s.i,
            wait_ms: Math.max(0, Math.max(...calls.map((c) => c.start + c.ms)) - t),
            calls: calls.length,
            slowest: { call: `${slow.method} ${slow.path}`, ms: slow.ms, status: slow.status },
            http_errors: calls.filter((c) => (c.status ?? 0) >= 400).map((c) => ({ call: `${c.method} ${c.path}`, status: c.status! })),
        })
    }
    return out
}

/**
 * How far the browser's clock is from PostHog's event times, from events that carry both
 * (properties.$time is the browser's). The median, so a few late events do not move it.
 */
export function clockShift(pairs: { ts: string; ctime?: number }[]): number {
    const d = pairs.filter((p) => p.ctime && p.ctime > 1e12).map((p) => p.ctime! - Date.parse(p.ts)).sort((a, b) => a - b)
    return d.length ? d[Math.floor(d.length / 2)] : 0
}

export const seconds = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`)

/** "server 18 s (POST /api/report/run), HTTP 500 on POST /api/x" */
export function timingWords(t: AttemptTiming): string {
    const parts = [`waited ${seconds(t.wait_ms)}`]
    if (t.slowest && t.calls > 1) parts.push(`slowest ${t.slowest.call} ${seconds(t.slowest.ms)}`)
    else if (t.slowest) parts.push(t.slowest.call)
    for (const e of t.http_errors.slice(0, 2)) parts.push(`HTTP ${e.status} on ${e.call}`)
    return parts.join(', ')
}
