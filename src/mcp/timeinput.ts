import { ToolInputError } from '../core/toolinputerror.ts'
import { z } from 'zod'
import { parseTimeWindow, type TimeWindow } from '../core/timewindow.ts'

export { PERIODS } from '../core/timewindow.ts'
import { PERIODS } from '../core/timewindow.ts'
export const TIME_HELP = 'Use window: {"last":"24h"} or {"last":"7d"} (rolling, ending now; the default kind), {"day":"2026-11-24"} (one UTC day) or {"from":"2026-11-01","to":"2026-11-24"} (inclusive UTC dates). Every window ends at the latest at now.'
export const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s, 'Use a real UTC date').refine(s => s <= new Date().toISOString().slice(0,10), 'Dates cannot be in the future')
const lastPattern = /^(\d{1,5})([hd])$/
/** The one time argument: rolling {last}, one UTC {day}, or inclusive UTC dates {from,to}. Strings "24h", "7d" and "YYYY-MM-DD" are shorthands. */
export const windowArg = z.union([
    z.object({ last: z.string().regex(lastPattern, { error: 'last is a number of hours or days, e.g. "24h" or "7d"' }) }).strict(),
    z.object({ day: utcDate }).strict(),
    z.object({ from: utcDate, to: utcDate }).strict(),
    z.string().regex(/^(\d{1,5}[hd]|\d{4}-\d{2}-\d{2})$/, { error: 'Use {"last":"7d"}, {"day":"2026-11-24"} or {"from":"2026-11-01","to":"2026-11-24"}' }),
], { error: 'window is {"last":"24h"|"7d"}, {"day":"YYYY-MM-DD"} or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}' })
    .describe('Time window. {"last":"24h"} or {"last":"7d"}: rolling, ending now (default kind; "last 7 days" means this). {"day":"2026-11-24"}: one UTC day. {"from":"2026-11-01","to":"2026-11-24"}: inclusive UTC dates. Clamped to now.')
export type WindowArg = z.infer<typeof windowArg>
export const timeShape = {
    window: windowArg.optional(),
    period: z.enum(PERIODS).optional().describe('Alias kept for old callers: named calendar-anchored UTC window. Prefer window.'),
    from: utcDate.optional().describe('Inclusive UTC start date (YYYY-MM-DD); requires to.'),
    to: utcDate.optional().describe('Inclusive UTC end date (YYYY-MM-DD); requires from.'),
    when: z.string().optional().describe('Deprecated: use period or from/to. Legacy natural-language window.'),
    compare: z.enum(['previous','none']).optional().describe('Compare with the previous equally long window, or no comparison.'),
    compare_from: utcDate.optional(), compare_to: utcDate.optional(),
    compare_with: z.object({ from: utcDate, to: utcDate }).optional().describe('Deprecated: use compare_from/compare_to.'),
    compared_with: z.string().optional().describe('Deprecated: use compare_from/compare_to.'),
}
export function checkTime(input: Record<string, unknown>, ctx: z.RefinementCtx): void {
    const issue = (message: string) => ctx.addIssue({code:'custom',message})
    const pair = (a: unknown, b: unknown) => {
        if ((a === undefined) !== (b === undefined)) issue('Give both from and to dates. ' + TIME_HELP)
        if (typeof a === 'string' && typeof b === 'string' && (a > b || (Date.parse(b)-Date.parse(a))/86400000+1 > 1500)) issue('Use ordered dates spanning at most 1500 inclusive days. ' + TIME_HELP)
    }
    pair(input.from,input.to); pair(input.compare_from,input.compare_to)
    const old = input.compare_with as {from?:string;to?:string}|undefined
    if(old) pair(old.from,old.to)
    if ([input.window !== undefined, input.period !== undefined, input.from !== undefined || input.to !== undefined, input.when !== undefined].filter(Boolean).length > 1) issue('Give one time argument: window (or the older period, from/to or when), not several. ' + TIME_HELP)
    const custom = [input.compare_from !== undefined || input.compare_to !== undefined, !!old, input.compared_with !== undefined].filter(Boolean).length
    if(custom > 1 || (custom && input.compare !== undefined)) issue('Choose compare OR one comparison date range, not both.')
    if ((input.window || input.period || input.from || input.when) && (input.days !== undefined || input.weeks !== undefined)) issue('Choose window instead of also giving days/weeks.')
}
export const timeInput = z.object(timeShape).superRefine(checkTime)
/** The resolved window as every result reports it. */
export const windowContext = (w: TimeWindow) => ({ from: w.from.toISOString(), to: w.to.toISOString(), kind: w.kind ?? 'range', label: w.label, ...(w.clamped ? { clamped_to_now: true } : {}) })
export const inclusiveWindow = (w: TimeWindow) => ({from:w.from.toISOString().slice(0,10),to:new Date(+w.to-1).toISOString().slice(0,10)})
const HOUR = 3_600_000, DAY = 86_400_000
function fromWindow(arg: WindowArg, now: Date): TimeWindow {
    const v = typeof arg === 'string' ? (lastPattern.test(arg) ? { last: arg } : { day: arg }) : arg
    if ('last' in v) {
        const [, n, unit] = lastPattern.exec(v.last)!, ms = Number(n) * (unit === 'h' ? HOUR : DAY)
        if (!ms || ms > 1500 * DAY) throw new ToolInputError('window.last must be between 1h and 1500d. ' + TIME_HELP)
        return { from: new Date(+now - ms), to: now, label: `last ${n}${unit} (rolling, ending now)`, precision: 'range', kind: 'rolling' }
    }
    if ('day' in v) { const from = new Date(v.day); return { from, to: new Date(+from + DAY), label: `UTC day ${v.day}`, precision: 'day', kind: 'day' } }
    const from = new Date(v.from), to = new Date(+new Date(v.to) + DAY)
    if (+to <= +from || (+to - +from) / DAY > 1500) throw new ToolInputError('window.from must be on or before window.to, at most 1500 days apart. ' + TIME_HELP)
    return { from, to, label: `UTC dates ${v.from} to ${v.to} inclusive`, precision: 'range', kind: 'range' }
}
/** No window ends after now: data stamped later (clock skew, test loads) is never counted. */
export function clampToNow(w: TimeWindow, now = new Date()): TimeWindow {
    if (+w.from >= +now) throw new ToolInputError(`The window starts at ${w.from.toISOString()}, after now: there is no data yet. ` + TIME_HELP)
    return +w.to > +now ? { ...w, to: now, clamped: true } : w
}
export function resolveTime(input: Record<string, unknown>, fallback: number|string = 7): TimeWindow {
    // A ZodError would lose its kind crossing a job boundary (job-backed tools report it as internal): say what to fix.
    const checked = timeInput.safeParse(input)
    if (!checked.success) throw new ToolInputError([...new Set(checked.error.issues.map(i => i.message.replace(TIME_HELP, '').trim()))].slice(0, 3).join(' ') + ' ' + TIME_HELP)
    const now = new Date()
    if (input.window !== undefined) return clampToNow(fromWindow(input.window as WindowArg, now), now)
    const kind: TimeWindow['kind'] = input.period ? 'named' : input.from ? 'range' : input.when ? 'named' : 'rolling'
    const text = input.period ? String(input.period) : input.from ? `${input.from} to ${input.to}` : input.when ? String(input.when) : input.days || input.weeks ? `last ${input.days || Number(input.weeks)*7} days` : typeof fallback === 'string' ? fallback : `last ${fallback} days`
    let w: TimeWindow
    try { w = parseTimeWindow(text, now, (input.period || input.from) ? undefined : input.timezone as string|undefined) }
    catch { throw new ToolInputError('Invalid time arguments. ' + TIME_HELP) }
    return clampToNow({ ...w, kind: w.kind ?? kind }, now)
}
