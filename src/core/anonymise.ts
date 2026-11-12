// Client anonymisation for AI. Off by default; a Lens admin switches it on (Admin → Client privacy for AI).
// When on, every client name and client code that would reach an AI is replaced by the client's codename
// ("Amber Falcon"), and codenames coming back from the AI are turned into the real client inside Lens:
//   - Lens's MCP server (src/mcp/anonymise.ts wraps both transports: every message in and out)
//   - the PostHog MCP proxy (src/mcp/posthog-proxy.ts): data commands refused, or filtered (admin's choice)
//   - Claude's ticket triage (src/core/triage.ts)
// People see real names only in the Lens web app, where /replays/codenames lists who is who.
// Codenames are random words (never derived from the name), stable, unique, and editable by admins.
import { randomInt } from 'node:crypto'

import { all, getSetting, one, run, setSetting, tx } from './db.ts'

export type PosthogMode = 'block' | 'filter'
export const anonymiseOn = (): boolean => getSetting<boolean>('anon_ai', false) === true
export const posthogMode = (): PosthogMode => (getSetting<string>('anon_posthog', 'block') === 'filter' ? 'filter' : 'block')
export function setAnonymise(p: { on?: boolean; posthog?: string }): void {
    if (p.on !== undefined) setSetting('anon_ai', !!p.on)
    if (p.posthog !== undefined) {
        if (p.posthog !== 'block' && p.posthog !== 'filter') throw new AnonInputError('PostHog mode is block or filter.')
        setSetting('anon_posthog', p.posthog)
    }
    bump()
}
export class AnonInputError extends Error {}

// ------------------------------------------------------------------ codenames
const ADJ = ['Amber', 'Azure', 'Bold', 'Brisk', 'Calm', 'Clear', 'Cobalt', 'Coral', 'Crimson', 'Crisp', 'Dawn', 'Deep', 'Dusky', 'Eager', 'Early', 'Even',
    'Fair', 'Fern', 'Fleet', 'Gentle', 'Gilded', 'Golden', 'Granite', 'Hazel', 'High', 'Honey', 'Indigo', 'Ivory', 'Jade', 'Keen', 'Kind', 'Lilac',
    'Lively', 'Lucky', 'Lunar', 'Maple', 'Mellow', 'Misty', 'Noble', 'Ochre', 'Olive', 'Opal', 'Pale', 'Pearl', 'Plum', 'Proud', 'Quiet', 'Rapid',
    'Rosy', 'Ruby', 'Rustic', 'Sable', 'Saffron', 'Scarlet', 'Silent', 'Silver', 'Slate', 'Snowy', 'Solar', 'Steady', 'Swift', 'Tawny', 'Velvet', 'Vivid']
const NOUN = ['Badger', 'Bison', 'Condor', 'Crane', 'Dolphin', 'Eagle', 'Egret', 'Falcon', 'Ferret', 'Finch', 'Fox', 'Gazelle', 'Gecko', 'Heron', 'Ibis', 'Jackal',
    'Jaguar', 'Kestrel', 'Kingfisher', 'Koala', 'Lark', 'Lemur', 'Leopard', 'Lynx', 'Magpie', 'Marten', 'Meerkat', 'Moose', 'Narwhal', 'Newt', 'Ocelot', 'Orca',
    'Oriole', 'Osprey', 'Otter', 'Owl', 'Panda', 'Panther', 'Pelican', 'Penguin', 'Petrel', 'Puffin', 'Puma', 'Quail', 'Raven', 'Robin', 'Salmon', 'Seal',
    'Sparrow', 'Stork', 'Swallow', 'Swan', 'Tapir', 'Tern', 'Tiger', 'Toucan', 'Trout', 'Turtle', 'Viper', 'Walrus', 'Weasel', 'Wolf', 'Wren', 'Yak']

export interface ClientCodename { client: string; name: string; codename: string; aliases: string[]; auto_aliases: string[]; set_by: string; set_at: string }
interface Row { client: string; name: string; codename: string; aliases: string; set_by: string; set_at: string }
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
export const slug = (codename: string) => words(codename).join('-')

/** Words a codename must not share with any client name or code (so it never hints at one). */
function clashes(codename: string, rows: { client: string; name: string; aliases: string[] }[], self?: string): string | undefined {
    const mine = new Set(words(codename))
    for (const r of rows) {
        if (r.client === self) {
            if ([r.name, r.client, ...r.aliases].some((x) => words(x).some((w) => mine.has(w)))) return 'it shares a word with this client\'s own name or code'
            continue
        }
        if ([r.name, r.client, ...r.aliases].some((x) => words(x).some((w) => mine.has(w)))) return 'it shares a word with another client\'s name or code'
    }
}
function randomCodename(taken: Set<string>, rows: { client: string; name: string; aliases: string[] }[], self: string): string {
    for (let i = 0; i < 500; i++) {
        const c = `${ADJ[randomInt(ADJ.length)]} ${NOUN[randomInt(NOUN.length)]}`
        if (!taken.has(c.toLowerCase()) && !clashes(c, rows, self)) return c
    }
    for (let n = 2; ; n++) { // 4,096 pairs used up: add a number
        const c = `${ADJ[randomInt(ADJ.length)]} ${NOUN[randomInt(NOUN.length)]} ${n}`
        if (!taken.has(c.toLowerCase()) && !clashes(c, rows, self)) return c
    }
}

// The legal or industry words a client is often written without: "Northwind Treasury" is also "Northwind".
const SUFFIX = /[\s,.]+(inc|ltd|llc|plc|gmbh|ag|sa|nv|bv|corp|corporation|company|co|group|holdings?|bank|banking|treasury|energy|industries|industrial|financial|finance|capital|limited|partners|international|global)\.?$/i
export function autoAliases(name: string): string[] {
    const out: string[] = []
    let n = name.trim()
    for (let i = 0; i < 3; i++) {
        const m = n.replace(SUFFIX, '').trim()
        if (m === n || m.length < 4) break
        out.push(m); n = m
    }
    return out
}
const parseAliases = (s: string): string[] => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : [] } catch { return [] } }
const toPublic = (r: Row): ClientCodename => ({ client: r.client, name: r.name, codename: r.codename, aliases: parseAliases(r.aliases), auto_aliases: autoAliases(r.name), set_by: r.set_by, set_at: r.set_at })
export const listCodenames = (): ClientCodename[] => all<Row>('SELECT * FROM client_codenames ORDER BY lower(name), client').map(toPublic)

/** Every client Lens knows of gets a codename (once; it then stays). Names are refreshed. */
export function syncClients(clients: { id: string; name?: string }[], by = 'lens'): number {
    let added = 0
    tx(() => {
        const rows = all<Row>('SELECT * FROM client_codenames')
        const byId = new Map(rows.map((r) => [r.client, r]))
        const roster = rows.map((r) => ({ client: r.client, name: r.name, aliases: parseAliases(r.aliases) }))
        const taken = new Set(rows.map((r) => r.codename.toLowerCase()))
        for (const c of clients) {
            const id = String(c.id || '').trim(); if (!id || id.length > 256) continue
            const name = String(c.name || '').trim().slice(0, 256)
            const have = byId.get(id)
            if (have) {
                if (name && name !== id && have.name !== name) {
                    // A renamed client: the old name stays hidden too.
                    const aliases = parseAliases(have.aliases)
                    if (have.name && !aliases.includes(have.name)) aliases.push(have.name)
                    run('UPDATE client_codenames SET name=?, aliases=? WHERE client=?', name, JSON.stringify(aliases.slice(-20)), id)
                    have.name = name; have.aliases = JSON.stringify(aliases); added++
                }
                continue
            }
            roster.push({ client: id, name, aliases: [] })
            const codename = randomCodename(taken, roster, id)
            taken.add(codename.toLowerCase())
            run('INSERT INTO client_codenames (client,name,codename,aliases,set_by,set_at) VALUES (?,?,?,?,?,?)', id, name === id ? '' : name, codename, '[]', by, new Date().toISOString())
            byId.set(id, { client: id, name, codename, aliases: '[]', set_by: by, set_at: '' })
            added++
        }
    })
    if (added) bump()
    return added
}

/** An admin changes a codename (or asks for a new random one) and the names a client also goes by. */
export function setCodename(client: string, p: { codename?: string; aliases?: string[] | string; regenerate?: boolean }, by: string): ClientCodename {
    const out = tx(() => {
        const rows = all<Row>('SELECT * FROM client_codenames')
        const me = rows.find((r) => r.client === client)
        if (!me) throw new AnonInputError('Unknown client.')
        const roster = rows.map((r) => ({ client: r.client, name: r.name, aliases: parseAliases(r.aliases) }))
        let aliases = parseAliases(me.aliases)
        if (p.aliases !== undefined) {
            const list = (Array.isArray(p.aliases) ? p.aliases : String(p.aliases).split(/[,\n]/)).map((a) => String(a).trim()).filter(Boolean)
            if (list.length > 20) throw new AnonInputError('At most 20 other names.')
            if (list.some((a) => a.length < 2 || a.length > 100)) throw new AnonInputError('Each other name is 2 to 100 characters.')
            aliases = [...new Set(list)]
            const mine = roster.find((r) => r.client === client)!; mine.aliases = aliases
        }
        let codename = me.codename
        if (p.regenerate) codename = randomCodename(new Set(rows.filter((r) => r.client !== client).map((r) => r.codename.toLowerCase())), roster, client)
        else if (p.codename !== undefined) {
            codename = String(p.codename).trim().replace(/\s+/g, ' ')
            if (!/^[A-Za-z][A-Za-z0-9 -]{2,39}$/.test(codename)) throw new AnonInputError('A codename is 3 to 40 letters, digits, spaces or hyphens, starting with a letter.')
            if (rows.some((r) => r.client !== client && r.codename.toLowerCase() === codename.toLowerCase())) throw new AnonInputError('Another client has this codename.')
            const why = clashes(codename, roster, client); if (why) throw new AnonInputError(`Choose another codename: ${why}.`)
        }
        run('UPDATE client_codenames SET codename=?, aliases=?, set_by=?, set_at=? WHERE client=?', codename, JSON.stringify(aliases), by, new Date().toISOString(), client)
        return toPublic(one<Row>('SELECT * FROM client_codenames WHERE client=?', client)!)
    })
    bump()
    return out
}

// ------------------------------------------------------------------ the matcher
// One pass over a text finds every client name, other name and code, longest first:
//   - names and other names: any case, words joined by spaces, _, -, ., + or %20 (as in URLs and ids)
//   - codes: any case, also inside longer ids (ACME-2026-001; trade ids are digits only, so they stay), except
//     a code that is also a common word (BETA is a client, "beta" is a word): that one only as written
// Before matching, look-alike letters are made plain: full-width (ＡＣＭＥ), zero-width spaces and soft
// hyphens, and Cyrillic or Greek letters that look Latin. Email addresses of anyone but Lens's own people are
// hidden too: a domain names its company.
interface Matcher { names?: RegExp; codesAnyCase?: RegExp; codesExact?: RegExp; byKey: Map<string, Row>; codenames: Map<string, Row>; staff: Set<string> }
/** Email domains of Lens's own people (admins, PMs): their addresses may show; everyone else's may not. */
function staffDomains(): Set<string> {
    const out = new Set<string>()
    for (const t of ['people', 'people_v2', 'survey_people', 'dashboard_people', 'mcp_tokens']) {
        try { for (const r of all<{ email: string }>(`SELECT DISTINCT email FROM ${t}`)) { const d = String(r.email).split('@')[1]; if (d) out.add(d.toLowerCase()) } } catch { /* table missing in an old database */ }
    }
    return out
}
// Letters that look Latin but are not, and invisible characters, made plain before matching.
const LOOKALIKE: Record<string, string> = { 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'ⅼ': 'l',
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
    'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X' }
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join('')}]`, 'g')
export const plain = (s: string) => s.normalize('NFKC').replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u180E]/g, '').replace(LOOKALIKE_RE, (c) => LOOKALIKE[c] || c)
const EMAIL = /[\p{L}\p{N}._%+-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/giu
let version = 0
let cache: { version: number; m: Matcher } | undefined
function bump() { version++ }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SEP = '(?:[\\s_.+\\-]|%20|%2[dD]|%5[fF])+'
const norm = (s: string) => s.toLowerCase().replace(/%20|%2d|%5f/gi, ' ').split(/[\s_.+\-]+/).filter(Boolean).join(' ')
const COMMON = new Set(['alpha', 'beta', 'gamma', 'delta', 'omega', 'test', 'demo', 'main', 'core', 'base', 'open', 'data', 'bank', 'fund', 'cash', 'risk', 'trade', 'deal', 'swap', 'loan', 'bond', 'live', 'prod', 'user', 'admin', 'team', 'home', 'next', 'new', 'old', 'one', 'two', 'all', 'any', 'and', 'the', 'for', 'not', 'yes', 'no', 'ok', 'id', 'api', 'app', 'web', 'acc', 'ref', 'tmp', 'dev'])
const shortCode = (c: string) => /^[A-Za-z]+$/.test(c) && COMMON.has(c.toLowerCase())

function matcher(): Matcher {
    if (cache?.version === version) return cache.m
    const rows = all<Row>('SELECT * FROM client_codenames')
    const byKey = new Map<string, Row>(), codenames = new Map<string, Row>()
    const names: string[] = [], anyCase: string[] = [], exact: string[] = []
    for (const r of rows) {
        codenames.set(r.codename.toLowerCase(), r); codenames.set(slug(r.codename), r)
        for (const n of [r.name, ...parseAliases(r.aliases), ...autoAliases(r.name)]) {
            const w = n.split(/[\s_.+\-]+/).filter(Boolean)
            if (!w.length || n.trim().length < 3) continue
            byKey.set('n:' + norm(n), r); names.push(w.map(esc).join(SEP))
        }
        if (shortCode(r.client)) { byKey.set('x:' + r.client, r); exact.push(esc(r.client)) }
        else { byKey.set('c:' + r.client.toLowerCase(), r); anyCase.push(esc(r.client)) }
    }
    const longest = (a: string[]) => [...new Set(a)].sort((x, y) => y.length - x.length).join('|')
    const m: Matcher = {
        byKey, codenames,
        names: names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${longest(names)})(?![\\p{L}\\p{N}])`, 'giu') : undefined,
        codesAnyCase: anyCase.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${longest(anyCase)})(?![\\p{L}\\p{N}])`, 'giu') : undefined,
        codesExact: exact.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${longest(exact)})(?![\\p{L}\\p{N}])`, 'gu') : undefined,
        staff: staffDomains(),
    }
    cache = { version, m }
    return m
}
/** Call after anything outside this module changed client_codenames (tests, imports). */
export const forgetMatcher = () => bump()

const URLISH = /(?:https?:\/\/|\/replays\/|\/posthog-mcp|\/mcp\b)[^\s"'<>)\]`]*/g
/** The text with every client name and code replaced by its codename (in links: its slug, which Lens's
 * pages turn back into the client). Returns how many were replaced. */
export function hideClients(text: string): { text: string; n: number } {
    if (!text) return { text, n: 0 }
    const m = matcher()
    let n = 0
    text = plain(text).replace(EMAIL, (hit, domain: string) => (m.staff.has(domain.toLowerCase()) ? hit : (n++, '[email hidden]')))
    const swap = (inUrl: boolean) => (s: string) => {
        let out = s
        const sub = (re: RegExp | undefined, key: (x: string) => string) => {
            if (!re) return
            out = out.replace(re, (hit) => {
                const r = m.byKey.get(key(hit))
                if (!r) return hit
                n++
                return inUrl ? encodeURIComponent(slug(r.codename)) : r.codename
            })
        }
        sub(m.names, (x) => 'n:' + norm(x))
        sub(m.codesAnyCase, (x) => 'c:' + x.toLowerCase())
        sub(m.codesExact, (x) => 'x:' + x)
        return out
    }
    const inUrls = text.replace(URLISH, swap(true))
    return { text: swap(false)(inUrls), n }
}
/** Same, through any JSON value: strings and object keys. */
// Fields that hold a client: a value the matcher does not know (a client Lens has not listed yet) is masked.
const CLIENT_FIELD = /^(client|clients|client_?id|client_?ids|client_?code|client_?name|client_?names|clientId|clientName)$/i
export function hideClientsDeep<T>(value: T): { value: T; n: number } {
    let n = 0
    const walk = (v: unknown, field = false): unknown => {
        if (typeof v === 'string') {
            const h = hideClients(v); n += h.n
            if (field && h.n === 0 && v.trim() && !clientOfCodename(v)) { n++; return '[client]' }
            return h.text
        }
        if (Array.isArray(v)) return v.map((x) => walk(x, field))
        if (v && typeof v === 'object') {
            const o: Record<string, unknown> = {}
            for (const [k, x] of Object.entries(v)) { const h = hideClients(k); n += h.n; o[h.text] = walk(x, CLIENT_FIELD.test(k)) }
            return o
        }
        return v
    }
    return { value: walk(value) as T, n }
}
/** Does this text name a client (name, other name or code)? */
export const namesClient = (text: string): boolean => hideClients(text).n > 0
/** An email address of someone outside Lens's own people (a client's user). */
export function outsideEmail(text: string): boolean {
    const m = matcher()
    for (const hit of plain(text).matchAll(EMAIL)) if (!m.staff.has(hit[1].toLowerCase())) return true
    return false
}
/** A codename (or its slug) → the client's code, or undefined. */
export function clientOfCodename(s: string): string | undefined {
    const k = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
    const m = matcher()
    return (m.codenames.get(k) || m.codenames.get(k.replace(/ /g, '-')))?.client
}
/** Every codename in a text replaced by the client's code (what the AI sends back). */
export function revealCodenames(text: string): string {
    const m = matcher()
    if (!m.codenames.size) return text
    const keys = [...m.codenames.keys()].sort((a, b) => b.length - a.length).map((k) => k.split(/[\s-]+/).map(esc).join('[\\s_\\-]+'))
    return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${keys.join('|')})(?![\\p{L}\\p{N}])`, 'giu'), (hit) => clientOfCodename(hit.replace(/[\s_\-]+/g, ' ')) || hit)
}
/** Every codename in a text replaced by the client's real name (text written for people). */
export function namesForCodenames(text: string): string {
    const m = matcher()
    if (!m.codenames.size) return text
    const keys = [...m.codenames.keys()].sort((a, b) => b.length - a.length).map((k) => k.split(/[\s-]+/).map(esc).join('[\\s_\\-]+'))
    return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${keys.join('|')})(?![\\p{L}\\p{N}])`, 'giu'), (hit) => {
        const r = m.codenames.get(hit.toLowerCase().replace(/[\s_\-]+/g, ' ')) || m.codenames.get(hit.toLowerCase().replace(/[\s_\-]+/g, '-'))
        return r ? (r.name || r.client) : hit
    })
}
export const codenameOf = (client: string): string | undefined => one<{ codename: string }>('SELECT codename FROM client_codenames WHERE client=?', client)?.codename

// ------------------------------------------------------------------ counts of what was blocked
export type BlockKind = 'lens_refused' | 'lens_cleaned' | 'posthog_refused' | 'posthog_cleaned' | 'triage_cleaned'
export function countBlock(kind: BlockKind, n = 1): void {
    try { run('INSERT INTO anon_blocks (day,kind,n) VALUES (?,?,?) ON CONFLICT(day,kind) DO UPDATE SET n=n+excluded.n', new Date().toISOString().slice(0, 10), kind, n) } catch { /* counting never breaks a request */ }
}
export function blockCounts(days = 30): Record<string, number> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    return Object.fromEntries(all<{ kind: string; n: number }>('SELECT kind, sum(n) AS n FROM anon_blocks WHERE day>=? GROUP BY kind', since).map((r) => [r.kind, r.n]))
}

/** The refusal an AI gets for a client name or code: the same for known and unknown names. */
export const REFUSAL = 'Client names and client codes are hidden from AI here (client anonymisation is on in Lens). Use the client\'s codename, such as "Amber Falcon": the person finds it in Lens, on the Codenames page (/replays/codenames). Do not ask the person to type client names or codes in chat.'
