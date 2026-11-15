import { ingestMessages } from './ingestmessages.ts'
// Which clients exist, for the anonymisation matcher: every client the task history, Lens's own tables and
// PostHog's durable incremental roster know. Each gets a codename the first time it is seen.
import { syncClients, whenUnknownClient, forgetMatcher } from './anonymise.ts'
import { all } from './db.ts'
import { tasksDb } from './tasks.ts'
import { refreshClientStore, storedClients } from './clientroster.ts'
async function posthogClients() { await refreshClientStore(); return storedClients() }

let last = 0
let lastPosthog = 0
let running: Promise<void> | undefined
// Both sources refresh at most once per minute; PostHog scans only the timestamp overlap.
export async function refreshRoster(maxAgeMs = 60_000, deps: { knownClients: () => Promise<{ id: string; name: string }[]> } = { knownClients: posthogClients }): Promise<void> {
    if (Date.now() - last < maxAgeMs) return
    if (running) return running
    running = (async () => {
        const list: { id: string; name?: string }[] = []
        const safe = (fn: () => { id: string; name?: string }[]) => { try { list.push(...fn()) } catch { /* a missing table is not an error */ } }
        safe(() => (tasksDb.prepare('SELECT client AS id, name FROM client_names').all() as { id: string; name: string }[]))
        safe(() => all<{ id: string }>('SELECT DISTINCT client AS id FROM client_outcomes UNION SELECT client FROM rescue_actions UNION SELECT client FROM client_surveys'))
        if (Date.now() - lastPosthog >= maxAgeMs || maxAgeMs === 0) {
            try {
                const ph = await Promise.race([deps.knownClients(), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 60_000).unref())])
                list.push(...ph.map((c) => ({ id: c.id, name: c.name })))
                lastPosthog = Date.now()
            } catch { /* PostHog unreachable: the clients already known keep their codenames; tried again next time */ }
        }
        safe(storedClients)
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

// Ingestion updates client_names, one of the privacy roster's durable sources.
ingestMessages.on('stored', () => { forgetRoster(); forgetMatcher() })
