// End-to-end check of native PostHog surveys made through Signal's MCP, against a REAL self-hosted PostHog.
// 1. MCP save_survey creates and launches a survey: PageView OPEN of LinkListReqv, SEM clients only.
// 2. Simulated Reval in headless Chrome (posthog-js from that PostHog, unmodified):
//    SEM user opens LinkListReqv -> survey shows and is answered; SEM user opens another dialog -> none;
//    HDG user opens LinkListReqv -> none.
// 3. MCP survey_results counts the answer; MCP stop_survey archives the survey.
//   REAL_PH=http://127.0.0.1 REAL_TOKEN=phc_… REAL_KEY=phx_… REAL_PROJECT=1 npx tsx tools/reval-sim/native-e2e.ts
import { resolve, join } from 'node:path'
import puppeteer from 'puppeteer'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { RevalServer } from './server.ts'
import { visit, surveysOnScreen, answerSurvey, sleep, type Sim, type Visit } from './harness.ts'

const PH = process.env.REAL_PH!, TOKEN = process.env.REAL_TOKEN!, KEY = process.env.REAL_KEY!, PROJECT = process.env.REAL_PROJECT || '1'
if (!PH || !TOKEN || !KEY) throw new Error('Set REAL_PH, REAL_TOKEN, REAL_KEY (and REAL_PROJECT)')
const env: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env,
    POSTHOG_HOST: PH, POSTHOG_PROJECT_ID: PROJECT, POSTHOG_PROJECT_TOKEN: TOKEN, POSTHOG_PERSONAL_API_KEY: KEY, POSTHOG_MCP_API_KEY: KEY, POSTHOG_SURVEY_API_KEY: KEY,
    FEATURE_SURVEYS: 'on', APP_EVENTS_FILE: resolve('config/app-events.reval.json'), CLIENT_FROM_DISTINCT_ID: '3', DISTINCT_ID_SEPARATOR: '|',
}).filter((e): e is [string, string] => e[1] !== undefined))

const results: { step: string; ok: boolean; note?: string }[] = []
const check = (step: string, ok: boolean, note?: string) => { results.push({ step, ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${note ? ` (${note})` : ''}`) }

const client = new Client({ name: 'native-e2e', version: '1' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/stdio.ts'], cwd: resolve('.'), env, stderr: 'pipe' }))
const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as { isError?: boolean; content?: { text?: string }[]; structuredContent?: any }
    if (r.isError) throw new Error(`${name}: ${r.content?.map((c) => c.text).join(' ')}`)
    return r
}
const tools = (await client.listTools()).tools.map((t) => t.name)
check('MCP exposes survey tools', ['design_survey', 'save_survey', 'stop_survey', 'list_surveys', 'survey_results'].every((t) => tools.includes(t)), tools.filter((t) => /survey/.test(t)).join(','))

const stamp = Date.now().toString(36)
const spec = {
    name: `Native e2e ${stamp}`, type: 'popover',
    questions: [{ type: 'rating', question: 'How easy was the report?', scale: 5, display: 'number', lowerBoundLabel: 'Hard', upperBoundLabel: 'Easy' }],
    conditions: { events: { repeatedActivation: false, values: [{ name: 'PageView', propertyFilters: {
        dialog_id: { operator: 'exact', values: ['LinkListReqv'] }, action: { operator: 'exact', values: ['OPEN'] } } }] } },
    appearance: { position: 'right', surveyPopupDelaySeconds: 1 },
    clients: ['SEM'],
}
await call('design_survey', spec)
check('design_survey validates the spec', true)
const saved = await call('save_survey', { ...spec, start_date: new Date().toISOString() })
const id: string = saved.structuredContent?.survey?.id ?? /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(JSON.stringify(saved))?.[1]
check('save_survey creates and launches', !!id, id)

// Stored as a native survey: no Signal chain, property filters and SEM targeting present.
const api = async (path: string) => (await fetch(`${PH}/api/projects/${PROJECT}/${path}`, { headers: { Authorization: `Bearer ${KEY}` } })).json() as Promise<any>
const stored = await api(`surveys/${id}/`)
check('stored natively (no lensChain)', !stored.conditions?.lensChain && stored.conditions?.events?.values?.[0]?.propertyFilters?.dialog_id?.values?.[0] === 'LinkListReqv')
check('running', !!stored.start_date && !stored.end_date)
const flagKey = stored.targeting_flag?.key || stored.internal_targeting_flag?.key
const flags = async (did: string) => (await (await fetch(`${PH}/flags/?v=2`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, distinct_id: did }) })).json() as any).flags?.[stored.targeting_flag?.key]?.enabled
if (stored.targeting_flag?.key) {
    const t0 = Date.now(); let sem = false
    while (Date.now() - t0 < 120_000 && !(sem = !!(await flags(`C1DEV|01|SEM|E2E${stamp}`)))) await sleep(2000)
    check('targeting flag: SEM matches', sem, `${Date.now() - t0} ms`)
    check('targeting flag: HDG does not match', !(await flags(`C1DEV|01|HDG|E2E${stamp}`)))
} else check('survey has a targeting flag', false, `flag key ${flagKey}`)

const reval = await new RevalServer().start()
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] })
const sim = { reval, browser, posthog: { url: PH, tokenFor: () => TOKEN } } as unknown as Sim
const R = (v: Visit, fn: string, ...a: unknown[]) => v.page.evaluate((f, xs) => (window as any).Reval[f](...xs), fn, a)
const ready = (v: Visit) => v.page.waitForFunction(() => !!(window as any).posthog?.__loaded, { timeout: 60_000 })
const shows = async (v: Visit, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await surveysOnScreen(v.page)).length) return true; await sleep(200) } return false }
try {
    const sem = await visit(sim, PROJECT, { client: 'SEM', user: `E2E${stamp}a`, ph: PH }); await ready(sem); await sleep(2500)
    const engine = await sem.page.evaluate(() => !!(window as any).__PosthogExtensions__?.generateSurveys?.__lensSurveyEngine)
    check('PostHog serves its original survey script (no Signal engine)', !engine)
    await R(sem, 'open', 'report:LinkListReqv')
    check('SEM user opening LinkListReqv sees the survey', await shows(sem, 20_000))
    check('survey can be answered', await answerSurvey(sem.page))

    const other = await visit(sim, PROJECT, { client: 'SEM', user: `E2E${stamp}b`, ph: PH }); await ready(other); await sleep(2500)
    await R(other, 'open', 'DlgCalculator'); check('SEM user opening DlgCalculator sees nothing', !(await shows(other, 8000)))

    const hdg = await visit(sim, PROJECT, { client: 'HDG', user: `E2E${stamp}c`, ph: PH }); await ready(hdg); await sleep(2500)
    await R(hdg, 'open', 'report:LinkListReqv')
    check('HDG user opening LinkListReqv sees nothing', !(await shows(hdg, 8000)))
    for (const v of [sem, other, hdg]) { const bad = v.errors.filter((e) => !/favicon|ERR_ABORTED/.test(e)); if (bad.length) console.log('page errors:', bad.slice(0, 5)) }
} finally { await browser.close(); await reval.stop?.() }

// Results reach ClickHouse after ingestion: poll survey_results.
let answered = 0; const t1 = Date.now()
while (Date.now() - t1 < 180_000) {
    const r = await call('survey_results', { survey_id: id, days: 1 })
    answered = Number(r.structuredContent?.answered ?? r.structuredContent?.data?.answered ?? /"answered":\s*(\d+)/.exec(JSON.stringify(r))?.[1] ?? 0)
    if (answered >= 1) break
    await sleep(10_000)
}
check('survey_results counts the answer', answered >= 1, `answered ${answered} after ${Math.round((Date.now() - t1) / 1000)} s`)
await call('stop_survey', { survey_id: id, archive: true })
const after = await api(`surveys/${id}/`)
check('stop_survey stops and archives', !!after.end_date && after.archived === true)
await client.close()

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
