// Persisted in-process jobs. Work may run in a worker thread so synchronous SQLite/decoding cannot
// prevent the MCP event loop from returning its handle on time. No request abort signal owns a job.
import { randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync, gunzipSync } from 'node:zlib'
export type JobStatus = 'working' | 'completed' | 'failed' | 'cancelled'
export interface JobRow { id: string; owner: string; revision: string; status: JobStatus; created: number; updated: number; expires: number; result: Uint8Array | null; error: string | null; owner_instance?: string | null; lease_expires?: number | null }
export interface JobWork { promise: Promise<unknown>; cancel?: () => void; metadata?: () => Record<string, unknown> }
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable)}]` : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',')}}` : JSON.stringify(v) ?? 'null'
/** The per-user cap was reached. Carries the caller's own running job ids, so the agent can poll them. */
export class JobCapError extends Error {
    constructor(readonly running: string[]) { super(`Two analyses are already running for you (job ids: ${running.join(', ')}). Call get_job_result with one of them until it finishes, then ask again.`) }
}
export class JobRunner {
    private active = new Map<string, { resolve: (v: unknown) => void; work: () => JobWork; cancel?: () => void; running: boolean; independent: boolean }>()
    private timer: NodeJS.Timeout
    private heartbeat: NodeJS.Timeout
    readonly instanceId = randomBytes(16).toString('hex')
    readonly ttlMs: number
    readonly concurrency: number
    constructor(readonly db: DatabaseSync, options: { ttlMs?: number; concurrency?: number; pruneMs?: number; now?: () => number } = {}) {
        this.ttlMs = Math.max(1, options.ttlMs ?? 3600000)
        this.concurrency = Math.max(1, options.concurrency ?? 2)
        this.now = options.now ?? Date.now
        db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS analysis_jobs (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision TEXT NOT NULL, flight TEXT NOT NULL,
            status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, expires INTEGER NOT NULL,
            result BLOB, error TEXT);
            CREATE INDEX IF NOT EXISTS analysis_jobs_flight ON analysis_jobs(owner,flight,status);
            CREATE INDEX IF NOT EXISTS analysis_jobs_expiry ON analysis_jobs(expires);
            CREATE TABLE IF NOT EXISTS analysis_job_context (id TEXT PRIMARY KEY, context TEXT NOT NULL);`)
        const columns = new Set(db.prepare('PRAGMA table_info(analysis_jobs)').all().map(r=>r.name))
        if(!columns.has('owner_instance')) db.exec('ALTER TABLE analysis_jobs ADD COLUMN owner_instance TEXT')
        if(!columns.has('lease_expires')) db.exec('ALTER TABLE analysis_jobs ADD COLUMN lease_expires INTEGER')
        db.prepare("UPDATE analysis_jobs SET status='failed', error='Server restarted before this job completed. Submit the tool again.', updated=? WHERE status='working' AND coalesce(lease_expires,0) < ?").run(this.now(), this.now()-60000)
        this.heartbeat = setInterval(() => this.renewLease(), 15000); this.heartbeat.unref()
        this.timer = setInterval(() => this.prune(), options.pruneMs ?? 60000); this.timer.unref()
        this.prune()
    }
    private now: () => number
    renewLease(): void {
        this.db.prepare("UPDATE analysis_jobs SET lease_expires=? WHERE status='working' AND owner_instance=?").run(this.now()+30000,this.instanceId)
    }
    // independent work supplies its own process-wide concurrency/queue admission (PostHog HTTP).
    start(owner: string, tool: string, args: unknown, revision: string, work: () => JobWork, ttlMs = this.ttlMs, context: unknown = {}, independent = false): { id: string; done: Promise<unknown> } {
        this.prune()
        const serializedContext = JSON.stringify(context)
        const flight = createHash('sha256').update(stable([tool, args, revision, JSON.parse(serializedContext)])).digest('hex')
        const existing = this.db.prepare("SELECT id FROM analysis_jobs WHERE owner=? AND flight=? AND status='working' AND expires>?").get(owner, flight, this.now())
        if (existing) return { id: String(existing.id), done: this.wait(String(existing.id)) }
        const running = (this.db.prepare("SELECT id FROM analysis_jobs WHERE owner=? AND status='working' AND expires>? ORDER BY created").all(owner, this.now()) as { id: string }[]).map(r => String(r.id))
        if (running.length >= 2) throw new JobCapError(running)
        const id = randomBytes(16).toString('hex'), now = this.now()
        this.db.prepare("INSERT INTO analysis_jobs (id,owner,revision,flight,status,created,updated,expires,result,error,owner_instance,lease_expires) VALUES (?,?,?,?,'working',?,?,?,?,NULL,?,?)").run(id, owner, revision, flight, now, now, now + Math.max(1, Math.min(this.ttlMs, ttlMs)), null, this.instanceId, now+30000)
        this.db.prepare('INSERT INTO analysis_job_context VALUES (?,?)').run(id, serializedContext)
        let resolve!: (v: unknown) => void
        const done = new Promise<unknown>(r => { resolve = r })
        this.active.set(id, { resolve, work, running: false, independent })
        // Always start after the caller has armed its deadline.
        setImmediate(() => this.pump())
        return { id, done }
    }
    private waiters = new Map<string, Promise<unknown>>()
    private foreignPolls = new Map<string,{timer:NodeJS.Timeout; resolve:(value:unknown)=>void}>()
    private wait(id: string): Promise<unknown> {
        let p = this.waiters.get(id)
        if (!p) {
            const active = this.active.get(id)
            if (!active) {
                p = new Promise(resolve => {
                    const poll = setInterval(() => {
                        const row = this.db.prepare('SELECT * FROM analysis_jobs WHERE id=?').get(id) as unknown as JobRow | undefined
                        if (!row || row.status !== 'working') { clearInterval(poll); this.foreignPolls.delete(id); this.waiters.delete(id); resolve(row?.status === 'completed' ? this.result(row) : undefined) }
                    },100)
                    this.foreignPolls.set(id,{timer:poll,resolve})
                    poll.unref()
                })
                this.waiters.set(id,p)
                return p
            }
            const old = active.resolve
            p = new Promise(r => { active.resolve = value => { old(value); r(value) } })
            this.waiters.set(id, p)
        }
        return p
    }
    private pump(): void {
        let running = [...this.active.values()].filter(x => x.running && !x.independent).length
        for (const [id, a] of this.active) {
            if (a.running || !a.independent && running >= this.concurrency) continue
            a.running = true; if (!a.independent) running++
            try {
                const work = a.work(); a.cancel = work.cancel
                void work.promise.then(result => this.finish(id, 'completed', result, undefined, work.metadata?.()), error => this.finish(id, 'failed', undefined, String(error?.message || error)))
            } catch (e) { this.finish(id, 'failed', undefined, String((e as Error).message)) }
        }
    }
    private finish(id: string, status: JobStatus, result?: unknown, error?: string, metadata?: Record<string, unknown>): void {
        const a = this.active.get(id)
        if (!a) return // cancelled/expired work cannot resurrect a job
        this.db.prepare("UPDATE analysis_jobs SET status=?,updated=?,result=?,error=? WHERE id=? AND status='working'")
            .run(status, this.now(), result === undefined ? null : gzipSync(Buffer.from(JSON.stringify(result))), error ?? null, id)
        if (metadata) {
            const row = this.db.prepare('SELECT context FROM analysis_job_context WHERE id=?').get(id)
            if (row) this.db.prepare('UPDATE analysis_job_context SET context=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.context)), ...metadata}), id)
        }
        this.active.delete(id); this.waiters.delete(id)
        a.resolve(result ?? { isError: true, content: [{ type: 'text', text: error || 'Job cancelled or expired.' }] })
        setImmediate(() => this.pump())
    }
    get(owner: string, id: string, revision: string): JobRow {
        const row = this.db.prepare('SELECT * FROM analysis_jobs WHERE id=? AND owner=? AND expires>?').get(id, owner, this.now()) as unknown as JobRow | undefined
        if (!row) throw new Error('Unknown or expired job id.') // same response for another user's id
        if (row.revision !== revision) throw new Error('Privacy or access settings changed. Submit the tool again.')
        return row
    }
    context(row: JobRow): unknown {
        const stored = this.db.prepare('SELECT context FROM analysis_job_context WHERE id=?').get(row.id)
        if (!stored) throw new Error('Job context unavailable. Submit the tool again.')
        return JSON.parse(String(stored.context))
    }
    result(row: JobRow): unknown { return row.result ? JSON.parse(gunzipSync(row.result).toString()) : undefined }
    cancel(owner: string, id: string, revision: string): JobRow {
        this.get(owner, id, revision)
        const a = this.active.get(id)
        if (a) { a.cancel?.(); this.finish(id, 'cancelled', undefined, 'Job cancelled.') }
        return this.get(owner, id, revision)
    }
    list(owner: string, revision: string): JobRow[] {
        return this.db.prepare('SELECT * FROM analysis_jobs WHERE owner=? AND revision=? AND expires>? ORDER BY created DESC LIMIT 100').all(owner, revision, this.now()) as unknown as JobRow[]
    }
    prune(): void {
        for (const [id, a] of this.active) {
            const row = this.db.prepare('SELECT expires FROM analysis_jobs WHERE id=?').get(id)
            if (!row || Number(row.expires) <= this.now()) { a.cancel?.(); this.finish(id, 'cancelled', undefined, 'Job expired.') }
        }
        this.db.prepare('DELETE FROM analysis_jobs WHERE expires<=?').run(this.now())
        this.db.exec('DELETE FROM analysis_job_context WHERE id NOT IN (SELECT id FROM analysis_jobs)')
    }
    close(): void {
        clearInterval(this.timer); clearInterval(this.heartbeat)
        for(const {timer,resolve} of this.foreignPolls.values()) { clearInterval(timer); resolve(undefined) }
        this.foreignPolls.clear(); this.waiters.clear()
        for (const [id, a] of this.active) {
            a.cancel?.(); this.finish(id, 'failed', undefined, 'Server stopped before this job completed. Submit the tool again.')
        }
    }
}
export function runningResult(id: string) { return { status: 'running', job_id: id, poll_after_seconds: 5, note: 'Call get_job_result with this job_id' } }
export async function waitForJob(job: { id: string; done: Promise<unknown> }, extra?: { _meta?: { progressToken?: string | number }; sendNotification?: (notification: unknown) => Promise<unknown> }, budgetMs = 20000, progressMs = 10000): Promise<unknown> {
    let deadline: NodeJS.Timeout | undefined, progress: NodeJS.Timeout | undefined, n = 0
    if (extra?._meta?.progressToken !== undefined && extra.sendNotification) {
        progress = setInterval(() => { void extra.sendNotification!({ method: 'notifications/progress', params: { progressToken: extra._meta!.progressToken, progress: ++n, message: 'Analysis is running' } }).catch(() => {}) }, progressMs)
    }
    try { return await Promise.race([job.done, new Promise(resolve => { deadline = setTimeout(() => resolve({ content: [{ type: 'text', text: JSON.stringify(runningResult(job.id)) }] }), budgetMs) })]) }
    finally { if (deadline) clearTimeout(deadline); if (progress) clearInterval(progress) }
}
