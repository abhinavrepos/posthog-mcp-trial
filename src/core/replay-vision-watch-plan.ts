/**
 * "Watch fully" frame plan (orchestrator decision, night run): which moments of a whole session to render as frames,
 * idle-trimmed, and the sanitized whole-session timeline the frames are paired with. Pure and bounded; runs in the
 * analysis worker next to readTimeline(), so no event stream or node map reaches the HTTP process.
 */
import { sanitizedWindow, type SanitizedEvent, type Timeline, type TimelineItem } from './replay-timeline.ts'

export const WATCH_LIMITS = Object.freeze({
    maxFrames: 16,            // images per request
    maxFrameBytes: 600 * 1024, // one PNG
    maxTotalBytes: 6 * 1024 * 1024, // all PNGs of one request (base64 adds a third)
    frameWidth: 960,          // rendered frames are scaled to this width before sending
    idleGapMs: 8_000,         // a pause longer than this is idle and trimmed
    minSpacingMs: 1_500,      // two frames are at least this far apart
    fillEveryMs: 8_000,       // within an active span without anchors, one frame this often
    settleMs: 400,            // a frame is taken this long after its anchor event (the UI's response)
    maxRenderS: 180,          // total seconds rendered per session
    maxClipS: 40,             // one render range
    maxEvents: 400,           // sanitized timeline events sent with the frames
    nearbyBeforeMs: 2_000, nearbyAfterMs: 500,
    renderDeadlineMs: 180_000, // review M7: rendering all frames of one session, end to end
    frameTimeoutMs: 20_000,    // one ffmpeg frame extraction
})
export type WatchLimits = typeof WATCH_LIMITS

export interface PlannedFrame { t_ms: number; reason: 'error' | 'navigation' | 'overlay' | 'click' | 'fill'; event_ids: string[] }
export interface RenderRange { start_s: number; duration_s: number }
export interface WatchPlan {
    duration_ms: number; active_ms: number; spans: { start_ms: number; end_ms: number }[]
    frames: PlannedFrame[]; ranges: RenderRange[]; events: SanitizedEvent[]; screens: string[]; dropped_frames: number
}

const ACTIVITY = new Set<TimelineItem['kind']>(['click', 'focus', 'input_activity', 'scroll', 'navigation', 'error', 'pointer'])
const PRIORITY: Record<PlannedFrame['reason'], number> = { error: 0, navigation: 1, overlay: 2, click: 3, fill: 4 }

/** Spans of user activity; gaps longer than idleGapMs are idle and excluded. */
export function activeSpans(t: Timeline, idleGapMs = WATCH_LIMITS.idleGapMs): { start_ms: number; end_ms: number }[] {
    const times = t.items.filter((e) => ACTIVITY.has(e.kind)).map((e) => e.offset_ms).sort((a, b) => a - b)
    const spans: { start_ms: number; end_ms: number }[] = []
    for (const at of times) {
        const last = spans.at(-1)
        if (last && at - last.end_ms <= idleGapMs) last.end_ms = at
        else spans.push({ start_ms: at, end_ms: at })
    }
    return spans.map((s) => ({ start_ms: Math.max(0, s.start_ms - 500), end_ms: s.end_ms + 1_500 }))
}

export function planWatch(t: Timeline, limits: WatchLimits = WATCH_LIMITS): WatchPlan {
    const duration = t.items.reduce((m, e) => Math.max(m, e.offset_ms), 0)
    const spans = activeSpans(t, limits.idleGapMs)
    // The sanitized whole-session timeline (same privacy rules as B′ windows), centred on the session.
    const half = Math.ceil(duration / 2) + 1
    const events = sanitizedWindow(t, half, half, half, limits.maxEvents).events
    const sent = new Set(events.map((e) => e.id))
    // Anchors: what the user did and what the app showed; frames land just after them.
    const anchors: PlannedFrame[] = []
    for (const e of t.items) {
        const reason: PlannedFrame['reason'] | undefined = e.kind === 'error' && e.error_kind === 'visible' ? 'error' : e.kind === 'navigation' ? 'navigation'
            : e.kind === 'coverage' && e.label === 'wait_start' ? 'overlay' : e.kind === 'click' && (e.interaction === 2 || e.interaction === undefined) ? 'click' : undefined
        if (reason) anchors.push({ t_ms: e.offset_ms + limits.settleMs, reason, event_ids: [] })
    }
    for (const s of spans) for (let at = s.start_ms + limits.fillEveryMs / 2; at < s.end_ms; at += limits.fillEveryMs) anchors.push({ t_ms: at, reason: 'fill', event_ids: [] })
    const inSpan = (at: number) => spans.some((s) => at >= s.start_ms && at <= s.end_ms)
    // Highest priority first, keeping minimum spacing; then the frame budget.
    const chosen: PlannedFrame[] = []
    for (const f of anchors.filter((a) => inSpan(a.t_ms) && a.t_ms <= duration + limits.settleMs).sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason] || a.t_ms - b.t_ms)) {
        if (chosen.some((c) => Math.abs(c.t_ms - f.t_ms) < limits.minSpacingMs)) continue
        chosen.push(f)
    }
    let frames = chosen.slice(0, limits.maxFrames).sort((a, b) => a.t_ms - b.t_ms)
    let dropped = chosen.length - frames.length
    // Render ranges: consecutive frames within one clip, bounded total seconds (frames past the budget are dropped).
    const ranges: RenderRange[] = []
    const kept: PlannedFrame[] = []
    let rendered = 0
    for (const f of frames) {
        const last = ranges.at(-1)
        const at = f.t_ms / 1000
        if (last && at <= last.start_s + limits.maxClipS - 0.5 && at - last.start_s >= 0) {
            const grown = Math.max(last.duration_s, Math.ceil(at - last.start_s + 1))
            if (rendered - last.duration_s + grown > limits.maxRenderS) { dropped++; continue }
            rendered += grown - last.duration_s; last.duration_s = grown
        } else {
            const start = Math.max(0, Math.floor(at - 1))
            if (rendered + 2 > limits.maxRenderS) { dropped++; continue }
            ranges.push({ start_s: start, duration_s: 2 }); rendered += 2
        }
        kept.push(f)
    }
    frames = kept.map((f) => ({ ...f, event_ids: events.filter((e) => e.t_ms >= f.t_ms - limits.nearbyBeforeMs - limits.settleMs && e.t_ms <= f.t_ms + limits.nearbyAfterMs && sent.has(e.id)).slice(-8).map((e) => e.id) }))
    return { duration_ms: duration, active_ms: spans.reduce((a, s) => a + s.end_ms - s.start_ms, 0), spans, frames, ranges, events, screens: t.screens.slice(0, 50), dropped_frames: dropped }
}
