// Made-up Reval-shaped events, to try the app-event tools (describe_app_events, session_story,
// dialog_friction) on a PostHog without Reval. Same properties and values as Reval sends, no real
// data. Needs APP_EVENTS_FILE=config/app-events.reval.json and CLIENT_FROM_DISTINCT_ID=3.
//
//   pnpm tsx scripts/seed-reval.ts [days=14]
import { config } from '../src/core/config.ts'

const days = Number(process.argv[2] || 14)
type Ev = { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }

// Clients and how hard their week is: fail = chance a validated step fails; fade = activity falls
// over the period (a client drifting away).
const CLIENTS = [
    { code: 'NBK', users: ['TREASURY1', 'TREASURY2', 'HEDGEOPS'], fail: 0.1, fade: 0 },
    { code: 'MRT', users: ['FXDESK', 'ACCTG01'], fail: 0.45, fade: 0 },
    { code: 'GLX', users: ['OPS1', 'OPS2', 'OPS3', 'RISK1'], fail: 0.15, fade: 0.8 },
    { code: 'ORB', users: ['ADMIN1'], fail: 0.2, fade: 0 },
]

let rnd = 42
const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]

type Step = [delay_s: number, event: 'PageView' | 'Event', props: Record<string, unknown>]
const openD = (d: string, name: string, tab = name): Step => [2, 'PageView', { dialog_id: d, dialog_name: name, tab_name: tab, action: 'OPEN' }]
const fieldD = (d: string, name: string, label: string, control = 'TEXTFIELD', tab = 'Main'): Step => [3 + r() * 8, 'Event', { dialog_id: d, dialog_name: name, tab_name: tab, action: label, control_type: control }]
const btn = (d: string, name: string, b: string): Step => [2 + r() * 4, 'Event', { dialog_id: d, dialog_name: name, tab_name: 'Main', action_name: b }]
const msg = (text: string): Step => [1.4, 'Event', { dialog_id: 'messagebox', dialog_name: 'UNKNOWN', tab_name: 'UNKNOWN', action_name: [text] }]
const toast = (text: string): Step => [1.2, 'Event', { dialog_id: 'toast', dialog_name: 'UNKNOWN', tab_name: 'UNKNOWN', action_name: [text] }]
const search = (type: string, text: string): Step[] => [
    [3, 'Event', { dialog_id: 'menuCmb', dialog_name: 'Menu', tab_name: type, action: type, control_type: 'SEARCHTYPE' }],
    [2, 'Event', { dialog_id: 'menuCmb', dialog_name: 'Menu', tab_name: type, action: text, control_type: 'SEARCH' }],
]

// Workflows: what a user sets out to do, and how it can go wrong.
const WORKFLOWS: ((fail: number) => Step[])[] = [
    (fail) => {
        const D = 'DlgDetailFasLinkAdvanced', N = 'Hedge Designation'
        const s: Step[] = [...search('Links', String(3000 + Math.floor(r() * 500))), openD(D, N), fieldD(D, N, 'Hedged Item', 'DROPDOWN')]
        let tries = 0
        while (r() < fail && tries++ < 3) s.push(btn(D, N, 'Save'), msg('Please designate a risk. Could not save FAS Link.'), fieldD(D, N, `gridfloatedit-${3000 + tries}-inputEl`))
        if (tries < 3) s.push(btn(D, N, 'Save'), toast(`Link Id ${3500 + Math.floor(r() * 99)} Added`))
        else s.push([20, 'PageView', { dialog_id: D, dialog_name: N, tab_name: N, action: 'CLOSE' }])
        return s
    },
    (fail) => {
        const D = 'DlgRepAccrEnh', N = 'Accrual Report Parameters'
        const s: Step[] = [...search('Menu', 'Accrual Report'), openD('RepAccrEnhReqv', 'Accrual Report'), btn('DlgGenericReport', 'Generic Report', 'Parameters'), openD(D, N, 'Parameters'), fieldD(D, N, 'From Trade Id', 'TEXTFIELD', 'Parameters')]
        if (r() < fail) s.push(btn(D, N, 'Run'), msg(pick(['Please provide an Accrual Date range', 'From Trade Id cannot be greater than To Trade Id.'])), fieldD(D, N, 'Accrual Date', 'DATEFIELD', 'Parameters'))
        s.push(btn(D, N, 'Run'), toast('The async report has been scheduled'))
        return s
    },
    (fail) => {
        const D = 'DlgDetailIRSwap', N = 'IR Swap'
        const s: Step[] = [...search('Trades', String(4000 + Math.floor(r() * 400))), openD(D, N), openD(D, N, 'Terms'), fieldD(D, N, 'Trade Date', 'DATEFIELD', 'Terms'), btn(D, N, 'Edit')]
        if (r() < fail / 2) s.push(btn(D, N, 'Save'), msg(`Last Traded Quote for rate feed code: USD-SOFR-RP_${100000 + Math.floor(r() * 900)} at market date: 06-Nov-2026 15:35:44 not found. Could not read Quotes from the rate history table.\nUnable to price trade.`))
        else s.push(btn(D, N, 'Save'), toast(`Trade Id ${4000 + Math.floor(r() * 400)} Updated`))
        return s
    },
    (fail) => {
        const s: Step[] = [...search('Trades', pick(['IOMOPS', 'ACME BANK', String(19000 + Math.floor(r() * 200))]))]
        if (r() < fail) s.push(msg('No trades found for search text: x'))
        else s.push(openD('DlgDetailIRDebt', 'Debt'), openD('DlgDetailIRDebt', 'Debt', 'Cashflow'), btn('DlgDetailIRDebt', 'Debt', 'XLS Export'))
        return s
    },
]

const events: Ev[] = []
const now = Date.now()
for (const c of CLIENTS) {
    for (let d = days; d >= 1; d--) {
        const activity = 1 - c.fade * ((days - d) / days) // falls towards the end for a fading client
        for (const user of c.users) {
            if (r() > 0.75 * activity) continue
            const sid = crypto.randomUUID()
            let t = now - d * 86_400_000 + (8 + r() * 8) * 3_600_000
            const distinct_id = `C1PRD|01|${c.code}|${user}`
            events.push({ event: 'PageView', distinct_id, timestamp: new Date(t).toISOString(), properties: { $session_id: sid, dialog_id: 'DlgListFavorites', dialog_name: 'My Views/My Favorites', tab_name: 'Main', action: 'OPEN', title: 'REVAL 27.0.0' } })
            for (let w = 0, n = 1 + Math.floor(r() * 4); w < n; w++) {
                for (const [delay, event, props] of pick(WORKFLOWS)(c.fail)) {
                    t += delay * 1000
                    events.push({ event, distinct_id, timestamp: new Date(t).toISOString(), properties: { $session_id: sid, ...props } })
                }
                t += 30_000 + r() * 120_000
            }
        }
    }
}

for (let i = 0; i < events.length; i += 500) {
    const res = await fetch(`${config.posthog.host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: config.posthog.projectToken, historical_migration: true, batch: events.slice(i, i + 500) }),
    })
    if (!res.ok) throw new Error(`batch → ${res.status}: ${(await res.text()).slice(0, 200)}`)
}
console.log(`Sent ${events.length} Reval-shaped events for ${CLIENTS.length} clients over ${days} days. They show up in queries after a minute or so.`)
