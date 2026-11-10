// Pure workflow definitions and reading. One start per episode, not per repeat open.
import { dialogLabel, type AppEvents, type DialogNames, type Step } from './appevents.ts'

export interface Workflow {
    id?: string
    name: string
    dialogs: string[]
    done: { dialog: string; buttons?: string[]; outcome: 'completed' | 'accepted' | 'either' }
}

// The same plain identifier pattern used by the event vocabulary for codes/properties.
export const DIALOG_CODE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
export const WORKFLOW_NAME_LIMIT = 1024
// A reversible, canonical chain id survives changes in titles, success text and query windows.
export const workflowId = (dialogs: string[]): string => `wf_${Buffer.from(JSON.stringify(dialogs)).toString('base64url')}`
export function workflowDialogsFromId(id: string): string[] {
    try {
        const dialogs: unknown = JSON.parse(Buffer.from(id.slice(3), 'base64url').toString())
        if (id.startsWith('wf_') && Array.isArray(dialogs) && dialogs.length >= 1 && dialogs.length <= 10 &&
            dialogs.every((d) => typeof d === 'string' && DIALOG_CODE.test(d)) && workflowId(dialogs) === id) return dialogs
    } catch { /* Report a useful error for malformed ids. */ }
    throw new Error('Invalid discovered workflow id. Use an id from discover_workflows or give dialogs.')
}
export function validateWorkflow(value: unknown): Workflow {
    const w = value as Workflow | undefined
    if (!w || typeof w.name !== 'string' || !w.name.trim() || w.name.trim().length > WORKFLOW_NAME_LIMIT) throw new Error(`Workflow name must be 1–${WORKFLOW_NAME_LIMIT} characters.`)
    if (!Array.isArray(w.dialogs) || !w.dialogs.length || w.dialogs.length > 10 || !w.dialogs.every((d) => typeof d === 'string' && DIALOG_CODE.test(d)))
        throw new Error('Workflow needs 1–10 dialog codes matching the vocabulary identifier pattern.')
    if (!w.done || !w.dialogs.includes(w.done.dialog)) throw new Error('Done dialog must be one of the workflow dialogs.')
    if (!['completed', 'accepted', 'either'].includes(w.done.outcome)) throw new Error('Done outcome must be completed, accepted or either.')
    if (w.done.buttons !== undefined && (!Array.isArray(w.done.buttons) || !w.done.buttons.length || w.done.buttons.length > 50 || !w.done.buttons.every((b) => typeof b === 'string' && !!b.trim() && b.length <= 80)))
        throw new Error('Done buttons must be 1–50 nonempty button names of at most 80 characters.')
    return { id: workflowId(w.dialogs), name: w.name.trim(), dialogs: [...w.dialogs], done: { dialog: w.done.dialog, outcome: w.done.outcome, ...(w.done.buttons ? { buttons: w.done.buttons.map((b) => b.trim()) } : {}) } }
}

export interface Episode { steps: Step[]; opens: Step[] }
export function workflowEpisodes(sessions: Step[][], reg: AppEvents): Episode[] {
    const excluded = new Set([...reg.dialogs.menu, ...reg.dialogs.messages, ...reg.dialogs.notices])
    const out: Episode[] = []
    for (const session of sessions) {
        let steps: Step[] = []
        const flush = () => {
            if (steps.length) out.push({ steps, opens: steps.filter((s) => s.kind === 'open' && !!s.dialog && !excluded.has(s.dialog)) })
            steps = []
        }
        for (const s of [...session].sort((a, b) => a.ts.localeCompare(b.ts) || a.i - b.i)) {
            if (s.kind === 'search' || s.kind === 'menu' || (steps.length && Date.parse(s.ts) - Date.parse(steps.at(-1)!.ts) >= 600_000)) flush()
            steps.push(s)
        }
        flush()
    }
    return out
}

export interface WorkflowError { text: string; template: string; count: number }
function topError(steps: Step[]): WorkflowError | undefined {
    const counts = new Map<string, WorkflowError>()
    for (const s of steps) if ((s.kind === 'message' || s.kind === 'notice') && s.outcome === 'error') {
        const key = s.template || s.text || '(no text)'
        const entry = counts.get(key) || { text: s.text || key, template: key, count: 0 }
        entry.count++
        counts.set(key, entry)
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.template.localeCompare(b.template))[0]
}

function timing(values: number[]) {
    const a = [...values].sort((x, y) => x - y)
    return { median_time_s: a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null,
        p90_time_s: a.length ? a[Math.ceil(a.length * 0.9) - 1] : null }
}
// A submit only counts when its answering message is inside this episode/attempt slice.
function reply(steps: Step[], submit: Step): Step | undefined {
    return steps.find((s) => (s.kind === 'notice' || s.kind === 'message') && s.cause === submit.i && s.outcome === submit.outcome)
}
const good = (s?: Step) => s?.outcome === 'completed' || s?.outcome === 'accepted'
const inWindow = (s: Step, window?: { from: Date; to: Date }) => !window || (Date.parse(s.ts) >= +window.from && Date.parse(s.ts) < +window.to)

export interface DiscoveredWorkflow {
    id: string; name: string; dialogs: string[]; sessions: number; clients: number; users: number; occurrences: number
    done: number; completed: number; accepted: number; median_time_s: number | null; p90_time_s: number | null; top_error?: WorkflowError; score: number
}

/** Frequent contiguous chains, support = distinct sessions; completion = occurrences. */
export function discoverWorkflowChains(sessions: Step[][], reg: AppEvents, opts: { names?: DialogNames; limit?: number; window?: { from: Date; to: Date } } = {}): DiscoveredWorkflow[] {
    type Candidate = { dialogs: string[]; sessions: Set<string>; clients: Set<string>; users: Set<string>; occurrences: number; completed: number; accepted: number; times: number[]; errors: Step[]; seen: string[]; finishes: Map<string, number> }
    const candidates = new Map<string, Candidate>()
    for (const ep of workflowEpisodes(sessions, reg)) {
        const opens = ep.opens.filter((s, i, all) => !i || s.dialog !== all[i - 1].dialog)
        for (let i = 0; i < opens.length; i++) for (let n = 2; n <= 4 && i + n <= opens.length; n++) {
            const first = opens[i], last = opens[i + n - 1], next = opens[i + n]
            if (!inWindow(first, opts.window)) continue
            const path = opens.slice(i, i + n)
            const steps = ep.steps.filter((s) => s.i >= first.i && (!next || s.i < next.i))
            const attempts = steps.filter((s) => s.kind === 'submit' && s.dialog === last.dialog && s.i > last.i)
            if (!attempts.length) continue
            const dialogs = path.map((s) => s.dialog), key = JSON.stringify(dialogs)
            let c = candidates.get(key)
            if (!c) candidates.set(key, c = { dialogs, sessions: new Set(), clients: new Set(), users: new Set(), occurrences: 0, completed: 0, accepted: 0, times: [], errors: [], seen: path.map((s) => s.name || ''), finishes: new Map() })
            c.sessions.add(first.raw.sid)
            if (first.raw.client) c.clients.add(first.raw.client)
            if (first.raw.user) c.users.add(first.raw.user)
            c.occurrences++
            const replies = attempts.map((s) => reply(steps, s)).filter((s): s is Step => good(s))
            if (replies.length) {
                const result = replies[0], submit = attempts.find((s) => s.i === result.cause)!
                const finish = `${submit.label} → '${(result.template || result.text || '').replace(/#/g, '…')}'`
                c.finishes.set(finish, (c.finishes.get(finish) || 0) + 1)
            }
            c.completed += Number(replies.some((s) => s.outcome === 'completed'))
            c.accepted += Number(replies.some((s) => s.outcome === 'accepted'))
            if (replies.length) c.times.push((Date.parse(replies[0].ts) - Date.parse(first.ts)) / 1000)
            c.errors.push(...steps.filter((s) => !replies.length || s.i <= replies[0].i))
        }
    }
    const frequent = [...candidates.values()].filter((c) => c.sessions.size >= 2)
    return frequent.filter((c) => !frequent.some((long) => long.dialogs.length > c.dialogs.length && long.sessions.size >= 0.8 * c.sessions.size &&
        long.dialogs.some((_, i) => c.dialogs.every((d, j) => long.dialogs[i + j] === d))))
        .map((c) => {
            const finish = [...c.finishes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
            const name = [...c.dialogs.map((d, i) => dialogLabel(d, reg, opts.names, c.seen[i])), ...(finish ? [finish] : [])].join(' → ')
            return { id: workflowId(c.dialogs), name: name.length > WORKFLOW_NAME_LIMIT ? `${name.slice(0, WORKFLOW_NAME_LIMIT - 1)}…` : name, dialogs: c.dialogs,
                sessions: c.sessions.size, clients: c.clients.size, users: c.users.size, occurrences: c.occurrences,
                done: c.times.length, completed: c.completed, accepted: c.accepted, ...timing(c.times), top_error: topError(c.errors), score: c.sessions.size * c.clients.size }
        })
        .sort((a, b) => b.score - a.score || b.sessions - a.sessions || b.dialogs.length - a.dialogs.length || a.name.localeCompare(b.name)).slice(0, opts.limit ?? 15)
}

export interface Abandonment { session_id: string; at: string; replay_url?: string }
export interface CompletionMetrics {
    started: number; steps: { dialog: string; name: string; reached: number }[]; done: number; completed: number; accepted: number
    failed_attempts: number; retries: number; abandoned: number; completion_rate: number
    median_time_s: number | null; p90_time_s: number | null
    biggest_drop?: { dialog: string; name: string; abandoned: number; top_error?: WorkflowError }
    examples: Abandonment[]
}
interface Attempt { dropoutSteps: Step[]; start: Step; reached: number; done?: Step; completed: boolean; accepted: boolean; failed: number; retries: number }

export function workflowCompletion(sessions: Step[][], definition: Workflow, reg: AppEvents, window?: { from: Date; to: Date }, names?: DialogNames): { overall: CompletionMetrics; clients: (CompletionMetrics & { client: string })[] } {
    const w = validateWorkflow(definition)
    const attempts: Attempt[] = []
    for (const ep of workflowEpisodes(sessions, reg)) {
        const start = ep.opens.find((s) => s.dialog === w.dialogs[0])
        if (!start || !inWindow(start, window)) continue
        let reached = 0, finalOpen = start
        for (const s of ep.opens) if (s.i >= start.i && s.dialog === w.dialogs[reached]) { reached++; finalOpen = s }
        const steps = ep.steps.filter((s) => s.i >= start.i)
        const finishes = reached === w.dialogs.length ? steps.filter((s) => s.kind === 'submit' && s.i > finalOpen.i && s.dialog === w.done.dialog &&
            (!w.done.buttons || w.done.buttons.some((b) => b.toLowerCase() === s.label.toLowerCase())))
            .map((s) => reply(steps, s)).filter((s): s is Step => good(s)) : []
        const done = finishes.find((s) => w.done.outcome === 'either' || s.outcome === w.done.outcome)
        const onWay = steps.filter((s) => (!done || s.i <= done.i) && w.dialogs.includes(s.dialog))
        const submits = onWay.filter((s) => s.kind === 'submit')
        const failed = submits.filter((s) => reply(steps, s)?.outcome === 'error')
        const retries = failed.filter((s) => submits.some((n) => n.i > s.i && n.dialog === s.dialog && n.label.toLowerCase() === s.label.toLowerCase() && Date.parse(n.ts) - Date.parse(s.ts) <= 300_000)).length
        attempts.push({ start, dropoutSteps: onWay.filter((s) => s.i >= finalOpen.i), reached, done, completed: finishes.some((s) => s.outcome === 'completed'), accepted: finishes.some((s) => s.outcome === 'accepted'), failed: failed.length, retries })
    }
    const metrics = (all: Attempt[]): CompletionMetrics => {
        const abandoned = all.filter((a) => !a.done)
        const drops = w.dialogs.map((_, i) => abandoned.filter((a) => a.reached === i + 1))
        const biggest = drops.map((a, i) => ({ a, i })).sort((a, b) => b.a.length - a.a.length || a.i - b.i)[0]
        const examples = new Map<string, Abandonment>()
        for (const a of abandoned) if (!examples.has(a.start.raw.sid) && examples.size < 3) examples.set(a.start.raw.sid, { session_id: a.start.raw.sid, at: a.start.ts })
        return { started: all.length, steps: w.dialogs.map((dialog, i) => ({ dialog, name: dialogLabel(dialog, reg, names), reached: all.filter((a) => a.reached > i).length })),
            done: all.length - abandoned.length, completed: all.filter((a) => a.completed).length, accepted: all.filter((a) => a.accepted).length,
            failed_attempts: all.reduce((n, a) => n + a.failed, 0), retries: all.reduce((n, a) => n + a.retries, 0), abandoned: abandoned.length,
            completion_rate: all.length ? (all.length - abandoned.length) / all.length : 0,
            ...timing(all.filter((a) => a.done).map((a) => (Date.parse(a.done!.ts) - Date.parse(a.start.ts)) / 1000)),
            biggest_drop: biggest?.a.length ? { dialog: w.dialogs[biggest.i], name: dialogLabel(w.dialogs[biggest.i], reg, names), abandoned: biggest.a.length,
                top_error: topError(biggest.a.flatMap((a) => a.dropoutSteps.filter((s) => s.dialog === w.dialogs[biggest.i])))} : undefined,
            examples: [...examples.values()] }
    }
    const clients = [...new Set(attempts.map((a) => a.start.raw.client || ''))].sort()
    return { overall: metrics(attempts), clients: clients.map((client) => ({ client, ...metrics(attempts.filter((a) => (a.start.raw.client || '') === client)) })) }
}
