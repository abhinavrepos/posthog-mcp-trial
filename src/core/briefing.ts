import { newClientValues } from './newclients.ts'
// A saved, deterministic daily briefing. No raw events or individual identities.
import { rescuePrivacy } from './rescueprivacy.ts'
import { all, one, run, tx } from './db.ts'
import { aggregates, coverage, tasksDb } from './tasks.ts'
import { rescueQueue, type RescueAction } from './rescue.ts'
import { clientSignals } from './signals.ts'

const shift = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10)
export interface BriefItem { client: string; client_name: string; text: string; open: string; score?: number }
// Every rescue/signal reason kind has a column, so a flagged client never shows an empty row.
export const GRID_COLUMNS: readonly (readonly [string, string, readonly string[]])[] = [
    ['missing', 'Stopped tasks', ['missing', 'dropped']], ['activity_drop', 'Less use', ['activity_drop']],
    ['users_lost', 'Users stopped', ['users_lost']], ['key_person_gap', 'Key person gone', ['key_person_gap']],
    ['failing', 'Failing', ['failing']], ['giving_up', 'Giving up', ['giving_up']], ['slower', 'Slower', ['slower']],
    ['peer_gap', 'Behind others', ['peer_gap', 'not_established']], ['work_moving_out', 'Exports up', ['work_moving_out']],
    ['recurring_close_error', 'Close errors', ['recurring_close_error']], ['trend', 'Trend', []],
]
/** Bumped when saved briefings must be rebuilt (new headline or columns). */
export const BRIEF_VERSION = 2
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
export function briefHeadline(c: { queue?: number; urgent?: number; new_or_worse?: number; overdue?: number; recovered?: number }): string {
    const need = c.queue ?? 0
    return `${plural(need, 'client needs', 'clients need')} someone${c.urgent ? ` (${c.urgent} urgent)` : ''}. Since your last briefing: ${c.new_or_worse ?? 0} new or worse, ${plural(c.overdue ?? 0, 'action')} overdue, ${plural(c.recovered ?? 0, 'recovery', 'recoveries')}.`
}
export interface BriefGridRow { client: string; client_name: string; score: number; level?: 'urgent' | 'watch'; open: string; cells: { column: string; mark: string; label: string }[] }
export interface MondayBrief {
    version?: number
    grid?: BriefGridRow[]
    generated_at: string; period: { from: string; to: string }; headline: string
    sections: { new_clients?: BriefItem[]; new_or_worse: BriefItem[]; close_soon: BriefItem[]; overdue: BriefItem[]; recovered: BriefItem[]; quiet_review: BriefItem | null }
    counts: Record<string, number>; queue_scores: Record<string, number>; verified_recoveries: string[]
}
const link = (client: string, extra: Record<string, string> = {}) => '/replays/dashboards?' + new URLSearchParams({ view: 'rescue', client, ...extra })
// Coalesce simultaneous visits as well as sequential reloads.
const pending = new Map<string, Promise<MondayBrief>>()
export function mondayBrief({ by, now = new Date() }: { by: string; now?: Date }): Promise<MondayBrief> {
    by = by.trim().toLowerCase()
    const day = now.toISOString().slice(0, 10), key = `${by}:${day}`
    const saved = one<{ payload: string }>('SELECT payload FROM briefing_snapshots WHERE "by"=? AND substr(created_at,1,10)=?', by, day)
    if (saved) {
        const value = JSON.parse(saved.payload) as MondayBrief
        if (value.version === BRIEF_VERSION && value.grid) return Promise.resolve(value)
        if (pending.has(key)) return pending.get(key)!
        // Older saved briefings are rebuilt against the previous saved one, keeping the personal diff.
        const rebuild = build(by, now, true).finally(() => pending.delete(key))
        pending.set(key, rebuild)
        return rebuild
    }
    if (pending.has(key)) return pending.get(key)!
    const work = build(by, now).finally(() => pending.delete(key))
    pending.set(key, work)
    return work
}
async function portfolio(to: string, quiet: BriefItem | null): Promise<BriefGridRow[]> {
    const q = await rescueQueue({ window: { from: shift(to, -27), to }, include_snoozed: true })
    const signals = await clientSignals({ to })
    const clients = new Map(q.clients.map(c => [c.client, { client: c.client, client_name: c.client_name, score: c.score, level: c.level as 'urgent' | 'watch' | undefined, reasons: c.reasons.map(r => ({ kind: String(r.kind), text: r.text })), trend: c.trend as string }]))
    for (const s of signals.signals) if (!clients.has(s.client)) clients.set(s.client, { client: s.client, client_name: s.client_name, score: 0, level: 'watch' as const, reasons: signals.signals.filter(x => x.client === s.client).map(x => ({ kind: x.kind, text: x.text })), trend: 'signal only' })
    if (quiet && !clients.has(quiet.client)) clients.set(quiet.client, { client: quiet.client, client_name: quiet.client_name, score: 0, level: undefined, reasons: [], trend: 'quiet review' })
    return [...clients.values()].sort((a,b) => b.score-a.score || a.client.localeCompare(b.client)).map(c => ({ client: c.client, client_name: c.client_name, score: c.score, ...(c.level ? { level: c.level } : {}),
        open: link(c.client, { view: 'story' }), cells: GRID_COLUMNS.map(([kind, label, kinds]) => {
            if (kind === 'trend') return { column: kind, mark: c.trend, label: `Trend: ${c.trend}` }
            const reasons = c.reasons.filter(r => kinds.includes(r.kind))
            return { column: kind, mark: reasons.length ? '●' : '–', label: reasons.length ? `Yes: ${reasons.map(r => r.text).join('; ')}` : `${label}: ${q.coverage.complete && signals.coverage.complete ? 'not flagged' : 'not flagged or insufficient history'}` }
        }) }))
}
async function build(by: string, now: Date, replaceToday = false): Promise<MondayBrief> {
    const day = now.toISOString().slice(0, 10), period = { from: shift(day, -7), to: shift(day, -1) }
    const previous = one<{ payload: string }>('SELECT payload FROM briefing_snapshots WHERE "by"=? AND substr(created_at,1,10)<? ORDER BY created_at DESC,id DESC LIMIT 1', by, day)
        ?? (replaceToday ? undefined : one<{ payload: string }>('SELECT payload FROM briefing_snapshots WHERE "by"=? ORDER BY created_at DESC,id DESC LIMIT 1', by))
    const old: MondayBrief | undefined = previous ? JSON.parse(previous.payload) : undefined
    const queue = await rescueQueue({ window: period, include_snoozed: true })
    const signals = await clientSignals({ to: period.to })
    const actions = all<RescueAction & { client: string }>('SELECT * FROM rescue_actions')
    const names = new Map((tasksDb.prepare('SELECT client,name FROM client_names').all() as { client: string; name: string }[]).map(c => [c.client, c.name]))
    const item = (client: string, text: string): BriefItem => ({ client, client_name: names.get(client) || client, text, open: link(client, { from: period.from, to: period.to }) })
    const changed = queue.clients.filter(c => old?.queue_scores[c.client] === undefined || c.score > old.queue_scores[c.client] + 1e-9)
    const new_or_worse = changed.slice(0, 5).map(c => ({ ...item(c.client, c.reasons[0].text), score: c.score }))
    const close_soon = signals.signals.filter(s => s.kind === 'recurring_close_error' && s.next_close_start! >= day && s.next_close_start! <= shift(day, 14))
        .map(s => ({ ...item(s.client, `${s.text}; next close from ${s.next_close_start}`), open: link(s.client, { view: 'flow_time', task: s.task_id || '', from: period.from, to: period.to }) }))
    const overdue = actions.filter(a => a.due && a.due < day && !['resolved', 'expected'].includes(a.status)).sort((a,b) => a.due!.localeCompare(b.due!) || a.client.localeCompare(b.client))
        .map(a => item(a.client, `Due ${a.due}: ${a.status.replaceAll('_', ' ')}`))
    const recoveries = [...(queue.recovered || []), ...queue.clients.filter(c => c.recovery === 'recovered')]
    const recovered = recoveries.filter(c => !old?.verified_recoveries?.includes(c.client))
        .map(c => ({ ...item(c.client, c.recovery_text!), open: link(c.client, { history: '1', from: period.from, to: period.to }) }))
    let quiet_review: BriefItem | null = null
    const baseline = { from: shift(period.from, -7), to: shift(period.from, -1) }
    if (coverage(period, baseline).complete) {
        const current = new Map<string, number>(), before = new Map<string, number>()
        for (const a of aggregates(period)) current.set(a.client, (current.get(a.client) || 0) + a.attempts)
        for (const a of aggregates(baseline)) before.set(a.client, (before.get(a.client) || 0) + a.attempts)
        const reviews = new Map(actions.map(a => [a.client, a.updated_at]))
        for (const s of all<{ payload: string; created_at: string }>('SELECT payload,created_at FROM briefing_snapshots')) {
            const c = (JSON.parse(s.payload) as MondayBrief).sections.quiet_review?.client
            if (c && (!reviews.has(c) || reviews.get(c)! < s.created_at)) reviews.set(c, s.created_at)
        }
        const candidates = [...current].filter(([c,n]) => n > 0 && n < 20 && (before.get(c) || 0) > 0 && n / before.get(c)! >= .8 && n / before.get(c)! <= 1.2 && !queue.clients.some(r => r.client === c))
            .sort(([a],[b]) => (reviews.get(a) || '').localeCompare(reviews.get(b) || '') || a.localeCompare(b))
        if (candidates.length) quiet_review = item(candidates[0][0], `Steady low use: ${candidates[0][1]} attempts this week, ${before.get(candidates[0][0])} before; silence is not satisfaction. Check whether their work is going well.`)
    }
    const new_clients = (await newClientValues(period.to)).slice(0,5).map(c => ({ ...item(c.client,c.text),open:link(c.client,{view:'story'}) }))
    const grid = await portfolio(period.to, quiet_review)
    const counts = { urgent: grid.filter(r => r.level === 'urgent').length, new_clients: new_clients.length, new_or_worse: changed.length, close_soon: close_soon.length, overdue: overdue.length, recovered: recovered.length, quiet_review: quiet_review ? 1 : 0, queue: grid.filter(r => r.level).length }
    const result: MondayBrief = { version: BRIEF_VERSION, grid, generated_at: now.toISOString(), period, headline: queue.coverage.complete ? briefHeadline(counts) : 'History is incomplete; review overdue actions while evidence is being processed.', sections: { new_clients, new_or_worse, close_soon, overdue, recovered, quiet_review }, counts, verified_recoveries: recoveries.map(c => c.client), queue_scores: Object.fromEntries(queue.clients.map(c => [c.client,c.score])) }
    const sanitized = await rescuePrivacy(result)
    return tx(() => {
        if (replaceToday) run('DELETE FROM briefing_snapshots WHERE "by"=? AND substr(created_at,1,10)=?', by, day)
        run('INSERT OR IGNORE INTO briefing_snapshots ("by",created_at,payload) VALUES (?,?,?)', by, result.generated_at, JSON.stringify(sanitized))
        run('DELETE FROM briefing_snapshots WHERE "by"=? AND id NOT IN (SELECT id FROM briefing_snapshots WHERE "by"=? ORDER BY created_at DESC,id DESC LIMIT 26)', by, by)
        return JSON.parse(one<{ payload: string }>('SELECT payload FROM briefing_snapshots WHERE "by"=? AND substr(created_at,1,10)=?', by, day)!.payload) as MondayBrief
    })
}
