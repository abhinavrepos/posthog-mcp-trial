// refreshInsights off the event loop (code review M5): one bounded worker per refresh, with a deadline.
import { Worker } from 'node:worker_threads'
import type { Reach } from './replay-vision-aggregate.ts'

export const REFRESH_LIMITS = Object.freeze({ timeoutMs: 120_000, heapMb: 256 })
export interface RefreshSummary { ok: boolean; scope_key?: string; runs?: number; moments?: number; insights?: number; error?: string }
export function refreshInsightsOffThread(scope: { client?: string | null; user?: string | null }, opts: { now?: Date; reach?: Map<string, Reach> } = {}, timeoutMs = REFRESH_LIMITS.timeoutMs): Promise<RefreshSummary> {
    return new Promise((resolve) => {
        const worker = new Worker(new URL('./replay-vision-refresh-thread.ts', import.meta.url), {
            workerData: { scope, now: (opts.now ?? new Date()).getTime(), reach: opts.reach ? [...opts.reach] : undefined },
            resourceLimits: { maxOldGenerationSizeMb: REFRESH_LIMITS.heapMb }, execArgv: ['--import', 'tsx'],
        })
        let done = false
        const finish = (r: RefreshSummary) => { if (done) return; done = true; clearTimeout(timer); void worker.terminate().catch(() => {}); resolve(r) }
        const timer = setTimeout(() => finish({ ok: false, error: 'refresh_timeout' }), timeoutMs)
        worker.once('message', (m: RefreshSummary) => finish(m))
        worker.once('error', (e) => finish({ ok: false, error: e.message.slice(0, 200) }))
        worker.once('exit', (code) => { if (code !== 0) finish({ ok: false, error: `refresh_exit_${code}` }) })
    })
}
