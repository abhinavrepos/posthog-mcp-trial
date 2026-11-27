// Configured application vocabulary and live replay discovery.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { config, ROOT } from './config.ts'
import { hogql, replayUrl, isTruncated, markPartial, type Completeness } from './posthog.ts'
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
    /** completion: actions that complete a screen without a save (e.g. a report's Run/Export); dialogMatch is a regex on the dialog id. */
    replaySuccess: { noticeAfterSubmit: boolean; closeAfterSubmit: boolean; noticeMatch: string[]; completion: { dialogMatch: string; buttons: string[] }[] }
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
        replaySuccess: { noticeAfterSubmit: r.replaySuccess?.noticeAfterSubmit === true, closeAfterSubmit: r.replaySuccess?.closeAfterSubmit === true, noticeMatch: regexes(r.replaySuccess?.noticeMatch, 'replaySuccess.noticeMatch'),
            completion: (() => { const c = r.replaySuccess?.completion; if (c === undefined) return []; if (!Array.isArray(c)) throw bad('replaySuccess.completion must be a list'); return c.slice(0, 20).map((x: any, i: number) => ({ dialogMatch: regexes([x?.dialogMatch], `replaySuccess.completion[${i}].dialogMatch`)[0]!, buttons: list(x?.buttons, `replaySuccess.completion[${i}].buttons`) })) })() },
    }
}

let loaded: AppEvents | null | undefined
/** The vocabulary from APP_EVENTS_FILE, or null when none is set. */
export function appEvents(): AppEvents | null {
    if (loaded !== undefined) return loaded
    const started=performance.now()
    const file = config.appEventsFile
    if (!file) { console.error(`[lens warm] app events/schema lookup: ${Math.round(performance.now()-started)} ms`); return (loaded = null) }
    const path = isAbsolute(file) ? file : join(ROOT, file)
    loaded = parseAppEvents(JSON.parse(readFileSync(path, 'utf8')), file)
    console.error(`[lens warm] app events/schema lookup: ${Math.round(performance.now()-started)} ms`)
    return loaded
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
export async function newestSessions(sql: string, values: Record<string, unknown>, from: Date, to: Date, limit: number, by: 'first' | 'last'): Promise<Record<string, unknown>[] & Completeness> {
    const found = new Map<string, Record<string, unknown>>()
    let partial = false
    for (let end = to, days = 7; end > from && found.size < limit; days = Math.min(days * 2, 90)) {
        const start = new Date(Math.max(+from, +end - days * 86_400_000))
        const rows = await hogql(sql, { ...values, from: start.toISOString(), to: end.toISOString() }, +to - +from > 31 * 86_400_000 ? { timeoutMs: 300_000 } : {})
        partial ||= isTruncated(rows)
        for (const r of rows) {
            const old = found.get(String(r.sid)), t = String(r[by])
            // A session crossing a slice edge: keep its earliest first / latest last.
            if (!old || (by === 'first' ? t < String(old[by]) : t > String(old[by]))) found.set(String(r.sid), r)
        }
        end = start
    }
    // Ties broken by session id, so a page boundary (find_trade's cursor) is stable.
    return markPartial([...found.values()].sort((a, b) => String(b[by]).localeCompare(String(a[by])) || String(b.sid).localeCompare(String(a.sid))).slice(0, limit), partial)
}


export async function recordingSpans(ids: string[]): Promise<Map<string, { start: string; end: string }> & Completeness> {
    if (!ids.length) return new Map<string, {start: string; end: string}>()
    const rows = await hogql(`SELECT session_id, min(min_first_timestamp) AS start, max(max_last_timestamp) AS end
        FROM raw_session_replay_events WHERE session_id IN {ids} GROUP BY session_id LIMIT 100`, {ids})
    return markPartial(new Map(rows.map(r => [String(r.session_id), {start: new Date(String(r.start)).toISOString(), end: new Date(String(r.end)).toISOString()}])), isTruncated(rows))
}
export interface SessionQuery { clientId: string; screen?: string; what?: string; user?: string; email?: string; from: Date; to: Date; limit?: number; cursor?: string; recordedOnly?: boolean; detail?: boolean }
export async function findSessions(q: SessionQuery) {
    if (!Number.isFinite(+q.from) || !Number.isFinite(+q.to) || q.to <= q.from || +q.to - +q.from > 366 * 86400000) throw new ToolInputError('Choose a time window of at most one year.')
    const reg = required(), limit = Math.max(1, Math.min(q.limit ?? 10, 20))
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
    // MCP carries both JSON text and structuredContent: budget their combined serialized size.
    const pageSize = (sessions: unknown[]) => {
        const json=JSON.stringify({sessions})
        return Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify(json)) + 100
    }
    let truncatedBySize = false
    let partial = !!hits.truncated || !!spans.truncated
    const sessions: any[] = []
    for (const h of hits) {
        const sid = String(h.sid)
        const dialog=prop(reg,'dialog'), message=prop(reg,'button')
        const outcomeValues=Object.fromEntries(reg.outcomes.map((o,i)=>[`outcome_${i}`,`(?i)${o.match}`]))
        const defaultError=`if(${dialog} IN {message_dialogs}, ${Number(reg.messageOutcome==='error')}, ${Number(reg.noticeOutcome==='error')})`
        const configuredError=reg.outcomes.reduceRight((rest,o,i)=>`if(match(${message}, {outcome_${i}}), ${Number(o.outcome==='error')}, ${rest})`,defaultError)
        const errorMessage=`(${dialog} IN {message_dialogs} OR ${dialog} IN {notice_dialogs}) AND (${configuredError} OR match(${message}, '(?i)error|failed|could not|invalid|missing'))`
        const ev = await hogql(`SELECT timestamp AS ts, toString(distinct_id) AS distinct_id, ${userExpr()} AS user,
            min(timestamp) OVER () AS session_start, max(timestamp) OVER () AS session_end,
            count() OVER () AS events_in_session, countIf(${errorMessage}) OVER () AS error_messages_in_session,
            ${prop(reg,'dialog')} AS dialog, ${prop(reg,'dialogName')} AS name, ${prop(reg,'tab')} AS tab,
            ${prop(reg,'action')} AS action, ${prop(reg,'button')} AS message, ${prop(reg,'control')} AS control, toFloat(properties.$time) AS ctime, toString(properties.$pathname) AS path, event
            FROM events WHERE timestamp >= {from} AND timestamp < {to} AND properties.$session_id = {sid}
            AND toString(${P.client}) = {client} AND ${userFilter} ORDER BY timestamp LIMIT 5000`,
            {...values,...outcomeValues,message_dialogs:reg.dialogs.messages,notice_dialogs:reg.dialogs.notices,sid,from:q.from.toISOString(),to:q.to.toISOString()}, +q.to - +q.from > 31 * 86_400_000 ? { timeoutMs: 300_000 } : {})
        partial ||= isTruncated(ev) || ev.length >= 5000
        const onScreen = (e: Record<string, unknown>) => !q.screen || [e.dialog,e.name,e.tab,e.path].some(v=>String(v || '').toLowerCase().includes(q.screen!.toLowerCase()))
        const isMessage = (e: Record<string, unknown>) => [...reg.dialogs.messages,...reg.dialogs.notices].includes(String(e.dialog))
        const screenOf = (e: Record<string, unknown>) => String(e.name || e.tab || '')
        const contextLine = (e: Record<string, unknown>) => [
            new Date(String(e.ts)).toISOString().slice(11,23), isMessage(e) ? `MESSAGE is_error=${isError(e)}` : e.action || e.event,
            e.message ? `'${String(e.message).replace(/\s+/g,' ').slice(0,80)}'` : '',
            screenOf(e) ? `[${screenOf(e)}]` : '',
        ].filter(Boolean).join(' ')
        const isError = (e: Record<string, unknown>) => {
            const text = String(e.message || '')
            const rule = reg.outcomes.find(o=>new RegExp(o.match,'i').test(text))
            const outcome = rule?.outcome ?? (reg.dialogs.messages.includes(String(e.dialog)) ? reg.messageOutcome : reg.noticeOutcome)
            return outcome === 'error' || /error|failed|could not|invalid|missing/i.test(text)
        }
        // Lists are oldest to newest; when capping, target-screen matches are kept first.
        const matches = ev.map((e,index)=>({e,index})).filter(({e})=>q.what ? [e.action,e.message,e.control,e.event].some(v=>String(v || '').toLowerCase().includes(q.what!.toLowerCase())) : onScreen(e))
        const first = matches.find(({e})=>onScreen(e))?.e || matches[0]?.e || ev[0]
        const span = spans.get(sid)
        // Recordings run on the browser clock: offset from the event's client time when it has one.
        const matchMs = Number(first?.ctime)>1e9 ? Number(first!.ctime)*1000 : Date.parse(String(first?.ts))
        // Start 5 s before the match so the viewer sees what led up to it.
        const offset = span && Number.isFinite(matchMs) ? Math.max(0,(matchMs-Date.parse(span.start))/1000-5) : 0
        const dialogIds = new Set(ev.map(e=>String(e.dialog || '')))
        const humanName = (v: unknown) => {
            const name = String(v || '').trim()
            return name && !dialogIds.has(name) && !/^(?:Dlg\w*|toast|messagebox|UNKNOWN)$/i.test(name) ? name : ''
        }
        const screens = [...new Set(ev.filter(e=>!isMessage(e)).map(e=>humanName(e.name) || humanName(e.tab)).filter(Boolean))]
        const dense = !q.detail && ev.length >= 50
        const session = {session_id:sid, user:String(ev[0]?.user || ''), distinct_id:ev[0]?.distinct_id,
            session_start:ev[0]?.session_start ?? ev[0]?.ts ?? null, session_end:ev[0]?.session_end ?? ev.at(-1)?.ts ?? null,
            recording_start:span?.start ?? null, recording_end:span?.end ?? null,
            recording_duration_s:span ? (Date.parse(span.end)-Date.parse(span.start))/1000 : null,
            screens:screens.slice(0,dense ? 3 : 15), screens_total:screens.length,
            matched_actions:(q.screen && q.what ? [...matches].sort((a,b)=>Number(onScreen(b.e))-Number(onScreen(a.e)) || a.index-b.index).slice(0,dense ? 1 : 10).sort((a,b)=>a.index-b.index) : matches.slice(0,dense ? 1 : 10)).map(({e,index})=>{
                let next: Record<string, unknown> | undefined
                if (!isMessage(e)) for (const n of ev.slice(index+1)) {
                    const afterMs = Date.parse(String(n.ts))-Date.parse(String(e.ts))
                    if (!isMessage(n) || afterMs > 30000) break
                    if (afterMs >= 0 && screenOf(e) && screenOf(n) === screenOf(e)) { next=n; break }
                }
                const neighbour = (n: Record<string, unknown>) => ({line:contextLine(n),dt_s:Number(((Date.parse(String(n.ts))-Date.parse(String(e.ts)))/1000).toFixed(3))})
                return {at:e.ts,event:e.event ?? '',action:isMessage(e) ? 'MESSAGE' : e.action ?? '',...(isMessage(e) ? {is_error:isError(e)} : {}),message:e.message ?? '',screen:screenOf(e),dialog_id:e.dialog ?? '',
                    ...(q.screen ? {on_target_screen:onScreen(e)} : {}),
                    outcome:next ? {at:next.ts,text:next.message,is_error:isError(next),screen:screenOf(next),dialog_id:next.dialog ?? '',
                        after_s:Number(((Date.parse(String(next.ts))-Date.parse(String(e.ts)))/1000).toFixed(3)),basis:'same screen, before any other action'} : null,
                    before:dense ? [] : ev.slice(Math.max(0,index-2),index).map(neighbour),
                    after:dense ? [] : ev.slice(index+1,index+4).map(neighbour)}
            }),
            matched_actions_total:matches.length, matched_actions_truncated:matches.length>(dense ? 1 : 10),
            ...(q.screen && q.what ? {matches_on_target_screen:matches.filter(({e})=>onScreen(e)).length,matches_elsewhere:matches.filter(({e})=>!onScreen(e)).length} : {}),
            events_in_session:Number(ev[0]?.events_in_session ?? ev.length), error_messages_in_session:Number(ev[0]?.error_messages_in_session ?? ev.filter(e=>isMessage(e) && isError(e)).length),
            recording:span ? true : recordingCheckFailed ? 'unknown' : false, offset_s:offset,
            replay_url:replayUrl(sid,offset), clip_url:`${config.service.publicUrl}/replays?url=${encodeURIComponent(replayUrl(sid,offset))}`,
            ...markPartial({}, isTruncated(ev) || ev.length >= 5000)}
        const topScreens = screens.slice(0,5).map(s=>s.slice(0,11))
        if(screens.length>5) topScreens.push(`+${screens.length-5} more`)
        const firstAction = session.matched_actions[0]
        const compact = {
            session_id:sid, user:session.user, session_start:session.session_start,
            duration_s:Math.max(0,(Date.parse(String(session.session_end))-Date.parse(String(session.session_start)))/1000),
            events_in_session:session.events_in_session, screens:topScreens,
            matched_action:firstAction ? [firstAction.action,firstAction.message].filter(Boolean).join(': ').slice(0,48) : null,
            replay_url:session.replay_url, clip_url:session.clip_url,
            ...markPartial({}, isTruncated(ev) || ev.length >= 5000),
        }
        const entry = q.detail ? session : compact
        // A single unusually verbose detailed session must still make progress through the cursor.
        if(q.detail && !sessions.length) {
            while(pageSize([session]) > 18500 && session.matched_actions.length) session.matched_actions.pop()
            while(pageSize([session]) > 18500 && session.screens.length) session.screens.pop()
            session.matched_actions_truncated=session.matched_actions.length < session.matched_actions_total
        }
        // Leave room for the cursor and note. Never consume a session that the page did not return.
        if(pageSize([...sessions,entry]) > 19000) { truncatedBySize=true; break }
        sessions.push(entry)
    }
    const last = hits[sessions.length-1]
    return {sessions, ...markPartial({}, partial), ...(q.what && !sessions.length ? {hint:`No session in this window matched "${q.what}"${q.screen ? ` with screen "${q.screen}"` : ''}. what is a literal substring: try a shorter word or one distinctive word (for example the first word of the phrase), or drop the screen filter.`} : {}), ...((more || truncatedBySize) && last ? {next_cursor:`${last.last}|${last.sid}`} : {}),
        ...(truncatedBySize ? {truncated_by_size:true} : {}),
        note:recordingCheckFailed ? 'Recording availability could not be checked.' : sessions.length && !sessions.some(s=>spans.has(String(s.session_id))) ? 'Sessions found, but none have a recording.' : q.detail ? 'Newest sessions first. Details are limited to 5000 events per session; matched actions to 10; screens to 15. Follow next_cursor for more sessions.' : 'Newest first. Set detail: true for action context; use next_cursor for more.'}
}
