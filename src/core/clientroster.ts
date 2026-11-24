// One durable roster shared by anonymisation and name resolution.
import { tasksDb } from './tasks.ts'
import { rollback } from './sqlitetx.ts'
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
// A full scan reads up to 1500 days in slices: one GROUP BY over four years (~400M events) takes minutes and
// always hit the 60 s query timeout, so the roster stayed empty and every lookup waited and found nothing.
export const ROSTER_SLICE_DAYS = 90
let running: Promise<void> | undefined, fullRunning: Promise<void> | undefined
const upsert = (list: RosterClient[]) => {
    const insert = tasksDb.prepare(`INSERT INTO client_roster VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' AND excluded.last_seen >= last_seen THEN excluded.name ELSE name END,
        last_seen = max(last_seen,excluded.last_seen)`)
    for (const c of list) insert.run(c.id, c.name, c.last_seen)
}
async function scanSlice(since: Date, until: Date): Promise<RosterClient[]> {
    let cursor = ''
    const list: RosterClient[] = []
    for (;;) {
        const page = await hogql(`SELECT toString(${P.client}) AS id, argMax(toString(${P.clientName}), timestamp) AS name, max(timestamp) AS last_seen FROM events
            WHERE timestamp >= {since} AND timestamp < {until} AND notEmpty(toString(${P.client})) AND toString(${P.client}) > {cursor}
            GROUP BY id ORDER BY id LIMIT 10000`, { since: since.toISOString(), until: until.toISOString(), cursor }, { timeoutMs: 60_000 })
        list.push(...page.map((r) => ({ id: String(r.id), name: String(r.name || ''), last_seen: new Date(String(r.last_seen || until.toISOString())).toISOString() })))
        if (page.length < 10000) break
        const next = String(page.at(-1)!.id)
        if (next <= cursor) throw new Error('Roster pagination did not advance')
        cursor = next
    }
    return list
}
export async function scanClients(full: boolean, now = new Date()): Promise<void> {
    const watermark = state('roster:scanned')
    const since = full || !watermark ? new Date(+now - 1500 * 86400000) : new Date(Date.parse(watermark) - OVERLAP_MS)
    // Newest slice first; each slice is stored as it arrives (the upsert merges), the watermarks only at the end.
    for (let until = now; until > since;) {
        const from = new Date(Math.max(+since, +until - ROSTER_SLICE_DAYS * 86400000))
        const list = await scanSlice(from, until)
        tasksDb.exec('BEGIN')
        try { upsert(list); tasksDb.exec('COMMIT') } catch (e) { rollback(tasksDb); throw e }
        until = from
    }
    tasksDb.exec('BEGIN')
    try {
        // Never move the incremental watermark backwards when a background full scan finishes.
        if (now.toISOString() > state('roster:scanned')) save('roster:scanned', now.toISOString())
        if (full) save('roster:full', now.toISOString())
        tasksDb.exec('COMMIT')
    } catch (e) { rollback(tasksDb); throw e }
}
/** An empty roster with task history (a new install after its backfill, or a restored database): every client
 * with sessions is already in client_names, with its last active day. Seed from that and scan PostHog only from
 * the end of that history; the full scan then runs in the background instead of blocking a request. */
function seedFromHistory(): boolean {
    const rows = tasksDb.prepare(`SELECT n.client AS id, n.name AS name, max(d.day) AS day FROM client_names n
        JOIN client_daily d ON d.client = n.client WHERE n.client != '' GROUP BY n.client`).all() as { id: string; name: string; day: string }[]
    if (!rows.length) return false
    const through = rows.map((r) => r.day).sort().at(-1)!
    tasksDb.exec('BEGIN')
    try {
        upsert(rows.map((r) => ({ id: r.id, name: r.name || '', last_seen: `${r.day}T00:00:00.000Z` })))
        if (!state('roster:scanned')) save('roster:scanned', new Date(Date.parse(through) + 86400000).toISOString())
        tasksDb.exec('COMMIT')
    } catch (e) { rollback(tasksDb); throw e }
    return true
}
export async function refreshClientStore(): Promise<void> {
    if (running) return running
    running = (async () => {
        const empty = !tasksDb.prepare('SELECT 1 FROM client_roster LIMIT 1').get() && !seedFromHistory()
        // Only a store that knows no client at all blocks a request on a full historical scan.
        await scanClients(empty)
        const days = Number(process.env.LENS_ROSTER_FULL_RESCAN_DAYS || 7)
        const interval = (Number.isFinite(days) && days >= 1 ? days : 7) * 86400000
        if (!empty && Date.now() - Date.parse(state('roster:full') || '1970-01-01') >= interval && !fullRunning) {
            fullRunning = scanClients(true).catch(() => { /* keep previous names and retry next refresh */ }).finally(() => { fullRunning = undefined })
        }
    })().finally(() => { running = undefined })
    return running
}
