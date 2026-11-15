// Works out which client and which screen a ticket is about, from PostHog's own data.
// Clients are the `client_id` / `client_name` super properties the app registers on every event,
// so this works for any product that tags events that way, not just the demo.
import { SCREENS, type Screen } from './catalog.ts'
import { hogql } from './posthog.ts'
import { containsPhrase, tokens } from './text.ts'
import { P } from './props.ts'

export interface ClientMatch {
    id: string
    name: string
    confidence: number // 0..1
    via: 'email' | 'email-domain' | 'name' | 'id'
    events_90d: number
}

export interface KnownClient {
    id: string
    name: string
    events: number
}

export async function knownClients(): Promise<KnownClient[]> {
    const { refreshRoster } = await import('./anonroster.ts')
    const { storedClients } = await import('./clientroster.ts')
    await refreshRoster()
    // Event counts from Lens's own daily rollups (no PostHog scan): shown with each candidate.
    const { tasksDb } = await import('./tasks.ts')
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
    const events = new Map((tasksDb.prepare('SELECT client, sum(events) AS n FROM user_daily WHERE day >= ? GROUP BY client').all(since) as { client: string; n: number }[]).map((r) => [r.client, Number(r.n) || 0]))
    return storedClients().map((c) => ({ id: c.id, name: c.name || c.id, events: events.get(c.id) || 0 })).sort((a, b) => b.events - a.events || a.id.localeCompare(b.id))
}

/** Which client(s) a person with this email has used the product as. */
export async function clientsForEmail(email: string): Promise<{ id: string; name: string; events: number }[]> {
    const rows = await hogql(
        `SELECT toString(${P.client}) AS id, any(toString(${P.clientName})) AS name, count() AS events
         FROM events
         WHERE timestamp > now() - INTERVAL 90 DAY
           AND (lower(toString(${P.email})) = {email} OR lower(distinct_id) = {email})
           AND notEmpty(toString(${P.client}))
         GROUP BY id ORDER BY events DESC LIMIT 5`,
        { email: email.toLowerCase() }
    )
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), events: Number(r.events) }))
}

async function clientsForDomain(domain: string): Promise<{ id: string; name: string; events: number }[]> {
    const rows = await hogql(
        `SELECT toString(${P.client}) AS id, any(toString(${P.clientName})) AS name, count() AS events
         FROM events
         WHERE timestamp > now() - INTERVAL 90 DAY
           AND endsWith(lower(toString(${P.email})), {domain})
           AND notEmpty(toString(${P.client}))
         GROUP BY id ORDER BY events DESC LIMIT 5`,
        { domain: '@' + domain.toLowerCase() }
    )
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), events: Number(r.events) }))
}

/** Scores how well free text names a client. Pure, so it is unit-tested. */
export function scoreClientName(text: string, client: { id: string; name: string }): number {
    const hay = tokens(text)
    const nameToks = tokens(client.name)
    if (!nameToks.length) return 0
    if (containsPhrase(hay, nameToks)) return 1
    if (hay.includes(client.id.toLowerCase())) return 0.95
    // Partial: the first, most distinctive word of the name ("Brightwater" for "Brightwater Logistics").
    const hits = nameToks.filter((t) => t.length > 2 && hay.includes(t))
    if (!hits.length) return 0
    const lead = hay.includes(nameToks[0]) ? 0.25 : 0
    return Math.min(0.9, 0.45 + lead + (0.2 * hits.length) / nameToks.length)
}

export async function resolveClient(input: { text: string; emails?: string[]; clientHint?: string }): Promise<ClientMatch[]> {
    const out = new Map<string, ClientMatch>()
    const add = (m: ClientMatch) => {
        const prev = out.get(m.id)
        if (!prev || prev.confidence < m.confidence) out.set(m.id, m)
    }

    for (const email of input.emails || []) {
        const byEmail = await clientsForEmail(email)
        // An email is the strongest evidence: it is added first, and a name match never displaces it.
        for (const c of byEmail) add({ ...c, confidence: 1, via: 'email', events_90d: c.events })
        if (!byEmail.length) {
            const domain = email.split('@')[1]
            for (const c of domain ? await clientsForDomain(domain) : []) {
                add({ ...c, confidence: 0.85, via: 'email-domain', events_90d: c.events })
            }
        }
    }

    const all = await knownClients()
    const text = [input.clientHint, input.text].filter(Boolean).join(' ')
    for (const c of all) {
        const score = scoreClientName(text, c)
        // An id that is also a word of the name ("nordlicht") reads better as a name match.
        const viaId = score === 0.95 && !tokens(c.name).includes(c.id.toLowerCase())
        if (score >= 0.5) add({ id: c.id, name: c.name, confidence: score, via: viaId ? 'id' : 'name', events_90d: c.events })
        // An explicit hint (a structured Jira field) that names the id exactly wins outright.
        if (input.clientHint && input.clientHint.trim().toLowerCase() === c.id) {
            add({ id: c.id, name: c.name, confidence: 1, via: 'id', events_90d: c.events })
        }
    }
    return [...out.values()].sort((a, b) => b.confidence - a.confidence || b.events_90d - a.events_90d)
}

export interface ScreenMatch {
    path: string
    name: string
    confidence: number
}

/** Maps ticket words to a screen. Pure, so it is unit-tested. */
export function resolveScreen(text: string, screens: Screen[] = SCREENS): ScreenMatch[] {
    const hay = tokens(text, { keepStop: true })
    const raw = text.toLowerCase()
    const out: ScreenMatch[] = []
    for (const s of screens) {
        let score = 0
        if (raw.includes(s.path)) score = 1
        else if (containsPhrase(hay, tokens(s.name, { keepStop: true }))) score = 0.9
        else {
            for (const alias of s.aliases) {
                const a = tokens(alias, { keepStop: true })
                if (containsPhrase(hay, a)) score = Math.max(score, a.length > 1 ? 0.8 : 0.6)
            }
        }
        if (score > 0) out.push({ path: s.path, name: s.name, confidence: score })
    }
    return out.sort((a, b) => b.confidence - a.confidence)
}
