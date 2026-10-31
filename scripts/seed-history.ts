// Backfills Acme Portal usage history into PostHog so usage and trend questions have real data.
//
//   pnpm seed                  # first run: 60 days. Later runs: only the gap since the last run.
//   pnpm seed --days 60 --regression-days-ago 5
//
// Release 2.14.0 rolls out on the regression date. From then on, EU multi-currency clients on
// 2.14.0 fail some PDF exports. Exceptions copy the stack of a live exception (from a recorded
// session), so PostHog error tracking groups old and new occurrences into one issue.
// State (the regression date and how far history reaches) lives in run/seed-state.json.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { CLIENTS, hitsExportBug, type DemoClient } from '../src/core/catalog.ts'
import { config, ROOT } from '../src/core/config.ts'
import { hogql } from '../src/core/posthog.ts'

const { values } = parseArgs({
    options: {
        days: { type: 'string', default: '60' },
        'regression-days-ago': { type: 'string', default: '5' },
        'dry-run': { type: 'boolean', default: false },
        reset: { type: 'boolean', default: false },
    },
})

const STATE_FILE = join(ROOT, 'run/seed-state.json')
interface SeedState {
    regression_start: string
    covered_from: string
    covered_until: string
}
const DAY = 86_400_000
const now = Date.now()
const stateIn: SeedState | undefined = !values.reset && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : undefined
const regressionStart = stateIn ? Date.parse(stateIn.regression_start) : now - Number(values['regression-days-ago']) * DAY
const from = stateIn ? Date.parse(stateIn.covered_until) : now - Number(values.days) * DAY
const until = now - 30 * 60_000 // leave the last half hour to live sessions

// Seeded random, so a re-run makes the same history.
let seed = 1234567 ^ Math.floor(from / DAY)
const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 1_000_000) / 1_000_000
}
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]

const SITE = process.env.DEMO_APP_URL || 'http://localhost:3000'
const PLAN_ACTIVITY = { enterprise: 0.55, growth: 0.4, starter: 0.25 } as const
// Tuesday to Thursday are busiest; weekends are quiet.
const WEEKDAY_FACTOR = [0.15, 0.9, 1.15, 1.25, 1.2, 0.85, 0.12]

async function liveException(): Promise<{ list: unknown; types: unknown; values: unknown } | undefined> {
    const rows = await hogql(
        `SELECT properties.$exception_list AS list, properties.$exception_types AS types, properties.$exception_values AS vals
         FROM events WHERE event = '$exception' AND toString(properties.$pathname) = '/invoices' AND timestamp > now() - INTERVAL 30 DAY
         ORDER BY timestamp DESC LIMIT 1`
    )
    if (!rows[0]) return undefined
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v)
    return { list: parse(rows[0].list), types: parse(rows[0].types), values: parse(rows[0].vals) }
}

type Ev = { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown>; uuid: string }

const EXPORT_CHAIN = 'button.btn:attr__class="btn"attr__data-attr="invoice-export-pdf"attr__id="export-pdf"nth-child="2"nth-of-type="1"text="Export PDF";div.toolbar:attr__class="toolbar"nth-child="2"nth-of-type="1"'

function versionAt(client: DemoClient, t: number): string {
    return client.version === '2.14.0' && t >= regressionStart ? '2.14.0' : '2.13.2'
}

function sessionEvents(client: DemoClient, start: number, exception: Awaited<ReturnType<typeof liveException>>): Ev[] {
    const user = pick(client.users)
    const sid = randomUUID()
    const wid = randomUUID()
    const version = versionAt(client, start)
    const evs: Ev[] = []
    let t = start
    const base = () => ({
        $session_id: sid,
        $window_id: wid,
        $lib: 'web',
        $browser: pick(['Chrome', 'Chrome', 'Edge', 'Safari']),
        $os: pick(['Mac OS X', 'Windows']),
        $host: new URL(SITE).host,
        client_id: client.id,
        client_name: client.name,
        client_region: client.region,
        client_plan: client.plan,
        app_version: version,
        $groups: { company: client.id },
    })
    const add = (event: string, path: string, extra: Record<string, unknown> = {}) => {
        evs.push({
            event,
            distinct_id: user.email,
            timestamp: new Date(t).toISOString(),
            uuid: randomUUID(),
            properties: { ...base(), $pathname: path, $current_url: SITE + path, ...extra },
        })
        t += 2000 + rnd() * 20_000
    }

    add('$pageview', '/dashboard', { $set: { email: user.email, name: user.name, role: user.role } })
    const screens = ['/invoices', '/invoices', '/invoices', '/reports/revenue', '/reports/revenue', '/clients', '/settings']
    const visits = 1 + Math.floor(rnd() * 3)
    for (let v = 0; v < visits; v++) {
        const path = pick(screens)
        add('$pageview', path)
        if (path === '/invoices' && rnd() < 0.6) {
            add('invoice_export_started', path, { invoice_count: 1 + Math.floor(rnd() * 12) })
            if (hitsExportBug(client) && version === '2.14.0' && rnd() < 0.5) {
                if (exception) {
                    add('$exception', path, { $exception_list: exception.list, $exception_types: exception.types, $exception_values: exception.values, $exception_level: 'error' })
                }
                if (rnd() < 0.6) add('$rageclick', path, { $elements_chain: EXPORT_CHAIN, $event_type: 'click' })
            } else {
                add('invoice_export_completed', path, { invoice_count: 1 + Math.floor(rnd() * 12) })
            }
        }
        if (path === '/reports/revenue') add('revenue_report_loaded', path, { range: 'qtd', total: Math.round(rnd() * 200_000) })
        if (path === '/settings' && rnd() < 0.3) add('settings_saved', path)
    }
    return evs
}

async function send(batch: Ev[]) {
    const res = await fetch(`${config.posthog.host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: config.posthog.projectToken, historical_migration: true, batch }),
    })
    if (!res.ok) throw new Error(`batch → ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

if (from >= until) {
    console.log('History is already up to date.')
    process.exit(0)
}
const exception = await liveException()
if (!exception) {
    console.warn('No live $exception on /invoices yet. Run `pnpm sessions` first, so backfilled errors group with real ones. Seeding without exceptions.')
}

const events: Ev[] = []
for (let day = Math.floor(from / DAY) * DAY; day < until; day += DAY) {
    const dow = new Date(day).getUTCDay()
    for (const client of CLIENTS) {
        const sessions = Math.round(client.users.length * PLAN_ACTIVITY[client.plan] * WEEKDAY_FACTOR[dow] * 2 * (0.6 + rnd() * 0.8))
        for (let s = 0; s < sessions; s++) {
            // Working hours, roughly in the client's region.
            const offset = { EU: -1, UK: 0, US: 5, APAC: -9 }[client.region]
            const hour = 8 + rnd() * 9 + offset
            const start = day + hour * 3_600_000 + rnd() * 3_600_000
            if (start < from || start > until) continue
            events.push(...sessionEvents(client, start, exception))
        }
    }
}
const exceptions = events.filter((e) => e.event === '$exception')
console.log(
    `${events.length} events from ${new Date(from).toISOString().slice(0, 10)} to ${new Date(until).toISOString().slice(0, 16)}; ` +
        `${exceptions.length} exceptions across ${new Set(exceptions.map((e) => e.properties.client_id)).size} clients since ${new Date(regressionStart).toISOString().slice(0, 10)}`
)
if (values['dry-run']) process.exit(0)

for (let i = 0; i < events.length; i += 500) {
    await send(events.slice(i, i + 500))
    process.stdout.write(`\rsent ${Math.min(events.length, i + 500)}/${events.length}`)
}
console.log()
mkdirSync(join(ROOT, 'run'), { recursive: true })
const stateOut: SeedState = {
    regression_start: new Date(regressionStart).toISOString(),
    covered_from: stateIn?.covered_from || new Date(from).toISOString(),
    covered_until: new Date(until).toISOString(),
}
writeFileSync(STATE_FILE, JSON.stringify(stateOut, null, 2) + '\n')
console.log(`State saved to ${STATE_FILE}`)
