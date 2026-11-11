// Defense in depth for free text copied from task titles and team notes.
import { cached, tasksDb } from './tasks.ts'
import { config } from './config.ts'

const MIN = 3 // shorter tokens are replaced only when they are the whole string
interface Matcher { exact: Set<string>; short: string[]; byPrefix: Map<string, string[]> }
const matchers = new WeakMap<string[], Matcher>()
function matcher(tokens: string[]): Matcher {
    let m = matchers.get(tokens)
    if (!m) {
        // Tokens arrive longest first, so each prefix list keeps that order and the first hit is the longest.
        const byPrefix = new Map<string, string[]>()
        for (const t of tokens) if (t.length >= MIN) { const k = t.slice(0, MIN), list = byPrefix.get(k); if (list) list.push(t); else byPrefix.set(k, [t]) }
        m = { exact: new Set(tokens), short: tokens.filter((t) => t.length < MIN), byPrefix }
        matchers.set(tokens, m)
    }
    return m
}
/** One pass over the text: every character covered by any token occurrence is hidden; each covered run
 * (overlapping or touching occurrences merged) becomes one [person]. At least as strict as replacing tokens
 * one by one, longest first. */
function replaceTokens(text: string, m: Matcher): string {
    let out = '', last = 0, runStart = -1, runEnd = -1
    for (let i = 0; i + MIN <= text.length; i++) {
        const list = m.byPrefix.get(text.slice(i, i + MIN))
        if (!list) continue
        for (const t of list) if (text.startsWith(t, i)) {
            if (runStart < 0 || i > runEnd) { if (runStart >= 0) { out += text.slice(last, runStart) + '[person]'; last = runEnd } runStart = i; runEnd = i + t.length }
            else runEnd = Math.max(runEnd, i + t.length)
            break // longest first: later ones in this list end sooner
        }
    }
    if (runStart >= 0) { out += text.slice(last, runStart) + '[person]'; last = runEnd }
    return last ? out + text.slice(last) : text
}
const containsToken = (text: string, m: Matcher) => replaceTokens(text, m) !== text

export async function rescuePrivacy<T>(value: T): Promise<T> {
    const tokens = await cached('rescue-identity-tokens', {}, async () => {
        const rows = tasksDb.prepare('SELECT user FROM known_users').all() as { user: string }[]
        return [...new Set(rows.flatMap(({ user }) => {
            const person = user.split(config.properties.distinctIdSeparator).at(-1) || ''
            return [user, person, person.includes('@') ? person.split('@')[0] : ''].filter(Boolean)
        }))].sort((a,b) => b.length - a.length)
    })
    return scrubWith(tokens, value)
}
/** Replaces identity tokens (sorted longest first) anywhere in strings inside value. */
export function scrubWith<T>(tokens: string[], value: T): T {
    const m = matcher(tokens)
    const safe = (v: unknown): unknown => {
        if (typeof v === 'string') {
            if (m.exact.has(v)) return '[person]'
            v = v.replace(/[^\s<>"']+@[^\s<>"']+/g, match => containsToken(match, m) || m.short.some(t => match.includes(t)) ? '[person]' : match)
            return replaceTokens(v as string, m)
        }
        if (Array.isArray(v)) return v.map(safe)
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,safe(x)]))
        return v
    }
    return safe(value) as T
}
