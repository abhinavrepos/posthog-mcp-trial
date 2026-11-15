import { dailyAggregate } from './aggregatedaily.ts'
import { tasksDb } from './tasks.ts'
// Aggregate-only event counts for questions the daily history does not hold (by app version, tab, button, a
// property over years). Lens builds the HogQL from approved dimensions and bound values: no SQL from the
// caller, no raw rows, exact distinct counts. Results go through the privacy layer like every tool answer.
import { required, prop, type AppEvents } from './appevents.ts'
import { hogql } from './posthog.ts'
import { P } from './props.ts'

type Dim = { expr: (reg: AppEvents) => string; about: string }
/** What a question may group or filter by. People are not a dimension: never a user or distinct id. */
export const DIMENSIONS: Record<string, Dim> = {
    event: { expr: () => 'event', about: 'event name' },
    client: { expr: () => `toString(${P.client})`, about: 'client id (codename in private mode)' },
    app_version: { expr: () => `toString(${P.version})`, about: 'app release' },
    dialog: { expr: (r) => prop(r, 'dialog'), about: 'dialog code' },
    dialog_name: { expr: (r) => prop(r, 'dialogName'), about: 'dialog title' },
    tab: { expr: (r) => prop(r, 'tab'), about: 'tab inside a dialog' },
    action: { expr: (r) => prop(r, 'action'), about: 'OPEN/CLOSE/CHANGE...' },
    button: { expr: (r) => prop(r, 'button'), about: 'button label or message text' },
}
const METRICS = {
    events: 'count()',
    sessions: 'uniqExact(toString(properties.$session_id))',
    users: 'uniqExact(distinct_id)',
    clients: `uniqExact(toString(${P.client}))`,
} as const
const BUCKETS = { none: '', day: 'toStartOfDay(timestamp)', week: 'toMonday(timestamp)', month: 'toStartOfMonth(timestamp)', quarter: 'toStartOfQuarter(timestamp)', year: 'toStartOfYear(timestamp)' } as const
export type Metric = keyof typeof METRICS
const DAY = 86_400_000, GROUP_CAP = 20_000
/** [from, to) split at each 1 January (or the Monday on or before it, for weekly periods), when longer than 400 days. */
export function splitByYear(from: Date, to: Date, monday: boolean): { from: Date; to: Date }[] {
    if (+to - +from <= 400 * DAY) return [{ from, to }]
    const cuts: Date[] = []
    for (let y = from.getUTCFullYear() + 1; y <= to.getUTCFullYear(); y++) {
        let cut = Date.UTC(y, 0, 1)
        if (monday) cut -= ((new Date(cut).getUTCDay() + 6) % 7) * DAY
        if (cut > +from && cut < +to) cuts.push(new Date(cut))
    }
    const edges = [from, ...cuts, to]
    return edges.slice(0, -1).map((f, i) => ({ from: f, to: edges[i + 1] }))
}
export interface AggregateQuery {
    from: Date; to: Date
    metrics?: Metric[]
    group_by?: string[]            // up to 2 DIMENSIONS
    bucket?: keyof typeof BUCKETS
    filters?: { dimension: string; op: 'eq' | 'neq' | 'in'; value: string | string[] }[]
    events?: string[]              // default: the app's own screen and interaction events
    limit?: number                 // groups returned (1-200, default 50); the rest are counted
}

export async function aggregateEvents(q: AggregateQuery) {
    const reg = required()
    const metrics = [...new Set(q.metrics?.length ? q.metrics : ['events' as Metric])]
    for (const m of metrics) if (!(m in METRICS)) throw new Error(`Unknown metric "${m}". Choose from ${Object.keys(METRICS).join(', ')}.`)
    const groups = [...new Set(q.group_by || [])]
    if (groups.length > 2) throw new Error('Group by at most two dimensions.')
    for (const g of groups) if (!DIMENSIONS[g]) throw new Error(`Unknown dimension "${g}". Choose from ${Object.keys(DIMENSIONS).join(', ')}.`)
    const bucket = q.bucket || 'none'
    if (!(bucket in BUCKETS)) throw new Error(`Unknown bucket "${bucket}".`)
    const limit = q.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit is 1-200.')
    const filters = q.filters || []
    if (filters.length > 5) throw new Error('At most five filters.')
    const values: Record<string, unknown> = { from: q.from.toISOString(), to: q.to.toISOString(),
        events: q.events?.length ? q.events.map(String) : [reg.events.screen, reg.events.interaction] }
    const where = filters.map((f, i) => {
        const d = DIMENSIONS[f.dimension]
        if (!d) throw new Error(`Unknown filter dimension "${f.dimension}".`)
        const list = Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]
        if (!list.length || list.length > 50 || list.some((v) => v.length > 200)) throw new Error('A filter takes 1-50 values of at most 200 characters.')
        values[`f${i}`] = f.op === 'in' ? list : list[0]
        return f.op === 'in' ? `${d.expr(reg)} IN {f${i}}` : `${d.expr(reg)} ${f.op === 'neq' ? '!=' : '='} {f${i}}`
    })
    if (bucket === 'day' && +q.to - +q.from > 400 * DAY) throw new Error('Daily periods are limited to 400 days; use week, month, quarter or year for longer windows.')
    const rolled = dailyAggregate(tasksDb, q)
    if (rolled) return rolled
    const keys = [...(bucket !== 'none' ? [`${BUCKETS[bucket]} AS period`] : []), ...groups.map((g) => `${DIMENSIONS[g].expr(reg)} AS ${g}`)]
    const names = [...(bucket !== 'none' ? ['period'] : []), ...groups]
    const select = [...keys, ...metrics.map((m) => `${METRICS[m]} AS ${m}`)].join(', ')
    const scope = `FROM events WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}${where.length ? ' AND ' + where.join(' AND ') : ''}`
    const order = metrics[0], distinct = metrics.filter((m) => m !== 'events')
    const started = performance.now()
    // Long windows run as one query per calendar year (Monday-aligned for weekly periods), one at a time, so no
    // single PostHog query has to scan four years before its time limit. This stays exact: event counts add up
    // across years, and every period lies wholly inside one year. Distinct counts over the whole window cannot
    // be added across years, so those run as one query and are reported as unavailable if it does not finish.
    const chunks = splitByYear(q.from, q.to, bucket === 'week')
    const chunked = chunks.length > 1 && (bucket !== 'none' || !distinct.length)
    const run = (sql: string, from: Date, to: Date) => hogql(sql, { ...values, from: from.toISOString(), to: to.toISOString() }, { timeoutMs: 120_000 })
        .catch((e) => { throw new Error(`PostHog could not finish this count (${(e as Error).message.slice(0, 160)}). ${bucket === 'none' && distinct.length ? 'Add a bucket (month, quarter or year) so it can run a year at a time, ' : ''}narrow the window, add a filter or group by fewer dimensions.`) })
    let rows: Record<string, unknown>[] = [], capped = false
    if (names.length) {
        const merged = new Map<string, Record<string, unknown>>()
        for (const c of chunked ? chunks : [{ from: q.from, to: q.to }]) {
            const got = await run(`SELECT ${select} ${scope} GROUP BY ${names.join(', ')} ORDER BY ${order} DESC LIMIT ${GROUP_CAP + 1}`, c.from, c.to)
            if (got.length > GROUP_CAP) capped = true
            for (const r of got.slice(0, GROUP_CAP)) {
                const k = JSON.stringify(names.map((n) => String(r[n])))
                const old = merged.get(k)
                // Only additive event counts can meet here: with periods, a key never spans two years.
                if (old) for (const m of metrics) old[m] = Number(old[m] || 0) + Number(r[m] || 0)
                else merged.set(k, { ...r })
            }
        }
        rows = [...merged.values()]
    }
    const totals: Record<string, number | null> = {}
    let totalsNote = ''
    // Every group came back: the event total is their sum (no second scan). Otherwise count it year by year.
    if (metrics.includes('events') && names.length && !capped) totals.events = rows.reduce((n, r) => n + Number(r.events || 0), 0)
    else if (metrics.includes('events')) {
        let sum = 0
        for (const c of chunks.length > 1 ? chunks : [{ from: q.from, to: q.to }]) sum += Number((await run(`SELECT count() AS events ${scope}`, c.from, c.to))[0]?.events || 0)
        totals.events = sum
    }
    if (distinct.length) {
        try {
            const t = await run(`SELECT ${distinct.map((m) => `${METRICS[m]} AS ${m}`).join(', ')} ${scope}`, q.from, q.to)
            for (const m of distinct) totals[m] = Number(t[0]?.[m] || 0)
        } catch (e) {
            for (const m of distinct) totals[m] = null
            totalsNote = ` Distinct totals over the whole window are unavailable: ${(e as Error).message}`
        }
    }
    // With periods and groups: keep the top groups overall (by the first metric) in every period.
    let shown = rows, omitted: number | string = 0
    if (groups.length) {
        const score = new Map<string, number>()
        for (const r of rows) { const k = JSON.stringify(groups.map((g) => r[g])); score.set(k, (score.get(k) || 0) + Number(r[order] || 0)) }
        const top = new Set([...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k))
        omitted = score.size - top.size
        shown = rows.filter((r) => top.has(JSON.stringify(groups.map((g) => r[g]))))
    }
    if (capped) omitted = 'more groups exist than shown; narrow the window, filter or group by fewer dimensions'
    shown.sort((a, b) => String(a.period ?? '').localeCompare(String(b.period ?? '')) || Number(b[order] || 0) - Number(a[order] || 0))
    return {
        window: { from: values.from, to: values.to }, metrics, group_by: groups, bucket, filters,
        totals,
        rows: shown.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'period' ? String(v).slice(0, 10) : (metrics as string[]).includes(k) ? Number(v) : v]))),
        groups_omitted: omitted, queries: chunked ? chunks.length : 1,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        source: 'live', coverage: { status: 'complete', detail: 'Every matching PostHog event in the window, aggregated in ClickHouse. Events PostHog no longer keeps cannot be counted.' },
        note: 'Counts are exact (distinct counts use uniqExact). Totals cover every matching event; rows are the largest groups. No raw events or people are returned. Distinct counts per period are not additive across periods.' + totalsNote,
    }
}
