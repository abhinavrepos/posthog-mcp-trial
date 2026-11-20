// The stand-in PostHog for scripts/stress-rescue.ts, in its own process (as the real one is): HogQL over HTTP,
// answered from a deterministic generator shaped like Reval's events. GET /stats tells how many queries came.
//   node --import tsx scripts/stress-posthog.ts <port> <clients> <sessions per client and day>
import { createServer } from 'node:http'

const PORT = Number(process.argv[2]), CLIENTS = Number(process.argv[3] || 50), PER = Number(process.argv[4] || 55), TASKS = 40
const DAY = 86_400_000
const dayStr = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10)
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const clientId = (c: number) => `C${pad(c + 1)}`

// ---------------------------------------------------------------- the event generator (deterministic per day)
type Ev = { sid: string; ts: string; event: string; client: string; user: string; dialog: string; dialogName: string; tab: string; action: string; control: string; button: string; version: string; ctime: number; event_uuid: string; client_name: string }
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }
const dayCache = new Map<string, { sessions: { sid: string; first_ts: string; first_ctime: number }[]; events: Ev[] }>()
function generate(day: string) {
    const hit = dayCache.get(day); if (hit) return hit
    const ago = Math.round((Date.parse(dayStr(0)) - Date.parse(day)) / DAY)
    const r = rng(Date.parse(day) / DAY), events: Ev[] = [], sessions: { sid: string; first_ts: string; first_ctime: number }[] = []
    let uuid = 0
    for (let c = 0; c < CLIENTS; c++) for (let s = 0; s < PER; s++) {
        const sid = `${day}-${clientId(c)}-${pad(s, 3)}`, user = `ENV|01|${clientId(c)}|user${(s % 6) + 1}`
        let t = Date.parse(`${day}T08:00:00Z`) + Math.floor(r() * 9 * 3600_000)
        const add = (event: string, dialog: string, button = '', action = '', step = 1 + r() * 8) => {
            t += Math.round(step * 1000)
            const ts = new Date(t).toISOString()
            events.push({ sid, ts, event, client: clientId(c), user, dialog, dialogName: dialog.replace('Dlg', ''), tab: '', action, control: '', button, version: 'Reval 26.3', ctime: t, event_uuid: `${sid}-${pad(uuid++, 6)}`, client_name: `Client ${pad(c + 1)}` })
        }
        add('PageView', 'DlgList', '', 'OPEN')
        sessions.push({ sid, first_ts: events.at(-1)!.ts, first_ctime: t })
        const attempts = 4 + Math.floor(r() * 4)
        for (let a = 0; a < attempts; a++) {
            let task = Math.floor(r() * TASKS)
            if (c === 0 && task === 0 && ago <= 14) task = 1 // C01 stopped task 00 in the last fortnight
            const dialog = `DlgTask${pad(task)}`, slow = c === 1 && task === 1 && ago <= 14 ? 1.6 : 1
            add('PageView', dialog, '', 'OPEN')
            for (let k = 0; k < 3; k++) add('Event', dialog, 'Field', 'CHANGE', 4 * slow + r() * 6 * slow)
            if (r() < 0.12) add('Event', dialog, 'CSV Export', '', 1)
            add('Event', dialog, 'Save', '', 2 * slow)
            if (r() < 0.1) {
                add('Event', 'messagebox', 'Invalid date', '', 1)
                if (r() < 0.3) { add('Event', dialog, 'Export', '', 1); continue }
                add('Event', dialog, 'Save', '', 5 * slow)
            }
            add('Event', 'toast', `Trade Id ${1000 + a} Updated`, '', 1)
        }
    }
    events.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.event_uuid < b.event_uuid ? -1 : 1))
    sessions.sort((a, b) => (a.sid < b.sid ? -1 : 1))
    const out = { sessions, events }
    dayCache.clear(); dayCache.set(day, out)
    return out
}
const after = (e: Ev, sid: string, ts: string, uuid: string) => e.sid > sid || (e.sid === sid && (e.ts > ts || (e.ts === ts && e.event_uuid > uuid)))
const notAfter = (e: Ev, sid: string, ts: string, uuid: string) => !after(e, sid, ts, uuid)
let queries = 0
async function fakePosthog(sql: string, values: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    queries++
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values.from ?? ''))) return [] // first-event and other lookups: nothing to report
    const g = generate(String(values.from))
    await new Promise((r) => setTimeout(r, 30)) // network/ClickHouse latency stand-in
    if (/GROUP BY sid/.test(sql)) return g.sessions
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] || 100)
    const [sid, ts, uuid] = [String(values.sid ?? ''), String(values.ts ?? ''), String(values.uuid ?? '')]
    const start = g.events.findIndex((e) => after(e, sid, ts, uuid)), from = start < 0 ? g.events.length : start
    if (sql.includes('{end_sid}')) {
        const out: Ev[] = []
        for (let i = from; i < g.events.length && out.length < limit && notAfter(g.events[i], String(values.end_sid), String(values.end_ts), String(values.end_uuid)); i++) out.push(g.events[i])
        return out.reverse() as never // unsorted, as ClickHouse may return them
    }
    return g.events.slice(from, from + limit).map(({ sid, ts, event_uuid }) => ({ sid, ts, event_uuid }))
}

const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const send = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    if (req.method === 'GET' && req.url === '/stats') return send(200, { queries })
    if (req.method === 'POST' && /\/api\/(?:projects|environments)\/[^/]+\/query\/?$/.test(req.url || '')) {
        try {
            const q = JSON.parse(body).query || {}
            const rows = q.kind === 'HogQLQuery' ? await fakePosthog(String(q.query || ''), q.values || {}) : []
            const columns = rows.length ? Object.keys(rows[0]) : []
            return send(200, { columns, results: rows.map((r) => columns.map((c) => (r as Record<string, unknown>)[c])) })
        } catch (e) { return send(500, { detail: String((e as Error).message) }) }
    }
    send(404, { detail: 'not in the stress stand-in' })
})
server.listen(PORT, '127.0.0.1', () => console.log('stand-in PostHog ready ' + PORT))
