/** One disclosure format for retained history; ranges are UTC and end exclusive. */
export type DayStatus = 'complete' | 'pending' | 'truncated' | 'source_expired' | 'before_tracking' | 'query_failed'
export interface DayObservation { day: string; status: DayStatus; detail?: string }
const shift = (s: string) => new Date(Date.parse(s)+86400000).toISOString().slice(0,10)
export function historyCoverage(from: string, to: string, days: DayObservation[], through: string | null, dataset = 'task_history') {
    const ranges: { from: string; to_exclusive: string; reason: DayStatus; detail: string; retryable: boolean }[] = []
    for (const d of days) {
        const detail = d.detail || ({ complete: 'Finalized retained daily statistics', pending: 'Day has not been fully processed', truncated: 'Ingestion hit a safety cap', source_expired: 'Source returned fewer sessions or events than previously retained; retained evidence was preserved', before_tracking: 'Before the first observed project event', query_failed: 'Source query failed; retry required' }[d.status])
        const prev = ranges.at(-1)
        if (prev && prev.reason === d.status && prev.detail === detail && prev.to_exclusive === d.day) prev.to_exclusive = shift(d.day)
        else ranges.push({ from: d.day, to_exclusive: shift(d.day), reason: d.status, detail, retryable: ['pending','query_failed','truncated'].includes(d.status) })
    }
    const covered = ranges.filter(r=>r.reason === 'complete').map(({from,to_exclusive})=>({from,to_exclusive}))
    const missing = ranges.filter(r=>r.reason !== 'complete')
    const coveredDays = days.filter(d=>d.status === 'complete').length
    return { requested: {from,to_exclusive:shift(to),timezone:'UTC'}, answered: covered,
        status: missing.length ? covered.length ? 'partial' : 'unavailable' : 'complete',
        datasets: [{name:dataset,source:'lens_history',covered_ranges:covered,missing_ranges:missing}],
        covered_days: coveredDays, missing_days: days.length-coveredDays,
        comparison: {status:'none' as string,reason:'No comparison requested'},
        freshness:{data_through:through,computed_at:new Date().toISOString()} }
}
export const historyLimits = (returned = 0, omitted = 0) => ({population:'covered_days_only',sample:null,returned_rows:returned,omitted_rows:omitted,examples_only:true,warnings:['Missing days are not zero activity. Replay examples require retained recordings.']})
