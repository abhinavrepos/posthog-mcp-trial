// Demo data for the Live page: people working through today, with real pauses, and a few people
// "in the app" right now. Only events are sent (no recordings).
//
//   pnpm live-demo                    # today's sessions so far, then 10 minutes of live activity
//   pnpm live-demo --minutes 30       # live for 30 minutes
//   pnpm live-demo --minutes 0        # today's sessions only
//   pnpm live-demo --selftest         # a fixed session on 2025-10-01 whose times are known exactly
//
// A working session: an action every 5 to 40 seconds, and now and then a pause of 2 to 25 minutes
// (reading, a call, another app). Pauses stay under PostHog's 30-minute session limit, so they
// count as idle time inside the session.
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import { ALL_CLIENTS, type DemoClient } from '../src/core/catalog.ts'
import { config } from '../src/core/config.ts'

const { values } = parseArgs({ options: { minutes: { type: 'string', default: '10' }, clients: { type: 'string', default: '8' }, selftest: { type: 'boolean', default: false } } })
const SITE = process.env.DEMO_APP_URL || 'http://localhost:3000'
const SCREENS = ['/dashboard', '/invoices', '/invoices', '/reports/revenue', '/clients', '/settings']
const ACTIONS = ['$autocapture', '$autocapture', '$autocapture', 'invoice_searched', 'client_filter_applied', 'revenue_summary_viewed']

type Ev = { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown>; uuid: string }
let seed = 42
const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 1_000_000) / 1_000_000
}
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]

function ev(client: DemoClient, email: string, sid: string, t: number, event: string, path: string): Ev {
    return {
        event,
        distinct_id: email,
        timestamp: new Date(t).toISOString(),
        uuid: randomUUID(),
        properties: {
            $session_id: sid,
            $lib: 'web',
            $pathname: path,
            $current_url: SITE + path,
            client_id: client.id,
            client_name: client.name,
            app_version: client.version,
            $set: { email },
            ...(event === '$autocapture' ? { $event_type: 'click', $elements_chain: 'button.btn:text="Apply"' } : {}),
        },
    }
}

async function send(batch: Ev[], historical: boolean) {
    for (let i = 0; i < batch.length; i += 500) {
        const res = await fetch(`${config.posthog.host}/batch/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ api_key: config.posthog.projectToken, ...(historical ? { historical_migration: true } : {}), batch: batch.slice(i, i + 500) }),
        })
        if (!res.ok) throw new Error(`batch → ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
}

if (values.selftest) {
    // Actions at 0, 30, 90, 400 and 410 seconds, with a 60-second active limit:
    // in the app 410 s; active 30 + 60 + 60 + 10 = 160 s; idle 250 s (the pause after 90 s).
    const client = { ...ALL_CLIENTS[0], id: 'lens-selftest', name: 'Lens self-test' }
    const start = Date.parse('2025-10-01T09:00:00Z')
    const sid = '0199a000-0000-7000-8000-000000005e1f'
    const evs = [0, 30, 90, 400, 410].map((s) => ev(client, 'selftest@lens.example', sid, start + s * 1000, '$autocapture', '/dashboard'))
    await send(evs, true)
    console.log('Sent the self-test session (Lens self-test, 2025-10-01 09:00 UTC). Expected with a 60 s limit: in the app 410 s, active 160 s, idle 250 s.')
    process.exit(0)
}

const now = Date.now()
const dayStart = new Date(now)
dayStart.setUTCHours(6, 0, 0, 0)
const clients = ALL_CLIENTS.slice(0, Math.max(1, Number(values.clients) || 8))

// Today so far.
const today: Ev[] = []
for (const client of clients) {
    for (const user of client.users.slice(0, 3)) {
        let t = dayStart.getTime() + rnd() * 3 * 3_600_000
        const sessions = 1 + Math.floor(rnd() * 3)
        for (let s = 0; s < sessions && t < now - 15 * 60_000; s++) {
            const sid = randomUUID()
            const end = Math.min(now - 12 * 60_000, t + (20 + rnd() * 160) * 60_000)
            let path = pick(SCREENS)
            today.push(ev(client, user.email, sid, t, '$pageview', path))
            while (t < end) {
                t += rnd() < 0.06 ? (2 + rnd() * 23) * 60_000 : (5 + rnd() * 35) * 1000
                if (t > end) break
                if (rnd() < 0.15) {
                    path = pick(SCREENS)
                    today.push(ev(client, user.email, sid, t, '$pageview', path))
                } else today.push(ev(client, user.email, sid, t, pick(ACTIONS), path))
            }
            t += (35 + rnd() * 120) * 60_000 // a break longer than 30 minutes: the next session
        }
    }
}
await send(today, true)
console.log(`Sent ${today.length} events for today's sessions so far (${clients.length} clients).`)

// Live: a few people keep working for a while.
const minutes = Math.max(0, Number(values.minutes) || 0)
if (!minutes) process.exit(0)
const live = clients.slice(0, 4).map((client, i) => ({ client, email: client.users[i % client.users.length].email, sid: randomUUID(), path: pick(SCREENS), next: Date.now() }))
console.log(`Live for ${minutes} minutes: ${live.map((l) => `${l.email} (${l.client.name})`).join(', ')}`)
const until = Date.now() + minutes * 60_000
for (const l of live) await send([ev(l.client, l.email, l.sid, Date.now(), '$pageview', l.path)], false)
while (Date.now() < until) {
    const due = live.filter((l) => l.next <= Date.now())
    if (due.length) {
        await send(due.map((l) => ev(l.client, l.email, l.sid, Date.now(), pick(ACTIONS), l.path)), false)
        for (const l of due) l.next = Date.now() + (5 + rnd() * 35) * 1000 + (rnd() < 0.05 ? 3 * 60_000 : 0)
    }
    await new Promise((r) => setTimeout(r, 1000))
}
console.log('Done.')
