// Saved aggregate charts: policy is checked again on every read, including cache hits.
import { ToolInputError } from './toolinputerror.ts'
import { commandRefusal, anonRefusal } from './posthogpolicy.ts'
import { privacyMode, withPrivacy, privacyCurrent, PRIVACY_CHANGED } from './anonymise.ts'
import { aiSafety } from './aisafety.ts'
import { guardResponse } from '../mcp/anonymise.ts'
import { posthogQuery, cachedPosthogRead, readCacheKey, PostHogError } from './posthog.ts'
import { posthogUsageMessage } from '../mcp/posthog-error.ts'
import { refreshRoster } from './anonroster.ts'

export const CHART_QUERY_KINDS = ['TrendsQuery', 'FunnelsQuery', 'RetentionQuery', 'PathsQuery', 'LifecycleQuery', 'StickinessQuery', 'HogQLQuery'] as const
export type ChartQueryKind = typeof CHART_QUERY_KINDS[number]
export interface PosthogChartParams {
    query: Record<string, unknown> & { kind: ChartQueryKind }
    chart?: 'line' | 'bar' | 'table'
    // SQL literals become bound placeholders. Offsets preserve the original window at each refresh.
    rolling?: { dates: { key: string; offset_ms: number; date_only: boolean }[] }
}
const commands: Record<ChartQueryKind, string> = { TrendsQuery: 'query-trends', FunnelsQuery: 'query-funnel', RetentionQuery: 'query-retention', PathsQuery: 'query-paths', LifecycleQuery: 'query-lifecycle', StickinessQuery: 'query-stickiness', HogQLQuery: 'execute-sql' }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fail = (message: string): never => { throw new ToolInputError(message) }
const DAY = 86400000
export const CHART_TTL = 5 * 60 * 1000

/** Returns a cloned node with codenames resolved, following the same command policy as posthog_exec. */
export function validateChartQuery(value: unknown): PosthogChartParams['query'] {
    let raw: string
    try { raw = JSON.stringify(value) } catch { return fail('The chart query must be JSON.') }
    if (!raw || Buffer.byteLength(raw) > 20_000) fail('The chart query must be at most 20 kB of JSON.')
    if (!object(value)) return fail('The chart query must be an object.')
    if (!CHART_QUERY_KINDS.includes(value.kind as ChartQueryKind)) return fail('Use a TrendsQuery, FunnelsQuery, RetentionQuery, PathsQuery, LifecycleQuery, StickinessQuery or HogQLQuery node.')
    // Inspect decoded strings too: JSON escapes, SQL comments and quoted identifiers cannot hide a source.
    const strings: string[] = []
    const visit = (v: unknown, depth = 0): void => {
        if (depth > 40) fail('The chart query is nested too deeply.')
        if (typeof v === 'string') strings.push(v)
        else if (Array.isArray(v)) v.forEach(x => visit(x, depth + 1))
        else if (object(v)) for (const [key, x] of Object.entries(v)) {
            strings.push(key)
            if (key === 'kind' && typeof x === 'string' && /person|record|replay/i.test(x)) fail('Person lists and recordings cannot be pinned.')
            if (key === 'kind' && typeof x === 'string' && /query$/i.test(x) && x !== value.kind) fail('Nested query nodes are not supported in a saved chart.')
            visit(x, depth + 1)
        }
    }
    visit(value)
    const inspected = strings.join(' ').replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/["`]/g, '')
    if (/session[_ -]?(?:replay|recording)|\breplays?\b|\brecordings?\b|\bpersons\b|\bemails?\b|\bperson_id\b|\bdistinct_id\b/i.test(inspected)) fail('Recordings, replays and person lists or identity fields cannot be pinned as charts. Use Lens tools for those.')
    if (value.kind === 'HogQLQuery') {
        if (/\bperson\b/i.test(inspected)) fail('Person identity fields cannot be pinned as SQL charts.')
        if (privacyMode() === 'private') fail('Raw SQL is refused in private mode. Use an aggregate PostHog chart instead.')
        if (typeof value.query !== 'string' || !/^\s*(?:select|with)\b/i.test(value.query.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, ''))) fail('A HogQL chart needs a read-only SELECT query.')
    }
    const command = `call ${commands[value.kind as ChartQueryKind]} ${raw}`
    const call = { method: 'tools/call', params: { name: 'exec', arguments: { command } } }
    const refused = commandRefusal(call)
    if (refused) fail(refused.error.message)
    const checked = anonRefusal(call)
    if (checked.refusal) fail(checked.refusal.result.content[0].text)
    const resolved = (checked.value as typeof call).params.arguments.command
    return JSON.parse(resolved.slice(resolved.indexOf('{'))) as PosthogChartParams['query']
}

export function validateChartParams(raw: unknown): PosthogChartParams {
    if (!object(raw)) return fail('Chart params must be an object.')
    validateChartQuery(raw.query)
    if (raw.chart !== undefined && !['line', 'bar', 'table'].includes(String(raw.chart))) fail('Chart must be line, bar or table.')
    if (raw.rolling !== undefined) {
        if (!object(raw.rolling) || !Array.isArray(raw.rolling.dates) || raw.rolling.dates.length > 100) return fail('Invalid rolling SQL window.')
        for (const d of raw.rolling.dates) if (!object(d) || !/^lens_chart_date_\d+$/.test(String(d.key)) || typeof d.offset_ms !== 'number' || !Number.isFinite(d.offset_ms) || d.offset_ms > 0 || d.offset_ms < -8_000_000_000_000_000 || typeof d.date_only !== 'boolean') fail('Invalid rolling SQL date.')
    }
    return structuredClone({ query: raw.query, ...(raw.chart ? { chart: raw.chart } : {}), ...(raw.rolling ? { rolling: raw.rolling } : {}) }) as PosthogChartParams
}

/** Fixed dates are copied verbatim. Relative dates supplied by PostHog already remain relative. */
export function prepareChartParams(query: unknown, chart?: PosthogChartParams['chart'], fixed = false, now = new Date()): PosthogChartParams {
    validateChartQuery(query)
    const p = validateChartParams({ query, chart })
    if (fixed) return p
    if (p.query.kind !== 'HogQLQuery') {
        const range = object(p.query.dateRange) ? p.query.dateRange : {}
        const from = typeof range.date_from === 'string' ? range.date_from : '-30d'
        if (/^-\d+[a-z]+$/i.test(from) || from === 'all') p.query.dateRange = { ...range, date_from: from, date_to: null }
        else {
            const start = Date.parse(from), end = range.date_to ? Date.parse(String(range.date_to)) : +now
            if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) fail('Use a valid date range or keep_dates_fixed.')
            const days = Math.max(1, Math.ceil((end - start) / DAY) + (range.date_to ? 1 : 0))
            p.query.dateRange = { ...range, date_from: `-${days}d`, date_to: null }
        }
    } else {
        const sql = String(p.query.query)
        const isoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && Number.isFinite(Date.parse(v))
        const literals = [...sql.matchAll(/'([^']*)'/g)].filter(m => isoDate(m[1]))
        const values = object(p.query.values) ? p.query.values : {}
        const bound = Object.entries(values).filter(([key, v]) => isoDate(v) && sql.includes(`{${key}}`)) as [string, string][]
        const allDates = [...literals.map(m => m[1]), ...bound.map(([, v]) => v)]
        if (allDates.length > 100) fail('Too many SQL dates. Use relative SQL dates or keep_dates_fixed.')
        if (allDates.length) {
            const distinct = [...new Set(allDates)]
            const anchor = distinct.length > 1 ? Math.max(...distinct.map(d => Date.parse(d))) : distinct[0].length === 10 ? Date.parse(now.toISOString().slice(0, 10)) : +now
            const dates: NonNullable<PosthogChartParams['rolling']>['dates'] = []
            const placeholder = (date: string): string => {
                const key = `lens_chart_date_${dates.length}`
                if (key in values) fail('SQL values beginning lens_chart_date_ are reserved for rolling dates.')
                dates.push({ key, offset_ms: Date.parse(date) - anchor, date_only: date.length === 10 })
                return `{${key}}`
            }
            let template = sql.replace(/'([^']*)'/g, (literal, date: string) => isoDate(date) ? placeholder(date) : literal)
            for (const [key, date] of bound) {
                template = template.replaceAll(`{${key}}`, placeholder(date))
                delete values[key]
            }
            p.query.query = template
            if (object(p.query.values)) p.query.values = values
            p.rolling = { dates }
        }
    }
    return p
}

export function resolveChartQuery(params: PosthogChartParams, now = new Date()): PosthogChartParams['query'] {
    const p = validateChartParams(params), query = validateChartQuery(p.query)
    if (p.rolling) {
        const values = object(query.values) ? query.values : {}
        for (const d of p.rolling.dates) {
            const end = d.date_only ? Date.parse(now.toISOString().slice(0, 10)) : Math.floor(+now / CHART_TTL) * CHART_TTL
            const date = new Date(end + d.offset_ms).toISOString()
            values[d.key] = d.date_only ? date.slice(0, 10) : date.replace('T', ' ').replace('Z', '')
        }
        query.values = values
    }
    return query
}

export class ChartError extends Error {}
export async function chartErrorMessage(error: unknown): Promise<string> {
    let message = 'PostHog is unavailable. Try again shortly; your saved chart is still here.'
    if (error instanceof ToolInputError || error instanceof ChartError) message = error.message
    else if (error instanceof PostHogError) {
        if (error.status === 400 || error.status === 422) message = posthogUsageMessage(error.message) || 'PostHog rejected this chart query. Check its fields and filters and pin it again.'
        else if (error.status === 401 || error.status === 403) message = 'PostHog refused access. Ask an admin to check the project read key.'
        else if (error.status === 429) message = 'PostHog is busy. Try again shortly.'
    }
    return aiSafety(message, 'posthog')
}

/** Cache raw reads internally; reapply current privacy to every response, even a cache hit. */
export async function readPosthogChart(params: PosthogChartParams): Promise<{ result: unknown; updated_at: string }> {
    return withPrivacy(async () => {
        try {
            validateChartParams(params)
            if (privacyMode() === 'private') await refreshRoster()
            const query = resolveChartQuery(params)
            const bucket = Math.floor(Date.now() / CHART_TTL)
            const answer = await cachedPosthogRead(readCacheKey('dashboard-chart', { query, bucket }), async () => {
                const result = await posthogQuery(query)
                if (object(result) && (result.error || result.isError)) throw new ChartError('PostHog could not run this chart. Check its query and pin it again.')
                if (query.kind === 'PathsQuery' && object(result) && Array.isArray(result.results)) {
                    result.results = result.results.map(row => {
                        if (!object(row) || typeof row.value !== 'number') return row
                        const { value, ...rest } = row
                        return { ...rest, count: value }
                    })
                }
                return result
            }, { ttlMs: CHART_TTL })
            // A numeric breakdown is a dimension value, not an event count. Give it the same
            // conservative treatment as a generic numeric `value` in Copilot answers.
            const dimensions = (v: unknown): unknown => Array.isArray(v) ? v.map(dimensions) : object(v)
                ? Object.fromEntries(Object.entries(v).map(([key, x]) => [key, key === 'breakdown_value' && privacyMode() !== 'open'
                    ? (Array.isArray(x) ? x.map(y => typeof y === 'number' ? '<amount>' : y) : typeof x === 'number' ? '<amount>' : x) : dimensions(x)])) : v
            const result = guardResponse(await aiSafety(dimensions(answer.value), 'posthog'), 'posthog_cleaned')
            if (!privacyCurrent()) throw new ChartError(PRIVACY_CHANGED)
            return { result, updated_at: new Date(answer.cachedAt).toISOString() }
        } catch (error) { throw new ChartError(await chartErrorMessage(error)) }
    })
}
