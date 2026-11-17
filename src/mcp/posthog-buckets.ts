/** Conservative annotations: only explicit absolute bounds and unambiguous calendar bucket tables.
 * This runs before every existing data privacy pass and never changes a returned number. */
export function annotatePosthogBuckets(command: string, result: any): any {
    const match = /^\s*call\s+(?:posthog:)?query-(trends|lifecycle|retention)\s+(\{[\s\S]*\})\s*$/.exec(command)
    if (!match || result?.isError || !Array.isArray(result?.content)) return result
    let args: any
    try { args = JSON.parse(match[2]) } catch { return result }
    const date = (value: unknown): number | undefined => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value)) return
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value.slice(0, 10) ? parsed : undefined
    }
    const from = date(args.dateRange?.date_from), to = date(args.dateRange?.date_to)
    if (from === undefined || to === undefined || from > to) return result
    const day = 86400000
    // A date-only upper bound includes that calendar day; a timestamp is an exact bound.
    const end = to + (args.dateRange.date_to.length === 10 ? day : 0)
    const interval = args.interval || (match[1] === 'retention' ? args.retentionFilter?.period?.toLowerCase() : undefined)
    if (!['day', 'week', 'month'].includes(interval)) return result
    const next = (value: number): number => {
        if (interval !== 'month') return value + day * (interval === 'week' ? 7 : 1)
        const d = new Date(value); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    }
    const tables: number[][] = []
    for (const block of result.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        const lines = block.text.split('\n')
        for (let i = 0; i < lines.length; i++) {
            if (!/^(Date|Day|Bucket)\|/i.test(lines[i])) continue
            const dates: number[] = []
            while (++i < lines.length) {
                const value = date(lines[i].split('|')[0])
                if (value === undefined) break
                dates.push(value)
            }
            if (dates.length >= 3) tables.push(dates)
        }
    }
    if (!tables.length) return result
    const dates = tables[0]
    if (tables.some(t => t.join() !== dates.join())) return result
    // Two interior starts must agree; only the first bucket may start at a clipped range bound.
    if (dates.slice(2).some((value, i) => value !== next(dates[i + 1]))) return result
    if (dates[0] >= dates[1] || dates[1] > next(dates[0])) return result
    if (interval === 'month' && dates.slice(1).some(d => new Date(d).getUTCDate() !== 1)) return result
    if (dates[0] > from || from >= dates[1] || next(dates.at(-1)!) < end || dates.at(-1)! >= end) return result
    const clippedStart = dates[0] === from && (next(dates[0]) !== dates[1] || interval === 'month' && new Date(dates[0]).getUTCDate() !== 1)
    const firstPartial = dates[0] < from || clippedStart
    const lastPartial = end < next(dates.at(-1)!)
    const week = interval === 'week' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(dates[1]).getUTCDay()] : 'n/a'
    const note = `Buckets: interval=${interval}; week start=${week}; partial: ${[firstPartial ? 'first' : '', lastPartial ? 'last' : ''].filter(Boolean).join(', ') || 'none'} (requested range).`
    return { ...result, content: [...result.content, { type: 'text', text: note }] }
}
