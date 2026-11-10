// The app's own events: Reval's dialogs, fields, buttons and the messages it shows. A JSON file
// (APP_EVENTS_FILE, see config/app-events.reval.json) says which properties hold what and how to
// read them; this module turns those events into:
//   - a session story, a readable timeline an AI agent (or a person) can follow like a replay,
//   - per-dialog friction: what people tried (Save, Run...), what came of it, which errors, who.
// The reading is pure and unit-tested; the queries only fetch rows.
//
// Messages keep their trade and link ids ("Trade Id 4348 Updated"): support looks failures up by
// trade. They are grouped by a version with ids taken out ("Trade Id # Updated"), so the same error
// on different trades counts as one problem. What people typed into the search box is never shown.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { config, ROOT } from './config.ts'
import { hogql, propertyDefinitions, replayUrl } from './posthog.ts'
import { recordingSpans } from './incidents.ts'
import { snapshotsFile } from './clip.ts'
import { attemptTimings, clockShift, networkFromFile, seconds, timingWords, type AttemptTiming } from './replaynet.ts'
import { P } from './props.ts'

export type Role = 'dialog' | 'dialogName' | 'tab' | 'action' | 'control' | 'button' | 'version'
export const ROLES: Role[] = ['dialog', 'dialogName', 'tab', 'action', 'control', 'button', 'version']
export type Outcome = 'completed' | 'accepted' | 'error' | 'empty' | 'none'

export interface AppEvents {
    app: string
    about: string
    events: { screen: string; interaction: string }
    properties: Partial<Record<Role, { name: string; meaning: string }>>
    dialogs: { messages: string[]; notices: string[]; menu: string[] }
    screenActions: { open: string[]; focus: string[]; close: string[] }
    submitButtons: string[]
    outcomeSeconds: number
    outcomes: { match: string; outcome: Outcome; note?: string }[]
    messageOutcome: Outcome
    noticeOutcome: Outcome
    generatedIds: string[]
    redact: string[]
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
        properties[role as Role] = { name: v.name, meaning: String(v.meaning || '') }
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
        redact: regexes(r.redact, 'redact'),
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

// ------------------------------------------------------------------ reading single values

/** The first item when a property holds a list (messages arrive as ["text"]). */
export function firstValue(v: unknown): string {
    if (v === null || v === undefined) return ''
    if (Array.isArray(v)) return firstValue(v[0])
    const s = String(v)
    if (s.startsWith('[')) {
        try {
            const a = JSON.parse(s)
            if (Array.isArray(a)) return firstValue(a[0])
        } catch {}
    }
    return s
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
const decode = (s: string) => s.replace(/&(#39|[a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)

/** A message as shown: entities decoded, one line, the redact patterns applied (search text). Ids stay. */
export function cleanMessage(text: string, reg: Pick<AppEvents, 'redact'>, max = 300): string {
    let s = firstValue(text)
        .replace(/&(#39|[a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
        .replace(/\\n|\s+/g, ' ')
        .trim()
    for (const r of reg.redact) s = s.replace(new RegExp(r, 'i'), (_m, keep = '') => `${keep}…`)
    return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * A message generalised, for grouping: dates, ids and long numbers replaced, the redact patterns
 * applied. "Trade Id 4348 Updated" → "Trade Id # Updated". Short numbers stay ("IFRS 9").
 */
export function generalise(text: string, reg: Pick<AppEvents, 'redact'>, max = 200): string {
    let s = firstValue(text)
        .replace(/&(#39|[a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
        .replace(/\\n|\s+/g, ' ')
        .trim()
    for (const r of reg.redact) s = s.replace(new RegExp(r, 'i'), (_m, keep = '') => `${keep}…`)
    s = s
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '…')
        .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/g, '<date>')
        .replace(/\b\d{1,2}[-/ ][A-Za-z]{3}[-/ ]\d{4}( \d{2}:\d{2}(:\d{2})?)?/g, '<date>')
        // A token mixing letters and digits (a code, a user id, a feed name) is an identifier.
        .replace(/[A-Za-z0-9_.-]*(?:[A-Za-z][A-Za-z0-9_.-]*\d|\d[A-Za-z0-9_.-]*[A-Za-z])[A-Za-z0-9_.-]*/g, (t) => (t.length >= 5 ? '…' : t))
        .replace(/\d{3,}/g, '#')
    return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function isGeneratedId(v: string, reg: Pick<AppEvents, 'generatedIds'>): boolean {
    return reg.generatedIds.some((r) => new RegExp(r, 'i').test(v))
}

/** What a message or notice means for the attempt before it. */
export function outcomeOf(text: string, isNotice: boolean, reg: Pick<AppEvents, 'outcomes' | 'messageOutcome' | 'noticeOutcome'>): Outcome {
    const t = firstValue(text)
    for (const o of reg.outcomes) if (new RegExp(o.match, 'i').test(t)) return o.outcome
    return isNotice ? reg.noticeOutcome : reg.messageOutcome
}

// ------------------------------------------------------------------ steps

/** One event as the queries return it. */
export interface RawEvent {
    sid: string
    ts: string // ISO
    event: string
    client?: string
    user?: string
    dialog: string
    dialogName?: string
    tab?: string
    action?: string
    control?: string
    button?: string
    version?: string
    ctime?: number // the browser's clock (properties.$time), ms: the replay's clock
}

export type StepKind = 'open' | 'focus' | 'close' | 'field' | 'search' | 'menu' | 'row' | 'button' | 'submit' | 'grid' | 'message' | 'notice' | 'other'

export interface Step {
    i: number
    ts: string
    kind: StepKind
    dialog: string // for messages: the dialog they are attributed to
    tab: string
    label: string
    text?: string // the message as shown (ids kept)
    template?: string // the message with ids taken out, for grouping
    outcome?: Outcome // on submits (what came of it) and on messages (what they mean)
    cause?: number // on messages: the step they answer
    name?: string // the dialog's title as seen on this event (or, for a message, on its cause)
    raw: RawEvent
}

const known = (v?: string) => (v && v.toUpperCase() !== 'UNKNOWN' ? v : '')

/** Turns one session's events (any order) into steps, with each message tied to what caused it. */
export function toSteps(events: RawEvent[], reg: AppEvents): Step[] {
    const isReply = (e: RawEvent) => reg.dialogs.messages.includes(e.dialog) || reg.dialogs.notices.includes(e.dialog)
    // At the same moment, a message comes after what caused it.
    const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts) || Number(isReply(a)) - Number(isReply(b)))
    const submit = new Set(reg.submitButtons.map((b) => b.toLowerCase()))
    const steps: Step[] = []
    let searchType = ''
    for (const e of sorted) {
        const action = e.action || ''
        const button = firstValue(e.button)
        const control = (e.control || '').toUpperCase()
        const isMsg = reg.dialogs.messages.includes(e.dialog)
        const isNotice = reg.dialogs.notices.includes(e.dialog)
        let kind: StepKind = 'other'
        let label = ''
        let text: string | undefined
        let template: string | undefined
        if (isMsg || isNotice) {
            kind = isMsg ? 'message' : 'notice'
            text = cleanMessage(button || action, reg)
            template = generalise(button || action, reg)
        } else if (e.event === reg.events.screen && reg.screenActions.open.includes(action)) kind = 'open'
        else if (e.event === reg.events.screen && reg.screenActions.focus.includes(action)) kind = 'focus'
        else if (e.event === reg.events.screen && reg.screenActions.close.includes(action)) kind = 'close'
        else if (button) {
            label = button
            kind = submit.has(button.toLowerCase()) ? 'submit' : /^[a-z]+[A-Z]\w*$/.test(button) || isGeneratedId(button, reg) ? 'grid' : 'button'
        } else if (control === 'SEARCH') {
            kind = 'search'
            // Searching the menu names a screen; any other search text (trades, counterparties) is
            // the user's own data and is not shown.
            label = /^menu$/i.test(searchType) && !/\d/.test(action) ? action.slice(0, 60) : '…'
        } else if (control === 'SEARCHTYPE' || control === 'MENU') {
            kind = 'menu'
            label = action
            if (control === 'SEARCHTYPE') searchType = action
        } else if (control === 'ROW' || action === 'DOUBLECLICK') {
            kind = 'row'
            label = 'a row'
        } else if (control || action) {
            kind = 'field'
            label = isGeneratedId(action, reg) || !action ? `an unlabelled ${control.toLowerCase() || 'field'}` : decode(action)
            if (control === 'RIGHTCLICK') label = `right-click on ${action}`
        }
        steps.push({ i: steps.length, ts: e.ts, kind, dialog: e.dialog, tab: known(e.tab), label, text, template, name: known(e.dialogName), raw: e })
    }
    // Tie each message to the attempt (submit) before it, or else the last thing the person did.
    const windowMs = reg.outcomeSeconds * 1000
    let lastSubmit: Step | undefined
    let lastAct: Step | undefined
    for (const s of steps) {
        if (s.kind === 'submit') {
            if (lastSubmit && lastSubmit.outcome === undefined) lastSubmit.outcome = 'none'
            lastSubmit = s
            lastAct = s
            continue
        }
        if (s.kind === 'message' || s.kind === 'notice') {
            s.outcome = outcomeOf(firstValue(s.raw.button) || s.raw.action || '', s.kind === 'notice', reg)
            const t = Date.parse(s.ts)
            if (lastSubmit && lastSubmit.outcome === undefined && t - Date.parse(lastSubmit.ts) <= windowMs) {
                lastSubmit.outcome = s.outcome
                s.cause = lastSubmit.i
                s.dialog = lastSubmit.dialog
                s.name = lastSubmit.name
            } else if (lastAct && t - Date.parse(lastAct.ts) <= 60_000) {
                s.cause = lastAct.i
                s.dialog = lastAct.dialog
                s.name = lastAct.name
            } else s.dialog = ''
            continue
        }
        if (s.kind !== 'other') lastAct = s
        // Too late, or the person has moved on (a search, the menu): the attempt got no message.
        if (lastSubmit && lastSubmit.outcome === undefined && (Date.parse(s.ts) - Date.parse(lastSubmit.ts) > windowMs || s.kind === 'search' || s.kind === 'menu'))
            lastSubmit.outcome = 'none'
    }
    if (lastSubmit && lastSubmit.outcome === undefined) lastSubmit.outcome = 'none'
    return steps
}

// ------------------------------------------------------------------ the session story

export interface DialogNames {
    get(dialog: string): string | undefined
}

/** The name people know a dialog by: an alias, the name seen most, or its code. */
export function dialogLabel(dialog: string, reg: AppEvents, names?: DialogNames, seen?: string): string {
    if (!dialog) return '(no dialog)'
    if (reg.dialogs.menu.includes(dialog)) return 'Menu bar'
    return reg.aliases[dialog] || names?.get(dialog) || known(seen) || dialog
}

const mmss = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000))
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const OUTCOME_WORDS: Record<Outcome, string> = {
    completed: 'done',
    accepted: 'queued',
    error: 'FAILED',
    empty: 'nothing found',
    none: 'no message within the time limit',
}

export interface Story {
    lines: string[]
    errors: { at_s: number; dialog: string; text: string }[]
    submits: number
    failed: number
    dialogs: number
    truncated: boolean
}

/**
 * A session as lines like "+3:12  Accrual Report Parameters › Run → FAILED". Repeats of the same
 * line are folded, idle gaps are shown, and a line per message says what it answered.
 */
export function renderStory(steps: Step[], reg: AppEvents, opts: { names?: DialogNames; startMs?: number; maxLines?: number; timings?: Map<number, AttemptTiming> } = {}): Story {
    const start = opts.startMs ?? (steps.length ? Date.parse(steps[0].ts) : 0)
    const max = opts.maxLines ?? 300
    const out: string[] = []
    const errors: Story['errors'] = []
    let prevLine = ''
    let repeat = 0
    let prevTs = start
    let prevDialog = ''
    const flush = () => {
        if (repeat > 1) out[out.length - 1] += `  ×${repeat}`
        repeat = 0
    }
    const label = (s: Step) => dialogLabel(s.dialog, reg, opts.names, s.name)
    for (const s of steps) {
        const t = Date.parse(s.ts)
        if (t - prevTs >= 120_000) {
            flush()
            out.push(`        … ${Math.round((t - prevTs) / 60_000)} min with nothing`)
            prevLine = ''
        }
        prevTs = t
        const where = `${label(s)}${s.tab && s.tab !== label(s) ? ` › ${s.tab}` : ''}`
        let line: string
        switch (s.kind) {
            case 'open':
                line = s.dialog === prevDialog ? `tab ${s.tab || '?'} (${label(s)})` : `opened ${where}`
                break
            case 'focus':
                line = `back to ${where}`
                break
            case 'close':
                line = `closed ${label(s)}`
                break
            case 'submit':
                line = `${where}: pressed [${s.label}] → ${OUTCOME_WORDS[s.outcome || 'none']}`
                if (opts.timings?.has(s.i)) line += ` (${timingWords(opts.timings.get(s.i)!)})`
                break
            case 'button':
                line = `${where}: [${s.label}]`
                break
            case 'grid':
                line = `${where}: grid ${s.label}`
                break
            case 'search':
                line = `searched "${s.label}"`
                break
            case 'menu':
                line = `${label(s)}: ${s.label}`
                break
            case 'row':
                line = `${where}: double-clicked a row`
                break
            case 'field':
                line = `${where}: ${s.label}`
                break
            case 'message':
            case 'notice': {
                const mark = s.outcome === 'error' ? '✘ ERROR' : s.outcome === 'empty' ? '· nothing found' : s.outcome === 'accepted' ? '✔ queued' : '✔'
                line = `    ${mark}: "${s.text}"${s.dialog ? ` (${label(s)})` : ''}`
                if (s.outcome === 'error') errors.push({ at_s: Math.round((t - start) / 1000), dialog: s.dialog, text: s.text || '' })
                break
            }
            default:
                line = `${s.raw.event}${s.dialog ? ` in ${label(s)}` : ''}`
        }
        if (s.kind !== 'message' && s.kind !== 'notice' && s.dialog) prevDialog = s.dialog
        if (line === prevLine) {
            repeat = repeat ? repeat + 1 : 2
            continue
        }
        flush()
        prevLine = line
        if (out.length < max) out.push(`+${mmss(t - start).padStart(5)}  ${line}`)
    }
    flush()
    const submits = steps.filter((s) => s.kind === 'submit')
    return {
        lines: out,
        errors,
        submits: submits.length,
        failed: submits.filter((s) => s.outcome === 'error').length,
        dialogs: new Set(steps.filter((s) => s.kind === 'open').map((s) => s.dialog)).size,
        truncated: out.length >= max,
    }
}

// ------------------------------------------------------------------ friction per dialog

export interface DialogFriction {
    dialog: string
    name: string
    opens: number
    sessions: number // sessions that did anything in it
    clients: number
    attempts: number // presses of a submit button
    outcomes: Record<Outcome, number>
    failure_rate: number // failed attempts / attempts
    sessions_with_errors: number
    clients_with_errors: string[]
    retry_loops: number // failed, then the same button again within 5 min
    stuck_sessions: number // an error here and nothing done here afterwards in the session
    errors: { text: string; count: number; sessions: number; clients: string[]; messages: string[]; example: { session_id: string; ts: string; message: string } }[]
}

/** Friction per dialog from many sessions' steps. `opens` comes from a separate count. */
export function frictionByDialog(sessions: Step[][], reg: AppEvents, opens: Map<string, { opens: number; name?: string }>, names?: DialogNames): DialogFriction[] {
    const by = new Map<string, DialogFriction & { _s: Set<string>; _c: Set<string>; _es: Set<string>; _ec: Set<string>; _err: Map<string, { count: number; s: Set<string>; c: Set<string>; m: Set<string>; ex: { session_id: string; ts: string; message: string } }> }>()
    const get = (d: string, seen?: string) => {
        let f = by.get(d)
        if (!f) {
            f = {
                dialog: d,
                name: dialogLabel(d, reg, names, opens.get(d)?.name || seen),
                opens: opens.get(d)?.opens || 0,
                sessions: 0,
                clients: 0,
                attempts: 0,
                outcomes: { completed: 0, accepted: 0, error: 0, empty: 0, none: 0 },
                failure_rate: 0,
                sessions_with_errors: 0,
                clients_with_errors: [],
                retry_loops: 0,
                stuck_sessions: 0,
                errors: [],
                _s: new Set(),
                _c: new Set(),
                _es: new Set(),
                _ec: new Set(),
                _err: new Map(),
            }
            by.set(d, f)
        }
        return f
    }
    for (const steps of sessions) {
        for (const s of steps) {
            if (s.kind === 'other' || (s.kind === 'notice' && !s.dialog) || reg.dialogs.notices.includes(s.dialog) || reg.dialogs.messages.includes(s.dialog)) continue
            const d = s.dialog || '(unattributed)'
            const f = get(d, s.name)
            const sid = s.raw.sid
            const client = s.raw.client || ''
            f._s.add(sid)
            if (client) f._c.add(client)
            if (s.kind === 'submit') {
                f.attempts++
                f.outcomes[s.outcome || 'none']++
                if (s.outcome === 'error') {
                    // The same button pressed again within 5 minutes, in this dialog: a retry.
                    const again = steps.find((n) => n.i > s.i && n.kind === 'submit' && n.dialog === s.dialog && n.label === s.label)
                    if (again && Date.parse(again.ts) - Date.parse(s.ts) <= 300_000) f.retry_loops++
                }
            }
            if (s.kind === 'message' && s.outcome === 'error') {
                f._es.add(sid)
                if (client) f._ec.add(client)
                const key = s.template || s.text || '(no text)'
                let e = f._err.get(key)
                if (!e) f._err.set(key, (e = { count: 0, s: new Set(), c: new Set(), m: new Set(), ex: { session_id: sid, ts: s.ts, message: s.text || '' } }))
                e.count++
                if (s.text && e.m.size < 10) e.m.add(s.text)
                e.s.add(sid)
                if (client) e.c.add(client)
            }
        }
        // Stuck: the last error in a dialog is not followed by a success in that dialog.
        const lastError = new Map<string, number>()
        const lastGood = new Map<string, number>()
        for (const s of steps) {
            if (s.kind === 'message' && s.outcome === 'error' && s.dialog) lastError.set(s.dialog, s.i)
            if ((s.kind === 'submit' || s.kind === 'notice' || s.kind === 'message') && (s.outcome === 'completed' || s.outcome === 'accepted')) lastGood.set(s.dialog, s.i)
        }
        for (const [d, i] of lastError) if ((lastGood.get(d) ?? -1) < i && by.has(d)) by.get(d)!.stuck_sessions++
    }
    return [...by.values()]
        .map(({ _s, _c, _es, _ec, _err, ...f }) => ({
            ...f,
            sessions: _s.size,
            clients: _c.size,
            sessions_with_errors: _es.size,
            clients_with_errors: [..._ec].sort(),
            failure_rate: f.attempts ? Math.round((100 * f.outcomes.error) / f.attempts) / 100 : 0,
            errors: [..._err.entries()]
                .map(([text, e]) => ({ text, count: e.count, sessions: e.s.size, clients: [...e.c].sort(), messages: [...e.m], example: e.ex }))
                .sort((a, b) => b.sessions - a.sessions || b.count - a.count)
                .slice(0, 8),
        }))
        .sort((a, b) => b.clients_with_errors.length - a.clients_with_errors.length || b.sessions_with_errors - a.sessions_with_errors || b.attempts - a.attempts)
}

// ------------------------------------------------------------------ queries

function required(): AppEvents {
    const reg = appEvents()
    if (!reg) throw new Error('No app event vocabulary is set up: set APP_EVENTS_FILE (e.g. config/app-events.reval.json) in .secrets.env.')
    return reg
}

const prop = (reg: AppEvents, role: Role) => (reg.properties[role] ? `toString(properties.${reg.properties[role]!.name})` : `''`)

function columns(reg: AppEvents): string {
    return `toString(properties.$session_id) AS sid, timestamp AS ts, event, toString(${P.client}) AS client, toString(distinct_id) AS user,
            ${prop(reg, 'dialog')} AS dialog, ${prop(reg, 'dialogName')} AS dialogName, ${prop(reg, 'tab')} AS tab,
            ${prop(reg, 'action')} AS action, ${prop(reg, 'control')} AS control, ${prop(reg, 'button')} AS button, ${prop(reg, 'version')} AS version,
            toFloat(properties.$time) AS ctime`
}

const toRaw = (r: Record<string, unknown>): RawEvent => ({
    sid: String(r.sid ?? ''),
    ts: new Date(String(r.ts)).toISOString(),
    event: String(r.event ?? ''),
    client: String(r.client ?? ''),
    user: String(r.user ?? ''),
    dialog: String(r.dialog ?? ''),
    dialogName: String(r.dialogName ?? ''),
    tab: String(r.tab ?? ''),
    action: String(r.action ?? ''),
    control: String(r.control ?? ''),
    button: String(r.button ?? ''),
    version: String(r.version ?? ''),
    ctime: Number(r.ctime) > 1e9 ? Math.round(Number(r.ctime) * 1000) : undefined,
})

/** The name seen most for each dialog in a window (UNKNOWN left out). */
export async function dialogNames(from: Date, to: Date, clientId = ''): Promise<Map<string, { opens: number; name?: string; sessions: number; clients: number }>> {
    const reg = required()
    const rows = await hogql(
        `SELECT ${prop(reg, 'dialog')} AS dialog, topK(3)(${prop(reg, 'dialogName')}) AS names,
                countIf(event = {screen} AND ${prop(reg, 'action')} IN {open}) AS opens,
                uniq(properties.$session_id) AS sessions, uniq(toString(${P.client})) AS clients
         FROM events
         WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events} AND notEmpty(${prop(reg, 'dialog')})
           AND ({client} = '' OR toString(${P.client}) = {client})
         GROUP BY dialog ORDER BY opens DESC LIMIT 5000`,
        { from: from.toISOString(), to: to.toISOString(), client: clientId, screen: reg.events.screen, open: reg.screenActions.open, events: [reg.events.screen, reg.events.interaction] }
    )
    return new Map(
        rows.map((r) => [
            String(r.dialog),
            {
                opens: Number(r.opens) || 0,
                name: ((r.names as string[]) || []).map(String).find((n) => known(n)),
                sessions: Number(r.sessions) || 0,
                clients: Number(r.clients) || 0,
            },
        ])
    )
}

const nameLookup = (m: Map<string, { name?: string }>): DialogNames => ({ get: (d) => m.get(d)?.name })

export interface SessionStoryResult {
    session_id: string
    client: string
    user: string
    start: string
    end: string
    version?: string
    summary: string
    story: string[]
    errors: { at: string; dialog: string; text: string; replay_url?: string }[]
    replay_url?: string
    network: string
    truncated: boolean
}

/** One session as a story, with a replay link at each error. */
export async function sessionStory(sessionId: string, opts: { maxLines?: number } = {}): Promise<SessionStoryResult> {
    const reg = required()
    const rows = await hogql(
        `SELECT ${columns(reg)} FROM events
         WHERE properties.$session_id = {sid} AND event IN {events} AND timestamp > now() - INTERVAL 400 DAY
         ORDER BY ts LIMIT 5000`,
        { sid: sessionId, events: [reg.events.screen, reg.events.interaction] }
    )
    if (!rows.length) throw new Error(`No ${reg.app} events for session ${sessionId}. Check the id (a PostHog session id or replay link).`)
    const events = rows.map(toRaw)
    const steps = toSteps(events, reg)
    const first = Date.parse(steps[0].ts)
    const last = Date.parse(steps[steps.length - 1].ts)
    const names = await dialogNames(new Date(first - 30 * 86_400_000), new Date(last + 60_000)).catch(() => new Map())
    const span = (await recordingSpans([sessionId]).catch(() => new Map())).get(sessionId)
    const startMs = span ? Math.min(Date.parse(span.start), first) : first
    const timings = span ? await sessionTimings(sessionId, steps).catch(() => undefined) : undefined
    const story = renderStory(steps, reg, { names: nameLookup(names), startMs, maxLines: opts.maxLines, timings })
    const version = events.map((e) => e.version).find((v) => v)
    return {
        session_id: sessionId,
        client: events.find((e) => e.client)?.client || '',
        user: events.find((e) => e.user)?.user || '',
        start: new Date(first).toISOString(),
        end: new Date(last).toISOString(),
        version,
        summary: `${Math.round((last - first) / 60_000)} min, ${story.dialogs} dialogs opened, ${story.submits} attempts (Save, Run...), ${story.failed} failed, ${story.errors.length} error messages.`,
        story: story.lines,
        errors: story.errors.map((e) => ({
            at: `+${mmss(e.at_s * 1000)}`,
            dialog: dialogLabel(e.dialog, reg, nameLookup(names)),
            text: e.text,
            replay_url: span ? replayUrl(sessionId, Math.max(0, e.at_s - 10)) : undefined,
        })),
        replay_url: span ? replayUrl(sessionId, 0) : undefined,
        network: !span ? 'no recording' : timings ? `server calls read from the recording for ${timings.size} of ${story.submits} attempts` : 'the recording has no network data',
        truncated: story.truncated,
    }
}

/** The server calls behind each attempt in a session, from its recording. */
async function sessionTimings(sessionId: string, steps: Step[]): Promise<Map<number, AttemptTiming> | undefined> {
    const requests = networkFromFile(await snapshotsFile(sessionId))
    if (!requests.length) return undefined
    const shift = clockShift(steps.map((s) => ({ ts: s.ts, ctime: s.raw.ctime })))
    return new Map(attemptTimings(steps, requests, shift).map((t) => [t.step, t]))
}

export interface SlowAttempt {
    dialog: string
    name: string
    button: string
    attempts: number
    median_wait_s: number
    p90_wait_s: number
    max_wait_s: number
    http_errors: number
    slowest_call?: string
    clients: string[]
    example?: { session_id: string; at: string; wait_s: number; replay_url: string }
}

/**
 * How long attempts (Save, Run...) wait on the server and which calls fail, from the recordings of
 * recent sessions. Recordings are downloaded (and cached), so this reads at most `sessions` of them.
 */
export async function slowAttempts(q: { from: Date; to: Date; clientId?: string; dialog?: string; sessions?: number }): Promise<{ sessions_read: number; sessions_without_network: number; attempts: SlowAttempt[]; note: string }> {
    const reg = required()
    const want = Math.min(Math.max(q.sessions ?? 12, 1), 40)
    const names = await dialogNames(q.from, q.to, q.clientId)
    const wanted = q.dialog?.toLowerCase()
    const dialogs = wanted ? [...names.keys()].filter((d) => d.toLowerCase() === wanted || (names.get(d)?.name || '').toLowerCase().includes(wanted)) : []
    if (wanted && !dialogs.length) throw new Error(`No dialog matches "${q.dialog}" in this period.`)
    // The newest recorded sessions with attempts (in the dialog, if one is given).
    const rows = await hogql(
        `SELECT toString(properties.$session_id) AS sid, max(timestamp) AS last FROM events
         WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events} AND ${prop(reg, 'button')} IN {submit}
           AND ({client} = '' OR toString(${P.client}) = {client}) AND ({all} = 1 OR ${prop(reg, 'dialog')} IN {dialogs})
           AND notEmpty(toString(properties.$session_id))
         GROUP BY sid ORDER BY last DESC LIMIT 200`,
        { from: q.from.toISOString(), to: q.to.toISOString(), events: [reg.events.screen, reg.events.interaction], submit: reg.submitButtons, client: q.clientId || '', all: dialogs.length ? 0 : 1, dialogs: dialogs.length ? dialogs : [''] }
    )
    const spans = await recordingSpans(rows.map((r) => String(r.sid)))
    const sids = rows.map((r) => String(r.sid)).filter((s) => spans.has(s)).slice(0, want)
    const by = new Map<string, { waits: number[]; errors: number; slow?: { call: string; ms: number }; clients: Set<string>; ex?: SlowAttempt['example'] & { ms: number } }>()
    let without = 0
    for (const sid of sids) {
        const ev = (
            await hogql(`SELECT ${columns(reg)} FROM events WHERE properties.$session_id = {sid} AND event IN {events} AND timestamp >= {from} - INTERVAL 1 DAY ORDER BY ts LIMIT 5000`, {
                sid,
                events: [reg.events.screen, reg.events.interaction],
                from: q.from.toISOString(),
            })
        ).map(toRaw)
        const steps = toSteps(ev, reg)
        const timings = await sessionTimings(sid, steps).catch(() => undefined)
        if (!timings) {
            without++
            continue
        }
        const span = spans.get(sid)!
        for (const [i, t] of timings) {
            const s = steps[i]
            if (dialogs.length && !dialogs.includes(s.dialog)) continue
            const key = `${s.dialog}\u0000${s.label}`
            let b = by.get(key)
            if (!b) by.set(key, (b = { waits: [], errors: 0, clients: new Set() }))
            b.waits.push(t.wait_ms)
            b.errors += t.http_errors.length ? 1 : 0
            if (s.raw.client) b.clients.add(s.raw.client)
            if (t.slowest && (!b.slow || t.slowest.ms > b.slow.ms)) b.slow = { call: t.slowest.call, ms: t.slowest.ms }
            if (!b.ex || t.wait_ms > b.ex.ms) {
                const at = Math.max(0, (Date.parse(s.ts) - Date.parse(span.start)) / 1000)
                b.ex = { session_id: sid, at: s.ts, wait_s: Math.round(t.wait_ms / 100) / 10, replay_url: replayUrl(sid, Math.max(0, at - 5)), ms: t.wait_ms }
            }
        }
    }
    const q90 = (a: number[], p: number) => {
        const x = [...a].sort((m, n) => m - n)
        return x[Math.min(x.length - 1, Math.floor(p * x.length))] / 1000
    }
    const attempts = [...by.entries()]
        .map(([key, b]) => {
            const [dialog, button] = key.split('\u0000')
            const { ms: _ms, ...example } = b.ex!
            return {
                dialog,
                name: dialogLabel(dialog, reg, nameLookup(names)),
                button,
                attempts: b.waits.length,
                median_wait_s: Math.round(q90(b.waits, 0.5) * 10) / 10,
                p90_wait_s: Math.round(q90(b.waits, 0.9) * 10) / 10,
                max_wait_s: Math.round(Math.max(...b.waits) / 100) / 10,
                http_errors: b.errors,
                slowest_call: b.slow ? `${b.slow.call} (${seconds(b.slow.ms)})` : undefined,
                clients: [...b.clients].sort(),
                example,
            }
        })
        .sort((a, b) => b.http_errors - a.http_errors || b.p90_wait_s - a.p90_wait_s)
    return {
        sessions_read: sids.length,
        sessions_without_network: without,
        attempts,
        note:
            'From the recordings (network timing): the wait is from the press until the last server call it started had answered; calls are shown by method and path only. ' +
            `Read from the ${sids.length} newest recorded sessions with attempts${sids.length >= want ? ` (raise "sessions" for more, up to 40)` : ''}. A wait close in time is not always caused by the press.`,
    }
}

export interface FrictionResult {
    window: { from: string; to: string }
    client?: string
    dialogs: DialogFriction[]
    rows_read: number
    truncated: boolean
    note: string
}

const ROW_LIMIT = 50_000

/** Where people fail: per dialog, attempts and outcomes, errors, retries, who was hit. */
export async function dialogFriction(q: { from: Date; to: Date; clientId?: string; dialog?: string; limit?: number }): Promise<FrictionResult> {
    const reg = required()
    const values = {
        from: q.from.toISOString(),
        to: q.to.toISOString(),
        client: q.clientId || '',
        events: [reg.events.screen, reg.events.interaction],
        special: [...reg.dialogs.messages, ...reg.dialogs.notices],
        screen: reg.events.screen,
    }
    // What friction needs: dialogs opened, buttons, searches, the menu and messages. Fields are left
    // out (most of the events), so a message right after a field is tied to the dialog then open.
    const [rows, opens] = await Promise.all([
        hogql(
            `SELECT ${columns(reg)} FROM events
             WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}
               AND (event = {screen} OR ${prop(reg, 'dialog')} IN {special} OR notEmpty(${prop(reg, 'button')}) OR upper(${prop(reg, 'control')}) IN ('SEARCH', 'SEARCHTYPE', 'MENU'))
               AND ({client} = '' OR toString(${P.client}) = {client})
             ORDER BY sid, ts LIMIT ${ROW_LIMIT}`,
            values
        ),
        dialogNames(q.from, q.to, q.clientId),
    ])
    const bySession = new Map<string, RawEvent[]>()
    for (const r of rows) {
        const e = toRaw(r)
        if (!bySession.has(e.sid)) bySession.set(e.sid, [])
        bySession.get(e.sid)!.push(e)
    }
    const all = frictionByDialog([...bySession.values()].map((ev) => toSteps(ev, reg)), reg, opens, nameLookup(opens))
    const wanted = q.dialog?.toLowerCase()
    const dialogs = (wanted ? all.filter((d) => d.dialog.toLowerCase() === wanted || d.name.toLowerCase().includes(wanted)) : all).slice(0, q.limit ?? 15)
    return {
        window: { from: values.from, to: values.to },
        client: q.clientId,
        dialogs,
        rows_read: rows.length,
        truncated: rows.length >= ROW_LIMIT,
        note:
            'attempts = presses of Save, Run, Export and the like; outcomes come from the message or notice that followed within ' +
            `${reg.outcomeSeconds} s ("none" = no message, which is not always a problem). stuck_sessions = an error here and no success here later in the session. ` +
            'Use session_story on an example session to see what happened.',
    }
}

export interface Vocabulary {
    app: string
    about: string
    client: string
    events: { name: string; count: number; role?: string }[]
    properties: { role: Role; name: string; meaning: string; filled: string; examples: string[] }[]
    dialogs: { dialog: string; name: string; opens: number; sessions: number; clients: number }[]
    messages: { text: string; count: number; outcome: Outcome; example: string }[]
    clients: { client: string; events: number }[]
    undescribed_properties?: string[]
    how_to_query: string[]
    window: string
}

/** What the app's events are and hold, from the vocabulary and the last days of data. */
export async function describeAppEvents(days = 7, clientSource = ''): Promise<Vocabulary> {
    const reg = required()
    const to = new Date()
    const from = new Date(to.getTime() - days * 86_400_000)
    const w = { from: from.toISOString(), to: to.toISOString(), events: [reg.events.screen, reg.events.interaction] }
    const roles = ROLES.filter((r) => reg.properties[r])
    const [events, props, names, msgs, clients, defined] = await Promise.all([
        hogql(`SELECT event, count() AS n FROM events WHERE timestamp >= {from} AND timestamp < {to} GROUP BY event ORDER BY n DESC LIMIT 30`, w),
        hogql(
            // Search text is what people typed (trades, counterparties): never an example.
            `SELECT count() AS n, ${roles
                .map((r, i) => `countIf(notEmpty(${prop(reg, r)})) AS f${i}, topK(12)(${r === 'action' ? `if(upper(${prop(reg, 'control')}) = 'SEARCH', '', ${prop(reg, r)})` : prop(reg, r)}) AS t${i}`)
                .join(', ')}
             FROM events WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}`,
            w
        ),
        dialogNames(from, to),
        hogql(
            `SELECT ${prop(reg, 'dialog')} AS dialog, ${prop(reg, 'button')} AS button, ${prop(reg, 'action')} AS action FROM events
             WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events} AND ${prop(reg, 'dialog')} IN {special}
             ORDER BY timestamp DESC LIMIT 5000`,
            { ...w, special: [...reg.dialogs.messages, ...reg.dialogs.notices] }
        ),
        hogql(
            `SELECT toString(${P.client}) AS client, count() AS n FROM events WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}
             GROUP BY client ORDER BY n DESC LIMIT 25`,
            w
        ),
        eventPropertyNames(),
    ])
    const p = props[0] || {}
    const total = Number(p.n) || 0
    const m = new Map<string, { count: number; outcome: Outcome; example: string }>()
    for (const r of msgs) {
        const raw = firstValue(r.button) || String(r.action || '')
        const text = generalise(raw, reg, 120)
        const e = m.get(text) || { count: 0, outcome: outcomeOf(raw, reg.dialogs.notices.includes(String(r.dialog)), reg), example: cleanMessage(raw, reg, 160) }
        e.count++
        m.set(text, e)
    }
    const describedNames = new Set(roles.map((r) => reg.properties[r]!.name))
    return {
        app: reg.app,
        about: reg.about,
        client: clientSource,
        events: events.map((r) => ({
            name: String(r.event),
            count: Number(r.n),
            role: r.event === reg.events.screen ? `${reg.app} dialog opened / focused / closed` : r.event === reg.events.interaction ? `${reg.app} click, field, button or message` : undefined,
        })),
        properties: roles.map((r, i) => ({
            role: r,
            name: reg.properties[r]!.name,
            meaning: reg.properties[r]!.meaning,
            filled: total ? `${Math.round((100 * Number(p[`f${i}`])) / total)}% of ${total} ${reg.app} events` : 'no events in the window',
            examples: ((p[`t${i}`] as unknown[]) || []).map((v) => (r === 'button' || r === 'action' ? generalise(String(v), reg, 60) : firstValue(v))).filter(Boolean),
        })),
        dialogs: [...names.entries()]
            .filter(([d]) => d && !reg.dialogs.messages.includes(d) && !reg.dialogs.notices.includes(d))
            .slice(0, 40)
            .map(([d, v]) => ({ dialog: d, name: dialogLabel(d, reg, nameLookup(names)), opens: v.opens, sessions: v.sessions, clients: v.clients })),
        messages: [...m.entries()].map(([text, v]) => ({ text, ...v })).sort((a, b) => b.count - a.count).slice(0, 25),
        clients: clients.map((r) => ({ client: String(r.client), events: Number(r.n) })),
        undescribed_properties: defined?.filter((n) => !describedNames.has(n) && !n.startsWith('$')).slice(0, 40),
        how_to_query: [
            `Client: toString(${P.client}). Dialog: ${prop(reg, 'dialog')}. Button: ${prop(reg, 'button')} (a JSON list on messages: take the first item).`,
            `Errors: ${prop(reg, 'dialog')} IN (${reg.dialogs.messages.map((d) => `'${d}'`).join(', ')}); notices: IN (${reg.dialogs.notices.map((d) => `'${d}'`).join(', ')}). Messages carry no dialog of their own: the attempt just before them in the session is what failed.`,
            `Always bound queries by timestamp; event IN ('${reg.events.screen}', '${reg.events.interaction}').`,
        ],
        window: `last ${days} days`,
    }
}

async function eventPropertyNames(): Promise<string[] | undefined> {
    return propertyDefinitions().catch(() => undefined)
}

// ------------------------------------------------------------------ clients: this period against the last

export interface ClientPeriod {
    sessions: number
    users: string[]
    days: number
    dialogs: number
    attempts: number
    errors: number // error messages (messages that are not "nothing found")
}

export interface ClientSignals {
    client: string
    now: ClientPeriod & { failure_rate: number }
    before: ClientPeriod & { failure_rate: number }
    last_seen: string
    quiet_users: string[] // active before, not now
    signals: string[] // why this client is listed, worst first
    weight: number
}

const userOf = (distinctId: string) => distinctId.split(/[|]/).pop() || distinctId
const rate = (p: ClientPeriod) => (p.attempts ? Math.round((100 * p.errors) / p.attempts) / 100 : 0)

/**
 * Plain, explainable signals per client: less use, people gone quiet, more failures, fewer dialogs,
 * not seen lately. Evidence for a person to judge, not a churn prediction.
 */
export function clientSignals(rows: { client: string; now: ClientPeriod; before: ClientPeriod; last_seen: string }[], at = Date.now()): ClientSignals[] {
    const out: ClientSignals[] = []
    for (const r of rows) {
        const now = { ...r.now, failure_rate: rate(r.now) }
        const before = { ...r.before, failure_rate: rate(r.before) }
        const signals: [number, string][] = []
        const drop = (a: number, b: number) => (b ? (b - a) / b : 0)
        const pct = (x: number) => `${Math.round(100 * x)}%`
        if (before.sessions >= 5 && drop(now.sessions, before.sessions) >= 0.3)
            signals.push([3 * drop(now.sessions, before.sessions), `sessions down ${pct(drop(now.sessions, before.sessions))} (${before.sessions} → ${now.sessions})`])
        const quiet = before.users.filter((u) => !now.users.includes(u))
        if (quiet.length && before.users.length >= 2)
            signals.push([(2 * quiet.length) / before.users.length, `${quiet.length} of ${before.users.length} users not seen this period: ${quiet.map(userOf).slice(0, 6).join(', ')}`])
        if (before.days >= 3 && drop(now.days, before.days) >= 0.3) signals.push([drop(now.days, before.days), `active on ${now.days} days (was ${before.days})`])
        if (now.attempts >= 5 && now.failure_rate >= 0.2 && now.failure_rate >= 1.5 * before.failure_rate)
            signals.push([2 * now.failure_rate, `${pct(now.failure_rate)} of attempts failed (was ${pct(before.failure_rate)}; ${now.errors} errors in ${now.attempts} attempts)`])
        else if (now.attempts >= 5 && now.failure_rate >= 0.3) signals.push([now.failure_rate, `${pct(now.failure_rate)} of attempts fail (${now.errors} errors in ${now.attempts} attempts)`])
        if (before.dialogs >= 5 && drop(now.dialogs, before.dialogs) >= 0.3) signals.push([drop(now.dialogs, before.dialogs), `uses ${now.dialogs} dialogs (was ${before.dialogs})`])
        const idle = Math.floor((at - Date.parse(r.last_seen)) / 86_400_000)
        if (idle >= 7) signals.push([Math.min(3, idle / 7), `not seen for ${idle} days`])
        signals.sort((a, b) => b[0] - a[0])
        out.push({
            client: r.client,
            now,
            before,
            last_seen: r.last_seen,
            quiet_users: quiet.map(userOf),
            signals: signals.map((s) => s[1]),
            weight: Math.round(100 * signals.reduce((t, s) => t + s[0], 0)) / 100,
        })
    }
    return out.sort((a, b) => b.weight - a.weight || b.before.sessions - a.before.sessions)
}

export interface ClientSignalsResult {
    now: { from: string; to: string }
    before: { from: string; to: string }
    clients: ClientSignals[]
    quiet_clients: number
    note: string
}

/** Every client, this window against the one before it of the same length. */
export async function clientSignalsReport(q: { from: Date; to: Date; clientId?: string; limit?: number }): Promise<ClientSignalsResult> {
    const reg = required()
    const len = q.to.getTime() - q.from.getTime()
    const from0 = new Date(q.from.getTime() - len)
    const submit = reg.submitButtons
    const empty = reg.outcomes.filter((o) => o.outcome === 'empty').map((o) => `(${o.match})`)
    const dialog = prop(reg, 'dialog')
    const button = prop(reg, 'button')
    const isError = `${dialog} IN {messages}${empty.length ? ` AND NOT match(${button}, {empty})` : ''}`
    const period = (name: string, cond: string) => `
        uniqIf(properties.$session_id, ${cond}) AS ${name}_sessions, groupUniqArrayIf(500)(toString(distinct_id), ${cond}) AS ${name}_users,
        uniqIf(toDate(timestamp), ${cond}) AS ${name}_days, uniqIf(${dialog}, ${cond} AND event = {screen}) AS ${name}_dialogs,
        countIf(${cond} AND ${button} IN {submit}) AS ${name}_attempts, countIf(${cond} AND ${isError}) AS ${name}_errors`
    const rows = await hogql(
        `SELECT toString(${P.client}) AS client, max(timestamp) AS last_seen,
                ${period('n', 'timestamp >= {from}')}, ${period('b', 'timestamp < {from}')}
         FROM events
         WHERE timestamp >= {from0} AND timestamp < {to} AND event IN {events} AND notEmpty(toString(${P.client}))
           AND ({client} = '' OR toString(${P.client}) = {client})
         GROUP BY client ORDER BY client LIMIT 5000`,
        {
            from0: from0.toISOString(),
            from: q.from.toISOString(),
            to: q.to.toISOString(),
            events: [reg.events.screen, reg.events.interaction],
            screen: reg.events.screen,
            submit,
            messages: reg.dialogs.messages,
            empty: `(?i)${empty.join('|') || 'x^'}`,
            client: q.clientId || '',
        }
    )
    const p = (r: Record<string, unknown>, k: string): ClientPeriod => ({
        sessions: Number(r[`${k}_sessions`]) || 0,
        users: ((r[`${k}_users`] as unknown[]) || []).map(String),
        days: Number(r[`${k}_days`]) || 0,
        dialogs: Number(r[`${k}_dialogs`]) || 0,
        attempts: Number(r[`${k}_attempts`]) || 0,
        errors: Number(r[`${k}_errors`]) || 0,
    })
    const all = clientSignals(rows.map((r) => ({ client: String(r.client), now: p(r, 'n'), before: p(r, 'b'), last_seen: new Date(String(r.last_seen)).toISOString() })), q.to.getTime())
    return {
        now: { from: q.from.toISOString(), to: q.to.toISOString() },
        before: { from: from0.toISOString(), to: q.from.toISOString() },
        clients: q.clientId ? all : all.slice(0, q.limit ?? 20),
        quiet_clients: all.filter((c) => !c.now.sessions).length,
        note:
            'Signals compare this window with the one before it of the same length. They show less use, people gone quiet and more failures: ' +
            'evidence to look at, not a prediction that a client will leave. Small numbers (a few sessions) swing a lot. Use dialog_friction with the client for where they fail.',
    }
}

// ------------------------------------------------------------------ the week's top pains

export interface Pain {
    rank: number
    dialog: string
    name: string
    headline: string // one line a PM can read
    main_error?: string
    clients_hit: string[]
    failed_attempts: number
    attempts: number
    stuck_sessions: number
    retry_loops: number
    trend: 'new' | 'worse' | 'same' | 'better'
    before: { clients_hit: number; failed_attempts: number; attempts: number }
    example?: { session_id: string; at: string }
    score: number
}

/**
 * The few dialogs that hurt most this period, as cards: breadth (clients hit) first, then people
 * stuck, retries and failures, with how it compares with the period before. Pure, so tested.
 */
export function rankPains(now: DialogFriction[], before: DialogFriction[], max = 5): Pain[] {
    const prev = new Map(before.map((d) => [d.dialog, d]))
    const pains: Pain[] = []
    for (const d of now) {
        if (!d.sessions_with_errors && !d.outcomes.error) continue
        const b = prev.get(d.dialog)
        const score = 3 * d.clients_with_errors.length + 2 * d.stuck_sessions + d.retry_loops + d.outcomes.error + (d.attempts >= 5 ? 5 * d.failure_rate : 0)
        const bScore = b ? 3 * b.clients_with_errors.length + 2 * b.stuck_sessions + b.retry_loops + b.outcomes.error : 0
        const trend: Pain['trend'] = !b || !(b.sessions_with_errors || b.outcomes.error) ? 'new' : score > 1.25 * bScore ? 'worse' : score < 0.75 * bScore ? 'better' : 'same'
        const e = d.errors[0]
        const parts = [`${d.clients_with_errors.length} client${d.clients_with_errors.length === 1 ? '' : 's'} hit errors`]
        if (d.attempts) parts.push(`${d.outcomes.error} of ${d.attempts} attempts failed`)
        if (d.stuck_sessions) parts.push(`${d.stuck_sessions} session${d.stuck_sessions === 1 ? '' : 's'} ended without success`)
        if (d.retry_loops) parts.push(`${d.retry_loops} retr${d.retry_loops === 1 ? 'y' : 'ies'} after a failure`)
        pains.push({
            rank: 0,
            dialog: d.dialog,
            name: d.name,
            headline: `${d.name}: ${parts.join(', ')}${e ? `. Main error: "${e.text}"` : ''}.`,
            main_error: e?.text,
            clients_hit: d.clients_with_errors,
            failed_attempts: d.outcomes.error,
            attempts: d.attempts,
            stuck_sessions: d.stuck_sessions,
            retry_loops: d.retry_loops,
            trend,
            before: { clients_hit: b?.clients_with_errors.length || 0, failed_attempts: b?.outcomes.error || 0, attempts: b?.attempts || 0 },
            example: e ? { session_id: e.example.session_id, at: e.example.ts } : undefined,
            score: Math.round(score * 10) / 10,
        })
    }
    return pains
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((p, i) => ({ ...p, rank: i + 1 }))
}

export interface PainsReport {
    window: { from: string; to: string }
    pains: (Pain & { replay_url?: string })[]
    clients_needing_attention: { client: string; signals: string[] }[]
    note: string
}

/** The top pains of a period against the one before, plus the clients with warning signs. */
export async function topPains(q: { from: Date; to: Date; max?: number }): Promise<PainsReport> {
    const len = q.to.getTime() - q.from.getTime()
    const prevFrom = new Date(q.from.getTime() - len)
    const [now, before, clients] = await Promise.all([
        dialogFriction({ from: q.from, to: q.to, limit: 200 }),
        dialogFriction({ from: prevFrom, to: q.from, limit: 200 }),
        clientSignalsReport({ from: q.from, to: q.to, limit: 50 }),
    ])
    const pains = rankPains(now.dialogs, before.dialogs, q.max ?? 5)
    const spans = await recordingSpans(pains.flatMap((p) => (p.example ? [p.example.session_id] : []))).catch(() => new Map())
    return {
        window: now.window,
        pains: pains.map((p) => {
            const span = p.example && spans.get(p.example.session_id)
            return span ? { ...p, replay_url: replayUrl(p.example!.session_id, Math.max(0, (Date.parse(p.example!.at) - Date.parse(span.start)) / 1000 - 20)) } : p
        }),
        clients_needing_attention: clients.clients.filter((c) => c.signals.length).slice(0, 5).map((c) => ({ client: c.client, signals: c.signals })),
        note:
            'Ranked by how many clients hit errors, sessions that ended without success, retries and failed attempts; trend compares with the period before. ' +
            'Each pain has an example session: session_story tells it, get_replay_link makes a clip for the user. Small numbers: say so.',
    }
}

// ------------------------------------------------------------------ one trade

export interface TradeHit {
    session_id: string
    client: string
    user: string
    first_seen: string
    how: string[] // "searched for it", "message: Trade Id 4348 Updated"
    errors_after: { at: string; dialog: string; text: string }[] // from reaching the trade until the next search for something else
    attempts_after: { at: string; dialog: string; button: string; outcome: Outcome }[]
    replay_url?: string
}

/**
 * Everything about one trade (or link) id: the sessions where someone searched for it or Reval
 * named it in a message, and what went wrong in those sessions from then on. For client services:
 * "trade 4348 failed for us".
 */
export async function findTrade(q: { id: string; from: Date; to: Date; clientId?: string; limit?: number }): Promise<{ id: string; sessions: TradeHit[]; note: string }> {
    const reg = required()
    const id = q.id.trim()
    if (!/^\d{1,15}$/.test(id)) throw new Error('A trade or link id is a number, e.g. 4348.')
    const values = {
        from: q.from.toISOString(),
        to: q.to.toISOString(),
        events: [reg.events.screen, reg.events.interaction],
        special: [...reg.dialogs.messages, ...reg.dialogs.notices],
        id,
        re: `(^|[^0-9])${id}([^0-9]|$)`,
        client: q.clientId || '',
    }
    const hits = await hogql(
        `SELECT toString(properties.$session_id) AS sid, min(timestamp) AS first FROM events
         WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events} AND notEmpty(toString(properties.$session_id))
           AND ((${prop(reg, 'dialog')} IN {special} AND match(${prop(reg, 'button')}, {re}))
                OR (upper(${prop(reg, 'control')}) = 'SEARCH' AND trim(${prop(reg, 'action')}) = {id}))
           AND ({client} = '' OR toString(${P.client}) = {client})
         GROUP BY sid ORDER BY first DESC LIMIT ${Math.min(q.limit ?? 10, 30)}`,
        values
    )
    const spans = await recordingSpans(hits.map((h) => String(h.sid))).catch(() => new Map())
    const names = await dialogNames(new Date(q.from.getTime()), q.to).catch(() => new Map())
    const out: TradeHit[] = []
    for (const h of hits) {
        const sid = String(h.sid)
        const ev = (
            await hogql(`SELECT ${columns(reg)} FROM events WHERE properties.$session_id = {sid} AND event IN {events} AND timestamp >= {from} - INTERVAL 1 DAY ORDER BY ts LIMIT 5000`, {
                sid,
                events: values.events,
                from: values.from,
            })
        ).map(toRaw)
        const steps = toSteps(ev, reg)
        const mentions = steps.filter((s) => ((s.kind === 'message' || s.kind === 'notice') && new RegExp(values.re).test(firstValue(s.raw.button))) || (s.kind === 'search' && (s.raw.action || '').trim() === id))
        if (!mentions.length) continue
        // From when the person got to the trade: their last search, or where they opened the dialog, at
        // most 15 minutes before it was first named (a failed Save comes before "Trade Id 4348 Updated").
        const first = mentions[0]
        const t0 = Date.parse(first.ts) - 15 * 60_000
        const dialog = first.kind === 'search' ? '' : steps[first.cause ?? first.i].dialog
        const back = steps.slice(0, first.i).reverse().filter((s) => Date.parse(s.ts) >= t0)
        const from = first.kind === 'search' ? first.i : (back.find((s) => s.kind === 'search') ?? [...back].reverse().find((s) => s.dialog === dialog))?.i ?? first.cause ?? first.i
        // Until the person searches for something else: after that they are working on another trade.
        const until = steps.find((s) => s.i > from && s.kind === 'search' && (s.raw.action || '').trim() !== id)?.i ?? Infinity
        const lab = (s: Step) => dialogLabel(s.dialog, reg, nameLookup(names), s.name)
        const span = spans.get(sid)
        out.push({
            session_id: sid,
            client: ev.find((e) => e.client)?.client || '',
            user: ev.find((e) => e.user)?.user || '',
            first_seen: mentions[0].ts,
            how: [...new Set(mentions.map((s) => (s.kind === 'search' ? 'searched for it' : `${s.kind === 'notice' ? 'notice' : 'message'}: ${s.text}`)))].slice(0, 5),
            errors_after: steps
                .filter((s) => s.i >= from && s.i < until && s.kind === 'message' && s.outcome === 'error')
                .slice(0, 8)
                .map((s) => ({ at: s.ts, dialog: lab(s), text: s.text || '' })),
            attempts_after: steps
                .filter((s) => s.i >= from && s.i < until && s.kind === 'submit')
                .slice(0, 10)
                .map((s) => ({ at: s.ts, dialog: lab(s), button: s.label, outcome: s.outcome || 'none' })),
            replay_url: span ? replayUrl(sid, Math.max(0, (Date.parse(mentions[0].ts) - Date.parse(span.start)) / 1000 - 10)) : undefined,
        })
    }
    return {
        id,
        sessions: out,
        note:
            'Sessions where someone searched for this id or Reval named it in a message, newest first. Errors and attempts run from when the person reached the trade (their search, or opening the dialog) until they searched for something else; ' +
            'an error that names no trade is likely, not proven, to be about this one. session_story tells a whole session.',
    }
}
