import { ToolInputError } from '../core/toolinputerror.ts'
import { isPosthogQuery, posthogQueryWork } from './posthog-query.ts'
import { analysisWorkers } from './jobpool.ts'
import { DatabaseSync } from 'node:sqlite'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { toolCorrelationId } from '../core/toolcontext.ts'
import { privacyKey } from '../core/anonymise.ts'
import { JobRunner, runningResult, waitForJob, type JobWork } from '../core/jobs.ts'
import { db } from '../core/db.ts'
import type { ChatCaller } from '../service/access.ts'
import type { TimeWindow } from '../core/timewindow.ts'

export const JOB_TOOLS = new Set(['aggregate_events', 'workflow_completion', 'discover_workflows', 'signal_scorecard', 'describe_app_events', 'message_doctor', 'find_trade','find_sessions', 'top_pains', 'rescue_queue', 'dialog_friction', 'client_signals', 'client_activity_changes', 'compare_client_patterns'])
export const FAST_TOOLS = new Set(['resolve_client','get_replay_link','find_task','list_dashboards','get_job_result','describe_tools','describe_config'])
export function jobBacked(name: string, readOnly: boolean, args: {command?:unknown} = {}) {
    if(name==='posthog_exec') return isPosthogQuery(args.command)
    return readOnly && !FAST_TOOLS.has(name)
}
let runner: JobRunner | undefined
const jobs = () => runner ??= new JobRunner(process.env.LENS_JOBS_DB ? new DatabaseSync(process.env.LENS_JOBS_DB) : db, {
    ttlMs: Number(process.env.LENS_JOB_TTL_SECONDS || 3600) * 1000,
    concurrency: Number(process.env.LENS_JOB_CONCURRENCY || 2),
})
type Caller = Pick<ChatCaller, 'who'> & Partial<Pick<ChatCaller, 'surveyRole' | 'email' | 'dashboardRole' | 'admin' | 'insights'>>
interface Context { name: string; args: Record<string, unknown>; window?: TimeWindow; clients?: string[]; publicError?: boolean; inputError?: boolean }
/** Internal execution envelope. Only the raw callback result is stored in analysis_jobs. */
export class JobAnswer {
    constructor(readonly result: unknown, readonly context: Context, readonly id: string, readonly started = false) {}
}
export interface JobOptions {
    runner?: JobRunner
    budgetMs?: number
    /** Injectable worker factory for deterministic boundary tests; production always uses Worker. */
    work?: (name: string, args: Record<string, unknown>, window: TimeWindow | undefined, execute: () => Promise<unknown>) => JobWork
}
export function createJobDispatch(caller?: Caller, options: JobOptions = {}) {
    const owner = caller?.who || 'stdio'
    const revision = () => JSON.stringify([privacyKey(), caller?.admin || false, caller?.insights || false, caller?.dashboardRole, caller?.surveyRole])
    const work = options.work ?? ((name, args, window) => analysisWorkers.run({ name, args, window, caller, correlationId: toolCorrelationId() }))
    const getRunner = () => options.runner ?? jobs()
    const read = (id: string): JobAnswer => {
        const runner = getRunner(), row = runner.get(owner, id, revision())
        const context = runner.context(row) as Context
        if (context.window) context.window = { ...context.window, from: new Date(context.window.from), to: new Date(context.window.to) }
        if (row.status === 'failed' || row.status === 'cancelled') throw context.inputError ? new ToolInputError(`${context.name}: ${row.error || 'Invalid arguments.'} Call ${context.name} again with corrected arguments.`) : new Error(row.error || 'Analysis job failed.')
        return new JobAnswer(row.status === 'completed' ? runner.result(row) : json(runningResult(id)), context, id, row.status === 'working')
    }
    return {
        read,
        async poll(id: string) {
            await getRunner().poll(owner, id, revision(), Math.min(options.budgetMs ?? 20000, Math.max(0, Number(process.env.LENS_JOB_POLL_WAIT_MS ?? 15000) || 0)))
            return read(id)
        },
        async execute(name: string, args: Record<string, unknown>, window: TimeWindow | undefined, extra: unknown, execute: (context?: {signal: AbortSignal; timeoutMs: number}) => Promise<unknown>) {
            // Policy refusals are immediate: a refused PostHog command never becomes a job handle.
            if (name === 'posthog_exec') {
                const { posthogExecPolicy } = await import('./posthog-proxy.ts')
                const policy = await posthogExecPolicy(String(args.command ?? ''))
                if ('refusal' in policy) return policy.refusal
            }
            const runner = getRunner(), startedRevision = revision(), context = { name, args, window }
            const job = runner.start(owner, name, args, startedRevision, () => name === 'posthog_exec' && isPosthogQuery(args.command) ? posthogQueryWork(execute) : work(name, args, window, execute), runner.ttlMs, context, name === 'posthog_exec')
            await waitForJob(job, extra as never, options.budgetMs)
            if (revision() !== startedRevision) throw new Error('Privacy or access settings changed. Submit the tool again.')
            runner.detach(owner, job.id, startedRevision)
            return read(job.id)
        },
    }
}
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
/** Register through wrapTools; no SDK dispatcher interception or native Tasks handlers. */
export function installJobTools(server: McpServer, dispatch: ReturnType<typeof createJobDispatch>): void {
    server.registerTool('get_job_result', {
        description: 'Wait up to 15 seconds for your analysis job result or running status. Job handles expire after one hour by default. Call this tool directly.',
        inputSchema: { job_id: z.string().regex(/^[0-9a-f]{32}$/) }, annotations: { readOnlyHint: true },
    }, async ({ job_id }) => dispatch.poll(job_id) as never)
}
