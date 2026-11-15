import { renderReport } from '../core/report.ts'
import type { TriageReport } from '../core/triage.ts'
import { aiSafety } from '../core/aisafety.ts'

// Keep the original structure until the registered tool's output boundary.
export const jsonResult = (label: string, value: unknown) => ({
    content: [{ type: 'text' as const, text: label }],
    _lensJson: { label, value },
})
export const reportResult = (report: TriageReport) => ({ content: [{ type: 'text' as const, text: '' }], _lensReport: report })
// Computed fractions (151.21259859888426, 38.06250000000001) cost tokens and suggest a precision the data does
// not have: four significant digits, whole numbers from 1,000. Integers (counts, ids, epoch times) are untouched.
const roundNumbers = (_key: string, v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) ? (Math.abs(v) >= 1000 ? Math.round(v) : Number(v.toPrecision(4))) : v
export async function safeResult(result: unknown): Promise<unknown> {
    const r = result as { _lensReport?: TriageReport; _lensJson?: { label: string; value: unknown }; content?: unknown[] }
    if (r?._lensReport) return { content: [{ type: 'text', text: renderReport(await aiSafety(r._lensReport)) }] }
    if (r?._lensJson) {
        const { _lensJson, ...rest } = r
        const { label, value } = await aiSafety(_lensJson)
        return { ...rest, content: [{ type: 'text', text: label ? `${label}\n\n\`\`\`json\n${JSON.stringify(value, roundNumbers, 2)}\n\`\`\`` : JSON.stringify(value, roundNumbers, 2) }] }
    }
    return aiSafety(result)
}
