import { renderReport } from '../core/report.ts'
import type { TriageReport } from '../core/triage.ts'
import { aiSafety } from '../core/aisafety.ts'

// Keep the original structure until the registered tool's output boundary.
export const jsonResult = (label: string, value: unknown) => ({
    content: [{ type: 'text' as const, text: label }],
    _lensJson: { label, value },
})
export const reportResult = (report: TriageReport) => ({ content: [{ type: 'text' as const, text: '' }], _lensReport: report })
export async function safeResult(result: unknown): Promise<unknown> {
    const r = result as { _lensReport?: TriageReport; _lensJson?: { label: string; value: unknown }; content?: unknown[] }
    if (r?._lensReport) return { content: [{ type: 'text', text: renderReport(await aiSafety(r._lensReport)) }] }
    if (r?._lensJson) {
        const { _lensJson, ...rest } = r
        const { label, value } = await aiSafety(_lensJson)
        return { ...rest, content: [{ type: 'text', text: label ? `${label}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`` : JSON.stringify(value, null, 2) }] }
    }
    return aiSafety(result)
}
