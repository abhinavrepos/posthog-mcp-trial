// Real-deployment check: a survey launched while Reval is already open shows without a reload.
// The simulated Reval in headless Chrome against a REAL self-hosted PostHog (its posthog-js, flags service and the
// Lens survey engine it serves). Pages open first, then Lens launches a Hedge Designation then Export survey.
// The survey engine reloads flags and surveys on an interval (window.__lensSurveyRefreshMs, here REFRESH_MS):
// after it, the next Hedge Designation then Export must show the survey. Control pages run with the refresh off
// (0) and must show none, which proves the reload is what makes it work.
//   REAL_PH=http://127.0.0.1 REAL_TOKEN=phc_… REAL_KEY=phx_… REAL_PROJECT=1 PAGES=6 CONTROL=2 REFRESH_MS=20000 \
//     npx tsx tools/reval-sim/real-live-launch.ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer'
import { RevalServer } from './server.ts'
import { visit, surveysOnScreen, type Sim, type Visit } from './harness.ts'

const PH = process.env.REAL_PH!, TOKEN = process.env.REAL_TOKEN!, KEY = process.env.REAL_KEY!, PROJECT = process.env.REAL_PROJECT || '1'
const PAGES = Number(process.env.PAGES || 6), CONTROL = Number(process.env.CONTROL || 2), REFRESH = Number(process.env.REFRESH_MS || 20_000)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
Object.assign(process.env, { POSTHOG_HOST: PH, POSTHOG_PROJECT_ID: PROJECT, POSTHOG_PERSONAL_API_KEY: KEY, POSTHOG_SURVEY_API_KEY: KEY, FEATURE_SURVEYS: 'on',
    APP_EVENTS_FILE: join(import.meta.dirname, '../../config/app-events.reval.json'), CLIENT_FROM_DISTINCT_ID: '3', DISTINCT_ID_SEPARATOR: '|' })
const { config } = await import('../../src/core/config.ts')
Object.assign(config.posthog, { host: PH, projectId: PROJECT, personalApiKey: KEY, surveyApiKey: KEY, surveyGate: '' })
config.surveys.enabled = true; config.properties.clientFromDistinctId = 3; config.properties.distinctIdSeparator = '|'
const lens = await import('../../src/core/surveys.ts')

const stamp = Date.now().toString(36)
const saved = await lens.saveSurvey({ name: `Hedge export live ${stamp}`, questions: [{ type: 'rating', text: 'How easy was the export?' }],
    steps: [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }], clients: ['SEM'], show: 'once', wait_for_page: true, max_wait_seconds: 30 } as never, { clientIds: ['SEM'] })
if (!saved.survey) throw new Error('Lens refused the survey: ' + JSON.stringify(saved.compiled.problems))
console.log('survey (draft)', saved.survey.id)

const reval = await new RevalServer().start()
const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 300_000, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const sim = { reval, browser, posthog: { url: PH, tokenFor: () => TOKEN } } as unknown as Sim

interface Row { i: number; control: boolean; user: string; expected: 'shows' | 'none'; result: 'shows' | 'none'; ok: boolean; beforeLaunch: 'none' | 'shows'; afterExportMs?: number; sinceLaunchMs?: number; note?: string }
const pages: { v: Visit; row: Row }[] = []
const R = (v: Visit, fn: string, ...a: unknown[]) => v.page.evaluate((f, xs) => (window as any).Reval[f](...xs), fn, a)
const press = async (v: Visit, screen: string, label: string) => { const id = await R(v, 'button', screen, label); if (!id) throw new Error(`no ${label} in ${screen}`); await v.page.click(`#${id}`) }
const watchNone = async (v: Visit, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await surveysOnScreen(v.page)).length) return false; await sleep(250) } return true }

try {
    // 1. Pages open before the survey exists for posthog-js. Each completes the chain once: nothing may show.
    for (let i = 0; i < PAGES + CONTROL; i++) {
        const control = i >= PAGES, user = `LL${stamp}${i}`
        const row: Row = { i, control, user: `C1DEV|01|SEM|${user}`, expected: control ? 'none' : 'shows', result: 'none', ok: false, beforeLaunch: 'none' }
        const v = await visit(sim, PROJECT, { client: 'SEM', user, ph: PH, refreshMs: control ? 0 : REFRESH })
        pages.push({ v, row })
    }
    await Promise.all(pages.map(async ({ v, row }) => {
        await v.page.waitForFunction(() => !!(window as any).__PosthogExtensions__?.generateSurveys && !!(window as any).posthog?.__loaded, { timeout: 60_000 })
        await sleep(1500)
        await R(v, 'open', 'report:LinkListReqv'); await sleep(1200); await press(v, 'LinkListReqv', 'Export')
        if (!(await watchNone(v, 5000))) row.beforeLaunch = 'shows'
    }))
    // 2. Lens launches it; wait until PostHog's flags service serves its targeting flag.
    await lens.launchSurvey(saved.survey.id)
    const launchedAt = Date.now()
    for (;;) {
        const f = await (await fetch(`${PH}/flags/?v=2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, distinct_id: `C1DEV|01|SEM|probe${Date.now()}` }) })).json() as { flags?: Record<string, { enabled: boolean }> }
        const s = await (await fetch(`${PH}/api/projects/${PROJECT}/surveys/${saved.survey.id}/`, { headers: { authorization: `Bearer ${KEY}` } })).json() as { internal_targeting_flag?: { key: string } }
        const key = s.internal_targeting_flag?.key
        if (key && f.flags?.[key]?.enabled) break
        if (Date.now() - launchedAt > 180_000) throw new Error('PostHog never served the survey targeting flag')
        await sleep(1000)
    }
    console.log(`launched; targeting flag served ${Date.now() - launchedAt} ms after launch; waiting ${REFRESH + 8000} ms (refresh interval + margin)`)
    await sleep(REFRESH + 8000)
    // 3. Same pages, no reload: close the report, open it again and export.
    await Promise.all(pages.map(async ({ v, row }) => {
        try {
            await R(v, 'close', 'LinkListReqv'); await sleep(800)
            await R(v, 'open', 'report:LinkListReqv')
            if (!(await watchNone(v, 1200))) row.note = 'survey visible before the export'
            const t = Date.now(); await press(v, 'LinkListReqv', 'Export')
            const end = t + (row.control ? 20_000 : 45_000)
            while (Date.now() < end) { if ((await surveysOnScreen(v.page)).length) { row.result = 'shows'; row.afterExportMs = Date.now() - t; row.sinceLaunchMs = Date.now() - launchedAt; break } await sleep(100) }
        } catch (e) { row.note = (e as Error).message.split('\n')[0] }
        row.ok = row.result === row.expected && row.beforeLaunch === 'none' && !row.note
    }))
} finally {
    for (const { v } of pages) { await v.page.goto('about:blank').catch(() => {}); await v.close() }
    await lens.stopSurvey?.(saved.survey.id).catch(() => {})
    await browser.close(); await reval.stop()
}
const rows = pages.map((p) => p.row)
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} #${r.i} ${r.control ? 'control (refresh off)' : `refresh ${REFRESH} ms`}: before launch ${r.beforeLaunch}, after ${r.result}${r.afterExportMs != null ? ` ${r.afterExportMs} ms after export (${r.sinceLaunchMs} ms after launch)` : ''}${r.note ? ` (${r.note})` : ''}`)
const out = join(import.meta.dirname, '../../run/real-live-launch'); mkdirSync(out, { recursive: true })
writeFileSync(join(out, `results-${stamp}.json`), JSON.stringify({ survey: saved.survey.id, ph: PH, refreshMs: REFRESH, rows }, null, 2))
console.log(`\n${rows.filter((r) => r.ok).length} of ${rows.length} pages as expected; survey ${saved.survey.id}`)
process.exit(rows.every((r) => r.ok) ? 0 : 1)
