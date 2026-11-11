// Explainable client signals from processed history. Identities never leave this module.
import { cached, coverage, dataThrough, tasksDb, validDay } from './tasks.ts'
import { config } from './config.ts'
import type { Coverage } from './taskstypes.ts'

export const SIGNALS = {
    key_share: .30, key_weeks: 6, key_gap_days: 3, key_min_users: 3, key_recent_days: 14,
    key_baseline_days: 56, key_completed_ratio: .75, key_weight: 4,
    export_recent_days: 28, export_baseline_days: 84, export_share_delta: .15, export_share_ratio: 1.5,
    export_min: 10, export_days: 3, export_done_drop: .25, export_after_error: 3, export_weight: 3,
    close_days: 180, close_months: 3, close_last_days: 5, close_first_days: 3, close_weight: 3, close_concentration: 2,
    giving_recent_days: 14, giving_baseline_days: 56, giving_rate: .40, giving_min: 4, giving_delta: .20, giving_weight: 3,
} as const
export type SignalKind = 'key_person_gap' | 'work_moving_out' | 'recurring_close_error' | 'giving_up'
export interface Signal {
    kind: SignalKind; client: string; client_name: string; text: string; weight: number
    evidence: Record<string, number | number[]>
    tasks?: string[]
    next_close_start?: string
    task_id?: string; dialog?: string; template?: string
}
export interface ClientSignals { coverage: Coverage; to: string; signals: Signal[] }
const shift = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10)
const query = <T>(sql: string, ...args: string[]) => tasksDb.prepare(sql).all(...args) as T[]
const pct = (x: number) => Math.round(x * 100)
const atLeast = (x: number, y: number) => x >= y - 1e-12
function closeMonth(day: string): number | undefined {
    const d = new Date(day), n = d.getUTCDate()
    if (n <= SIGNALS.close_first_days) d.setUTCDate(0)
    else if (n < new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - SIGNALS.close_last_days + 1) return
    return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1
}
function nextClose(to: string): string {
    const d = new Date(to)
    let start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1 - SIGNALS.close_last_days)).toISOString().slice(0, 10)
    if (start <= to) start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1 - SIGNALS.close_last_days)).toISOString().slice(0, 10)
    return start
}
export function clientSignals(p: { to?: string; client?: string } = {}): Promise<ClientSignals> {
    return cached('signals', p, async () => compute(p))
}
function compute(p: { to?: string; client?: string }): ClientSignals {
    const to = p.to ?? dataThrough() ?? shift(new Date().toISOString().slice(0, 10), -1)
    validDay(to)
    if (p.client !== undefined && (typeof p.client !== 'string' || p.client.length > 256)) throw new Error('Client must be a string of at most 256 characters')
    const from = shift(to, 1 - SIGNALS.close_days)
    // v1 processed days lack captures, and task rollups survive capture retention.
    const missingCaptures = query<{ key: string }>("SELECT key FROM task_state WHERE key LIKE 'signals_missing:%'")
        .map(r => r.key.slice('signals_missing:'.length))
    const captureCoverage = (begin: string): Coverage => {
        const c = coverage({ from: begin, to })
        const missing = [...new Set([...c.unprocessed, ...missingCaptures.filter(d => d >= begin && d <= to)])].sort()
        return missing.length ? { complete: false, unprocessed: missing, text: 'Some days lack complete signal captures. Re-ingest these days before using their client signals.' } : c
    }
    const cover = captureCoverage(from)
    const ready = (days: number) => captureCoverage(shift(to, 1 - days)).complete
    const keyReady = ready(SIGNALS.key_baseline_days + SIGNALS.key_recent_days + 1),
        exportReady = ready(SIGNALS.export_baseline_days + SIGNALS.export_recent_days),
        givingReady = ready(SIGNALS.giving_baseline_days + SIGNALS.giving_recent_days)
    const suffix = p.client === undefined ? '' : ' AND client = ?', args = p.client === undefined ? [] : [p.client]
    const names = new Map(query<{ client: string; name: string }>('SELECT * FROM client_names').map(r => [r.client, r.name]))
    const people = query<{ day: string; client: string; user: string; events: number; completed: number }>(`SELECT * FROM user_daily WHERE day BETWEEN ? AND ?${suffix} ORDER BY day`, from, to, ...args)
    // Templates and task titles can contain user-supplied text. Remove known identity forms too.
    const identityForms = (user: string) => {
        const person = user.split(config.properties.distinctIdSeparator).at(-1) || ''
        return [user, person, person.split('@')[0]].filter(Boolean)
    }
    const identities = new Set(people.flatMap(r => identityForms(r.user)))
    for (const r of query<{ user: string }>(`SELECT DISTINCT user FROM task_users_daily WHERE day BETWEEN ? AND ?${suffix}`, from, to, ...args)) {
        for (const token of identityForms(r.user)) identities.add(token)
    }
    const tokens = [...identities].sort((a, b) => b.length - a.length)
    const safe = (s: string) => {
        s = s.replace(/[^\s<>"']+@[^\s<>"']+/g, '[person]')
        for (const token of tokens) s = s.split(token).join('[person]')
        return s
    }
    const out: Signal[] = []
    const add = (kind: SignalKind, client: string, text: string, weight: number, evidence: Signal['evidence'], extra: Partial<Signal> = {}) =>
        out.push({ kind, client, client_name: safe(names.get(client) || client || 'Unknown client'), text: safe(text), weight, evidence, ...extra })
    if (keyReady) {
        const end = shift(to, -SIGNALS.key_recent_days - 1), begin = shift(end, 1 - SIGNALS.key_baseline_days), recent = shift(to, 1 - SIGNALS.key_recent_days)
        const clients = new Map<string, { completed: number; recent: number; users: Map<string, { completed: number; days: string[]; active: number }> }>()
        for (const r of people) {
            if (r.day < begin) continue
            let c = clients.get(r.client)
            if (!c) { c = { completed: 0, recent: 0, users: new Map() }; clients.set(r.client, c) }
            let u = c.users.get(r.user)
            if (!u) { u = { completed: 0, days: [], active: 0 }; c.users.set(r.user, u) }
            if (r.day <= end) { c.completed += r.completed; u.completed += r.completed; if (r.events > 0 && r.user) u.days.push(r.day) }
            if (r.day >= recent) { c.recent += r.completed; u.active += r.events }
        }
        for (const [client, c] of clients) {
            if (!c.completed || [...c.users.values()].filter(u => u.days.length).length < SIGNALS.key_min_users || c.recent > c.completed / SIGNALS.key_baseline_days * SIGNALS.key_recent_days * SIGNALS.key_completed_ratio) continue
            for (const [user, u] of c.users) {
                if (!user || u.active || !atLeast(u.completed / c.completed, SIGNALS.key_share)) continue
                const weeks = new Set(u.days.map(d => { const dt = new Date(d); return shift(d, -((dt.getUTCDay() + 6) % 7)) }))
                const gaps = u.days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(u.days[i])) / 86400000).sort((a, b) => a - b)
                const median = gaps.length ? (gaps[Math.floor((gaps.length - 1) / 2)] + gaps[Math.floor(gaps.length / 2)]) / 2 : Infinity
                if (weeks.size < SIGNALS.key_weeks || median > SIGNALS.key_gap_days) continue
                const tasks = query<{ name: string }>(`SELECT c.name FROM task_users_daily u JOIN task_catalog c USING(task_id)
                    WHERE u.client = ? AND u.user IN (?, ?) AND u.day BETWEEN ? AND ? GROUP BY u.task_id ORDER BY count(*) DESC, u.task_id LIMIT 3`, client, user, user.split(config.properties.distinctIdSeparator).at(-1) || '', begin, end).map(r => safe(r.name))
                const drop = 1 - c.recent / (c.completed / SIGNALS.key_baseline_days * SIGNALS.key_recent_days)
                add('key_person_gap', client, `One person did ${pct(u.completed / c.completed)}% of their completed work; no activity from them for 14+ days and completed work is down ${pct(drop)}%.`, SIGNALS.key_weight,
                    { share: u.completed / c.completed, baseline_completed: c.completed, recent_completed: c.recent, active_weeks: weeks.size, median_gap_days: median, inactive_days: 14 }, { tasks })
            }
        }
    }
    if (exportReady) {
        const recent = shift(to, 1 - SIGNALS.export_recent_days), begin = shift(recent, -SIGNALS.export_baseline_days)
        const rows = query<{ client: string; period: number; exports: number; days: number; done: number; after_error: number }>(`SELECT client, day >= ? AS period, sum(export_chains) AS exports,
            sum(export_chains > 0) AS days, sum(productive_done) AS done, sum(export_after_error) AS after_error FROM client_daily
            WHERE day BETWEEN ? AND ?${suffix} GROUP BY client, period`, recent, begin, to, ...args)
        const productive = new Map(query<{ client: string; period: number; n: number }>(`SELECT client, day >= ? AS period, sum(submits) AS n FROM ops_daily
            WHERE family = 'productive' AND day BETWEEN ? AND ?${suffix} GROUP BY client, period`, recent, begin, to, ...args).map(r => [JSON.stringify([r.client, r.period]), r.n]))
        for (const n of rows.filter(r => r.period === 1)) {
            const b = rows.find(r => r.client === n.client && r.period === 0)
            const bs = b ? b.exports / (b.exports + (productive.get(JSON.stringify([n.client, 0])) || 0) || 1) : 0
            const ns = n.exports / (n.exports + (productive.get(JSON.stringify([n.client, 1])) || 0) || 1)
            const drop = b?.done ? 1 - n.done / SIGNALS.export_recent_days / (b.done / SIGNALS.export_baseline_days) : 0
            if (n.exports < SIGNALS.export_min || n.days < SIGNALS.export_days || !atLeast(ns, bs + SIGNALS.export_share_delta) || !atLeast(ns, bs * SIGNALS.export_share_ratio) || (!atLeast(drop, SIGNALS.export_done_drop) && n.after_error < SIGNALS.export_after_error)) continue
            add('work_moving_out', n.client, `Exports went from ${pct(bs)}% to ${pct(ns)}% of their work ${atLeast(drop, SIGNALS.export_done_drop) ? `while completed work fell ${pct(drop)}%` : `and ${n.after_error} exports came right after an error`}.`, SIGNALS.export_weight,
                { baseline_share: bs, recent_share: ns, exports: n.exports, export_days: n.days, completed_drop: drop, export_after_error: n.after_error })
        }
    }
    const errors = query<{ day: string; client: string; dialog: string; op: string; template: string; chains: number; unrecovered: number }>(`SELECT * FROM errors_daily WHERE day BETWEEN ? AND ?${suffix}`, from, to, ...args)
    // Recurring close errors count closes in whatever older history is processed: a missing day can only
    // hide an occurrence, never invent one. Only the recent 28 days must be complete, so the finding is current.
    if (ready(28)) {
        // Concentrated at close: per processed day, the error must be at least SIGNALS.close_concentration times as
        // frequent inside close windows as outside them (an error that happens every day is not a close problem).
        const groups = new Map<string, { row: typeof errors[number]; months: Set<number>; inClose: number; outside: number }>()
        for (const row of errors) {
            if (!row.chains) continue
            const month = closeMonth(row.day)
            const key = JSON.stringify([row.client, row.dialog, row.op, row.template])
            const g = groups.get(key) || { row, months: new Set<number>(), inClose: 0, outside: 0 }
            if (month) { g.months.add(month); g.inClose += row.chains } else g.outside += row.chains
            groups.set(key, g)
        }
        const processed = query<{ day: string }>('SELECT day FROM task_ingest WHERE day BETWEEN ? AND ? AND truncated = 0', from, to).map(r => r.day)
        const closeDays = processed.filter(d => closeMonth(d)).length, otherDays = processed.length - closeDays
        const concentrated = (g: { inClose: number; outside: number }) => !g.outside || !otherDays || !closeDays
            || atLeast((g.inClose / closeDays) / (g.outside / otherDays), SIGNALS.close_concentration)
        const dialogs = new Map(query<{ dialog: string; name: string }>('SELECT * FROM dialog_names').map(r => [r.dialog, r.name]))
        for (const g of groups.values()) if (g.months.size >= SIGNALS.close_months && concentrated(g)) { const { row, months } = g
            add('recurring_close_error', row.client, `The same error at ${months.size} month-ends: "${row.template}" on ${dialogs.get(row.dialog) || row.dialog}`, SIGNALS.close_weight,
                { months: [...months].sort(), month_count: months.size }, { next_close_start: nextClose(to), task_id: safe(`t_${row.dialog}`), dialog: safe(row.dialog), template: safe(row.template) }) }
    }
    if (givingReady) {
        const recent = shift(to, 1 - SIGNALS.giving_recent_days), begin = shift(recent, -SIGNALS.giving_baseline_days)
        const sums = new Map<string, { nc: number; nu: number; bc: number; bu: number }>()
        for (const r of errors) {
            if (r.day < begin) continue
            const s = sums.get(r.client) || { nc: 0, nu: 0, bc: 0, bu: 0 }
            if (r.day >= recent) { s.nc += r.chains; s.nu += r.unrecovered } else { s.bc += r.chains; s.bu += r.unrecovered }
            sums.set(r.client, s)
        }
        for (const [client, s] of sums) if (s.nu >= SIGNALS.giving_min && atLeast(s.nu / s.nc, SIGNALS.giving_rate) && atLeast(s.nu / s.nc, (s.bc ? s.bu / s.bc : 0) + SIGNALS.giving_delta))
            add('giving_up', client, `After an error, users gave up ${s.nu} of ${s.nc} times (was ${s.bu} of ${s.bc}).`, SIGNALS.giving_weight,
                { unrecovered: s.nu, chains: s.nc, baseline_unrecovered: s.bu, baseline_chains: s.bc }, (() => {
                    const row = errors.filter(r => r.client === client && r.day >= recent).sort((a,b) => b.unrecovered - a.unrecovered || a.dialog.localeCompare(b.dialog))[0]
                    return row ? { task_id: safe(`t_${row.dialog}`), dialog: safe(row.dialog) } : {}
                })())
    }
    return { coverage: cover, to, signals: out.sort((a, b) => b.weight - a.weight || a.client.localeCompare(b.client) || a.kind.localeCompare(b.kind)) }
}
