import { toolContext } from '../core/toolcontext.ts'
import { ToolInputError } from '../core/toolinputerror.ts'
import { posthogQueryWork } from './posthog-query.ts'
import { DatabaseSync } from 'node:sqlite'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { JobRunner, runningResult, waitForJob, type JobWork } from '../core/jobs.ts'
import { db } from '../core/db.ts'
import type { ChatCaller } from '../service/access.ts'
import type { TimeWindow } from '../core/timewindow.ts'

export const JOB_TOOLS = new Set(['find_sessions','resolve_client','design_survey'])
export const FAST_TOOLS = new Set(['get_replay_link','get_job_result'])
export function jobBacked(name: string, _readOnly: boolean, args: {command?:unknown} = {}) {
    return name === 'posthog_exec' ? !/^\s*(tools|info |schema )/.test(String(args.command)) : JOB_TOOLS.has(name)
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
    const revision = () => JSON.stringify([caller?.admin || false, caller?.insights || false, caller?.dashboardRole, caller?.surveyRole])
    const work: NonNullable<JobOptions['work']> = options.work ?? ((_name, _args, _window, execute) => ({promise: execute()}))
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
            const runner = getRunner(), startedRevision = revision(), context = { name, args, window }
            const state=toolContext.getStore()
            const job = runner.start(owner, name, args, startedRevision, () => {
                const task=name==='posthog_exec' ? posthogQueryWork(execute) : work(name,args,window,execute)
                return {...task,metadata:()=>({...task.metadata?.(),clients:[...(state?.clients || [])],window:state?.window || window})}
            }, runner.ttlMs, context, name==='posthog_exec')
            await waitForJob(job, extra as never, options.budgetMs)
            if (revision() !== startedRevision) throw new Error('Access settings changed. Submit the tool again.')
            runner.detach(owner, job.id, startedRevision)
            return read(job.id)
        },
    }
}
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string,unknown> })
/** Register through wrapTools; no SDK dispatcher interception or native Tasks handlers. */
export function installJobTools(server: McpServer, dispatch: ReturnType<typeof createJobDispatch>): void {
    server.registerTool('get_job_result', {
        description: 'Wait up to 15 seconds for your analysis job result or running status. Job handles expire after one hour by default. Call this tool directly.',
        inputSchema: { job_id: z.string().regex(/^[0-9a-f]{32}$/) }, annotations: { readOnlyHint: true },
    }, async ({ job_id }) => dispatch.poll(job_id) as never)
}
