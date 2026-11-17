import { privacyMode, withPrivacy } from './anonymise.ts'
// Defense in depth for free text copied from task titles and team notes.
import { cached, tasksDb } from './tasks.ts'
import { ALL_CLIENTS } from './catalog.ts'
import { config } from './config.ts'

const MIN = 3 // shorter tokens are replaced only when they are the whole string
interface Matcher { exact: Set<string>; short: string[]; byPrefix: Map<string, string[]>; cased: Set<string> }
const matchers = new WeakMap<string[], Matcher>()
function matcher(tokens: string[]): Matcher {
    let m = matchers.get(tokens)
    if (!m) {
        // Tokens arrive longest first, so each prefix list keeps that order and the first hit is the longest.
        const byPrefix = new Map<string, string[]>()
        for (const t of tokens.map(t => t.toLowerCase())) if (t.length >= MIN) { const k = t.slice(0, MIN), list = byPrefix.get(k); if (list) list.push(t); else byPrefix.set(k, [t]) }
        m = { exact: new Set(tokens.map(t => t.toLowerCase())), short: tokens.filter((t) => t.length < MIN).map(t => t.toLowerCase()), byPrefix, cased: new Set(tokens) }
        matchers.set(tokens, m)
    }
    return m
}
/** One pass over the text: every character covered by any token occurrence is hidden; each covered run
 * (overlapping or touching occurrences merged) becomes one [person]. At least as strict as replacing tokens
 * one by one, longest first. */
function replaceTokens(text: string, m: Matcher): string {
    const folded = text.toLowerCase()
    // Lowercasing can expand a Unicode character; keep offsets into the original text.
    const offsets: number[] = []
    if (folded.length !== text.length) {
        let at = 0
        for (const c of text) { for (let j = 0; j < c.toLowerCase().length; j++) offsets.push(at); at += c.length }
        offsets.push(text.length)
    }
    const original = (i: number) => offsets.length ? offsets[i]! : i
    let out = '', last = 0, runStart = -1, runEnd = -1
    for (let i = 0; i + MIN <= folded.length; i++) {
        const list = m.byPrefix.get(folded.slice(i, i + MIN))
        if (!list) continue
        for (const t of list) if (folded.startsWith(t, i)) {
            const start = original(i), end = original(i + t.length)
            // Same case as a known identity: hidden anywhere, as before. Another case ("JANE SMITH") only as a
            // whole word, so a login like "admin" or "mark" does not eat "Admin page" or "market".
            if (!m.cased.has(text.slice(start, end)) && (/[\p{L}\p{N}]/u.test(text[start - 1] || '') || /[\p{L}\p{N}]/u.test(text[end] || ''))) continue
            if (runStart < 0 || start > runEnd) { if (runStart >= 0) { out += text.slice(last, runStart) + '[person]'; last = runEnd } runStart = start; runEnd = end }
            else runEnd = Math.max(runEnd, end)
            break // longest first: later ones in this list end sooner
        }
    }
    if (runStart >= 0) { out += text.slice(last, runStart) + '[person]'; last = runEnd }
    return last ? out + text.slice(last) : text
}
const containsToken = (text: string, m: Matcher) => replaceTokens(text, m) !== text

export async function identityTokens(): Promise<string[]> {
    return cached('rescue-identity-tokens', {}, async () => {
        const rows = tasksDb.prepare('SELECT user FROM known_users').all() as { user: string }[]
        return [...new Set([...ALL_CLIENTS.flatMap(c => c.users.flatMap(u => [u.name, u.email])), ...rows.flatMap(({ user }) => {
            const person = user.split(config.properties.distinctIdSeparator).at(-1) || ''
            return [user, person, person.includes('@') ? person.split('@')[0] : ''].filter(Boolean)
        })])].sort((a,b) => b.length - a.length)
    })
}
export async function rescuePrivacy<T>(value: T): Promise<T> {
    return withPrivacy(async () => privacyMode() === 'open' ? value : scrubWith(await identityTokens(), value))
}
/** Replaces identity tokens (sorted longest first) anywhere in strings inside value. */
export function scrubWith<T>(tokens: string[], value: T): T {
    const m = matcher(tokens)
    const safe = (v: unknown): unknown => {
        if (typeof v === 'string') {
            if (m.exact.has(v.toLowerCase())) return '[person]'
            // Whole tokens holding an @, found without a regex that retries at every position (quadratic on a long
            // run with no @: 200,000 digits took minutes).
            v = v.replace(/[^\s<>"']+/g, match => match.includes('@') && (containsToken(match, m) || m.short.some(t => match.toLowerCase().includes(t))) ? '[person]' : match)
            return replaceTokens(v as string, m)
        }
        if (Array.isArray(v)) return v.map(safe)
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,safe(x)]))
        return v
    }
    return safe(value) as T
}
