/**
 * Replay Vision deterministic detectors (research §7 catalogue D1–D15, §12a R1/R2, §12b S1–S3).
 *
 * Pure functions over a normalized Timeline. Every candidate carries facts (numbers), the cited
 * event ids, screen / element / workflow step and the coverage limitations; never an emotion.
 * Thresholds live in DETECTOR_CONFIG, which is versioned and hashed by the evaluation before
 * held-out scoring. Population context (per-screen dwell medians, per-container page extents)
 * is optional and comes from the 30-day baseline; without it the absolute floors apply.
 */
import type { Timeline, TimelineItem } from './replay-timeline.ts'

export const DETECTOR_CONFIG = Object.freeze({
    version: 'rv-d1-15-r1-r2-s1-s3-v6',
    rageClicks: 3, rageGapMs: 1000, rageManhattanPx: 30,
    deadResponseMs: 2500, deadScrollMs: 100,
    errorClickMs: 1000,
    validationCycles: 2, validationErrorMs: 3000, validationWindowMs: 180_000,
    abandonQuietMs: 1000,
    hesitationMs: 3000,
    fieldReturns: 3,
    dwellMs: 2500,
    thrashWindowMs: 1500, thrashReversals: 4, thrashAmplitudePx: 30, thrashPathPx: 600, thrashNetRatio: 0.3,
    waitMs: 3000, strongWaitMs: 10_000, waitClickMs: 1000,
    revisitMergeMs: 2000, taskIdleMs: 600_000, loopsStrong: 3, reopens: 3,
    helpWindowMs: 30_000,
    scrollDistanceOverH: 3, scrollHysteresisH: 0.25, scrollHysteresisPx: 200, scrollReversals: 3, scrollWindowMs: 15_000, scrollHuntOverP: 2,
    repeatMinMs: 1000, repeatMaxMs: 10_000, undoMs: 10_000,
    idleMs: 60_000,
    maxCandidates: 5000,
})
export type DetectorConfig = typeof DETECTOR_CONFIG
export type DetectorCode = 'D1'|'D2'|'D3'|'D4'|'D5'|'D6'|'D7'|'D8'|'D9'|'D10'|'R1'|'R2'|'D12'|'S1'|'S2'|'S3'|'D14'|'D15'|'V1'
export interface Candidate {
    kind: DetectorCode; start_ms: number; end_ms: number; score: number
    screen: string; element: string; step: string; event_ids: string[]
    facts: Record<string, number|string|boolean>; limitations: string[]; strength: 'strong'|'medium'|'weak'
}
/** Population context from the baseline (optional). */
export interface DetectorContext {
    /** Median dwell per screen across the population (ms), for R1. */
    screenDwellMedianMs?: Record<string, number>
    /** Persisted per-screen/container page extent lower bound P (px), keyed `screen|container`, for S1/S3. */
    pageExtentPx?: Record<string, number>
}
export const STRENGTH: Record<DetectorCode, Candidate['strength']> = {
    D1: 'strong', D3: 'strong', D4: 'strong', D5: 'strong',
    D2: 'medium', D6: 'medium', D7: 'medium', D10: 'medium', R1: 'medium', R2: 'medium', D12: 'medium', S1: 'medium', S3: 'medium', D14: 'medium',
    D8: 'weak', D9: 'weak', S2: 'weak', D15: 'weak',
    // V1: a Watch-fully finding (frames + timeline, Haiku 5.5), accepted only with valid timeline citations.
    V1: 'medium',
}
export const SUBMIT_LABELS = new Set(['Save', 'Submit', 'Save & Submit'])
const HELP_LABELS = new Set(['Help', 'Search'])
const UNDO_LABELS = new Set(['Cancel', 'Undo'])

export interface Visit { screen: string; start: number; end: number; id: string; index: number }
const byTime = (a: TimelineItem, b: TimelineItem) => a.offset_ms - b.offset_ms || a.event_id.localeCompare(b.event_id, 'en', { numeric: true })
const manhattan = (a: TimelineItem, b: TimelineItem) => Math.abs((a.x ?? 0) - (b.x ?? 0)) + Math.abs((a.y ?? 0) - (b.y ?? 0))
const isInput = (e: TimelineItem) => e.kind === 'click' || e.kind === 'input_activity' || e.kind === 'focus' || e.kind === 'scroll'
/** A click that enters a form field (text input, select, its label) rather than issuing a command. */
const isFieldEntry = (e: TimelineItem) => ['input', 'textarea', 'select', 'label'].includes(e.tag ?? '') || ['combobox', 'textbox', 'searchbox', 'spinbutton'].includes(e.role ?? '')
const isPrimaryClick = (e: TimelineItem) => e.kind === 'click' && (e.interaction === 2 || e.interaction === undefined)
export const doctypeOf = (screen: string) => screen.split(':')[0] ?? screen

/** First index i in sorted offsets with offsets[i] >= t. */
function lowerBound(offsets: number[], t: number): number {
    let lo = 0, hi = offsets.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid]! < t) lo = mid + 1; else hi = mid }
    return lo
}
/** Time index over one kind of event for O(log n) window queries. */
class Series {
    readonly items: TimelineItem[]; readonly t: number[]
    constructor(items: TimelineItem[]) { this.items = items; this.t = items.map((e) => e.offset_ms) }
    /** Events with from < t <= to (from inclusive when asked). */
    between(from: number, to: number, inclusive = false): TimelineItem[] {
        const out: TimelineItem[] = []
        for (let i = lowerBound(this.t, from); i < this.items.length && this.t[i]! <= to; i++) if (inclusive || this.t[i]! > from) out.push(this.items[i]!)
        return out
    }
    /** First event with from < t <= to matching pred. */
    any(from: number, to: number, pred: (e: TimelineItem) => boolean = () => true): TimelineItem | undefined {
        for (let i = lowerBound(this.t, from); i < this.items.length && this.t[i]! <= to; i++) if (this.t[i]! > from && pred(this.items[i]!)) return this.items[i]
        return undefined
    }
}

/** Screen visits: repeated same-screen navigation within revisitMergeMs, with no other screen between, is one visit (SPA re-render, or rrweb + app event for one navigation). */
export function screenVisits(events: TimelineItem[], cfg: DetectorConfig = DETECTOR_CONFIG): Visit[] {
    const visits: Visit[] = []
    let lastNavAt = -Infinity
    for (const e of events) {
        if (e.kind !== 'navigation' || !e.screen) continue
        const prev = visits.at(-1)
        if (prev && prev.screen === e.screen && e.offset_ms - lastNavAt <= cfg.revisitMergeMs) { lastNavAt = e.offset_ms; continue }
        lastNavAt = e.offset_ms
        visits.push({ screen: e.screen, start: e.offset_ms, end: e.offset_ms, id: e.event_id, index: visits.length })
    }
    const sessionEnd = events.at(-1)?.offset_ms ?? 0
    for (let i = 0; i < visits.length; i++) visits[i]!.end = visits[i + 1]?.start ?? Math.max(visits[i]!.start, sessionEnd)
    return visits
}

/**
 * Task windows (§12a, taskWindow): a task starts at entry to a screen and ends at its success signal
 * (new form → saved record), after taskIdleMs without input, or at session end.
 */
export function taskSegments(visits: Visit[], inputs: { between(from: number, to: number, inclusive?: boolean): TimelineItem[] }, cfg: DetectorConfig = DETECTOR_CONFIG): Visit[][] {
    const tasks: Visit[][] = []
    let current: Visit[] = []
    for (const v of visits) {
        const prev = current.at(-1)
        if (prev) {
            let lastInput = prev.start
            for (const e of inputs.between(prev.start, v.start, true)) lastInput = e.offset_ms
            if (v.start - lastInput > cfg.taskIdleMs) { tasks.push(current); current = [] }
            else if (prev.screen.endsWith(':new') && v.screen === doctypeOf(prev.screen) + ':form') { current.push(v); tasks.push(current); current = []; continue }
        }
        current.push(v)
    }
    if (current.length) tasks.push(current)
    return tasks
}

export function detectCandidates(timeline: Timeline, cfg: DetectorConfig = DETECTOR_CONFIG, ctx: DetectorContext = {}): Candidate[] {
    const out: Candidate[] = []
    const events = timeline.items.slice().sort(byTime)
    const limitations = timeline.coverage.state === 'complete' ? [] : [timeline.coverage.state, ...timeline.coverage.reasons.slice(0, 4)]
    const visits = screenVisits(events, cfg)
    // Attribute each event to the visit it happened in (navigation events keep their own screen).
    let vi = -1
    const screenAt = new Map<TimelineItem, string>()
    for (const e of events) {
        while (vi + 1 < visits.length && visits[vi + 1]!.start <= e.offset_ms) vi++
        screenAt.set(e, e.kind === 'navigation' && e.screen ? e.screen : visits[vi]?.screen ?? timeline.screens[0] ?? 'unknown_screen')
    }
    const scr = (e: TimelineItem) => screenAt.get(e) ?? 'unknown_screen'
    const add = (kind: DetectorCode, group: TimelineItem[], facts: Candidate['facts'], element?: string, step?: string, screen?: string) => {
        if (!group.length || out.length >= cfg.maxCandidates) return
        const first = group.reduce((a, b) => (b.offset_ms < a.offset_ms ? b : a), group[0]!)
        const last = group.reduce((a, b) => (b.offset_ms > a.offset_ms ? b : a), group[0]!)
        out.push({
            kind, start_ms: first.offset_ms, end_ms: last.offset_ms, score: group.length,
            screen: screen ?? scr(first), element: element || first.label || 'unknown_element',
            step: step || (kind === 'R1' || kind === 'R2' ? 'Navigation' : kind.startsWith('S') ? 'Scroll' : first.label ? (SUBMIT_LABELS.has(first.label) ? first.label : `Use ${first.label}`) : 'unknown_step'),
            event_ids: [...new Set(group.map((e) => e.event_id))].slice(0, 8), facts, limitations, strength: STRENGTH[kind],
        })
    }

    const primary = new Series(events.filter(isPrimaryClick))
    const inputs = new Series(events.filter(isInput))
    // An edit is an input on a field the user engaged (clicked or focused) earlier in the same screen visit. ERPNext sets
    // hundreds of field values by script when a form opens (rrweb records them as inputs, without userTriggered), and
    // dependent fields are filled by script after a user edit; neither is the user editing.
    const engaged = new Set<string>()
    const edits = new Series(events.filter((e) => {
        if (e.kind === 'navigation') { engaged.clear(); return false }
        const key = `${e.window_id}|${e.node_id}`
        if ((e.kind === 'click' || e.kind === 'focus') && e.node_id !== undefined) engaged.add(key)
        return e.kind === 'input_activity' && e.node_id !== undefined && engaged.has(key)
    }))
    const errors = new Series(events.filter((e) => e.kind === 'error'))
    const visibleErrors = new Series(errors.items.filter((e) => e.error_kind === 'visible'))
    const responses = new Series(events.filter((e) => e.kind === 'mutation' || e.kind === 'navigation'))
    const scrolls = new Series(events.filter((e) => e.kind === 'scroll'))
    const navs = new Series(events.filter((e) => e.kind === 'navigation'))
    const pc = primary.items

    // D1 rage click: ≥3 primary clicks, each within 1 s and 30 px of the previous, same screen and frame.
    const rage = new Set<TimelineItem>()
    for (let i = 0; i < pc.length;) {
        let j = i + 1
        while (j < pc.length && pc[j]!.offset_ms - pc[j - 1]!.offset_ms <= cfg.rageGapMs && manhattan(pc[j - 1]!, pc[j]!) <= cfg.rageManhattanPx && scr(pc[j]!) === scr(pc[i]!) && pc[j]!.frame_id === pc[i]!.frame_id) j++
        if (j - i >= cfg.rageClicks) {
            const group = pc.slice(i, j); group.forEach((e) => rage.add(e))
            const span = group.at(-1)!.offset_ms - group[0]!.offset_ms
            add('D1', group, { clicks: group.length, span_ms: span, lost_ms: span })
        }
        i = j
    }

    // D2 dead click: a labelled button / role=button; no DOM or URL response within 2.5 s and no scroll within 100 ms.
    // Requires observed DOM coverage: without mutations in the recording, silence is not evidence.
    if (timeline.coverage.dom_seen && !timeline.coverage.truncated) {
        for (const c of pc) {
            if (rage.has(c) || !c.label || c.tag === 'a' || !(c.tag === 'button' || c.role === 'button')) continue
            if (responses.any(c.offset_ms, c.offset_ms + cfg.deadResponseMs)) continue
            if (scrolls.any(c.offset_ms, c.offset_ms + cfg.deadScrollMs)) continue
            add('D2', [c], { response_window_ms: cfg.deadResponseMs, lost_ms: cfg.deadResponseMs })
        }
    }

    // D3 error click: console error, failed request or exception within 1 s after a click.
    // Only rrweb plugin errors count: an app $exception is a separate observation and is never tied to a click by time alone.
    // Background errors need corroboration (§8 "cry wolf"): a visible error too, or the first error of that kind.
    const firstOfKind = new Set<TimelineItem>()
    const seenKinds = new Set<string>()
    for (const e of errors.items) { const k = e.error_kind ?? 'unknown'; if (!seenKinds.has(k)) { seenKinds.add(k); firstOfKind.add(e) } }
    for (const c of pc) {
        const err = errors.any(c.offset_ms, c.offset_ms + cfg.errorClickMs, (e) => e.source === 'rrweb' && (e.error_kind === 'console' || e.error_kind === 'network'))
        if (!err) continue
        const visible = !!visibleErrors.any(c.offset_ms, c.offset_ms + cfg.errorClickMs)
        if (!visible && !firstOfKind.has(err)) continue
        add('D3', [c, err], { delay_ms: err.offset_ms - c.offset_ms, error_kind: err.error_kind ?? 'unknown', visible_error: visible, first_of_kind: firstOfKind.has(err), lost_ms: 0 }, c.label)
    }

    // D4 validation-error loop: Save/Submit → visible error (≤3 s) → edit → Save/Submit → error, on one screen; ≥2 cycles.
    const submits = pc.filter((e) => !!e.label && SUBMIT_LABELS.has(e.label))
    const loopSubmits = new Set<TimelineItem>()
    for (let i = 0; i < submits.length;) {
        const screen = scr(submits[i]!)
        let j = i + 1
        while (j < submits.length && scr(submits[j]!) === screen && submits[j]!.offset_ms - submits[j - 1]!.offset_ms <= cfg.validationWindowMs) j++
        const attempts = submits.slice(i, j)
        let cycles = 0, run: TimelineItem[] = [], best: TimelineItem[] = [], bestCycles = 0
        for (let k = 0; k < attempts.length; k++) {
            const s = attempts[k]!, nextAt = attempts[k + 1]?.offset_ms ?? Infinity
            const err = visibleErrors.any(s.offset_ms - 1, Math.min(s.offset_ms + cfg.validationErrorMs, nextAt))
            if (err) { cycles++; run.push(s, err) }
            const continues = !!err && k + 1 < attempts.length && !!edits.any(err.offset_ms, nextAt)
            if (!continues) {
                if (cycles > bestCycles) { bestCycles = cycles; best = run }
                cycles = 0; run = []
            }
        }
        if (bestCycles >= cfg.validationCycles) {
            const label = best[0]!.label!
            best.forEach((e) => loopSubmits.add(e))
            const span = best.at(-1)!.offset_ms - best[0]!.offset_ms
            add('D4', best, { cycles: bestCycles, span_ms: span, error_category: 'visible validation error', lost_ms: span }, label, label)
        }
        i = j
    }

    // D10 slow step: action → overlay removal, or (new form) Save → saved-record navigation; >3 s note, >10 s strong.
    const waitEnds = new Series(events.filter((e) => e.kind === 'coverage' && e.label === 'wait_end'))
    const waited = new Set<TimelineItem>()
    for (const s of events.filter((e) => e.kind === 'coverage' && e.label === 'wait_start')) {
        const end = waitEnds.any(s.offset_ms - 1, Infinity, (e) => e.window_id === s.window_id)
        const click = primary.between(s.offset_ms - cfg.waitClickMs, s.offset_ms, true).at(-1)
        if (!end || !click || waited.has(click)) continue
        const wait = end.offset_ms - click.offset_ms
        if (wait < cfg.waitMs) continue
        waited.add(click)
        add('D10', [click, s, end], { wait_ms: wait, strong: wait > cfg.strongWaitMs, signal: 'overlay', inputs_during_wait: inputs.between(click.offset_ms, end.offset_ms).length, lost_ms: wait }, click.label, click.label)
    }
    for (const s of submits) {
        const screen = scr(s)
        if (waited.has(s) || !screen.endsWith(':new')) continue
        const nav = navs.any(s.offset_ms, s.offset_ms + 120_000, (e) => e.screen !== screen)
        if (!nav || nav.screen !== doctypeOf(screen) + ':form' || errors.any(s.offset_ms, nav.offset_ms)) continue
        // Measure from the last Save before the navigation (a repeated click restarts the wait).
        const lastSave = primary.between(s.offset_ms, nav.offset_ms, true).filter((e) => e.label === s.label).at(-1) ?? s
        const wait = nav.offset_ms - lastSave.offset_ms
        if (wait < cfg.waitMs || waited.has(lastSave)) continue
        waited.add(lastSave)
        add('D10', [lastSave, nav], { wait_ms: wait, strong: wait > cfg.strongWaitMs, signal: 'save_response', inputs_during_wait: inputs.between(lastSave.offset_ms, nav.offset_ms).length, lost_ms: wait }, s.label, s.label, screen)
    }

    // D5 abandonment: a new form with ≥1 edit, then exit to another screen without the saved-record transition.
    // The session tail is uncertain (tail loss at unload) and never counts as abandonment.
    for (let i = 0; i + 1 < visits.length; i++) {
        const v = visits[i]!, next = visits[i + 1]!
        if (!v.screen.endsWith(':new') || next.screen === doctypeOf(v.screen) + ':form') continue
        const attemptEdits = edits.between(v.start, next.start, true)
        if (!attemptEdits.length) continue
        const lastEdit = attemptEdits.at(-1)!
        if (next.start - lastEdit.offset_ms < cfg.abandonQuietMs) continue
        // Only an error shown after a Save/Submit attempt is a validation error; Frappe also marks a required field red
        // (has-error-mandatory) while it is briefly empty during typing, which is not a rejected attempt.
        const firstSubmit = primary.between(v.start, next.start, true).find((e) => !!e.label && SUBMIT_LABELS.has(e.label))
        const lastError = firstSubmit ? visibleErrors.between(firstSubmit.offset_ms, next.start, true).at(-1) : undefined
        const afterFriction = out.some((c) => c.screen === v.screen && (c.kind === 'D3' || c.kind === 'D4' || c.kind === 'D10') && c.start_ms >= v.start && c.end_ms <= next.start)
        const lastField = attemptEdits.slice().reverse().find((e) => e.label)?.label
        add('D5', [attemptEdits[0]!, ...(lastError ? [lastError] : []), lastEdit], { edits: new Set(attemptEdits.map((e) => `${e.window_id}|${e.node_id}`)).size, input_events: attemptEdits.length, success_observed: false, exit_to: next.screen, after_friction: afterFriction, last_error: !!lastError, last_field: lastField ?? 'unknown', lost_ms: next.start - v.start }, lastField ?? 'Form', 'Abandon form', v.screen)
    }

    // D6 field hesitation (focus → first input ≥3 s, no other field typed meanwhile) and D7 returns (≥3 focuses), per visit.
    const focusAll = new Series(events.filter((e) => e.kind === 'focus' && !!e.label))
    for (const v of visits.length ? visits : [{ screen: timeline.screens[0] ?? 'unknown_screen', start: -1, end: Infinity, id: '', index: 0 }]) {
        const byField = new Map<string, TimelineItem[]>()
        for (const f of focusAll.between(v.start, v.end, true).slice(0, 2000)) byField.set(f.label!, [...(byField.get(f.label!) ?? []), f])
        for (const [label, group] of byField) {
            if (group.length >= cfg.fieldReturns) add('D7', group, { returns: group.length, lost_ms: 0 }, label, `Fill ${label}`, v.screen)
            for (const f of group) {
                const firstInput = edits.any(f.offset_ms - 1, v.end, (e) => e.label === label)
                if (!firstInput || edits.any(f.offset_ms - 1, firstInput.offset_ms - 1, (e) => e.label !== label)) continue
                const h = firstInput.offset_ms - f.offset_ms
                if (h >= cfg.hesitationMs) { add('D6', [f, firstInput], { hesitation_ms: h, lost_ms: h - cfg.hesitationMs }, label, `Fill ${label}`, v.screen); break }
            }
        }
    }

    // D8 dwell without action: no pointer sample for ≥2.5 s while over a labelled element, and no input in between.
    const pointers = events.filter((e) => e.kind === 'pointer' && e.x !== undefined && e.y !== undefined)
    for (let i = 0; i + 1 < pointers.length; i++) {
        const a = pointers[i]!, b = pointers[i + 1]!
        if (!a.label || b.offset_ms - a.offset_ms < cfg.dwellMs || inputs.any(a.offset_ms, b.offset_ms)) continue
        add('D8', [a, b], { dwell_ms: b.offset_ms - a.offset_ms, lost_ms: 0 }, a.label)
    }
    // D9 cursor thrash: experimental diagnostics only (research recovered 4/8 scripted reversals).
    for (let i = 0; i < pointers.length; i++) {
        const a = pointers[i]!
        let j = i
        while (j + 1 < pointers.length && pointers[j + 1]!.offset_ms - a.offset_ms <= cfg.thrashWindowMs && j - i < 60) j++
        const w = pointers.slice(i, j + 1)
        if (w.length < 6) continue
        let path = 0, reversals = 0, dir = 0, extreme = w[0]!.x!
        for (let k = 1; k < w.length; k++) {
            const dx = w[k]!.x! - w[k - 1]!.x!
            path += Math.hypot(dx, w[k]!.y! - w[k - 1]!.y!)
            const d = Math.sign(dx)
            if (d && dir && d !== dir) { if (Math.abs(w[k - 1]!.x! - extreme) >= cfg.thrashAmplitudePx) reversals++; extreme = w[k - 1]!.x! }
            if (d) dir = d
        }
        const net = Math.hypot(w.at(-1)!.x! - a.x!, w.at(-1)!.y! - a.y!)
        if (reversals >= cfg.thrashReversals && path >= cfg.thrashPathPx && net <= path * cfg.thrashNetRatio) {
            add('D9', [a, w.at(-1)!], { reversals, path_px: Math.round(path), net_px: Math.round(net), experimental: true, lost_ms: 0 }, a.label ?? 'Cursor')
            i = j
        }
    }

    // D12 help-seeking: Help/Search opened within 30 s after D6/D8/D4 on the same screen.
    for (const c of out.filter((x) => x.kind === 'D6' || x.kind === 'D8' || x.kind === 'D4')) {
        const help = primary.any(c.end_ms, c.end_ms + cfg.helpWindowMs, (e) => !!e.label && HELP_LABELS.has(e.label) && scr(e) === c.screen)
        const before = events.find((e) => e.event_id === c.event_ids[0])
        if (help && before) add('D12', [before, help], { after: c.kind, delay_ms: help.offset_ms - c.end_ms, lost_ms: help.offset_ms - c.start_ms }, c.element, c.step, c.screen)
    }

    // R1 A→B→A loops (B's dwell below its population median when known) and R2 re-opens (K ≥ 3), within one task.
    const navById = new Map(navs.items.map((e) => [e.event_id, e]))
    for (const task of taskSegments(visits, inputs, cfg)) {
        const loops = new Map<string, { n: number; dwell: number[]; items: TimelineItem[] }>()
        const loopAt = new Set<number>()
        for (let i = 0; i + 2 < task.length; i++) {
            const a = task[i]!, b = task[i + 1]!, c = task[i + 2]!
            if (a.screen !== c.screen || a.screen === b.screen) continue
            // B→A→B inside A→B→A→B→A is the same back-and-forth: judged once, from A.
            if (loopAt.has(i - 1)) continue
            loopAt.add(i)
            const dwell = b.end - b.start, median = ctx.screenDwellMedianMs?.[b.screen]
            if (median !== undefined && dwell >= median) continue
            const key = `${a.screen}|${b.screen}`
            const entry = loops.get(key) ?? { n: 0, dwell: [], items: [] }
            entry.n++; entry.dwell.push(dwell)
            for (const id of [b.id, c.id]) { const e = navById.get(id); if (e) entry.items.push(e) }
            loops.set(key, entry)
        }
        for (const [key, l] of loops) {
            const [screen, via] = key.split('|') as [string, string]
            const lost = l.dwell.reduce((s, x) => s + x, 0)
            const median = ctx.screenDwellMedianMs?.[via]
            add('R1', l.items, { loops: l.n, via, dwell_b_ms: Math.round(lost / l.n), population_median_ms: median ?? -1, calibrated: median !== undefined, single_lookup: l.n === 1, lost_ms: lost }, via, 'Navigation', screen)
        }
        const counts = new Map<string, Visit[]>()
        for (const v of task) counts.set(v.screen, [...(counts.get(v.screen) ?? []), v])
        for (const [screen, vv] of counts) {
            if (vv.length < cfg.reopens) continue
            const items = vv.map((v) => navById.get(v.id)).filter((e): e is TimelineItem => !!e)
            add('R2', items, { reopens: vv.length, lost_ms: 0 }, screen, 'Navigation', screen)
        }
    }

    // S1 distance, S2 reversals with hysteresis h = max(0.25·H, 200 px), S3 hunting; per visit and scroll container.
    const H = Math.max(1, timeline.height || 800)
    const h = Math.max(cfg.scrollHysteresisH * H, cfg.scrollHysteresisPx)
    for (const v of visits.length ? visits : [{ screen: timeline.screens[0] ?? 'unknown_screen', start: -1, end: Infinity, id: '', index: 0 }]) {
        const containers = new Map<string, TimelineItem[]>()
        for (const e of scrolls.between(v.start, v.end, true)) if (e.scroll_y !== undefined) {
            const key = `${e.window_id}:${e.scroll_id ?? -1}`
            containers.set(key, [...(containers.get(key) ?? []), e])
        }
        for (const [container, group] of containers) {
            if (group.length < 2) continue
            const population = ctx.pageExtentPx?.[`${v.screen}|${container}`]
            const P = Math.max(H, ...group.map((e) => e.scroll_y! + H), population ?? 0)
            let distance = 0, reversals = 0, dir = 0, extreme = group[0]!.scroll_y!
            const turns: TimelineItem[] = []
            for (let i = 1; i < group.length; i++) {
                const y = group[i]!.scroll_y!
                distance += Math.abs(y - group[i - 1]!.scroll_y!)
                const d = Math.sign(y - extreme)
                if (!d) continue
                if (!dir) { dir = d; extreme = y; continue }
                if (d === dir) { extreme = y; continue }
                if (Math.abs(y - extreme) >= h) { reversals++; turns.push(group[i]!); dir = d; extreme = y }
            }
            const label = group.find((e) => e.label)?.label ?? (group[0]!.tag === undefined || group[0]!.tag === 'html' || group[0]!.tag === 'body' ? 'Page' : 'Scroll container')
            const span = group.at(-1)!.offset_ms - group[0]!.offset_ms
            const facts = { distance_px: Math.round(distance), d_over_h: +(distance / H).toFixed(3), d_over_p: +(distance / P).toFixed(3), reversals, page_lower_bound_px: Math.round(P), container, p_source: population ? 'population' : 'session', lost_ms: span }
            if (distance / H >= cfg.scrollDistanceOverH) add('S1', [group[0]!, group.at(-1)!], facts, label, 'Scroll', v.screen)
            if (reversals) add('S2', [group[0]!, ...turns], facts, label, 'Scroll', v.screen)
            let hunted = false
            for (let i = 0; i + cfg.scrollReversals - 1 < turns.length && !hunted; i++) {
                const t0 = turns[i]!, t1 = turns[i + cfg.scrollReversals - 1]!
                if (t1.offset_ms - t0.offset_ms <= cfg.scrollWindowMs && !inputs.any(t0.offset_ms - 1, t1.offset_ms, (e) => e.kind === 'click' || e.kind === 'input_activity')) hunted = true
            }
            const firstClick = primary.any(v.start, v.end)
            let before = 0
            for (let i = 1; i < group.length && (!firstClick || group[i]!.offset_ms < firstClick.offset_ms); i++) before += Math.abs(group[i]!.scroll_y! - group[i - 1]!.scroll_y!)
            if (hunted || before / P >= cfg.scrollHuntOverP) add('S3', [group[0]!, ...turns.slice(0, 5), group.at(-1)!], { ...facts, hunting_rule: hunted ? 'reversals' : 'distance_before_click', d_over_p_before_click: +(before / P).toFixed(3) }, label, 'Scroll', v.screen)
        }
    }

    // D14 repeated command with no state change, or undo/Cancel within 10 s after a save (Low, no rank weight).
    for (let i = 1; i < pc.length; i++) {
        const a = pc[i - 1]!, b = pc[i]!, gap = b.offset_ms - a.offset_ms
        if (!a.label || a.label !== b.label || loopSubmits.has(b) || rage.has(b) || gap <= cfg.repeatMinMs || gap >= cfg.repeatMaxMs) continue
        if (isFieldEntry(a) || isFieldEntry(b)) continue // clicking into a field again is not a repeated command
        if (navs.any(a.offset_ms, b.offset_ms) || errors.any(a.offset_ms, b.offset_ms)) continue
        add('D14', [a, b], { repeat_ms: gap, pattern: 'repeat', lost_ms: gap }, a.label)
    }
    for (const save of out.filter((x) => x.kind === 'D10').map((x) => x.end_ms)) {
        const undo = primary.any(save, save + cfg.undoMs, (e) => !!e.label && UNDO_LABELS.has(e.label))
        if (undo) add('D14', [undo], { pattern: 'undo_after_save', lost_ms: 0 }, undo.label)
    }

    // D15 long idle mid-session (supporting only): no input for ≥60 s between two inputs.
    const ii = inputs.items
    for (let i = 1; i < ii.length; i++) {
        const gap = ii[i]!.offset_ms - ii[i - 1]!.offset_ms
        if (gap < cfg.idleMs) continue
        const moved = pointers.some((p) => p.offset_ms > ii[i - 1]!.offset_ms && p.offset_ms < ii[i]!.offset_ms)
        add('D15', [ii[i - 1]!, ii[i]!], { idle_ms: gap, cursor_moved: moved, lost_ms: 0 }, ii[i - 1]!.label ?? 'Idle')
    }

    return out.sort((a, b) => a.start_ms - b.start_ms || a.kind.localeCompare(b.kind))
}
