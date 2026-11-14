// Client privacy is optional; user identities and financial values are never optional.
// App messages and errors keep their wording (they are what PMs act on: "Invalid date", "Counterparty
// not found"); amounts, long numbers, emails, distinct ids and known user names inside them are masked.
import { maskAmounts } from './appevents.ts'
import { anonFor, hideClientsDeep } from './anonymise.ts'
import { config } from './config.ts'
import { all } from './db.ts'
import { identityTokens, scrubWith } from './rescueprivacy.ts'

export function staffEmails(): Set<string> {
    const emails = new Set<string>()
    for (const table of ['people', 'people_v2', 'survey_people', 'dashboard_people', 'mcp_tokens']) {
        try { for (const { email } of all<{ email: string }>(`SELECT DISTINCT email FROM ${table}`)) if (email) emails.add(email.toLowerCase()) } catch { /* old databases may lack a table */ }
    }
    return emails
}
export function safetyWith<T>(value: T, tokens: string[], staff = new Set<string>()): T {
    tokens = tokens.filter(t => !staff.has(t.toLowerCase()))
    const sep = config.properties.distinctIdSeparator
    const text = (s: string): string => {
        try {
            const parsed = JSON.parse(s)
            if (parsed && typeof parsed === 'object') return JSON.stringify(walk(parsed))
        } catch { /* ordinary text */ }
        // Decode for matching, including links that encode an address more than once.
        s = s.replace(/[^\s<>"'`]+/g, token => {
            let decoded = token
            for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(decoded); i++) decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            return decoded.includes('@') || !!sep && decoded.includes(sep) || scrubWith(tokens, decoded) !== decoded ? decoded : token
        })
        s = s.replace(/https?:\/\/[^\s<>"'`]+/g, url => /\/replay\//.test(url) && (url.includes('@') || !!sep && url.includes(sep) || scrubWith(tokens, url) !== url) ? `${config.service.publicUrl}/replays` : url)
        s = s.replace(/[^\s<>"'`]+/g, t => sep && t.includes(sep) && t.split(sep).length >= 2 && t.split(sep).every(Boolean) ? '[person]' : t)
        s = s.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, e => staff.has(e.toLowerCase()) ? e : '[person]')
        // Identifiers are not cash values: URLs (replay links, already checked for identities above),
        // UUIDs (session ids such as 019b55aa-...-123456789012) and release versions keep their digits,
        // or the links break and the ids cannot be passed to the next tool.
        const versions: string[] = []
        const keep = (id: string) => { versions.push(id); return `\uE000v${versions.length - 1}\uE001` }
        s = s.replace(/https?:\/\/[^\s<>"'`]+/g, keep)
        s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, keep)
        s = s.replace(/\b\d{1,2}(?:\.\d{1,2}){2}\b/g, keep)
        return maskAmounts(s.split(/(\[person\]|<amount>|\[withheld\]|\[client\])/g).map((part, i) => i % 2 ? part : scrubWith(tokens, part)).join('')).replace(/\uE000v(\d+)\uE001/g, (_, index) => versions[Number(index)] || '')
    }
    const walk = (v: unknown, key = ''): unknown => {
        if (/^(user|user_?id|distinct_?id|user_?email|person_?id)$/i.test(key.split('.').at(-1) || '') && v != null) return '[person]'
        if (key === 'owner' && typeof v === 'string' && staff.has(v.toLowerCase())) return v
        if (typeof v === 'string' && /(?:notional|amount|cash|balance|price|value)/i.test(key) && /^[-+]?\d[\d., ]*$/.test(v)) return '<amount>'
        if (typeof v === 'string') return text(v)
        if (typeof v === 'number' && /(?:notional|amount|cash|balance|price|value)/i.test(key)) return '<amount>'
        if (/^users$/i.test(key) && Array.isArray(v)) return v.map(x => typeof x === 'string' || typeof x === 'number' ? '[person]' : walk(x))
        if (Array.isArray(v)) return v.map(x => walk(x, key))
        if (v && typeof v === 'object') {
            const out: Record<string, unknown> = {}
            const table = v as { columns?: unknown[]; results?: unknown[] }
            const columns = Array.isArray(table.columns) ? table.columns.map(c => typeof c === 'string' ? c : String((c as { name?: string })?.name || '')) : []
            for (const [k, x] of Object.entries(v)) {
                if (k === 'results' && columns.length && Array.isArray(x)) {
                    out[k] = x.map(row => Array.isArray(row) ? row.map((cell, i) => walk(cell, columns[i] || '')) : walk(row))
                    continue
                }
                const key = text(k), safe = (k === 'note' && ('owner' in v || 'status' in v) || k === 'text' && 'kind' in v && v.kind === 'note') && x != null ? '[withheld]' : walk(x, k)
                // Masked survey labels can coincide; retain their combined answer count.
                out[key] = typeof out[key] === 'number' && typeof safe === 'number' ? out[key] + safe : safe
            }
            return out
        }
        return v
    }
    return walk(value) as T
}
export async function aiSafety<T>(value: T, path: 'lens' | 'triage' | 'posthog' = 'lens'): Promise<T> {
    const safe = safetyWith(value, await identityTokens(), staffEmails())
    return anonFor(path) ? hideClientsDeep(safe).value : safe
}
