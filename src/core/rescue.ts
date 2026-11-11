// Weekly account-team queue. Reads only Lens history; actions deliberately bypass the answer cache.
import { aggregates, metrics, cached, coverage, dataThrough, validWindow, validDay, tasksDb } from './tasks.ts'
import { all, one, run, tx } from './db.ts'
import { audit } from '../service/access.ts'
import type { Window, Coverage } from './taskstypes.ts'

export const RESCUE = { failing: .15, slower: 1.3, slower_seconds: 10, dropped: .5, activity_drop: .4,
    regular_weeks: 2, users_lost: 2, users_fraction: .3, done_min: 5, activity_min: 20, default_min: 5, urgent: 40, snooze_days: 120, snooze_growth: 1.5 } as const
export const RESCUE_STATUSES = ['open', 'contacted', 'in_progress', 'resolved', 'expected'] as const
export type RescueStatus = typeof RESCUE_STATUSES[number]
export type ReasonKind = 'missing' | 'users_lost' | 'failing' | 'slower' | 'dropped' | 'activity_drop' | 'worse_since_snoozed'
const weights: Record<ReasonKind, number> = { missing: 5, users_lost: 4, failing: 3, slower: 2, dropped: 2, activity_drop: 3, worse_since_snoozed: 0 }
export interface RescueReason { kind: ReasonKind; text: string; task_id?: string; task_name?: string; now: number; before: number;
    evidence?: { users: { user: string; last_seen: string }[]; regular_users: number } }
export interface RescueAction { owner: string | null; status: RescueStatus; note: string | null; due: string | null;
    snooze_until: string | null; score_at_snooze: number | null; updated_by: string; updated_at: string }
export interface RescueClient { client: string; client_name: string; level: 'urgent' | 'watch'; score: number;
    trend: 'new' | 'worse' | 'same' | 'better'; reasons: RescueReason[]; critical_task?: { task_id: string; task_name: string };
    next_step: string; action?: RescueAction }
export interface RescueParams { window?: Window; baseline?: Window; min_attempts?: number; include_snoozed?: boolean }
export interface RescueQueue { coverage: Coverage; window: Window; baseline: Window; data_through: string | null;
    clients: RescueClient[]; hidden_snoozed: number; note: string }
const shift = (s: string, n: number) => new Date(Date.parse(s) + n * 86400000).toISOString().slice(0, 10)
const today = () => new Date().toISOString().slice(0, 10)
const moved = (w: Window): Window => ({ from: shift(w.from, -7), to: shift(w.to, -7) })
const query = <T>(sql: string, ...args: string[]) => tasksDb.prepare(sql).all(...args) as T[]
export function rescueClients(text: string): { id: string; name: string }[] {
    // Resolve against local history as well: a rescue read/write must never query raw events.
    const rows = query<{ id: string; name: string }>(`SELECT DISTINCT d.client AS id, coalesce(n.name, d.client) AS name FROM task_daily d LEFT JOIN client_names n ON n.client=d.client`)
    const exact = rows.filter(r => r.id.toLowerCase() === text.toLowerCase() || r.name.toLowerCase() === text.toLowerCase())
    return exact.length ? exact : rows.filter(r => r.name.toLowerCase().includes(text.toLowerCase()))
}
function nextStep(r: RescueReason): string {
    switch (r.kind) {
        case 'missing': return `Ask the account team whether ${r.task_name} moved elsewhere; open a recent session from before the stop.`
        case 'users_lost': return 'Confirm whether the people left or changed role; offer training to whoever took over.'
        case 'failing': return 'Watch two failed attempts (replay links) and check the first error.'
        case 'slower': return 'Compare the slow path with the usual one on the flow time page.'
        case 'dropped': return `Ask the account team why ${r.task_name} is used less.`
        default: return 'Check in with the client: overall use fell.'
    }
}
function compute(window: Window, baseline: Window, min: number): RescueClient[] {
    const now = new Map(aggregates(window).map(r => [JSON.stringify([r.client, r.task_id]), r]))
    const names = new Map(query<{ client: string; name: string }>('SELECT * FROM client_names').map(r => [r.client, r.name]))
    const tasks = new Map(query<{ task_id: string; name: string }>('SELECT * FROM task_catalog').map(r => [r.task_id, r.name]))
    const clients = new Map<string, { reasons: RescueReason[]; before: number; now: number }>()
    for (const a of now.values()) {
        const c = clients.get(a.client) || { reasons: [], before: 0, now: 0 }; c.now += a.attempts; clients.set(a.client, c)
    }
    for (const b of aggregates(baseline)) {
        const c = clients.get(b.client) || { reasons: [], before: 0, now: 0 }; clients.set(b.client, c); c.before += b.attempts
        const a = now.get(JSON.stringify([b.client, b.task_id])), n = metrics(a), prev = metrics(b)
        const task = { task_id: b.task_id, task_name: tasks.get(b.task_id) || b.task_id.slice(2) }
        const add = (kind: ReasonKind, text: string, now: number, before: number) => c.reasons.push({ kind, text, ...task, now, before })
        const missing = prev.done >= min && n.attempts === 0
        if (missing) add('missing', `Stopped doing ${task.task_name}: ${prev.done} done before, none in the last ${(Date.parse(window.to) - Date.parse(window.from)) / 86400000 + 1} days`, 0, prev.done)
        if (!missing && prev.attempts >= min && n.attempts <= prev.attempts * RESCUE.dropped)
            add('dropped', `${task.task_name} attempts fell from ${prev.attempts} to ${n.attempts}`, n.attempts, prev.attempts)
        if (prev.attempts >= min && n.attempts >= min && prev.done / prev.attempts - n.done / n.attempts >= RESCUE.failing - 1e-12)
            add('failing', `${task.task_name} done rate fell from ${Math.round(prev.done / prev.attempts * 100)}% to ${Math.round(n.done / n.attempts * 100)}%`, n.done / n.attempts, prev.done / prev.attempts)
        if (n.done >= RESCUE.done_min && prev.done >= RESCUE.done_min && n.median_s !== null && prev.median_s !== null && n.median_s >= prev.median_s * RESCUE.slower && n.median_s - prev.median_s >= RESCUE.slower_seconds)
            add('slower', `${task.task_name} takes longer: median ${Math.round(n.median_s)} s, from ${Math.round(prev.median_s)} s`, n.median_s, prev.median_s)
    }
    const regular = query<{ client: string; user: string; last_seen: string; active: number }>(`SELECT b.client, b.user, max(CASE WHEN b.day BETWEEN ? AND ? THEN b.day END) AS last_seen,
        max(CASE WHEN b.day BETWEEN ? AND ? THEN 1 ELSE 0 END) AS active
        FROM task_users_daily b WHERE (b.day BETWEEN ? AND ? OR b.day BETWEEN ? AND ?) AND b.user != ''
        GROUP BY b.client, b.user HAVING count(DISTINCT CASE WHEN b.day BETWEEN ? AND ? THEN strftime('%G-%V', b.day) END) >= ${RESCUE.regular_weeks}`,
        baseline.from, baseline.to, window.from, window.to, baseline.from, baseline.to, window.from, window.to, baseline.from, baseline.to)
    const users = new Map<string, typeof regular>()
    for (const r of regular) { const list = users.get(r.client) || []; list.push(r); users.set(r.client, list) }
    const out: RescueClient[] = []
    for (const [client, c] of clients) {
        const reg = users.get(client) || [], lost = reg.filter(r => !r.active)
        if (lost.length && (lost.length >= RESCUE.users_lost || lost.length / reg.length >= RESCUE.users_fraction)) {
            const last = lost.map(r => r.last_seen).sort().at(-1)!
            const label = new Date(last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
            c.reasons.push({ kind: 'users_lost', text: `${lost.length} of ${reg.length} regular users stopped: last seen ${label}`, now: lost.length, before: reg.length,
                evidence: { users: lost.map(({ user, last_seen }) => ({ user, last_seen })), regular_users: reg.length } })
        }
        if (c.before >= RESCUE.activity_min && c.now <= c.before * (1 - RESCUE.activity_drop))
            c.reasons.push({ kind: 'activity_drop', text: `Overall use fell: ${c.now} attempts, from ${c.before}`, now: c.now, before: c.before })
        if (!c.reasons.length) continue
        c.reasons.sort((a, b) => weights[b.kind] - weights[a.kind] || b.before - a.before || (a.task_id || '').localeCompare(b.task_id || ''))
        const score = c.reasons.reduce((sum, r) => sum + weights[r.kind], 0) * Math.log2(2 + c.before)
        // Urgent at 40 weighted volume points, or any missing task together with lost regular users.
        const urgent = score >= RESCUE.urgent || c.reasons.some(r => r.kind === 'missing') && c.reasons.some(r => r.kind === 'users_lost')
        const first = c.reasons[0]
        out.push({ client, client_name: names.get(client) || client || 'Unknown client', score, level: urgent ? 'urgent' : 'watch', trend: 'new', reasons: c.reasons,
            ...(first.task_id ? { critical_task: { task_id: first.task_id, task_name: first.task_name! } } : {}), next_step: nextStep(first) })
    }
    return out.sort((a, b) => b.score - a.score || a.client.localeCompare(b.client))
}
async function answer(p: RescueParams): Promise<RescueQueue> {
    const through = dataThrough(), to = through || shift(today(), -1), window = p.window || { from: shift(to, -27), to }
    validWindow(window)
    const baseline = p.baseline || { from: shift(window.from, -28), to: shift(window.from, -1) }
    validWindow(baseline)
    const min = p.min_attempts ?? RESCUE.default_min
    if (!Number.isInteger(min) || min < 1 || min > 100000) throw new Error('min_attempts must be an integer from 1 to 100000')
    const cover = coverage(window, baseline)
    const base = { coverage: cover, window, baseline, data_through: through, hidden_snoozed: 0, note: 'Ranked from processed task history. Review the evidence with the account team.' }
    if (!cover.complete) return { ...base, clients: [] }
    const clients = compute(window, baseline, min), pw = moved(window), pb = moved(baseline)
    // An incomplete earlier comparison cannot be evidence of worsening or recovery.
    const previous = coverage(pw, pb).complete ? new Map(compute(pw, pb, min).map(c => [c.client, c.score])) : null
    for (const c of clients) {
        const old = previous?.get(c.client)
        c.trend = old === undefined ? 'new' : c.score > old + 1e-9 ? 'worse' : c.score < old - 1e-9 ? 'better' : 'same'
    }
    return { ...base, clients, ...(!previous ? { note: base.note + ' Earlier comparison is incomplete; trend is new until a prior flag is available.' } : {}) }
}
export async function rescueQueue(p: RescueParams = {}): Promise<RescueQueue> {
    const { include_snoozed, ...params } = p
    if (include_snoozed !== undefined && typeof include_snoozed !== 'boolean') throw new Error('include_snoozed must be boolean')
    const result = await cached('rescue', params, () => answer(params))
    const actions = new Map(all<RescueAction & { client: string }>('SELECT * FROM rescue_actions').map(a => [a.client, a]))
    let hidden_snoozed = 0
    const clients = result.clients.flatMap(c => {
        const action = actions.get(c.client)
        const snoozed = action?.status === 'expected' && !!action.snooze_until && action.snooze_until > today()
        const worse = snoozed && action.score_at_snooze !== null && c.score >= action.score_at_snooze * RESCUE.snooze_growth && c.score > action.score_at_snooze
        if (snoozed && !worse && !include_snoozed) { hidden_snoozed++; return [] }
        return [{ ...c, reasons: worse ? [{ kind: 'worse_since_snoozed' as const, text: 'Worse since snoozed: score rose by at least 50%', now: c.score, before: action!.score_at_snooze! }, ...c.reasons] : c.reasons, ...(action ? { action } : {}) }]
    })
    return { ...result, clients, hidden_snoozed }
}
export class RescueInputError extends Error {}
export async function setRescueAction(client: string, change: Record<string, unknown>, by: string): Promise<RescueAction> {
    if (typeof client !== 'string' || !client.trim() || client.length > 256) throw new RescueInputError('Give a client id of 1–256 characters')
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new RescueInputError('Give an action object')
    if (!Object.keys(change).length || Object.keys(change).some(k => !['owner', 'status', 'note', 'due', 'snooze_until'].includes(k))) throw new RescueInputError('Give owner, status, note, due or snooze_until')
    const old = one<RescueAction>('SELECT * FROM rescue_actions WHERE client=?', client)
    const merged = { owner: null, status: 'open', note: null, due: null, snooze_until: null, ...old, ...change }
    if (merged.owner !== null && (typeof merged.owner !== 'string' || merged.owner.length > 254 || merged.owner && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merged.owner))) throw new RescueInputError('Owner must be an email or empty')
    if (!RESCUE_STATUSES.includes(merged.status as RescueStatus)) throw new RescueInputError('Invalid rescue status')
    if (merged.note !== null && (typeof merged.note !== 'string' || merged.note.length > 500)) throw new RescueInputError('Note must be at most 500 characters')
    for (const key of ['due', 'snooze_until'] as const) if (merged[key] !== null && merged[key] !== '') {
        try { validDay(merged[key] as string) } catch { throw new RescueInputError('Dates must be valid YYYY-MM-DD dates') }
    }
    if (merged.status === 'expected' && (!merged.snooze_until || String(merged.snooze_until) <= today() || String(merged.snooze_until) > shift(today(), RESCUE.snooze_days))) throw new RescueInputError('Expected needs a snooze date within the next 120 days')
    const score = merged.status !== 'expected' ? null : old?.status === 'expected' && old.snooze_until === merged.snooze_until ? old.score_at_snooze : (await rescueQueue({ include_snoozed: true })).clients.find(c => c.client === client)?.score ?? 0
    tx(() => {
        run(`INSERT OR REPLACE INTO rescue_actions VALUES (?,?,?,?,?,?,?,?,?)`, client, (merged.owner as string)?.toLowerCase() || null, merged.status as string,
            merged.note as string | null, merged.due as string || null, merged.snooze_until as string || null, score, by, new Date().toISOString())
        audit(by, 'rescue.updated', { client, ...change })
    })
    return one<RescueAction>('SELECT * FROM rescue_actions WHERE client=?', client)!
}
