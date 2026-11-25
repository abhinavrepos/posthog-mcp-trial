// Real-deployment survey timing test: the simulated Reval in headless Chrome against a REAL self-hosted PostHog
// (posthog-js and the Lens survey engine served by that PostHog), with the survey created and launched through Lens.
// Rows record the distinct_id the simulated Reval sends (C1DEV|01|client|user, the sim server default env).
//   REAL_PH=http://127.0.0.1 REAL_TOKEN=phc_… REAL_KEY=phx_… REAL_PROJECT=1 SESSIONS=120 PARALLEL=6 \
//     node --import tsx tools/reval-sim/real-sessions.ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer'
import { RevalServer } from './server.ts'
import { visit, surveysOnScreen, type Sim } from './harness.ts'

const PH = process.env.REAL_PH!, TOKEN = process.env.REAL_TOKEN!, KEY = process.env.REAL_KEY!, PROJECT = process.env.REAL_PROJECT || '1'
const N = Number(process.env.SESSIONS || 120), PAR = Number(process.env.PARALLEL || 6)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
Object.assign(process.env, { POSTHOG_HOST: PH, POSTHOG_PROJECT_ID: PROJECT, POSTHOG_PERSONAL_API_KEY: KEY, POSTHOG_SURVEY_API_KEY: KEY, FEATURE_SURVEYS: 'on',
    APP_EVENTS_FILE: join(import.meta.dirname, '../../config/app-events.reval.json'), CLIENT_FROM_DISTINCT_ID: '3', DISTINCT_ID_SEPARATOR: '|' })
const { config } = await import('../../src/core/config.ts')
Object.assign(config.posthog, { host: PH, projectId: PROJECT, personalApiKey: KEY, surveyApiKey: KEY, surveyGate: '' })
config.surveys.enabled = true; config.properties.clientFromDistinctId = 3; config.properties.distinctIdSeparator = '|'
const lens = await import('../../src/core/surveys.ts')

type Kind = 'export' | 'export-late' | 'open-only' | 'export-elsewhere' | 'export-first' | 'other-client'
const KINDS: Kind[] = ['export', 'export', 'export-late', 'open-only', 'export-elsewhere', 'export-first', 'other-client', 'export']
const stamp = Date.now().toString(36)
const saved = await lens.saveSurvey({ name: `Hedge export ${stamp}`, questions: [{ type: 'rating', text: 'How easy was the export?' }],
    steps: [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }], clients: ['SEM'], show: 'once', wait_for_page: true, max_wait_seconds: 30 } as never, { clientIds: ['SEM'] })
if (!saved.survey) throw new Error('Lens refused the survey: ' + JSON.stringify(saved.compiled.problems))
await lens.launchSurvey(saved.survey.id)
console.log('survey', saved.survey.id, 'warnings:', saved.compiled.problems.map((p) => p.text).join(' | ') || 'none')
// PostHog's flags service learns a newly launched survey's internal targeting flag a few seconds after launch, and
// posthog-js reads flags once per page load: wait until the flag is served, so sessions see the survey as users do.
const launchedAt = Date.now()
for (;;) {
    const f = await (await fetch(`${PH}/flags/?v=2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, distinct_id: `PROD|01|SEM|probe${Date.now()}` }) })).json() as { flags?: Record<string, { enabled: boolean }> }
    const survey = await (await fetch(`${PH}/api/projects/${PROJECT}/surveys/${saved.survey.id}/`, { headers: { authorization: `Bearer ${KEY}` } })).json() as { internal_targeting_flag?: { key: string } }
    const key = survey.internal_targeting_flag?.key
    if (key && f.flags?.[key]?.enabled) { console.log('targeting flag', key); break }
    if (Date.now() - launchedAt > 180_000) throw new Error('PostHog never served the survey targeting flag')
    await sleep(1000)
}
console.log(`survey targeting flag served ${Date.now() - launchedAt} ms after launch`)
await sleep(2000)

const reval = await new RevalServer().start()
const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 300_000, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const sim = { reval, browser, posthog: { url: PH, tokenFor: () => TOKEN } } as unknown as Sim

interface Row { i: number; kind: Kind; user: string; expected: 'shows' | 'none'; result: 'shows' | 'none'; ok: boolean; exportAt?: string; shownAt?: string; delayMs?: number; earlyShow?: boolean; waitedMs?: number; note?: string }
const rows: Row[] = []
const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a))

async function session(i: number): Promise<Row> {
    const kind = KINDS[i % KINDS.length]
    const client = kind === 'other-client' ? 'ACME' : 'SEM'
    const user = `RS${stamp}${i}`
    const row: Row = { i, kind, user: `C1DEV|01|${client}|${user}`, expected: ['export', 'export-late', 'other-client'].includes(kind) ? (kind === 'other-client' ? 'none' : 'shows') : 'none', result: 'none', ok: false }
    const v = await visit(sim, PROJECT, { client, user, ph: PH })
    const R = (fn: string, ...a: unknown[]) => v.page.evaluate((f, xs) => (window as any).Reval[f](...xs), fn, a)
    let early = false
    const watch = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await surveysOnScreen(v.page)).length) early = true; await sleep(250) } }
    const press = async (screen: string, label: string) => { const id = await R('button', screen, label); if (!id) throw new Error(`no ${label} in ${screen}`); await v.page.click(`#${id}`) }
    try {
        await v.page.waitForFunction(() => !!(window as any).__PosthogExtensions__?.generateSurveys && !!(window as any).posthog?.__loaded, { timeout: 60_000 })
        await watch(1500)
        for (const s of ['DlgTradeList', 'DlgCalculator', 'DlgHedgeList'].slice(0, rand(1, 4))) { await R('open', s); await watch(rand(800, 2500)) }
        if (kind === 'export-first') { await R('open', 'DlgHedgeList'); await watch(1500); await press('DlgHedgeList', 'Export'); await watch(1500) }
        if (kind !== 'export-elsewhere' || true) { await R('open', 'report:LinkListReqv'); await watch(rand(1000, 4000)) }
        if (kind === 'export-late') { await watch(rand(180_000, 240_000)) } // 3 to 4 minutes in the report before exporting
        else if (kind === 'export' || kind === 'other-client') await watch(rand(500, 20_000))
        if (kind === 'export-elsewhere') { await R('open', 'DlgTradeList'); await watch(1300); await press('DlgTradeList', 'Export') }
        else if (kind === 'export' || kind === 'export-late' || kind === 'other-client') {
            row.earlyShow = early
            const t = Date.now(); row.exportAt = new Date(t).toISOString()
            await press('LinkListReqv', 'Export')
            const end = t + 45_000
            while (Date.now() < end) { if ((await surveysOnScreen(v.page)).length) { row.result = 'shows'; row.delayMs = Date.now() - t; row.shownAt = new Date().toISOString(); break } await sleep(100) }
        }
        if (row.result === 'none') { const t = Date.now(); await watch(kind === 'open-only' || kind === 'export-elsewhere' || kind === 'export-first' ? 15_000 : 0); row.waitedMs = Date.now() - t; if (early) row.result = 'shows' }
        row.earlyShow = row.earlyShow ?? early
        row.ok = row.result === row.expected && !row.earlyShow
        if (row.earlyShow) row.note = 'survey visible before the export'
    } catch (e) { row.note = (e as Error).message.split('\n')[0] }
    finally { await v.page.goto('about:blank').catch(() => {}); await sleep(500); await v.close() }
    return row
}

let next = 0
await Promise.all(Array.from({ length: PAR }, async () => { while (next < N) { const i = next++; const r = await session(i); rows.push(r); console.log(`${r.ok ? 'PASS' : 'FAIL'} #${r.i} ${r.kind} expected ${r.expected}, ${r.result}${r.delayMs != null ? ` ${r.delayMs} ms after export` : ''}${r.note ? ` (${r.note})` : ''}`) } }))
rows.sort((a, b) => a.i - b.i)
const out = join(import.meta.dirname, '../../run/real-sessions'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, `results-${stamp}.json`), JSON.stringify({ survey: saved.survey.id, ph: PH, rows }, null, 2))
const d = rows.filter((r) => r.delayMs != null).map((r) => r.delayMs!).sort((a, b) => a - b)
console.log(`\n${rows.filter((r) => r.ok).length} of ${rows.length} sessions as expected; survey ${saved.survey.id}`)
if (d.length) console.log(`delay after export: min ${d[0]} ms, median ${d[Math.floor(d.length / 2)]} ms, p95 ${d[Math.floor(d.length * 0.95)]} ms, max ${d[d.length - 1]} ms`)
await lens.stopSurvey?.(saved.survey.id).catch(() => {})
await browser.close(); await reval.stop()
