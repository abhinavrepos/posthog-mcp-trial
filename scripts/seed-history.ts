// Backfills Acme Portal usage history into PostHog: a year of monthly releases (see
// src/core/release-plan.ts), so the release dashboard and the triage have real data.
//
//   pnpm seed                  # first run: from 2025-09-01. Later runs: only the gap since the last run.
//   pnpm seed --from 2025-09-01 --dry-run
//
// Each client takes each release a few days after it ships. From then on its users use the
// features that release added, and hit its rage clicks and errors until the fix ships. Release
// 26.10.0 went to half the clients on its release day; on it, EU multi-currency clients fail some
// PDF exports. Those exceptions copy the stack of a live exception (from a recorded session), so
// PostHog error tracking groups old and new occurrences into one issue.
// State (how far history reaches) lives in run/seed-state.json.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { ALL_CLIENTS, BUGGY_VERSION, hitsExportBug, type DemoClient, type DemoUser } from '../src/core/catalog.ts'
import { config, ROOT } from '../src/core/config.ts'
import { hogql } from '../src/core/posthog.ts'
import { activeSignals, appliesTo, releaseIndex, releaseTime, versionAt } from '../src/core/release-plan.ts'

const { values } = parseArgs({
    options: {
        from: { type: 'string', default: '2025-09-01' },
        'dry-run': { type: 'boolean', default: false },
        reset: { type: 'boolean', default: false },
    },
})

const STATE_FILE = join(ROOT, 'run/seed-state.json')
interface SeedState {
    covered_from: string
    covered_until: string
}
const DAY = 86_400_000
const now = Date.now()
const stateIn: SeedState | undefined = !values.reset && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : undefined
const from = stateIn ? Date.parse(stateIn.covered_until) : Date.parse(values.from + 'T00:00:00Z')
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
const CLIENTS_NAMED = new Set(ALL_CLIENTS.slice(0, 20).map((c) => c.id))
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

const chain = (text: string) => `button.btn:attr__class="btn"text="${text}";div.toolbar:attr__class="toolbar"nth-child="2"nth-of-type="1"`
const frameFile = (path: string) => `${SITE}/static/${path.split('/').filter(Boolean).join('-') || 'app'}.js`

function sessionEvents(client: DemoClient, start: number, exception: Awaited<ReturnType<typeof liveException>>): Ev[] {
    const user: DemoUser = pick(client.users)
    const sid = randomUUID()
    const wid = randomUUID()
    const version = versionAt(client, start)
    const signals = activeSignals(version).filter((x) => appliesTo(x, client, user.role))
    // Rage clicks and errors stop once the client is on the release that fixed them.
    const broken = (x: (typeof signals)[number]) => !x.until || releaseIndex(version) < releaseIndex(x.until)
    // New features catch on over the first three weeks.
    const ramp = (since: string) => Math.min(1, 0.3 + (0.7 * Math.max(0, start - releaseTime(since))) / (21 * DAY))
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
    for (const x of signals) if (x.screen === '/dashboard' && x.event && x.use && rnd() < x.use * ramp(x.since)) add(x.event, '/dashboard')
    const screens = ['/invoices', '/invoices', '/invoices', '/reports/revenue', '/reports/revenue', '/clients', '/clients', '/settings', '/dashboard']
    const visits = 1 + Math.floor(rnd() * 3)
    for (let v = 0; v < visits; v++) {
        const path = pick(screens)
        add('$pageview', path)
        for (const x of signals) {
            if (x.screen !== path) continue
            if (x.event && x.use && rnd() < x.use * ramp(x.since)) add(x.event, path)
            if (x.rage && broken(x) && rnd() < x.rage) add('$rageclick', path, { $elements_chain: chain(x.element || 'Button'), $event_type: 'click' })
            if (x.error && broken(x) && rnd() < x.error.rate) {
                const e = x.error
                add('$exception', path, {
                    $exception_list: [
                        {
                            type: e.type,
                            value: e.message,
                            mechanism: { handled: false, synthetic: false, type: 'onerror' },
                            stacktrace: {
                                type: 'raw',
                                frames: [
                                    { platform: 'web:javascript', filename: frameFile(path), function: e.fn, lineno: 212, colno: 18, in_app: true },
                                    { platform: 'web:javascript', filename: frameFile(path), function: 'render', lineno: 88, colno: 5, in_app: true },
                                ],
                            },
                        },
                    ],
                    $exception_types: [e.type],
                    $exception_values: [e.message],
                    $exception_level: 'error',
                })
            }
        }
        if (path === '/invoices' && rnd() < 0.6) {
            add('invoice_export_started', path, { invoice_count: 1 + Math.floor(rnd() * 12) })
            if (hitsExportBug(client) && version === BUGGY_VERSION && rnd() < 0.5) {
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
    for (const client of ALL_CLIENTS) {
        // About one session per active user every two working days; the named clients a bit more,
        // so their stories show up.
        const perUser = CLIENTS_NAMED.has(client.id) ? 1.2 : 0.42
        const sessions = Math.round(client.users.length * PLAN_ACTIVITY[client.plan] * WEEKDAY_FACTOR[dow] * perUser * (0.6 + rnd() * 0.8))
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
        `${exceptions.length} exceptions, ${events.filter((e) => e.event === '$rageclick').length} rage clicks, ${new Set(events.map((e) => e.event)).size} event types`
)
if (values['dry-run']) {
    const count = new Map<string, number>()
    for (const e of events) {
        const k = e.event.startsWith('$') && e.event !== '$pageview' ? `${e.event} ${e.properties.$pathname} ${String(e.properties.app_version)}` : e.event
        count.set(k, (count.get(k) || 0) + 1)
    }
    for (const [k, n] of [...count].sort()) console.log(String(n).padStart(6), k)
    process.exit(0)
}

for (let i = 0; i < events.length; i += 500) {
    await send(events.slice(i, i + 500))
    process.stdout.write(`\rsent ${Math.min(events.length, i + 500)}/${events.length}`)
}
console.log()
mkdirSync(join(ROOT, 'run'), { recursive: true })
const stateOut: SeedState = {
    covered_from: stateIn?.covered_from || new Date(from).toISOString(),
    covered_until: new Date(until).toISOString(),
}
writeFileSync(STATE_FILE, JSON.stringify(stateOut, null, 2) + '\n')
console.log(`State saved to ${STATE_FILE}`)
