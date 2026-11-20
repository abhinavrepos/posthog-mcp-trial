// Structured tool output (MCP 2025-11-25 Tools: outputSchema / structuredContent) and the `detail` switch.
// Both run inside wrapTools, on the final object only: tool internals, numbers and the privacy pass are unchanged.
import { z } from 'zod'

/**
 * Registration markers. A registration passes `outputSchema: ANALYSIS_OUTPUT` (or ROWS_OUTPUT/CANDIDATES_OUTPUT)
 * only when its callback answers every successful call with jsonResult; wrapTools replaces the marker with the
 * advertised schema. The guarantee belongs to the callback, so it is declared next to it, never inferred from
 * a tool name. Analysis answers are completed by analyticalResult with window, coverage (with processing) and
 * limits. Tools with any text-only success path have no marker: attempt_timings (no insights access),
 * handover_pack (Markdown), pin_dashboard/list_dashboards/share_dashboard (personal-token refusals),
 * save_survey and draft_rescue_survey (several unrelated shapes), and every Markdown/text tool.
 */
export const ANALYSIS_OUTPUT = z.looseObject({}).meta({ title: 'lens-analysis-output' })
export const ROWS_OUTPUT = z.looseObject({}).meta({ title: 'lens-rows-output' })
export const CANDIDATES_OUTPUT = z.looseObject({}).meta({ title: 'lens-candidates-output' })
/** The tools registered with ANALYSIS_OUTPUT (kept in sync by test/structured-output.test.ts). */
export const ANALYSIS_SCHEMA_TOOLS = new Set(['find_client_incidents', 'screen_usage', 'error_blast_radius', 'find_silent_issues',
    'discover_workflows', 'aggregate_events', 'workflow_completion', 'describe_app_events', 'dialog_friction', 'message_doctor', 'top_pains',
    'find_trade', 'find_sessions', 'client_signals', 'design_survey', 'list_surveys', 'survey_results', 'signal_scorecard', 'client_experience',
    'friction_hotspots', 'client_story', 'client_activity_changes', 'compare_client_patterns', 'monday_brief', 'rescue_queue',
    'set_rescue_status', 'task_map', 'flow_time'])
/** Analysis tools that accept `detail` (concise | full). get_job_result also accepts it for completed jobs. */
export const DETAIL_TOOLS = new Set([...ANALYSIS_SCHEMA_TOOLS, 'attempt_timings', 'get_job_result'].filter(t => !['design_survey', 'set_rescue_status'].includes(t)))
export const detailInput = z.enum(['concise', 'full']).optional().describe('concise: headline numbers, window, coverage, top 10 rows and counts of what was left out. Default full.')

const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape).meta({ additionalProperties: true })
// Every field is optional: the MCP SDK rejects an answer whose structuredContent does not match the advertised
// schema, so a required field that one answer path omits turns a good answer into a PM-facing error (find_trade
// did exactly that). The schema documents the fields; it must never be able to fail a real answer.
const analysisShape = () => loose({
    window: z.any().optional().describe('{from, to}: the dates the answer covers'),
    coverage: z.any().optional().describe('which days were covered and why any are missing'),
    limits: z.any().optional().describe('caps, truncation and approximations that apply'),
    detail: z.any().optional().describe('concise or full'),
    omitted: z.any().optional().describe('concise answers: what was left out, by path'),
})
// Exactly the object runningResult() serialises (src/core/jobs.ts).
const runningShape = () => loose({ status: z.any().optional(), job_id: z.any().optional(), poll_after_seconds: z.any().optional(), note: z.any().optional() })
const SHAPES = new Map<unknown, () => z.ZodObject>([
    [ANALYSIS_OUTPUT, analysisShape],
    [ROWS_OUTPUT, () => loose({ rows: z.array(loose({})).optional() })],
    [CANDIDATES_OUTPUT, () => loose({ candidates: z.array(loose({})).optional() })],
])
/**
 * The output schema to advertise for a registration marker; any other value passes through unchanged.
 * Job-backed tools may answer with a running handle, so their schema is `type: object` + `anyOf` [answer,
 * handle]: the SDK only accepts object schemas, so the alternatives are checked by a refinement and
 * advertised through metadata.
 */
export function outputSchemaFor(marker: unknown, jobBacked: boolean): unknown {
    const answer = SHAPES.get(marker)?.()
    if (!answer) return marker
    if (!jobBacked) return answer
    const running = runningShape()
    const json = (s: z.ZodType) => { const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io: 'output' }) as Record<string, unknown>; return rest }
    // Documentation only: an answer or a running handle. No refinement, so no answer can be rejected by its shape.
    return z.looseObject({}).meta({ additionalProperties: true, description: 'An analysis answer, or a running job handle {status:"running", job_id, poll_after_seconds, note}.', anyOf: [json(answer), json(running)] })
}

/** structuredContent must be a JSON object; a top-level list is carried as {rows}, the convention analyticalResult uses. */
export function structuredOf(value: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(value)) return { rows: value }
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

// ------------------------------------------------------------------ concise answers
const TOP_ROWS = 10, NESTED_ROWS = 3
// Example sessions/replays and per-day/week/month series: dropped in concise answers, with counts.
const DROP = new Set(['examples', 'example', 'example_sessions', 'example_session', 'sample', 'samples', 'replays', 'replay', 'replay_url', 'replay_links',
    'series', 'series_all', 'daily', 'by_day', 'per_day', 'days', 'weeks', 'weekly', 'months', 'monthly', 'timeline', 'recording_months', 'buckets'])
// Disclosures are never compacted; they say what the numbers cover.
const KEEP = new Set(['window', 'period', 'coverage', 'limits', 'omitted_rows_by_path', 'comparison', 'freshness'])
// Per-tool keys kept whole: survey_results' spec is meant to be edited and passed back to save_survey.
const KEEP_FOR: Record<string, string[]> = { survey_results: ['spec'], find_sessions: ['sessions'] }
const size = (v: unknown) => Array.isArray(v) ? v.length : 1
/** Generic compaction of a final answer object for detail=concise. Pure: returns a new object. */
export function conciseValue(name: string, value: Record<string, unknown>): Record<string, unknown> {
    const omitted: Record<string, number> = {}
    const keep = new Set([...KEEP, ...(KEEP_FOR[name] || [])])
    const add = (path: string, n: number) => { if (n > 0) omitted[path] = (omitted[path] || 0) + n }
    const walk = (v: unknown, path: string, inList: boolean, top: boolean): unknown => {
        if (Array.isArray(v)) {
            const cap = inList ? NESTED_ROWS : TOP_ROWS
            add(path, v.length - cap)
            return v.slice(0, cap).map(item => walk(item, `${path}[]`, true, false))
        }
        if (!v || typeof v !== 'object') return v
        const out: Record<string, unknown> = {}
        for (const [key, child] of Object.entries(v)) {
            const p = path ? `${path}.${key}` : key
            if (top && keep.has(key)) { out[key] = child; continue }
            // Only lists and objects are dropped: a scalar such as weeks: 12 is a headline number.
            if (DROP.has(key) && child && typeof child === 'object') { add(p, size(child)); continue }
            if (DROP.has(key) && key.includes('replay') && typeof child === 'string') { add(p, 1); continue }
            out[key] = walk(child, p, inList, false)
        }
        return out
    }
    const out = walk(value, '', false, true) as Record<string, unknown>
    if(name==='rescue_queue' && Array.isArray(out.clients)) {
        const total=Number(out.total_clients), offset=Number(out.offset || 0)
        out.limits={...(out.limits as object),returned_rows:out.clients.length,omitted_rows:Math.max(0,total-out.clients.length)}
        out.next_offset=offset+out.clients.length<total ? offset+out.clients.length : null
    }
    return { ...out, detail: 'concise', omitted }
}
/** Apply detail=concise to a jsonResult before the privacy pass. Text-only and error results pass unchanged. */
export function applyDetail(name: string, result: unknown, detail: 'concise' | 'full' | undefined): unknown {
    if (detail !== 'concise' || !result || typeof result !== 'object') return result
    const r = result as { isError?: boolean; _lensJson?: { label: string; value: unknown } }
    if (r.isError || !r._lensJson) return result
    const value = structuredOf(r._lensJson.value)
    if (!value) return result
    return { ...r, _lensJson: { ...r._lensJson, value: conciseValue(name, value) } }
}

/** Last line of defence for tools that advertise an outputSchema: a successful text-only answer gets its text as
 * structuredContent.overview, so the SDK can never turn a real answer into "has an output schema but did not
 * return structured content". Errors and answers that already carry structuredContent pass unchanged. */
export function ensureStructured(result: unknown): unknown {
    const r = result as { isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: unknown }[] }
    if (!r || typeof r !== 'object' || r.isError || r.structuredContent || !Array.isArray(r.content)) return result
    const text = r.content.map(c => c?.type === 'text' && typeof c.text === 'string' ? c.text : '').filter(Boolean).join('\n\n')
    return { ...r, structuredContent: { overview: text } }
}
