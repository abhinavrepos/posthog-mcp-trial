import { JOB_HANDLE_NOTE } from './jobnote.ts'
// Persisted in-process jobs. Work may run in a worker thread so synchronous SQLite/decoding cannot
// prevent the MCP event loop from returning its handle on time. No request abort signal owns a job.
import { ToolInputError } from './toolinputerror.ts'
import { plainReason } from './jobhealth.ts'
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
    constructor(readonly running: string[]) { super(`${running.length} analyses are already running for you (job ids: ${running.join(', ')}). Call get_job_result with one of them until it finishes, then ask again.`) }
}
export class JobQueueError extends Error {
    constructor() { super('Analysis queue is full. Retry later.') }
}
const integerOption = (value: number, fallback: number, minimum: number) => Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback
const sqliteBusy = (error: unknown) => [5, 6].includes(Number((error as { errcode?: number })?.errcode) & 255)
// Timer callbacks: a throw there is an uncaught exception that stops the whole service, and a full disk or a
// read-only file system made every heartbeat throw (a restart loop). Busy is expected; anything else is logged.
const skipBusy = (work: () => void) => { try { work() } catch (error) { if (!sqliteBusy(error)) storageTrouble(error) } }
let lastTrouble = { at: 0, reason: '' }
function storageTrouble(error: unknown): void {
    const reason = plainReason(error)
    if (reason === lastTrouble.reason && Date.now() - lastTrouble.at < 60_000) return // one line a minute, not one per tick
    lastTrouble = { at: Date.now(), reason }
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'analysis jobs: database write failed', reason }))
}
export class JobRunner {
    private active = new Map<string, { resolve: (v: unknown) => void; work: () => JobWork; cancel?: () => void; running: boolean; independent: boolean; retry?: NodeJS.Timeout }>()
    private closed = false
    private timer: NodeJS.Timeout
    private heartbeat: NodeJS.Timeout
    readonly instanceId = randomBytes(16).toString('hex')
    readonly ttlMs: number
    readonly concurrency: number
    readonly perUser: number
    readonly queueLimit: number
    constructor(readonly db: DatabaseSync, options: { ttlMs?: number; concurrency?: number; pruneMs?: number; perUser?: number; queueLimit?: number; now?: () => number } = {}) {
        this.ttlMs = Math.max(1, options.ttlMs ?? 3600000)
        this.concurrency = Math.max(1, options.concurrency ?? 2)
        this.perUser = integerOption(options.perUser ?? Number(process.env.LENS_JOBS_PER_USER ?? 8), 8, 1)
        this.queueLimit = integerOption(options.queueLimit ?? Number(process.env.LENS_JOB_QUEUE ?? 64), 64, 0)
        this.now = options.now ?? Date.now
        db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS analysis_jobs (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision TEXT NOT NULL, flight TEXT NOT NULL,
            status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, expires INTEGER NOT NULL,
            result BLOB, error TEXT);
            CREATE INDEX IF NOT EXISTS analysis_jobs_flight ON analysis_jobs(owner,flight,status);
            CREATE INDEX IF NOT EXISTS analysis_jobs_expiry ON analysis_jobs(expires);
            CREATE TABLE IF NOT EXISTS analysis_job_context (id TEXT PRIMARY KEY, context TEXT NOT NULL);`)
        const columns = new Set(db.prepare('PRAGMA table_info(analysis_jobs)').all().map(r=>r.name))
        if(!columns.has('detached')) db.exec('ALTER TABLE analysis_jobs ADD COLUMN detached INTEGER NOT NULL DEFAULT 0')
        if(!columns.has('owner_instance')) db.exec('ALTER TABLE analysis_jobs ADD COLUMN owner_instance TEXT')
        if(!columns.has('lease_expires')) db.exec('ALTER TABLE analysis_jobs ADD COLUMN lease_expires INTEGER')
        this.heartbeat = setInterval(() => skipBusy(() => { this.renewLease(); this.prune() }), 15000); this.heartbeat.unref()
        this.timer = setInterval(() => skipBusy(() => this.prune()), options.pruneMs ?? 60000); this.timer.unref()
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
        const ordinary = [...this.active.values()].filter(a => !a.independent)
        if (!independent && ordinary.length >= this.concurrency + this.queueLimit) throw new JobQueueError()
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
    /** Only a handle exposed to the caller consumes a detached slot. */
    detach(owner: string, id: string, revision: string): void {
        const row = this.get(owner, id, revision)
        if (row.status !== 'working') return
        const detached = this.db.prepare('SELECT detached FROM analysis_jobs WHERE id=?').get(id)
        if (detached?.detached) return
        const running = this.db.prepare("SELECT id FROM analysis_jobs WHERE owner=? AND status='working' AND detached=1 AND expires>? ORDER BY created").all(owner, this.now()).map(r => String(r.id))
        if (running.length >= this.perUser) {
            // This job has no public handle; do not leave rejected work consuming the queue.
            this.cancel(owner, id, revision)
            throw new JobCapError(running)
        }
        this.db.prepare('UPDATE analysis_jobs SET detached=1 WHERE id=?').run(id)
    }
    async poll(owner: string, id: string, revision: string, waitMs: number): Promise<void> {
        const row = this.get(owner, id, revision)
        if (row.status !== 'working') return
        let timer: NodeJS.Timeout | undefined
        try {
            await Promise.race([this.wait(id), new Promise<void>(resolve => {
                timer = setTimeout(resolve, Math.max(0, Math.min(20000, waitMs, row.expires - this.now())))
            })])
        } finally { if (timer) clearTimeout(timer) }
        this.get(owner, id, revision)
    }
    private waiters = new Map<string, Promise<unknown>>()
    /** Jobs that finished but whose terminal state could not be written (full disk): id → the reason shown. */
    private unsaved = new Map<string, string>()
    private foreignPolls = new Map<string,{timer:NodeJS.Timeout; resolve:(value:unknown)=>void}>()
    private wait(id: string): Promise<unknown> {
        let p = this.waiters.get(id)
        if (!p) {
            const active = this.active.get(id)
            if (!active) {
                p = new Promise(resolve => {
                    const poll = setInterval(() => skipBusy(() => {
                        const row = this.db.prepare('SELECT * FROM analysis_jobs WHERE id=?').get(id) as unknown as JobRow | undefined
                        if (!row || row.expires <= this.now() || row.status !== 'working') { clearInterval(poll); this.foreignPolls.delete(id); this.waiters.delete(id); resolve(row?.status === 'completed' ? this.result(row) : undefined) }
                    }),100)
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
                void work.promise.then(result => this.finish(id, 'completed', result, undefined, work.metadata?.()), error => this.finish(id, 'failed', undefined, String(error?.message || error), { ...work.metadata?.(), inputError: error instanceof ToolInputError || work.metadata?.().inputError === true }))
            } catch (e) { this.finish(id, 'failed', undefined, String((e as Error).message), {inputError: e instanceof ToolInputError}) }
        }
    }
    private finish(id: string, status: JobStatus, result?: unknown, error?: string, metadata?: Record<string, unknown>): void {
        const a = this.active.get(id)
        if (!a) return // cancelled/expired work cannot resurrect a job
        if (a.retry && status !== 'cancelled' && !this.closed) return // cancellation awaiting persistence wins over a late worker reply
        clearTimeout(a.retry)
        a.retry = undefined
        try {
            // Publish the result and its safety metadata together; a busy commit must leave neither visible.
            this.db.exec('SAVEPOINT analysis_job_finish')
            try {
                this.db.prepare("UPDATE analysis_jobs SET status=?,updated=?,result=?,error=? WHERE id=? AND status='working'")
                    .run(status, this.now(), result === undefined ? null : gzipSync(Buffer.from(JSON.stringify(result))), error ?? null, id)
                if (metadata) {
                    const row = this.db.prepare('SELECT context FROM analysis_job_context WHERE id=?').get(id)
                    if (row) this.db.prepare('UPDATE analysis_job_context SET context=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.context)), ...metadata}), id)
                }
                this.db.exec('RELEASE analysis_job_finish')
            } catch (error) {
                // SQLite may already have rolled the whole transaction back itself (a full disk does): then the
                // savepoint is gone, and undoing it again would replace the real reason.
                if (this.db.isTransaction) this.db.exec('ROLLBACK TO analysis_job_finish; RELEASE analysis_job_finish')
                throw error
            }
        } catch (failure) {
            if (sqliteBusy(failure)) {
                // Keep the completed value until SQLite can accept it. Never reject an unobserved .then().
                if (!this.closed) { a.retry = setTimeout(() => { a.retry = undefined; this.finish(id, status, result, error, metadata) }, 100); return }
                // Shutdown cannot keep retrying against a database its caller is about to close. The lease
                // recovery path will mark an unwritten terminal state failed after restart.
            } else {
                // The disk is full, the file system is read-only, or the file is damaged. Throwing here was an
                // unhandled rejection that stopped the service. The caller still waiting gets its answer; a later
                // poll of this id is told why there is no stored result.
                storageTrouble(failure)
                this.unsaved.set(id, `Lens could not store this job's result because ${plainReason(failure)}. Submit the tool again later.`)
            }
        }
        this.active.delete(id); this.waiters.delete(id)
        a.resolve(result ?? { isError: true, content: [{ type: 'text', text: error || 'Job cancelled or expired.' }] })
        if (!this.closed) setImmediate(() => this.pump())
    }
    get(owner: string, id: string, revision: string): JobRow {
        const row = this.db.prepare('SELECT * FROM analysis_jobs WHERE id=? AND owner=? AND expires>?').get(id, owner, this.now()) as unknown as JobRow | undefined
        if (!row) throw new Error('Unknown or expired job id.') // same response for another user's id
        if (row.revision !== revision) throw new Error('Privacy or access settings changed. Submit the tool again.')
        const unsaved = row.status === 'working' && !this.active.has(id) ? this.unsaved.get(id) : undefined
        return unsaved ? { ...row, status: 'failed', error: unsaved } : row
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
        this.db.prepare("UPDATE analysis_jobs SET status='failed', error='Server restarted before this job completed. Submit the tool again.', updated=? WHERE status='working' AND coalesce(lease_expires,0) < ? AND (owner_instance IS NULL OR owner_instance != ?)").run(this.now(), this.now()-60000, this.instanceId)

        for (const [id, a] of this.active) {
            const row = this.db.prepare('SELECT expires FROM analysis_jobs WHERE id=?').get(id)
            if (!row || Number(row.expires) <= this.now()) { a.cancel?.(); this.finish(id, 'cancelled', undefined, 'Job expired.') }
        }
        this.db.prepare('DELETE FROM analysis_jobs WHERE expires<=?').run(this.now())
        for (const id of this.unsaved.keys()) if (!this.db.prepare('SELECT 1 FROM analysis_jobs WHERE id=?').get(id)) this.unsaved.delete(id)
        this.db.exec('DELETE FROM analysis_job_context WHERE id NOT IN (SELECT id FROM analysis_jobs)')
    }
    close(): void {
        this.closed = true
        clearInterval(this.timer); clearInterval(this.heartbeat)
        for(const {timer,resolve} of this.foreignPolls.values()) { clearInterval(timer); resolve(undefined) }
        this.foreignPolls.clear(); this.waiters.clear()
        for (const [id, a] of this.active) {
            a.cancel?.(); this.finish(id, 'failed', undefined, 'Server stopped before this job completed. Submit the tool again.')
        }
    }
}
export function runningResult(id: string) { return { status: 'running', job_id: id, poll_after_seconds: 5, note: JOB_HANDLE_NOTE } }
export async function waitForJob(job: { id: string; done: Promise<unknown> }, extra?: { _meta?: { progressToken?: string | number }; sendNotification?: (notification: unknown) => Promise<unknown> }, budgetMs = 20000, progressMs = 10000): Promise<unknown> {
    let deadline: NodeJS.Timeout | undefined, progress: NodeJS.Timeout | undefined, n = 0
    if (extra?._meta?.progressToken !== undefined && extra.sendNotification) {
        progress = setInterval(() => { void extra.sendNotification!({ method: 'notifications/progress', params: { progressToken: extra._meta!.progressToken, progress: ++n, message: 'Analysis is running' } }).catch(() => {}) }, progressMs)
    }
    try { return await Promise.race([job.done, new Promise(resolve => { deadline = setTimeout(() => resolve({ content: [{ type: 'text', text: JSON.stringify(runningResult(job.id)) }] }), budgetMs) })]) }
    finally { if (deadline) clearTimeout(deadline); if (progress) clearInterval(progress) }
}
