import { peerBenchmark, type PeerTask } from './peers.ts'
// A client account narrative from Lens's own history. Never query PostHog here.
import { tasksDb, cached, coverage, dataThrough } from './tasks.ts'
import { all, one } from './db.ts'
import { rescueQueue, type RescueAction } from './rescue.ts'
import { weekObservation } from './weekly.ts'
import { rescuePrivacy } from './rescueprivacy.ts'
import { replayUrl } from './posthog.ts'
import type { Coverage } from './taskstypes.ts'

const shift = (s: string, n: number) => new Date(Date.parse(s) + n * 86400000).toISOString().slice(0, 10)
const query = <T>(sql: string, ...args: string[]) => tasksDb.prepare(sql).all(...args) as T[]
export interface StoryWeek { week_start: string; attempts: number; done: number; users: number; errors: number; unrecovered: number; exports: number; productive_done: number }
export interface StoryEvent { actor?: string; source?: string; date: string; kind: 'reason_seen' | 'reason_cleared' | 'signal_seen' | 'action' | 'survey' | 'note'; text: string }
export interface ClientStory {
    peers?: PeerTask[]; peer_note?: string; peer_clients?: number
    window?: { from: string; to: string }; client: string; client_name: string; coverage: Coverage; weeks: StoryWeek[]; events: StoryEvent[]; summary: string
    surveys: { name: string; date: string; status: string }[]; action?: RescueAction; unknown: string
}
async function history(client: string, weeks: number, to: string) {
    // Calendar weeks in UTC; the final week can be partial through the last processed day.
    const monday = shift(to, -((new Date(to).getUTCDay() + 6) % 7)), from = shift(monday, -7 * (weeks - 1))
    const series: StoryWeek[] = [], events: StoryEvent[] = []
    let previous: Map<string, { text: string }> | null = null
    const seenSignals = new Set<string>()
    for (let i = -1; i < weeks; i++) {
        const start = shift(from, i * 7), end = [shift(start, 6), to].sort()[0]
        if (i >= 0) {
            const sum = (table: string, expr: string) => query<Record<string, number>>(`SELECT ${expr} FROM ${table} WHERE client=? AND day BETWEEN ? AND ?`, client, start, end)[0]
            const t = sum('task_daily', 'coalesce(sum(attempts),0) AS attempts, coalesce(sum(done),0) AS done')
            const e = sum('errors_daily', 'coalesce(sum(chains),0) AS errors, coalesce(sum(unrecovered),0) AS unrecovered')
            series.push({ week_start: start, attempts: t.attempts, done: t.done,
                users: sum('task_users_daily', "count(DISTINCT nullif(user,'')) AS n").n, errors: e.errors, unrecovered: e.unrecovered,
                exports: sum('ops_daily', "coalesce(sum(CASE WHEN family='export' THEN submits ELSE 0 END),0) AS n").n,
                productive_done: sum('client_daily', 'coalesce(sum(productive_done),0) AS n').n })
        }
        // Stored weekly observations (src/core/weekly.ts): computed once per week, not on every story.
        const obs = await weekObservation(end), complete = obs.complete
        const mine = obs.rows.filter(r => r.client === client)
        const current = new Map(mine.filter(r => r.source === 'reason').map(r => [r.key, r]))
        if (i >= 0 && complete) {
            for (const [key, r] of current) if (!previous?.has(key)) events.push({ date: end, kind: 'reason_seen', text: `First observed in weekly review: ${r.text}` })
            if (previous) for (const [key, r] of previous) if (!current.has(key)) events.push({ date: end, kind: 'reason_cleared', text: `No longer flagged in weekly review: ${r.text} (not proof of recovery)` })
        }
        previous = complete ? current : null
        for (const s of mine.filter(r => r.source === 'signal')) {
            if (i >= 0 && !seenSignals.has(s.key)) events.push({ date: end, kind: 'signal_seen', text: `Signal first observed in weekly review: ${s.text}` })
            seenSignals.add(s.key)
        }
    }
    return { weeks: series, events, coverage: coverage({ from: shift(from, -56), to }), window: { from, to } }
}
export async function clientStory({ client, weeks = 26 }: { client: string; weeks?: number }): Promise<ClientStory> {
    if (typeof client !== 'string' || !client.trim() || client.length > 256) throw new Error('Choose a client id')
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new Error('Weeks must be an integer from 1 to 52')
    const to = dataThrough() || shift(new Date().toISOString().slice(0, 10), -1)
    const h = await cached('story-history', { client, weeks, to }, () => history(client, weeks, to), weeks * 7 + 186)
    const name = query<{ name: string }>('SELECT name FROM client_names WHERE client=?', client)[0]?.name || client
    const action = one<RescueAction>('SELECT * FROM rescue_actions WHERE client=?', client)
    const events = [...h.events]
    let previousStatus: string | undefined
    for (const a of all<{ t: string; who: string; details: string }>("SELECT t,who,details FROM audit WHERE action='rescue.updated' AND json_extract(details,'$.client')=? AND t>=? ORDER BY t,id", client, h.window.from)) {
        const d = JSON.parse(a.details) as { status?: string; previous_status?: string; from_status?: string; note?: string; via?: string; source?: string }
        if (d.status) {
            const label = (v: string) => v.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())
            const from = d.previous_status || d.from_status || previousStatus
            events.push({ date: a.t, kind: 'action', actor: a.who, text: `changed follow-up ${from ? 'from ' + label(from) + ' to ' : 'to '}${label(d.status)}`, ...((d.via || d.source || /^via (chat|web)$/i.exec(d.note || '')?.[1]) ? { source: d.via || d.source || /^via (chat|web)$/i.exec(d.note || '')![1] } : {}) })
            previousStatus = d.status
        }
        if (d.note && !/^via (chat|web)$/i.test(d.note)) events.push({ date: a.t, actor: a.who, kind: 'note', text: `Note updated: ${d.note}`, ...(d.via || d.source ? { source: d.via || d.source } : {}) })
    }
    const surveys = all<{ name: string; date: string; status: string }>(`SELECT name,created_at AS date,status FROM client_surveys WHERE client=? AND created_at>=?`, client, h.window.from)
    for (const s of surveys) events.push({ date: s.date, kind: 'survey', text: `${s.name}: ${s.status} (last recorded locally)` })
    for (const s of all<{ survey_name: string; at: string }>(`SELECT survey_name,at FROM survey_launches l WHERE at>=? AND
        (EXISTS (SELECT 1 FROM json_each(l.clients) WHERE value=?) OR l.clients='"all"' OR EXISTS
        (SELECT 1 FROM client_surveys c WHERE c.survey_id=l.survey_id AND c.client=?))`, h.window.from, client, client)) {
        surveys.push({ name: s.survey_name, date: s.at, status: 'launched' })
        events.push({ date: s.at, kind: 'survey', text: `${s.survey_name}: launched` })
    }
    if (action?.note && !events.some(e => e.source === action.note || e.kind === 'note' && e.text.replace(/^Note updated: /, '') === action.note)) events.push({ date: action.updated_at, kind: 'note', text: action.note })
    events.sort((a,b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text))
    surveys.sort((a,b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
    const last = h.weeks.at(-1)!, before = h.weeks.at(-2)
    const changed = `Latest calendar week through ${to}: ${last.attempts} attempts and ${last.done} done${before ? ` versus ${before.attempts} attempts and ${before.done} done in the preceding week` : ''}; the latest week may be partial.`
    const doing = action ? `The account action is ${action.status.replaceAll('_', ' ')} with ${action.owner || 'no owner assigned'}${action.due ? ` and due ${action.due}` : ''}; ${surveys.length} survey records are available.` : `No account action is recorded; ${surveys.length} survey records are available.`
    const unknown = `History cannot tell us why use changed or whether work moved elsewhere; ${h.coverage.complete ? 'processed days cover this series' : 'some days are unprocessed'}, survey status is last recorded locally and weekly flags compare trailing 28-day periods rather than exact onset dates.`
    const peer = await peerBenchmark({ client, window: { from: shift(to,-27), to } })
    return rescuePrivacy({ window: h.window, peer_clients: Math.max(0, ...peer.tasks.map(p => p.peer_clients)), peers: peer.tasks.filter(p => p.ratio >= 1.5 - 1e-12 || p.peer_done_rate-p.done_rate >= .15 - 1e-12), peer_note: peer.coverage.complete ? peer.note : peer.coverage.text, client, client_name: name, coverage: h.coverage, weeks: h.weeks, events, surveys, ...(action ? { action } : {}), summary: `${changed} ${doing} ${unknown}`, unknown })
}
export async function handoverPack(client: string): Promise<string> {
    const story = await clientStory({ client }), to = dataThrough() || shift(new Date().toISOString().slice(0,10), -1), from = shift(to, -89)
    const tasks = query<{ name: string; done: number }>(`SELECT coalesce(c.name,d.task_id) AS name,sum(d.done) AS done FROM task_daily d LEFT JOIN task_catalog c USING(task_id)
        WHERE d.client=? AND d.day BETWEEN ? AND ? GROUP BY d.task_id HAVING sum(d.done)>0 ORDER BY done DESC,d.task_id LIMIT 5`, client, from, to)
    const q = await rescueQueue({ include_snoozed: true })
    const reasons = q.clients.find(c => c.client === client)?.reasons || []
    const replays = query<{ session_id: string; offset_s: number }>(`SELECT session_id,offset_s FROM task_attempts WHERE client=? AND session_id!='' AND day BETWEEN ? AND ?
        GROUP BY session_id ORDER BY max(started_at) DESC,session_id LIMIT 2`, client, from, to)
    const bullets = (lines: string[], empty: string) => lines.length ? lines.map(s => `- ${s}`).join('\n') : empty
    const a = story.action
    return rescuePrivacy(`# Handover: ${story.client_name}\n\n## Established tasks (90 days)\n${bullets(tasks.map(t => `${t.name}: ${t.done} done`), 'No completed tasks recorded.')}\n\n## What changed recently\n${bullets(reasons.map(r => r.text), q.coverage.complete ? 'No current rescue reasons.' : 'Incomplete comparison history; reasons unavailable.')}\n\n## Open actions and owners\n${a && !['resolved','expected'].includes(a.status) ? `${a.status.replaceAll('_',' ')} — ${a.owner || 'Unassigned'}${a.due ? `; due ${a.due}` : ''}${a.note ? `\n${a.note}` : ''}` : 'No open action recorded.'}\n\n## Surveys asked\n${bullets(story.surveys.map(s => `${s.date}: ${s.name} — ${s.status}`), 'No surveys sent to this client.')}\n\n## Replays\n${bullets(replays.map((r,i) => `[Replay ${i+1}](${replayUrl(r.session_id,r.offset_s)})`), 'No replay links for recorded attempts.')}\n\n## What we do not know\n${bullets(['History cannot explain why use changed or whether work moved elsewhere.', story.coverage.complete ? 'Processed days cover this series.' : 'Some days are unprocessed.', 'Survey status reflects the last recorded update.', 'Weekly flags compare trailing 28-day periods; they do not establish when a change began.', 'Earlier surveys without targeting metadata may be absent.'], '')}\n`)
}
