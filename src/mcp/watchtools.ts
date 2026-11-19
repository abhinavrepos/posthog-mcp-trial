// The Watchlist in chat: Copilot reads what Lens kept from watched clients' replays (core/watchlist.ts),
// step by step, and can add or pause clients. Same grant as the other replay insights (client_experience):
// a Lens admin gives it per person. Everything here is structure only: reviewed control names, rounded
// timings, counts and replay links for the person to open; never typed values, screen text or coordinates.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { auditClient, requestedToolWindow } from '../core/toolcontext.ts'
import { rescueClients } from '../core/rescue.ts'
import { rescuePrivacy } from '../core/rescueprivacy.ts'
import { config } from '../core/config.ts'
import { MARK_TEXT, MARKS, type Mark } from '../core/replaymoments.ts'
import { changeWatch, highlights, repeatedProblems, sessionDetail, watchDigest, watched, watchlist, type Filter } from '../core/watchlist.ts'
import { jsonResult } from './result.ts'

export const WATCH_TOOLS = ['watch_highlights', 'session_moments', 'repeated_problems', 'watch_client']
/** Tools that change the list: they need dashboard sharing rights, like set_rescue_status. */
export const WATCH_WRITE_TOOLS = ['watch_client']

type Window = { from: string; to: string }
const kinds = z.array(z.enum(MARKS)).max(MARKS.length).optional().describe(`Only these kinds: ${MARKS.map((k) => `${k} (${MARK_TEXT[k].toLowerCase()})`).join(', ')}.`)
const when = z.string().max(80).optional().describe('Plain words such as last 7 days, yesterday or last month; default last 7 days.')
const page = () => `${config.service.publicUrl.replace(/\/$/, '')}/replays/watch`
const NOTE = 'Structure only: control names, timings and counts from the replay; no typed values, screen text or pointer positions. A long hover or pause shows where attention stayed, not why: watch the moment before concluding the person was confused.'

type Reg = McpServer['registerTool']
const day = (d: Date | number) => new Date(d).toISOString().slice(0, 10)
/** The period the tool wrapper resolved from `when`. Rolling periods ("last 7 days") include today: the watchlist is read every 10 minutes. */
function period(when: string | undefined, fallbackDays = 7): Window {
    const w = requestedToolWindow()
    const today = day(Date.now()), startOfToday = Date.parse(today + 'T00:00:00Z')
    if (!w) return { from: day(Date.now() - (fallbackDays - 1) * 86_400_000), to: today }
    // "last 7 days" ends where processed history ends (yesterday); here it means up to now. "yesterday" stays yesterday.
    // With no period given, the tool wrapper passes its default window as "<from> to <to>": that is rolling too.
    const defaulted = !!when && when.trim() === `${day(+w.from)} to ${day(+w.to - 1)}` && +w.to === startOfToday && +w.to - +w.from === fallbackDays * 86_400_000
    const rolling = !when || defaulted || /\b(last|past|this|today|recent|since)\b/i.test(when)
    return { from: day(+w.from), to: rolling && +w.to >= startOfToday ? today : day(Math.min(+w.to, Date.now()) - 1) }
}
export function registerWatchTools(reg: Reg, caller: { who: string; email?: string }): void {
    const json = (label: string, value: unknown) => jsonResult(label, value)
    const pick = (client: string, onlyWatched: boolean): { id: string; name: string } | { reply: ReturnType<typeof json> } => {
        const all = rescueClients(client.trim())
        const list = onlyWatched ? all.filter((c) => watched(c.id)) : all
        if (list.length === 1) { auditClient(list[0].id); return list[0] }
        if (onlyWatched && !list.length && all.length) return { reply: json('That client is not on the watchlist. Add it with watch_client first.', { watchlist: watchlist().slice(0, 50).map((c) => ({ client: c.client, name: c.name })) }) }
        if (!list.length) return { reply: json(`No client matches "${client.trim().slice(0, 80)}". Try the name as Lens shows it, or the client id.`, { candidates: [] }) }
        return { reply: json('Which client did you mean? Choose a client id.', { candidates: list.slice(0, 10) }) }
    }
    const filterOf = (input: { when?: string; kinds?: Mark[] }, client?: string): Filter => ({ ...period(input.when), ...(client ? { client } : {}), ...(input.kinds?.length ? { kinds: input.kinds } : {}) })

    reg('watch_client', {
        title: 'Add, pause, resume or remove a watched client',
        description: 'Changes the watchlist. add: Lens starts reading this client\'s finished replays of the last 14 days, a few every 10 minutes. pause/resume: stop or restart reading. remove: takes the client off and deletes what was kept for it. Only do this when the person asks.',
        inputSchema: { client: z.string().min(1).max(200).describe('Client name or id'), action: z.enum(['add', 'pause', 'resume', 'remove']) },
    }, async ({ client, action }) => {
        const c = pick(client, action !== 'add')
        if ('reply' in c) return c.reply
        if (action === 'add' && watched(c.id)) changeWatch(c.id, 'resume', caller.email || caller.who)
        else changeWatch(c.id, action, caller.email || caller.who)
        const done = { add: 'added to', pause: 'paused on', resume: 'resumed on', remove: 'removed from' }[action]
        return json(`${c.name} ${done} the watchlist.${action === 'add' ? ' The first sessions appear within about 10 minutes.' : ''}`, await rescuePrivacy({ client: c.id, name: c.name, action, open: page() }))
    })

    reg('watch_highlights', {
        title: 'What happened at watched clients?',
        description: 'Watched sessions where something went wrong or took effort, most telling first. One per session: a headline, the evidence in plain words, what kinds of struggle it shows, and a replay link at the moment. With a client: also a summary of what keeps going wrong there. Also lists the watched clients and how many sessions were read. Then session_moments for the step-by-step detail of one session.',
        inputSchema: { client: z.string().max(200).optional().describe('Client name or id; omit for every watched client.'), when, kinds, limit: z.number().int().min(1).max(25).default(10), offset: z.number().int().min(0).max(10_000).default(0) },
        annotations: { readOnlyHint: true },
    }, async (input) => {
        let id: string | undefined
        if (input.client) { const c = pick(input.client, true); if ('reply' in c) return c.reply; id = c.id }
        const f = filterOf(input, id)
        const list = watchlist()
        if (!list.length) return json(`The watchlist is empty. Add a client with watch_client, or on ${page()}.`, { watchlist: [], open: page() })
        const h = highlights(f, input.limit, input.offset)
        const digest = id ? watchDigest(id, { from: f.from, to: f.to, ...(f.kinds ? { kinds: f.kinds } : {}) }) : undefined
        const lines = [...(digest ? [`${digest.client_name}: ${digest.summary}`] : []), h.coverage.note, ...h.items.map((x, i) => `${input.offset + i + 1}. [${x.severity}] ${x.headline} (${x.client_name}, ${x.started_at.slice(0, 16).replace('T', ' ')} UTC): ${x.evidence}. Watch: ${x.moment.replay_url}`)]
        const status = list.filter((c) => !id || c.client === id).slice(0, 50).map((c) => ({ client: c.client, name: c.name, status: c.paused ? 'paused' : 'active', found: c.found, read: c.read, waiting: c.waiting, skipped: c.skipped, last_read_at: c.last_read_at, problem: c.last_error }))
        return json(lines.join('\n'), await rescuePrivacy({ window: { from: f.from, to: f.to }, watchlist: status, ...(digest ? { summary: digest.summary, kinds: digest.kinds, top_problems: digest.top_problems } : {}), total: h.total, offset: input.offset, reading: h.coverage, highlights: h.items, open: id ? `${page()}?client=${encodeURIComponent(id)}` : page(), note: NOTE }))
    })

    reg('repeated_problems', {
        title: 'What keeps going wrong in the same place?',
        description: 'The same struggle on the same control in several watched sessions ("Submit failed on the Save button in 6 sessions, 3 clients"), most sessions first, with up to three examples to watch. Use for "what should we fix first" on watched clients.',
        inputSchema: { client: z.string().max(200).optional(), when, kinds, min_sessions: z.number().int().min(1).max(50).default(2) },
        annotations: { readOnlyHint: true },
    }, async (input) => {
        let id: string | undefined
        if (input.client) { const c = pick(input.client, true); if ('reply' in c) return c.reply; id = c.id }
        const f = filterOf(input, id)
        const list = repeatedProblems(f, input.min_sessions)
        const label = list.length ? list.slice(0, 10).map((p) => `- ${p.what} on ${p.where}: ${p.sessions} sessions, ${p.clients} client${p.clients === 1 ? '' : 's'}`).join('\n') : `Nothing repeated in at least ${input.min_sessions} sessions from ${f.from} to ${f.to}.`
        return json(label, await rescuePrivacy({ window: { from: f.from, to: f.to }, problems: list, note: NOTE }))
    })

    reg('session_moments', {
        title: 'What exactly happened in this session?',
        description: 'Step by step, what the person did in one watched session and what followed. For each click or submit: what led up to it (how long the pointer rested on the control, how often it left and came back, how direct the path was, pauses, the fields visited and revisited, scrolling back and forth, controls hovered without clicking) and what followed (did the page react within 1 s, the server\'s time and status class, an error on screen). Each step has a replay link at that moment. To compare a session that went wrong with one that went fine, read both.',
        inputSchema: { session_id: z.string().min(8).max(100), from_s: z.number().min(0).max(86_400).optional().describe('Only steps from this second of the recording'), to_s: z.number().min(0).max(86_400).optional().describe('Only steps up to this second'), only_marked: z.boolean().default(false).describe('Only steps where something went wrong or took effort'), offset: z.number().int().min(0).max(100_000).default(0).describe('Skip this many steps (from next_offset)') },
        annotations: { readOnlyHint: true },
    }, async (input) => {
        if (input.from_s !== undefined && input.to_s !== undefined && input.to_s < input.from_s) return json('to_s must not be before from_s.', { from_s: input.from_s, to_s: input.to_s })
        const d = sessionDetail(input.session_id.trim(), { from_s: input.from_s, to_s: input.to_s, onlyMarked: input.only_marked })
        if (!d) return json('Lens has no steps for that session: only sessions of watched clients are read. Use watch_highlights to find one.', { session_id: input.session_id })
        auditClient(d.client)
        const PAGE = 80, steps = d.steps.slice(input.offset, input.offset + PAGE), nextOffset = input.offset + PAGE < d.steps.length ? input.offset + PAGE : null
        const lines = [`${d.client_name}, ${d.started_at.slice(0, 16).replace('T', ' ')} UTC, ${Math.round(d.duration_ms / 60_000)} min (${Math.round(d.active_ms / 60_000)} active). Pointer recording: ${d.pointer.coverage}.`,
            ...steps.map((s) => `${fmt(s.at_ms)} ${s.marks.length ? `[${s.marks.map((k) => MARK_TEXT[k]).join('; ')}] ` : ''}${s.line}`), ...(nextOffset !== null ? [`More steps: call again with offset ${nextOffset}.`] : [])]
        return json(lines.join('\n'), await rescuePrivacy({ ...d, steps, offset: input.offset, next_offset: nextOffset, steps_matching: d.steps.length, note: NOTE }))
    })

}
const fmt = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
