import { ingestMessages, type Stored } from '../core/ingestmessages.ts'
import { Worker } from 'node:worker_threads'
import type { JobWork } from '../core/jobs.ts'

type Task = { data: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void; metadata: Record<string,unknown> }
type Slot = { worker: Worker; task?: Task }
/** Reusable workers keep synchronous analytics off the service event loop. */
export class AnalysisWorkerPool {
    private slots: Slot[] = []
    private queue: Task[] = []
    constructor(readonly size = Math.max(1,Math.floor(Number(process.env.LENS_JOB_WORKERS) || 2))) {
        ingestMessages.on('stored', this.onStored)
    }
    private onStored = (message: Stored) => { for (const slot of this.slots) slot.worker.postMessage(message) }
    run(data: unknown): JobWork {
        let task!: Task
        const promise = new Promise((resolve,reject) => { task={data,resolve,reject,metadata:{}}; this.queue.push(task) })
        this.pump()
        return {promise,metadata:()=>task.metadata,cancel:()=>{
            this.queue=this.queue.filter(t=>t!==task)
            const slot=this.slots.find(s=>s.task===task)
            if(slot) this.retire(slot,new Error('Analysis cancelled.'))
            else task.reject(new Error('Analysis cancelled.'))
        }}
    }
    private retire(slot: Slot, error: Error) {
        if(!this.slots.includes(slot)) return
        this.slots=this.slots.filter(s=>s!==slot)
        slot.task?.reject(error); slot.task=undefined
        void slot.worker.terminate()
        this.pump()
    }
    private pump() {
        while(this.queue.length) {
            let slot=this.slots.find(s=>!s.task)
            if(!slot) {
                if(this.slots.length>=this.size) return
                const worker=new Worker(new URL('./jobworker.ts',import.meta.url))
                slot={worker}; this.slots.push(slot)
                const current=slot
                worker.on('message',message=>{
                    const task=current.task
                    if(!task) return
                    current.task=undefined
                    task.metadata={clients:message.clients,publicError:message.publicError}
                    message.error ? task.reject(new Error(message.error)) : task.resolve(message.result)
                    worker.unref();this.pump()
                })
                worker.on('error',error=>this.retire(current,error))
                worker.on('exit',code=>this.retire(current,new Error(`Analysis worker exited (${code}).`)))
            }
            slot.task=this.queue.shift()!; slot.worker.ref();slot.worker.postMessage(slot.task.data)
        }
    }
    close() { ingestMessages.off('stored', this.onStored); const queued=this.queue.splice(0);for(const task of queued)task.reject(new Error('Worker pool closed.'));for(const slot of [...this.slots])this.retire(slot,new Error('Worker pool closed.')) }
}
export const analysisWorkers = new AnalysisWorkerPool()
