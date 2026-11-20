import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { toolCorrelationId } from '../core/toolcontext.ts'
const advice = 'narrow the date range, filter to fewer events or properties, or query one bounded period at a time with posthog_exec'
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
    const usage = status === undefined || status === 400 || status === 422 ? posthogUsageMessage(raw) : undefined
    if (usage) message = usage
    else if (status === 401 || status === 403) message = "PostHog refused access: check the key's access to this project and tool."
    else if (status === 429) {
        const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? Math.max(1, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)) : NaN
        message = `PostHog is busy: ${Number.isFinite(seconds) ? `retry after ${seconds} seconds` : 'retry later'}.`
    }
    else if (/memory limit|out of memory|too much data|code:\s*241/i.test(raw)) message = `PostHog ran out of memory for this query: ${advice}.`
    // PostHog's own server-side limit: calling again repeats it, so steer to a smaller query or Lens's rollups.
    else if (/max execution time|max_execution_time|TIMEOUT_EXCEEDED|code:\s*159|\b504\b|gateway time-?out/i.test(raw)) message = POSTHOG_LIMIT
    else if (/timeout|timed out|TimeoutError/i.test(raw)) message = `PostHog query timed out: ${advice}; it continues as a job if you call it again.`
    errorDiagnostic(detail,'posthog_exec','upstream',correlationId,status)
    return new Error(message)
}
/** PostHog stopped the query at its own time limit (it scans too much data for one request on this server). */
export const POSTHOG_LIMIT = 'PostHog stopped this query at its own time limit; repeating it will not help. Query a shorter range (for example one quarter at a time) or add filters. Use posthog_exec for each bounded period, then combine the returned data.'
const USAGE_HELP = 'Run "tools" to list PostHog tools, "info <tool>" for one tool\'s input schema, then "call <tool> <json_input>".'
export const TRENDS_CORRECTION = 'For query-trends use breakdownFilter.breakdowns: [{property: <property>, type: "event"}], not breakdownFilter.breakdown_type.'
const TOOL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
/** PostHog's own MCP answers a wrongly formed command with a tool error. Those are the agent's mistakes, not
 * outages: map them to fixed, server-authored corrections instead of "unavailable" (which made agents give up).
 * Upstream prose and rejected values are never echoed; only structured schema facts are published. */
export function posthogUsageMessage(raw: string): string | undefined {
    const tool = /"([a-z0-9-]+)" is a tool, not a command/i.exec(raw)?.[1]
    if (tool && TOOL_NAME.test(tool)) return `PostHog command format: "${tool}" is a tool. Use: call ${tool} <json_input>. ${USAGE_HELP}`
    if (/unknown (?:command|tool)|is not a (?:known )?(?:command|tool)|no such (?:command|tool)/i.test(raw)) return `PostHog does not know that command. ${USAGE_HELP}`
    const validation = validationDetails(raw)
    if (validation || /invalid (?:input|arguments?|json)|validation[_ ](?:error|failed)|expected [a-z]+, received|required property|is required|unexpected token/i.test(raw)) return `PostHog rejected the input for this command. ${validation}${USAGE_HELP}`
    const sql = /(syntax error|unknown (?:table|field|function|identifier)|unable to resolve field|unknown column|illegal type|illegal_type_of_argument|number of arguments|no such column|cannot convert|type mismatch|there is no supertype|missing columns|not an aggregate function|aggregate function .{0,40}is found inside)[^"\\]{0,200}/i.exec(raw)?.[0]
    // The first line names the field or function the agent wrote ("Unable to resolve field dialog"): it is what makes
    // the retry right. Reduced to a strict character set and 160 characters, as before.
    // Quoted literals can carry values ('Acme Ltd', a user id): blanked. Names of fields and functions stay.
    if (sql) return `PostHog could not run the SQL: ${sql.replace(/'[^']*'?/g, "'…'").replace(/[^A-Za-z0-9 _.,:()'=<>*…-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}. Fix the query and retry.`
}
const usagePublic = (message: string): boolean => {
    const raw = message.endsWith(' ' + TRENDS_CORRECTION) ? message.slice(0, -TRENDS_CORRECTION.length - 1) : message
    const suggestions = / Closest tools: [a-z0-9-]{1,64}(?:, [a-z0-9-]{1,64}){0,2}\.$/.exec(raw)
    if (suggestions) return raw.slice(0, suggestions.index) === `PostHog does not know that command. ${USAGE_HELP}`
    return /^PostHog command format: "[a-z0-9-]{1,64}" is a tool\. Use: call [a-z0-9-]{1,64} <json_input>\. /.test(raw) && raw.endsWith(USAGE_HELP)
    || raw === `PostHog does not know that command. ${USAGE_HELP}` || validDetailedUsage(raw)
    || /^PostHog could not run the SQL: [A-Za-z0-9 _.,:()'=<>*…-]{1,160}\. Fix the query and retry\.$/.test(raw)
}
export const posthogUsageError = (raw: string) => usagePublic(raw)
/** Only fixed server-authored messages survive job persistence; never publish upstream diagnostics. */
export function posthogPublicMessage(raw: string): string | undefined {
    if (usagePublic(raw) || raw === POSTHOG_LIMIT) return raw
    if (raw === 'PostHog is busy. Retry later.' || raw === 'PostHog is unavailable. Retry later.' || raw === "PostHog refused access: check the key's access to this project and tool." || /^PostHog is busy: (?:retry after \d+ seconds|retry later)\.$/.test(raw) || raw === `PostHog ran out of memory for this query: ${advice}.` || raw === `PostHog query timed out: ${advice}; it continues as a job if you call it again.`) return raw
}

// Read structured validator issues only. Free-form messages and received/input/value are private.
function validationDetails(raw: string): string {
    raw = raw.slice(0, 64_000)
    let attempts = 0
    const issues: Record<string, unknown>[] = []
    const visit = (v: unknown, depth = 0): void => {
        if (depth > 12 || !v) return
        if (Array.isArray(v)) { for (const x of v.slice(0, 30)) visit(x, depth + 1); return }
        if (typeof v === 'string') { scan(v, depth + 1); return }
        if (typeof v !== 'object') return
        const r = v as Record<string, unknown>
        if (Array.isArray(r.path) && typeof r.code === 'string') issues.push(r)
        for (const key of ['issues', 'errors', 'error', 'detail', 'message', 'unionErrors']) visit(r[key], depth + 1)
    }
    // MCP prefixes a JSON issue array with "Invalid input ...". Find complete JSON, not message prose.
    const scan = (text: string, depth = 0): void => {
        if (depth > 12) return
        for (let i = 0; i < text.length && attempts < 64; i++) if (text[i] === '[' || text[i] === '{') {
            const endChar = text[i] === '[' ? ']' : '}'
            for (let j = text.lastIndexOf(endChar); j > i && attempts++ < 64; j = text.lastIndexOf(endChar, j - 1)) {
                try { visit(JSON.parse(text.slice(i, j + 1)), depth + 1); break } catch {}
            }
            if (issues.length) break
        }
    }
    scan(raw)
    const parts = issues.flatMap(r => {
        const segments = r.path as unknown[]
        if (segments.some(x => typeof x === 'number' ? !Number.isSafeInteger(x) || x < 0 : typeof x !== 'string' || !/^[A-Za-z_$][\w$-]{0,63}$/.test(x))) return []
        const path = segments.join('.') || 'input'
        if (path.length > 200) return []
        if (r.code === 'invalid_type' && typeof r.expected === 'string' && /^(?:string|number|integer|boolean|object|array|null|undefined|date)$/.test(r.expected))
            return [`${path}: expected ${r.expected}${r.received === 'undefined' ? ' (required)' : ''}.`]
        const values = r.options ?? r.values
        if ((r.code === 'invalid_enum_value' || r.code === 'invalid_value') && Array.isArray(values) && values.length && values.length <= 40 && values.every(x => typeof x === 'string' && /^[A-Za-z_$][\w$-]{0,63}$/.test(x)))
            return [`${path}: allowed ${values.join(', ')}.`]
        if (r.code === 'unrecognized_keys') return [`${path}: remove unsupported fields.`]
        return []
    })
    return [...new Set(parts)].slice(0, 6).join(' ') + (parts.length ? ' ' : '')
}
function validDetailedUsage(raw: string): boolean {
    const prefix = 'PostHog rejected the input for this command. '
    if (!raw.startsWith(prefix) || !raw.endsWith(USAGE_HELP)) return false
    const detail = raw.slice(prefix.length, -USAGE_HELP.length)
    return detail === '' || /^(?:[A-Za-z_$][\w$.-]{0,199}: (?:expected (?:string|number|integer|boolean|object|array|null|undefined|date)(?: \(required\))?|allowed [A-Za-z_$][\w$-]*(?:, [A-Za-z_$][\w$-]*)*|remove unsupported fields)\. ){1,6}$/.test(detail)
}
