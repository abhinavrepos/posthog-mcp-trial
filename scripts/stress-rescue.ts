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
const PORT = Number(process.env.STRESS_PORT) || 18097
Object.assign(process.env, {
    TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json',
    SERVICE_PORT: String(PORT), SERVICE_PUBLIC_URL: `http://127.0.0.1:${PORT}`, MCP_TOKEN: 'stress-shared-' + Date.now(),
    CLIP_LINK_SECRET: 'stress-secret-0123456789abcdef', TASKS_INTERVAL_MINUTES: '1440', TASKS_BACKFILL_DAYS_PER_RUN: '0',
    LENS_PREWARM_MINUTES: '0', FEATURE_SURVEYS: 'off', LENS_HTTP_COMPRESSION: process.env.LENS_HTTP_COMPRESSION || 'on',
    // The service ingests in a worker thread that queries PostHog over HTTP: a stand-in PostHog on the next port.
    POSTHOG_HOST: `http://127.0.0.1:${PORT + 1}`, POSTHOG_PUBLIC_HOST: `http://127.0.0.1:${PORT + 1}`, POSTHOG_PROJECT_ID: '1', POSTHOG_PERSONAL_API_KEY: 'stress-key',
    REPLAY_SIGNALS: 'off', WATCHLIST: 'off',
})
const DAY = 86_400_000
const dayStr = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10)
const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const clientId = (c: number) => `C${pad(c + 1)}`

// ---------------------------------------------------------------- the stand-in PostHog, in its own process
const posthog = spawn(process.execPath, ['--import', 'tsx', 'scripts/stress-posthog.ts', String(PORT + 1), String(CLIENTS), String(PER)], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise<void>((resolve, reject) => { posthog.stdout!.on('data', (d) => { if (/ready/.test(String(d))) resolve() }); posthog.once('exit', (c) => reject(new Error(`stand-in PostHog exited (${c})`))) })
process.on('exit', () => posthog.kill())
const posthogQueries = async () => ((await (await fetch(`http://127.0.0.1:${PORT + 1}/stats`)).json()) as { queries: number }).queries


// ---------------------------------------------------------------- start Lens with this source, seed older history
const tasks = await import('../src/core/tasks.ts')
// Ingestion queries the stand-in over HTTP, through the service's worker, as in production.
{
    const hist = JSON.stringify(Array.from({ length: 21 }, (_, i) => (i === 4 ? 6 : i === 5 ? 3 : i === 6 ? 1 : 0)))
    const row = tasks.tasksDb.prepare('INSERT OR REPLACE INTO task_daily VALUES (?,?,?,?,?,?,?,?,?)')
    const users = tasks.tasksDb.prepare('INSERT OR IGNORE INTO task_users_daily VALUES (?,?,?,?)')
    const ingest = tasks.tasksDb.prepare('INSERT OR REPLACE INTO task_ingest(day,sessions,events,attempts,truncated,seconds,done_at,finalized) VALUES (?,?,?,?,0,1,?,1)')
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
let failedRuns = 0
const t0 = Date.now()
for (let i = DAYS; i >= 1; i--) {
    const d = dayStr(i), s = Date.now()
    // The service's own scheduled run may hold the worker: wait for it, then ingest this day.
    let info: { events: number; attempts: number } | undefined
    for (let tries = 0; !info && tries < 600; tries++) {
        while (tasks.ingestStatus().running) await new Promise((r) => setTimeout(r, 200))
        // A failed day is reported and tried again, as the service's scheduler would.
        try { await tasks.ingestDay(d) } catch (e) { failedRuns++; console.log(JSON.stringify({ msg: 'ingest failed, retrying', day: d, error: String((e as Error).message) })); await new Promise((r) => setTimeout(r, 2000)) }
        info = tasks.tasksDb.prepare('SELECT events, attempts FROM task_ingest WHERE day = ?').get(d) as typeof info
        if (!info) await new Promise((r) => setTimeout(r, 200))
    }
    if (!info) throw new Error(`day ${d} was never ingested`)
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
// The last 14 finished days (yesterday is not final yet), as the product's own windows end.
const q14 = await rescueQueue({ window: { from: dayStr(15), to: dayStr(2) } })
const c01 = q14.clients.find((c) => c.client === 'C01'), c02 = q14.clients.find((c) => c.client === 'C02')
const audits = (db.one('SELECT count(*) AS n FROM audit WHERE action = ?', 'rescue.updated') as { n: number }).n
const rows = (db.one('SELECT count(*) AS n FROM rescue_actions') as { n: number }).n
const events = perDay.reduce((s, d) => s + d.events, 0), ms = perDay.map((d) => d.ms).sort((a, b) => a - b)
const summary = {
    ingestion: { days: DAYS, events, attempts: perDay.reduce((s, d) => s + d.attempts, 0), total_s: Math.round(ingestMs / 1000), per_day_ms: { p50: ms[Math.floor(ms.length / 2)], max: ms.at(-1) }, events_per_s: Math.round(events / (ingestMs / 1000)), fake_posthog_queries: await posthogQueries(), failed_runs_retried: failedRuns },
    event_loop_during_ms: Object.fromEntries(Object.entries(loopDuring).map(([k, v]) => [k, Math.round(v)])),
    lens_rss_peak_mb: Math.round(rssPeak / 1048576),
    load,
    consistency: { status_writes_ok: load.writes_ok, audit_rows: audits, audit_matches_writes: audits === load.writes_ok, clients_with_status: rows },
    planted: { C01: c01 ? `${c01.level}: ${c01.reasons[0]?.text}` : 'NOT FLAGGED', C02: c02 ? `${c02.level}: ${c02.reasons.map((r) => r.kind).join(',')}` : 'NOT FLAGGED', coverage: q14.coverage, flagged_total: q14.clients.length },
}
console.log('\nSUMMARY ' + JSON.stringify(summary, null, 2))
writeFileSync(process.env.STRESS_OUT || join(tmpdir(), 'lens-stress-summary.json'), JSON.stringify(summary, null, 2))
if (process.env.STRESS_KEEP) console.log(JSON.stringify({ msg: 'kept', dir })); else rmSync(dir, { recursive: true, force: true })
process.exit(0)
