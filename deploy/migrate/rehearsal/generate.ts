// Fills the rehearsal copy of the old PostHog with production-like data, for testing the migration:
//   - events over the past DAYS days (page views, clicks, purchases, exceptions, custom events),
//     from USERS users at CLIENTS companies, with person properties, groups, and anonymous visitors
//     who sign in later (person merges);
//   - saved things that refer to each other by id, which the migration must keep pointing right:
//     actions, cohorts (one built on another, one static), feature flags using a cohort, insights using
//     an action and a cohort, a dashboard with those insights and a text tile, an annotation, a survey,
//     and a webhook destination.
//
//   tsx generate.ts --host http://127.0.0.1:8010 --events 1100000
// Env: OLD_PERSONAL_API_KEY (all scopes, for the saved things), OLD_PROJECT_TOKEN, OLD_PROJECT_ID.
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values: opt } = parseArgs({
    options: {
        host: { type: 'string', default: 'http://127.0.0.1:8010' },
        events: { type: 'string', default: '1100000' },
        days: { type: 'string', default: '60' },
        users: { type: 'string', default: '30000' },
        clients: { type: 'string', default: '300' },
        rate: { type: 'string', default: '1500' }, // events per second sent
        only: { type: 'string' }, // "events" or "objects"
    },
})
const HOST = opt.host!
const TOKEN = process.env.OLD_PROJECT_TOKEN!
const KEY = process.env.OLD_PERSONAL_API_KEY!
const PROJECT = process.env.OLD_PROJECT_ID!
const N = Number(opt.events)
const DAYS = Number(opt.days)
const USERS = Number(opt.users)
const CLIENTS = Number(opt.clients)
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

let seed = 4242
const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 1_000_000) / 1_000_000
}
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]
const PATHS = ['/dashboard', '/invoices', '/invoices/new', '/clients', '/reports/revenue', '/settings', '/billing']
const IPS = ['81.2.69.142', '2.125.160.216', '216.160.83.56', '89.160.20.112', '67.43.156.1', '175.16.199.1']
const PLANS = ['starter', 'growth', 'enterprise'] as const

// ------------------------------------------------------------------ events
async function events() {
    const start = Date.now() - DAYS * 86_400_000
    const sent = { n: 0, failed: 0 }
    const inflight = new Set<Promise<void>>()
    const post = (batch: object[]) => {
        const p = (async () => {
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    const r = await fetch(`${HOST}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: TOKEN, batch }) })
                    await r.arrayBuffer()
                    if (r.ok) return
                } catch {}
                await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
            }
            sent.failed += batch.length
        })()
        inflight.add(p)
        p.finally(() => inflight.delete(p))
    }
    const t0 = Date.now()
    // Events go out in time order, like a real app over two months, so person merges happen in order.
    for (let i = 0; i < N; ) {
        const batch: object[] = []
        for (let j = 0; j < 100 && i < N; j++, i++) {
            const ts = new Date(start + (i / N) * DAYS * 86_400_000 + rnd() * 60_000)
            const u = Math.floor(rnd() * USERS)
            const client = `client-${u % CLIENTS}`
            const email = `user${u}@${client}.example`
            const session = `${u}-${Math.floor(ts.getTime() / 1_800_000)}`
            const base = { $session_id: session, $current_url: `https://portal.example.com${pick(PATHS)}`, $ip: pick(IPS), $browser: pick(['Chrome', 'Safari', 'Firefox']), $os: pick(['Mac OS X', 'Windows', 'iOS']), client_id: client, app_version: ts.getTime() > start + DAYS * 43_200_000 ? '26.10.0' : '26.9.0', $groups: { company: client } }
            const r = rnd()
            let e: Record<string, unknown>
            if (r < 0.01) {
                // An anonymous visitor who signs in: PostHog merges the two into one person.
                const anon = `anon-${randomUUID()}`
                batch.push({ event: '$pageview', distinct_id: anon, timestamp: new Date(ts.getTime() - 60_000).toISOString(), uuid: randomUUID(), properties: { ...base, $pathname: '/login' } })
                e = { event: '$identify', distinct_id: email, properties: { ...base, $anon_distinct_id: anon, $set: { email, plan: pick(PLANS), client_id: client }, $set_once: { first_seen_client: client } } }
            } else if (r < 0.015) {
                e = { event: '$groupidentify', distinct_id: email, properties: { $group_type: 'company', $group_key: client, $group_set: { name: `Client ${u % CLIENTS}`, plan: pick(PLANS), seats: 5 + (u % 200) } } }
            } else if (r < 0.5) e = { event: '$pageview', distinct_id: email, properties: { ...base, $pathname: pick(PATHS) } }
            else if (r < 0.75) e = { event: '$autocapture', distinct_id: email, properties: { ...base, $event_type: 'click', $elements_chain: `button.btn:text="${pick(['Save', 'Send', 'Export'])}"nth-child="1"nth-of-type="1"` } }
            else if (r < 0.8) e = { event: 'invoice_sent', distinct_id: email, properties: { ...base, amount: Math.round(rnd() * 90000) / 100, currency: pick(['EUR', 'GBP', 'USD']) } }
            else if (r < 0.82) e = { event: '$exception', distinct_id: email, properties: { ...base, $exception_list: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'toFixed')", mechanism: { handled: false } }] } }
            else e = { event: pick(['report_exported', 'client_filter_applied', 'invoice_viewed', 'settings_saved']), distinct_id: email, properties: base }
            batch.push({ ...e, timestamp: ts.toISOString(), uuid: randomUUID() })
        }
        while (inflight.size >= 16) await Promise.race(inflight)
        post(batch)
        sent.n = i
        // Keep to the rate, so the old ingestion keeps up and nothing is dropped.
        const ahead = sent.n / Number(opt.rate) - (Date.now() - t0) / 1000
        if (ahead > 0) await new Promise((r) => setTimeout(r, ahead * 1000))
        if (i % 100_000 < 100) log(`sent ${i} events, ${sent.failed} failed`)
    }
    await Promise.all(inflight)
    log(`all ${N} events sent (${sent.failed} failed) in ${Math.round((Date.now() - t0) / 1000)}s`)
}

// ------------------------------------------------------------------ saved things
async function api(method: string, path: string, body?: unknown) {
    const r = await fetch(`${HOST}/api/projects/${PROJECT}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const t = await r.text()
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 300)}`)
    return JSON.parse(t)
}
async function objects() {
    const action = await api('POST', '/actions/', { name: 'Sent an invoice', steps: [{ event: 'invoice_sent' }] })
    const action2 = await api('POST', '/actions/', { name: 'Exported a report', steps: [{ event: 'report_exported' }] })
    const enterprise = await api('POST', '/cohorts/', { name: 'Enterprise users', filters: { properties: { type: 'OR', values: [{ type: 'AND', values: [{ key: 'plan', type: 'person', value: ['enterprise'], operator: 'exact' }] }] } } })
    const both = await api('POST', '/cohorts/', {
        name: 'Enterprise users who sent invoices',
        filters: { properties: { type: 'AND', values: [{ type: 'AND', values: [{ key: 'id', type: 'cohort', value: enterprise.id }, { key: 'plan', type: 'person', value: ['enterprise', 'growth'], operator: 'exact' }] }] } },
    })
    const fixed = await api('POST', '/cohorts/', { name: 'Pilot users (static)', is_static: true })
    await fetch(`${HOST}/api/projects/${PROJECT}/cohorts/${fixed.id}/`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ _create_static_person_ids: Array.from({ length: 40 }, (_, i) => `user${i}@client-${i % CLIENTS}.example`) }),
    }).catch(() => {})
    const flag = await api('POST', '/feature_flags/', { key: 'new-invoice-editor', name: 'New invoice editor', filters: { groups: [{ properties: [{ key: 'id', type: 'cohort', value: enterprise.id }], rollout_percentage: 100 }, { properties: [], rollout_percentage: 20 }] }, active: true })
    const trends = await api('POST', '/insights/', {
        name: 'Invoices sent by enterprise users',
        query: { kind: 'InsightVizNode', source: { kind: 'TrendsQuery', series: [{ kind: 'ActionsNode', id: action.id, name: action.name, math: 'total' }], properties: { type: 'AND', values: [{ type: 'AND', values: [{ key: 'id', type: 'cohort', value: both.id }] }] }, dateRange: { date_from: '-60d' }, interval: 'week' } },
    })
    const funnel = await api('POST', '/insights/', {
        name: 'Export to invoice funnel',
        query: { kind: 'InsightVizNode', source: { kind: 'FunnelsQuery', series: [{ kind: 'ActionsNode', id: action2.id }, { kind: 'EventsNode', event: 'invoice_sent' }], dateRange: { date_from: '-30d' } } },
    })
    const pages = await api('POST', '/insights/', { name: 'Page views by version', query: { kind: 'InsightVizNode', source: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview', math: 'dau' }], breakdownFilter: { breakdown: 'app_version', breakdown_type: 'event' }, dateRange: { date_from: '-60d' } } } })
    const dash = await api('POST', '/dashboards/', { name: 'Billing health', description: 'Invoices, exports and versions' })
    for (const i of [trends, funnel, pages]) await api('PATCH', `/insights/${i.id}/`, { dashboards: [dash.id] })
    await api('PATCH', `/dashboards/${dash.id}/`, { tiles: [{ text: { body: 'Numbers since the 26.10.0 release.' } }] }).catch((e) => log('text tile:', e.message))
    await api('POST', '/annotations/', { content: 'Released 26.10.0', date_marker: new Date(Date.now() - 30 * 86_400_000).toISOString(), scope: 'project' })
    await api('POST', '/surveys/', { name: 'Invoice editor feedback', type: 'popover', questions: [{ type: 'rating', question: 'How easy is invoicing?', scale: 5 }], linked_flag_id: flag.id }).catch((e) => log('survey:', e.message))
    await api('POST', '/hog_functions/', {
        type: 'destination',
        name: 'Invoice webhook',
        template_id: 'template-webhook',
        enabled: false,
        inputs: { url: { value: 'https://example.com/hook' }, method: { value: 'POST' }, body: { value: { event: '{event}' } } },
        filters: { actions: [{ id: String(action.id), type: 'actions', name: action.name, order: 0 }] },
    }).catch((e) => log('destination:', e.message))
    log(`saved things created: actions ${action.id},${action2.id}; cohorts ${enterprise.id},${both.id},${fixed.id}; flag ${flag.id}; insights ${trends.id},${funnel.id},${pages.id}; dashboard ${dash.id}`)
}

if (opt.only !== 'objects') await events()
if (opt.only !== 'events') await objects()
