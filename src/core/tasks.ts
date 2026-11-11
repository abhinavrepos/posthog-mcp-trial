// Task history has its own database: ingest and long scans must not lock the web service's tables.
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { appEvents, columns, dialogLabel, required, toRaw, toSteps, type AppEvents, type Step, type RawEvent } from './appevents.ts'
import { config, ROOT } from './config.ts'
import { hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'
import { workflowEpisodes } from './workflows.ts'
import { DURATION_BUCKETS, type Coverage, type TaskAttempt, type Task, type TaskMapParams, type TaskMap, type TaskMapRow,
    type FlowTimeParams, type FlowTime, type FlowPoint, type IngestStatus, type Window } from './taskstypes.ts'

const DAY = 86_400_000
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const shift = (day: string, n: number) => date(Date.parse(day) + n * DAY)
const today = () => date(Date.now())
export const TASKS_DB_FILE = isAbsolute(config.tasks.db) ? config.tasks.db : join(ROOT, config.tasks.db)
mkdirSync(dirname(TASKS_DB_FILE), { recursive: true })
// Exported for maintenance and bulk fixtures; application queries use the functions below.
export const tasksDb = new DatabaseSync(TASKS_DB_FILE)
// busy_timeout first: switching to WAL needs a lock, and without it a second process opening the file at
// the same moment fails at once ("database is locked") instead of waiting.
tasksDb.exec('PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32768;')
function transaction<T>(fn: () => T): T {
    tasksDb.exec('BEGIN IMMEDIATE')
    try { const value = fn(); tasksDb.exec('COMMIT'); return value }
    catch (e) { tasksDb.exec('ROLLBACK'); throw e }
}
transaction(() => {
    // Another process may have migrated while this one waited for the write lock.
    const version = (tasksDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version < 1) tasksDb.exec(`
        CREATE TABLE task_attempts(day TEXT NOT NULL, client TEXT NOT NULL, user TEXT NOT NULL, session_id TEXT NOT NULL,
            task_id TEXT NOT NULL, path TEXT NOT NULL, path_key TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
            duration_s REAL NOT NULL, outcome TEXT NOT NULL, errors INTEGER NOT NULL, first_error TEXT, offset_s REAL NOT NULL);
        CREATE INDEX attempts_task_client_day ON task_attempts(task_id, client, day);
        CREATE INDEX attempts_day ON task_attempts(day);
        CREATE INDEX attempts_duration ON task_attempts(task_id, day, duration_s);
        CREATE TABLE task_daily(day TEXT NOT NULL, client TEXT NOT NULL, task_id TEXT NOT NULL, attempts INTEGER NOT NULL,
            done INTEGER NOT NULL, failed INTEGER NOT NULL, abandoned INTEGER NOT NULL, users INTEGER NOT NULL, dur_hist TEXT NOT NULL,
            PRIMARY KEY(day, client, task_id)) WITHOUT ROWID;
        CREATE INDEX daily_task_day ON task_daily(task_id, day, client, attempts, done, failed, abandoned, dur_hist);
        CREATE TABLE task_paths_daily(day TEXT NOT NULL, client TEXT NOT NULL, task_id TEXT NOT NULL, path_key TEXT NOT NULL,
            path TEXT NOT NULL, attempts INTEGER NOT NULL, done INTEGER NOT NULL, dur_hist TEXT NOT NULL,
            PRIMARY KEY(day, client, task_id, path_key)) WITHOUT ROWID;
        CREATE INDEX paths_task_day ON task_paths_daily(task_id, day, client);
        CREATE TABLE task_users_daily(day TEXT NOT NULL, client TEXT NOT NULL, task_id TEXT NOT NULL, user TEXT NOT NULL,
            PRIMARY KEY(day, client, task_id, user)) WITHOUT ROWID;
        CREATE INDEX users_task_day ON task_users_daily(task_id, day, client, user);
        CREATE TABLE task_catalog(task_id TEXT PRIMARY KEY, dialog TEXT NOT NULL, name TEXT NOT NULL, finish TEXT NOT NULL,
            first_day TEXT NOT NULL, last_day TEXT NOT NULL);
        CREATE TABLE dialog_names(dialog TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE client_names(client TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE task_finishes_daily(day TEXT NOT NULL, task_id TEXT NOT NULL, finish TEXT NOT NULL, n INTEGER NOT NULL,
            PRIMARY KEY(day, task_id, finish)) WITHOUT ROWID;
        CREATE TABLE task_ingest(day TEXT PRIMARY KEY, sessions INTEGER NOT NULL, events INTEGER NOT NULL, attempts INTEGER NOT NULL,
            truncated INTEGER NOT NULL, seconds REAL NOT NULL, done_at TEXT NOT NULL);
        CREATE TABLE task_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA user_version = 1;
    `)
})
type Row = Record<string, unknown>
const all = <T = Row>(sql: string, ...args: SQLInputValue[]) => tasksDb.prepare(sql).all(...args) as T[]
const one = <T = Row>(sql: string, ...args: SQLInputValue[]) => tasksDb.prepare(sql).get(...args) as T | undefined
const run = (sql: string, ...args: SQLInputValue[]) => tasksDb.prepare(sql).run(...args)
const emptyHist = () => DURATION_BUCKETS.map(() => 0)
// Histograms often repeat across daily rows. Bound the cache so backfills cannot grow it forever.
const histCache = new Map<string, number[]>()
function histogram(s: string): number[] {
    let h = histCache.get(s)
    if (!h) { h = JSON.parse(s) as number[]; if (histCache.size >= 4096) histCache.clear(); histCache.set(s, h) }
    return h
}
const merge = (into: number[], h: number[]) => { for (let i = 0; i < into.length; i++) into[i] += h[i] || 0 }
// Aggregate in SQLite to return one row per client/task. A numeric handle avoids copying JSON on every row;
// SQLite calls result once per group, which releases the temporary histogram.
let histId = 0
const histStates = new Map<number, number[]>()
tasksDb.aggregate('hist_merge', {
    start: () => { const id = ++histId; histStates.set(id, emptyHist()); return id },
    step: (id, value) => { merge(histStates.get(Number(id))!, histogram(String(value))); return id },
    result: (id) => { const h = histStates.get(Number(id))!; histStates.delete(Number(id)); return JSON.stringify(h) },
})

function percentile(h: number[], q: number): number | null {
    const n = h.reduce((a, b) => a + b, 0)
    if (!n) return null
    const target = n * q
    let below = 0
    for (let i = 0; i < h.length; i++) {
        if (h[i] && below + h[i] >= target) {
            const lo = DURATION_BUCKETS[i], hi = DURATION_BUCKETS[i + 1] ?? lo * 2
            return lo + (hi - lo) * (target - below) / h[i]
        }
        below += h[i]
    }
    return null
}
const bucket = (s: number) => { let i = 0; while (i + 1 < DURATION_BUCKETS.length && s >= DURATION_BUCKETS[i + 1]) i++; return i }

/** One slice ends at the first good submit reply; a terminal slice uses its last submitted dialog.
 * A failed submit followed by a successful retry is one attempt, including its errors.
 */
export function extractAttempts(sessions: Step[][], reg: AppEvents): TaskAttempt[] {
    const excluded = new Set([...reg.dialogs.menu, ...reg.dialogs.messages, ...reg.dialogs.notices])
    const result: TaskAttempt[] = []
    for (const session of sessions) {
        if (!session.length) continue
        const first = session.reduce((a, b) => a.ts < b.ts || (a.ts === b.ts && a.i < b.i) ? a : b)
        for (const ep of workflowEpisodes([session], reg)) {
            let start = 0
            let submits = new Map<number, Step>()
            const emit = (end: number, submit: Step, done: boolean) => {
                const slice = ep.steps.slice(start, end + 1), a = slice[0], z = slice.at(-1)!
                const path: string[] = []
                for (const s of slice) if (s.kind === 'open' && s.dialog && !excluded.has(s.dialog) && path.at(-1) !== s.dialog) path.push(s.dialog)
                if (path.at(-1) !== submit.dialog) path.push(submit.dialog)
                const errors = slice.filter((s) => (s.kind === 'message' || s.kind === 'notice') && s.outcome === 'error')
                const clock = a.raw.ctime !== undefined && first.raw.ctime !== undefined
                    ? a.raw.ctime - first.raw.ctime : Date.parse(a.ts) - Date.parse(first.ts)
                result.push({ day: first.ts.slice(0, 10), client: first.raw.client || '',
                    user: (first.raw.user || '').split(config.properties.distinctIdSeparator).at(-1) || '', session_id: first.raw.sid,
                    task_id: `t_${submit.dialog}`, path: path.length > 8 ? [...path.slice(0, 3), '…', ...path.slice(-4)] : path,
                    started_at: a.ts, ended_at: z.ts, duration_s: Math.max(0, (Date.parse(z.ts) - Date.parse(a.ts)) / 1000),
                    outcome: done ? 'done' : errors.length ? 'failed' : 'abandoned', errors: errors.length,
                    first_error: errors[0]?.template || errors[0]?.text, offset_s: Math.max(0, clock / 1000) })
            }
            for (let j = 0; j < ep.steps.length; j++) {
                const s = ep.steps[j]
                if (s.kind === 'submit' && s.dialog && !excluded.has(s.dialog)) submits.set(s.i, s)
                const submit = s.cause === undefined ? undefined : submits.get(s.cause)
                if ((s.kind === 'message' || s.kind === 'notice') && submit && s.outcome === submit.outcome &&
                    (s.outcome === 'completed' || s.outcome === 'accepted')) {
                    emit(j, submit, true); start = j + 1; submits = new Map()
                }
            }
            const last = [...submits.values()].at(-1)
            if (last && start < ep.steps.length) emit(ep.steps.length - 1, last, false)
        }
    }
    return result
}

interface StoreInfo {
    sessions?: number; events?: number; truncated?: boolean; seconds?: number
    dialogNames?: Map<string, string>; clientNames?: Map<string, string>
    finishes?: Map<string, Map<string, number>>
}
interface Counts { attempts: number; done: number; failed: number; abandoned: number; hist: number[]; users: Set<string> }
const counts = (): Counts => ({ attempts: 0, done: 0, failed: 0, abandoned: 0, hist: emptyHist(), users: new Set() })
function add(c: Counts, a: TaskAttempt) {
    c.attempts++; c[a.outcome]++; c.users.add(a.user)
    if (a.outcome === 'done') c.hist[bucket(a.duration_s)]++
}
function label(dialog: string, names?: Map<string, string>): string {
    const reg = appEvents()
    return reg ? dialogLabel(dialog, reg, { get: (d) => names?.get(d) || one<{ name: string }>('SELECT name FROM dialog_names WHERE dialog = ?', d)?.name })
        : names?.get(dialog) || one<{ name: string }>('SELECT name FROM dialog_names WHERE dialog = ?', dialog)?.name || dialog
}

/** Replaces a day atomically, including zero-attempt days. Daily identity rows are deliberately kept
 * with rollups: summing daily user counts would overcount people active on several days.
 */
// Answers change only when a day is stored, so each answer is kept until the next store (or 10 minutes,
// for "today" in relative windows). Many people opening the same dashboard cost one query.
let generation = 0
const answers = new Map<string, { at: number; generation: number; value: Promise<unknown> }>()
function cached<T>(kind: string, p: object, compute: () => Promise<T>): Promise<T> {
    const key = kind + JSON.stringify(p), hit = answers.get(key)
    if (hit && hit.generation === generation && Date.now() - hit.at < 600_000) return hit.value as Promise<T>
    const value = compute()
    value.catch(() => answers.delete(key))
    if (answers.size >= 500) answers.delete(answers.keys().next().value!)
    answers.set(key, { at: Date.now(), generation, value })
    return value
}
/** Drops every kept answer (tests, and after maintenance). */
export function forgetAnswers(): void { answers.clear() }
export const taskMap = (p: TaskMapParams): Promise<TaskMap> => cached('map', p, () => computeTaskMap(p))
export const flowTime = (p: FlowTimeParams): Promise<FlowTime> => cached('flow', p, () => computeFlowTime(p))

export function storeAttempts(day: string, attempts: TaskAttempt[], info: StoreInfo = {}): void {
    generation++
    validDay(day)
    if (attempts.some((a) => a.day !== day)) throw new Error('All attempts must belong to the stored day')
    const daily = new Map<string, { client: string; task: string; c: Counts }>()
    const paths = new Map<string, { client: string; task: string; path: string; c: Counts }>()
    for (const a of attempts) {
        const k = JSON.stringify([a.client, a.task_id]), path = JSON.stringify(a.path), pk = JSON.stringify([a.client, a.task_id, path])
        if (!daily.has(k)) daily.set(k, { client: a.client, task: a.task_id, c: counts() })
        if (!paths.has(pk)) paths.set(pk, { client: a.client, task: a.task_id, path, c: counts() })
        add(daily.get(k)!.c, a); add(paths.get(pk)!.c, a)
    }
    transaction(() => {
        const affected = new Set([...all<{ task_id: string }>('SELECT DISTINCT task_id FROM task_daily WHERE day = ?', day).map((r) => r.task_id), ...attempts.map((a) => a.task_id)])
        for (const table of ['task_attempts', 'task_daily', 'task_paths_daily', 'task_users_daily', 'task_finishes_daily', 'task_ingest']) run(`DELETE FROM ${table} WHERE day = ?`, day)
        const ins = tasksDb.prepare('INSERT INTO task_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        for (const a of attempts) ins.run(day, a.client, a.user, a.session_id, a.task_id, JSON.stringify(a.path), JSON.stringify(a.path),
            a.started_at, a.ended_at, a.duration_s, a.outcome, a.errors, a.first_error ?? null, a.offset_s)
        const dailyIns = tasksDb.prepare('INSERT INTO task_daily VALUES (?,?,?,?,?,?,?,?,?)')
        const userIns = tasksDb.prepare('INSERT INTO task_users_daily VALUES (?,?,?,?)')
        for (const { client, task, c } of daily.values()) {
            dailyIns.run(day, client, task, c.attempts, c.done, c.failed, c.abandoned, c.users.size, JSON.stringify(c.hist))
            for (const user of c.users) userIns.run(day, client, task, user)
        }
        const pathIns = tasksDb.prepare('INSERT INTO task_paths_daily VALUES (?,?,?,?,?,?,?,?)')
        for (const { client, task, path, c } of paths.values()) pathIns.run(day, client, task, path, path, c.attempts, c.done, JSON.stringify(c.hist))
        for (const [d, name] of info.dialogNames || []) run('INSERT OR REPLACE INTO dialog_names VALUES (?,?)', d, name)
        for (const [c, name] of info.clientNames || []) run('INSERT OR REPLACE INTO client_names VALUES (?,?)', c, name)
        for (const [task, finishes] of info.finishes || []) for (const [finish, n] of finishes) run('INSERT INTO task_finishes_daily VALUES (?,?,?,?)', day, task, finish, n)
        for (const task of affected) {
            const range = one<{ first: string | null; last: string | null }>('SELECT min(day) AS first, max(day) AS last FROM task_daily WHERE task_id = ?', task)!
            if (!range.first) { run('DELETE FROM task_catalog WHERE task_id = ?', task); continue }
            const finish = one<{ finish: string }>('SELECT finish, sum(n) AS n FROM task_finishes_daily WHERE task_id = ? GROUP BY finish ORDER BY n DESC, finish LIMIT 1', task)?.finish || ''
            const dialog = task.slice(2)
            run('INSERT OR REPLACE INTO task_catalog VALUES (?,?,?,?,?,?)', task, dialog, label(dialog, info.dialogNames) + (finish ? ` → ${finish}` : ''), finish, range.first, range.last)
        }
        run('INSERT INTO task_ingest VALUES (?,?,?,?,?,?,?)', day, info.sessions ?? new Set(attempts.map((a) => a.session_id)).size,
            info.events ?? 0, attempts.length, Number(info.truncated || false), info.seconds ?? 0, new Date().toISOString())
    })
}

function validDay(s: string): void {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || date(Date.parse(s)) !== s) throw new Error('Dates must be valid YYYY-MM-DD UTC dates')
}
function validWindow(w: Window): number {
    if (!w) throw new Error('A window with from and to is required')
    validDay(w.from); validDay(w.to)
    const days = (Date.parse(w.to) - Date.parse(w.from)) / DAY + 1
    if (days < 1 || days > 400) throw new Error('Window must have from <= to and at most 400 days')
    return days
}
function filters(task?: string, client?: string) {
    if (task !== undefined && !/^t_[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(task)) throw new Error('Invalid task id; expected t_ followed by a dialog code')
    if (client !== undefined && (typeof client !== 'string' || client.length > 256)) throw new Error('Client must be a string of at most 256 characters')
    return { sql: `${task === undefined ? '' : ' AND task_id = ?'}${client === undefined ? '' : ' AND client = ?'}`, args: [task, client].filter((v): v is string => v !== undefined) }
}
interface Aggregate { client: string; task_id: string; attempts: number; done: number; failed: number; abandoned: number; hist: string }
function aggregates(w: Window, task?: string, client?: string): Aggregate[] {
    const f = filters(task, client)
    return all<Aggregate>(`SELECT client, task_id, sum(attempts) AS attempts, sum(done) AS done,
        sum(failed) AS failed, sum(abandoned) AS abandoned, hist_merge(dur_hist) AS hist
        FROM task_daily WHERE day BETWEEN ? AND ?${f.sql} GROUP BY client, task_id`, w.from, w.to, ...f.args)
}
function userCounts(w: Window, task?: string, client?: string): Map<string, number> {
    const f = filters(task, client)
    return new Map(all<{ client: string; task_id: string; n: number }>(`SELECT client, task_id, count(DISTINCT user) AS n FROM task_users_daily WHERE day BETWEEN ? AND ?${f.sql} GROUP BY client, task_id`, w.from, w.to, ...f.args).map((r) => [JSON.stringify([r.client, r.task_id]), r.n]))
}
const key = (r: { client: string; task_id: string }) => JSON.stringify([r.client, r.task_id])
function metrics(a?: Aggregate, users = 0): TaskMapRow['now'] {
    const h = a ? histogram(a.hist) : emptyHist()
    return { attempts: a?.attempts || 0, done: a?.done || 0, failed: a?.failed || 0, abandoned: a?.abandoned || 0,
        users, median_s: percentile(h, 0.5), p90_s: percentile(h, 0.9) }
}
function dataThrough(): string | null {
    // Today is mutable; only a complete, nontruncated day can be called fully processed.
    return one<{ day: string }>('SELECT max(day) AS day FROM task_ingest WHERE day < ? AND truncated = 0', today())?.day || null
}
/** The days of these periods not fully processed yet (today never counts as complete). */
export function coverage(...windows: Window[]): Coverage {
    const done = new Set(all<{ day: string }>('SELECT day FROM task_ingest WHERE day BETWEEN ? AND ? AND truncated = 0 AND day < ?',
        windows.map((w) => w.from).sort()[0], windows.map((w) => w.to).sort().at(-1)!, today()).map((r) => r.day))
    const unprocessed = new Set<string>()
    for (const w of windows) for (let d = w.from; d <= w.to && unprocessed.size < 400; d = shift(d, 1)) if (!done.has(d)) unprocessed.add(d)
    const list = [...unprocessed].sort()
    if (!list.length) return { complete: true, unprocessed: [] }
    const span = list.length === 1 ? list[0] : `${list.length} days (${list[0]} to ${list.at(-1)})`
    return { complete: false, unprocessed: list, text: `Not processed yet: ${span}. Lens gives no flags until both periods are fully processed, so a day still missing is never shown as work that stopped. Choose dates up to ${dataThrough() ?? 'the last processed day'}, or wait for the history to catch up.` }
}
function note(w: Window): string {
    const complete = one<{ n: number }>('SELECT count(*) AS n FROM task_ingest WHERE day BETWEEN ? AND ? AND truncated = 0', w.from, w.to)!.n
    const missing = Math.max(0, (Date.parse(w.to) - Date.parse(w.from)) / DAY + 1 - complete)
    const partial = one<{ n: number }>('SELECT count(*) AS n FROM task_ingest WHERE day BETWEEN ? AND ? AND truncated != 0', w.from, w.to)!.n
    return `Done includes completed and accepted replies. Durations use interpolated buckets; the open final bucket is estimated as 7200–14400 seconds. Daily rollups and distinct user identities survive attempt retention. Slow attempts and top errors cover only the retained ${config.tasks.historyDays} days. Session scans cover the previous day through the following day; longer sessions may be partial.${missing ? ` ${missing} day(s) in this window are not fully processed.` : ''}${partial ? ` ${partial} day(s) hit a safety cap; results are truncated.` : ''}`
}
function pathRows(w: Window, task?: string, client?: string, withHist = true) {
    const f = filters(task, client)
    return all<{ client: string; task_id: string; path: string; attempts: number; done: number; hist: string }>(`SELECT client, task_id, path, sum(attempts) AS attempts, sum(done) AS done, ${withHist ? 'hist_merge(dur_hist)' : "'[]'"} AS hist
        FROM task_paths_daily WHERE day BETWEEN ? AND ?${f.sql} GROUP BY client, task_id, path_key`, w.from, w.to, ...f.args)
}
async function computeTaskMap(p: TaskMapParams): Promise<TaskMap> {
    const days = validWindow(p.window), baseline = p.baseline || { from: shift(p.window.from, -days), to: shift(p.window.from, -1) }
    validWindow(baseline); filters(p.task, p.client)
    const cover = coverage(p.window, baseline)
    const min = p.min_attempts ?? 5
    if (!Number.isInteger(min) || min < 1) throw new Error('min_attempts must be a positive integer')
    const now = new Map(aggregates(p.window, p.task, p.client).map((r) => [key(r), r])), before = new Map(aggregates(baseline, p.task, p.client).map((r) => [key(r), r]))
    const un = userCounts(p.window, p.task, p.client), ub = userCounts(baseline, p.task, p.client)
    const names = new Map(all<{ client: string; name: string }>('SELECT * FROM client_names').map((r) => [r.client, r.name]))
    const catalog = new Map(all<{ task_id: string; name: string }>('SELECT * FROM task_catalog').map((r) => [r.task_id, r.name]))
    const labels = new Map(all<{ dialog: string; name: string }>('SELECT * FROM dialog_names').map((r) => [r.dialog, r.name]))
    const bestPaths = (w: Window) => {
        const map = new Map<string, { path: string; attempts: number }>()
        for (const r of pathRows(w, p.task, p.client, false)) {
            const old = map.get(key(r))
            if (!old || r.attempts > old.attempts || (r.attempts === old.attempts && r.path < old.path)) map.set(key(r), r)
        }
        return map
    }
    const pn = bestPaths(p.window)
    const pb = [...before.keys()].some((k) => !now.has(k)) ? bestPaths(baseline) : new Map<string, { path: string; attempts: number }>()
    const rows: TaskMapRow[] = []
    for (const k of new Set([...now.keys(), ...before.keys()])) {
        const a = now.get(k), b = before.get(k), source = a || b!, n = metrics(a, un.get(k)), prev = metrics(b, ub.get(k))
        const flags: TaskMapRow['flags'] = []
        if (prev.done >= min && n.done === 0) flags.push('missing')
        if (prev.attempts >= min && n.attempts <= prev.attempts * 0.5) flags.push('dropped')
        if (prev.attempts >= min && n.done >= 5 && prev.done >= 5 && n.median_s !== null && prev.median_s !== null && n.median_s >= prev.median_s * 1.3 && n.median_s - prev.median_s >= 10) flags.push('slower')
        if (prev.attempts >= min && n.attempts > 0 && prev.done / prev.attempts - n.done / n.attempts >= 0.15 - 1e-12) flags.push('failing')
        if (!prev.attempts && n.attempts) flags.push('new')
        if (!cover.complete) flags.length = 0 // unprocessed days are not missing work
        const path = (n.attempts ? pn : pb).get(k)?.path
        rows.push({ client: source.client, client_name: names.get(source.client) || source.client, task_id: source.task_id,
            task_name: catalog.get(source.task_id) || appEvents()?.aliases[source.task_id.slice(2)] || labels.get(source.task_id.slice(2)) || source.task_id.slice(2), now: n, before: prev, flags,
            typical_path: path ? (JSON.parse(path) as string[]).map((d) => d === '…' ? d : appEvents()?.aliases[d] || labels.get(d) || d) : [] })
    }
    rows.sort((a, b) => Number(!!b.flags.length) - Number(!!a.flags.length) || b.now.attempts - a.now.attempts || a.client.localeCompare(b.client) || a.task_id.localeCompare(b.task_id))
    const clients = new Map<string, TaskMap['clients'][number]>()
    for (const r of rows) {
        let c = clients.get(r.client)
        if (!c) clients.set(r.client, c = { client: r.client, client_name: r.client_name, attempts_now: 0, attempts_before: 0, tasks_now: 0, tasks_before: 0, missing: 0, slower: 0, score: 0 })
        c.attempts_now += r.now.attempts; c.attempts_before += r.before.attempts
        c.tasks_now += Number(r.now.attempts > 0); c.tasks_before += Number(r.before.attempts > 0)
        c.missing += Number(r.flags.includes('missing')); c.slower += Number(r.flags.includes('slower'))
        c.score += Math.log2(2 + Math.max(r.now.attempts, r.before.attempts)) * r.flags.reduce((s, f) => s + ({ missing: 5, slower: 4, failing: 3, dropped: 2, new: 0 }[f]), 0)
    }
    return { coverage: cover, params: { ...p, baseline }, rows, clients: [...clients.values()].sort((a, b) => b.score - a.score || a.client.localeCompare(b.client)), data_through: dataThrough(), note: note(p.window) }
}

function total(rows: Aggregate[]) {
    const c = { attempts: 0, done: 0, hist: emptyHist() }
    for (const r of rows) { c.attempts += r.attempts; c.done += r.done; merge(c.hist, histogram(r.hist)) }
    return { attempts: c.attempts, done: c.done, done_rate: c.attempts ? c.done / c.attempts : null, median_s: percentile(c.hist, 0.5), p90_s: percentile(c.hist, 0.9) }
}
function series(w: Window, task: string, granularity: 'day' | 'week', client?: string): FlowPoint[] {
    const f = filters(task, client)
    // SQLite weekday 0 is Sunday; subtract to the preceding ISO Monday.
    const period = granularity === 'day' ? 'day' : "date(day, '-' || ((cast(strftime('%w', day) AS INTEGER) + 6) % 7) || ' days')"
    return all<{ period: string; attempts: number; done: number; hist: string }>(`SELECT ${period} AS period, sum(attempts) AS attempts, sum(done) AS done, hist_merge(dur_hist) AS hist
        FROM task_daily WHERE day BETWEEN ? AND ?${f.sql} GROUP BY period ORDER BY period`, w.from, w.to, ...f.args)
        .map((r) => ({ period: r.period, attempts: r.attempts, done: r.done, median_s: percentile(histogram(r.hist), 0.5), p90_s: percentile(histogram(r.hist), 0.9) }))
}
async function computeFlowTime(p: FlowTimeParams): Promise<FlowTime> {
    const days = validWindow(p.window), f = filters(p.task, p.client), granularity = p.granularity ?? (days > 31 ? 'week' : 'day')
    if (granularity !== 'day' && granularity !== 'week') throw new Error('granularity must be day or week')
    const slowestLimit = p.slowest_limit ?? 10
    if (!Number.isInteger(slowestLimit) || slowestLimit < 1 || slowestLimit > 100) throw new Error('slowest_limit must be an integer from 1 to 100')
    const cat = one<{ task_id: string; name: string; dialog: string }>('SELECT task_id, name, dialog FROM task_catalog WHERE task_id = ?', p.task)
    const summary = total(aggregates(p.window, p.task, p.client)), allSummary = p.client === undefined ? summary : total(aggregates(p.window, p.task))
    const users = one<{ n: number }>(`SELECT count(DISTINCT json_array(client, user)) AS n FROM task_users_daily WHERE day BETWEEN ? AND ?${f.sql}`, p.window.from, p.window.to, ...f.args)!.n
    const paths = new Map<string, { path: string; attempts: number; done: number; hist: number[] }>()
    for (const r of pathRows(p.window, p.task, p.client)) {
        let a = paths.get(r.path)
        if (!a) paths.set(r.path, a = { path: r.path, attempts: 0, done: 0, hist: emptyHist() })
        a.attempts += r.attempts; a.done += r.done; merge(a.hist, histogram(r.hist))
    }
    const slow = all<TaskAttempt & { path: string }>(`SELECT * FROM task_attempts WHERE day BETWEEN ? AND ?${f.sql} ORDER BY duration_s DESC, session_id, started_at LIMIT ?`, p.window.from, p.window.to, ...f.args, slowestLimit)
    return { coverage: coverage(p.window), params: { ...p, granularity }, task: cat || { task_id: p.task, dialog: p.task.slice(2), name: label(p.task.slice(2)) },
        client_name: p.client === undefined ? undefined : one<{ name: string }>('SELECT name FROM client_names WHERE client = ?', p.client)?.name || p.client,
        summary: { ...summary, users }, all_clients: { median_s: allSummary.median_s, p90_s: allSummary.p90_s, done_rate: allSummary.done_rate },
        series: series(p.window, p.task, granularity, p.client), series_all: p.client === undefined ? undefined : series(p.window, p.task, granularity),
        paths: [...paths.values()].sort((a, b) => b.attempts - a.attempts || a.path.localeCompare(b.path)).slice(0, 8).map((r) => {
            const path = JSON.parse(r.path) as string[]
            return { path, labels: path.map((d) => d === '…' ? d : label(d)), attempts: r.attempts, share: summary.attempts ? r.attempts / summary.attempts : 0,
                done_rate: r.done / r.attempts, median_s: percentile(r.hist, 0.5) }
        }),
        slowest: slow.map((a) => ({ client: a.client, user: a.user, session_id: a.session_id, started_at: a.started_at, duration_s: a.duration_s,
            outcome: a.outcome, path: JSON.parse(a.path) as string[], labels: (JSON.parse(a.path) as string[]).map((d) => (d === '…' ? d : label(d))), first_error: a.first_error || undefined, replay_url: replayUrl(a.session_id, a.offset_s) })),
        top_errors: all<{ template: string; count: number }>(`SELECT first_error AS template, count(*) AS count FROM task_attempts WHERE day BETWEEN ? AND ?${f.sql} AND first_error IS NOT NULL AND first_error != '' GROUP BY first_error ORDER BY count DESC, first_error LIMIT 5`, p.window.from, p.window.to, ...f.args).map((r) => ({ template: r.template, count: r.count })),
        data_through: dataThrough(), note: note(p.window) }
}
export function findTasks(query: string, limit = 10): Task[] {
    if (typeof query !== 'string' || query.length > 1024) throw new Error('Task search must be a string of at most 1024 characters')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be from 1 to 100')
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const rows = all<Task & { title: string }>(`SELECT c.task_id, c.dialog, c.name, coalesce(d.name, '') AS title,
        coalesce(sum(r.attempts), 0) AS attempts_90d, count(DISTINCT r.client) AS clients_90d
        FROM task_catalog c LEFT JOIN dialog_names d ON d.dialog = c.dialog
        LEFT JOIN task_daily r ON r.task_id = c.task_id AND r.day BETWEEN ? AND ?
        GROUP BY c.task_id ORDER BY attempts_90d DESC, c.task_id`, shift(today(), -89), today())
    return rows.filter((r) => words.every((w) => `${r.name} ${r.dialog} ${r.title}`.toLowerCase().includes(w))).slice(0, limit)
        .map(({ task_id, dialog, name, attempts_90d, clients_90d }) => ({ task_id, dialog, name, attempts_90d, clients_90d }))
}

export type TaskQuery = (query: string, values?: Record<string, unknown>) => Promise<Row[]>
let taskQuery: TaskQuery = hogql
/** A query boundary for offline ingestion tests and maintenance scripts. */
export function setTaskQuery(query: TaskQuery = hogql): void { taskQuery = query }
const EVENT_PAGE = 50_000, MAX_SESSIONS = 100_000, MAX_EVENTS = 3_000_000
// PostHog limits how many queries one key may run (about 240 a minute and 1,200 an hour by default), and
// Lens's other tools share that budget. A day costs one query for its sessions and one per 50,000 events:
// about 4 for a full Reval day (~110,000 events). Sessions are matched on PostHog's $session_id column,
// not inside the properties JSON, which keeps each scan cheap.
const BUSY = new Set([429, 500, 502, 503, 504, 513])
/** Retries a query PostHog was too busy for (rate limit, overload, timeout), waiting longer each time (5 s, 20 s, 60 s). */
export async function patiently<T>(fn: () => Promise<T>, waits = [5_000, 20_000, 60_000]): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await fn()
        } catch (e) {
            const status = (e as { status?: number }).status
            const timedOut = (e as Error).name === 'TimeoutError' // a slow answer under load is "busy" too
            if (i >= waits.length || !(timedOut || (status && BUSY.has(status)))) throw e
            await new Promise((r) => setTimeout(r, waits[i]))
        }
    }
}
/** One UTC day: its sessions (first Reval event that day) with all their events up to the next day's end,
 * so a task started before midnight still finishes. Keyset pages (session, time, uuid) never skip or repeat
 * events that share a timestamp. All scans are bounded; caps are recorded as truncated.
 */
export async function ingestDay(day: string, query: TaskQuery = taskQuery, waits?: number[]): Promise<void> {
    validDay(day)
    const started = performance.now(), reg = required()
    const q: TaskQuery = (text, values) => patiently(() => query(text, values), waits)
    const values = { from: day, to: shift(day, 1), scan_from: shift(day, -1), scan_to: shift(day, 2), events: [reg.events.screen, reg.events.interaction] }
    // Sessions whose first Reval event is on this day (a session from the evening before is not this day's).
    const startedToday = `SELECT $session_id FROM events WHERE timestamp >= {scan_from} AND timestamp < {to} AND event IN {events} AND $session_id != ''
            GROUP BY $session_id HAVING min(timestamp) >= {from} AND min(timestamp) < {to}`
    const ids = await q(`SELECT $session_id AS sid, min(timestamp) AS first_ts, argMin(toFloat(properties.$time), timestamp) AS first_ctime FROM events
            WHERE timestamp >= {scan_from} AND timestamp < {to} AND event IN {events} AND $session_id != ''
            GROUP BY sid HAVING first_ts >= {from} AND first_ts < {to} ORDER BY sid LIMIT ${MAX_SESSIONS}`, values)
    let truncated = ids.length >= MAX_SESSIONS
    const sessions: Step[][] = [], clientNames = new Map<string, string>(), dialogCounts = new Map<string, Map<string, number>>()
    const by = new Map<string, RawEvent[]>()
    let events = 0, sid = '', ts = values.from, uuid = ''
    while (ids.length && events < MAX_EVENTS) {
        const page = await q(`SELECT ${columns(reg)}, toString(uuid) AS event_uuid, ${P.clientName} AS client_name FROM events
                WHERE timestamp >= {from} AND timestamp < {scan_to} AND event IN {events}
                AND $session_id IN (${startedToday})
                AND ($session_id, timestamp, toString(uuid)) > ({sid}, {ts}, {uuid})
                ORDER BY $session_id, timestamp, toString(uuid) LIMIT ${EVENT_PAGE}`, { ...values, sid, ts, uuid })
        events += page.length
        for (const row of page) {
            const e = toRaw(row)
            if (!by.has(e.sid)) by.set(e.sid, [])
            by.get(e.sid)!.push(e)
            if (row.client_name) clientNames.set(e.client || '', String(row.client_name))
            if (e.dialogName && e.dialogName.toUpperCase() !== 'UNKNOWN') {
                if (!dialogCounts.has(e.dialog)) dialogCounts.set(e.dialog, new Map())
                const c = dialogCounts.get(e.dialog)!; c.set(e.dialogName, (c.get(e.dialogName) || 0) + 1)
            }
        }
        if (page.length < EVENT_PAGE) break
        const last = page.at(-1)!, next = [String(last.sid), String(last.ts), String(last.event_uuid)]
        if (next[0] === sid && next[1] === ts && next[2] === uuid) throw new Error('Event pagination did not advance')
        ;[sid, ts, uuid] = next
        if (events >= MAX_EVENTS) truncated = true
    }
    for (const ev of by.values()) sessions.push(toSteps(ev, reg))
    const attempts = extractAttempts(sessions, reg), firsts = new Map(ids.map((r) => [String(r.sid), r]))
    const sessionFirst = new Map(sessions.filter((s) => s.length).map((s) => [s[0].raw.sid, s[0]]))
    for (const a of attempts) {
        a.day = day
        const first = firsts.get(a.session_id)!, step = sessionFirst.get(a.session_id)!
        const ctime = Number(first.first_ctime) * 1000
        a.offset_s += Math.max(0, step.raw.ctime !== undefined && ctime > 0 ? (step.raw.ctime - ctime) / 1000 : (Date.parse(step.ts) - Date.parse(String(first.first_ts))) / 1000)
    }
    const finishes = new Map<string, Map<string, number>>()
    const doneEnds = new Set(attempts.filter((a) => a.outcome === 'done').map((a) => JSON.stringify([a.session_id, a.ended_at, a.task_id])))
    for (const session of sessions) {
        const submits = new Map(session.filter((s) => s.kind === 'submit').map((s) => [s.i, s]))
        for (const s of session) {
            const submit = s.cause === undefined ? undefined : submits.get(s.cause)
            if (!submit || submit.outcome !== s.outcome || (s.outcome !== 'completed' && s.outcome !== 'accepted')) continue
            if (!doneEnds.has(JSON.stringify([s.raw.sid, s.ts, `t_${submit.dialog}`]))) continue
            const task = `t_${submit.dialog}`, finish = `${submit.label} → '${(s.template || s.text || '').replace(/#/g, '…')}'`
            if (!finishes.has(task)) finishes.set(task, new Map())
            const c = finishes.get(task)!; c.set(finish, (c.get(finish) || 0) + 1)
        }
    }
    const dialogNames = new Map([...dialogCounts].map(([d, c]) => [d, [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]]))
    storeAttempts(day, attempts, { sessions: ids.length, events, truncated, seconds: (performance.now() - started) / 1000, clientNames, dialogNames, finishes })
}
let running = false, scheduled = false
function state(key: string, value: string) { run('INSERT OR REPLACE INTO task_state VALUES (?,?)', key, value) }
function failure(day: string, e: unknown) {
    const error = e instanceof Error ? e.message : String(e)
    state('last_error', `${day}: ${error}`)
    console.error(JSON.stringify({ at: new Date().toISOString(), event: 'tasks.ingest_error', day, error }))
}
export async function runIngest(opts: { days?: string[]; maxBackfill?: number } = {}): Promise<void> {
    if (opts.days) opts.days.forEach(validDay)
    if (opts.maxBackfill !== undefined && (!Number.isInteger(opts.maxBackfill) || opts.maxBackfill < 0 || opts.maxBackfill > 400)) throw new Error('maxBackfill must be from 0 to 400')
    if (running) return
    running = true
    state('last_run', new Date().toISOString()); run("DELETE FROM task_state WHERE key = 'last_error'")
    try {
        let days = opts.days
        if (!days) {
            days = [today(), shift(today(), -1)]
            const processed = new Set(all<{ day: string }>('SELECT day FROM task_ingest WHERE truncated = 0').map((r) => r.day))
            let remaining = opts.maxBackfill ?? config.tasks.backfillDaysPerRun
            for (let i = 2; i < config.tasks.historyDays && remaining > 0; i++) {
                const d = shift(today(), -i)
                if (!processed.has(d)) { days.push(d); remaining-- }
            }
        }
        for (const day of new Set(days)) try { await ingestDay(day) } catch (e) { failure(day, e) }
        transaction(() => run('DELETE FROM task_attempts WHERE day < ?', shift(today(), 1 - config.tasks.historyDays)))
        forgetAnswers()
        tasksDb.exec('PRAGMA incremental_vacuum(1000)')
    } finally { running = false }
}
export function ingestStatus(): IngestStatus {
    const s = one<{ n: number; first: string | null; last: string | null; attempts: number }>('SELECT count(*) AS n, min(day) AS first, max(day) AS last, coalesce(sum(attempts), 0) AS attempts FROM task_ingest')!
    const recent = one<{ n: number }>('SELECT count(*) AS n FROM task_ingest WHERE day BETWEEN ? AND ? AND truncated = 0', shift(today(), 1 - config.tasks.historyDays), today())!.n
    return { days_done: s.n, first_day: s.first, last_day: s.last, behind_days: config.tasks.historyDays - recent, attempts: s.attempts,
        last_run: one<{ value: string }>("SELECT value FROM task_state WHERE key = 'last_run'")?.value || null,
        last_error: one<{ value: string }>("SELECT value FROM task_state WHERE key = 'last_error'")?.value || null, running }
}
export function startTaskHistory(): void {
    if (scheduled) return
    scheduled = true
    const tick = async () => {
        try { await runIngest() } catch (e) { failure('scheduler', e) }
        setTimeout(tick, config.tasks.intervalMinutes * 60_000).unref()
    }
    setTimeout(tick, 15_000).unref()
}
