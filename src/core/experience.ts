// How a client's people actually experience Reval, from session replays: hesitation, a cursor circling,
// hunting by scrolling, clicks that do nothing, rage clicks, errors that keep coming back, long idle
// stretches. src/core/replaysignals.ts turns one replay into structure-only signals (no values, no text);
// this file decides which replays to read, keeps the signals, and turns them into findings a product
// manager can act on, compared with other clients.
//
// Nothing here stores or returns replay content: only counts, timings and safe element names, per
// session (for replay links) and per client.
import { createHash } from 'node:crypto'

import { snapshotsFile } from './clip.ts'
import { getRecording, hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'
import { signalsFromReplay, type SessionSignals } from './replaysignals.ts'
import { tasksDb } from './tasks.ts'

tasksDb.exec(`
CREATE TABLE IF NOT EXISTS replay_signals(session_id TEXT PRIMARY KEY, client TEXT NOT NULL, user_hash TEXT NOT NULL,
    day TEXT NOT NULL, duration_ms INTEGER NOT NULL, signals TEXT NOT NULL, processed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS replay_signals_client_day ON replay_signals(client, day);
CREATE TABLE IF NOT EXISTS replay_skips(session_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
`)

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const hashUser = (u: string) => createHash('sha256').update('lens-replay:' + u).digest('hex').slice(0, 16)

// ------------------------------------------------------------------ which replays to read
export interface Candidate { session_id: string; client: string; user: string; start: string }
/** Recorded sessions of the last `days` with a client, newest first, not read yet. */
export async function candidates(days = 30, limit = 400, deps = { hogql }): Promise<Candidate[]> {
    const rows = await deps.hogql(`SELECT $session_id AS session_id, any(toString(${P.client})) AS client, any(distinct_id) AS user, min(timestamp) AS start
        FROM events WHERE timestamp > now() - INTERVAL ${Math.max(1, Math.min(90, days))} DAY AND notEmpty($session_id) AND notEmpty(toString(${P.client}))
          AND $session_id IN (SELECT session_id FROM raw_session_replay_events WHERE min_first_timestamp > now() - INTERVAL ${Math.max(1, Math.min(90, days)) + 1} DAY)
        GROUP BY $session_id ORDER BY start DESC LIMIT ${Math.max(1, Math.min(5000, limit * 5))}`, {}, { timeoutMs: 60_000 })
    const done = new Set((tasksDb.prepare('SELECT session_id FROM replay_signals UNION SELECT session_id FROM replay_skips').all() as { session_id: string }[]).map((r) => r.session_id))
    return rows.map((r) => ({ session_id: String(r.session_id), client: String(r.client), user: String(r.user || ''), start: String(r.start) }))
        .filter((c) => c.session_id && c.client && !done.has(c.session_id))
}
/** Round-robin over clients, so every client gets some replays read before any client gets many. */
export function fairOrder(list: Candidate[], perRun: number): Candidate[] {
    const by = new Map<string, Candidate[]>()
    for (const c of list) { const l = by.get(c.client); if (l) l.push(c); else by.set(c.client, [c]) }
    const queues = [...by.values()], out: Candidate[] = []
    for (let i = 0; out.length < perRun && queues.some((q) => q.length); i = (i + 1) % queues.length) { const c = queues[i].shift(); if (c) out.push(c) }
    return out
}

/** Reads up to `perRun` replays and stores their signals. Failures are remembered so they are not retried forever. */
export async function processReplays(perRun = 30, deps: { candidates?: typeof candidates; jsonl?: (id: string) => Promise<string>; durationMs?: (id: string) => Promise<number | undefined> } = {}): Promise<{ read: number; skipped: number }> {
    const list = fairOrder(await (deps.candidates || candidates)(), perRun)
    const read = deps.jsonl || (async (id: string) => (await import('node:fs')).readFileSync(await snapshotsFile(id), 'utf8'))
    // PostHog's recorder pauses while nobody moves: the session's real length comes from its metadata.
    const length = deps.durationMs || (async (id: string) => { try { return Math.round(Number((await getRecording(id)).recording_duration) * 1000) || undefined } catch { return undefined } })
    let ok = 0, skipped = 0
    for (const c of list) {
        try {
            const s = signalsFromReplay(await read(c.session_id), await length(c.session_id))
            if (s.duration_ms < 5_000) throw new Error('too short')
            tasksDb.prepare('INSERT OR REPLACE INTO replay_signals VALUES (?,?,?,?,?,?,?)').run(c.session_id, c.client, hashUser(c.user), day(Date.parse(c.start)), Math.round(s.duration_ms), JSON.stringify(s), new Date().toISOString())
            ok++
        } catch (e) {
            const reason = String((e as Error).message || e).slice(0, 120)
            // A recording still being written gets another chance later; everything else is skipped for good.
            if (!/no stored snapshots yet/i.test(reason)) tasksDb.prepare('INSERT OR REPLACE INTO replay_skips VALUES (?,?,?)').run(c.session_id, reason, new Date().toISOString())
            skipped++
        }
    }
    return { read: ok, skipped }
}

let timer: NodeJS.Timeout | undefined, running = false
/** Every 15 minutes (REPLAY_SIGNALS=off turns it off; REPLAY_SIGNALS_PER_RUN sets the batch). */
export function startReplaySignals(): void {
    if (process.env.REPLAY_SIGNALS === 'off' || timer) return
    const per = Math.max(1, Math.min(200, Number(process.env.REPLAY_SIGNALS_PER_RUN) || 30))
    const round = async () => { if (running) return; running = true; try { await processReplays(per) } catch { /* PostHog unreachable: next round */ } finally { running = false } }
    setTimeout(() => void round(), 60_000).unref()
    timer = setInterval(() => void round(), 15 * 60_000); timer.unref()
}

// ------------------------------------------------------------------ per client
interface Stored { session_id: string; client: string; user_hash: string; day: string; duration_ms: number; s: SessionSignals }
function stored(from: string, to: string, client?: string): Stored[] {
    const rows = (client
        ? tasksDb.prepare('SELECT * FROM replay_signals WHERE client=? AND day BETWEEN ? AND ?').all(client, from, to)
        : tasksDb.prepare('SELECT * FROM replay_signals WHERE day BETWEEN ? AND ?').all(from, to)) as { session_id: string; client: string; user_hash: string; day: string; duration_ms: number; signals: string }[]
    return rows.flatMap((r) => { try { return [{ ...r, s: JSON.parse(r.signals) as SessionSignals }] } catch { return [] } })
}

/** The measures, per hour of active use (or per session), so short and long sessions compare fairly. */
export const MEASURES = {
    rage: { label: 'Rage clicks', unit: 'per hour', worse: 'higher', floor: 2, of: (x: Stored) => perHour(x, x.s.rage_clicks.length) },
    dead: { label: 'Clicks that do nothing', unit: 'per hour', worse: 'higher', floor: 4, of: (x: Stored) => perHour(x, x.s.dead_clicks.length) },
    errors: { label: 'Errors shown', unit: 'per session', worse: 'higher', floor: 1, of: (x: Stored) => x.s.errors_shown.length },
    loops: { label: 'Error loops (fix, retry, fail again)', unit: 'per session', worse: 'higher', floor: 0.5, of: (x: Stored) => x.s.error_loops.reduce((a, l) => a + l.count, 0) },
    hesitation: { label: 'Long hesitations before acting', unit: 'per hour', worse: 'higher', floor: 3, of: (x: Stored) => perHour(x, x.s.hesitations.length) },
    circling: { label: 'Cursor circling (searching the screen)', unit: 'per hour', worse: 'higher', floor: 3, of: (x: Stored) => perHour(x, x.s.cursor.circling_bursts) },
    hunting: { label: 'Scrolling up and down to find something', unit: 'per hour', worse: 'higher', floor: 3, of: (x: Stored) => perHour(x, x.s.scroll.hunting_bursts) },
    idle: { label: 'Idle share of the session', unit: '%', worse: 'higher', floor: 35, of: (x: Stored) => x.s.duration_ms ? 100 * x.s.idle_ms / x.s.duration_ms : 0 },
    failures: { label: 'Failed or slow server calls', unit: 'per session', worse: 'higher', floor: 1, of: (x: Stored) => x.s.network_errors + x.s.slow_calls },
} as const
export type MeasureKey = keyof typeof MEASURES
function perHour(x: Stored, n: number) { const h = Math.max(x.s.active_ms, 60_000) / 3_600_000; return n / h }
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const round1 = (n: number) => Math.round(n * 10) / 10

export interface Finding { measure: MeasureKey; label: string; client: number; peers: number | null; unit: string; severity: 'high' | 'medium'; text: string; where: string[]; replays: { url: string; why: string }[] }
export interface ClientExperience {
    client: string; window: { from: string; to: string }
    sessions: number; people: number; active_minutes: number
    verdict: 'smooth' | 'some friction' | 'struggling' | 'not enough replays'
    summary: string
    findings: Finding[]
    measures: { key: MeasureKey; label: string; client: number; peers: number | null; unit: string }[]
    hotspots: { where: string; what: string; count: number }[]
    next_steps: string[]
    usage: Usage
    note: string
}
export interface Usage { sessions: number; people: number; completed_work: number; before: { sessions: number; people: number; completed_work: number }; change_pct: number | null; text: string }
/** Are they using it: sessions, people (daily average) and completed work, against the period before. */
export function usageOf(client: string, from: string, to: string): Usage {
    const len = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
    const pf = day(Date.parse(from) - len * 86_400_000), pt = day(Date.parse(from) - 86_400_000)
    const sum = (a: string, b: string) => tasksDb.prepare('SELECT coalesce(sum(sessions),0) AS sessions, coalesce(max(users),0) AS people, coalesce(sum(productive_done),0) AS done FROM client_daily WHERE client=? AND day BETWEEN ? AND ?').get(client, a, b) as { sessions: number; people: number; done: number }
    const now = sum(from, to), before = sum(pf, pt)
    const change = before.done ? Math.round(100 * (now.done / before.done - 1)) : null
    const text = !now.sessions ? 'No use recorded in this period.' : `${now.sessions} sessions, up to ${now.people} people a day, ${now.done} pieces of work completed${change === null ? '' : ` (${change >= 0 ? '+' : ''}${change}% against the ${len} days before)`}.`
    return { sessions: now.sessions, people: now.people, completed_work: now.done, before: { sessions: before.sessions, people: before.people, completed_work: before.done }, change_pct: change, text }
}

const MIN_SESSIONS = 3, MIN_PEER_CLIENTS = 3
/** Findings for one client: measures well above other clients' typical value (or above a fixed floor when there are too few peers). */
export function clientExperience(client: string, opts: { days?: number; now?: number } = {}): ClientExperience {
    const days = Math.max(7, Math.min(90, opts.days ?? 28)), to = day(opts.now ?? Date.now()), from = day((opts.now ?? Date.now()) - (days - 1) * 86_400_000)
    const all = stored(from, to), mine = all.filter((x) => x.client === client)
    const others = new Map<string, Stored[]>()
    for (const x of all) if (x.client !== client) { const l = others.get(x.client); if (l) l.push(x); else others.set(x.client, [x]) }
    const peerClients = [...others.values()].filter((l) => l.length >= MIN_SESSIONS)
    const base: ClientExperience = { client, window: { from, to }, sessions: mine.length, people: new Set(mine.map((x) => x.user_hash)).size, active_minutes: Math.round(mine.reduce((a, x) => a + x.s.active_ms, 0) / 60_000), verdict: 'not enough replays', summary: '', findings: [], measures: [], hotspots: [], next_steps: [], usage: usageOf(client, from, to), note: '' }
    base.note = `From ${mine.length} replay${mine.length === 1 ? '' : 's'} read in ${from} to ${to}; compared with ${peerClients.length} other client${peerClients.length === 1 ? '' : 's'}. Structure only: no values, typed text or on-screen text were read.`
    if (mine.length < MIN_SESSIONS) {
        base.summary = `Only ${mine.length} replay${mine.length === 1 ? '' : 's'} read for this client so far; findings need at least ${MIN_SESSIONS}.`
        base.next_steps = ['Check again after more replays are read (Lens reads new replays every 15 minutes).']
        return base
    }
    for (const key of Object.keys(MEASURES) as MeasureKey[]) {
        const m = MEASURES[key]
        const value = median(mine.map(m.of))
        const peers = peerClients.length >= MIN_PEER_CLIENTS ? median(peerClients.map((l) => median(l.map(m.of)))) : null
        base.measures.push({ key, label: m.label, client: round1(value), peers: peers === null ? null : round1(peers), unit: m.unit })
        const above = value >= m.floor && (peers === null ? value >= 2 * m.floor : value >= Math.max(1.5 * peers, peers + m.floor / 2))
        if (!above) continue
        const severity: Finding['severity'] = peers !== null ? (value >= 3 * Math.max(peers, m.floor / 2) ? 'high' : 'medium') : value >= 3 * m.floor ? 'high' : 'medium'
        const worst = [...mine].sort((a, b) => m.of(b) - m.of(a)).slice(0, 3)
        const hit = mine.filter((x) => m.of(x) >= m.floor / 2 && m.of(x) > 0).length
        const perSession = m.unit === 'per hour' ? median(mine.map((x) => m.of(x) * Math.max(x.s.active_ms, 60_000) / 3_600_000)) : value
        const shown = m.unit === '%' ? `${Math.round(value)}% of the time` : `about ${perSession >= 10 ? Math.round(perSession) : round1(perSession)} per session`
        base.findings.push({ measure: key, label: m.label, client: round1(value), peers: peers === null ? null : round1(peers), unit: m.unit, severity,
            text: `${m.label} in ${hit} of ${mine.length} sessions, ${shown}${peers !== null ? (peers === 0 ? '; other clients: almost never' : `; other clients: ${round1(peers)} ${m.unit}`) : ''}.`,
            where: whereOf(key, mine), replays: worst.map((x) => ({ url: replayUrl(x.session_id, Math.max(0, momentOf(key, x) / 1000 - 5)), why: `${round1(m.of(x))} ${m.unit}` })) })
    }
    base.findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1))
    base.hotspots = hotspots(mine)
    const high = base.findings.filter((f) => f.severity === 'high').length
    base.verdict = !base.findings.length ? 'smooth' : high || base.findings.length >= 3 ? 'struggling' : 'some friction'
    base.summary = !base.findings.length
        ? `Their people work smoothly: no measure stands out from other clients in ${mine.length} replays.`
        : `${base.verdict === 'struggling' ? 'Struggling' : 'Some friction'}: ${base.findings.slice(0, 3).map((f) => f.label.toLowerCase() + (f.where[0] ? ` (mostly ${f.where[0]})` : '')).join('; ')}.`
    base.next_steps = nextSteps(base.findings)
    return base
}

function momentOf(key: MeasureKey, x: Stored): number {
    const s = x.s
    const first = key === 'rage' ? s.rage_clicks[0]?.at_ms : key === 'dead' ? s.dead_clicks[0]?.at_ms : key === 'errors' || key === 'loops' ? s.errors_shown[0]?.at_ms : key === 'hesitation' ? s.hesitations[0]?.at_ms : undefined
    return first ?? 0
}
/** A safe element name as a person would say it: "field:counterparty" -> "the Counterparty field". */
export function humanName(target: string | undefined): string | undefined {
    if (!target) return undefined
    const words = (t: string) => t.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/\b\w/g, (c) => c.toUpperCase())
    let m: RegExpExecArray | null
    if ((m = /^field:(.+)$/.exec(target))) return `the ${words(m[1])} field`
    if ((m = /^(?:button|a|input)[#.:](.+)$/.exec(target))) return `the ${words(m[1])} button`
    if (/banner|alert|error|toast/i.test(target)) return 'the error message'
    if ((m = /^[a-z]+[#.:](.+)$/.exec(target))) return words(m[1])
    return target === 'button' ? 'a button' : target === 'field' ? 'a field' : target
}
function count(items: (string | undefined)[]): string[] {
    const m = new Map<string, number>()
    for (const raw of items) { const i = humanName(raw); if (i) m.set(i, (m.get(i) || 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k)
}
function whereOf(key: MeasureKey, xs: Stored[]): string[] {
    switch (key) {
        case 'rage': return count(xs.flatMap((x) => x.s.rage_clicks.map((r) => r.target)))
        case 'dead': return count(xs.flatMap((x) => x.s.dead_clicks.map((r) => r.target)))
        case 'errors': return count(xs.flatMap((x) => x.s.errors_shown.map((r) => r.target)))
        case 'loops': return count(xs.flatMap((x) => x.s.error_loops.map((r) => r.field)))
        case 'hesitation': return count(xs.flatMap((x) => x.s.hesitations.map((r) => r.before)))
        default: return []
    }
}
function hotspots(xs: Stored[]): ClientExperience['hotspots'] {
    const m = new Map<string, { where: string; what: string; count: number }>()
    const add = (raw: string | undefined, what: string, n = 1) => { const where = humanName(raw); if (!where) return; const k = what + '|' + where; const h = m.get(k); if (h) h.count += n; else m.set(k, { where, what, count: n }) }
    for (const x of xs) {
        for (const r of x.s.rage_clicks) add(r.target, 'rage clicks', r.count)
        for (const r of x.s.dead_clicks) add(r.target, 'clicks that do nothing')
        for (const l of x.s.error_loops) add(l.field, 'error loops', l.count)
        // Buttons can take focus too; only real fields count here.
        for (const f of x.s.fields) if (f.focus_count >= 3 && !/^field:(save|submit|ok|cancel|close|apply|preview|search|run)$/i.test(f.field)) add(f.field, 'coming back to the same field')
    }
    return [...m.values()].sort((a, b) => b.count - a.count).slice(0, 6)
}
function nextSteps(f: Finding[]): string[] {
    const out: string[] = []
    const has = (k: MeasureKey) => f.find((x) => x.measure === k)
    if (has('loops') || has('errors')) out.push(`Watch the first error replay${has('loops')?.where[0] ? ` (${has('loops')!.where[0]})` : ''}: does the message say clearly what to fix? If several clients loop on the same field, raise it with the team that owns that dialog.`)
    if (has('rage') || has('dead')) out.push(`A button that seems not to respond${(has('rage') || has('dead'))!.where[0] ? ` (${(has('rage') || has('dead'))!.where[0]})` : ''}: check whether it is slow or disabled without saying why.`)
    if (has('circling') || has('hunting') || has('hesitation')) out.push('People search the screen before acting: offer a short walkthrough of the workflow, or ask them in-app what they were looking for (Rescue queue → Send survey).')
    if (has('idle')) out.push('Long idle stretches inside sessions: they may be waiting on something outside Reval (approvals, data). Ask the account team.')
    if (has('failures')) out.push('Server calls fail or are slow for them: check the System page and the error tools for their sessions.')
    return out.slice(0, 3)
}

/** Across all clients: where friction gathers (button or field), for "what should we fix first". */
export function frictionHotspots(opts: { days?: number; now?: number } = {}): { where: string; what: string; count: number; clients: number }[] {
    const days = Math.max(7, Math.min(90, opts.days ?? 28)), to = day(opts.now ?? Date.now()), from = day((opts.now ?? Date.now()) - (days - 1) * 86_400_000)
    const m = new Map<string, { where: string; what: string; count: number; clients: Set<string> }>()
    for (const x of stored(from, to)) for (const h of hotspots([x])) {
        const k = h.what + '|' + h.where; const e = m.get(k)
        if (e) { e.count += h.count; e.clients.add(x.client) } else m.set(k, { where: h.where, what: h.what, count: h.count, clients: new Set([x.client]) })
    }
    return [...m.values()].map((e) => ({ where: e.where, what: e.what, count: e.count, clients: e.clients.size })).sort((a, b) => b.clients - a.clients || b.count - a.count).slice(0, 15)
}
export const replayCoverage = () => tasksDb.prepare('SELECT count(*) AS sessions, count(DISTINCT client) AS clients, max(processed_at) AS last FROM replay_signals').get() as { sessions: number; clients: number; last: string | null }
