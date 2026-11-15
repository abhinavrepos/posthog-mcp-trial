/** FIFO among eligible owners: a capped owner never blocks another person's work. */
export function clipInteger(value: string | undefined, fallback: number, max: number): number {
    const n = Number(value)
    return value && Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback
}

export function createClipQueue<T>(render: (key: string) => Promise<T>, options: { concurrency?: number; perUser?: number; timing?: (times: { queuedMs: number; renderMs: number }) => void } = {}) {
    const concurrency = options.concurrency ?? clipInteger(process.env.LENS_CLIP_CONCURRENCY, 5, 8)
    const perUser = Math.min(concurrency, options.perUser ?? clipInteger(process.env.LENS_CLIP_PER_USER, 2, concurrency))
    type Entry = { key: string; owner: string; enqueued: number; started?: number; listeners: (() => void)[]; promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
    const flights = new Map<string, Entry>()
    const queued: Entry[] = []
    const owners = new Map<string, number>()
    let rendering = 0
    function drain() {
        while (rendering < concurrency) {
            const index = queued.findIndex(e => (owners.get(e.owner) ?? 0) < perUser)
            if (index < 0) return
            const e = queued.splice(index, 1)[0]
            rendering++
            owners.set(e.owner, (owners.get(e.owner) ?? 0) + 1)
            e.started = Date.now()
            // Handle synchronous renderer failures as well as rejected promises.
            void Promise.resolve().then(() => {
                for (const notify of e.listeners) notify()
                return render(e.key)
            }).then(value => finish(true, value), error => finish(false, undefined, error))
            function finish(ok: boolean, value?: T, error?: unknown) {
                rendering--
                owners.set(e.owner, owners.get(e.owner)! - 1)
                if (!owners.get(e.owner)) owners.delete(e.owner)
                flights.delete(e.key)
                options.timing?.({ queuedMs: e.started! - e.enqueued, renderMs: Date.now() - e.started! })
                if (!ok) e.reject(error)
                else e.resolve(value as T)
                drain()
            }
        }
    }
    return {
        run(key: string, owner = 'system', onStart?: () => void): Promise<T> {
            const existing = flights.get(key)
            if (existing) {
                if (onStart) {
                    if (existing.started !== undefined) onStart()
                    else existing.listeners.push(onStart)
                }
                return existing.promise
            }
            let resolve!: (value: T) => void
            let reject!: (error: unknown) => void
            const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
            const e: Entry = { key, owner, enqueued: Date.now(), listeners: onStart ? [onStart] : [], promise, resolve, reject }
            flights.set(key, e)
            queued.push(e)
            drain()
            return promise
        },
        stats: () => ({ rendering, queued: queued.length, concurrency }),
    }
}
