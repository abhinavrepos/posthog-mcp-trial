// Which clients exist, for the anonymisation matcher: every client the task history, Lens's own tables and
// PostHog's last 90 days of events know. Each gets a codename the first time it is seen.
import { syncClients, whenUnknownClient } from './anonymise.ts'
import { all } from './db.ts'
import { hogql } from './posthog.ts'
import { P } from './props.ts'
import { tasksDb } from './tasks.ts'

/** Every client in PostHog's events of the last 400 days, however many (not just the busiest). */
async function posthogClients(): Promise<{ id: string; name: string }[]> {
    const rows = await hogql(`SELECT toString(${P.client}) AS id, any(toString(${P.clientName})) AS name FROM events
        WHERE timestamp > now() - INTERVAL 400 DAY AND notEmpty(toString(${P.client})) GROUP BY id LIMIT 200000`, {}, { timeoutMs: 60_000 })
    return rows.map((r) => ({ id: String(r.id), name: String(r.name || '') }))
}

let last = 0
let lastPosthog = 0
let running: Promise<void> | undefined
// Lens's own tables every minute; PostHog's full list every five minutes, and again at once after a failure.
export async function refreshRoster(maxAgeMs = 60_000, deps: { knownClients: () => Promise<{ id: string; name: string }[]> } = { knownClients: posthogClients }): Promise<void> {
    if (Date.now() - last < maxAgeMs) return
    if (running) return running
    running = (async () => {
        const list: { id: string; name?: string }[] = []
        const safe = (fn: () => { id: string; name?: string }[]) => { try { list.push(...fn()) } catch { /* a missing table is not an error */ } }
        safe(() => (tasksDb.prepare('SELECT client AS id, name FROM client_names').all() as { id: string; name: string }[]))
        safe(() => all<{ id: string }>('SELECT DISTINCT client AS id FROM client_outcomes UNION SELECT client FROM rescue_actions UNION SELECT client FROM client_surveys'))
        if (Date.now() - lastPosthog >= Math.max(maxAgeMs, 5 * 60_000) || maxAgeMs === 0) {
            try {
                const ph = await Promise.race([deps.knownClients(), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 60_000).unref())])
                list.push(...ph.map((c) => ({ id: c.id, name: c.name })))
                lastPosthog = Date.now()
            } catch { /* PostHog unreachable: the clients already known keep their codenames; tried again next time */ }
        }
        // Names first: a later id-only row must not hide a name.
        syncClients(list.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0)))
        last = Date.now()
    })().finally(() => { running = undefined })
    return running
}
export const forgetRoster = () => { last = 0; lastPosthog = 0 }
// A client Lens has no codename for showed up in an answer: look for new clients now (at most once a minute).
let lastUnknown = 0
whenUnknownClient(() => { if (Date.now() - lastUnknown > 60_000) { lastUnknown = Date.now(); void refreshRoster(0).catch(() => {}) } })
