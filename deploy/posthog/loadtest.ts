// Load test for a self-hosted PostHog. It sends browser-like traffic to a separate "Load test" project,
// watches Kafka lag and the containers while it runs, then checks that nothing was lost:
//   - every accepted event is in ClickHouse,
//   - the GeoIP transformation filled in the country,
//   - the webhook destination delivered every "loadtest_purchase" event (PostHog's own success count),
//   - no transformation or destination failed and no container restarted.
//
//   tsx deploy/posthog/loadtest.ts --rate 200 --minutes 10 --label after
//
// Settings (environment or .secrets.env):
//   POSTHOG_DIR          the PostHog install (default /opt/posthog); the script runs docker compose there
//   POSTHOG_HOST         where to send events (default http://localhost)
//   POSTHOG_ADMIN_EMAIL / POSTHOG_ADMIN_PASSWORD   used once to create the webhook destination
//   LOADTEST_WEBHOOK_URL where the test destination sends each purchase. PostHog refuses private addresses,
//                        so it must be a public one the containers can reach. Default: the triage service's
//                        /healthz (SERVICE_PUBLIC_URL), which answers 200 to anything and stores nothing.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import { config, ROOT } from '../../src/core/config.ts'

const sh = promisify(execFile)
const { values: opt } = parseArgs({
    options: {
        rate: { type: 'string', default: '200' },
        minutes: { type: 'string', default: '5' },
        label: { type: 'string', default: 'run' },
        users: { type: 'string', default: '20000' },
        'drain-minutes': { type: 'string', default: '15' },
        'max-in-flight': { type: 'string', default: '512' },
    },
})
const RATE = Number(opt.rate)
const SECONDS = Number(opt.minutes) * 60
const USERS = Number(opt.users)
const MAX_IN_FLIGHT = Number(opt['max-in-flight'])
const POSTHOG_DIR = process.env.POSTHOG_DIR || '/opt/posthog'
const HOST = config.posthog.host
const WEBHOOK_URL = process.env.LOADTEST_WEBHOOK_URL || `${config.service.publicUrl}/healthz`
const RUN = `${opt.label}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const compose = async (args: string[], input?: string, timeout = 60_000): Promise<string> => {
    const p = sh('docker', ['compose', ...args], { cwd: POSTHOG_DIR, maxBuffer: 64 << 20, timeout })
    if (input !== undefined) {
        p.child.stdin!.write(input)
        p.child.stdin!.end()
    }
    return (await p).stdout
}
const ch = async (sql: string): Promise<string> => (await compose(['exec', '-T', 'clickhouse', 'clickhouse-client', '-d', 'posthog', '-q', sql], undefined, 120_000)).trim()
const pg = async (sql: string): Promise<string> => (await compose(['exec', '-T', 'db', 'psql', '-U', 'posthog', '-d', 'posthog', '-Atc', sql])).trim()

// ---------------------------------------------------------------------------------------------
// 1. The project and its webhook destination
// ---------------------------------------------------------------------------------------------
async function ensureProject(): Promise<{ id: number; token: string }> {
    const py = `
import json
from posthog.models import Team, User, Organization
team = Team.objects.filter(name="Load test").first()
if not team:
    user = User.objects.filter(email=${JSON.stringify(config.posthog.adminEmail || '')}).first() or User.objects.order_by("id").first()
    team = Team.objects.create_with_data(organization=user.organization, name="Load test", initiating_user=user)
print("LT" + json.dumps({"id": team.id, "token": team.api_token}))
`
    const out = await compose(['exec', '-T', 'web', 'python', 'manage.py', 'shell'], py, 180_000)
    const line = out.split('\n').find((l) => l.startsWith('LT{'))
    if (!line) throw new Error(`could not create the Load test project: ${out.slice(-500)}`)
    return JSON.parse(line.slice(2))
}

async function login(): Promise<{ cookie: string; csrf: string }> {
    const res = await fetch(`${HOST}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: config.posthog.adminEmail, password: config.posthog.adminPassword }),
        redirect: 'manual',
    })
    if (!res.ok) throw new Error(`PostHog login → ${res.status}. Set POSTHOG_ADMIN_EMAIL and POSTHOG_ADMIN_PASSWORD.`)
    const jar = res.headers.getSetCookie().map((c) => c.split(';')[0])
    const csrf = jar.find((c) => c.startsWith('posthog_csrftoken='))?.split('=')[1] || ''
    return { cookie: jar.join('; '), csrf }
}

async function ensureDestination(teamId: number, url: string): Promise<string> {
    const s = await login()
    const api = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${HOST}/api/environments/${teamId}${path}`, {
            method,
            headers: { cookie: s.cookie, 'x-csrftoken': s.csrf, referer: `${HOST}/`, 'content-type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
        return JSON.parse(text)
    }
    const fn = {
        type: 'destination',
        name: `Load test webhook ${RUN}`,
        template_id: 'template-webhook',
        enabled: true,
        inputs: {
            url: { value: url },
            method: { value: 'POST' },
            body: { value: { uuid: '{event.uuid}', event: '{event.event}', run: '{event.properties.lt_run}', amount: '{event.properties.amount}' } },
            headers: { value: { 'Content-Type': 'application/json' } },
        },
        filters: { events: [{ id: 'loadtest_purchase', type: 'events', name: 'loadtest_purchase', order: 0 }] },
    }
    // One destination per run, so jobs left over from an earlier run are not counted as this run's deliveries.
    // Earlier runs' destinations are switched off; their leftover jobs are then skipped.
    const list = await api('GET', '/hog_functions/?type=destination&limit=200')
    for (const old of list.results as { id: string; name: string; enabled: boolean }[]) {
        if (old.name.startsWith('Load test webhook') && old.enabled) await api('PATCH', `/hog_functions/${old.id}/`, { enabled: false })
    }
    const saved = await api('POST', '/hog_functions/', fn)
    return saved.id
}

// ---------------------------------------------------------------------------------------------
// 3. Browser-like traffic
// ---------------------------------------------------------------------------------------------
let seed = 12345
const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 1_000_000) / 1_000_000
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
// Public addresses from the GeoLite2 test ranges and well-known resolvers, so GeoIP has something to find.
const IPS = ['81.2.69.142', '2.125.160.216', '216.160.83.56', '89.160.20.112', '67.43.156.1', '175.16.199.1', '8.8.8.8', '1.1.1.1', '202.196.224.1', '149.101.100.1']
const PATHS = ['/dashboard', '/invoices', '/invoices', '/invoices/new', '/clients', '/clients', '/reports/revenue', '/settings']
const BROWSERS = [
    ['Chrome', 'Mac OS X', 'Desktop'],
    ['Chrome', 'Windows', 'Desktop'],
    ['Safari', 'iOS', 'Mobile'],
    ['Firefox', 'Windows', 'Desktop'],
    ['Edge', 'Windows', 'Desktop'],
] as const
type User = { id: string; client: string; session: string; seen: number; ip: string; ua: (typeof BROWSERS)[number] }
const users: User[] = Array.from({ length: USERS }, (_, i) => ({
    id: `lt-user-${i}@client${i % 400}.example`,
    client: `client-${i % 400}`,
    session: randomUUID(),
    seen: 0,
    ip: IPS[i % IPS.length],
    ua: BROWSERS[i % BROWSERS.length],
}))
const sent = { events: 0, purchases: 0, exceptions: 0, accepted: 0, acceptedPurchases: 0, acceptedExceptions: 0 }

function event(token: string): Record<string, unknown> {
    const r = rnd()
    // One visit in ten is a new anonymous visitor who signs in on the first event (a person merge).
    if (r < 0.02) {
        const u = pick(users)
        return base(token, u, '$identify', { $anon_distinct_id: `anon-${randomUUID()}`, $set: { email: u.id, client_id: u.client, plan: pick(['starter', 'growth', 'enterprise']) } })
    }
    const u = pick(users)
    if (++u.seen % 40 === 0) u.session = randomUUID()
    const path = pick(PATHS)
    if (r < 0.45) return base(token, u, '$pageview', { $pathname: path, $current_url: `https://portal.example.com${path}`, title: path.slice(1) })
    if (r < 0.75)
        return base(token, u, '$autocapture', {
            $event_type: 'click',
            $pathname: path,
            $current_url: `https://portal.example.com${path}`,
            $elements_chain: `button.btn:text="${pick(['Save', 'Send', 'Export', 'Filter'])}"nth-child="1"nth-of-type="1"`,
        })
    if (r < 0.8) return base(token, u, '$pageleave', { $pathname: path, $current_url: `https://portal.example.com${path}` })
    if (r < 0.85) {
        sent.purchases++
        return base(token, u, 'loadtest_purchase', { amount: Math.round(rnd() * 50000) / 100, currency: pick(['EUR', 'GBP', 'USD']) })
    }
    if (r < 0.855) {
        sent.exceptions++
        return base(token, u, '$exception', {
            $exception_list: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'toFixed')", mechanism: { handled: false, synthetic: false } }],
            $pathname: path,
        })
    }
    return base(token, u, pick(['invoice_viewed', 'client_filter_applied', 'report_exported', 'invoice_sent']), { $pathname: path })
}
function base(token: string, u: User, name: string, props: Record<string, unknown>) {
    return {
        event: name,
        distinct_id: u.id,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        properties: {
            token,
            $session_id: u.session,
            $window_id: u.session,
            $lib: 'web',
            $lib_version: '1.300.0',
            $browser: u.ua[0],
            $os: u.ua[1],
            $device_type: u.ua[2],
            $host: 'portal.example.com',
            $screen_width: 1920,
            $screen_height: 1080,
            $ip: u.ip,
            client_id: u.client,
            app_version: '26.10.0',
            lt_run: RUN,
            ...props,
        },
    }
}

type Sample = { t: number; lag: Record<string, number>; cpu: Record<string, number>; mem: Record<string, number> }
const http = { ok: 0, failed: 0, byStatus: {} as Record<string, number>, latencies: [] as number[], dropped: 0 }
let inFlight = 0

async function send(token: string, batch: Record<string, unknown>[]) {
    const counts = { events: batch.length, purchases: 0, exceptions: 0 }
    for (const e of batch) {
        if (e.event === 'loadtest_purchase') counts.purchases++
        if (e.event === '$exception') counts.exceptions++
    }
    const t0 = performance.now()
    inFlight++
    try {
        // Like posthog-js: single events to /i/v0/e/, bigger flushes to /batch/.
        const res =
            batch.length === 1
                ? await fetch(`${HOST}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch[0]), signal: AbortSignal.timeout(30_000) })
                : await fetch(`${HOST}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: token, batch }), signal: AbortSignal.timeout(30_000) })
        await res.arrayBuffer()
        http.byStatus[res.status] = (http.byStatus[res.status] || 0) + 1
        if (res.ok) {
            http.ok++
            sent.accepted += counts.events
            sent.acceptedPurchases += counts.purchases
            sent.acceptedExceptions += counts.exceptions
        } else http.failed++
    } catch (e) {
        http.failed++
        const k = (e as Error).name
        http.byStatus[k] = (http.byStatus[k] || 0) + 1
    } finally {
        inFlight--
        http.latencies.push(performance.now() - t0)
    }
}

async function generate(token: string) {
    const start = performance.now()
    const perSecond: number[] = []
    let lastSecond = 0
    while (true) {
        const elapsed = (performance.now() - start) / 1000
        if (elapsed >= SECONDS) break
        let due = Math.floor(elapsed * RATE) - sent.events
        while (due > 0) {
            const size = rnd() < 0.3 ? 1 : 2 + Math.floor(rnd() * 19)
            const batch = Array.from({ length: Math.min(size, due) }, () => event(token))
            sent.events += batch.length
            due -= batch.length
            if (inFlight >= MAX_IN_FLIGHT) {
                http.dropped += batch.length // PostHog is not keeping up; count it rather than queue forever.
                continue
            }
            void send(token, batch)
        }
        const s = Math.floor(elapsed)
        if (s !== lastSecond) {
            perSecond.push(sent.accepted)
            lastSecond = s
            if (s % 30 === 0) log(`${s}s: sent ${sent.events}, accepted ${sent.accepted}, in flight ${inFlight}, failed requests ${http.failed}`)
        }
        await new Promise((r) => setTimeout(r, 20))
    }
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 100))
    return (performance.now() - start) / 1000
}

// ---------------------------------------------------------------------------------------------
// 4. Watching Kafka and the containers
// ---------------------------------------------------------------------------------------------
async function kafkaLag(): Promise<Record<string, number>> {
    const groups = (await compose(['exec', '-T', 'kafka', 'rpk', 'group', 'list']))
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split(/\s+/)[1])
        .filter(Boolean)
    const out = await compose(['exec', '-T', 'kafka', 'rpk', 'group', 'describe', ...groups])
    const lag: Record<string, number> = {}
    let group = ''
    for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/)
        if (cols[0] === 'GROUP') group = cols[1]
        else if (cols.length >= 6 && /^\d+$/.test(cols[1]) && /^\d+$/.test(cols[5])) {
            const key = `${group} ← ${cols[0]}`
            lag[key] = (lag[key] || 0) + Number(cols[5])
        }
    }
    return lag
}
async function containerStats(): Promise<{ cpu: Record<string, number>; mem: Record<string, number> }> {
    const out = (await sh('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'])).stdout
    const cpu: Record<string, number> = {}
    const mem: Record<string, number> = {}
    for (const line of out.trim().split('\n')) {
        const [name, c, m] = line.split('\t')
        const n = name.replace(/^posthog-/, '')
        cpu[n] = parseFloat(c)
        const [v, unit] = [parseFloat(m), m.split(' ')[0].replace(/[\d.]/g, '')]
        mem[n] = v * ({ B: 1 / 2 ** 20, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[unit] ?? 1)
    }
    return { cpu, mem }
}
async function restarts(): Promise<Record<string, string>> {
    const ids = (await compose(['ps', '-a', '-q'])).trim().split('\n').filter(Boolean)
    const out = (await sh('docker', ['inspect', '-f', '{{.Name}} {{.RestartCount}} {{.State.OOMKilled}} {{.State.Status}}', ...ids])).stdout
    return Object.fromEntries(out.trim().split('\n').map((l) => { const [n, ...r] = l.split(' '); return [n.replace(/^\/posthog-/, ''), r.join(' ')] }))
}
function watch(samples: Sample[]): () => Promise<void> {
    let stop = false
    const loop = (async () => {
        const t0 = Date.now()
        while (!stop) {
            try {
                const [lag, stats] = await Promise.all([kafkaLag(), containerStats()])
                samples.push({ t: Math.round((Date.now() - t0) / 1000), lag, ...stats })
            } catch (e) {
                log('watch:', (e as Error).message.slice(0, 200))
            }
            await new Promise((r) => setTimeout(r, 5000))
        }
    })()
    return async () => {
        stop = true
        await loop
    }
}

// ---------------------------------------------------------------------------------------------
// 5. Run, drain, verify, report
// ---------------------------------------------------------------------------------------------
const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : 0
}
const countRun = async (teamId: number, where = '1') =>
    Number(await ch(`SELECT uniqExact(uuid) FROM events WHERE team_id = ${teamId} AND timestamp > now() - INTERVAL 1 DAY AND JSONExtractString(properties, 'lt_run') = '${RUN}' AND ${where}`))

/** All-time totals of each transformation's and destination's metrics in the project, keyed "function · kind · name". */
async function metricTotals(teamId: number): Promise<Record<string, number>> {
    const names = Object.fromEntries((await pg(`SELECT id, name FROM posthog_hogfunction WHERE team_id = ${teamId}`)).split('\n').map((l) => l.split('|')))
    const rows = await ch(`SELECT app_source_id, metric_kind, metric_name, sum(count) FROM app_metrics2 WHERE team_id = ${teamId} GROUP BY ALL FORMAT TSV`)
    const out: Record<string, number> = {}
    for (const l of rows.split('\n').filter(Boolean)) {
        const [id, kind, name, n] = l.split('\t')
        out[`${names[id] || id} · ${kind} · ${name}`] = Number(n)
    }
    return out
}
const diff = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - (a[k] || 0)]).filter(([, v]) => v !== 0))
const HOOK = `Load test webhook ${RUN}`
const delivered = (m: Record<string, number>) => m[`${HOOK} · success · succeeded`] || 0

async function main() {
    log(`Run ${RUN}: ${RATE} events/s for ${SECONDS}s against ${HOST}`)
    const project = await ensureProject()
    const fnId = await ensureDestination(project.id, WEBHOOK_URL)
    log(`Project ${project.id}, destination ${fnId} → ${WEBHOOK_URL}`)

    // Prove the whole path works before loading it: one purchase must reach ClickHouse and the webhook.
    const start0 = await metricTotals(project.id)
    const probe = event(project.token)
    Object.assign(probe, { event: 'loadtest_purchase' })
    ;(probe.properties as Record<string, unknown>).lt_run = `${RUN}-probe`
    const probeStart = Date.now()
    let probeSeconds: number | null = null
    while (delivered(await metricTotals(project.id)) <= delivered(start0)) {
        if (Date.now() - probeStart > 240_000) break
        if ((Date.now() - probeStart) % 30_000 < 3000) await send(project.token, [probe])
        await new Promise((r) => setTimeout(r, 3000))
    }
    if (Date.now() - probeStart <= 240_000) probeSeconds = Math.round((Date.now() - probeStart) / 1000)
    log(probeSeconds === null ? `WARNING: a single purchase did not reach ${WEBHOOK_URL} in 4 minutes. Running the load anyway.` : `Probe delivered in ${probeSeconds}s`)
    await new Promise((r) => setTimeout(r, 10_000)) // let the probe's metrics settle
    Object.assign(sent, { events: 0, purchases: 0, exceptions: 0, accepted: 0, acceptedPurchases: 0, acceptedExceptions: 0 })
    Object.assign(http, { ok: 0, failed: 0, byStatus: {}, latencies: [], dropped: 0 })

    const before = await restarts()
    const metricsBefore = await metricTotals(project.id)
    const samples: Sample[] = []
    const stopWatch = watch(samples)
    const fromTime = new Date(Date.now() - 5000).toISOString().replace('T', ' ').slice(0, 19)
    const took = await generate(project.token)
    log(`Load done in ${Math.round(took)}s: ${sent.accepted} of ${sent.events} events accepted. Waiting for the pipeline to catch up…`)

    const drainStart = Date.now()
    let landed = 0
    let hooks = 0
    let stableSince = Date.now()
    while (Date.now() - drainStart < Number(opt['drain-minutes']) * 60_000) {
        const [n, m] = await Promise.all([countRun(project.id), metricTotals(project.id)])
        const h = delivered(m) - delivered(metricsBefore)
        if (n !== landed || h !== hooks) stableSince = Date.now()
        landed = n
        hooks = h
        if (landed >= sent.accepted && hooks >= sent.acceptedPurchases) break
        if (Date.now() - stableSince > 120_000) break // nothing new for two minutes
        await new Promise((r) => setTimeout(r, 5000))
    }
    const drainSeconds = Math.round((Date.now() - drainStart) / 1000)
    await new Promise((r) => setTimeout(r, 20_000)) // let metrics flush
    await stopWatch()
    const after = await restarts()

    const geo = await countRun(project.id, "JSONExtractString(properties, '$geoip_country_code') != ''")
    const exceptions = await countRun(project.id, "event = '$exception'")
    const fnMetrics = diff(metricsBefore, await metricTotals(project.id))
    hooks = delivered(fnMetrics)
    const failures = Object.entries(fnMetrics).filter(([k]) => / · failure · |fail|error|dropped|disabled|degraded/.test(k))
    const warnings = await ch(
        `SELECT type, count() FROM ingestion_warnings WHERE team_id = ${project.id} AND timestamp >= '${fromTime}' GROUP BY type ORDER BY 2 DESC LIMIT 10 FORMAT TSV`
    ).catch(() => '')
    const persons = Number(await pg(`SELECT count(*) FROM posthog_person WHERE team_id = ${project.id}`))

    const maxLag: Record<string, number> = {}
    for (const s of samples) for (const [k, v] of Object.entries(s.lag)) maxLag[k] = Math.max(maxLag[k] || 0, v)
    const peak = (field: 'cpu' | 'mem') => {
        const m: Record<string, number> = {}
        for (const s of samples) for (const [k, v] of Object.entries(s[field])) m[k] = Math.max(m[k] || 0, v)
        return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, Math.round(v)]))
    }
    const restarted = Object.entries(after).filter(([k, v]) => before[k] !== v).map(([k, v]) => `${k}: ${before[k] ?? 'new'} → ${v}`)

    const report = {
        run: RUN,
        target_rate: RATE,
        seconds: Math.round(took),
        sent: sent.events,
        accepted: sent.accepted,
        achieved_rate: Math.round(sent.accepted / took),
        dropped_by_client_backlog: http.dropped,
        http: { ok: http.ok, failed: http.failed, by_status: http.byStatus, latency_ms: { p50: pct(http.latencies, 50), p95: pct(http.latencies, 95), p99: pct(http.latencies, 99), max: pct(http.latencies, 100) } },
        in_clickhouse: landed,
        missing: sent.accepted - landed,
        drain_seconds: drainSeconds,
        geoip_filled: `${geo} of ${landed - exceptions}`,
        exceptions: `${exceptions} of ${sent.acceptedExceptions}`,
        webhook: { probe_delivered_after_s: probeSeconds, purchases_accepted: sent.acceptedPurchases, delivered: hooks },
        persons_in_project: persons,
        function_metrics: fnMetrics,
        function_failures: Object.fromEntries(failures),
        ingestion_warnings: warnings,
        container_restarts: restarted,
        max_kafka_lag: Object.fromEntries(Object.entries(maxLag).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 12)),
        peak_cpu_percent: peak('cpu'),
        peak_mem_mib: peak('mem'),
    }
    const dir = join(ROOT, 'run/loadtest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${RUN}.json`), JSON.stringify({ ...report, samples }, null, 2))
    console.log(JSON.stringify(report, null, 2))
    const ok = report.missing === 0 && report.webhook.delivered === report.webhook.purchases_accepted && failures.length === 0 && restarted.length === 0 && http.failed === 0
    log(ok ? 'PASS: nothing lost, no failures, no restarts' : 'FAIL: see the report above')
    process.exit(ok ? 0 : 1)
}

main().catch((e) => {
    console.error(e)
    process.exit(2)
})
