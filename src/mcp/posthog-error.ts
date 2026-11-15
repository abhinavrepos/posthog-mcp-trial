import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { toolCorrelationId } from '../core/toolcontext.ts'
const advice = 'narrow the date range, filter to fewer events or properties, or use Lens aggregate_events for counts by period and dimension'
export function posthogFailure(detail: unknown, status?: number, retryAfter?: string | null, correlationId = toolCorrelationId()): Error {
    // An MCP tool error arrives as {content:[{type:'text',text}], isError}: match on its text, not escaped JSON.
    const texts = detail && typeof detail === 'object' && Array.isArray((detail as { content?: unknown }).content)
        ? ((detail as { content: { text?: unknown }[] }).content).map(c => typeof c?.text === 'string' ? c.text : '').join('\n') : ''
    const raw = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : texts || JSON.stringify(detail)
    // PostHog can report a REST failure inside an MCP error even when MCP HTTP returned 200.
    if (status === undefined) {
        if (/\b429\b|too many requests/i.test(raw)) status = 429
        else if (/\b401\b|unauthorized/i.test(raw)) status = 401
        else if (/\b403\b|forbidden/i.test(raw)) status = 403
    }
    retryAfter ??= /retry[-_ ]after["':=\s]+["']?(\d+)\b/i.exec(raw)?.[1]
    let message = 'PostHog is unavailable. Retry later.'
    const usage = status === undefined ? posthogUsageMessage(raw) : undefined
    if (usage) message = usage
    else if (status === 401 || status === 403) message = "PostHog refused access: check the key's access to this project and tool."
    else if (status === 429) {
        const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? Math.max(1, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)) : NaN
        message = `PostHog is busy: ${Number.isFinite(seconds) ? `retry after ${seconds} seconds` : 'retry later'}.`
    }
    else if (/memory limit|out of memory|too much data|code:\s*241/i.test(raw)) message = `PostHog ran out of memory for this query: ${advice}.`
    else if (/timeout|timed out|TimeoutError/i.test(raw)) message = `PostHog query timed out: ${advice}; it continues as a job if you call it again.`
    errorDiagnostic(detail,'posthog_exec','upstream',correlationId,status)
    return new Error(message)
}
const USAGE_HELP = 'Run "tools" to list PostHog tools, "info <tool>" for one tool\'s input schema, then "call <tool> <json_input>".'
const TOOL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
/** PostHog's own MCP answers a wrongly formed command with a tool error. Those are the agent's mistakes, not
 * outages: map them to fixed, server-authored corrections instead of "unavailable" (which made agents give up).
 * Upstream text is never echoed, except a SQL error's first line reduced to a strict character set. */
export function posthogUsageMessage(raw: string): string | undefined {
    const tool = /"([a-z0-9-]+)" is a tool, not a command/i.exec(raw)?.[1]
    if (tool && TOOL_NAME.test(tool)) return `PostHog command format: "${tool}" is a tool. Use: call ${tool} <json_input>. ${USAGE_HELP}`
    if (/unknown (?:command|tool)|is not a (?:known )?(?:command|tool)|no such (?:command|tool)/i.test(raw)) return `PostHog does not know that command. ${USAGE_HELP}`
    const sql = /(syntax error|unknown (?:table|field|function|identifier)|unable to resolve field|unknown column)[^"\\]{0,200}/i.exec(raw)?.[0]
    if (sql) return `PostHog could not run the SQL: ${sql.replace(/[^A-Za-z0-9 _.,:()'=<>*-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}. Fix the query and retry.`
    if (/invalid (?:input|arguments?|json)|validation (?:error|failed)|expected [a-z]+, received|required property|is required|unexpected token/i.test(raw)) return `PostHog rejected the input for this command. ${USAGE_HELP}`
}
const usagePublic = (raw: string) =>
    /^PostHog command format: "[a-z0-9-]{1,64}" is a tool\. Use: call [a-z0-9-]{1,64} <json_input>\. /.test(raw) && raw.endsWith(USAGE_HELP)
    || raw === `PostHog does not know that command. ${USAGE_HELP}` || raw === `PostHog rejected the input for this command. ${USAGE_HELP}`
    || /^PostHog could not run the SQL: [A-Za-z0-9 _.,:()'=<>*-]{1,160}\. Fix the query and retry\.$/.test(raw)
export const posthogUsageError = (raw: string) => usagePublic(raw)
/** Only fixed server-authored messages survive job persistence; never publish upstream diagnostics. */
export function posthogPublicMessage(raw: string): string | undefined {
    if (usagePublic(raw)) return raw
    if (raw === 'PostHog is busy. Retry later.' || raw === 'PostHog is unavailable. Retry later.' || raw === "PostHog refused access: check the key's access to this project and tool." || /^PostHog is busy: (?:retry after \d+ seconds|retry later)\.$/.test(raw) || raw === `PostHog ran out of memory for this query: ${advice}.` || raw === `PostHog query timed out: ${advice}; it continues as a job if you call it again.`) return raw
}
