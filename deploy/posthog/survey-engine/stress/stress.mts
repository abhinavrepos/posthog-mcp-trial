// Stress test for Lens survey chains: many browser pages at once, each a Reval stand-in running one
// scripted journey, checked against the expected survey (or none), with every browser error recorded.
//
//   tsx stress.mts <config.json> [total pages] [concurrency]
// config.json: { host, token, pageBase, surveys: { S1: id, S2: id, S3: id, S4: id } }
import { readFileSync, writeFileSync } from 'node:fs'
import puppeteer, { type Browser, type Page } from 'puppeteer'

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const TOTAL = Number(process.argv[3] || 200)
const CONC = Number(process.argv[4] || 50)
const S = cfg.surveys as Record<'S1' | 'S2' | 'S3' | 'S4', string>

type Step = ['open' | 'close' | 'save' | 'run' | 'toast' | 'noise' | 'garbage' | 'wait' | 'reload' | 'dupes', string?, number?]
interface Journey { name: string; client: string; steps: Step[]; expect: keyof typeof S | null; mask?: number }
const J: Journey[] = [
    { name: 'acme full chain', client: 'ACME', steps: [['open', 'DlgA'], ['noise'], ['save', 'DlgA'], ['noise'], ['open', 'DlgZ']], expect: 'S1' },
    { name: 'acme wrong order', client: 'ACME', steps: [['open', 'DlgA'], ['open', 'DlgZ'], ['save', 'DlgA']], expect: null },
    { name: 'acme partial', client: 'ACME', steps: [['open', 'DlgA'], ['save', 'DlgA']], expect: null },
    { name: 'acme closed first dialog', client: 'ACME', steps: [['open', 'DlgA'], ['save', 'DlgA'], ['close', 'DlgA'], ['open', 'DlgZ']], expect: null },
    { name: 'acme reload mid-chain', client: 'ACME', steps: [['open', 'DlgA'], ['save', 'DlgA'], ['reload'], ['open', 'DlgZ']], expect: null },
    { name: 'acme reload then full', client: 'ACME', steps: [['open', 'DlgA'], ['reload'], ['open', 'DlgA'], ['save', 'DlgA'], ['open', 'DlgZ']], expect: 'S1' },
    { name: 'acme chain under load mask', client: 'ACME', mask: 6000, steps: [['open', 'DlgA'], ['save', 'DlgA'], ['open', 'DlgZ']], expect: 'S1' },
    { name: 'acme 50 duplicates then chain', client: 'ACME', steps: [['dupes', 'DlgA'], ['save', 'DlgA'], ['open', 'DlgZ']], expect: 'S1' },
    { name: 'beta does acme chain', client: 'BETA', steps: [['open', 'DlgA'], ['save', 'DlgA'], ['open', 'DlgZ']], expect: null },
    { name: 'beta saves C', client: 'BETA', steps: [['open', 'DlgC'], ['save', 'DlgC']], expect: 'S4' },
    { name: 'link added message', client: 'DELTA', steps: [['open', 'DlgL'], ['save', 'DlgL'], ['toast', 'Link Id 3508 Added']], expect: 'S2' },
    { name: 'other message', client: 'DELTA', steps: [['toast', 'Trade Id 4348 Updated']], expect: null },
    { name: 'gamma timed ok', client: 'GAMMA', steps: [['open', 'DlgB'], ['wait', '', 1000], ['run', 'DlgB']], expect: 'S3' },
    { name: 'gamma timed too late', client: 'GAMMA', steps: [['open', 'DlgB'], ['wait', '', 9500], ['run', 'DlgB']], expect: null },
    { name: 'garbage events', client: 'ACME', steps: [['garbage'], ['garbage'], ['noise']], expect: null },
]

const watch = (page: Page) =>
    page.evaluate(() => {
        const out: { id: string; visible: boolean; footer: string; posthogLink: boolean }[] = []
        document.querySelectorAll('[class^="PostHogSurvey"]').forEach((host: any) => {
            const id = String(host.className).replace(/^PostHogSurvey-?/, '')
            const root = host.shadowRoot as ShadowRoot | null
            if (!root) return
            const els = Array.from(root.querySelectorAll('*')) as HTMLElement[]
            const visible = els.some((e) => {
                const r = e.getBoundingClientRect()
                const cs = getComputedStyle(e)
                return r.width > 50 && r.height > 50 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.5 && /Q:/.test(e.textContent || '')
            })
            const f = root.querySelector('.footer-branding') as HTMLElement | null
            out.push({ id, visible, footer: (f?.textContent || '').trim(), posthogLink: !!root.querySelector('a[href*="posthog.com"]') })
        })
        const mask = document.getElementById('mask') as HTMLElement
        return { surveys: out, maskVisible: mask.style.display !== 'none' }
    })

async function act(page: Page, s: Step) {
    const cap = (event: string, props: Record<string, unknown>) => page.evaluate((e, p) => (window as any).posthog.capture(e, p), event, props)
    switch (s[0]) {
        case 'open': return cap('PageView', { dialog_id: s[1], dialog_name: s[1], action: 'OPEN' })
        case 'close': return cap('PageView', { dialog_id: s[1], action: 'CLOSE' })
        case 'save': return cap('Event', { dialog_id: s[1], action_name: 'Save' })
        case 'run': return cap('Event', { dialog_id: s[1], action_name: 'Run' })
        case 'toast': return cap('Event', { dialog_id: 'toast', action_name: [s[1]] })
        case 'noise': return cap('Event', { dialog_id: 'DlgN', action: 'Trade Date', control_type: 'DATEFIELD' })
        case 'dupes': for (let i = 0; i < 50; i++) await cap('PageView', { dialog_id: s[1], action: 'OPEN' }); return
        case 'garbage':
            await cap('PageView', { dialog_id: null, action: { nested: [1, 2, { x: 'y' }] } })
            await cap('Event', { dialog_id: ['DlgA', 'DlgZ'], action_name: 'x'.repeat(20000) })
            await cap('PageView', { dialog_id: 12345, action: undefined, weird: '\u0000\uffff<script>' })
            return
        case 'wait': return new Promise((r) => setTimeout(r, s[2] || 0))
    }
}

interface Result { net?: string[]; n: number; journey: string; core: string; ok: boolean; why: string; shown: string[]; errors: string[]; ms: number; shownWhileMask?: boolean }

async function run(browser: Browser, n: number): Promise<Result> {
    const j = J[n % J.length]
    const core = process.env.CORE === 'new' ? 'new' : process.env.CORE === 'old' ? 'old' : n % 2 ? 'old' : 'new'
    const t0 = Date.now()
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') errors.push(`console.${m.type()}: ${m.text().slice(0, 200)}`) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`))
    page.on('requestfailed', (r) => { const f = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(f)) errors.push(`requestfailed: ${r.url().slice(0, 90)} ${f}`) })
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url().slice(0, 90)}`) })
    const net: string[] = []
    const startedAt = new Map<string, number>()
    const watched = /\/(flags|decide|api\/surveys|static\/surveys|array\/)/
    page.on('request', (q) => { if (watched.test(q.url())) startedAt.set(q.url() + q.method(), Date.now()) })
    page.on('requestfinished', (q) => {
        const k = q.url() + q.method()
        const t = startedAt.get(k)
        if (t !== undefined) net.push(`${q.url().replace(/^https?:\/\/[^/]+/, '').replace(/token=[^&]+/, 'token=…').slice(0, 50)} ${q.response()?.status()} ${Date.now() - t}ms`)
    })
    const shown = new Set<string>()
    let shownWhileMask = false
    let footerBad = ''
    const user = `C1DEV|01|${j.client}|STRESS${Date.now().toString(36)}${n}`
    const url = `${cfg.pageBase}?core=${core}&host=${encodeURIComponent(cfg.host)}&token=${cfg.token}&id=${encodeURIComponent(user)}&client=${j.client}${j.mask ? `&mask=${j.mask}` : ''}`
    const load = async () => {
        await page.goto(url, { waitUntil: 'load', timeout: 60000 })
        await page.waitForFunction('window.__ready === true', { timeout: 60000 })
        // until the survey renderer and the definitions are in
        await page.waitForFunction(() => !!(window as any).__PosthogExtensions__?.generateSurveys, { timeout: 60000 })
        await new Promise((r) => setTimeout(r, 2500))
    }
    const poll = async (ms: number) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
            const w = await watch(page)
            for (const s of w.surveys) if (s.visible) {
                shown.add(s.id)
                if (w.maskVisible) shownWhileMask = true
                if (s.footer !== 'Survey by ION' || s.posthogLink) footerBad = `footer "${s.footer}" posthogLink=${s.posthogLink}`
            }
            await new Promise((r) => setTimeout(r, 200))
        }
    }
    try {
        await load()
        for (const s of j.steps) {
            if (s[0] === 'reload') { await load(); continue }
            await act(page, s)
            await new Promise((r) => setTimeout(r, 150))
        }
        await poll(j.mask ? j.mask + 3500 : 3500)
    } catch (e) {
        errors.push(`harness: ${(e as Error).message.slice(0, 200)}`)
    }
    const ids = [...shown]
    const want = j.expect ? S[j.expect] : null
    let ok = true, why = ''
    if (want && !(ids.length === 1 && ids[0] === want)) { ok = false; why = `expected ${j.expect}, saw [${ids}]` }
    if (!want && ids.length) { ok = false; why = `expected none, saw [${ids}]` }
    if (shownWhileMask) { ok = false; why += ' shown while the load mask was visible' }
    if (footerBad) { ok = false; why += ` ${footerBad}` }
    if (errors.length) { ok = false; why += ` ${errors.length} browser errors` }
    await ctx.close().catch(() => {})
    return { net, n, journey: j.name, core, ok, why: why.trim(), shown: ids, errors, ms: Date.now() - t0, shownWhileMask }
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=24', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], protocolTimeout: 600000 })
const results: Result[] = []
let next = 0, peak = 0, active = 0
const started = Date.now()
await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < TOTAL) {
        const n = next++
        active++; peak = Math.max(peak, active)
        results.push(await run(browser, n))
        active--
        if (results.length % 50 === 0) console.log(`${results.length}/${TOTAL} done, ${results.filter((r) => !r.ok).length} failing, ${Math.round((Date.now() - started) / 1000)} s`)
    }
}))
await browser.close()
const byJourney: Record<string, { pass: number; fail: number }> = {}
for (const r of results) { const k = `${r.journey} [${r.core}]`; byJourney[k] ??= { pass: 0, fail: 0 }; byJourney[k][r.ok ? 'pass' : 'fail']++ }
const summary = { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, peakConcurrentPages: peak, seconds: Math.round((Date.now() - started) / 1000), byJourney, failures: results.filter((r) => !r.ok).slice(0, 40) }
writeFileSync(process.argv[5] || 'stress-result.json', JSON.stringify({ summary, results }, null, 1))
console.log(JSON.stringify({ ...summary, failures: summary.failures.map((f) => `${f.journey} [${f.core}] ${f.why} ${f.errors.slice(0, 2).join(' | ')}`) }, null, 1))
