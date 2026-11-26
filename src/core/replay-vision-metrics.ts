/**
 * Per-session, per-screen metric rows (architecture "Baselines, prevalence and severity").
 * Every visited screen contributes a row for every detector, including zero values, so a
 * baseline built from these rows reflects all admitted sessions, not only flagged ones.
 */
import type { Timeline } from './replay-timeline.ts'
import { DETECTOR_CONFIG, screenVisits, type Candidate, type DetectorCode } from './replay-vision-detectors.ts'
import { buildBaseline, type Baseline } from './replay-vision-severity.ts'

export const METRIC_CODES: DetectorCode[] = ['D1','D2','D3','D4','D5','D6','D7','D8','D9','D10','R1','R2','D12','S1','S2','S3','D14','D15']
/** Detectors judged as a rate of affected sessions rather than by a continuous value. */
export const BINARY_CODES = new Set<string>(['D1', 'D3', 'D4', 'D5'])
export type MetricCode = DetectorCode | 'DWELL'
export interface SessionMetric { screen: string; detector: MetricCode; value: number; container?: string; max_scroll_extent_px?: number; coverage: string }
export interface BaselineRecord { session_id: string; user_id: string; admitted: boolean; metrics: SessionMetric[] }

/** The continuous value a candidate contributes to its (screen, detector) metric. */
export function metricValue(c: Pick<Candidate, 'kind'|'facts'>): number {
    const f = c.facts
    const v = c.kind === 'D1' ? f.clicks : c.kind === 'D4' ? f.cycles : c.kind === 'D10' ? f.wait_ms : c.kind === 'R1' ? f.loops : c.kind === 'R2' ? f.reopens
        : c.kind === 'S1' || c.kind === 'S3' ? f.d_over_p : c.kind === 'S2' ? f.reversals : c.kind === 'D6' ? f.hesitation_ms : c.kind === 'D7' ? f.returns
        : c.kind === 'D8' ? f.dwell_ms : c.kind === 'D15' ? f.idle_ms : 1
    return typeof v === 'number' && Number.isFinite(v) ? v : 1
}

export function sessionMetrics(timeline: Timeline, candidates: Candidate[]): SessionMetric[] {
    const coverage = timeline.coverage.state
    const values = new Map<string, SessionMetric>()
    const screens = new Set(timeline.screens)
    for (const c of candidates) screens.add(c.screen)
    for (const screen of [...screens].slice(0, 100)) for (const detector of METRIC_CODES) values.set(`${screen}|${detector}`, { screen, detector, value: 0, coverage })
    for (const c of candidates) {
        const m = values.get(`${c.screen}|${c.kind}`)
        if (m) m.value = Math.max(m.value, metricValue(c))
    }
    // Median visit dwell per screen in this session (population input for R1).
    const events = timeline.items.slice().sort((a, b) => a.offset_ms - b.offset_ms)
    const dwell = new Map<string, number[]>()
    for (const v of screenVisits(events, DETECTOR_CONFIG)) dwell.set(v.screen, [...(dwell.get(v.screen) ?? []), v.end - v.start])
    for (const [screen, d] of [...dwell].slice(0, 100)) {
        const sorted = d.sort((a, b) => a - b)
        values.set(`${screen}|DWELL`, { screen, detector: 'DWELL', value: sorted[(sorted.length - 1) >> 1]!, coverage })
    }
    // S1 per container: D/P and the session's own extent max(y)+H, which feeds the population P estimate.
    const H = Math.max(1, timeline.height || 800)
    let screen = timeline.screens[0] ?? 'unknown_screen'
    const last = new Map<string, number>(), distance = new Map<string, number>(), extent = new Map<string, number>()
    for (const item of events) {
        if (item.kind === 'navigation' && item.screen) { screen = item.screen; continue }
        if (item.kind !== 'scroll' || item.scroll_y === undefined) continue
        const key = `${screen}|${item.window_id}:${item.scroll_id ?? -1}`, prev = last.get(key)
        if (prev !== undefined) distance.set(key, (distance.get(key) ?? 0) + Math.abs(item.scroll_y - prev))
        last.set(key, item.scroll_y)
        extent.set(key, Math.max(extent.get(key) ?? H, item.scroll_y + H))
    }
    for (const [key, P] of [...extent].slice(0, 200)) {
        const split = key.indexOf('|'), s = key.slice(0, split), container = key.slice(split + 1)
        values.set(`${s}|S1|${container}`, { screen: s, detector: 'S1', value: (distance.get(key) ?? 0) / P, container, max_scroll_extent_px: P, coverage })
    }
    return [...values.values()].slice(0, 2500)
}

/** Build baselines from admitted deterministic reductions only; provider selection never enters this API. */
export function metricBaselines(records: BaselineRecord[]): Map<string, Baseline> {
    const byMetric = new Map<string, { values: number[]; users: Set<string> }>(), seen = new Set<string>()
    for (const record of records) {
        if (!record.admitted || seen.has(record.session_id)) continue
        seen.add(record.session_id)
        for (const metric of record.metrics) {
            if (!Number.isFinite(metric.value)) continue
            const key = `${metric.screen}|${metric.detector}${metric.container ? `|${metric.container}` : ''}`
            const bucket = byMetric.get(key) ?? { values: [], users: new Set<string>() }
            bucket.values.push(metric.value); bucket.users.add(record.user_id); byMetric.set(key, bucket)
        }
    }
    return new Map([...byMetric].map(([key, b]) => [key, buildBaseline(b.values, b.users.size)]))
}
