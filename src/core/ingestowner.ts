import { Worker } from 'node:worker_threads'
import { config } from './config.ts'
import { stored } from './ingestmessages.ts'
import { errorDiagnostic } from './errordiagnostics.ts'

/** One lazy, reusable worker, independent of the analysis pool. Restart only on the next request. */
export class IngestOwner {
    private worker?: Worker
    private pending?: { resolve: () => void; reject: (e: Error) => void }
    get running() { return !!this.pending }
    run(message: { opts?: { days?: string[]; maxBackfill?: number }; day?: string }): Promise<void> {
        if (this.pending) return Promise.resolve() // existing skip-while-running semantics
        return new Promise<void>((resolve, reject) => {
            this.pending = { resolve, reject }
            try {
                if (!this.worker) {
                    const worker = new Worker(new URL('./ingestworker.ts', import.meta.url), {
                        resourceLimits: { maxOldGenerationSizeMb: config.tasks.workerMemoryMb },
                    })
                    this.worker = worker
                    const fail = (error: Error) => {
                        if (this.worker !== worker) return
                        this.worker = undefined
                        errorDiagnostic(error, 'tasks_ingest_worker')
                        stored({ type: 'stored', days: [], kinds: ['cleanup'] })
                        this.finish(new Error('Task history worker stopped.'))
                        void worker.terminate()
                    }
                    worker.on('error', fail)
                    worker.on('exit', code => fail(new Error(`Task history worker exited (${code}).`)))
                    worker.on('message', result => {
                        if (result.type === 'stored') stored(result)
                        else if (result.type === 'done') this.finish()
                        else if (result.type === 'failed') this.finish(new Error('Task history ingestion failed.'))
                    })
                }
                this.worker.ref()
                this.worker.postMessage(message)
            } catch (e) { this.finish(e instanceof Error ? e : new Error('Task history worker failed.')) }
        })
    }
    private finish(error?: Error) {
        const pending = this.pending
        this.pending = undefined
        this.worker?.unref()
        if (error) pending?.reject(error)
        else pending?.resolve()
    }
    async close() {
        const worker = this.worker
        this.worker = undefined
        this.finish(new Error('Task history worker closed.'))
        await worker?.terminate()
    }
}
export const ingestOwner = new IngestOwner()
