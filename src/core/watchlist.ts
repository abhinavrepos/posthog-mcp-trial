// The Watchlist: clients a PM wants watched closely. Every 10 minutes Lens reads their new session
// replays on this machine (core/replaymoments.ts turns each one into steps), and keeps the steps here so
// the Watchlist page and Copilot (the watch_* MCP tools) can show what happened, step by step.
//
// Kept: per session, the steps (structure only: reviewed element names, rounded timings, counts), the
// client, a hash of the person and when it was recorded. Never kept: coordinates, typed values, screen
// text, URLs or the person's identity. Replay links are built when asked, from the session id.
import { jobFailed, jobOk, registerJob } from './jobhealth.ts'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'

import { snapshotsFile } from './clip.ts'
import { fairOrder, humanName, screenVocabulary, type Candidate } from './experience.ts'
import { getRecording, hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'
import { MARK_TEXT, MARK_WEIGHT, MARKS, MOMENTS_VERSION, stepLine, type Mark, type SessionMoments, type Step } from './replaymoments.ts'
import { tasksDb } from './tasks.ts'
import { config } from './config.ts'
import { rollback } from './sqlitetx.ts'

tasksDb.exec(`
CREATE TABLE IF NOT EXISTS watch_clients(client TEXT PRIMARY KEY, added_by TEXT NOT NULL, added_at TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
    found INTEGER NOT NULL DEFAULT 0, checked_at TEXT, last_read_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS watch_sessions(session_id TEXT PRIMARY KEY, client TEXT NOT NULL, user_hash TEXT NOT NULL, started_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL, active_ms INTEGER NOT NULL, score INTEGER NOT NULL, marks TEXT NOT NULL, moments TEXT NOT NULL, version INTEGER NOT NULL, read_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS watch_sessions_client ON watch_sessions(client, started_at);
CREATE TABLE IF NOT EXISTS watch_skips(session_id TEXT PRIMARY KEY, client TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watch_retries(session_id TEXT PRIMARY KEY, client TEXT NOT NULL, attempts INTEGER NOT NULL, retry_after INTEGER NOT NULL);
`)

const hashUser = (u: string) => createHash('sha256').update('lens-watch:' + u).digest('hex').slice(0, 16)
const lit = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const DAY = 86_400_000
export const WATCH_DAYS = () => Math.max(1, Math.min(90, Number(process.env.WATCHLIST_DAYS) || 14))

// ------------------------------------------------------------------ the list itself
export interface WatchClient { client: string; name: string; added_at: string; paused: boolean; found: number; read: number; skipped: number; waiting: number; checked_at: string | null; last_read_at: string | null; last_error: string | null }
const clientName = (id: string) => (tasksDb.prepare('SELECT name FROM client_names WHERE client=?').get(id) as { name: string } | undefined)?.name || id

export function watchlist(): WatchClient[] {
    const rows = tasksDb.prepare(`SELECT w.client, w.added_at, w.paused, w.found, w.checked_at, w.last_read_at, w.last_error, (SELECT count(*) FROM watch_sessions s WHERE s.client=w.client) AS read,
        (SELECT count(*) FROM watch_skips k WHERE k.client=w.client) AS skipped FROM watch_clients w ORDER BY w.added_at`).all() as (Omit<WatchClient, 'paused' | 'name' | 'waiting'> & { paused: number })[]
    return rows.map((r) => ({ ...r, name: clientName(r.client), paused: !!r.paused, waiting: Math.max(0, r.found - r.read - r.skipped) }))
}
export const watched = (client: string) => !!tasksDb.prepare('SELECT 1 FROM watch_clients WHERE client=?').get(client)

/** Known clients a person can add: everyone the history has named. */
export function watchableClients(text = ''): { id: string; name: string }[] {
    const t = text.trim().toLowerCase()
    const rows = tasksDb.prepare(`SELECT client AS id, name FROM client_names WHERE client != '' ORDER BY name`).all() as { id: string; name: string }[]
    return t ? rows.filter((r) => r.id.toLowerCase() === t || r.name.toLowerCase().includes(t) || r.id.toLowerCase().includes(t)) : rows
}

export type WatchAction = 'add' | 'pause' | 'resume' | 'remove'
/** Changes the list. Removing a client also deletes the steps kept for it. */
export function changeWatch(client: string, action: WatchAction, by: string): { ok: true; client: string; action: WatchAction } {
    const id = client.trim()
    if (!id || id.length > 200) throw new Error('Choose a client.')
    if (action === 'add') {
        if (!watchableClients().some((c) => c.id === id)) throw new Error('Unknown client: choose one from the list.')
        tasksDb.prepare('INSERT INTO watch_clients(client, added_by, added_at) VALUES (?,?,?) ON CONFLICT(client) DO UPDATE SET paused=0').run(id, by, new Date().toISOString())
    } else {
        if (!watched(id)) throw new Error('That client is not on the watchlist.')
        if (action === 'remove') {
            tasksDb.exec('BEGIN')
            try {
                tasksDb.prepare('DELETE FROM watch_sessions WHERE client=?').run(id)
                tasksDb.prepare('DELETE FROM watch_retries WHERE client=?').run(id)
                tasksDb.prepare('DELETE FROM watch_skips WHERE client=?').run(id)
                tasksDb.prepare('DELETE FROM watch_clients WHERE client=?').run(id)
                tasksDb.exec('COMMIT')
            } catch (e) { rollback(tasksDb); throw e }
        } else tasksDb.prepare('UPDATE watch_clients SET paused=? WHERE client=?').run(action === 'pause' ? 1 : 0, id)
    }
    return { ok: true, client: id, action }
}

// ------------------------------------------------------------------ reading replays
/** Finished recordings (no event for 30 minutes) of watched clients, newest first. */
export async function watchCandidates(clients: string[], deps = { hogql }): Promise<{ list: Candidate[]; found: Map<string, number> }> {
    const found = new Map<string, number>()
    if (!clients.length) return { list: [], found }
    const days = WATCH_DAYS()
    // Ownership and "finished" are judged on the whole session, not only its watched-client events: a session
    // that also carries another client, or that is still going, is not read.
    const client = `toString(${P.client})`
    const rows = await deps.hogql(`SELECT $session_id AS session_id, anyIf(${client}, notEmpty(${client})) AS client, any(distinct_id) AS user, min(timestamp) AS start, max(timestamp) AS end,
            uniqIf(${client}, notEmpty(${client})) AS clients
        FROM events WHERE timestamp > now() - INTERVAL ${days + 1} DAY AND notEmpty($session_id)
          AND $session_id IN (SELECT $session_id FROM events WHERE timestamp > now() - INTERVAL ${days} DAY AND ${client} IN (${clients.map(lit).join(',')}))
          AND $session_id IN (SELECT session_id FROM raw_session_replay_events WHERE min_first_timestamp > now() - INTERVAL ${days + 1} DAY)
        GROUP BY $session_id HAVING max(timestamp) < now() - INTERVAL 30 MINUTE AND clients = 1 ORDER BY start DESC LIMIT 5000`, {}, { timeoutMs: 60_000 })
    const list: Candidate[] = []
    for (const r of rows) {
        const c = { session_id: String(r.session_id || ''), client: String(r.client || ''), user: String(r.user || ''), start: String(r.start), end: r.end ? String(r.end) : undefined }
        if (!c.session_id || !clients.includes(c.client)) continue
        found.set(c.client, (found.get(c.client) || 0) + 1)
        list.push(c)
    }
    return { list, found }
}

/** Parsing runs in a worker thread, so a large recording never blocks the web service. */
export function momentsInWorker(input: { file?: string; jsonl?: string }, duration: number | undefined, names: string[]): Promise<SessionMoments> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const { workerData, parentPort } = require('node:worker_threads');
            const { readFileSync, statSync } = require('node:fs');
            (async () => {
                const { momentsFromReplay } = await import(workerData.module);
                const limit = (Number(process.env.REPLAY_MAX_MB) || 200) * 1024 * 1024;
                if (workerData.file && statSync(workerData.file).size > limit) throw new Error('Recording too large by snapshot policy');
                const text = workerData.file ? readFileSync(workerData.file, 'utf8') : workerData.jsonl;
                if (Buffer.byteLength(text) > limit) throw new Error('Recording too large by snapshot policy');
                parentPort.postMessage(momentsFromReplay(text, workerData.duration, { names: workerData.names }));
            })().catch(e => { throw e });
        `, { eval: true, workerData: { ...input, duration, names, module: new URL('./replaymoments.ts', import.meta.url).href }, resourceLimits: { maxOldGenerationSizeMb: 512 } })
        const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Replay reading timed out')) }, 60_000)
        worker.once('message', (m) => { clearTimeout(timer); resolve(m); void worker.terminate() })
        worker.once('error', (e) => { clearTimeout(timer); reject(e) })
        worker.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Replay reading worker exited: ${code}`)) })
    })
}

export const scoreOf = (m: SessionMoments) => m.steps.reduce((a, s) => a + s.marks.reduce((b, k) => b + MARK_WEIGHT[k], 0), 0)

/** Reads up to `perRun` replays of watched, active clients and keeps their steps. */
export async function processWatchlist(perRun = 30, deps: { candidates?: typeof watchCandidates; jsonl?: (id: string) => Promise<string>; durationMs?: (id: string) => Promise<number | undefined>; names?: () => Promise<string[]> } = {}): Promise<{ read: number; skipped: number; waiting: number }> {
    const rowsNow = tasksDb.prepare('SELECT client, added_at FROM watch_clients WHERE paused=0').all() as { client: string; added_at: string }[]
    const active = rowsNow.map((r) => r.client)
    if (!active.length) return { read: 0, skipped: 0, waiting: 0 }
    // Removed (or removed and added again) while a replay was being read: that read belongs to the old entry.
    const since = new Map(rowsNow.map((r) => [r.client, r.added_at]))
    const still = (client: string) => (tasksDb.prepare('SELECT added_at FROM watch_clients WHERE client=?').get(client) as { added_at: string } | undefined)?.added_at === since.get(client)
    const now = new Date().toISOString()
    let found: Awaited<ReturnType<typeof watchCandidates>>
    try { found = await (deps.candidates || watchCandidates)(active) } catch (e) {
        // The raw error can quote the query or PostHog's own text: only a fixed message is kept.
        const msg = 'PostHog did not answer the last check for new replays.'
        for (const c of active) tasksDb.prepare('UPDATE watch_clients SET checked_at=?, last_error=? WHERE client=?').run(now, msg, c)
        throw e
    }
    for (const c of active) tasksDb.prepare('UPDATE watch_clients SET found=?, checked_at=?, last_error=NULL WHERE client=?').run(found.found.get(c) || 0, now, c)
    // Read already (by this version of the reader), skipped for good, or waiting before another try.
    const done = new Set((tasksDb.prepare('SELECT session_id FROM watch_sessions WHERE version=? UNION SELECT session_id FROM watch_skips UNION SELECT session_id FROM watch_retries WHERE retry_after > ?').all(MOMENTS_VERSION, Date.now()) as { session_id: string }[]).map((r) => r.session_id))
    const todo = found.list.filter((c) => !done.has(c.session_id))
    const list = fairOrder(todo, perRun)
    if (!list.length) return { read: 0, skipped: 0, waiting: 0 }
    const names = await (deps.names || screenVocabulary)()
    const length = deps.durationMs || (async (id: string) => { try { return Math.round(Number((await getRecording(id)).recording_duration) * 1000) || undefined } catch { return undefined } })
    let read = 0, skipped = 0
    for (const c of list) {
        try {
            const span = c.end ? Date.parse(c.end) - Date.parse(c.start) : 0
            const input = deps.jsonl ? { jsonl: await deps.jsonl(c.session_id) } : { file: await snapshotsFile(c.session_id) }
            const m = await momentsInWorker(input, Math.max((await length(c.session_id)) || 0, Number.isFinite(span) ? span : 0) || undefined, names)
            if (m.duration_ms < 5_000) throw new Error('too short')
            const marks = [...new Set(m.steps.flatMap((s) => s.marks))]
            // The client may have been removed while this replay was being read.
            if (!still(c.client)) continue
            tasksDb.prepare('INSERT OR REPLACE INTO watch_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(c.session_id, c.client, hashUser(c.user), new Date(Date.parse(c.start)).toISOString(), Math.round(m.duration_ms), Math.round(m.active_ms), scoreOf(m), JSON.stringify(marks), JSON.stringify(m), MOMENTS_VERSION, new Date().toISOString())
            tasksDb.prepare('DELETE FROM watch_retries WHERE session_id=?').run(c.session_id)
            tasksDb.prepare('UPDATE watch_clients SET last_read_at=? WHERE client=?').run(new Date().toISOString(), c.client)
            read++
        } catch (e) {
            const reason = String((e as Error).message || e).slice(0, 120)
            if ([404, 410, 413].includes((e as { status?: number }).status || 0) || /^too short$|Recording too large|recording deleted/i.test(reason)) {
                if (still(c.client)) tasksDb.prepare('INSERT OR REPLACE INTO watch_skips VALUES (?,?,?,?)').run(c.session_id, c.client, reason, new Date().toISOString())
                tasksDb.prepare('DELETE FROM watch_retries WHERE session_id=?').run(c.session_id)
            } else {
                const prev = tasksDb.prepare('SELECT attempts FROM watch_retries WHERE session_id=?').get(c.session_id) as { attempts: number } | undefined
                const attempts = Math.min(10, (prev?.attempts || 0) + 1)
                if (still(c.client)) tasksDb.prepare('INSERT OR REPLACE INTO watch_retries VALUES (?,?,?,?)').run(c.session_id, c.client, attempts, Date.now() + Math.min(DAY, 60_000 * 2 ** attempts))
            }
            skipped++
        }
    }
    return { read, skipped, waiting: Math.max(0, todo.length - list.length) }
}

let timer: NodeJS.Timeout | undefined, running = false
/** Every 10 minutes (WATCHLIST=off turns it off; WATCHLIST_PER_RUN sets the batch, default 30). */
export function startWatchlist(): void {
    if (process.env.WATCHLIST === 'off' || timer) return
    const per = Math.max(1, Math.min(200, Number(process.env.WATCHLIST_PER_RUN) || 30))
    registerJob('watchlist', 'Watchlist reader', 10 * 60_000)
    const round = async () => { if (running) return; running = true; try { const r = await processWatchlist(per); jobOk('watchlist', `last round: ${r.read} read, ${r.skipped} skipped, ${r.waiting} waiting`) } catch (e) { /* also recorded on each client as last_error */ jobFailed('watchlist', e) } finally { running = false } }
    setTimeout(() => void round(), 90_000).unref()
    timer = setInterval(() => void round(), 10 * 60_000); timer.unref()
}
/** For the page's "Read now" button: one round at once, unless one is running. */
export async function readNow(): Promise<{ started: boolean }> {
    if (running) return { started: false }
    running = true
    void processWatchlist(Math.max(1, Math.min(200, Number(process.env.WATCHLIST_PER_RUN) || 30))).catch(() => {}).finally(() => { running = false })
    return { started: true }
}
export const watchRunning = () => running

// ------------------------------------------------------------------ reading what was kept
interface Row { session_id: string; client: string; user_hash: string; started_at: string; duration_ms: number; active_ms: number; score: number; marks: string; moments: string }
export interface Filter { client?: string; from: string; to: string; kinds?: Mark[] } // from/to: YYYY-MM-DD, inclusive
function rows(f: Filter): (Row & { m: SessionMoments })[] {
    const args: string[] = [f.from, new Date(Date.parse(f.to) + DAY).toISOString().slice(0, 10)]
    let sql = 'SELECT * FROM watch_sessions WHERE started_at >= ? AND started_at < ? AND client IN (SELECT client FROM watch_clients)'
    if (f.client) { sql += ' AND client = ?'; args.push(f.client) }
    return (tasksDb.prepare(sql).all(...args) as unknown as Row[]).flatMap((r) => { try { return [{ ...r, m: JSON.parse(r.moments) as SessionMoments }] } catch { return [] } })
}
const matches = (s: Step, kinds?: Mark[]) => s.marks.some((k) => !kinds?.length || kinds.includes(k))
const topMark = (s: Step) => s.marks[0]
export type Severity = 'high' | 'medium' | 'low'
const severityOf = (score: number, marks: Mark[]): Severity => (marks.includes('error_loop') || marks.includes('failed_submit') || score >= 10 ? 'high' : score >= 4 ? 'medium' : 'low')

/** "the Save button", "the Notional field", "a button": the name a person would use. */
export const targetText = (t: string) => (t === 'end of recording' ? 'before leaving' : humanName(t) || t)
const label = (s: Step) => { const k = topMark(s); return k ? `${MARK_TEXT[k]}${s.kind === 'end' ? ' before leaving' : ` on ${targetText(s.target)}`}` : targetText(s.target) }
const lensWatch = (session: string, at_ms: number) => `${config.service.publicUrl.replace(/\/$/, '')}/replays?url=${encodeURIComponent(replayUrl(session, Math.max(0, Math.floor(at_ms / 1000) - 3)))}`
export const replayAt = (session: string, at_ms: number) => ({ offset_s: Math.max(0, Math.floor(at_ms / 1000) - 3), replay_url: replayUrl(session, Math.max(0, Math.floor(at_ms / 1000) - 3)), clip_page: lensWatch(session, at_ms) })

export interface Highlight {
    session_id: string; client: string; client_name: string; started_at: string; duration_ms: number; active_ms: number
    severity: Severity; score: number; headline: string; evidence: string; marks: Mark[]; mark_text: string[]
    moment: { step: number; at_ms: number; offset_s: number; replay_url: string; clip_page: string }
    steps_marked: number
}
/** Sessions worth watching, the most telling first: one card per session. */
export function highlights(f: Filter, limit = 50, offset = 0): { total: number; items: Highlight[]; coverage: Coverage } {
    const list: Highlight[] = []
    for (const r of rows(f)) {
        // With a kind filter, only the matching marks count: the headline and rank are about what was asked for.
        const keep = (s: Step): Step => (f.kinds?.length ? { ...s, marks: s.marks.filter((k) => f.kinds!.includes(k)) } : s)
        const marked = r.m.steps.map(keep).filter((s) => s.marks.length)
        if (!marked.length) continue
        const score = marked.reduce((a, s) => a + s.marks.reduce((b, k) => b + MARK_WEIGHT[k], 0), 0)
        const best = [...marked].sort((a, b) => MARK_WEIGHT[topMark(b)!] - MARK_WEIGHT[topMark(a)!] || a.at_ms - b.at_ms)[0]
        const marks = MARKS.filter((k) => marked.some((s) => s.marks.includes(k)))
        list.push({ session_id: r.session_id, client: r.client, client_name: clientName(r.client), started_at: r.started_at, duration_ms: r.duration_ms, active_ms: r.active_ms,
            severity: severityOf(score, marks), score, headline: label(best), evidence: stepLine(best, targetText), marks, mark_text: marks.map((k) => MARK_TEXT[k]),
            moment: { step: best.n, at_ms: best.at_ms, ...replayAt(r.session_id, best.at_ms) }, steps_marked: marked.length })
    }
    const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
    list.sort((a, b) => rank[a.severity] - rank[b.severity] || b.score - a.score || b.started_at.localeCompare(a.started_at) || a.session_id.localeCompare(b.session_id))
    return { total: list.length, items: list.slice(offset, offset + limit), coverage: coverage(f) }
}

export interface Problem { key: string; mark: Mark; what: string; where: string; target: string; sessions: number; clients: number; people: number; latest: string; examples: { session_id: string; client: string; client_name: string; started_at: string; at_ms: number; offset_s: number; replay_url: string; clip_page: string; evidence: string }[] }
/** The same thing going wrong on the same control in several sessions. */
export function repeatedProblems(f: Filter, minSessions = 2): Problem[] {
    const m = new Map<string, { mark: Mark; target: string; sessions: Set<string>; clients: Set<string>; people: Set<string>; latest: string; examples: Problem['examples'] }>()
    for (const r of rows(f)) {
        const seen = new Set<string>()
        for (const s of r.m.steps) for (const k of s.marks) {
            if (f.kinds?.length && !f.kinds.includes(k)) continue
            const key = `${k}|${s.target}`
            let g = m.get(key)
            if (!g) { g = { mark: k, target: s.target, sessions: new Set(), clients: new Set(), people: new Set(), latest: r.started_at, examples: [] }; m.set(key, g) }
            if (seen.has(key)) continue
            seen.add(key)
            g.sessions.add(r.session_id); g.clients.add(r.client); g.people.add(r.user_hash)
            if (r.started_at > g.latest) g.latest = r.started_at
            g.examples.push({ session_id: r.session_id, client: r.client, client_name: clientName(r.client), started_at: r.started_at, at_ms: s.at_ms, ...replayAt(r.session_id, s.at_ms), evidence: stepLine(s, targetText) })
        }
    }
    return [...m.entries()].filter(([, g]) => g.sessions.size >= minSessions).map(([key, g]) => ({
        key, mark: g.mark, what: MARK_TEXT[g.mark], where: targetText(g.target), target: g.target, sessions: g.sessions.size, clients: g.clients.size, people: g.people.size, latest: g.latest,
        examples: g.examples.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 3),
    })).sort((a, b) => b.sessions - a.sessions || MARK_WEIGHT[b.mark] - MARK_WEIGHT[a.mark] || b.latest.localeCompare(a.latest)).slice(0, 30)
}

export interface Coverage { sessions_read: number; with_highlights: number; clients: number; people: number; skipped: number; waiting: number; note: string }
export function coverage(f: Filter): Coverage {
    const list = rows(f)
    const wl = watchlist().filter((c) => !f.client || c.client === f.client)
    const withHighlights = list.filter((r) => r.m.steps.some((s) => s.marks.length && matches(s, f.kinds))).length
    const waiting = wl.reduce((a, c) => a + c.waiting, 0), skipped = wl.reduce((a, c) => a + c.skipped, 0)
    return { sessions_read: list.length, with_highlights: withHighlights, clients: new Set(list.map((r) => r.client)).size, people: new Set(list.map((r) => r.user_hash)).size, skipped, waiting,
        note: `${withHighlights} of ${list.length} sessions read from ${f.from} to ${f.to} have something worth watching${waiting ? `; ${waiting} more waiting to be read` : ''}. Structure only: no typed values, screen text or pointer coordinates.` }
}

export interface SessionDetail {
    session_id: string; client: string; client_name: string; started_at: string; duration_ms: number; active_ms: number; pointer: SessionMoments['pointer']
    steps: (Step & { line: string; offset_s: number; replay_url: string; clip_page: string })[]; total_steps: number; marks: { mark: Mark; text: string; steps: number }[]
}
/** Every step of one watched session, in order (from_s/to_s narrow it to part of the recording). */
export function sessionDetail(sessionId: string, opts: { from_s?: number; to_s?: number; onlyMarked?: boolean } = {}): SessionDetail | undefined {
    if (opts.from_s !== undefined && opts.to_s !== undefined && opts.to_s < opts.from_s) throw new Error('to_s must not be before from_s.')
    const r = tasksDb.prepare('SELECT * FROM watch_sessions WHERE session_id=? AND client IN (SELECT client FROM watch_clients)').get(sessionId) as Row | undefined
    if (!r) return undefined
    const m = JSON.parse(r.moments) as SessionMoments
    const inRange = (s: Step) => (opts.from_s === undefined || s.at_ms >= opts.from_s * 1000) && (opts.to_s === undefined || s.at_ms <= opts.to_s * 1000)
    const steps = m.steps.filter((s) => inRange(s) && (!opts.onlyMarked || s.marks.length)).map((s) => ({ ...s, line: stepLine(s, targetText), ...replayAt(r.session_id, s.at_ms) }))
    return { session_id: r.session_id, client: r.client, client_name: clientName(r.client), started_at: r.started_at, duration_ms: r.duration_ms, active_ms: r.active_ms, pointer: m.pointer,
        steps, total_steps: m.steps.length, marks: MARKS.map((k) => ({ mark: k, text: MARK_TEXT[k], steps: m.steps.filter((s) => s.marks.includes(k)).length })).filter((x) => x.steps) }
}

/** Two to five sessions side by side, per control: did the same step go differently? */
export function compareSessions(ids: string[]): { sessions: { session_id: string; client_name: string; started_at: string; duration_ms: number; marked_steps: number }[]; rows: { target: string; where: string; per_session: ({ clicks: number; slowest_ms: number | null; longest_dwell_ms: number | null; marks: Mark[] } | null)[] }[]; missing: string[] } {
    const found = ids.map((id) => sessionDetail(id))
    const have = found.filter((x): x is SessionDetail => !!x)
    const targets = new Map<string, number>()
    for (const d of have) for (const s of d.steps) if (s.kind !== 'end') targets.set(s.target, (targets.get(s.target) || 0) + (s.marks.length ? 10 : 1))
    const order = [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t]) => t)
    return {
        sessions: have.map((d) => ({ session_id: d.session_id, client_name: d.client_name, started_at: d.started_at, duration_ms: d.duration_ms, marked_steps: d.steps.filter((s) => s.marks.length).length })),
        rows: order.map((t) => ({ target: t, where: targetText(t), per_session: have.map((d) => {
            const ss = d.steps.filter((s) => s.target === t)
            if (!ss.length) return null
            const req = ss.map((s) => s.after.request_ms).filter((x): x is number => x !== null), dw = ss.map((s) => s.lead.dwell_ms).filter((x): x is number => x !== null)
            return { clicks: ss.reduce((a, s) => a + Math.max(1, s.clicks), 0), slowest_ms: req.length ? Math.max(...req) : null, longest_dwell_ms: dw.length ? Math.max(...dw) : null, marks: MARKS.filter((k) => ss.some((s) => s.marks.includes(k))) }
        }) })),
        missing: ids.filter((_, i) => !found[i]),
    }
}

/** One client in a paragraph: how much was read, what keeps going wrong, where to look first. */
export function watchDigest(client: string, f: Omit<Filter, 'client'>) {
    const filter = { ...f, client }
    const cov = coverage(filter)
    const problems = repeatedProblems(filter, 1).slice(0, 5)
    const top = highlights(filter, 3).items
    const counts = MARKS.map((k) => ({ mark: k, text: MARK_TEXT[k], sessions: rows(filter).filter((r) => r.m.steps.some((s) => s.marks.includes(k))).length })).filter((x) => x.sessions)
    const summary = !cov.sessions_read ? 'No sessions read yet for this client in this period.' : !problems.length ? `Nothing stood out in ${cov.sessions_read} sessions.`
        : `${problems[0].what} on ${problems[0].where} in ${problems[0].sessions} of ${cov.sessions_read} sessions${problems[1] ? `; ${problems[1].what.toLowerCase()} on ${problems[1].where} in ${problems[1].sessions}` : ''}.`
    return { client, client_name: clientName(client), window: { from: f.from, to: f.to }, summary, coverage: cov, kinds: counts, top_problems: problems, worth_watching: top }
}
