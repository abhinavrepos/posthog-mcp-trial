import { ToolInputError } from '../core/toolinputerror.ts'
export { ToolInputError } from '../core/toolinputerror.ts'
import { ClipQueueError } from '../core/clip-queue.ts'
import { JobCapError, JobQueueError } from '../core/jobs.ts'
import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { posthogPublicMessage, posthogFailure, posthogUsageError } from './posthog-error.ts'
import { RescueInputError } from '../core/rescue.ts'
import { toolCorrelationId } from '../core/toolcontext.ts'
import { z } from 'zod'
import { RateLimitError } from './ratelimit.ts'
import { TIME_HELP } from './timeinput.ts'
export class ToolValidationError extends Error {}
export function toolError(error: unknown, tool: string, id: string = toolCorrelationId(), contract?: {keys:string[];example:unknown}) {
    const raw = error instanceof Error ? error.message : String(error)
    let kind='internal', message='The tool could not complete. Retry later; if it persists, give the correlation id to a Lens administrator.'
    if(posthogPublicMessage(raw)) {kind=posthogUsageError(raw) ? 'validation' : /memory|timed out|time limit/.test(raw) ? 'capacity' : 'unavailable';message=raw}
    else if(tool==='posthog_exec' && /memory limit|too much data|code:\s*241|timeout|timed out/i.test(raw)) {kind='capacity';message=posthogFailure(error).message}
    else if(error instanceof RateLimitError) {kind='rate_limit';message=raw}
    else if(error instanceof JobCapError || error instanceof JobQueueError || error instanceof ClipQueueError) {kind='busy';message=error.message}
    else if(raw === 'Unknown or expired job id.') {kind='not_found';message=raw}
    else if(raw === 'Privacy or access settings changed. Submit the tool again.') {kind='privacy_changed';message=raw}
    else if(error instanceof z.ZodError) {
        kind='validation'
        // Never echo input values or unknown property names, which may contain identities.
        const issues=error.issues.map(i=>{
            const key=contract?.keys.includes(String(i.path[0])) ? `${String(i.path[0])}: ` : ''
            const detail=i.code==='custom' ? i.message
                : i.code==='invalid_type' ? `expected ${i.expected}.`
                : i.code==='invalid_value' ? `use one of ${i.values.map(String).join(', ')}.`
                : i.code==='too_big' ? `maximum ${i.maximum}.`
                : i.code==='too_small' ? `minimum ${i.minimum}.`
                : i.code==='unrecognized_keys' ? 'Remove unsupported argument keys.'
                : 'Use the documented format.'
            return key+detail
        }).slice(0,4).join(' ')
        message=`Invalid arguments for ${tool}: ${issues} Example: ${JSON.stringify(contract?.example || {period:'last_7_days'})}. ` + (contract?.keys.includes('period') ? TIME_HELP : 'See the tool input schema for required arguments.')

    }
    else if(error instanceof RescueInputError) {kind='validation';message=raw + ' Example: ' + JSON.stringify({client:'client-id from resolve_client',status:'expected',snooze_until:new Date(Date.now()+86400000).toISOString().slice(0,10)})}
    else if(error instanceof ToolInputError) {kind='validation';message=raw + (contract && tool !== 'get_job_result' ? ' Example: ' + JSON.stringify(contract.example) + '. ' + (contract.keys.includes('period') && !raw.includes(TIME_HELP) ? TIME_HELP : '') : '')}
    else if(error instanceof ToolValidationError || /invalid time window|unrecognised time window|dates must|ordered window|invalid relative window/i.test(raw)) {kind='validation';message='Invalid time arguments. ' + TIME_HELP}
    else if(/memory|timeout|timed out|too large|limit exceeded|code: 241/i.test(raw)) {kind='capacity';message='The window or grouping is too large for a single call. Use a narrower window, a coarser bucket (month instead of week), or fewer group_by dimensions.'}
    else if(/not in the kept releases/i.test(raw)) {kind='not_found';message='The ticket is not in the kept releases. Call list_releases, then ticket_evidence for a valid ticket key.'}
    else if(/not found|no (?:unambiguous )?client matches|no screen matches|unknown (client|task|survey|workflow)/i.test(raw)) {kind='not_found';message='The requested item was not found. Call resolve_client for client ids, find_task for task ids, discover_workflows for workflows, or list_surveys for survey ids, then retry.'}
    else if(/posthog|fetch failed|econn|unavailable|503|502|429|queue is busy/i.test(raw)) {kind='unavailable';message='PostHog is unavailable or busy. Retry later.'}
    else if(/history is still being built/i.test(raw)) {kind='unavailable';message='Task history is still being built. Retry shortly; the Dashboards page shows progress.'}
    errorDiagnostic(error,tool,kind,id)
    return {kind,id,result:{isError:true,content:[{type:'text' as const,text:`${message} Correlation id: ${id}`}]}}
}

/** Build a value-only example from server-authored JSON Schema, never from rejected user input. */
export function argumentExample(schema: Record<string,unknown>, key=''): unknown {
    if(schema.default !== undefined)return schema.default
    if(Array.isArray(schema.enum))return schema.enum[0]
    if(schema.const !== undefined)return schema.const
    const alternatives=schema.anyOf || schema.oneOf
    if(Array.isArray(alternatives))return argumentExample(alternatives[0] as Record<string,unknown>,key)
    if(schema.type==='object') {
        const props=(schema.properties || {}) as Record<string,Record<string,unknown>>
        const required=(schema.required || []) as string[]
        const keys=required.length ? required : 'period' in props ? ['period'] : []
        return Object.fromEntries(keys.map(k=>[k,k==='period' ? 'last_7_days' : argumentExample(props[k],k)]))
    }
    if(schema.type==='array')return Array.from({length:Math.max(1,Number(schema.minItems)||1)},()=>argumentExample((schema.items || {}) as Record<string,unknown>))
    if(schema.type==='number' || schema.type==='integer')return Math.max(1,Number(schema.minimum)||0)
    if(schema.type==='boolean')return false
    if(key==='session_id')return '01a19b90-8c82-7185-ba5a-8333dd59c200'
    if(['from','to','compare_from','compare_to'].includes(key))return '2024-11-01'
    if(key==='trade')return '12345'
    if(key==='email')return 'pm@example.com'
    if(key==='when')return 'last 7 days'
    return 'example'
}
