/**
 * Rolling 30-day per-(detector, screen) baselines from every admitted deterministic run,
 * including zero-candidate visits (architecture §12c; PhD review #4). LLM selection never
 * enters here: only rv_run rows in mode 'deterministic' are read.
 */
import { all, run, tx } from './db.ts'
import { buildBaseline, SEVERITY_CONFIG, type Baseline } from './replay-vision-severity.ts'
import type { DetectorCode, DetectorContext } from './replay-vision-detectors.ts'
import { METRIC_CODES, type SessionMetric } from './replay-vision-metrics.ts'

export const DETECTORS: DetectorCode[] = METRIC_CODES
const MAX_RUNS = 5000
export interface RunMetrics { screens: string[]; counts: Record<string, Record<string, number>>; events: number; snapshot_bytes: number; metrics?: SessionMetric[] }

/** The bounded summary stored in rv_run.metrics_json. `metrics` (per-screen values incl. zeros) is the baseline input. */
export function runMetrics(screens: string[], candidates: { kind: string; screen: string }[], events: number, snapshot_bytes: number, metrics?: SessionMetric[]): RunMetrics {
    const counts: RunMetrics['counts'] = {}
    const list = [...new Set(screens)].slice(0, 100)
    for (const screen of list) { counts[screen] = {}; for (const code of DETECTORS) counts[screen]![code] = 0 }
    for (const c of candidates) { const row = counts[c.screen]; if (row) row[c.kind] = (row[c.kind] ?? 0) + 1 }
    return { screens: list, counts, events, snapshot_bytes, ...(metrics ? { metrics: metrics.slice(0, 2500) } : {}) }
}

/** Metric rows of one stored run: the per-screen values when present, otherwise candidate counts. */
function rowsOf(m: RunMetrics): { key: string; value: number; extent?: number }[] {
    if (Array.isArray(m.metrics)) return m.metrics
        .filter((x) => x && typeof x.screen === 'string' && typeof x.detector === 'string' && Number.isFinite(x.value))
        .map((x) => ({ key: `${x.detector}|${x.screen}${x.container ? '|' + x.container : ''}`, value: Math.max(0, x.value), extent: Number.isFinite(x.max_scroll_extent_px) ? x.max_scroll_extent_px : undefined }))
    if (!Array.isArray(m.screens)) return []
    return m.screens.filter((s) => typeof s === 'string').slice(0, 100).flatMap((screen) => DETECTORS.map((code) => ({ key: `${code}|${screen}`, value: Math.max(0, Number(m.counts?.[screen]?.[code]) || 0) })))
}

/**
 * Recompute the baselines for the 30 days before `now`, excluding `excludeRunId` (the item being
 * evaluated). Returns the number of (detector, screen) rows written.
 */
export function recomputeBaselines(excludeRunId?: number, now = new Date()): number {
    const rows = all<{ id: number; distinct_id: string | null; metrics_json: string }>(
        `SELECT id, distinct_id, metrics_json FROM rv_run WHERE state IN ('complete','partial') AND mode = 'deterministic' AND completed_at >= ? AND completed_at <= ? AND id <> ? ORDER BY completed_at DESC LIMIT ${MAX_RUNS}`,
        new Date(+now - SEVERITY_CONFIG.windowDays * 86_400_000).toISOString(), now.toISOString(), excludeRunId ?? -1)
    const values = new Map<string, { metrics: number[]; users: Set<string>; extent: number }>()
    for (const row of rows) {
        let metrics: RunMetrics
        try { metrics = JSON.parse(row.metrics_json) } catch { continue }
        const seen = new Set<string>()
        for (const r of rowsOf(metrics)) {
            if (seen.has(r.key)) continue
            seen.add(r.key)
            const entry = values.get(r.key) ?? { metrics: [], users: new Set<string>(), extent: 0 }
            entry.metrics.push(r.value)
            entry.users.add(row.distinct_id ?? `run:${row.id}`)
            if (r.extent) entry.extent = Math.max(entry.extent, r.extent)
            values.set(r.key, entry)
        }
    }
    const date = now.toISOString().slice(0, 10)
    const sample = rows.length === MAX_RUNS ? 'sampled' : 'all_admitted'
    tx(() => {
        for (const [key, entry] of values) {
            const sep = key.indexOf('|'), code = key.slice(0, sep), screen = key.slice(sep + 1)
            const b = buildBaseline(entry.metrics, entry.users.size, sample)
            run(`INSERT INTO rv_baseline(detector,screen_key,window_end,n_sessions,n_users,median,mad,p90,p95,rate,version,aux_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(detector,screen_key,window_end,version) DO UPDATE SET n_sessions=excluded.n_sessions,n_users=excluded.n_users,median=excluded.median,mad=excluded.mad,p90=excluded.p90,p95=excluded.p95,rate=excluded.rate,aux_json=excluded.aux_json`,
                code, screen, date, b.n_sessions, b.n_users, b.median, b.mad, b.p90, b.p95, entry.metrics.filter((x) => x > 0).length / Math.max(1, b.n_sessions), b.version,
                JSON.stringify({ sample: b.sample, selection: 'all admitted deterministic runs, including zero-hit visits', window_days: SEVERITY_CONFIG.windowDays, excluded_run: excludeRunId ?? null, page_extent_px: entry.extent || undefined, values: b.values.slice(0, 5000) }))
        }
    })
    return values.size
}

export interface StoredBaseline extends Baseline { rate: number; page_extent_px?: number; window_end: string }
/** The latest stored baseline per `${detector}|${screen}` (container rows keep their `|container` suffix). */
export function loadBaselines(): Map<string, StoredBaseline> {
    const rows = all<{ detector: string; screen_key: string; window_end: string; n_sessions: number; n_users: number; median: number; mad: number; p90: number; p95: number; rate: number; version: string; aux_json: string }>(
        `SELECT b.* FROM rv_baseline b JOIN (SELECT detector, screen_key, version, max(window_end) AS w FROM rv_baseline WHERE version = ? GROUP BY detector, screen_key, version) l
         ON b.detector = l.detector AND b.screen_key = l.screen_key AND b.version = l.version AND b.window_end = l.w LIMIT 50000`, SEVERITY_CONFIG.version)
    const out = new Map<string, StoredBaseline>()
    for (const r of rows) {
        let aux: { values?: number[]; sample?: string; page_extent_px?: number } = {}
        try { aux = JSON.parse(r.aux_json) } catch {}
        out.set(`${r.detector}|${r.screen_key}`, {
            n_sessions: r.n_sessions, n_users: r.n_users, median: r.median ?? 0, mad: r.mad ?? 0, p90: r.p90 ?? 0, p95: r.p95 ?? 0, rate: r.rate ?? 0,
            values: Array.isArray(aux.values) ? aux.values.filter(Number.isFinite) : [], sample: aux.sample === 'sampled' ? 'sampled' : 'all_admitted',
            version: r.version, page_extent_px: aux.page_extent_px, window_end: r.window_end,
        })
    }
    return out
}

/** Population context for the detectors: per-screen median dwell (R1) and per-container page extent P (S1/S3), only from calibrated rows. */
export function baselineContext(baselines: Map<string, StoredBaseline>): DetectorContext {
    const ctx: Required<DetectorContext> = { screenDwellMedianMs: {}, pageExtentPx: {} }
    for (const [key, b] of baselines) {
        if (!isCalibrated(b)) continue
        if (key.startsWith('DWELL|')) ctx.screenDwellMedianMs[key.slice(6)] = b.median
        else if (key.startsWith('S1|') && key.split('|').length === 3 && b.page_extent_px) ctx.pageExtentPx[key.slice(3)] = b.page_extent_px
    }
    return ctx
}

export const isCalibrated = (b: Pick<Baseline, 'n_sessions'|'n_users'> | undefined): boolean =>
    !!b && b.n_sessions >= SEVERITY_CONFIG.minSessions && b.n_users >= SEVERITY_CONFIG.minUsers
