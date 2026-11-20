// Configured application vocabulary and live replay discovery.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { config, ROOT } from './config.ts'
import { hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'
import { userExpr, normalise } from './identity.ts'
import { ToolInputError } from './toolinputerror.ts'
export type Role = 'dialog' | 'dialogName' | 'tab' | 'action' | 'control' | 'button' | 'version'
export const ROLES: Role[] = ['dialog', 'dialogName', 'tab', 'action', 'control', 'button', 'version']
export type Outcome = 'completed' | 'accepted' | 'error' | 'empty' | 'none'

export interface AppEvents {
    app: string
    distinctIdParts?: string[]
    about: string
    events: { screen: string; interaction: string }
    properties: Partial<Record<Role, { name: string; meaning: string; examples?: string[] }>>
    dialogs: { messages: string[]; notices: string[]; menu: string[] }
    screenActions: { open: string[]; focus: string[]; close: string[] }
    submitButtons: string[]
    outcomeSeconds: number
    outcomes: { match: string; outcome: Outcome; note?: string }[]
    messageOutcome: Outcome
    noticeOutcome: Outcome
    generatedIds: string[]
    aliases: Record<string, string>
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
const OUTCOMES: Outcome[] = ['completed', 'accepted', 'error', 'empty', 'none']

/** Checks a vocabulary and fills defaults. Property names go into HogQL, so only plain names. */
export function parseAppEvents(raw: unknown, source = 'APP_EVENTS_FILE'): AppEvents {
    const r = (raw || {}) as Partial<AppEvents>
    const bad = (m: string) => new Error(`${source}: ${m}`)
    const list = (v: unknown, what: string): string[] => {
        if (v === undefined) return []
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad(`${what} must be a list of strings`)
        return v
    }
    const properties: AppEvents['properties'] = {}
    for (const [role, v] of Object.entries(r.properties || {})) {
        if (!ROLES.includes(role as Role)) throw bad(`unknown property role "${role}" (known: ${ROLES.join(', ')})`)
        if (!v || typeof v.name !== 'string' || !IDENT.test(v.name)) throw bad(`properties.${role}.name must be a plain property name`)
        properties[role as Role] = { name: v.name, meaning: String(v.meaning || ''), examples: list(v.examples, `properties.${role}.examples`) }
    }
    if (!properties.dialog) throw bad('properties.dialog is required')
    const regexes = (v: unknown, what: string) => {
        const l = list(v, what)
        for (const x of l) {
            try {
                new RegExp(x, 'i')
            } catch {
                throw bad(`${what}: "${x}" is not a regular expression`)
            }
        }
        return l
    }
    const outcome = (v: unknown, d: Outcome): Outcome => {
        if (v === undefined) return d
        if (!OUTCOMES.includes(v as Outcome)) throw bad(`outcome "${v}" is not one of ${OUTCOMES.join(', ')}`)
        return v as Outcome
    }
    const outcomes = (r.outcomes || []).map((o) => {
        regexes([o.match], 'outcomes.match')
        return { match: o.match, outcome: outcome(o.outcome, 'completed'), note: o.note }
    })
    return {
        app: String(r.app || 'the app'),
        distinctIdParts: list(r.distinctIdParts, 'distinctIdParts'),
        about: String(r.about || ''),
        events: { screen: String(r.events?.screen || '$pageview'), interaction: String(r.events?.interaction || '$autocapture') },
        properties,
        dialogs: { messages: list(r.dialogs?.messages, 'dialogs.messages'), notices: list(r.dialogs?.notices, 'dialogs.notices'), menu: list(r.dialogs?.menu, 'dialogs.menu') },
        screenActions: {
            open: list(r.screenActions?.open, 'screenActions.open'),
            focus: list(r.screenActions?.focus, 'screenActions.focus'),
            close: list(r.screenActions?.close, 'screenActions.close'),
        },
        submitButtons: list(r.submitButtons, 'submitButtons'),
        outcomeSeconds: Math.min(300, Math.max(1, Number(r.outcomeSeconds) || 20)),
        outcomes,
        messageOutcome: outcome(r.messageOutcome, 'error'),
        noticeOutcome: outcome(r.noticeOutcome, 'completed'),
        generatedIds: regexes(r.generatedIds, 'generatedIds'),
        aliases: Object.fromEntries(Object.entries(r.aliases || {}).map(([k, v]) => [k, String(v)])),
    }
}

let loaded: AppEvents | null | undefined
/** The vocabulary from APP_EVENTS_FILE, or null when none is set. */
export function appEvents(): AppEvents | null {
    if (loaded !== undefined) return loaded
    const file = config.appEventsFile
    if (!file) return (loaded = null)
    const path = isAbsolute(file) ? file : join(ROOT, file)
    return (loaded = parseAppEvents(JSON.parse(readFileSync(path, 'utf8')), file))
}


export function required(): AppEvents {
    const reg = appEvents()
    if (!reg) throw new ToolInputError('Set APP_EVENTS_FILE to the application event map.')
    return reg
}
export const prop = (reg: AppEvents, role: Role) => reg.properties[role] ? `toString(properties.${reg.properties[role]!.name})` : `''`
export async function observedAppEventNames(): Promise<string[] | undefined> {
    const rows = await hogql(`SELECT event FROM events WHERE timestamp >= now() - INTERVAL 7 DAY GROUP BY event LIMIT 1000`, {}, {cache:true,ttlMs:600000})
    return rows.map(r => String(r.event))
}
export async function newestSessions(sql: string, values: Record<string, unknown>, from: Date, to: Date, limit: number, by: 'first' | 'last'): Promise<Record<string, unknown>[]> {
    const found = new Map<string, Record<string, unknown>>()
    for (let end = to, days = 7; end > from && found.size < limit; days = Math.min(days * 2, 90)) {
        const start = new Date(Math.max(+from, +end - days * 86_400_000))
        for (const r of await hogql(sql, { ...values, from: start.toISOString(), to: end.toISOString() })) {
            const old = found.get(String(r.sid)), t = String(r[by])
            // A session crossing a slice edge: keep its earliest first / latest last.
            if (!old || (by === 'first' ? t < String(old[by]) : t > String(old[by]))) found.set(String(r.sid), r)
        }
        end = start
    }
    // Ties broken by session id, so a page boundary (find_trade's cursor) is stable.
    return [...found.values()].sort((a, b) => String(b[by]).localeCompare(String(a[by])) || String(b.sid).localeCompare(String(a.sid))).slice(0, limit)
}


export async function recordingSpans(ids: string[]) {
    if (!ids.length) return new Map<string, {start: string; end: string}>()
    const rows = await hogql(`SELECT session_id, min(min_first_timestamp) AS start, max(max_last_timestamp) AS end
        FROM raw_session_replay_events WHERE session_id IN {ids} GROUP BY session_id LIMIT 100`, {ids})
    return new Map(rows.map(r => [String(r.session_id), {start: new Date(String(r.start)).toISOString(), end: new Date(String(r.end)).toISOString()}]))
}
export interface SessionQuery { clientId: string; screen?: string; what?: string; user?: string; email?: string; from: Date; to: Date; limit?: number; cursor?: string; recordedOnly?: boolean }
export async function findSessions(q: SessionQuery) {
    if (!Number.isFinite(+q.from) || !Number.isFinite(+q.to) || q.to <= q.from || +q.to - +q.from > 366 * 86400000) throw new ToolInputError('Choose a time window of at most one year.')
    const reg = required(), limit = Math.max(1, Math.min(q.limit ?? 10, 30))
    let after: {ts:string; sid:string} | undefined
    if (q.cursor) {
        const i = q.cursor.indexOf('|'), ts = q.cursor.slice(0,i), sid = q.cursor.slice(i+1)
        if (i < 0 || !Number.isFinite(Date.parse(ts)) || !/^[\w.:-]{1,120}$/.test(sid)) throw new ToolInputError('Pass next_cursor unchanged.')
        after = {ts,sid}
    }
    const screen = [prop(reg,'dialog'),prop(reg,'dialogName'),prop(reg,'tab'), 'toString(properties.$pathname)']
    const action = [prop(reg,'action'),prop(reg,'button'),prop(reg,'control'), 'event']
    const contains = (parts:string[], key:string) => `({${key}} = '' OR ` + parts.map(p => `positionCaseInsensitive(${p}, {${key}}) > 0`).join(' OR ') + ')'
    const userFilter = `({user} = '' OR replaceRegexpAll(lower(${userExpr()}), '[ _-]', '') = {user} OR replaceRegexpAll(lower(toString(distinct_id)), '[ _-]', '') = {user} OR replaceRegexpAll(lower(toString(${P.email})), '[ _-]', '') = {user})`
    const values = {client:q.clientId, screen:q.screen || '', what:q.what || '', user:normalise(q.user || q.email || ''), cts:after?.ts || '', csid:after?.sid || ''}
    // Session-level filters allow the screen and action to occur on different events.
    const sql = `SELECT toString(properties.$session_id) AS sid, max(timestamp) AS last,
        minIf(timestamp, ${q.what ? contains(action,'what') : contains(screen,'screen')}) AS first_match
        FROM events WHERE timestamp >= {from} AND timestamp < {to}
        AND toString(${P.client}) = {client} AND notEmpty(toString(properties.$session_id)) AND ${userFilter}
        ${q.recordedOnly ? 'AND toString(properties.$session_id) IN (SELECT session_id FROM raw_session_replay_events WHERE min_first_timestamp >= {from} - INTERVAL 1 DAY AND min_first_timestamp < {to})' : ''}
        GROUP BY sid HAVING countIf(${contains(screen,'screen')}) > 0 AND countIf(${contains(action,'what')}) > 0
        ${after ? 'AND (last < {cts} OR (last = {cts} AND sid < {csid}))' : ''}
        ORDER BY last DESC, sid DESC LIMIT ${limit+1}`
    const hits = await newestSessions(sql, values, q.from, after ? new Date(Math.min(+q.to,Date.parse(after.ts)+1)) : q.to, limit+1,'last')
    const more = hits.length > limit; hits.length = Math.min(hits.length,limit)
    let spans: Awaited<ReturnType<typeof recordingSpans>> = new Map(), recordingCheckFailed = false
    try { spans = await recordingSpans(hits.map(h=>String(h.sid))) } catch { recordingCheckFailed = true }
    const sessions = []
    for (const h of hits) {
        const sid = String(h.sid)
        const ev = await hogql(`SELECT timestamp AS ts, toString(distinct_id) AS distinct_id, ${userExpr()} AS user,
            ${prop(reg,'dialog')} AS dialog, ${prop(reg,'dialogName')} AS name, ${prop(reg,'tab')} AS tab,
            ${prop(reg,'action')} AS action, ${prop(reg,'button')} AS message, toFloat(properties.$time) AS ctime, toString(properties.$pathname) AS path, event
            FROM events WHERE timestamp >= {from} AND timestamp < {to} AND properties.$session_id = {sid}
            AND toString(${P.client}) = {client} AND ${userFilter} ORDER BY timestamp LIMIT 5000`,
            {...values,sid,from:q.from.toISOString(),to:q.to.toISOString()})
        const matches = ev.filter(e => (!q.screen || [e.dialog,e.name,e.tab,e.path].some(v=>String(v || '').toLowerCase().includes(q.screen!.toLowerCase()))) && (!q.what || [e.action,e.message,e.event].some(v=>String(v || '').toLowerCase().includes(q.what!.toLowerCase()))))
        const first = matches[0] || ev.find(e=>!q.what || String(e.message || e.action || '').toLowerCase().includes(q.what.toLowerCase())) || ev[0]
        const span = spans.get(sid)
        const matchMs = Number(first?.ctime)>1e9 ? Number(first!.ctime)*1000 : Date.parse(String(h.first_match || first?.ts))
        const offset = span && Number.isFinite(matchMs) ? Math.max(0,(matchMs-Date.parse(span.start))/1000) : 0
        sessions.push({session_id:sid, user:String(ev[0]?.user || ''), distinct_id:ev[0]?.distinct_id,
            start:span?.start || ev[0]?.ts, end:span?.end || ev.at(-1)?.ts,
            screens:[...new Set(ev.flatMap(e=>[e.name,e.tab,e.dialog,e.path]).filter(Boolean).map(String))],
            matched_actions:ev.filter(e=>!q.what || [e.action,e.message,e.event].some(v=>String(v || '').toLowerCase().includes(q.what!.toLowerCase()))).slice(0,100).map(e=>({at:e.ts,action:e.action,message:e.message})),
            error_count:ev.filter(e=>(reg.messageOutcome==='error' && reg.dialogs.messages.includes(String(e.dialog))) || (reg.noticeOutcome==='error' && reg.dialogs.notices.includes(String(e.dialog))) || /error|exception/i.test(String(e.event))).length,
            recording:span ? true : recordingCheckFailed ? 'unknown' : false, offset_s:offset,
            replay_url:replayUrl(sid,offset), clip_url:`${config.service.publicUrl}/replays?url=${encodeURIComponent(replayUrl(sid,offset))}`,
            ...(ev.length===5000 ? {truncated:true} : {})})
    }
    const last = hits.at(-1)
    return {sessions, ...(more && last ? {next_cursor:`${last.last}|${last.sid}`} : {}),
        note:recordingCheckFailed ? 'Recording availability could not be checked.' : sessions.length && !sessions.some(s=>s.recording===true) ? 'Sessions found, but none have a recording.' : 'Newest sessions first. Details are limited to 5000 events per session; matched actions to 100.'}
}
