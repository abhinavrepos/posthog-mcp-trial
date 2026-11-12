// End-to-end check of "how is <client> doing" on a deployed Lens, with the replay lab's recordings
// (scripts/replay-lab: personas with known behaviour, planted trade values): Lens reads the replays by
// itself, Copilot's client_experience answers each lab client as it behaved, nothing planted comes out,
// and the Client story page shows the same. See scripts/e2e/README.md.
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer'

import { canaryStrings } from '../replay-lab/canaries.ts'

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) { console.error(`Set ${k}`); process.exit(2) } return v }
const LENS = env('LENS_URL', 'http://127.0.0.1:8080')
const pw = (process.env.E2E_PASSWORD ?? readFileSync(env('E2E_PASSWORD_FILE'), 'utf8')).trim()
const truth = JSON.parse(readFileSync(env('LAB_TRUTH', 'scripts/replay-lab/out/ground-truth.json'), 'utf8'))
const lab = Object.values(truth.sessions || truth) as { client_id: string; client_name: string; persona: string }[]
const clients = [...new Map(lab.map((s) => [s.client_id, s])).values()]
const report: string[] = []
const ok = (l: string, c: boolean, x = '') => { report.push((c ? 'PASS ' : 'FAIL ') + l + (x ? ' — ' + x : '')); return c }

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900 })
await page.goto(LENS + '/replays', { waitUntil: 'networkidle0' })
await page.type('input[type=email]', env('E2E_ADMIN', 'lens-check-admin@example.invalid')); await page.type('input[type=password]', pw)
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('form button')])
const api = (path: string, method = 'GET', body?: unknown) => page.evaluate(async (path, method, body) => {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-clip-page': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return r.json()
}, path, method, body)
const key = await api('/replays/connect/api/tokens', 'POST', { label: 'experience-check' })
let id = 1
const mcp = async (method: string, params: unknown) => {
    const r = await fetch(LENS + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + key.token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) })
    return r.text()
}
const leaks = (t: string) => canaryStrings.flatMap((c) => [c, c.replace(/,/g, ''), c.toLowerCase()]).filter((v) => t.includes(v))
try {
    await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'xp', version: '1' } })
    const expect: Record<string, RegExp> = { smooth: /SMOOTH/, 'error-looping': /STRUGGLING|SOME FRICTION/, 'rage-dead': /STRUGGLING|SOME FRICTION/, 'scroll-hunting': /STRUGGLING|SOME FRICTION/, 'hesitant-circling': /STRUGGLING|SOME FRICTION/, idle: /STRUGGLING|SOME FRICTION/ }
    const finding: Record<string, RegExp> = { 'error-looping': /Error loops|Errors shown/, 'rage-dead': /Rage clicks|Clicks that do nothing/, 'scroll-hunting': /Scrolling up and down/, 'hesitant-circling': /hesitations|circling/i, idle: /Idle share/ }
    for (const c of clients) {
        const t = await mcp('tools/call', { name: 'client_experience', arguments: { client: c.client_name } })
        ok(`${c.persona} (${c.client_name}): verdict`, expect[c.persona].test(t), (/: (SMOOTH|SOME FRICTION|STRUGGLING|NOT ENOUGH REPLAYS)/.exec(t) || [''])[0])
        if (finding[c.persona]) ok(`${c.persona}: names the right problem`, finding[c.persona].test(t), t.slice(0, 200).replace(/\\n/g, ' '))
        ok(`${c.persona}: nothing planted in the answer`, !leaks(t).length, leaks(t).join(', '))
    }
    const hot = await mcp('tools/call', { name: 'friction_hotspots', arguments: {} })
    ok('friction_hotspots ranks places, nothing planted', /Counterparty|Save/.test(hot) && !leaks(hot).length, hot.slice(0, 160))
    const err = clients.find((c) => c.persona === 'error-looping')!
    await page.goto(`${LENS}/replays/dashboards?view=story&client=${encodeURIComponent(err.client_id)}`, { waitUntil: 'networkidle0' })
    const body = await page.evaluate(() => document.body.innerText)
    ok('Client story shows "How they experience it" with a verdict and next steps', /How they experience it/.test(body) && /Struggling|Some friction/.test(body) && /Next steps/.test(body), body.slice(0, 120))
    ok('Client story page: nothing planted', !leaks(await page.content()).length)
} finally {
    await api('/replays/connect/api/tokens/' + key.id, 'DELETE')
    await browser.close()
}
console.log(report.join('\n'))
const failed = report.filter((l) => l.startsWith('FAIL')).length
console.log(`${report.filter((l) => l.startsWith('PASS')).length} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
