import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { toolCorrelationId } from '../core/toolcontext.ts'
const advice = 'narrow the date range, filter to fewer events or properties, or use Lens aggregate_events for counts by period and dimension'
export function posthogFailure(detail: unknown, status?: number, retryAfter?: string | null, correlationId = toolCorrelationId()): Error {
    const raw = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : JSON.stringify(detail)
    // PostHog can report a REST failure inside an MCP error even when MCP HTTP returned 200.
    if (status === undefined) {
        if (/\b429\b|too many requests/i.test(raw)) status = 429
        else if (/\b401\b|unauthorized/i.test(raw)) status = 401
        else if (/\b403\b|forbidden/i.test(raw)) status = 403
    }
    retryAfter ??= /retry[-_ ]after["':=\s]+["']?(\d+)\b/i.exec(raw)?.[1]
    let message = 'PostHog is unavailable. Retry later.'
    if (status === 401 || status === 403) message = "PostHog refused access: check the key's access to this project and tool."
    else if (status === 429) {
        const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? Math.max(1, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)) : NaN
        message = `PostHog is busy: ${Number.isFinite(seconds) ? `retry after ${seconds} seconds` : 'retry later'}.`
    }
    else if (/memory limit|out of memory|too much data|code:\s*241/i.test(raw)) message = `PostHog ran out of memory for this query: ${advice}.`
    else if (/timeout|timed out|TimeoutError/i.test(raw)) message = `PostHog query timed out: ${advice}; it continues as a job if you call it again.`
    errorDiagnostic(detail,'posthog_exec','upstream',correlationId,status)
    return new Error(message)
}
/** Only fixed server-authored messages survive job persistence; never publish upstream diagnostics. */
export function posthogPublicMessage(raw: string): string | undefined {
    if (raw === 'PostHog is busy. Retry later.' || raw === 'PostHog is unavailable. Retry later.' || raw === "PostHog refused access: check the key's access to this project and tool." || /^PostHog is busy: (?:retry after \d+ seconds|retry later)\.$/.test(raw) || raw === `PostHog ran out of memory for this query: ${advice}.` || raw === `PostHog query timed out: ${advice}; it continues as a job if you call it again.`) return raw
}
