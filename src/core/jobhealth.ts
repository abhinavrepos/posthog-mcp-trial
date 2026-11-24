// How Lens's own background jobs are doing: task history, replay analysis, the Watchlist, replay retention,
// briefing delivery, the chat pre-warm. Each job reports here after every round; the System page shows the
// result (through /health and the status service), and the service log gets one clear line whenever a job
// starts failing or recovers, not one per round.
//
// Everything is in memory: nothing is queried to produce it. Reasons are rewritten into plain words and
// never carry query text, URLs or addresses.
export type JobLevel = 'ok' | 'warn' | 'down' | 'waiting'
export interface JobState {
    key: string; label: string; level: JobLevel; reason: string | null
    last_ok_at: string | null; last_error_at: string | null; since: string; detail: string | null
}
interface Job { label: string; everyMs: number; ok?: number; err?: number; reason?: string; detail?: string; failures: number; since: number; started: number }

const jobs = new Map<string, Job>()
const log = (msg: string, extra: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))
const ago = (ms: number) => ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`

/** A job that runs every `everyMs`: it shows as waiting until its first round. */
export function registerJob(key: string, label: string, everyMs: number): void {
    if (!jobs.has(key)) jobs.set(key, { label, everyMs, failures: 0, since: Date.now(), started: Date.now() })
}

/** The error as a person would say it: what went wrong, without query text, URLs or addresses. */
export function plainReason(e: unknown): string {
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    const m = raw.toLowerCase()
    // The status travels on the error, or only in its text ("PostHog POST /api/projects/1/query/ → 401: …") once
    // it has been stored (task history keeps the message) or crossed a worker thread.
    const status = Number((e as { status?: number })?.status) || Number(/\b(?:http|status)[^0-9]{0,3}([1-5]\d\d)\b/i.exec(raw)?.[1])
        || Number(/^(?:\w*Error: )?PostHog [A-Z]+ \S+ → ([1-5]\d\d)\b/.exec(raw)?.[1]) || 0
    const missing = /PostHog is not configured: set ([A-Z0-9_]+(?:, [A-Z0-9_]+)*)/.exec(raw)?.[1]
    if (missing) return `PostHog settings are missing: ${missing.trim()}`
    // PostHog answered, but its event store did not: ClickHouse is down or restarting ("Code: 210. DB::NetException:
    // Connection refused (clickhouse:9000)"). Not "PostHog is unreachable", which sends people to the wrong container.
    if (/clickhouse|db::netexception|\bcode: (?:209|210)\b|network_error|socket_timeout/.test(m) && /refused|network|timeout|unreachable|not available|code: (?:209|210)/.test(m)) return "PostHog's ClickHouse (event store) is not answering"
    if (/timeout|timed out|aborted|lens paused calls/.test(m)) return 'PostHog did not answer in time'
    if (/econnrefused|enotfound|ehostunreach|econnreset|fetch failed|socket hang up|network/.test(m)) return 'PostHog is unreachable'
    const scope = /missing (?:required )?scope\W{0,3}([a-z_]+:(?:read|write))/i.exec(raw)?.[1]
    if (scope) return `PostHog refused Lens's API key: it lacks the ${scope} scope`
    if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid (?:personal )?api key/.test(m)) return "PostHog refused Lens's API key"
    if (status === 404 && /\/api\/projects\/[^/\s]*\/query\//.test(raw)) return 'PostHog has no such project for Lens: check POSTHOG_PROJECT_ID'
    if (/unreadable answer|unexpected answer/.test(m)) return 'PostHog sent an answer Lens could not read'
    if (status === 429 || /rate limit|too many requests/.test(m)) return 'PostHog is rate-limiting Lens'
    if (status >= 500) return `PostHog returned an error (HTTP ${status})`
    if (/heap out of memory|err_worker_out_of_memory|out of memory|allocation failed|resourcelimits/.test(m)) return 'ran out of memory'
    if (/enospc|no space left|disk is full|database or disk is full/.test(m)) return 'the disk is full'
    if (/database is locked|sqlite_busy/.test(m)) return 'the history database was busy'
    if (/attempt to write a readonly database|sqlite_readonly|erofs|read-only file system/.test(m)) return "Lens's storage is read-only"
    if (/database disk image is malformed|sqlite_corrupt|file is not a database|sqlite_notadb/.test(m)) return "Lens's database file is damaged"
    if (/worker exited|worker .*terminated/.test(m)) return 'its worker stopped unexpectedly'
    if (/too large/.test(m)) return 'a recording was too large to read'
    // Anything else: the first line, without URLs, addresses or quoted text.
    const first = raw.split('\n')[0].replace(/^(?:Error|TypeError|RangeError): /, '').replace(/https?:\/\/\S+/g, '<url>').replace(/[^\s<>"']+@[^\s<>"']+/g, '<address>').replace(/(['"`]).*?\1/g, '…').replace(/\s+/g, ' ').trim()
    return first.slice(0, 160) || 'failed'
}

/** The round finished. `detail` is a short note for the System page ("read 12 replays"). */
export function jobOk(key: string, detail?: string): void {
    const j = jobs.get(key); if (!j) return
    const now = Date.now()
    if (j.failures) {
        log('job recovered', { job: key, label: j.label, after: ago(now - (j.since || now)), failures: j.failures })
        j.since = now
    } else if (!j.ok) j.since = now
    j.ok = now; j.failures = 0; j.reason = undefined; j.detail = detail
}

/** The round failed: logged when the job first fails, and again only every 10 failures. */
export function jobFailed(key: string, e: unknown): void {
    const j = jobs.get(key); if (!j) return
    const now = Date.now(), reason = plainReason(e)
    if (!j.failures || j.reason !== reason) {
        log('job failed', { job: key, label: j.label, reason, last_ok: j.ok ? new Date(j.ok).toISOString() : null })
        if (!j.failures) j.since = now
    } else if (j.failures % 10 === 0) log('job still failing', { job: key, label: j.label, reason, failures: j.failures + 1, for: ago(now - j.since) })
    j.err = now; j.failures++; j.reason = reason
}

/** Every job's state, worst first. A job with no success for three rounds is a warning even without an error. */
export function jobStates(now = Date.now()): JobState[] {
    const rank: Record<JobLevel, number> = { down: 0, warn: 1, waiting: 2, ok: 3 }
    return [...jobs].map(([key, j]) => {
        let level: JobLevel = 'ok', reason: string | null = null
        if (j.failures >= 3) { level = 'down'; reason = `${j.reason} (failing for ${ago(now - j.since)}, ${j.failures} rounds)` }
        else if (j.failures) { level = 'warn'; reason = `${j.reason}; retrying` }
        else if (!j.ok) { level = now - j.started > 3 * j.everyMs ? 'warn' : 'waiting'; reason = level === 'warn' ? `no round has finished in ${ago(now - j.started)}` : 'first round not finished yet' }
        else if (now - j.ok > 3 * j.everyMs) { level = 'warn'; reason = `no successful round for ${ago(now - j.ok)}` }
        return { key, label: j.label, level, reason, detail: j.detail || null, last_ok_at: j.ok ? new Date(j.ok).toISOString() : null,
            last_error_at: j.err ? new Date(j.err).toISOString() : null, since: new Date(j.since).toISOString() }
    }).sort((a, b) => rank[a.level] - rank[b.level] || a.label.localeCompare(b.label))
}

/** For tests. */
export function resetJobs(): void { jobs.clear() }
