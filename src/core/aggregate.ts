import { ToolInputError } from './toolinputerror.ts'
import { dailyAggregate, RollupBudgetError } from './aggregatedaily.ts'
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

/** Cuts only at bucket boundaries: distinct identities never need adding across chunks. */
export function splitBuckets(from: Date, to: Date, bucket: string) {
    const chunks: { from: Date; to: Date }[] = []
    let start = from
    while (+start < +to) {
        const end = new Date(start)
        end.setUTCHours(0, 0, 0, 0)
        if (bucket === 'week') end.setUTCDate(end.getUTCDate() + (7 - (end.getUTCDay() + 6) % 7))
        else if (bucket === 'day') end.setUTCDate(end.getUTCDate() + 1)
        else {
            end.setUTCDate(1)
            if (bucket === 'month') end.setUTCMonth(end.getUTCMonth() + 1)
            else if (bucket === 'quarter') end.setUTCMonth(Math.floor(end.getUTCMonth() / 3) * 3 + 3)
            else { end.setUTCMonth(0); end.setUTCFullYear(end.getUTCFullYear() + 1) }
        }
        const next = +end < +to ? end : to
        chunks.push({ from: start, to: next }); start = next
    }
    return chunks
}

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
    limit?: number                 // requested groups (1-200, default 200); oversized buckets return at most 20 plus other
}

export async function aggregateEvents(q: AggregateQuery) {
    if (!Number.isFinite(+q.from) || !Number.isFinite(+q.to) || +q.from >= +q.to) throw new ToolInputError('from must be before to, with valid dates.')
    // "all time" and other very long requests are answered for the last four years (the most Lens keeps), not refused.
    let clampNote = ''
    if (+q.to - +q.from > 1462 * DAY) { q = { ...q, from: new Date(+q.to - 1461 * DAY) }; clampNote = ' The window was shortened to the last four years, the most Lens keeps.' }
    const reg = required()
    const metrics = [...new Set(q.metrics?.length ? q.metrics : ['events' as Metric])]
    for (const m of metrics) if (!Object.hasOwn(METRICS, m)) throw new ToolInputError(`Unknown metric "${m}". Choose from ${Object.keys(METRICS).join(', ')}.`)
    const groups = [...new Set(q.group_by || [])]
    if (groups.length > 2) throw new ToolInputError('Group by at most two dimensions.')
    for (const g of groups) if (!Object.hasOwn(DIMENSIONS, g)) throw new ToolInputError(`Unknown dimension "${g}". Choose from ${Object.keys(DIMENSIONS).join(', ')}.`)
    const bucket = q.bucket || 'none'
    if (!Object.hasOwn(BUCKETS, bucket)) throw new ToolInputError(`Unknown bucket "${bucket}".`)
    const limit = q.limit ?? 200
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ToolInputError('limit is 1-200.')
    const filters = q.filters || []
    if (filters.length > 5) throw new ToolInputError('At most five filters.')
    const values: Record<string, unknown> = { from: q.from.toISOString(), to: q.to.toISOString(),
        events: q.events?.length ? q.events.map(String) : [reg.events.screen, reg.events.interaction] }
    const where = filters.map((f, i) => {
        const d = DIMENSIONS[f.dimension]
        if (!['eq', 'neq', 'in'].includes(f.op)) throw new ToolInputError('Filter op must be eq, neq or in.')
        if (!Object.hasOwn(DIMENSIONS, f.dimension)) throw new ToolInputError(`Unknown filter dimension "${f.dimension}".`)
        const list = Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]
        if (!list.length || list.length > 50 || list.some((v) => v.length > 200)) throw new ToolInputError('A filter takes 1-50 values of at most 200 characters.')
        values[`f${i}`] = f.op === 'in' ? list : list[0]
        return f.op === 'in' ? `${d.expr(reg)} IN {f${i}}` : `${d.expr(reg)} ${f.op === 'neq' ? '!=' : '='} {f${i}}`
    })
    if (bucket === 'day' && +q.to - +q.from > 400 * DAY) throw new ToolInputError('Daily periods are limited to 400 days; use week, month, quarter or year for longer windows.')
    let rollupNote = clampNote
    try { const rolled = dailyAggregate(tasksDb, q); if (rolled) return rolled }
    catch(e) { if (!(e instanceof RollupBudgetError)) throw e; rollupNote = ' ' + e.message }
    if (tasksDb.prepare("SELECT 1 FROM aggregate_dimension_skipped WHERE day>=? AND day<? AND reason='source_expired' LIMIT 1").get(q.from.toISOString().slice(0,10),q.to.toISOString().slice(0,10))) {
        // A live query cannot reconstruct expired history either.
        return {window:{from:q.from.toISOString(),to:q.to.toISOString()},metrics,group_by:groups,bucket,filters,totals:{},rows:[],groups_omitted:0,queries:0,seconds:0,source:'history',coverage:{requested:{from:q.from.toISOString(),to_exclusive:q.to.toISOString(),timezone:'UTC'},answered:[],status:'unavailable',reason:'source_expired',detail:'PostHog source has fewer sessions or events than retained task evidence.'},note:'Exact dimension counts are unavailable because the source expired.'}
    }
    const keys = [...(bucket !== 'none' ? [`${BUCKETS[bucket]} AS period`] : []), ...groups.map((g) => `${DIMENSIONS[g].expr(reg)} AS ${g}`)]
    const names = [...(bucket !== 'none' ? ['period'] : []), ...groups]
    const select = [...keys, ...metrics.map((m) => `${METRICS[m]} AS ${m}`)].join(', ')
    const scope = `FROM events WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}${where.length ? ' AND ' + where.join(' AND ') : ''}`
    const order = metrics[0], distinct = metrics.filter((m) => m !== 'events')
    const started = performance.now()
    // Without periods only event counts can be added across years. Bucketed requests below
    // use smaller, complete periods so exact distinct states never cross chunk boundaries.
    const chunks = splitByYear(q.from, q.to, bucket === 'week')
    const maxGroups = Math.max(1, Math.min(GROUP_CAP, Math.floor(Number(process.env.LENS_AGG_MAX_GROUPS)) || GROUP_CAP))
    let queries = 0
    const run = (sql: string, from: Date, to: Date) => {
        queries++
        return hogql(sql, { ...values, from: from.toISOString(), to: to.toISOString() }, { timeoutMs: 120_000 })
            .catch((e) => { throw new Error(`PostHog could not finish this count (${(e as Error).message.slice(0, 160)}). ${bucket === 'none' && distinct.length ? 'Add a bucket (month, quarter or year) so it can run one bucket at a time, ' : ''}narrow the window, add a filter or group by fewer dimensions.`) })
    }
    if (bucket !== 'none') {
        const rows: Record<string, unknown>[] = [], totals: Record<string, number | null> = {}
        const buckets = splitBuckets(q.from, q.to, bucket)
        // Reserve a fair share of the result budget for every bucket. Small breakdowns
        // stay complete; only oversized buckets are reduced to top-N plus other.
        const allowance = Math.max(1, Math.min(limit, Math.floor(maxGroups / buckets.length)))
        const n = Math.min(20, allowance)
        let truncated = false, omitted = 0
        for (const c of buckets) {
            // Prefer retained exact sets, releasing them after each bucket. Budget exhaustion only
            // selects the live path; it never causes a partial rollup to be merged into the answer.
            let rolled
            try { rolled = dailyAggregate(tasksDb, { ...q, from: c.from, to: c.to, limit: allowance }) }
            catch (e) { if (!(e instanceof RollupBudgetError)) throw e; rollupNote = ' ' + e.message }
            if (rolled) {
                rows.push(...rolled.rows)
                truncated ||= Boolean(rolled.limits?.truncated)
                omitted += rolled.groups_omitted
                continue
            }
            const got = await run(`SELECT ${select} ${scope} GROUP BY ${names.join(', ')} ORDER BY ${order} DESC${groups.length ? ', ' + groups.join(', ') : ''} LIMIT ${allowance + 1}`, c.from, c.to)
            const kept = got.length > allowance ? got.slice(0, n) : got
            rows.push(...kept)
            if (got.length > allowance) {
                truncated = true; omitted++
                // Recount the complement from source. Summing group distincts would double count
                // sessions/clients shared by two omitted groups.
                const exclusions = kept.map((r, i) => '(' + groups.map((g, j) => {
                    values[`top${i}_${j}`] = r[g]
                    return `(ifNull(${DIMENSIONS[g].expr(reg)} = {top${i}_${j}}, 0) OR (${DIMENSIONS[g].expr(reg)} IS NULL AND {top${i}_${j}} IS NULL))`
                }).join(' AND ') + ')').join(' OR ')
                const rest = await run(`SELECT ${BUCKETS[bucket]} AS period, ${metrics.map(m => `${METRICS[m]} AS ${m}`).join(', ')} ${scope} AND NOT (${exclusions}) GROUP BY period LIMIT 1`, c.from, c.to)
                rows.push(...rest.map(r => ({ ...r, ...Object.fromEntries(groups.map(g => [g, 'other'])), is_other: true })))
            }
        }
        if (metrics.includes('events')) totals.events = rows.reduce((sum, r) => sum + Number(r.events || 0), 0)
        // An exact window-wide distinct requires retaining IDs across all buckets, or another
        // unbounded scan. Publish bucket counts and explicitly leave that total unavailable.
        for (const m of distinct) totals[m] = null
        const limits = {
            ...(truncated ? { truncated: `Top ${n} groups per bucket plus other. To get the rest, repeat this window with filters on ${groups.join(' or ')} (eq or in, at most 50 values), or request one bucket with narrower filters until other disappears.` } : {}),
            ...(distinct.length ? { distinct: `Exact ${distinct.join(', ')} counts are computed per bucket and per other row only. Window totals are unavailable; distinct counts must not be summed across buckets or groups.` } : {}),
        }
        return { window: { from: values.from, to: values.to }, metrics, group_by: groups, bucket, filters,
            totals, rows: rows.map(r => Object.fromEntries(Object.entries(r).map(([k,v]) => [k, k === 'period' ? String(v).slice(0,10) : (metrics as string[]).includes(k) ? Number(v) : v]))),
            groups_omitted: truncated && queries ? `At least ${omitted} omitted group rows; filter dimensions to retrieve the rest.` : omitted, queries, seconds: Math.round((performance.now()-started)/100)/10,
            source: queries ? 'live' : 'history', coverage: { status: 'complete', detail: 'Each complete bucket uses exact daily rollups where available, otherwise an exact source query.' }, limits,
            note: 'Counts are exact. Other is counted from the complement, never by summing distinct counts.' + rollupNote }
    }
    // No bucket: grouped distincts must see the entire window. Event-only totals below
    // can still be split by year. A bounded result LIMIT is applied after aggregation.
    // An exact distinct count over a whole long window can exceed ClickHouse memory. Then distinct metrics fall back to
    // ClickHouse's approximate uniq (about 1% error, small memory) and the answer says so; events stay exact.
    let approx = false
    const expr = (m: Metric) => approx ? METRICS[m].replace('uniqExact(', 'uniq(') : METRICS[m]
    const tooBig = (e: unknown) => distinct.length > 0 && /memory|code:\s*241|too much data/i.test(String((e as Error)?.message ?? e))
    let rows: Record<string, unknown>[] = [], capped = false
    if (names.length) {
        const grouped = () => run(`SELECT ${[...keys, ...metrics.map((m) => `${expr(m)} AS ${m}`)].join(', ')} ${scope} GROUP BY ${names.join(', ')} ORDER BY ${order} DESC LIMIT ${maxGroups + 1}`, q.from, q.to)
        let got: Record<string, unknown>[]
        try { got = await grouped() } catch (e) { if (!tooBig(e)) throw e; approx = true; got = await grouped() }
        capped = got.length > maxGroups
        rows = got.slice(0, maxGroups)
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
            const total = () => run(`SELECT ${distinct.map((m) => `${expr(m)} AS ${m}`).join(', ')} ${scope}`, q.from, q.to)
            let t: Record<string, unknown>[]
            try { t = await total() } catch (e) { if (!tooBig(e) || approx) throw e; approx = true; t = await total() }
            for (const m of distinct) totals[m] = Number(t[0]?.[m] || 0)
        } catch (e) {
            for (const m of distinct) totals[m] = null
            totalsNote = ` Distinct totals over the whole window are unavailable: ${(e as Error).message}`
        }
    }
    // With no period, keep the top groups over the entire window.
    let shown = rows, omitted: number | string = 0
    if (groups.length) {
        const score = new Map<string, number>()
        for (const r of rows) { const k = JSON.stringify(groups.map((g) => r[g])); score.set(k, (score.get(k) || 0) + Number(r[order] || 0)) }
        const top = new Set([...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k))
        omitted = score.size - top.size
        shown = rows.filter((r) => top.has(JSON.stringify(groups.map((g) => r[g]))))
    }
    const limits: { truncated?: string; approximate?: string } = {}
    if (approx) limits.approximate = `${distinct.join(' and ')} are approximate (ClickHouse uniq, about 1% error): an exact count over this whole window did not fit in memory. Events are exact. For exact distinct counts add bucket: 'month' (exact per month) or use a shorter window.`
    if (groups.length && (capped || Number(omitted) > 0)) {
        const selected = shown.map((r,i) => '(' + groups.map((g,j) => {
            values[`top${i}_${j}`] = r[g]
            return `(ifNull(${DIMENSIONS[g].expr(reg)} = {top${i}_${j}}, 0) OR (${DIMENSIONS[g].expr(reg)} IS NULL AND {top${i}_${j}} IS NULL))`
        }).join(' AND ') + ')').join(' OR ')
        const rest = await run(`SELECT ${metrics.map(m=>`${expr(m)} AS ${m}`).join(', ')} ${scope} AND NOT (${selected})`, q.from, q.to)
        shown.push(...rest.map(r=>({...r,...Object.fromEntries(groups.map(g=>[g,'other'])),is_other:true})))
        limits.truncated = `Top ${Math.min(limit,maxGroups)} groups plus other. To get the rest, repeat with eq or in filters on ${groups.join(' or ')} (at most 50 values) until other disappears.`
    }
    if (capped) omitted = 'more groups exist than shown; use dimension filters to retrieve the rest'
    shown.sort((a, b) => String(a.period ?? '').localeCompare(String(b.period ?? '')) || Number(b[order] || 0) - Number(a[order] || 0))
    return {
        window: { from: values.from, to: values.to }, metrics, group_by: groups, bucket, filters,
        totals,
        rows: shown.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'period' ? String(v).slice(0, 10) : (metrics as string[]).includes(k) ? Number(v) : v]))),
        limits, groups_omitted: omitted, queries,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        source: 'live', coverage: { status: 'complete', detail: 'Every matching PostHog event in the window, aggregated in ClickHouse. Events PostHog no longer keeps cannot be counted.' },
        note: (approx ? 'Event counts are exact; distinct counts are approximate (see limits). ' : 'Counts are exact (distinct counts use uniqExact). ') + 'Totals cover every matching event; rows are the largest groups. No raw events or people are returned. Distinct counts per period are not additive across periods.' + totalsNote + rollupNote,
    }
}
