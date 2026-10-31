// Adds in-product survey answers to the demo history: "How is this screen working for you?",
// rated 1 to 5, with an optional comment. They follow the release plan, so clients complain while
// a screen is broken for them and praise features they use.
//
//   pnpm seed:feedback            # from 2025-09-01, or from where the last run stopped
//   pnpm seed:feedback --dry-run
//
// They are sent as PostHog "survey sent" events, the same shape PostHog surveys produce, so the
// release tools read real surveys the same way. State lives in run/seed-feedback-state.json.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { ALL_CLIENTS, BUGGY_VERSION, hitsExportBug } from '../src/core/catalog.ts'
import { config, ROOT } from '../src/core/config.ts'
import { activeSignals, appliesTo, releaseIndex, releaseTime, versionAt } from '../src/core/release-plan.ts'

const { values } = parseArgs({ options: { from: { type: 'string', default: '2025-09-01' }, 'dry-run': { type: 'boolean', default: false } } })
const STATE = join(ROOT, 'run/seed-feedback-state.json')
const DAY = 86_400_000
const from = existsSync(STATE) ? Date.parse(JSON.parse(readFileSync(STATE, 'utf8')).covered_until) : Date.parse(values.from + 'T00:00:00Z')
const until = Date.now() - 30 * 60_000

let seed = 777 ^ Math.floor(from / DAY)
const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 1_000_000) / 1_000_000
}
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]

/** What people say while a screen is broken for them, by the ticket that broke it. */
const BROKEN: Record<string, string[]> = {
    'ACP-142': ['The new date picker closes every time I click the arrow', 'Picking a date range on the revenue report is painful now', 'Calendar keeps closing before I can choose the end date'],
    'ACP-180': ['Revenue report shows an error instead of the chart', 'The chart is broken for this quarter', 'Report crashed again, I had to build it in Excel'],
    'ACP-200': ['Where did the search box go?', 'I just want to find a client by name', 'The new filters take three clicks to find anyone'],
    export: ['PDF export hangs on "Preparing PDF"', "Can't export invoices that mix EUR and GBP", 'Export is stuck, we could not send our statements'],
}
/** What people say about features they like, by ticket. */
const LIKED: Record<string, string[]> = {
    'ACP-140': ['Reminders get us paid faster', 'The reminder emails are great'],
    'ACP-130': ['The year-end summary made closing much easier'],
    'ACP-161': ['Revenue by region is really useful for our board pack'],
    'ACP-210': ['Bulk send saves me an hour at month end', 'Sending all invoices at once is brilliant'],
    'ACP-213': ['The last-year comparison is exactly what our CFO wanted'],
    'ACP-220': ['Payment links are a big help', 'Clients pay faster with the payment link'],
    'ACP-221': ['Health score helps us spot late payers early'],
    'ACP-231': ['Templates save a lot of typing'],
}
const NEUTRAL = ['', '', '', 'Works fine', 'No complaints', 'Fast enough', 'Would like more export formats', 'Good', 'Could be quicker on Mondays']
const SCREENS = ['/invoices', '/invoices', '/invoices', '/reports/revenue', '/reports/revenue', '/clients', '/clients', '/dashboard', '/settings']
const WEEKDAY = [0.1, 1, 1.1, 1.2, 1.1, 0.8, 0.1]

type Ev = { event: string; distinct_id: string; timestamp: string; uuid: string; properties: Record<string, unknown> }
const events: Ev[] = []
for (let day = Math.floor(from / DAY) * DAY; day < until; day += DAY) {
    const dow = new Date(day).getUTCDay()
    for (const client of ALL_CLIENTS) {
        // About one answer per 100 users a working day.
        const expected = client.users.length * 0.01 * WEEKDAY[dow]
        const n = Math.floor(expected) + (rnd() < expected % 1 ? 1 : 0)
        for (let k = 0; k < n; k++) {
            const t = day + (8 + rnd() * 9) * 3_600_000
            if (t < from || t > until) continue
            const user = pick(client.users)
            const path = pick(SCREENS)
            const version = versionAt(client, t)
            const live = activeSignals(version).filter((x) => x.screen === path && appliesTo(x, client, user.role))
            const broken = live.filter((x) => (x.rage || x.error) && (!x.until || releaseIndex(version) < releaseIndex(x.until))).map((x) => x.key)
            if (path === '/invoices' && hitsExportBug(client) && version === BUGGY_VERSION) broken.push('export')
            const liked = live.filter((x) => LIKED[x.key] && x.use && t - releaseTime(x.since) < 75 * DAY).map((x) => x.key)
            let rating: number
            let comment: string
            if (broken.length && rnd() < 0.7) {
                rating = pick([1, 2, 2, 2, 3])
                comment = rnd() < 0.8 ? pick(BROKEN[pick(broken)] || NEUTRAL) : ''
            } else if (liked.length && rnd() < 0.35) {
                rating = pick([4, 5, 5])
                comment = pick(LIKED[pick(liked)])
            } else {
                rating = pick([3, 4, 4, 4, 5, 5])
                comment = pick(NEUTRAL)
            }
            events.push({
                event: 'survey sent',
                distinct_id: user.email,
                timestamp: new Date(t).toISOString(),
                uuid: randomUUID(),
                properties: {
                    $survey_id: 'quick-feedback',
                    $survey_name: 'Quick feedback',
                    $survey_response: String(rating),
                    $survey_response_1: comment,
                    $pathname: path,
                    $current_url: `http://localhost:3000${path}`,
                    client_id: client.id,
                    client_name: client.name,
                    app_version: version,
                },
            })
        }
    }
}
const low = events.filter((e) => Number(e.properties.$survey_response) <= 2).length
console.log(`${events.length} survey answers from ${new Date(from).toISOString().slice(0, 10)}, ${low} rated 1 or 2`)
if (values['dry-run']) process.exit(0)
for (let i = 0; i < events.length; i += 500) {
    const res = await fetch(`${config.posthog.host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: config.posthog.projectToken, historical_migration: true, batch: events.slice(i, i + 500) }),
    })
    if (!res.ok) throw new Error(`batch → ${res.status}: ${(await res.text()).slice(0, 200)}`)
}
writeFileSync(STATE, JSON.stringify({ covered_until: new Date(until).toISOString() }, null, 2) + '\n')
console.log(`Sent. State saved to ${STATE}`)
