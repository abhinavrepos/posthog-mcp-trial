// Learn what happens after an error, without exposing field values or search text.
import { dialogLabel, isGeneratedId, prop, required, toSteps, type AppEvents, type DialogNames, type Step } from './appevents.ts'
import { recordingSpans } from './incidents.ts'
import { hogql, replayUrl } from './posthog.ts'
import { P } from './props.ts'
import { tokens } from './text.ts'

const ACTION_MS = 5 * 60_000
const RECOVERY_MS = 15 * 60_000
const BATCH_SIZE = 25

type Result = 'recovered' | 'failed_again' | 'gave_up'
export interface MessageExample {
    session_id: string
    at: string // the error, not the later retry
    message: string // keep trade/link ids
    replay_url?: string
}

export interface MessageDiagnosis {
    dialog: string
    name: string
    template: string
    occurrences: number
    sessions: number
    clients: number
    recovered: number
    recovered_pct: number
    failed_again: number
    failed_again_pct: number
    gave_up: number
    gave_up_pct: number
    median_recovery_s: number | null
    fixed_fields: { label: string; occurrences: number; pct: number }[]
    other_dialogs: { dialog: string; name: string; occurrences: number; pct: number }[]
    searched: { occurrences: number; pct: number }
    flags: { flag: 'points elsewhere' | 'dead end' | 'fine'; reason: string }[]
    examples: Partial<Record<Result, MessageExample>>
}

export interface MessageScope {
    from?: Date
    to?: Date
    clientId?: string
    dialog?: string
    message?: string
}

const pct = (n: number, total: number) => Math.round((1000 * n) / total) / 10
const samePerson = (a: Step, b: Step) => a.raw.sid === b.raw.sid && (a.raw.user || '') === (b.raw.user || '') && (a.raw.client || '') === (b.raw.client || '')

/**
 * One array per session/person, as returned by toSteps. Actions stop at any next submit or five
 * minutes. Outcomes look farther: a same-button success within 15 min, a retry with this template
 * again, or no more submits on this dialog in the observed session. Recovery and failure can overlap.
 */
export function diagnoseMessages(sessions: Step[][], reg: AppEvents, scope: MessageScope = {}, names?: DialogNames): MessageDiagnosis[] {
    const groups = new Map<string, {
        result: MessageDiagnosis
        sessions: Set<string>
        clients: Set<string>
        times: number[]
        fields: Map<string, number>
        dialogs: Map<string, { name: string; count: number }>
        fixed: number
    }>()
    for (const session of sessions) {
        const steps = [...session].sort((a, b) => a.ts.localeCompare(b.ts) || a.i - b.i)
        const byIndex = new Map(steps.map((s) => [s.i, s]))
        // Only a reply tied to this submit can establish when it ended (not an unrelated toast).
        const replies = new Map<number, Step>()
        for (const s of steps) {
            if ((s.kind === 'message' || s.kind === 'notice') && s.cause !== undefined) {
                const cause = byIndex.get(s.cause)
                if (cause?.kind === 'submit' && samePerson(s, cause) && cause.outcome === s.outcome && !replies.has(cause.i)) replies.set(cause.i, s)
            }
        }
        for (let i = 0; i < steps.length; i++) {
            const error = steps[i]
            if ((error.kind !== 'message' && error.kind !== 'notice') || error.outcome !== 'error') continue
            const at = Date.parse(error.ts)
            if ((scope.from && at < scope.from.getTime()) || (scope.to && at >= scope.to.getTime()) || (scope.clientId && error.raw.client !== scope.clientId)) continue
            const name = dialogLabel(error.dialog, reg, names, error.name)
            if (scope.dialog && error.dialog.toLowerCase() !== scope.dialog.toLowerCase() && !name.toLowerCase().includes(scope.dialog.toLowerCase())) continue
            const template = error.template || error.text || '(no text)'
            if (scope.message && ![error.text || '', template].some((t) => t.toLowerCase().includes(scope.message!.toLowerCase()))) continue
            const key = JSON.stringify([error.dialog, template])
            let group = groups.get(key)
            if (!group) {
                group = {
                    result: {
                        dialog: error.dialog, name, template, occurrences: 0, sessions: 0, clients: 0,
                        recovered: 0, recovered_pct: 0, failed_again: 0, failed_again_pct: 0, gave_up: 0, gave_up_pct: 0,
                        median_recovery_s: null, fixed_fields: [], other_dialogs: [], searched: { occurrences: 0, pct: 0 }, flags: [], examples: {},
                    },
                    sessions: new Set(), clients: new Set(), times: [], fields: new Map(), dialogs: new Map(), fixed: 0,
                }
                groups.set(key, group)
            }
            const r = group.result
            r.occurrences++
            group.sessions.add(error.raw.sid)
            if (error.raw.client) group.clients.add(error.raw.client)
            const fields = new Set<string>()
            const dialogs = new Map<string, string>()
            let searched = false
            for (let j = i + 1; j < steps.length; j++) {
                const next = steps[j]
                if (Date.parse(next.ts) - at > ACTION_MS) break
                if (!samePerson(error, next)) continue
                if (next.kind === 'submit') break
                if (next.kind === 'field' && next.label && !/^an unlabelled\b/i.test(next.label) && !isGeneratedId(next.label, reg) && !isGeneratedId(next.raw.action || '', reg)) fields.add(next.label)
                if (next.kind === 'search') searched = true // deliberately do not read label/raw.action
                if (next.kind === 'open' && next.dialog && next.dialog !== error.dialog && ![...reg.dialogs.menu, ...reg.dialogs.messages, ...reg.dialogs.notices].includes(next.dialog))
                    dialogs.set(next.dialog, dialogLabel(next.dialog, reg, names, next.name))
            }
            if (fields.size) group.fixed++
            for (const f of fields) group.fields.set(f, (group.fields.get(f) || 0) + 1)
            for (const [d, label] of dialogs) group.dialogs.set(d, { name: label, count: (group.dialogs.get(d)?.count || 0) + 1 })
            if (searched) r.searched.occurrences++

            const cause = error.cause === undefined ? undefined : byIndex.get(error.cause)
            const button = cause?.kind === 'submit' && samePerson(error, cause) ? cause.label : undefined
            let retried = false
            let failedAgain = false
            let recovery: number | undefined
            for (let j = i + 1; j < steps.length; j++) {
                const next = steps[j]
                if (!error.dialog || !samePerson(error, next) || next.kind !== 'submit' || next.dialog !== error.dialog) continue
                retried = true
                const reply = replies.get(next.i)
                if (!reply) continue
                if (reply.outcome === 'error' && (reply.template || reply.text || '(no text)') === template) failedAgain = true
                const elapsed = Date.parse(reply.ts) - at
                if (button && next.label.toLowerCase() === button.toLowerCase() && (next.outcome === 'completed' || next.outcome === 'accepted') && elapsed >= 0 && elapsed <= RECOVERY_MS)
                    recovery = Math.min(recovery ?? Infinity, elapsed / 1000)
            }
            const example = { session_id: error.raw.sid, at: error.ts, message: error.text || template }
            if (recovery !== undefined) {
                r.recovered++
                group.times.push(recovery)
                r.examples.recovered ??= example
            }
            if (failedAgain) {
                r.failed_again++
                r.examples.failed_again ??= example
            }
            // An unattributed error has no dialog on which to establish abandonment.
            if (error.dialog && !retried) {
                r.gave_up++
                r.examples.gave_up ??= example
            }
        }
    }
    return [...groups.values()].map((g) => {
        const r = g.result
        const n = r.occurrences
        r.sessions = g.sessions.size
        r.clients = g.clients.size
        r.recovered_pct = pct(r.recovered, n)
        r.failed_again_pct = pct(r.failed_again, n)
        r.gave_up_pct = pct(r.gave_up, n)
        const times = g.times.sort((a, b) => a - b)
        if (times.length) r.median_recovery_s = (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2
        r.fixed_fields = [...g.fields].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([label, count]) => ({ label, occurrences: count, pct: pct(count, n) }))
        r.other_dialogs = [...g.dialogs].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, 3).map(([dialog, d]) => ({ dialog, name: d.name, occurrences: d.count, pct: pct(d.count, n) }))
        r.searched.pct = pct(r.searched.occurrences, n)
        const words = new Set(tokens(r.template))
        const matches = r.fixed_fields.filter((f) => tokens(f.label).some((w) => words.has(w))).length
        if (n >= 3 && r.fixed_fields.length && !matches)
            r.flags.push({ flag: 'points elsewhere', reason: `0/${r.fixed_fields.length} top field labels share a message word; fields touched after ${g.fixed}/${n} occurrences.` })
        if (n >= 3 && r.gave_up / n >= 0.5)
            r.flags.push({ flag: 'dead end', reason: `${r.gave_up}/${n} (${r.gave_up_pct}%) had no later submit on this dialog in the session.` })
        if (r.recovered / n >= 0.8)
            r.flags.push({ flag: 'fine', reason: `${r.recovered}/${n} (${r.recovered_pct}%) recovered on the same dialog and button within 15 min.` })
        return r
    }).sort((a, b) => {
        const warning = (r: MessageDiagnosis) => Number(r.flags.some((f) => f.flag !== 'fine'))
        return warning(b) - warning(a) || b.clients - a.clients || b.occurrences - a.occurrences || a.dialog.localeCompare(b.dialog) || a.template.localeCompare(b.template)
    })
}

export interface MessageDoctorReport {
    window: { from: string; to: string }
    observed_through: string
    messages: MessageDiagnosis[]
    rows_read: number
    query_rows: { sessions: number; events: number; capped_event_batches: number }
    sessions_read: number
    omitted_sessions: string[]
    truncated: boolean
    replay_links: 'available' | 'unavailable'
    /** Only when the window had more error sessions than are diagnosed live. */
    sample?: { from: string; to: string; error_sessions: number; note: string }
    window_totals?: WindowTotals
    note: string
}
export interface WindowTotals {
    source: 'history'
    complete: boolean
    coverage?: string
    messages: { dialog: string; name: string; template: string; occurrences: number; unrecovered: number; clients: number }[]
}
const maxErrorSessions = () => { const n = Number(process.env.LENS_MESSAGE_DOCTOR_SESSIONS || 1000); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1000 }
/** Every error chain in the window, per dialog and template, from the daily history (complete days only). */
async function historyTotals(q: MessageScope & { from: Date; to: Date }): Promise<WindowTotals> {
    const { tasksDb, coverage } = await import('./tasks.ts')
    const window = { from: q.from.toISOString().slice(0, 10), to: new Date(+q.to - 1).toISOString().slice(0, 10) }
    const cover = coverage(window)
    const like = (s?: string) => s ? `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null
    const rows = tasksDb.prepare(`SELECT e.dialog, coalesce(n.name, e.dialog) AS name, e.template, sum(e.chains) AS occurrences, sum(e.unrecovered) AS unrecovered,
            count(DISTINCT e.client) AS clients FROM errors_daily e LEFT JOIN dialog_names n ON n.dialog = e.dialog
        WHERE e.day BETWEEN ? AND ? AND e.day IN (SELECT day FROM task_ingest WHERE finalized = 1 AND truncated = 0)
          AND (? IS NULL OR e.client = ?) AND (? IS NULL OR e.dialog LIKE ? ESCAPE '\\' OR n.name LIKE ? ESCAPE '\\') AND (? IS NULL OR e.template LIKE ? ESCAPE '\\')
        GROUP BY e.dialog, e.template ORDER BY occurrences DESC, e.dialog, e.template LIMIT 20`)
        .all(window.from, window.to, q.clientId ?? null, q.clientId ?? null, like(q.dialog), like(q.dialog), like(q.dialog), like(q.message), like(q.message)) as WindowTotals['messages']
    return { source: 'history', complete: cover.complete, ...(cover.text ? { coverage: cover.text } : {}), messages: rows.map((r) => ({ ...r })) }
}

/** Error sessions first, then their events (including fields), so busy sessions do not hide errors. */
export async function messageDoctor(q: { from: Date; to: Date; clientId?: string; dialog?: string; message?: string }): Promise<MessageDoctorReport> {
    const reg = required()
    const button = prop(reg, 'button')
    // Reval sends the message as ["text"], but other vocabularies may send a plain string or action.
    const text = `if(empty(${button}), ${prop(reg, 'action')}, if(startsWith(${button}, '['), JSONExtractString(${button}, 1), ${button}))`
    const values: Record<string, unknown> = {
        from: q.from.toISOString(), to: q.to.toISOString(), client: q.clientId || '',
        events: [reg.events.screen, reg.events.interaction], special: [...reg.dialogs.messages, ...reg.dialogs.notices], notices: reg.dialogs.notices,
        error: 'error', messageOutcome: reg.messageOutcome, noticeOutcome: reg.noticeOutcome,
    }
    // Mirror outcomeOf's ordered rules, including "nothing found" and scheduled/queued notices.
    const rules = reg.outcomes.map((o, i) => {
        values[`match${i}`] = `(?i)${o.match}`
        values[`outcome${i}`] = o.outcome
        return `WHEN match(${text}, {match${i}}) THEN {outcome${i}}`
    }).join(' ')
    const outcome = rules ? `CASE ${rules} ELSE if(${prop(reg, 'dialog')} IN {notices}, {noticeOutcome}, {messageOutcome}) END`
        : `if(${prop(reg, 'dialog')} IN {notices}, {noticeOutcome}, {messageOutcome})`
    // Filter dialog/message after attribution/grouping. A messagebox carries neither its originating
    // dialog nor its title, and filtering raw messages would also miss id-free template matches.
    // Error sessions are read from the window's end backwards, in slices that double (7, 14, 28 … days), up to
    // MAX_ERROR_SESSIONS. Every page re-aggregates its slice, and two years held 2.4 million error sessions
    // (2,400 pages of a 2-year scan, then 95,000 event batches): the job could never finish. A window with fewer
    // error sessions is still read completely; a larger one is diagnosed from the most recent slice reached
    // (sessions ordered by id within it, so effectively at random), and says so. Window totals come from history.
    const candidates: Record<string, unknown>[] = []
    const cap = maxErrorSessions()
    let sliceTo = q.to, sliceDays = 7, sampledFrom = q.from, sampled = false
    while (sliceTo > q.from && !sampled) {
        const sliceFrom = new Date(Math.max(+q.from, +sliceTo - sliceDays * 86_400_000))
        let cursor = ''
        while (true) {
            const page = await hogql(
                `SELECT toString(properties.$session_id) AS sid, max(timestamp) AS last FROM events
                 WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}
                   AND ${prop(reg, 'dialog')} IN {special} AND (${outcome}) = {error}
                   AND notEmpty(toString(properties.$session_id)) AND ({client} = '' OR toString(${P.client}) = {client})
                 AND toString(properties.$session_id) > {cursor}
                 GROUP BY sid ORDER BY sid LIMIT 1000`, { ...values, from: sliceFrom.toISOString(), to: sliceTo.toISOString(), cursor }
            )
            candidates.push(...page)
            // More than the cap, with more still unread (this slice or older ones): diagnose what was read.
            if (candidates.length > cap && (page.length === 1000 || sliceFrom > q.from)) { sampled = true; break }
            if (page.length < 1000) break
            const next = String(page.at(-1)!.sid)
            if (next <= cursor) throw new Error('Error session pagination did not advance')
            cursor = next
        }
        if (sampled) sampledFrom = sliceFrom
        sliceTo = sliceFrom; sliceDays *= 2
    }
    // A session with errors in two slices is read once.
    const unique = [...new Map(candidates.map((r) => [String(r.sid), r])).values()].slice(0, sampled ? cap : undefined)
    candidates.length = 0; candidates.push(...unique)
    const scope = sampled ? { ...q, from: sampledFrom } : q
    // Read through now, not just the requested window: a retry just after the window still counts.
    // One minute of history covers toSteps' attribution window for an error at the left edge.
    const observed = new Date()
    let eventRows = 0
    const cappedBatches = 0
    const omitted: string[] = []
    const sessions: Step[][] = []
    let sessionsRead = 0
    const { liveEvents } = await import('./liveevents.ts')
    const read = async (ids: string[]): Promise<void> => {
        const rows = await liveEvents({ ...q, from: new Date(+scope.from - 60_000), to: observed }, ids)
        eventRows += rows.length
        const byPerson = new Map<string, typeof rows>()
        const seen = new Set<string>()
        for (const e of rows) {
            const key = JSON.stringify([e.sid, e.client, e.user])
            if (!byPerson.has(key)) byPerson.set(key, [])
            byPerson.get(key)!.push(e)
            seen.add(e.sid)
        }
        sessionsRead += seen.size
        for (const events of byPerson.values()) sessions.push(toSteps(events, reg))
    }
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) await read(candidates.slice(i, i + BATCH_SIZE).map((r) => String(r.sid)))
    const messages = diagnoseMessages(sessions, reg, scope)
    const history = sampled ? await historyTotals(q) : undefined
    const examples = messages.flatMap((m) => Object.values(m.examples))
    let replayLinks: MessageDoctorReport['replay_links'] = 'available'
    const spans = await recordingSpans(examples.map((e) => e.session_id)).catch(() => {
        replayLinks = 'unavailable'
        return new Map()
    })
    for (const e of examples) {
        const span = spans.get(e.session_id)
        if (span) e.replay_url = replayUrl(e.session_id, Math.max(0, (Date.parse(e.at) - Date.parse(span.start)) / 1000 - 10))
    }
    return {
        window: { from: q.from.toISOString(), to: q.to.toISOString() }, observed_through: observed.toISOString(), messages,
        rows_read: candidates.length + eventRows,
        query_rows: { sessions: candidates.length, events: eventRows, capped_event_batches: cappedBatches },
        sessions_read: sessionsRead, omitted_sessions: omitted, truncated: sampled, replay_links: replayLinks,
        ...(sampled ? { sample: { from: scope.from.toISOString(), to: q.to.toISOString(), error_sessions: candidates.length,
            note: `This window has more than ${cap.toLocaleString('en-US')} error sessions. Recovery, give-up, fields and examples are learned from ${candidates.length.toLocaleString('en-US')} error sessions in its most recent days (${scope.from.toISOString().slice(0, 10)} to ${q.to.toISOString().slice(0, 10)}); window_totals counts every error in the whole window from Lens's daily history. For behaviour in an earlier period, ask for that period.` },
            window_totals: history } : {}),
        note: (sampled ? 'Sampled: see sample. ' : 'All error sessions and their events are keyset paged; no population cap. ') + 'Client is filtered before selection, dialog and message after attribution. ' +
            'Only errors inside the window count; following events are read through observed_through. Gave up means no later submit in the observed session, which may still be active. ' +
            'Actions stop at the next submit (on any dialog) or 5 min. Fixed fields are labels touched, not proof of a correction. ' +
            'Recovery requires a later same-dialog, same-button submit ending completed or accepted within 15 min of the error; accepted means queued, not finished. ' +
            'Failed again means a later submit on this dialog produced the same template. Recovery and failed again (and their flags) can overlap; other retries may fit neither. ' +
            'Percentages use occurrences, counting each field, other dialog and search at most once per occurrence. Points elsewhere: ≥3 occurrences and no word overlap in the top 5 touched field labels; dead end: ≥3 occurrences and ≥50% gave up; fine: ≥80% recovered. ' +
            'Flags describe observed behaviour, not causation; unassigned errors cannot establish give-up or same-button recovery. Replay links are for people only.',
    }
}
