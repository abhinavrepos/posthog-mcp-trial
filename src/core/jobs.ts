// Persisted in-process jobs. Work may run in a worker thread so synchronous SQLite/decoding cannot
// prevent the MCP event loop from returning its handle on time. No request abort signal owns a job.
import { randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync, gunzipSync } from 'node:zlib'
export type JobStatus = 'working' | 'completed' | 'failed' | 'cancelled'
export interface JobRow { id: string; owner: string; revision: string; status: JobStatus; created: number; updated: number; expires: number; result: Uint8Array | null; error: string | null }
export interface JobWork { promise: Promise<unknown>; cancel?: () => void; metadata?: () => Record<string, unknown> }
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable)}]` : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',')}}` : JSON.stringify(v) ?? 'null'
export class JobRunner {
    private active = new Map<string, { resolve: (v: unknown) => void; work: () => JobWork; cancel?: () => void; running: boolean; independent: boolean }>()
    private timer: NodeJS.Timeout
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
        db.prepare("UPDATE analysis_jobs SET status='failed', error='Server restarted before this job completed. Submit the tool again.', updated=? WHERE status='working'").run(this.now())
        this.timer = setInterval(() => this.prune(), options.pruneMs ?? 60000); this.timer.unref()
        this.prune()
    }
    private now: () => number
    // independent work supplies its own process-wide concurrency/queue admission (PostHog HTTP).
    start(owner: string, tool: string, args: unknown, revision: string, work: () => JobWork, ttlMs = this.ttlMs, context: unknown = {}, independent = false): { id: string; done: Promise<unknown> } {
        this.prune()
        const serializedContext = JSON.stringify(context)
        const flight = createHash('sha256').update(stable([tool, args, revision, JSON.parse(serializedContext)])).digest('hex')
        const existing = this.db.prepare("SELECT id FROM analysis_jobs WHERE owner=? AND flight=? AND status='working' AND expires>?").get(owner, flight, this.now())
        if (existing) return { id: String(existing.id), done: this.wait(String(existing.id)) }
        const count = Number(this.db.prepare("SELECT count(*) n FROM analysis_jobs WHERE owner=? AND status='working'").get(owner)!.n)
        if (count >= 2) throw new Error('Two analysis jobs are already running for this user. Poll or cancel an existing job first.')
        const id = randomBytes(16).toString('hex'), now = this.now()
        this.db.prepare("INSERT INTO analysis_jobs VALUES (?,?,?,?,'working',?,?,?,?,NULL)").run(id, owner, revision, flight, now, now, now + Math.max(1, Math.min(this.ttlMs, ttlMs)), null)
        this.db.prepare('INSERT INTO analysis_job_context VALUES (?,?)').run(id, serializedContext)
        let resolve!: (v: unknown) => void
        const done = new Promise<unknown>(r => { resolve = r })
        this.active.set(id, { resolve, work, running: false, independent })
        // Always start after the caller has armed its deadline.
        setImmediate(() => this.pump())
        return { id, done }
    }
    private waiters = new Map<string, Promise<unknown>>()
    private wait(id: string): Promise<unknown> {
        let p = this.waiters.get(id)
        if (!p) {
            const active = this.active.get(id)!
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
    close(): void { clearInterval(this.timer); for (const [id, a] of this.active) { a.cancel?.(); this.finish(id, 'failed', undefined, 'Server stopped before this job completed. Submit the tool again.') } }
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
