import { isPublicToolError } from './publicerror.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { JobWork } from '../core/jobs.ts'

// Match one static command only: chains, arguments containing commands and every call keep data privacy.
export const isPosthogMetadata = (command: unknown): boolean => typeof command === 'string' && /^[ \t]*(?:tools|(?:info|schema)[ \t]+(?:posthog:)?[\w-]+(?:[ \t]+[\w.$-]+)*)[ \t]*$/i.test(command)

/** Inspect only command/tool names and compute flags, never SQL text. */
export function isPosthogQuery(command: unknown): boolean {
    if (typeof command !== 'string') return false
    return command.split(/[\n;&|]+/).some(part => {
        const match = /^\s*call\s+(?:--[\w-]+\s+)*["'`]?(?:posthog:)?([\w-]+)/i.exec(part)
        if (!match) return false
        const tool = match[1].toLowerCase()
        return tool.startsWith('query-') || tool === 'execute-sql' ||
            /^(?:insight|dashboard)s?-/.test(tool) && (/(?:refresh|compute|query|run|calculate)/.test(tool) || /["']?(?:refresh|force_refresh|forceRefresh|compute)["']?\s*[:=]\s*(?:true|1|["'](?:blocking|async|force))/i.test(part))
    })
}
const positive = (v: string | undefined, fallback: number) => Number.isFinite(Number(v)) && Number(v) > 0 ? Math.max(1, Math.floor(Number(v))) : fallback
export const posthogQueryContext = new AsyncLocalStorage<{ signal: AbortSignal; timeoutMs: number }>()
/** One gate in the service process, shared by every caller/session. Queued work owns no upstream session. */
export class PosthogQueryGate {
    private active = 0
    private queue: { start: () => void; reject: (error: Error) => void; signal: AbortSignal }[] = []
    constructor(readonly cap = positive(process.env.LENS_POSTHOG_MAX_CONCURRENT_QUERIES, 3), readonly maxQueue = positive(process.env.LENS_POSTHOG_MAX_QUEUED_QUERIES, 30)) {}
    async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
        if (signal.aborted) throw new Error('PostHog query cancelled.')
        await new Promise<void>((resolve, reject) => {
            const entry = { signal, reject, start: () => { signal.removeEventListener('abort', abort); this.active++; resolve() } }
            const abort = () => { this.queue = this.queue.filter(x => x !== entry); reject(new Error('PostHog query cancelled.')) }
            if (this.active < this.cap) entry.start()
            else if (this.queue.length >= this.maxQueue) reject(new Error('PostHog is busy. Retry later.'))
            else { this.queue.push(entry); signal.addEventListener('abort', abort, { once: true }) }
        })
        try { return await execute() }
        finally { this.active--; this.queue.shift()?.start() }
    }
}
export const posthogQueryGate = new PosthogQueryGate()
export function posthogQueryWork(execute: (context?: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>): JobWork {
    const controller = new AbortController()
    const timeoutMs = positive(process.env.LENS_POSTHOG_QUERY_TIMEOUT_SECONDS, 600) * 1000
    let publicError = false
    return { promise: posthogQueryGate.run(controller.signal, async () => { const result = await execute({ signal: controller.signal, timeoutMs }); publicError = isPublicToolError(result); return result }), metadata: () => ({ publicError }), cancel: () => controller.abort() }
}
