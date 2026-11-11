// Demo data for the client signals (src/core/signals.ts): five extra Reval-shaped clients over ~110 working days,
// each with one planted pattern, sent to PostHog like scripts/seed-reval-scale.ts (historical batch capture).
//
//   npx tsx scripts/seed-reval-signals.ts [--dry] [--out file.jsonl]      (SEED_END_DAY, default 2026-11-10)
//
//   S001 Northwind Treasury  key person: one user does ~70% of the work, then has no activity for the last 15 days
//   S002 Harbor Bank         work moving out: exports jump in the last 28 days while saves fall; exports after errors
//   S003 Cedar Industries    recurring close error: the same effectiveness-test error at every month-end close
//   S004 Atlas Energy        giving up: in the last 14 days most errors on hedge designation end the session
//   S005 Quiet Mills         flat, low, steady use: never trips a decline alert (for the quiet-account review)
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { config } from '../src/core/config.ts'

const args = process.argv.slice(2), dry = args.includes('--dry'), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : ''
if (!dry && !out && !config.posthog.projectToken) throw new Error('Set POSTHOG_PROJECT_TOKEN, or use --dry / --out')
const end = Date.parse(process.env.SEED_END_DAY || '2026-11-10'), DAYS = Number(process.env.SEED_DAYS || 110), DAY = 86_400_000
let random = 7
const r = () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 2 ** 32)
type Ev = { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }
const stream = !dry && out ? createWriteStream(out) : undefined
let chunk: Ev[] = [], total = 0, sessions = 0
async function flush() {
    if (!chunk.length) return
    if (stream) { if (!stream.write(chunk.map((e) => JSON.stringify(e)).join('\n') + '\n')) await once(stream, 'drain') }
    else if (!dry) for (let attempt = 0; ; attempt++) {
        try {
            const res = await fetch(`${config.posthog.host}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ api_key: config.posthog.projectToken, historical_migration: true, batch: chunk }), signal: AbortSignal.timeout(30_000) })
            if (!res.ok) throw new Error(`batch: ${res.status} ${(await res.text()).slice(0, 200)}`)
            break
        } catch (e) { if (attempt >= 4) throw e; await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt)) }
    }
    total += chunk.length; chunk = []
}
const emit = async (e: Ev) => { chunk.push(e); if (chunk.length >= 500) await flush() }

const clients = [
    { code: 'S001', name: 'Northwind Treasury' }, { code: 'S002', name: 'Harbor Bank' }, { code: 'S003', name: 'Cedar Industries' },
    { code: 'S004', name: 'Atlas Energy' }, { code: 'S005', name: 'Quiet Mills' },
]
const HEDGE = { dialog: 'DlgDetailFasLinkAdvanced', title: 'Hedge Designation', button: 'Save', ok: 'Link Id 13456 Added' }
const SWAP = { dialog: 'DlgDetailIRSwap', title: 'IR Swap', button: 'Save', ok: 'Trade Id 4356 Updated' }
const EFF = { dialog: 'DlgHedgeEffectiveness', title: 'Effectiveness Test', button: 'Run', ok: 'Effectiveness test completed' }
const isClose = (d: Date) => { const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); return d.getUTCDate() > last - 5 || d.getUTCDate() <= 3 }

for (let i = DAYS; i >= 1; i--) {
    const day = end - (i - 1) * DAY, date = new Date(day), dow = date.getUTCDay()
    if (dow === 0 || dow === 6) continue // treasury teams work weekdays
    const ago = i - 1 // 0 = the last seeded day
    for (const [ci, c] of clients.entries()) {
        const perDay = c.code === 'S005' ? 2 : 10
        for (let s = 0; s < perDay; s++) {
            // Who works: Northwind's USER1 does ~70% of sessions until the last 15 days, then is absent.
            let user = `USER${(s % 4) + 1}`
            if (c.code === 'S001') { const key = s < 7; if (key && ago < 15) continue; user = key ? 'USER1' : `USER${(s % 3) + 2}` }
            const distinct_id = `C1PRD|01|${c.code}|${user}`
            const id = `${date.toISOString().slice(0, 10).replaceAll('-', '')}-9${String(ci).padStart(3, '0')}-4000-8000-${String(s).padStart(12, '0')}`
            let t = day + (8 + (s / perDay) * 9) * 3_600_000
            const add = async (delay: number, event: string, properties: Record<string, unknown>) => {
                t += delay * 1000
                await emit({ event, distinct_id, timestamp: new Date(t).toISOString(), properties: { $session_id: id, $time: t / 1000, client_id: c.code, client_name: c.name, ...properties } })
            }
            const work = async (def: typeof HEDGE, error?: { text: string; recover: boolean }) => {
                await add(15, 'PageView', { dialog_id: def.dialog, dialog_name: def.title, action: 'OPEN' })
                for (let f = 0; f < 3; f++) await add(10 + r() * 10, 'Event', { dialog_id: def.dialog, dialog_name: def.title, tab_name: 'Main', action: ['Trade Date', 'Currency', 'Amount'][f], control_type: 'TEXTFIELD' })
                await add(2, 'Event', { dialog_id: def.dialog, action_name: def.button })
                if (error) {
                    await add(1, 'Event', { dialog_id: 'messagebox', action_name: [error.text] })
                    if (!error.recover) return false
                    await add(12, 'Event', { dialog_id: def.dialog, action: 'Accounting Date', control_type: 'DATEFIELD' })
                    await add(2, 'Event', { dialog_id: def.dialog, action_name: def.button })
                }
                await add(1, 'Event', { dialog_id: 'toast', action_name: [def.ok] })
                return true
            }
            const exportNow = async (dialog = 'DlgTradeList', title = 'Trade List') => {
                await add(10, 'PageView', { dialog_id: dialog, dialog_name: title, action: 'OPEN' })
                await add(5, 'Event', { dialog_id: dialog, action_name: 'XLSX Export' })
                await add(2, 'Event', { dialog_id: 'toast', action_name: ['Export completed'] })
            }
            sessions++
            await add(0, 'PageView', { dialog_id: 'DlgListFavorites', dialog_name: 'My Views/My Favorites', action: 'OPEN', title: 'REVAL 27.0.0' })
            if (c.code === 'S002') {
                // Harbor: in the last 28 days fewer saves, many exports, and exports right after errors.
                const recent = ago < 28
                if (!recent || s % 5 < 3) {
                    const failed = !(await work(SWAP, recent && r() < 0.35 ? { text: 'Valuation curve not available', recover: false } : undefined))
                    if (failed) await exportNow()
                }
                if (recent ? s % 2 === 0 : s === 0) await exportNow(s % 4 === 0 ? 'DlgCashflowReport' : 'DlgTradeList', s % 4 === 0 ? 'Cashflow Report' : 'Trade List')
            } else if (c.code === 'S003') {
                // Cedar: the same effectiveness-test error in every close window; fine otherwise.
                await work(SWAP)
                await work(EFF, isClose(date) && s % 3 === 0 ? { text: 'Effectiveness test failed: no curve for USD-SOFR', recover: s % 2 === 0 } : undefined)
            } else if (c.code === 'S004') {
                // Atlas: errors used to be recovered; in the last 14 days most end the session.
                const err = r() < (ago < 14 ? 0.5 : 0.12)
                await work(HEDGE, err ? { text: 'Hedge relationship could not be saved: invalid designation date', recover: ago >= 14 || r() < 0.25 } : undefined)
            } else {
                await work(s % 2 === 0 ? HEDGE : SWAP)
                if (c.code !== 'S005' && s % 4 === 0) await work(EFF)
            }
        }
    }
    await flush()
    if (!dry && i % 10 === 0) console.log(`${date.toISOString().slice(0, 10)}: ${total} events, ${sessions} sessions`)
}
await flush()
if (stream) { stream.end(); await once(stream, 'finish') }
console.log(JSON.stringify({ days: DAYS, clients: clients.length, sessions, events: total, dry, out: out || null }))
