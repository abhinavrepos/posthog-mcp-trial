import { ToolInputError } from '../core/toolinputerror.ts'
import { z } from 'zod'
import { parseTimeWindow, type TimeWindow } from '../core/timewindow.ts'

export { PERIODS } from '../core/timewindow.ts'
import { PERIODS } from '../core/timewindow.ts'
export const TIME_HELP = `Use period: ${PERIODS.join(', ')}; or inclusive UTC dates from/to (YYYY-MM-DD), e.g. {"from":"2024-11-01","to":"2025-11-30"}.`
export const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s, 'Use a real UTC date').refine(s => s <= new Date().toISOString().slice(0,10), 'Dates cannot be in the future')
export const timeShape = {
    period: z.enum(PERIODS).optional().describe('Named UTC window. Relative windows end on dataThrough; today/yesterday are literal days.'),
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
    if ([input.period !== undefined, input.from !== undefined || input.to !== undefined, input.when !== undefined].filter(Boolean).length > 1) issue('Give exactly one of period, from/to, or deprecated when. ' + TIME_HELP)
    const custom = [input.compare_from !== undefined || input.compare_to !== undefined, !!old, input.compared_with !== undefined].filter(Boolean).length
    if(custom > 1 || (custom && input.compare !== undefined)) issue('Choose compare OR one comparison date range, not both.')
    if ((input.period || input.from || input.when) && (input.days !== undefined || input.weeks !== undefined)) issue('Choose period or from/to instead of also giving days/weeks.')
}
export const timeInput = z.object(timeShape).superRefine(checkTime)
export const inclusiveWindow = (w: TimeWindow) => ({from:w.from.toISOString().slice(0,10),to:new Date(+w.to-1).toISOString().slice(0,10)})
export function resolveTime(input: Record<string, unknown>, fallback: number|string = 7): TimeWindow {
    const text = input.period ? String(input.period) : input.from ? `${input.from} to ${input.to}` : input.when ? String(input.when) : input.days || input.weeks ? `last ${input.days || Number(input.weeks)*7} days` : typeof fallback === 'string' ? fallback : `last ${fallback} days`
    try { return parseTimeWindow(text, new Date(), (input.period || input.from) ? undefined : input.timezone as string|undefined) }
    catch { throw new ToolInputError('Invalid time arguments. ' + TIME_HELP) }
}
