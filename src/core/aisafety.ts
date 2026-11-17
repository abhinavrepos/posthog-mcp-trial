// Standard/private mask identities and amounts; open preserves available source data.
// App messages and errors keep their wording (they are what PMs act on: "Invalid date", "Counterparty
// not found"); amounts, long numbers, emails, distinct ids and known user names inside them are masked.
import { appEvents, maskAmounts } from './appevents.ts'
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

const PERSON_COLUMN = /^(?:distinct_?id|person(?:_?id)?|user(?:_?id|name|_?email)?|email|who)$/i
const MONEY_COLUMN = /amount|notional|cash|price|pnl|p&l|balance|cost|revenue|nominal|principal|exposure|mtm|market.?value|\bvalue\b/i
const DURATION_COLUMN = /^(?:(?:avg\.?|average|median|p\d{2})[ _]+)?(?:conversion[ _]+)?(?:time|duration)(?:[ _]+(?:seconds?|minutes?|hours?|ms|s))?$/i
const durationCell = (s: string) => /^(?:-|[-+]?\d+(?:\.\d+)?|(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w)\s*)+)$/i.test(s.trim())
const releaseLabel = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && /^(?:Reval )?\d{1,2}\.\d{1,2}(?:\.\d{1,3})?(?:-[a-z]{1,8}\d{0,3})?$/i.test(String(v))
const HEADER_CELL = /^[A-Za-z_$][\w $().%&/-]{0,60}$/
// PostHog insight tables (trends, funnels, retention, lifecycle) start with one of these; their cells are results.
const INSIGHT_FIRST = /^(?:date|metric|cohort|period|day|week|month|step|breakdown|series)$/i
// SQL columns named like counts, rates or times. Unknown names stay under the prose amount rule (5+ digits masked).
const COUNT_COLUMN = /(?:^|_)(?:count|cnt|n|num|total|events?|sessions?|users?|persons?|people|clients?|dau|wau|mau|visits?|views?|opens?|attempts?|errors?|toasts?|rate|ratio|pct|percent(?:age)?|share|conversion|dropoff|drop_off|retention|retained|returning|new|resurrecting|dormant|days?|weeks?|months?|date|time|duration|median|avg|average|p\d{2}|rank|step|level|version)(?:$|_|s$)/i
/** Column-aware masking of pipe tables (see the call site). Each table row is finished here and wrapped by keep(),
 * so later passes leave counts, dates and durations ("2h 43m") alone. Non-table lines are returned unchanged. */
function pipeTables(s: string, keep: (v: string) => string, staff: Set<string>, scrub: (v: string) => string): string {
    const lines = s.split('\n')
    let header: string[] | null = null, insight = false
    const eventNames = new Set(Object.values(appEvents()?.events || {}))
    const masked = (cell: string) => cell.includes('@') ? maskEmailsIn(cell, staff) : cell
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!line.includes('|')) { header = null; continue }
        const cells = line.split('|')
        const next = lines[i + 1]?.split('|')
        if (!header) {
            // Empty results have only a header; require known dimensions/metrics so a bare user id cannot qualify.
            const empty = /^(?:date|month|event|plan|metric|cohort|period|day|week|step|breakdown|series)$/i.test(cells[0]!.trim()) && cells.slice(1).every(c => COUNT_COLUMN.test(c.trim()) || PERSON_COLUMN.test(c.trim()) || MONEY_COLUMN.test(c.trim()) || eventNames.has(c.trim()))
            if (cells.length >= 2 && cells.every(c => HEADER_CELL.test(c.trim())) && (empty || next && next.length >= cells.length)) { header = cells; insight = INSIGHT_FIRST.test(cells[0]!.trim()); lines[i] = keep(cells.map(c => scrub(c)).join('|')) }
            continue
        }
        let row = cells
        const extra = cells.length - header.length
        if (extra < 0) { header = null; continue }
        if (extra > 0) {
            // One column absorbed extra separators: the run with the most alphabetic parts is the distinct id.
            let best = -1, score = -1
            for (let j = 0; j + extra < cells.length; j++) {
                const run = cells.slice(j, j + extra + 1)
                // A duration or prose cell with spaces cannot be a component of the pipe-delimited login.
                if (!run.every(p => p && !/\s/.test(p))) continue
                const sc = run.filter(p => /[A-Za-z]/.test(p)).length * 2 + (PERSON_COLUMN.test(header[j]!.trim()) ? 1 : 0)
                if (sc > score) { score = sc; best = j }
            }
            if (best < 0) { header = null; continue }
            row = [...cells.slice(0, best), '[person]', ...cells.slice(best + extra + 1)]
        }
        // The finished row is protected as a whole: its '|' separators must not look like a distinct id later.
        lines[i] = keep(row.map((cell, j) => {
            const name = header![j]!.trim()
            if (cell === '[person]') return cell
            if (PERSON_COLUMN.test(name)) return '[person]'
            if (MONEY_COLUMN.test(name) && /\d/.test(cell)) return '<amount>'
            if (!MONEY_COLUMN.test(name) && (insight || COUNT_COLUMN.test(name) || DURATION_COLUMN.test(name) && durationCell(cell))) return scrub(masked(cell))
            // Money-like and unnamed columns: the prose amount rule, applied to this cell now.
            return maskAmounts(scrub(masked(cell)))
        }).join('|'))
    }
    return lines.join('\n')
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
        // PostHog answers with pipe tables (a header row, then rows with the same number of cells). Reval distinct
        // ids use the same '|' separator, so the token rule below wiped every table row ("2025-11-01|900") as a
        // person. Tables are read column by column instead: person-like columns are masked, money-like columns keep
        // amount masking, everything else (counts, dates, rates) is protected from the amount pass. A row with more
        // cells than its header holds a distinct id inside one cell: that run of cells becomes [person].
        if (sep === '|') s = pipeTables(s, keep, staff, (x) => scrubWith(tokens, x))
        s = s.replace(/[^\s<>"'`]+/g, t => sep && t.includes(sep) && t.split(sep).length >= 2 && t.split(sep).every(Boolean) ? '[person]' : t)
        // Emails in linear time: one regex over the text retries from every position of a long run without an
        // @ (quadratic: 200,000 digits took minutes). Only tokens with an @ are scanned, split at each @.
        s = s.replace(/[^\s<>"'`]+/g, (t) => (t.includes('@') ? maskEmailsIn(t, staff) : t))
        // Identifiers are not cash values: URLs (replay links, already checked for identities above),
        // UUIDs (session ids such as 019b55aa-...-123456789012) and release versions keep their digits,
        // or the links break and the ids cannot be passed to the next tool.
        // A link keeps its path, but query values that look like money are masked (?notional=250000);
        // id-like parameters (t, id, session, version...) keep their digits so links still work; so does a clip file
        // name (?clip=<session>_<start>-<end>.mp4): a session id with 5+ digits in a row was masked and the link died.
        s = s.replace(/https?:\/\/[^\s<>"'`]+/g, (url) => keep(url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep, k, v) =>
            /(?:^|_)(?:id|uuid|t|ts|time|session|sid|page|p|v|ver|version)$/i.test(k) || k === 'clip' && /^[\w-]+_\d+-\d+\.mp4$/.test(decodeURIComponent(v)) || maskAmounts(v) === v ? m : `${sep}${k}=<amount>`)))
        s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, keep)
        s = s.replace(/\b\d{1,2}(?:\.\d{1,2}){2}\b/g, keep)
        // A release named after the app ("Reval 26.3") is a label, like 26.3.1 above; the amount pass read 26.3 as cash.
        const app = appEvents()?.app
        if (app) s = s.replace(new RegExp(String.raw`\b${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \d{1,2}\.\d{1,2}(?:\.\d{1,3})?\b`, 'gi'), keep)
        return maskAmounts(s.split(/(\[person\]|<amount>|\[withheld\]|\[client\])/g).map((part, i) => i % 2 ? part : scrubWith(tokens, part)).join('')).replace(/\uE000v(\d+)\uE001/g, (_, index) => versions[Number(index)] || '')
    }
    const walk = (v: unknown, key = ''): unknown => {
        if (PERSON_COLUMN.test(key.split('.').at(-1) || '') && v != null) return '[person]'
        if (key === 'owner' && typeof v === 'string' && staff.has(v.toLowerCase())) return v
        // Under a money-like field everything with a digit is money, nested values included ({"amount":"250k"},
        // {"amount":{"major":250,"zeros":3}}).
        // "value" alone is too generic ({"property":"browser","value":"Chrome 120"}): only a bare number there.
        const field = key.split('.').at(-1) || ''   // properties.value, person.properties.amount
        if (/^trade_?ids?$/i.test(field)) return v
        // A find_trade paging cursor ("<first seen>|<session id>") is not a Reval user id (ENV|01|C88|user3), even
        // though both use "|": masked, the agent could not ask for the next page.
        if (/^(?:next_)?cursor$/i.test(field) && typeof v === 'string' && /^[^|]{1,40}\|[\w.:-]{1,120}$/.test(v) && Number.isFinite(Date.parse(v.slice(0, v.indexOf('|'))))) return v
        // Releases ("Reval 26.3", "26.3.1") are labels, not money: the amount pass read "26.3" as cash.
        if (/^(?:app_?)?version$|_version$/i.test(field) && releaseLabel(v)) return v
        if (/^(client|client_?code|client_?id)$/i.test(field) && (typeof v === 'string' || typeof v === 'number')) return v
        if (/^value$/i.test(field) && (typeof v === 'number' || typeof v === 'string' && /^[-+]?\d[\d., ]*$/.test(v))) return '<amount>'
        if (MONEY_COLUMN.test(field) && !/^value$/i.test(field)) {
            // Numbers and digit-bearing text are money; anything else still goes through walk(), so identity
            // fields nested under a money field ({"amount":{"user_id":...}}) are masked as people.
            const money = (x: unknown, k = key): unknown => typeof x === 'number' ? '<amount>' : typeof x === 'string' ? (/\d/.test(x) ? '<amount>' : text(x))
                : Array.isArray(x) ? x.map((y) => money(y, k)) : x && typeof x === 'object'
                    ? Object.fromEntries(Object.entries(x).map(([n, y]) => [text(n), (PERSON_COLUMN.test(n) || /^users$/i.test(n)) ? walk(y, n) : money(y, n)])) : x
            if (typeof v === 'string' || typeof v === 'number' || (v && typeof v === 'object')) return money(v)
        }
        if (typeof v === 'string' && COUNT_COLUMN.test(field) && !MONEY_COLUMN.test(field) && /^[-+]?\d[\d., ]*%?$/.test(v)) return scrubWith(tokens, v)
        if (typeof v === 'string') return text(v)
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
                // A filter echo on an app version ({dimension:'app_version', value:'Reval 26.3'}) is a release label.
                if (k === 'value' && typeof (v as { dimension?: unknown }).dimension === 'string' && /version/i.test((v as { dimension: string }).dimension)
                    && (typeof x === 'string' || Array.isArray(x))) {
                    const label = (y: unknown) => releaseLabel(y) ? y : walk(y, k)
                    out[text(k)] = Array.isArray(x) ? x.map(label) : label(x); continue
                }
                // Only the operational block has exactly these fields and processing states; action/team notes stay private.
                const processing = Object.keys(v).length === 3 && 'data_through' in v && 'status' in v && 'note' in v
                    && (v.data_through === null || typeof v.data_through === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.data_through))
                    && ['processed', 'includes_unprocessed_days', 'unknown'].includes(String(v.status))
                const key = text(k), safe = !jobNote && !processing && (k === 'note' && ('owner' in v || 'status' in v) || k === 'text' && 'kind' in v && v.kind === 'note') && x != null ? '[withheld]' : walk(x, k)
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
