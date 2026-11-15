// Central privacy policy and persistent numbered client labels.
import { randomInt, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { all, getSetting, one, run, setSetting, tx } from './db.ts'

export type PrivacyMode = 'open' | 'standard' | 'private'
export type PosthogMode = 'block' | 'filter'
export interface AnonSettings {
    mode: PrivacyMode; posthog: PosthogMode; round: boolean
    // Derived compatibility fields; these are never independently configurable.
    on: boolean; lens: boolean; triage: boolean; codes: boolean; emails: boolean; message: string
}
const policy = new AsyncLocalStorage<{ settings: AnonSettings; revision: number }>()
function liveSettings(): AnonSettings {
    const old = getSetting<Partial<AnonSettings>>('anon', {})
    let mode = old.mode
    if (!['open', 'standard', 'private'].includes(String(mode))) {
        mode = (old.on ?? getSetting('anon_ai', false)) ? 'private' : 'standard'
        tx(() => {
            if (['open', 'standard', 'private'].includes(String(getSetting<Partial<AnonSettings>>('anon', {}).mode))) return
            setSetting('anon', { mode, posthog: (old.posthog ?? getSetting('anon_posthog', 'block')) === 'filter' ? 'filter' : 'block', round: !!old.round })
            run('INSERT INTO audit (t,who,action,details) VALUES (?,?,?,?)', new Date().toISOString(), 'lens', 'privacy.mode_migrated', JSON.stringify({ mode, legacy_on: mode === 'private', removed_bypasses: { lens: old.lens, triage: old.triage, codes: old.codes, emails: old.emails, posthog: old.posthog } }))
        })
        return liveSettings()
    }
    return { mode: mode!, on: mode === 'private', lens: true, triage: true, codes: true, emails: true, message: '', posthog: old.posthog === 'filter' ? 'filter' : 'block', round: mode === 'private' && !!old.round }
}
export const anonSettings = (): AnonSettings => policy.getStore()?.settings ?? liveSettings()
export const privacyMode = (): PrivacyMode => anonSettings().mode
export const privacyRevision = (): number => getSetting('codename_revision', 0)
// Codenames only exist in private mode: a new client getting one (the roster sync on a first call does that) must
// not invalidate standard/open answers, where it changes nothing. In private mode it still does: an answer computed
// before the client was known could hold its real name, so that request is refused and retried.
const codenameRevision = (settings: AnonSettings, revision: number): number => settings.mode === 'private' ? revision : 0
export const privacyKey = (): string => JSON.stringify([anonSettings(), codenameRevision(anonSettings(), policy.getStore()?.revision ?? privacyRevision())])
export const privacyCurrent = (): boolean => !policy.getStore() || (JSON.stringify(liveSettings()) === JSON.stringify(anonSettings())
    && codenameRevision(anonSettings(), policy.getStore()!.revision) === codenameRevision(anonSettings(), privacyRevision()))
export const PRIVACY_CHANGED = 'Privacy settings changed during this request. Please retry.'
export function withPrivacy<T>(work: () => T): T { return policy.getStore() ? work() : policy.run({ settings: liveSettings(), revision: privacyRevision() }, work) }
export const anonymiseOn = (): boolean => privacyMode() === 'private'
export const posthogMode = (): PosthogMode => anonSettings().posthog
export const anonFor = (_path: 'lens' | 'posthog' | 'triage'): boolean => anonymiseOn()
export function setAnonymise(p: Partial<Record<keyof AnonSettings, unknown>>): AnonSettings {
    const previous = liveSettings()
    const next = { ...previous }
    if (p.mode !== undefined) {
        if (!['open', 'standard', 'private'].includes(String(p.mode))) throw new AnonInputError('Mode is open, standard or private.')
        next.mode = p.mode as PrivacyMode
    }
    if (p.posthog !== undefined) {
        if (!['block', 'filter'].includes(String(p.posthog))) throw new AnonInputError('PostHog is block or filter.')
        next.posthog = p.posthog as PosthogMode
    }
    if (p.round !== undefined) {
        if (typeof p.round !== 'boolean') throw new AnonInputError('Round is true or false.')
        next.round = p.round
    }
    tx(() => {
        setSetting('anon', { mode: next.mode, posthog: next.posthog, round: next.round })
        if (previous.mode !== next.mode || previous.posthog !== next.posthog || previous.round !== next.round) revise()
        if (previous.mode !== next.mode || previous.posthog !== next.posthog || previous.round !== next.round) run('INSERT INTO audit(t,who,action,details) VALUES (?,?,?,?)', new Date().toISOString(), 'lens', 'privacy.policy_set', JSON.stringify({ before: previous.mode, mode: next.mode, posthog: next.posthog, round: next.round }))
    })
    bump()
    return liveSettings()
}
const DEFAULT_REFUSAL = 'Private mode hides client names and codes. Use a numbered codename, such as "Client 100", from Lens → Codenames (/replays/codenames). Unknown or retired codenames cannot be used. Do not type real client names or codes in chat.'
export const refusalText = (): string => DEFAULT_REFUSAL
export class AnonInputError extends Error {}

// ------------------------------------------------------------------ codenames
export interface ClientCodename { client: string; name: string; codename: string; aliases: string[]; auto_aliases: string[]; set_by: string; set_at: string }
interface Row { client: string; name: string; codename: string; aliases: string; set_by: string; set_at: string }
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
export const slug = (codename: string) => words(codename).join('-')

/** A codename label nobody has used (retired) and that is not a real client's name or code. */
function labelFree(label: string): boolean {
    if (one('SELECT label FROM retired_codenames WHERE label=?', slug(label))) return false
    return !one('SELECT client FROM client_codenames WHERE lower(name) = lower(?) OR lower(client) = lower(?)', label, label)
}
export interface Numbering { prefix: string; start: number }
export const numbering = (): Numbering => getSetting('codename_numbering', { prefix: 'Client', start: 1 })
function validateNumbering(p: Numbering): Numbering {
    const prefix = String(p.prefix).trim().replace(/\s+/g, ' ')
    if (!prefix || !words(prefix).length || prefix.length > 40 || !/^[\p{L}\p{N} -]+$/u.test(prefix)) throw new AnonInputError('Prefix needs 1–40 letters, digits, spaces or hyphens.')
    if (!Number.isSafeInteger(p.start) || p.start < 0) throw new AnonInputError('Start must be a non-negative safe integer.')
    const k = keyOf(prefix)
    for (const r of listCodenames()) for (const n of [r.client, r.name, ...r.aliases, ...r.auto_aliases, ...acronyms(r.name)]) {
        if (n && k.includes(keyOf(n))) throw new AnonInputError('Prefix contains a real client name, code or alias.')
    }
    return { prefix, start: p.start }
}
export function previewNumbering(p: Numbering) {
    p = validateNumbering(p)
    const roster = all<Row & { rank: number }>('SELECT * FROM client_codenames ORDER BY rank')
    const currentSlugs = new Set(roster.map(r => slug(r.codename)))
    return roster.map(r => {
        if (!Number.isSafeInteger(p.start + r.rank)) throw new AnonInputError('Number exceeds safe integer range.')
        const codename = `${p.prefix} ${p.start + r.rank}`
        if (codename !== r.codename && one('SELECT label FROM retired_codenames WHERE label=?', slug(codename))) throw new AnonInputError('This scheme reuses a retired codename. Choose another prefix or start.')
        if (codename !== r.codename && currentSlugs.has(slug(codename))) throw new AnonInputError('This scheme reassigns an existing codename. Choose another prefix or start.')
        return { client: r.client, name: r.name, before: r.codename, codename }
    })
}
export function applyNumbering(p: Numbering, by: string, expectedRevision?: number) {
    const result = tx(() => {
        if (expectedRevision !== undefined && expectedRevision !== privacyRevision()) throw new AnonInputError('Mapping changed; preview again before applying.')
        const rows = previewNumbering(p)
        for (const r of rows) if (r.before !== r.codename) {
            run('INSERT OR IGNORE INTO retired_codenames(label) VALUES (?)', slug(r.before))
            run('UPDATE client_codenames SET codename=?,set_by=?,set_at=? WHERE client=?', r.codename, by, new Date().toISOString(), r.client)
        }
        setSetting('codename_numbering', validateNumbering(p))
        setSetting('codename_revision', getSetting('codename_revision', 0) + 1)
        run('INSERT INTO audit(t,who,action,details) VALUES (?,?,?,?)', new Date().toISOString(), by, 'privacy.numbering_set', JSON.stringify(p))
        return rows
    })
    bump(); return result
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
export const listCodenames = (): ClientCodename[] => all<Row>('SELECT * FROM client_codenames ORDER BY rank, client').map(toPublic)

/** Every client Lens knows of gets a codename (once; it then stays). Names are refreshed. */
export function syncClients(clients: { id: string; name?: string }[], by = 'lens'): number {
    let added = 0
    tx(() => {
        const rows = all<Row>('SELECT * FROM client_codenames')
        const byId = new Map(rows.map((r) => [r.client, r]))
        for (const c of shuffled(clients)) {
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
            const scheme = numbering()
            // Skip numbers whose label is retired or is a real client's name or code: a new client must always get
            // a codename (a failed sync would leave its real name unknown to the privacy filter).
            let rank = getSetting('codename_next_rank', 0)
            while (Number.isSafeInteger(scheme.start + rank) && !labelFree(`${scheme.prefix} ${scheme.start + rank}`)) rank++
            if (!Number.isSafeInteger(scheme.start + rank)) throw new AnonInputError('Codename number exceeds safe integer range; update the numbering scheme.')
            setSetting('codename_next_rank', rank + 1)
            const codename = `${scheme.prefix} ${scheme.start + rank}`
            run('INSERT INTO client_codenames (client,name,codename,aliases,set_by,set_at,rank) VALUES (?,?,?,?,?,?,?)', id, name === id ? '' : name, codename, '[]', by, new Date().toISOString(), rank)
            byId.set(id, { client: id, name, codename, aliases: '[]', set_by: by, set_at: '' })
            added++
        }
        if (added) revise()
    })
    return added
}

/** Admins can edit real-name aliases; labels are controlled only by the shared numbering scheme. */
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
        const codename = me.codename
        if (p.regenerate || p.codename !== undefined && p.codename !== me.codename) throw new AnonInputError('Numbered codenames cannot be edited individually; change prefix/start for all clients. Real-name aliases remain editable.')
        run('UPDATE client_codenames SET codename=?, aliases=?, set_by=?, set_at=? WHERE client=?', codename, JSON.stringify(aliases), by, new Date().toISOString(), client)
        revise()
        return toPublic(one<Row>('SELECT * FROM client_codenames WHERE client=?', client)!)
    })
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
interface Matcher { codenameTokens?: RegExp; names?: RegExp; codesAnyCase?: RegExp; codesExact?: RegExp; byKey: Map<string, Row>; codenames: Map<string, Row>; staff: Set<string>; emails: boolean; fuzzy: Map<string, Row>; deletions: Map<string, string[]> }
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
const ENTITY: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: "'", lsquo: "'" }
const char = (code: number) => (code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '')
/** Text as a person reads it, for matching: escapes (\u0041, &#65;, &amp;) decoded, accents dropped (é → e),
 * full-width and look-alike letters made plain, invisible characters removed. */
export const plain = (s: string) => s
    .replace(/\\u\{?([0-9a-fA-F]{4,6})\}?|\\x([0-9a-fA-F]{2})/g, (_, u, x) => char(parseInt(u || x, 16)))
    .replace(/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});|&([a-zA-Z]+);/g, (hit, d, h, name) => (d ? char(+d) : h ? char(parseInt(h, 16)) : ENTITY[name.toLowerCase()] ?? hit))
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u180E]/g, '').replace(LOOKALIKE_RE, (c) => LOOKALIKE[c] || c)
    .normalize('NFKC')
const EMAIL = /[\p{L}\p{N}._%+-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/giu
let version = 0
let cache: { version: number; revision: number; m: Matcher } | undefined
function bump() { version++; cache = undefined }
function revise() { setSetting('codename_revision', privacyRevision() + 1); bump() }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Between the words of a name: nothing, separators (also URL-encoded), and the name's own punctuation, written
// as is or URL-encoded ("O'Brien & Sons" also matches O%27Brien%20%26%20Sons, OBrien and Sons, OBrien-Sons).
const SEPS = ['[\\s_.+\\-]', '%20', '%2[dD]', '%5[fF]']
const pct = (c: string) => { const h = c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'); return `%${h[0]}[${h[1]}${h[1].toLowerCase()}]` }
function gap(sep: string): string {
    const alts = new Set(SEPS)
    for (const c of sep) if (!/[\s_.+\-]/.test(c) && c.charCodeAt(0) < 128) { alts.add(esc(c)); alts.add(pct(c)) } else if (!/[\s_.+\-]/.test(c)) alts.add(esc(c))
    if (sep.includes('&')) alts.add('and')
    return `(?:${[...alts].join('|')})*`
}
/** A name as a pattern: its words, any gap between them, and an optional plural or possessive (Acme's, Acmes). */
function namePattern(name: string): string | undefined {
    const parts = plain(name).trim().split(/([^\p{L}\p{N}]+)/u).filter((x) => x !== '')
    const words = parts.filter((x) => /[\p{L}\p{N}]/u.test(x))
    if (!words.length || words.join('').length < 3) return undefined
    return parts.map((x) => (/[\p{L}\p{N}]/u.test(x) ? esc(x) : gap(x))).join('') + "(?:(?:'|%27)?s|es)?"
}
/** The key a name or a matched text is looked up by: letters and digits only. */
const keyOf = (s: string) => plain(s.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))).toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '')
const COMMON = new Set(['alpha', 'beta', 'gamma', 'delta', 'omega', 'test', 'demo', 'main', 'core', 'base', 'open', 'data', 'bank', 'fund', 'cash', 'risk', 'trade', 'deal', 'swap', 'loan', 'bond', 'live', 'prod', 'user', 'admin', 'team', 'home', 'next', 'new', 'old', 'one', 'two', 'all', 'any', 'and', 'the', 'for', 'not', 'yes', 'no', 'ok', 'id', 'api', 'app', 'web', 'acc', 'ref', 'tmp', 'dev'])
const shortCode = (c: string) => /^[A-Za-z]+$/.test(c) && COMMON.has(c.toLowerCase())

// Words that say what kind of company it is, not which one: never used on their own.
const GENERIC = new Set(['treasury', 'industries', 'industrial', 'energy', 'capital', 'holdings', 'holding', 'financial', 'finance', 'international', 'global', 'systems', 'solutions', 'services', 'partners', 'management', 'group', 'limited', 'company', 'corporation', 'technologies', 'technology', 'investments', 'investment', 'securities', 'insurance', 'banking', 'markets', 'trading', 'national', 'general', 'american', 'european', 'canadian'])
const STOP = new Set(['and', 'of', 'the', 'for', 'de', 'la', 'le', 'du', 'des', 'et'])
/** Initials of a name of three or more words, in capitals (KFH). */
function acronyms(name: string): string[] {
    const words = plain(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w.toLowerCase()))
    if (words.length < 3) return []
    const a = words.map((w) => w[0].toUpperCase()).join('')
    return a.length >= 3 && /^[A-Z]+$/.test(a) && !COMMON.has(a.toLowerCase()) ? [a] : []
}
// Words Lens's own answers and people's questions use all the time ("clients", "payment", "export"). Written
// exactly, such a word is left alone even when a client's name contains it ("Summit Payments", "Client 100"):
// otherwise every "payments" in an answer became a codename and "Which clients are at risk?" was refused.
// The client is still found by its full name, aliases and initials, and a misspelling of the word ("Northrn"
// for "Northern Trust") is still hidden.
const VOCABULARY = new Set(['client', 'clients', 'customer', 'customers', 'account', 'accounts', 'payment', 'payments', 'settlement', 'settlements',
    'pension', 'pensions', 'treasury', 'hedge', 'hedging', 'accounting', 'export', 'exports', 'import', 'imports', 'report', 'reports', 'reporting',
    'dialog', 'dialogs', 'dialogue', 'screen', 'screens', 'action', 'actions', 'session', 'sessions', 'replay', 'replays', 'workflow', 'workflows',
    'signal', 'signals', 'health', 'healthy', 'warning', 'warnings', 'attention', 'friction', 'failure', 'failures', 'errors', 'change', 'changes',
    'people', 'person', 'users', 'usage', 'leaving', 'renewal', 'renewed', 'stayed', 'contracted', 'outcome', 'outcomes', 'portfolio', 'summary',
    'version', 'release', 'releases', 'update', 'updated', 'deleted', 'created', 'search', 'filter', 'limits', 'limit', 'counterparty', 'counterparties',
    'instrument', 'instruments', 'position', 'positions', 'market', 'valuation', 'journal', 'journals', 'ledger', 'entries', 'approval', 'approvals',
    'workbench', 'security', 'transfer', 'transfers', 'balance', 'balances', 'forecast', 'forecasts', 'liquidity', 'currency', 'currencies', 'rates',
    'interest', 'derivative', 'derivatives', 'compliance', 'invoice', 'invoices', 'vendor', 'vendors', 'banking', 'statement', 'statements',
    'reconciliation', 'business', 'service', 'services', 'support', 'success', 'growth', 'network', 'digital', 'advisors', 'advisory', 'consulting',
    'pacific', 'atlantic', 'northern', 'southern', 'eastern', 'western', 'central', 'united', 'standard', 'premier', 'royal', 'first', 'second'])
/** Words of 6 letters or more that point to one company (not "Treasury"): matched with one typo too. */
function distinctive(names: string[]): string[] {
    const out = new Set<string>()
    for (const n of names) for (const w of plain(n).toLowerCase().split(/[^\p{L}]+/u)) if (w.length >= 6 && !GENERIC.has(w) && !COMMON.has(w)) out.add(w)
    return [...out]
}
/** Each word under itself and every one-letter deletion: a word one typo away shares a key with it. */
const dels = (w: string) => { const out = [w]; for (let i = 0; i < w.length; i++) out.push(w.slice(0, i) + w.slice(i + 1)); return out }
function deletionIndex(words: string[]): Map<string, string[]> {
    const idx = new Map<string, string[]>()
    for (const w of words) for (const k of dels(w)) { const l = idx.get(k); if (l) { if (!l.includes(w)) l.push(w) } else idx.set(k, [w]) }
    return idx
}
/** Optimal-string-alignment distance, stopping early above 1. */
function withinOne(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) return false
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    if (i === a.length && i === b.length) return true
    const rest = (x: number, y: number) => a.slice(x) === b.slice(y)
    return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2))
}

function matcher(): Matcher {
    if (cache?.version === version && cache.revision === privacyRevision()) return cache.m
    const rows = all<Row>('SELECT * FROM client_codenames')
    const settings = anonSettings()
    const byKey = new Map<string, Row>(), codenames = new Map<string, Row>(), fuzzy = new Map<string, Row>()
    const names: string[] = [], anyCase: string[] = [], exact: string[] = []
    for (const r of rows) {
        codenames.set(r.codename.toLowerCase(), r); codenames.set(slug(r.codename), r)
        for (const n of [r.name, ...parseAliases(r.aliases), ...autoAliases(r.name)]) {
            const pattern = namePattern(n)
            if (!pattern) continue
            byKey.set('n:' + keyOf(n), r); byKey.set('n:' + keyOf(n.replace(/&/g, ' ')), r); names.push(pattern)
        }
        // Initials of a long name, in capitals: "Kwambe Fintrust Holdings" is also KFH.
        for (const a of acronyms(r.name)) { byKey.set('x:' + a, r); exact.push(esc(a)) }
        // Distinctive words of the name, for misspellings ("Nortwind").
        for (const w of distinctive([r.name, ...parseAliases(r.aliases)])) if (!fuzzy.has(w)) fuzzy.set(w, r)
        if (!settings.codes || /^\d+$/.test(r.client)) continue
        if (shortCode(r.client)) {
            // A code that is also a word: as written, or capitalised (Beta), never in lower case.
            const title = r.client[0].toUpperCase() + r.client.slice(1).toLowerCase()
            for (const c of new Set([r.client, title])) { byKey.set('x:' + c, r); exact.push(esc(c)) }
        }
        else { byKey.set('c:' + r.client.toLowerCase(), r); anyCase.push(esc(r.client)) }
    }
    const longest = (a: string[]) => [...new Set(a)].sort((x, y) => y.length - x.length).join('|')
    const m: Matcher = {
        byKey, codenames, codenameTokens: codenamePattern(rows),
        names: names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${longest(names)})(?![\\p{L}\\p{N}])`, 'giu') : undefined,
        codesAnyCase: anyCase.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${longest(anyCase)})(?![\\p{L}\\p{N}])`, 'giu') : undefined,
        codesExact: exact.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${longest(exact)})(?![\\p{L}\\p{N}])`, 'gu') : undefined,
        staff: staffDomains(), emails: settings.emails, fuzzy, deletions: deletionIndex([...fuzzy.keys()]),
    }
    cache = { version, revision: privacyRevision(), m }
    return m
}
/** Call after anything outside this module changed client_codenames (tests, imports). */
export const forgetMatcher = () => bump()

function codenamePattern(rows: Row[]): RegExp | undefined {
    const prefixes = new Set<string>(), other: string[] = []
    const sep = '(?:[\\s_-]|%20|%2[dD])+'
    for (const r of rows) {
        const numbered = /^(.*) (\d+)$/.exec(r.codename)
        if (numbered) prefixes.add(numbered[1].split(/[\s-]+/).map(esc).join(sep))
        else other.push(r.codename.split(/[\s-]+/).map(esc).join(sep))
    }
    const parts = [...prefixes].map(p => p + sep + '[0-9]+').concat(other)
    return parts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : undefined
}
export function protectCodenameTokens(text: string, keep: (token: string) => string): string {
    const m = matcher()
    return m.codenameTokens ? text.replace(m.codenameTokens, token => clientOfCodename(token) ? keep(token) : token) : text
}

const URLISH = /(?:https?:\/\/|\/replays\/|\/posthog-mcp|\/mcp\b)[^\s"'<>)\]`]*/g
/** The text with every client name and code replaced by its codename (in links: its slug, which Lens's
 * pages turn back into the client). Returns how many were replaced. */
export function hideClients(text: string): { text: string; n: number } {
    if (!text) return { text, n: 0 }
    const m = matcher()
    let n = 0
    text = plain(text).replace(/\u0000/g, '')
    // Links that open a clip without signing in become sign-in links.
    text = text.replace(/((?:https?:\/\/[^\s"'<>\/]+)?)\/clips\/([^\s"'<>?#]+)\?([^\s"'<>#]*)/g, (hit, base: string, name: string, query: string) => {
        let q: URLSearchParams
        try { q = new URLSearchParams(decodeURIComponent(query)) } catch { q = new URLSearchParams(query) }
        if (!q.has('sig') && !q.has('exp')) return hit
        n++
        let file = name
        try { file = decodeURIComponent(name) } catch { /* keep as written */ }
        return `${base}/replays?clip=${encodeURIComponent(file)}`
    })
    if (m.emails) text = text.replace(EMAIL, (hit, domain: string) => (m.staff.has(domain.toLowerCase()) ? hit : (n++, '[email hidden]')))
    // Session and other UUIDs stay exactly as they are (a part of one can look like a code).
    const kept: string[] = []
    const protect = (v: string) => `\u0000${kept.push(v) - 1}\u0000`
    text = protectCodenameTokens(text, protect)
    text = text.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, (u) => `\u0000${kept.push(u) - 1}\u0000`)
    const swap = (inUrl: boolean) => (s: string) => {
        let out = s
        const sub = (re: RegExp | undefined, key: (x: string) => string) => {
            if (!re) return
            out = out.replace(re, (hit) => {
                const r = m.byKey.get(key(hit))
                if (!r) return hit
                n++
                return protect(inUrl ? encodeURIComponent(slug(r.codename)) : r.codename)
            })
        }
        sub(m.names, (x) => { const k = keyOf(x); for (const c of [k, k.replace(/es$/, ''), k.replace(/s$/, '')]) if (m.byKey.has('n:' + c)) return 'n:' + c; return 'n:' + k })
        sub(m.codesAnyCase, (x) => 'c:' + x.toLowerCase())
        sub(m.codesExact, (x) => 'x:' + x)
        // Misspelt distinctive words, one letter off ("Nortwind", "Northwnid").
        if (m.fuzzy.size) out = out.replace(/(?<![\p{L}\p{N}])\p{L}{5,}(?![\p{L}\p{N}])/gu, (word) => {
            const w = word.toLowerCase()
            if (VOCABULARY.has(w)) return word
            if (m.fuzzy.has(w)) { n++; const r = m.fuzzy.get(w)!; return protect(inUrl ? encodeURIComponent(slug(r.codename)) : r.codename) }
            for (const k of dels(w)) for (const d of m.deletions.get(k) || []) if (withinOne(w, d)) { const r = m.fuzzy.get(d)!; n++; return protect(inUrl ? encodeURIComponent(slug(r.codename)) : r.codename) }
            return word
        })
        return out
    }
    const inUrls = text.replace(URLISH, swap(true))
    return { text: swap(false)(inUrls).replace(/\u0000(\d+)\u0000/g, (_, i) => kept[+i]), n }
}
/** Same, through any JSON value: strings and object keys. */
// A client field held a client Lens has no codename for yet: look for new clients now (src/core/anonroster.ts).
let onUnknown: (() => void) | undefined
export const whenUnknownClient = (fn: () => void) => { onUnknown = fn }
function unknownClientSeen() { try { onUnknown?.() } catch { /* never breaks an answer */ } }
// Fields that hold a client: a value the matcher does not know (a client Lens has not listed yet) is masked.
const CLIENT_FIELD = /^(client|clients|client_?id|client_?ids|client_?code|client_?name|client_?names|clientId|clientName)$/i
export function hideClientsDeep<T>(value: T): { value: T; n: number } {
    let n = 0
    const walk = (v: unknown, field = false): unknown => {
        if (typeof v === 'string') {
            if (field && isClientCode(v)) { n++; return codenameOf(v) || '[client]' }
            const h = hideClients(v); n += h.n
            if (field && h.n === 0 && v.trim() && !clientOfCodename(v) && (anonSettings().codes || !isClientCode(v.trim()))) { n++; unknownClientSeen(); return '[client]' }
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
// Counts in answers rounded to two significant figures (148 → 150, 1,234 → 1,200), when an admin chose it:
// in JSON blocks of tool answers, for count-like fields only (never ids, dates, versions, rates or shares).
const COUNT_KEY = /(count|events|users|people|sessions|attempts|opens|done|failed|total|clients|shown|answered|dismissed|actions|calls|errors|hits|visits|clicks|exports|^n$)/i
const NOT_COUNT = /(id|day|date|time|version|percent|pct|rate|share|score|ratio|median|p\d\d|_ms$|_s$|seconds|minutes|hours|offset|start|end)/i
export const round2 = (x: number) => (Number.isInteger(x) && Math.abs(x) >= 10 ? Number(x.toPrecision(2)) : x)
const isCountKey = (k: string) => COUNT_KEY.test(k) && !NOT_COUNT.test(k)
/** Counts rounded anywhere in a value: numbers under count-like keys (also inside arrays under them, and
 * numeric strings), and JSON blocks inside texts. */
export function roundValue(v: unknown, key = ''): unknown {
    if (typeof v === 'number') return isCountKey(key) ? round2(v) : v
    if (typeof v === 'string') return /^-?\d+$/.test(v) && isCountKey(key) ? String(round2(Number(v))) : v.includes('```json') ? roundCounts(v) : v
    if (Array.isArray(v)) return v.map((x) => roundValue(x, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundValue(x, k)]))
    return v
}
export function roundCounts(text: string): string {
    return text.replace(/```json\n([\s\S]*?)\n```/g, (block, body: string) => {
        try { return '```json\n' + JSON.stringify(roundValue(JSON.parse(body)), null, 2) + '\n```' } catch { return block }
    })
}
/** Does this text name a client (name, other name or code)? */
export const namesClient = (text: string): boolean => hideClients(text).n > 0
/** An email address of someone outside Lens's own people (a client's user). */
export function outsideEmail(text: string): boolean {
    const m = matcher()
    if (!m.emails) return false
    for (const hit of plain(text).matchAll(EMAIL)) if (!m.staff.has(hit[1].toLowerCase())) return true
    return false
}
/** A codename (or its slug) → the client's code, or undefined. */
export function clientOfCodename(s: string): string | undefined {
    let decoded = String(s || ''); try { decoded = decodeURIComponent(decoded) } catch {}
    const k = decoded.trim().toLowerCase().replace(/\s+/g, ' ')
    const m = matcher()
    return (m.codenames.get(k) || m.codenames.get(slug(k)))?.client
}
/** Every codename in a text replaced by the client's code (what the AI sends back). */
export function revealCodenames(text: string): string {
    const m = matcher()
    return m.codenameTokens ? text.replace(m.codenameTokens, hit => clientOfCodename(hit) || hit) : text
}
/** Every current codename replaced with the real name for human-facing reports. */
export function namesForCodenames(text: string): string {
    const m = matcher()
    return m.codenameTokens ? text.replace(m.codenameTokens, hit => {
        const client = clientOfCodename(hit)
        const row = client ? one<Row>('SELECT * FROM client_codenames WHERE client=?', client) : undefined
        return row ? row.name || row.client : hit
    }) : text
}
/** A client code Lens knows (whatever the case). */
export const isClientCode = (s: string): boolean => !!s && !!one<{ client: string }>('SELECT client FROM client_codenames WHERE client=? COLLATE NOCASE', s)
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

/** The default refusal (tests and callers that do not need the admin's own wording). */
export const REFUSAL = DEFAULT_REFUSAL

function shuffled<T>(input: T[]): T[] {
    const out = [...input]
    for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]] }
    return out
}
function migrateRanks() {
    tx(() => {
        const rows = shuffled(all<Row & { rank: number | null }>('SELECT * FROM client_codenames WHERE rank IS NULL'))
        let next = getSetting('codename_next_rank', 0)
        const scheme = numbering()
        for (const r of rows) {
            run('INSERT OR IGNORE INTO retired_codenames(label) VALUES (?)', slug(r.codename))
            run('UPDATE client_codenames SET codename=? WHERE client=?', `tmp-${randomUUID()}`, r.client)
        }
        for (const r of rows) {
            while (!labelFree(`${scheme.prefix} ${scheme.start + next}`)) next++
            const rank = next++
            if (!Number.isSafeInteger(scheme.start + rank)) throw new AnonInputError('Codename number exceeds safe integer range.')
            run('UPDATE client_codenames SET rank=?,codename=? WHERE client=?', rank, `${scheme.prefix} ${scheme.start + rank}`, r.client)
        }
        setSetting('codename_next_rank', next)
        if (rows.length) {
            setSetting('codename_revision', getSetting('codename_revision', 0) + 1)
            run('INSERT INTO audit(t,who,action,details) VALUES (?,?,?,?)', new Date().toISOString(), 'lens', 'privacy.ranks_migrated', JSON.stringify({ clients: rows.length }))
        }
    })
}
migrateRanks()

liveSettings()
