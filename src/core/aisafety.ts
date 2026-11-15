// Standard/private mask identities and amounts; open preserves available source data.
// App messages and errors keep their wording (they are what PMs act on: "Invalid date", "Counterparty
// not found"); amounts, long numbers, emails, distinct ids and known user names inside them are masked.
import { maskAmounts } from './appevents.ts'
import { protectCodenameTokens, anonFor, hideClientsDeep, privacyMode, withPrivacy } from './anonymise.ts'
import { config } from './config.ts'
import { all } from './db.ts'
import { JOB_HANDLE_NOTE } from './jobnote.ts'
export { JOB_HANDLE_NOTE }
import { identityTokens, scrubWith } from './rescueprivacy.ts'

export function staffEmails(): Set<string> {
    const emails = new Set<string>()
    for (const table of ['people', 'people_v2', 'survey_people', 'dashboard_people', 'mcp_tokens']) {
        try { for (const { email } of all<{ email: string }>(`SELECT DISTINCT email FROM ${table}`)) if (email) emails.add(email.toLowerCase()) } catch { /* old databases may lack a table */ }
    }
    return emails
}
const LOCAL = /[\p{L}\p{N}._%+-]/u
// local@domain.tld inside one token: the local part is the run of address characters before each @ (found by
// walking back, never a regex anchored at the end), the domain must hold a dot. Staff addresses stay.
function maskEmailsIn(token: string, staff: Set<string>): string {
    const parts = token.split('@'), out = [parts[0]!]
    for (let i = 1; i < parts.length; i++) {
        const prev = out[out.length - 1]!
        // Walk back by whole characters: a letter outside the BMP (𐐀) is two UTF-16 units.
        let j = prev.length
        while (j > 0) {
            const k = j >= 2 && /[\uDC00-\uDFFF]/.test(prev[j - 1]!) && /[\uD800-\uDBFF]/.test(prev[j - 2]!) ? j - 2 : j - 1
            if (!LOCAL.test(prev.slice(k, j))) break
            j = k
        }
        const domain = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u.exec(parts[i]!)
        if (j < prev.length && domain) {
            const email = `${prev.slice(j)}@${domain[0]}`
            out[out.length - 1] = prev.slice(0, j) + (staff.has(email.toLowerCase()) ? email : '[person]') + parts[i]!.slice(domain[0].length)
        } else out.push(parts[i]!)
    }
    return out.join('@')
}

export function safetyWith<T>(value: T, tokens: string[], staff = new Set<string>()): T {
    if (privacyMode() === 'open') return value
    tokens = tokens.filter(t => !staff.has(t.toLowerCase()))
    const sep = config.properties.distinctIdSeparator
    const text = (s: string): string => {
        // The private-use characters this pass uses as placeholders mean nothing in real text: drop them,
        // so input cannot forge a placeholder.
        s = s.replace(/[\uE000-\uE003]/g, '')
        try {
            const parsed = JSON.parse(s)
            if (parsed && typeof parsed === 'object') return JSON.stringify(walk(parsed))
        } catch { /* ordinary text */ }
        // A tool answer as sent: a heading, then a fenced JSON block. Walk the JSON by key (only money fields are
        // amounts) instead of masking it as prose, where every long number looks like cash: counts such as
        // "events": 10941928 were coming out as <amount> on this second, transport-level pass.
        // Linear: one indexOf for the opening fence and one lastIndexOf for the closing one (a regex here rescanned
        // the rest of the string for every opening fence, which crafted text could make quadratic).
        const open = s.indexOf('```json\n'), close = s.lastIndexOf('\n```')
        const fenced = open >= 0 && close > open + 7 && /^\s*$/.test(s.slice(close + 4)) ? [s, s.slice(0, open), s.slice(open + 8, close)] : null
        if (fenced) {
            try {
                const parsed = JSON.parse(fenced[2])
                if (parsed && typeof parsed === 'object') return `${fenced[1] ? text(fenced[1]) : ''}\`\`\`json\n${JSON.stringify(walk(parsed), null, /\n {2}"/.test(fenced[2]) ? 2 : undefined)}\n\`\`\``
            } catch { /* not JSON after all: treated as prose below */ }
        }
        const versions: string[] = []
        const keep = (id: string) => { versions.push(id); return `\uE000v${versions.length - 1}\uE001` }
        s = protectCodenameTokens(s, keep)
        // Decode for matching, including links that encode an address more than once.
        s = s.replace(/[^\s<>"'`]+/g, token => {
            let decoded = token
            for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(decoded); i++) decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            return decoded.includes('@') || !!sep && decoded.includes(sep) || scrubWith(tokens, decoded) !== decoded ? decoded : token
        })
        s = s.replace(/https?:\/\/[^\s<>"'`]+/g, url => /\/replay\//.test(url) && (url.includes('@') || !!sep && url.includes(sep) || scrubWith(tokens, url) !== url) ? `${config.service.publicUrl}/replays` : url)
        s = s.replace(/[^\s<>"'`]+/g, t => sep && t.includes(sep) && t.split(sep).length >= 2 && t.split(sep).every(Boolean) ? '[person]' : t)
        // Emails in linear time: one regex over the text retries from every position of a long run without an
        // @ (quadratic: 200,000 digits took minutes). Only tokens with an @ are scanned, split at each @.
        s = s.replace(/[^\s<>"'`]+/g, (t) => (t.includes('@') ? maskEmailsIn(t, staff) : t))
        // Identifiers are not cash values: URLs (replay links, already checked for identities above),
        // UUIDs (session ids such as 019b55aa-...-123456789012) and release versions keep their digits,
        // or the links break and the ids cannot be passed to the next tool.
        // A link keeps its path, but query values that look like money are masked (?notional=250000);
        // id-like parameters (t, id, session, version...) keep their digits so links still work.
        s = s.replace(/https?:\/\/[^\s<>"'`]+/g, (url) => keep(url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep, k, v) =>
            /(?:^|_)(?:id|uuid|t|ts|time|session|sid|page|p|v|ver|version)$/i.test(k) || maskAmounts(v) === v ? m : `${sep}${k}=<amount>`)))
        s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, keep)
        s = s.replace(/\b\d{1,2}(?:\.\d{1,2}){2}\b/g, keep)
        return maskAmounts(s.split(/(\[person\]|<amount>|\[withheld\]|\[client\])/g).map((part, i) => i % 2 ? part : scrubWith(tokens, part)).join('')).replace(/\uE000v(\d+)\uE001/g, (_, index) => versions[Number(index)] || '')
    }
    const walk = (v: unknown, key = ''): unknown => {
        if (/^(user|user_?id|distinct_?id|user_?email|person_?id)$/i.test(key.split('.').at(-1) || '') && v != null) return '[person]'
        if (key === 'owner' && typeof v === 'string' && staff.has(v.toLowerCase())) return v
        // Under a money-like field everything with a digit is money, nested values included ({"amount":"250k"},
        // {"amount":{"major":250,"zeros":3}}).
        // "value" alone is too generic ({"property":"browser","value":"Chrome 120"}): only a bare number there.
        const field = key.split('.').at(-1) || ''   // properties.value, person.properties.amount
        if (/^trade_?ids?$/i.test(field)) return v
        // Releases ("Reval 26.3", "26.3.1") are labels, not money: the amount pass read "26.3" as cash.
        if (/^(?:app_?)?version$|_version$/i.test(field) && (typeof v === 'string' || typeof v === 'number')) return v
        if (/^(client|client_?code|client_?id)$/i.test(field) && (typeof v === 'string' || typeof v === 'number')) return v
        if (/^value$/i.test(field) && (typeof v === 'number' || typeof v === 'string' && /^[-+]?\d[\d., ]*$/.test(v))) return '<amount>'
        if (/(?:notional|amount|cash|balance|price)/i.test(field)) {
            // Numbers and digit-bearing text are money; anything else still goes through walk(), so identity
            // fields nested under a money field ({"amount":{"user_id":...}}) are masked as people.
            const money = (x: unknown, k = key): unknown => typeof x === 'number' ? '<amount>' : typeof x === 'string' ? (/\d/.test(x) ? '<amount>' : walk(x, k))
                : Array.isArray(x) ? x.map((y) => money(y, k)) : x && typeof x === 'object'
                    ? Object.fromEntries(Object.entries(x).map(([n, y]) => [text(n), /^(user|user_?id|distinct_?id|user_?email|person_?id|users)$/i.test(n) ? walk(y, n) : money(y, n)])) : x
            if (typeof v === 'string' || typeof v === 'number' || (v && typeof v === 'object')) return money(v)
        }
        if (typeof v === 'string') return text(v)
        if (typeof v === 'number' && /(?:notional|amount|cash|balance|price|value)/i.test(field)) return '<amount>'
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
                // A job handle's note is the fixed server instruction (runningResult in jobs.ts), not a person's free text.
                const jobNote = k === 'note' && (v as { status?: unknown }).status === 'running' && 'job_id' in v && x === JOB_HANDLE_NOTE
                const key = text(k), safe = !jobNote && (k === 'note' && ('owner' in v || 'status' in v) || k === 'text' && 'kind' in v && v.kind === 'note') && x != null ? '[withheld]' : walk(x, k)
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
    return withPrivacy(async () => {
        if (privacyMode() === 'open') return value
        const safe = safetyWith(value, await identityTokens(), staffEmails())
        return anonFor(path) ? hideClientsDeep(safe).value : safe
    })
}

/** Schemas are protocol metadata: scrub their text without changing field types or numeric limits. */
export function metadataSafetyWith<T>(value: T, tokens: string[], staff = new Set<string>()): T {
    const walk = (v: unknown): unknown => typeof v === 'string' ? safetyWith(v, tokens, staff)
        : Array.isArray(v) ? v.map(walk)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,walk(x)])) : v
    return walk(value) as T
}
export function aiMetadataSafety<T>(value: T): Promise<T> {
    return withPrivacy(async () => {
        const safe = metadataSafetyWith(value, await identityTokens(), staffEmails())
        return anonFor('lens') ? hideClientsDeep(safe).value : safe
    })
}
