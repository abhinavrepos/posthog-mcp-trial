import { parentPort } from 'node:worker_threads'
import { ingestMessages } from './ingestmessages.ts'
import { errorDiagnostic } from './errordiagnostics.ts'
import { runIngest, ingestDay } from './tasks.ts'
console.log = console.error
if (process.env.LENS_INGEST_BOOTSTRAP) await (await import(process.env.LENS_INGEST_BOOTSTRAP)).default()
ingestMessages.on('stored', message => parentPort!.postMessage(message))
parentPort!.on('message', async message => {
    try {
        if (message.day) await ingestDay(message.day)
        else await runIngest(message.opts)
        parentPort!.postMessage({ type: 'done' })
    } catch (e) {
        errorDiagnostic(e, 'tasks_ingest_worker')
        // Raw upstream errors must not escape into worker protocol or service logs.
        parentPort!.postMessage({ type: 'failed' })
    }
})
