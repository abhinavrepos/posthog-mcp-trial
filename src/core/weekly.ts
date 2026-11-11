// Weekly observations: for a week end W, the rescue reasons (28 days to W against the 28 before) and the client
// signals (to W) of every client, computed once and kept in the history database. Replays such as the signal
// scorecard and client stories read them instead of recomputing a year of weeks on every request. Storing a day
// drops the observations of weeks ending on or after it (src/core/tasks.ts), so they are recomputed when needed.
import { coverage, historyGeneration, tasksDb } from './tasks.ts'
import { rescueWindow, type RescueReason } from './rescue.ts'
import { clientSignals } from './signals.ts'

export interface WeekRow { client: string; source: 'reason' | 'signal'; kind: string; key: string; text: string }
export interface WeekObservation { week_end: string; complete: boolean; signals_complete: boolean; rows: WeekRow[] }
const shift = (s: string, n: number) => new Date(Date.parse(s) + n * 86_400_000).toISOString().slice(0, 10)
/** Signal kinds come from clientSignals; the rescue reasons of those kinds are not stored twice. */
export const SIGNAL_KINDS = new Set(['key_person_gap', 'work_moving_out', 'recurring_close_error', 'giving_up'])
export const reasonKey = (r: Pick<RescueReason, 'kind'> & { task_id?: string; dialog?: string; template?: string }) =>
    JSON.stringify([r.kind, r.task_id || '', r.dialog || '', r.template || ''])
export const periodsOf = (w: string) => ({ window: { from: shift(w, -27), to: w }, baseline: { from: shift(w, -55), to: shift(w, -28) } })

const pending = new Map<string, Promise<WeekObservation>>()
export function weekObservation(w: string): Promise<WeekObservation> {
    const { window, baseline } = periodsOf(w)
    if (!coverage(window, baseline).complete) return Promise.resolve({ week_end: w, complete: false, signals_complete: false, rows: [] })
    const done = tasksDb.prepare('SELECT signals_complete FROM week_done WHERE week_end = ?').get(w) as { signals_complete: number } | undefined
    if (done) return Promise.resolve({ week_end: w, complete: true, signals_complete: !!done.signals_complete,
        rows: tasksDb.prepare('SELECT client, source, kind, key, text FROM week_obs WHERE week_end = ?').all(w) as unknown as WeekRow[] })
    let p = pending.get(w)
    if (!p) {
        p = (async () => {
            const before = historyGeneration()
            const [clients, signals] = [await rescueWindow(window, baseline), await clientSignals({ to: w })]
            const rows: WeekRow[] = [
                ...clients.flatMap((c) => c.reasons.filter((r) => !SIGNAL_KINDS.has(r.kind)).map((r) => ({ client: c.client, source: 'reason' as const, kind: r.kind, key: reasonKey(r), text: r.text }))),
                ...signals.signals.map((s) => ({ client: s.client, source: 'signal' as const, kind: s.kind, key: reasonKey(s as never), text: s.text })),
            ]
            // History changed while computing: answer, but do not keep a possibly stale observation.
            if (historyGeneration() !== before) return { week_end: w, complete: true, signals_complete: signals.coverage.complete, rows }
            const insert = tasksDb.prepare('INSERT OR REPLACE INTO week_obs VALUES (?,?,?,?,?,?)')
            tasksDb.exec('BEGIN IMMEDIATE')
            try {
                tasksDb.prepare('DELETE FROM week_obs WHERE week_end = ?').run(w)
                for (const r of rows) insert.run(w, r.client, r.source, r.kind, r.key, r.text)
                tasksDb.prepare('INSERT OR REPLACE INTO week_done VALUES (?,?,?)').run(w, new Date().toISOString(), signals.coverage.complete ? 1 : 0)
                tasksDb.exec('COMMIT')
            } catch (e) { tasksDb.exec('ROLLBACK'); throw e }
            return { week_end: w, complete: true, signals_complete: signals.coverage.complete, rows }
        })().finally(() => pending.delete(w))
        pending.set(w, p)
    }
    return p
}
