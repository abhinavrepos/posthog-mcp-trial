// Stress test: task-history ingestion at Reval volume and heavy use of the rescue queue, task map, flow time
// and status changes, all at once, against a real Lens HTTP server in this process (as in production, where
// ingestion and requests share one Node process). Load comes from a separate process (stress-load.ts).
//
//   npx tsx scripts/stress-rescue.ts [days=60] [clients=50] [sessionsPerClientDay=55]
//
// Events come from a generator shaped like Reval's (PageView/Event, dialogs, Save, toast/messagebox replies,
// about 40 events a session: ~110,000 a day at the defaults), served through the same query protocol the
// ingestion uses with PostHog (sessions, sorted key pages, unsorted rows), so ingestion runs its real code.
// Older history (days+1 .. 365) is seeded as daily rollups. Planted: client C01 stops task 00 in the last
// 14 days; client C02's task 01 takes 60% longer in the last 14 days. Uses temporary databases only.
// Page loads need a PostHog sign-in: set STRESS_EMAIL and STRESS_PASSWORD_FILE (optional).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const DAYS = Number(process.argv[2] || 60), CLIENTS = Number(process.argv[3] || 50), PER = Number(process.argv[4] || 55), TASKS = 40
const dir = mkdtempSync(join(tmpdir(), 'lens-stress-'))
const PORT = 18097
Object.assign(process.env, {
    TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json',
    SERVICE_PORT: String(PORT), SERVICE_PUBLIC_URL: `http://127.0.0.1:${PORT}`, MCP_TOKEN: 'stress-shared-' + Date.now(),
    CLIP_LINK_SECRET: 'stress-secret-0123456789abcdef', TASKS_INTERVAL_MINUTES: '1440', TASKS_BACKFILL_DAYS_PER_RUN: '0',
    LENS_PREWARM_MINUTES: '0', FEATURE_SURVEYS: 'off', LENS_HTTP_COMPRESSION: process.env.LENS_HTTP_COMPRESSION || 'on',
})
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

// ---------------------------------------------------------------- start Lens with this source, seed older history
const tasks = await import('../src/core/tasks.ts')
tasks.setTaskQuery(fakePosthog)
{
    const hist = JSON.stringify(Array.from({ length: 21 }, (_, i) => (i === 4 ? 6 : i === 5 ? 3 : i === 6 ? 1 : 0)))
    const row = tasks.tasksDb.prepare('INSERT OR REPLACE INTO task_daily VALUES (?,?,?,?,?,?,?,?,?)')
    const users = tasks.tasksDb.prepare('INSERT OR IGNORE INTO task_users_daily VALUES (?,?,?,?)')
    const ingest = tasks.tasksDb.prepare('INSERT OR REPLACE INTO task_ingest VALUES (?,?,?,?,0,1,?)')
    const names = tasks.tasksDb.prepare('INSERT OR REPLACE INTO client_names VALUES (?,?)')
    tasks.tasksDb.exec('BEGIN')
    for (let c = 0; c < CLIENTS; c++) names.run(clientId(c), `Client ${pad(c + 1)}`)
    for (let i = DAYS + 1; i <= 365; i++) {
        const d = dayStr(i); ingest.run(d, CLIENTS * PER, CLIENTS * PER * 40, CLIENTS * TASKS * 3, new Date().toISOString())
        for (let c = 0; c < CLIENTS; c++) for (let t = 0; t < TASKS; t++) {
            row.run(d, clientId(c), `t_DlgTask${pad(t)}`, 10, 9, 1, 0, 3, hist)
            users.run(d, clientId(c), `t_DlgTask${pad(t)}`, `ENV|01|${clientId(c)}|user${(t % 6) + 1}`)
        }
    }
    tasks.tasksDb.exec('COMMIT'); tasks.forgetAnswers()
}
const columnsOk = tasks.tasksDb.prepare("SELECT count(*) AS n FROM task_daily").get() as { n: number }
console.log(JSON.stringify({ msg: 'seeded older history', daily_rows: columnsOk.n, days: 365 - DAYS }))
await import('../src/service/server.ts')
await new Promise((r) => setTimeout(r, 1500))

// people and keys
const access = await import('../src/service/access.ts')
const admins = Array.from({ length: 5 }, (_, i) => `admin${i + 1}@stress.example`), viewers = Array.from({ length: 20 }, (_, i) => `pm${i + 1}@stress.example`)
for (const a of admins) access.setPerson(a, 'admin', 'stress')
for (const v of viewers) { access.setPerson(v, 'watch', 'stress'); access.setDashboardRole(v, 'view', 'stress') }
const tokens = { admins: admins.map((e) => access.createMcpToken({ email: e, posthog_admin: false }, 'stress').token), viewers: viewers.map((e) => access.createMcpToken({ email: e, posthog_admin: false }, 'stress').token) }
writeFileSync(join(dir, 'tokens.json'), JSON.stringify(tokens))
// Page loads: one real sign-in through Lens (PostHog checks the password; the session is cached a minute).
let cookie = ''
if (process.env.STRESS_EMAIL && process.env.STRESS_PASSWORD_FILE) {
    access.setPerson(process.env.STRESS_EMAIL, 'admin', 'stress')
    const r = await fetch(`http://127.0.0.1:${PORT}/replays/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-clip-page': '1' },
        body: JSON.stringify({ email: process.env.STRESS_EMAIL, password: readFileSync(process.env.STRESS_PASSWORD_FILE, 'utf8').trim() }) })
    cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    console.log(JSON.stringify({ msg: 'page sign-in', status: r.status, cookie: cookie ? 'yes' : 'no' }))
}

// ---------------------------------------------------------------- run: backfill while the loader hammers the server
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable()
let rssPeak = 0; const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss) }, 200)
const loader = spawn(process.execPath, ['--import', 'tsx', 'scripts/stress-load.ts', `http://127.0.0.1:${PORT}`, join(dir, 'tokens.json'), join(dir, 'load.json'), String(CLIENTS)],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, STRESS_COOKIE: cookie } })
const perDay: { day: string; ms: number; events: number; attempts: number }[] = []
const t0 = Date.now()
for (let i = DAYS; i >= 1; i--) {
    const d = dayStr(i), s = Date.now()
    await tasks.ingestDay(d)
    const info = tasks.tasksDb.prepare('SELECT events, attempts FROM task_ingest WHERE day = ?').get(d) as { events: number; attempts: number }
    perDay.push({ day: d, ms: Date.now() - s, events: info.events, attempts: info.attempts })
    if ((DAYS - i) % 10 === 0) console.log(JSON.stringify({ msg: 'ingested', day: d, ms: Date.now() - s, events: info.events, attempts: info.attempts, loop_max_ms: Math.round(loop.max / 1e6) }))
}
const ingestMs = Date.now() - t0
const loopDuring = { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 }
writeFileSync(join(dir, 'ingest-done'), '1') // tells the loader to run its final rounds
await new Promise<void>((r) => loader.on('exit', () => r()))
clearInterval(rssTimer); loop.disable()

// ---------------------------------------------------------------- checks
const load = JSON.parse(readFileSync(join(dir, 'load.json'), 'utf8'))
const { rescueQueue } = await import('../src/core/rescue.ts')
const db = await import('../src/core/db.ts')
const q14 = await rescueQueue({ window: { from: dayStr(14), to: dayStr(1) } })
const c01 = q14.clients.find((c) => c.client === 'C01'), c02 = q14.clients.find((c) => c.client === 'C02')
const audits = (db.one('SELECT count(*) AS n FROM audit WHERE action = ?', 'rescue.updated') as { n: number }).n
const rows = (db.one('SELECT count(*) AS n FROM rescue_actions') as { n: number }).n
const events = perDay.reduce((s, d) => s + d.events, 0), ms = perDay.map((d) => d.ms).sort((a, b) => a - b)
const summary = {
    ingestion: { days: DAYS, events, attempts: perDay.reduce((s, d) => s + d.attempts, 0), total_s: Math.round(ingestMs / 1000), per_day_ms: { p50: ms[Math.floor(ms.length / 2)], max: ms.at(-1) }, events_per_s: Math.round(events / (ingestMs / 1000)), fake_posthog_queries: queries },
    event_loop_during_ms: Object.fromEntries(Object.entries(loopDuring).map(([k, v]) => [k, Math.round(v)])),
    lens_rss_peak_mb: Math.round(rssPeak / 1048576),
    load,
    consistency: { status_writes_ok: load.writes_ok, audit_rows: audits, audit_matches_writes: audits === load.writes_ok, clients_with_status: rows },
    planted: { C01: c01 ? `${c01.level}: ${c01.reasons[0]?.text}` : 'NOT FLAGGED', C02: c02 ? `${c02.level}: ${c02.reasons.map((r) => r.kind).join(',')}` : 'NOT FLAGGED', flagged_total: q14.clients.length },
}
console.log('\nSUMMARY ' + JSON.stringify(summary, null, 2))
writeFileSync(process.env.STRESS_OUT || join(tmpdir(), 'lens-stress-summary.json'), JSON.stringify(summary, null, 2))
rmSync(dir, { recursive: true, force: true })
process.exit(0)
