// One durable roster shared by anonymisation and name resolution.
import { tasksDb } from './tasks.ts'
import { hogql } from './posthog.ts'
import { P } from './props.ts'
export interface RosterClient { id: string; name: string; last_seen: string }
const state = (key: string) => String(tasksDb.prepare('SELECT value FROM task_state WHERE key = ?').get(key)?.value || '')
const save = (key: string, value: string) => tasksDb.prepare('INSERT OR REPLACE INTO task_state VALUES (?,?)').run(key, value)
export const storedClients = (): RosterClient[] => tasksDb.prepare('SELECT id,name,last_seen FROM client_roster ORDER BY last_seen DESC,id').all() as unknown as RosterClient[]
// Events can reach PostHog late with their original timestamps (an app sending from an offline buffer, an
// ingestion delay). Each refresh re-reads two days so a client first seen that way is still found before
// its name could reach an AI; the weekly full scan is only the backstop. Two days is ~0.5M events at
// 100M a year: well under a second.
const OVERLAP_MS = 2 * 86400000
let running: Promise<void> | undefined, fullRunning: Promise<void> | undefined
export async function scanClients(full: boolean, now = new Date()): Promise<void> {
    const watermark = state('roster:scanned')
    const since = full || !watermark ? new Date(+now - 400 * 86400000) : new Date(Date.parse(watermark) - OVERLAP_MS)
    let cursor = ''
    const list: RosterClient[] = []
    for (;;) {
        const page = await hogql(`SELECT toString(${P.client}) AS id, argMax(toString(${P.clientName}), timestamp) AS name, max(timestamp) AS last_seen FROM events
            WHERE timestamp >= {since} AND timestamp < {until} AND notEmpty(toString(${P.client})) AND toString(${P.client}) > {cursor}
            GROUP BY id ORDER BY id LIMIT 10000`, { since: since.toISOString(), until: now.toISOString(), cursor }, { timeoutMs: 60_000 })
        list.push(...page.map((r) => ({ id: String(r.id), name: String(r.name || ''), last_seen: new Date(String(r.last_seen || now.toISOString())).toISOString() })))
        if (page.length < 10000) break
        const next = String(page.at(-1)!.id)
        if (next <= cursor) throw new Error('Roster pagination did not advance')
        cursor = next
    }
    tasksDb.exec('BEGIN')
    try {
        const insert = tasksDb.prepare(`INSERT INTO client_roster VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' AND excluded.last_seen >= last_seen THEN excluded.name ELSE name END,
            last_seen = max(last_seen,excluded.last_seen)`)
        for (const c of list) insert.run(c.id, c.name, c.last_seen)
        // Never move the incremental watermark backwards when a background full scan finishes.
        if (now.toISOString() > state('roster:scanned')) save('roster:scanned', now.toISOString())
        if (full) save('roster:full', now.toISOString())
        tasksDb.exec('COMMIT')
    } catch (e) { tasksDb.exec('ROLLBACK'); throw e }
}
export async function refreshClientStore(): Promise<void> {
    if (running) return running
    running = (async () => {
        const empty = !tasksDb.prepare('SELECT 1 FROM client_roster LIMIT 1').get()
        // Only an empty store blocks a request on a full historical scan.
        await scanClients(empty)
        const days = Number(process.env.LENS_ROSTER_FULL_RESCAN_DAYS || 7)
        const interval = (Number.isFinite(days) && days >= 1 ? days : 7) * 86400000
        if (!empty && Date.now() - Date.parse(state('roster:full') || '1970-01-01') >= interval && !fullRunning) {
            fullRunning = scanClients(true).catch(() => { /* keep previous names and retry next refresh */ }).finally(() => { fullRunning = undefined })
        }
    })().finally(() => { running = undefined })
    return running
}
